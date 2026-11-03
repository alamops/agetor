/**
 * The OpenCode server hub: ONE SSE subscription per agetor-owned `opencode
 * serve`, fanned out to per-session subscribers (plan:
 * `docs/plans/opencode-server-driver.md`, T7; decisions D7 and D13).
 *
 * What it owns:
 *   - The stream lifecycle per server key (the harness id): opened lazily on the
 *     first subscriber or watched session, closed when neither remains, and
 *     reopened on demand. A changed ref (new url or password after a server
 *     restart) for the same key replaces the stream; callers may pass an
 *     `epoch` (the server's `startedAt`) and a ref with an OLDER epoch than the
 *     one held is ignored, so a stale caller cannot swap out a healthy stream.
 *     Without epochs, or with an equal one, the last ref wins and existing
 *     subscribers are kept and resynced. A NEWER epoch means the server process
 *     restarted: its executions are gone, so existing subscribers get
 *     `onServerLost(Error("OpenCode server restarted"))` and are dropped before
 *     the swap. A swap does not reset the failure count.
 *     Exactly one stream per key exists at any time (single-flight connect, a
 *     generation counter drops callbacks of a stale stream, and a stream that
 *     closes synchronously inside its own open call is not kept).
 *   - Ownership: which session ids belong to which subscriber. A subscriber
 *     names a root session; its children (and their children, depth <= 4,
 *     <= 500 sessions per root) are learned from `session.created{parentID}`
 *     and seeded from `GET /api/session?parentID=` on subscribe and after every
 *     reconnect (each root independently), so a child created while the stream
 *     was down is still owned. Events for sessions nobody owns are dropped (wake
 *     detection aside). `opencodeOwnedSessions` lists a root's owned sessions.
 *   - Stream loss: any close that is not ours triggers a reconnect with
 *     exponential backoff (1 s to 30 s, jittered). Two caps give up:
 *     10 consecutive attempts that never reached `server.connected`, or 30
 *     post-connect drops within 5 minutes where each stream lived under
 *     `stableMs` (10 s); a stream that stayed up that long clears the drop
 *     count, so a reachable but flapping server is not declared lost early.
 *     On give-up every subscriber gets `onServerLost` and is dropped, the
 *     record (its watched set included) is deleted, the watch-lost handler is
 *     told if sessions were watched, and nothing retries until the next
 *     subscribe or watch. OpenCode replays nothing, so after each reconnect
 *     every subscriber that was already live gets exactly one
 *     `onResync(owned)` (after `server.connected` and after ITS root's children
 *     were re-seeded; `owned` lists the root and every descendant, so the
 *     subscriber can refetch pending permissions and forms of the children too).
 *   - Wake (D7): a `session.execution.started` for a watched root session that
 *     has no subscriber means OpenCode started a turn on its own (a background
 *     subagent finished and its result was queued). The wake handler is called
 *     once per execution (deduped by envelope id). For every watched root the
 *     hub remembers the latest execution that has started and not ended, even
 *     while a driver is subscribed: when the last subscriber unsubscribes with
 *     that execution still open, the wake fires then (the next execution began
 *     under the previous turn's driver). A driver that unsubscribes BEFORE the
 *     terminal event of its own turn (a kill that does not wait) therefore
 *     produces a wake; the orchestrator gates those (a task with a running run
 *     refuses a wake). On EVERY connect (first or reconnect) watched sessions
 *     that the server reports active are checked too, since the
 *     `execution.started` may have fallen into the gap or predate this core;
 *     that snapshot is discarded for any session that saw a live execution
 *     event after the request began.
 *     The same check runs for sessions newly added by a `watch` call on an
 *     already-connected stream.
 *
 * Contract notes for callers:
 *   - `ready` resolves once the stream is open (`server.connected`) and the
 *     root's existing children are seeded. With a server that is down it can
 *     take minutes (the reconnect cap) before it rejects, so the driver must
 *     apply its own deadline. It also resolves (not rejects) when the caller
 *     unsubscribes first; the driver checks its own killed flag afterwards. It
 *     rejects when the ref is invalid, the hub gives up, or the hub is closed.
 *   - A subscriber created inside the wake handler does not receive the
 *     `execution.started` that triggered the wake (it was dispatched before the
 *     subscriber existed, and OpenCode replays nothing): build its state from a
 *     snapshot after `ready`.
 *   - Callers re-watch after every server ensure and after `onServerLost`: a
 *     give-up deletes the watched set (`setOpencodeWatchLostHandler` says when).
 *
 * The password never leaves the `OpencodeServerRef` handed to the http module
 * (invariant I4): nothing here logs a ref, an event payload or an error that
 * could carry one.
 *
 * Main thread: dispatch is one Map lookup per event; there is no queue (a
 * subscriber is registered synchronously and sees events from that moment, so
 * the driver awaits `ready` before it prompts).
 */
import {
  createOpencodeClient,
  isLoopbackOpencodeUrl,
  openOpencodeEventStream,
  type OpencodeEnvelope,
  type OpencodeEventStream,
  type OpencodeServerRef,
} from "./opencode-http.ts";

export interface OpencodeHubOrigin {
  /** The session the event belongs to (the root itself or a descendant). */
  sessionId: string;
  isChild: boolean;
  /** The immediate parent of a child session. */
  childOf?: string;
  /** 0 for the root, 1 for its children, and so on. */
  depth: number;
}

export interface OpencodeHubSubscriber {
  onEvent(e: OpencodeEnvelope, origin: OpencodeHubOrigin): void;
  /**
   * The stream was lost and is back: refetch state (messages, pending
   * permissions and forms). `owned` is the root and every descendant the hub
   * knows after re-seeding, so children are refetched too.
   */
  onResync(owned: ReadonlyArray<OpencodeHubOrigin>): void;
  /** Reconnecting gave up (attempt cap reached): settle as failed. The subscriber is dropped. */
  onServerLost?(err?: unknown): void;
}

/** `epoch` (optional) orders refs of one server key: the server's `startedAt` works. */
export type OpencodeHubServer = { key: string; epoch?: number } & OpencodeServerRef;
export type OpencodeWakeHandler = (serverKey: string, sessionId: string, e: OpencodeEnvelope) => void;
export type OpencodeWatchLostHandler = (serverKey: string) => void;

/** Children of children are followed this deep (the root is depth 0). */
const MAX_CHILD_DEPTH = 4;
/** Sessions owned per root, the root included. */
const MAX_OWNED_PER_ROOT = 500;
/** Envelope ids remembered for wake dedupe. */
const WAKE_DEDUPE_MAX = 256;

const DEFAULT_BACKOFF = {
  baseMs: 1000,
  maxMs: 30_000,
  /** Consecutive attempts that never reached `server.connected`. */
  maxFailures: 10,
  /** A stream that stayed connected this long clears the post-connect drop count. */
  stableMs: 10_000,
  /** Post-connect drops (streams shorter than `stableMs`) tolerated within `dropWindowMs`. */
  maxDrops: 30,
  dropWindowMs: 300_000,
};
let backoff = { ...DEFAULT_BACKOFF };

interface Entry {
  root: string;
  sub: OpencodeHubSubscriber;
  /** True once the stream was open while this entry was registered; only live entries are resynced. */
  live: boolean;
  settleReady: { resolve(): void; reject(err: unknown): void; done: boolean };
}

interface Owned {
  root: string;
  origin: Readonly<OpencodeHubOrigin>;
}

interface HubServer {
  key: string;
  ref: OpencodeServerRef;
  epoch: number | undefined;
  stream: OpencodeEventStream | null;
  /** Bumped whenever a stream is replaced or closed on purpose; stale callbacks compare against it. */
  gen: number;
  /** `server.connected` was seen on the current stream. */
  connected: boolean;
  /** Connections that reached `server.connected` during this server record's life. */
  connects: number;
  connectedAt: number;
  /** Consecutive attempts that closed before `server.connected`; reset when one connects. */
  failures: number;
  /** Timestamps of recent post-connect drops of short-lived streams. */
  drops: number[];
  retryTimer: ReturnType<typeof setTimeout> | null;
  entries: Map<string, Entry[]>;
  owned: Map<string, Owned>;
  ownedByRoot: Map<string, Set<string>>;
  watched: Set<string>;
  /** Watched sessions the wake handler fired for whose execution has not ended. */
  woken: Set<string>;
  /** Per watched root: the latest `execution.started` with no matching end yet, subscribed or not. */
  openExec: Map<string, OpencodeEnvelope>;
  /** Per watched root: `execSeq` of its latest execution event (a live event beats an older snapshot). */
  lastExec: Map<string, number>;
  execSeq: number;
  wakeSeen: Set<string>;
}

const servers = new Map<string, HubServer>();
let wakeHandler: OpencodeWakeHandler | null = null;
let watchLostHandler: OpencodeWatchLostHandler | null = null;
let testFetch: typeof fetch | null = null;
const hooks: {
  beforeSeed?: (serverKey: string, root: string) => Promise<void> | void;
  afterActiveSessions?: (serverKey: string) => Promise<void> | void;
} = {};
const stats = { streamsOpened: 0, concurrent: 0, maxConcurrent: 0 };

// ------------------------------------------------------------------ helpers

function warn(msg: string, key: string, sessionId?: string, err?: unknown): void {
  // No event payload and no ref: only ids and the error's message.
  const why = err instanceof Error ? err.message : err === undefined ? "" : String(err);
  console.warn(`[opencode-hub] ${msg} (server ${key}${sessionId ? `, session ${sessionId}` : ""})${why ? `: ${why.slice(0, 200)}` : ""}`);
}

function refsEqual(a: OpencodeServerRef, b: OpencodeServerRef): boolean {
  return a.url === b.url && a.password === b.password;
}

function validRef(ref: OpencodeServerRef): Error | null {
  if (!ref || typeof ref.url !== "string" || !isLoopbackOpencodeUrl(ref.url)) {
    return new Error("OpenCode server URL must be an http loopback address");
  }
  if (!ref.password) return new Error("OpenCode server password is empty");
  return null;
}

function hasEntries(srv: HubServer): boolean {
  for (const list of srv.entries.values()) if (list.length > 0) return true;
  return false;
}

function sessionIdOf(e: OpencodeEnvelope): string | undefined {
  const d = e.data;
  if (!d || typeof d !== "object") return undefined;
  if (typeof d.sessionID === "string") return d.sessionID;
  if (d.form && typeof d.form === "object" && typeof d.form.sessionID === "string") return d.form.sessionID;
  return undefined;
}

function isUnref(t: unknown): t is { unref(): void } {
  return !!t && typeof (t as { unref?: unknown }).unref === "function";
}

function callGuarded(srv: HubServer, sessionId: string | undefined, what: string, fn: () => unknown): void {
  try {
    const r = fn();
    if (r && typeof (r as { then?: unknown }).then === "function") {
      (r as Promise<unknown>).catch((err) => warn(`${what} rejected`, srv.key, sessionId, err));
    }
  } catch (err) {
    warn(`${what} threw`, srv.key, sessionId, err);
  }
}

function claimOwner(srv: HubServer, root: string, sessionId: string, parent: string | undefined, depth: number): Owned | null {
  const existing = srv.owned.get(sessionId);
  if (existing) return existing;
  const set = srv.ownedByRoot.get(root);
  if (!set || set.size >= MAX_OWNED_PER_ROOT || depth > MAX_CHILD_DEPTH) return null;
  const origin: OpencodeHubOrigin = Object.freeze({
    sessionId,
    isChild: parent !== undefined,
    ...(parent !== undefined ? { childOf: parent } : {}),
    depth,
  });
  const rec: Owned = { root, origin };
  srv.owned.set(sessionId, rec);
  set.add(sessionId);
  return rec;
}

function releaseRoot(srv: HubServer, root: string): void {
  const set = srv.ownedByRoot.get(root);
  if (set) for (const id of set) srv.owned.delete(id);
  srv.ownedByRoot.delete(root);
}

// ------------------------------------------------------------ stream lifecycle

function clearTimers(srv: HubServer): void {
  if (srv.retryTimer) clearTimeout(srv.retryTimer);
  srv.retryTimer = null;
}

/** Close the current stream on purpose; its late callbacks are ignored. */
function dropStream(srv: HubServer): void {
  srv.gen++;
  const s = srv.stream;
  srv.stream = null;
  srv.connected = false;
  if (s) {
    stats.concurrent = Math.max(0, stats.concurrent - 1);
    try {
      s.close();
    } catch {
      // Already closed.
    }
  }
}

function disposeServer(srv: HubServer): void {
  clearTimers(srv);
  dropStream(srv);
  if (servers.get(srv.key) === srv) servers.delete(srv.key);
}

/** Close the stream when nobody needs it. */
function maybeDispose(srv: HubServer): void {
  if (!hasEntries(srv) && srv.watched.size === 0) disposeServer(srv);
}

function connect(srv: HubServer): void {
  if (srv.stream || srv.retryTimer) return;
  const gen = ++srv.gen;
  try {
    const stream = openOpencodeEventStream(
      srv.ref,
      {
        onEvent: (e) => onStreamEvent(srv, gen, e),
        onClose: (reason, err) => onStreamClose(srv, gen, reason, err),
      },
      testFetch ? { fetchImpl: testFetch } : {},
    );
    // The stream may have closed inside its own open call (onClose already ran,
    // bumped the generation and scheduled the retry): do not keep a dead handle.
    if (srv.gen !== gen) return;
    srv.stream = stream;
    // `concurrent` counts streams that exist (connecting or open) until dropped or closed.
    stats.streamsOpened++;
    stats.concurrent++;
    stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.concurrent);
  } catch (err) {
    // A ref the http module refuses (validated earlier, so not expected): count it as a failed attempt.
    srv.stream = null;
    queueMicrotask(() => onStreamClose(srv, gen, "error", err));
  }
}

function backoffDelay(attempt: number): number {
  const raw = Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.max(0, Math.round(raw * (0.5 + Math.random() * 0.5)));
}

function onStreamClose(srv: HubServer, gen: number, reason: string, err?: unknown): void {
  if (srv.gen !== gen) return; // closed on purpose, or replaced
  srv.gen++;
  if (srv.stream) stats.concurrent = Math.max(0, stats.concurrent - 1);
  srv.stream = null;
  const wasConnected = srv.connected;
  srv.connected = false;
  if (servers.get(srv.key) !== srv) return;
  if (!hasEntries(srv) && srv.watched.size === 0) {
    disposeServer(srv);
    return;
  }
  let attempt: number;
  let label: string;
  if (wasConnected) {
    // A stream that lived: its drop is not a failed attempt. Short-lived ones
    // are counted in a window so a flapping server still ends up lost.
    const now = Date.now();
    if (now - srv.connectedAt >= backoff.stableMs) srv.drops = [];
    else {
      srv.drops = srv.drops.filter((t) => now - t < backoff.dropWindowMs);
      srv.drops.push(now);
      if (srv.drops.length >= backoff.maxDrops) {
        giveUp(srv, err ?? new Error(`OpenCode event stream ${reason}`));
        return;
      }
    }
    attempt = Math.max(1, srv.drops.length);
    label = `drop ${srv.drops.length}/${backoff.maxDrops}`;
  } else {
    srv.failures++;
    if (srv.failures >= backoff.maxFailures) {
      giveUp(srv, err ?? new Error(`OpenCode event stream ${reason}`));
      return;
    }
    attempt = srv.failures;
    label = `attempt ${srv.failures}/${backoff.maxFailures}`;
  }
  const delay = backoffDelay(attempt);
  warn(`event stream ${reason}; reconnect (${label}) in ${delay} ms`, srv.key, undefined, err);
  const timer = setTimeout(() => {
    if (srv.retryTimer !== timer) return;
    srv.retryTimer = null;
    if (servers.get(srv.key) === srv) connect(srv);
  }, delay);
  if (isUnref(timer)) timer.unref();
  srv.retryTimer = timer;
}

function giveUp(srv: HubServer, err: unknown): void {
  warn("reconnect gave up", srv.key, undefined, err);
  clearTimers(srv);
  const hadWatch = srv.watched.size > 0;
  const all: Entry[] = [];
  for (const list of srv.entries.values()) all.push(...list);
  srv.entries.clear();
  srv.owned.clear();
  srv.ownedByRoot.clear();
  // Nothing retries from here: the record (watches included) is gone, and the
  // next subscribe or watch starts a fresh one.
  if (servers.get(srv.key) === srv) servers.delete(srv.key);
  for (const entry of all) {
    if (!entry.settleReady.done) {
      entry.settleReady.done = true;
      entry.settleReady.reject(err instanceof Error ? err : new Error("OpenCode server lost"));
    }
    const fn = entry.sub.onServerLost;
    if (fn) callGuarded(srv, entry.root, "onServerLost", () => fn.call(entry.sub, err));
  }
  const lost = watchLostHandler;
  if (hadWatch && lost) callGuarded(srv, undefined, "watch-lost handler", () => lost(srv.key));
}

// ---------------------------------------------------------------- event path

function onStreamEvent(srv: HubServer, gen: number, e: OpencodeEnvelope): void {
  if (srv.gen !== gen) return;
  try {
    if (e.type === "server.connected") {
      onConnected(srv, gen);
      return;
    }
    route(srv, e);
  } catch (err) {
    // Never let a bug here end the stream (the http reader would treat a throw as a stream error).
    warn("event handling failed", srv.key, sessionIdOf(e), err);
  }
}

function isExecutionEnd(type: string): boolean {
  return type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted";
}

function wakeKey(sid: string, e: OpencodeEnvelope): string {
  return e.id ?? `${sid}:${e.created ?? ""}`;
}

function route(srv: HubServer, e: OpencodeEnvelope): void {
  const sid = sessionIdOf(e);
  if (!sid) return;
  let owner = srv.owned.get(sid);

  if (!owner && e.type === "session.created") {
    const parentID = e.data?.parentID;
    if (typeof parentID === "string") {
      const parent = srv.owned.get(parentID);
      if (parent) owner = claimOwner(srv, parent.root, sid, parentID, parent.origin.depth + 1) ?? undefined;
    }
  }

  // Execution bookkeeping for watched roots comes BEFORE dispatch, so a
  // subscriber that unsubscribes from inside onEvent sees the up-to-date state.
  const started = e.type === "session.execution.started";
  if ((started || isExecutionEnd(e.type)) && srv.watched.has(sid)) {
    srv.lastExec.set(sid, ++srv.execSeq);
    if (started) srv.openExec.set(sid, e);
    else {
      srv.openExec.delete(sid);
      srv.woken.delete(sid);
    }
  }
  if (started) maybeWake(srv, sid, e, owner);

  if (!owner) return;
  const list = srv.entries.get(owner.root);
  if (!list || list.length === 0) return;
  for (const entry of list.length === 1 ? list : [...list]) {
    callGuarded(srv, sid, "onEvent", () => entry.sub.onEvent(e, owner!.origin));
  }
}

function maybeWake(srv: HubServer, sid: string, e: OpencodeEnvelope, owner: Owned | undefined): void {
  if (!srv.watched.has(sid)) return;
  // A subscribed session does not wake now: its driver handles the next
  // execution itself, and `openExec` makes the wake fire if the driver
  // unsubscribes while that execution is still open.
  if ((srv.entries.get(sid)?.length ?? 0) > 0 || owner) return;
  if (srv.woken.has(sid)) return; // an earlier wake (e.g. from a snapshot) already covers this execution
  fireWake(srv, sid, e);
}

function fireWake(srv: HubServer, sid: string, e: OpencodeEnvelope): void {
  const key = wakeKey(sid, e);
  if (srv.wakeSeen.has(key)) return;
  srv.wakeSeen.add(key);
  if (srv.wakeSeen.size > WAKE_DEDUPE_MAX) {
    const oldest = srv.wakeSeen.values().next().value;
    if (oldest !== undefined) srv.wakeSeen.delete(oldest);
  }
  srv.woken.add(sid);
  const fn = wakeHandler;
  if (!fn) return;
  callGuarded(srv, sid, "wake handler", () => fn(srv.key, sid, e));
}

function onConnected(srv: HubServer, gen: number): void {
  srv.connected = true;
  srv.connectedAt = Date.now();
  srv.connects++;
  srv.failures = 0; // consecutive attempts that never connected: this one did

  const resyncSet = new Set<Entry>();
  const freshSet = new Set<Entry>();
  const roots: string[] = [];
  for (const [root, list] of srv.entries) {
    roots.push(root);
    for (const entry of list) (entry.live ? resyncSet : freshSet).add(entry);
  }
  // Each root re-seeds on its own; one slow tree does not hold the others back.
  for (const root of roots) {
    reseedRoot(srv, gen, root, resyncSet, freshSet).catch((err) => warn("connect handling failed", srv.key, root, err));
  }
  wakeResync(srv, gen).catch((err) => warn("active-session check failed", srv.key, undefined, err));
}

async function reseedRoot(srv: HubServer, gen: number, root: string, resyncSet: Set<Entry>, freshSet: Set<Entry>): Promise<void> {
  // Children first, so the subscriber's refetch can already attribute a child's state.
  await seedChildren(srv, gen, root);
  if (srv.gen !== gen || servers.get(srv.key) !== srv) return; // dropped again; the next connect resyncs
  const list = srv.entries.get(root);
  if (!list) return;
  for (const entry of [...list]) {
    if (freshSet.has(entry)) {
      entry.live = true;
      if (!entry.settleReady.done) {
        entry.settleReady.done = true;
        entry.settleReady.resolve();
      }
    } else if (resyncSet.has(entry)) {
      callGuarded(srv, root, "onResync", () => entry.sub.onResync(ownedOrigins(srv, root)));
    }
  }
}

function ownedOrigins(srv: HubServer, root: string): OpencodeHubOrigin[] {
  const out: OpencodeHubOrigin[] = [];
  const set = srv.ownedByRoot.get(root);
  if (!set) return out;
  for (const id of set) {
    const rec = srv.owned.get(id);
    if (rec) out.push({ ...rec.origin });
  }
  return out;
}

/** Wake for watched sessions the server reports running while nobody is attached (a gap, or a fresh core). */
async function wakeResync(srv: HubServer, gen: number, only?: ReadonlySet<string>): Promise<void> {
  if (srv.watched.size === 0) return;
  const startSeq = srv.execSeq;
  let active: Record<string, unknown>;
  try {
    active = await createOpencodeClient(srv.ref).activeSessions();
  } catch (err) {
    warn("active-session check failed", srv.key, undefined, err);
    return;
  }
  if (hooks.afterActiveSessions) await hooks.afterActiveSessions(srv.key);
  if (srv.gen !== gen || servers.get(srv.key) !== srv) return;
  for (const sid of only ?? srv.watched) {
    if (!srv.watched.has(sid)) continue;
    // A live execution event arrived after the request began: it is newer than the snapshot.
    if ((srv.lastExec.get(sid) ?? 0) > startSeq) continue;
    if (active[sid] === undefined) {
      srv.woken.delete(sid);
      srv.openExec.delete(sid);
      continue;
    }
    const e: OpencodeEnvelope = { id: `resync:${srv.connects}:${sid}`, type: "session.execution.started", data: { sessionID: sid } };
    if ((srv.entries.get(sid)?.length ?? 0) > 0) {
      // Attached: remember the open execution so unsubscribing while it runs wakes.
      if (!srv.openExec.has(sid)) srv.openExec.set(sid, e);
      continue;
    }
    if (srv.woken.has(sid)) continue;
    srv.openExec.set(sid, e);
    fireWake(srv, sid, e);
  }
}

/** Learn `root`'s existing descendants (bounded breadth-first walk, one request per session). */
async function seedChildren(srv: HubServer, gen: number, root: string): Promise<void> {
  const stale = (): boolean => servers.get(srv.key) !== srv || srv.gen !== gen || !srv.ownedByRoot.has(root);
  let client;
  try {
    client = createOpencodeClient(srv.ref);
  } catch (err) {
    warn("could not seed child sessions", srv.key, root, err);
    return;
  }
  if (hooks.beforeSeed) {
    await hooks.beforeSeed(srv.key, root);
    if (stale()) return;
  }
  const queue: Array<{ id: string; depth: number }> = [{ id: root, depth: 0 }];
  let seen = 0;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.depth >= MAX_CHILD_DEPTH) continue;
    if (++seen > MAX_OWNED_PER_ROOT) return;
    let kids: unknown[];
    try {
      kids = await client.listChildren(cur.id);
    } catch (err) {
      warn("could not list child sessions", srv.key, cur.id, err);
      return;
    }
    // The root may have been unsubscribed, or the stream replaced, while we waited.
    if (stale()) return;
    for (const k of kids) {
      const id = (k as { id?: unknown } | null)?.id;
      if (typeof id !== "string") continue;
      const rec = claimOwner(srv, root, id, cur.id, cur.depth + 1);
      if (rec) queue.push({ id, depth: cur.depth + 1 });
    }
  }
}

// -------------------------------------------------------------------- public

function getOrCreate(key: string, ref: OpencodeServerRef, epoch: number | undefined): HubServer {
  let srv = servers.get(key);
  if (srv && !refsEqual(srv.ref, ref)) {
    if (epoch !== undefined && srv.epoch !== undefined && epoch < srv.epoch) {
      warn("ignoring a server ref older than the current one", key);
      return srv;
    }
    // A newer epoch means the server process was restarted: every execution the
    // existing subscribers were following died with it, so they are told and
    // dropped (the driver settles them) instead of resynced onto a new server.
    const restarted = epoch !== undefined && srv.epoch !== undefined && epoch > srv.epoch;
    const lostEntries: Entry[] = [];
    if (restarted) {
      for (const list of srv.entries.values()) lostEntries.push(...list);
      srv.entries.clear();
      srv.owned.clear();
      srv.ownedByRoot.clear();
    }
    // Otherwise (same or unknown epoch) keep the subscribers and resync them on
    // the new stream. The failure count carries over; only a connect resets it.
    clearTimers(srv);
    dropStream(srv);
    srv.ref = { url: ref.url, password: ref.password };
    if (epoch !== undefined) srv.epoch = epoch;
    srv.woken.clear();
    srv.openExec.clear();
    srv.lastExec.clear();
    if (lostEntries.length > 0) {
      const err = new Error("OpenCode server restarted");
      for (const entry of lostEntries) {
        if (!entry.settleReady.done) {
          entry.settleReady.done = true;
          entry.settleReady.reject(err);
        }
        const fn = entry.sub.onServerLost;
        if (fn) callGuarded(srv, entry.root, "onServerLost", () => fn.call(entry.sub, err));
      }
    }
    return srv;
  }
  if (!srv) {
    srv = {
      key,
      ref: { url: ref.url, password: ref.password },
      epoch,
      stream: null,
      gen: 0,
      connected: false,
      connects: 0,
      connectedAt: 0,
      failures: 0,
      drops: [],
      retryTimer: null,
      entries: new Map(),
      owned: new Map(),
      ownedByRoot: new Map(),
      watched: new Set(),
      woken: new Set(),
      openExec: new Map(),
      lastExec: new Map(),
      execSeq: 0,
      wakeSeen: new Set(),
    };
    servers.set(key, srv);
  }
  return srv;
}

export function subscribeOpencodeSession(
  server: OpencodeHubServer,
  rootSessionId: string,
  sub: OpencodeHubSubscriber,
): { unsubscribe(): void; ready: Promise<void> } {
  const bad = validRef(server);
  if (bad || !rootSessionId) {
    const failed = Promise.reject(bad ?? new Error("OpenCode session id is empty"));
    failed.catch(() => {});
    return { unsubscribe() {}, ready: failed };
  }
  const srv = getOrCreate(server.key, server, server.epoch);
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const ready = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  ready.catch(() => {}); // a caller that never awaits `ready` must not trigger an unhandled rejection
  const entry: Entry = { root: rootSessionId, sub, live: false, settleReady: { resolve, reject, done: false } };

  let list = srv.entries.get(rootSessionId);
  if (!list) {
    list = [];
    srv.entries.set(rootSessionId, list);
  }
  list.push(entry);
  if (!srv.ownedByRoot.has(rootSessionId)) srv.ownedByRoot.set(rootSessionId, new Set());
  claimOwner(srv, rootSessionId, rootSessionId, undefined, 0);
  srv.woken.delete(rootSessionId); // an attached driver now owns whatever is running

  if (srv.connected) {
    // Already connected: seed this root's existing children, then it is ready.
    const gen = srv.gen;
    entry.live = true;
    seedChildren(srv, gen, rootSessionId)
      .catch((err) => warn("could not seed child sessions", srv.key, rootSessionId, err))
      .finally(() => {
        if (!entry.settleReady.done) {
          entry.settleReady.done = true;
          resolve();
        }
      });
  } else {
    connect(srv);
  }

  let unsubscribed = false;
  return {
    ready,
    unsubscribe() {
      if (unsubscribed) return;
      unsubscribed = true;
      const cur = srv.entries.get(rootSessionId);
      let last = false;
      if (cur) {
        const i = cur.indexOf(entry);
        if (i >= 0) cur.splice(i, 1);
        if (cur.length === 0) {
          srv.entries.delete(rootSessionId);
          releaseRoot(srv, rootSessionId);
          last = true;
        }
      }
      if (!entry.settleReady.done) {
        entry.settleReady.done = true;
        resolve();
      }
      if (servers.get(srv.key) !== srv) return;
      maybeDispose(srv);
      // The turn this driver was attached to has ended, but the server started
      // another one meanwhile (its terminal event has not come): wake for it.
      const open = last && srv.watched.has(rootSessionId) ? srv.openExec.get(rootSessionId) : undefined;
      if (open && !srv.woken.has(rootSessionId)) fireWake(srv, rootSessionId, open);
    },
  };
}

/** The root session and every descendant the hub currently owns for it (empty when not subscribed). */
export function opencodeOwnedSessions(serverKey: string, rootSessionId: string): OpencodeHubOrigin[] {
  const srv = servers.get(serverKey);
  return srv ? ownedOrigins(srv, rootSessionId) : [];
}

export function setOpencodeWakeHandler(fn: OpencodeWakeHandler | null): void {
  wakeHandler = fn;
}

/** Called when the hub gave up on a server that had watched sessions: the watch is gone, so re-watch after the next ensure. */
export function setOpencodeWatchLostHandler(fn: OpencodeWatchLostHandler | null): void {
  watchLostHandler = fn;
}

/**
 * Keep the stream open for these root sessions even with no subscriber
 * (replaces the previous set for the server). Call it again after every server
 * ensure and after `onServerLost` / the watch-lost handler: a give-up deletes
 * the watch.
 */
export function watchOpencodeSessionsForWake(serverKey: string, ref: OpencodeServerRef & { epoch?: number }, sessionIds: string[]): void {
  const ids = sessionIds.filter((s) => typeof s === "string" && s.length > 0);
  if (ids.length === 0) {
    const srv = servers.get(serverKey);
    if (srv) {
      srv.watched.clear();
      srv.woken.clear();
      srv.openExec.clear();
      srv.lastExec.clear();
      maybeDispose(srv);
    }
    return;
  }
  const bad = validRef(ref);
  if (bad) {
    warn("watch ignored: invalid server ref", serverKey, undefined, bad);
    return;
  }
  const srv = getOrCreate(serverKey, ref, ref.epoch);
  const added = new Set(ids.filter((s) => !srv.watched.has(s)));
  srv.watched = new Set(ids);
  for (const m of [srv.woken, srv.openExec, srv.lastExec] as Array<Set<string> | Map<string, unknown>>) {
    for (const sid of [...m.keys()]) if (!srv.watched.has(sid)) m.delete(sid);
  }
  connect(srv);
  // On a stream that is already connected nothing else looks at the newly
  // watched sessions (onConnected only runs on connect): one may be running.
  if (srv.connected && added.size > 0) {
    wakeResync(srv, srv.gen, added).catch((err) => warn("active-session check failed", srv.key, undefined, err));
  }
}

/**
 * Close one server's stream (or all), dropping its subscribers and watches.
 * A subscriber that was already ready gets `onServerLost`; one still waiting
 * gets its `ready` rejected.
 */
export function closeOpencodeHub(serverKey?: string): void {
  const targets = serverKey === undefined ? [...servers.values()] : [servers.get(serverKey)].filter((s): s is HubServer => !!s);
  const err = new Error("OpenCode hub closed");
  const notify: Array<{ srv: HubServer; entry: Entry }> = [];
  for (const srv of targets) {
    for (const list of srv.entries.values()) {
      for (const entry of list) {
        if (!entry.settleReady.done) {
          entry.settleReady.done = true;
          entry.settleReady.reject(err);
        } else notify.push({ srv, entry });
      }
    }
    srv.entries.clear();
    srv.owned.clear();
    srv.ownedByRoot.clear();
    srv.watched.clear();
    srv.woken.clear();
    srv.openExec.clear();
    srv.lastExec.clear();
    disposeServer(srv);
  }
  // After the records are gone, so a callback that subscribes again starts afresh.
  for (const { srv, entry } of notify) {
    const fn = entry.sub.onServerLost;
    if (fn) callGuarded(srv, entry.root, "onServerLost", () => fn.call(entry.sub, err));
  }
}

export const __forTest = {
  /** Override the reconnect policy; call `resetBackoff()` in afterEach. */
  setBackoff(o: Partial<typeof DEFAULT_BACKOFF>): void {
    backoff = { ...backoff, ...o };
  },
  resetBackoff(): void {
    backoff = { ...DEFAULT_BACKOFF };
  },
  /** Awaited at the start of a root's child seeding / after the wake check's active-session fetch. */
  setHooks(h: { beforeSeed?: typeof hooks.beforeSeed; afterActiveSessions?: typeof hooks.afterActiveSessions }): void {
    hooks.beforeSeed = h.beforeSeed;
    hooks.afterActiveSessions = h.afterActiveSessions;
  },
  /** Route the event stream through this fetch (null restores the default); also clears the hooks. */
  setFetchImpl(f: typeof fetch | null): void {
    testFetch = f;
  },
  clearHooks(): void {
    hooks.beforeSeed = undefined;
    hooks.afterActiveSessions = undefined;
    testFetch = null;
  },
  /** Internal state of one server, or null when the hub holds no record of it. */
  probe(key: string): {
    streamOpen: boolean;
    connected: boolean;
    connects: number;
    failures: number;
    drops: number;
    openExec: string[];
    retryPending: boolean;
    subscribers: number;
    watched: string[];
    owned: string[];
    woken: string[];
  } | null {
    const srv = servers.get(key);
    if (!srv) return null;
    let subscribers = 0;
    for (const l of srv.entries.values()) subscribers += l.length;
    return {
      streamOpen: srv.stream !== null,
      connected: srv.connected,
      connects: srv.connects,
      failures: srv.failures,
      drops: srv.drops.length,
      openExec: [...srv.openExec.keys()],
      retryPending: srv.retryTimer !== null,
      subscribers,
      watched: [...srv.watched],
      owned: [...srv.owned.keys()],
      woken: [...srv.woken],
    };
  },
  serverKeys(): string[] {
    return [...servers.keys()];
  },
  /** Streams ever opened and the most that existed at once (must stay 1 per key). */
  streamStats(): { opened: number; maxConcurrent: number } {
    return { opened: stats.streamsOpened, maxConcurrent: stats.maxConcurrent };
  },
  resetStreamStats(): void {
    stats.streamsOpened = 0;
    stats.maxConcurrent = stats.concurrent;
  },
};

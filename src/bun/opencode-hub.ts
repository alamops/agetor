/**
 * The OpenCode server hub: ONE SSE subscription per agetor-owned `opencode
 * serve`, fanned out to per-session subscribers (plan:
 * `docs/plans/opencode-server-driver.md`, T7; decisions D7 and D13).
 *
 * What it owns:
 *   - The stream lifecycle per server key (the harness id): opened lazily on the
 *     first subscriber or watched session, closed when neither remains, and
 *     reopened on demand. A changed ref (new url or password after a server
 *     restart) for the same key replaces the stream. Exactly one stream per key
 *     exists at any time (single-flight connect, a generation counter drops
 *     callbacks of a stale stream).
 *   - Ownership: which session ids belong to which subscriber. A subscriber
 *     names a root session; its children (and their children, depth <= 4,
 *     <= 500 sessions per root) are learned from `session.created{parentID}`
 *     and seeded from `GET /api/session?parentID=` on subscribe and after every
 *     resync, so a child created while the stream was down is still owned.
 *     Events for sessions nobody owns are dropped (wake detection aside).
 *   - Stream loss: any close that is not ours triggers a reconnect with
 *     exponential backoff (1 s to 30 s, jittered). Ten consecutive failures give
 *     up: every subscriber gets `onServerLost` and is dropped, and nothing
 *     retries until the next subscribe/watch. OpenCode replays nothing, so
 *     after each successful reopen every subscriber that was already live gets
 *     exactly one `onResync()` (after `server.connected` and after the children
 *     were re-seeded) and must refetch its state.
 *   - Wake (D7): a `session.execution.started` for a watched root session that
 *     has no subscriber means OpenCode started a turn on its own (a background
 *     subagent finished and its result was queued). The wake handler is called
 *     once per execution (deduped by envelope id). After a reconnect, watched
 *     sessions that are active but have no subscriber are woken too, since the
 *     `execution.started` may have fallen into the gap.
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
  /** The stream was lost and is back: refetch state (messages, pending permissions and forms). */
  onResync(): void;
  /** Reconnecting gave up (attempt cap reached): settle as failed. The subscriber is dropped. */
  onServerLost?(err?: unknown): void;
}

export type OpencodeHubServer = { key: string } & OpencodeServerRef;
export type OpencodeWakeHandler = (serverKey: string, sessionId: string, e: OpencodeEnvelope) => void;

/** Children of children are followed this deep (the root is depth 0). */
const MAX_CHILD_DEPTH = 4;
/** Sessions owned per root, the root included. */
const MAX_OWNED_PER_ROOT = 500;
/** Envelope ids remembered for wake dedupe. */
const WAKE_DEDUPE_MAX = 256;

const DEFAULT_BACKOFF = {
  baseMs: 1000,
  maxMs: 30_000,
  maxFailures: 10,
  /** A stream that stays up this long resets the failure count. */
  stableMs: 10_000,
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
  stream: OpencodeEventStream | null;
  /** Bumped whenever a stream is replaced or closed on purpose; stale callbacks compare against it. */
  gen: number;
  /** `server.connected` was seen on the current stream. */
  connected: boolean;
  /** Connections that reached `server.connected` during this server record's life. */
  connects: number;
  failures: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  stableTimer: ReturnType<typeof setTimeout> | null;
  entries: Map<string, Entry[]>;
  owned: Map<string, Owned>;
  ownedByRoot: Map<string, Set<string>>;
  watched: Set<string>;
  /** Watched sessions the wake handler fired for whose execution has not ended. */
  woken: Set<string>;
  wakeSeen: Set<string>;
}

const servers = new Map<string, HubServer>();
let wakeHandler: OpencodeWakeHandler | null = null;
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
  if (srv.stableTimer) clearTimeout(srv.stableTimer);
  srv.stableTimer = null;
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
    srv.stream = openOpencodeEventStream(srv.ref, {
      onEvent: (e) => onStreamEvent(srv, gen, e),
      onClose: (reason, err) => onStreamClose(srv, gen, reason, err),
    });
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

function backoffDelay(failures: number): number {
  const raw = Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.max(0, failures - 1));
  return Math.max(0, Math.round(raw * (0.5 + Math.random() * 0.5)));
}

function onStreamClose(srv: HubServer, gen: number, reason: string, err?: unknown): void {
  if (srv.gen !== gen) return; // closed on purpose, or replaced
  srv.gen++;
  if (srv.stream) stats.concurrent = Math.max(0, stats.concurrent - 1);
  srv.stream = null;
  srv.connected = false;
  if (srv.stableTimer) clearTimeout(srv.stableTimer);
  srv.stableTimer = null;
  if (servers.get(srv.key) !== srv) return;
  if (!hasEntries(srv) && srv.watched.size === 0) {
    disposeServer(srv);
    return;
  }
  srv.failures++;
  if (srv.failures >= backoff.maxFailures) {
    giveUp(srv, err ?? new Error(`OpenCode event stream ${reason}`));
    return;
  }
  const delay = backoffDelay(srv.failures);
  warn(`event stream ${reason}; reconnect ${srv.failures}/${backoff.maxFailures} in ${delay} ms`, srv.key, undefined, err);
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
  const all: Entry[] = [];
  for (const list of srv.entries.values()) all.push(...list);
  srv.entries.clear();
  srv.owned.clear();
  srv.ownedByRoot.clear();
  for (const entry of all) {
    if (!entry.settleReady.done) {
      entry.settleReady.done = true;
      entry.settleReady.reject(err instanceof Error ? err : new Error("OpenCode server lost"));
    }
    const fn = entry.sub.onServerLost;
    if (fn) callGuarded(srv, entry.root, "onServerLost", () => fn.call(entry.sub, err));
  }
  // Nothing retries from here: the record (watches included) is gone, and the
  // next subscribe or watch starts a fresh one.
  if (servers.get(srv.key) === srv) servers.delete(srv.key);
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

  if (e.type === "session.execution.started") maybeWake(srv, sid, e, owner);
  else if (
    srv.woken.size > 0 &&
    (e.type === "session.execution.succeeded" || e.type === "session.execution.failed" || e.type === "session.execution.interrupted")
  ) {
    srv.woken.delete(sid);
  }

  if (!owner) return;
  const list = srv.entries.get(owner.root);
  if (!list || list.length === 0) return;
  for (const entry of list.length === 1 ? list : [...list]) {
    callGuarded(srv, sid, "onEvent", () => entry.sub.onEvent(e, owner!.origin));
  }
}

function maybeWake(srv: HubServer, sid: string, e: OpencodeEnvelope, owner: Owned | undefined): void {
  if (!srv.watched.has(sid)) return;
  // A subscribed session never wakes: its driver handles the next execution itself.
  if ((srv.entries.get(sid)?.length ?? 0) > 0 || owner) return;
  const dedupe = e.id ?? `${sid}:${e.created ?? ""}`;
  if (srv.wakeSeen.has(dedupe)) return;
  fireWake(srv, sid, e, dedupe);
}

function fireWake(srv: HubServer, sid: string, e: OpencodeEnvelope, dedupe: string): void {
  srv.wakeSeen.add(dedupe);
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
  srv.connects++;
  const reconnect = srv.connects > 1;
  if (srv.stableTimer) clearTimeout(srv.stableTimer);
  const stable = setTimeout(() => {
    if (srv.gen === gen) srv.failures = 0;
  }, backoff.stableMs);
  if (isUnref(stable)) stable.unref();
  srv.stableTimer = stable;

  const resync: Entry[] = [];
  const fresh: Entry[] = [];
  for (const list of srv.entries.values()) {
    for (const entry of list) (entry.live ? resync : fresh).push(entry);
  }
  void (async () => {
    // Re-seed children for every root first, so the subscriber's refetch can
    // already attribute a child's state to the right owner.
    for (const root of [...srv.entries.keys()]) {
      if (srv.gen !== gen) return;
      await seedChildren(srv, gen, root);
    }
    if (srv.gen !== gen) return; // dropped again; the next connect resyncs
    for (const entry of fresh) {
      entry.live = true;
      if (!entry.settleReady.done) {
        entry.settleReady.done = true;
        entry.settleReady.resolve();
      }
    }
    for (const entry of resync) {
      if (!isRegistered(srv, entry)) continue;
      callGuarded(srv, entry.root, "onResync", () => entry.sub.onResync());
    }
    if (reconnect) await wakeResync(srv, gen);
  })().catch((err) => warn("connect handling failed", srv.key, undefined, err));
}

function isRegistered(srv: HubServer, entry: Entry): boolean {
  return srv.entries.get(entry.root)?.includes(entry) === true;
}

/** After a gap: wake for watched sessions that are running with nobody attached. */
async function wakeResync(srv: HubServer, gen: number): Promise<void> {
  if (srv.watched.size === 0) return;
  let active: Record<string, unknown>;
  try {
    active = await createOpencodeClient(srv.ref).activeSessions();
  } catch (err) {
    warn("active-session check after reconnect failed", srv.key, undefined, err);
    return;
  }
  if (srv.gen !== gen) return;
  for (const sid of srv.watched) {
    const isActive = active[sid] !== undefined;
    if (!isActive) {
      srv.woken.delete(sid);
      continue;
    }
    if ((srv.entries.get(sid)?.length ?? 0) > 0 || srv.woken.has(sid)) continue;
    const e: OpencodeEnvelope = { id: `resync:${srv.connects}:${sid}`, type: "session.execution.started", data: { sessionID: sid } };
    fireWake(srv, sid, e, e.id!);
  }
}

/** Learn `root`'s existing descendants (bounded breadth-first walk, one request per session). */
async function seedChildren(srv: HubServer, gen: number, root: string): Promise<void> {
  let client;
  try {
    client = createOpencodeClient(srv.ref);
  } catch (err) {
    warn("could not seed child sessions", srv.key, root, err);
    return;
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
    if (servers.get(srv.key) !== srv || srv.gen !== gen || !srv.ownedByRoot.has(root)) return;
    for (const k of kids) {
      const id = (k as { id?: unknown } | null)?.id;
      if (typeof id !== "string") continue;
      const rec = claimOwner(srv, root, id, cur.id, cur.depth + 1);
      if (rec) queue.push({ id, depth: cur.depth + 1 });
    }
  }
}

// -------------------------------------------------------------------- public

function getOrCreate(key: string, ref: OpencodeServerRef): HubServer {
  let srv = servers.get(key);
  if (srv && !refsEqual(srv.ref, ref)) {
    // The server restarted (new url or password): replace the stream, keep the subscribers.
    clearTimers(srv);
    dropStream(srv);
    srv.ref = { url: ref.url, password: ref.password };
    srv.failures = 0;
    srv.woken.clear();
    return srv;
  }
  if (!srv) {
    srv = {
      key,
      ref: { url: ref.url, password: ref.password },
      stream: null,
      gen: 0,
      connected: false,
      connects: 0,
      failures: 0,
      retryTimer: null,
      stableTimer: null,
      entries: new Map(),
      owned: new Map(),
      ownedByRoot: new Map(),
      watched: new Set(),
      woken: new Set(),
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
  const srv = getOrCreate(server.key, server);
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
      if (cur) {
        const i = cur.indexOf(entry);
        if (i >= 0) cur.splice(i, 1);
        if (cur.length === 0) {
          srv.entries.delete(rootSessionId);
          releaseRoot(srv, rootSessionId);
        }
      }
      if (!entry.settleReady.done) {
        entry.settleReady.done = true;
        resolve();
      }
      if (servers.get(srv.key) === srv) maybeDispose(srv);
    },
  };
}

export function setOpencodeWakeHandler(fn: OpencodeWakeHandler | null): void {
  wakeHandler = fn;
}

/** Keep the stream open for these root sessions even with no subscriber (replaces the previous set for the server). */
export function watchOpencodeSessionsForWake(serverKey: string, ref: OpencodeServerRef, sessionIds: string[]): void {
  const ids = sessionIds.filter((s) => typeof s === "string" && s.length > 0);
  if (ids.length === 0) {
    const srv = servers.get(serverKey);
    if (srv) {
      srv.watched.clear();
      srv.woken.clear();
      maybeDispose(srv);
    }
    return;
  }
  const bad = validRef(ref);
  if (bad) {
    warn("watch ignored: invalid server ref", serverKey, undefined, bad);
    return;
  }
  const srv = getOrCreate(serverKey, ref);
  srv.watched = new Set(ids);
  for (const sid of [...srv.woken]) if (!srv.watched.has(sid)) srv.woken.delete(sid);
  connect(srv);
}

/** Close one server's stream (or all), dropping its subscribers and watches. Pending `ready`s reject. */
export function closeOpencodeHub(serverKey?: string): void {
  const targets = serverKey === undefined ? [...servers.values()] : [servers.get(serverKey)].filter((s): s is HubServer => !!s);
  for (const srv of targets) {
    for (const list of srv.entries.values()) {
      for (const entry of list) {
        if (!entry.settleReady.done) {
          entry.settleReady.done = true;
          entry.settleReady.reject(new Error("OpenCode hub closed"));
        }
      }
    }
    srv.entries.clear();
    srv.owned.clear();
    srv.ownedByRoot.clear();
    srv.watched.clear();
    srv.woken.clear();
    disposeServer(srv);
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
  /** Internal state of one server, or null when the hub holds no record of it. */
  probe(key: string): {
    streamOpen: boolean;
    connected: boolean;
    connects: number;
    failures: number;
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

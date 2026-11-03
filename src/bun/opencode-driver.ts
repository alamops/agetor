/**
 * The OpenCode v2 turn driver on the agetor-owned `opencode serve`
 * (docs/plans/opencode-server-driver.md, T9; decisions D4, D5, D7, D11, D12,
 * invariants I1 to I9).
 *
 * One turn is one `SpawnedAgent`-shaped handle. `spawnOpencodeServerTurn`
 * starts a turn (server, session, prompt), `attachOpencodeServerTurn` joins one
 * that is already running on the server (an agetor restart, or an execution
 * the server started on its own, D7). Both share one core:
 *
 *   server (`ensureOpencodeServer`) -> session (create / resume / reconcile)
 *     -> hub subscription (`ready` awaited BEFORE the prompt) -> `prompt`
 *     -> live events through the event mapper -> `execution.*` terminal.
 *
 * Invariants kept here:
 *   - I1 Nothing the model reads is written by agetor. The prompt, a steer, a
 *     permission reason and a skip reason are the user's text verbatim; Skip
 *     with no text sends an empty answer. Status lines are UI-only.
 *   - I5 This module is the only writer of a run's events. Live events and
 *     snapshots go through one mapper, whose line uuids are the dedupe key, so
 *     a resync (hub reconnect, attach) never duplicates a line. A chunk with
 *     `replace: true` overwrites an already persisted event (`onReplace`).
 *   - I6 A card is answered once: the registry in `interactions.ts` owns the
 *     card, this module remembers which request ids it already replied to, and
 *     a stale server answer (404/409) closes the card without an error.
 *   - I9 Snapshot mapping and chunk batches run in short slices with a
 *     `setImmediate` yield between them.
 *
 * Settling. `done` resolves 0 (succeeded), 1 (failed or anything unclear) or
 * 130 (stopped). It never rejects and never hangs: a Stop that OpenCode does
 * not confirm within 10 s settles anyway with a status line. A terminal only
 * counts once OUR prompt was delivered (`session.inbox.delivered`), so the
 * tail of an earlier execution cannot end this turn. A lost terminal (no
 * event, no stream loss) is caught by a slow liveness check that re-reads the
 * session from the server.
 *
 * Catch-up (hub `onResync`, and `attach`). Events are buffered while the
 * message snapshot is fetched and seeded (subscribe -> buffer -> seed ->
 * drain, the mapper's required order). The anchor is OUR user message when its
 * id is known, otherwise the first user or synthetic message after the last
 * `idle` marker that is not newer than the turn's start: a time window alone
 * could anchor on the previous turn's message and settle this turn from the
 * previous turn's outcome. Open cards are re-listed and re-registered
 * (idempotent by request or form id), cards the server no longer holds are
 * closed, and known children are re-synced.
 *
 * Children (subagents) are handed to `opencode-subagents.ts` (T12): their
 * events go through a per-child mapper into `ingestOpencodeChildChunks`, their
 * terminal into `settleOpencodeChild`. A child that is not settled when this
 * turn ends keeps running; T12 settles it later through
 * `syncOpencodeChildFromServer`.
 *
 * Steering. `steer(text)` posts `prompt(delivery:"steer")`; the orchestrator
 * writes the user bubble. A steer that races the very end of the turn can land
 * after the execution closed; OpenCode then starts a fresh execution for it,
 * which the hub reports as a server wake (D7), so the message is not lost.
 */
import {
  createOpencodeClient,
  type OpencodeClient,
  type OpencodeEnvelope,
  type OpencodeModelRef,
  type OpencodePermissionRule,
  type OpencodeServerRef,
} from "./opencode-http.ts";
import { subscribeOpencodeSession, type OpencodeHubOrigin } from "./opencode-hub.ts";
import {
  createOpencodeEventMapper,
  type OpencodeEventMapper,
  type OpencodeMappedChunk,
  type OpencodeTerminal,
} from "./opencode-events.ts";
import { ensureOpencodeServer, noteOpencodeActivity, type OpencodeServerSpec } from "./opencode-server.ts";
import {
  registerOpencodeAskQuestions,
  registerOpencodePermission,
  resolveOpencodeCardsForRequest,
  type FxPermissionToolCall,
  type OpencodeAskField,
} from "./interactions.ts";
import {
  ingestOpencodeChildChunks,
  registerOpencodeChildSession,
  settleOpencodeChild,
  syncOpencodeChildFromServer,
} from "./opencode-subagents.ts";
import { isRec, str, type Rec } from "./opencode-map-helpers.ts";
import type { SpawnedAgent } from "./claude-tmux.ts";
import { OPENCODE_DEFAULT_MODEL } from "../shared/opencode.ts";
import type { RunEventStream } from "../shared/types.ts";

/* ────────────────────────────────────────────────────────────────────────── *
 * Public shapes
 * ────────────────────────────────────────────────────────────────────────── */

export interface OpencodeServerTurnArgs {
  taskId: string;
  runId: string;
  harnessId: string;
  /** Server spec parts (the orchestrator builds them from the harness). */
  bin: string;
  env: Record<string, string>;
  serverCwd: string;
  /** The task's working directory: the session's `location.directory`. */
  cwd: string;
  /** The user's text, verbatim (I1). */
  prompt: string;
  mode: "auto" | "ask" | "plan";
  /** `provider/model`, the OPENCODE_DEFAULT_MODEL sentinel, or null (no model sent). */
  model: string | null;
  /** A variant id, `"auto"` or null (no variant). */
  effort: string | null;
  /** Used only when a fresh session is created (at most 100 code points). */
  title?: string | null;
  resumeSessionId?: string | null;
  /** Whether a turn or an open card is using this harness's server (restart gate of `ensure`). */
  isBusy: () => boolean;
  onChunk: (stream: RunEventStream, data: string, lineUuid?: string) => void;
  /** A `replace: true` chunk: overwrite the persisted event with this line uuid and re-broadcast. */
  onReplace: (lineUuid: string, data: string) => void;
  onSessionId: (sessionId: string) => void;
  /** Status lines (UI-only). Defaults to `onChunk("status", text)`. */
  onStatus?: (text: string) => void;
}

export interface OpencodeServerAttachArgs extends Omit<OpencodeServerTurnArgs, "prompt" | "title" | "resumeSessionId"> {
  sessionId: string;
  /** reattach: when the run started. wake: when the server's `execution.started` envelope was created. */
  sinceMs: number;
  reason: "reattach" | "wake";
}

/** A running turn. `SpawnedAgent` with an awaitable `steer` (the orchestrator's `steer?` is a sync boolean). */
export interface OpencodeServerTurn extends Omit<SpawnedAgent, "steer"> {
  /** Deliver text into the running turn. `"unavailable"`: nothing was sent, queue it as a new turn. */
  steer(text: string): Promise<"accepted" | "unavailable">;
  /** The OpenCode session id once known (null while the session is being created). */
  sessionId(): string | null;
  /**
   * Stop listening WITHOUT interrupting the server: unsubscribe, clear timers.
   * `done` stays pending and the turn keeps running on the server, for a
   * teardown that must not end the run (a core handing over, tests). No-op once settled.
   */
  detach(): void;
}

/** What this driver needs from `opencode-subagents.ts` (T12) and the server manager; injectable for tests. */
export interface OpencodeDriverDeps {
  ensureServer: typeof ensureOpencodeServer;
  registerChild(a: {
    taskId: string;
    runId: string;
    parentSessionId: string;
    childSessionId: string;
    title?: string;
    agent?: string;
    depth: number;
    background?: boolean;
  }): void;
  ingestChildChunks(a: { taskId: string; childSessionId: string; chunks: OpencodeMappedChunk[] }): void;
  settleChild(a: {
    taskId: string;
    childSessionId: string;
    outcome: "completed" | "failed" | "interrupted";
    error?: string;
  }): void;
  syncChild(a: { taskId: string; runId: string; client: OpencodeClient; childSessionId: string }): Promise<void>;
}

const defaultDeps: OpencodeDriverDeps = {
  ensureServer: (spec: OpencodeServerSpec) => ensureOpencodeServer(spec),
  registerChild: (a) => registerOpencodeChildSession(a),
  ingestChildChunks: (a) => ingestOpencodeChildChunks(a),
  settleChild: (a) => settleOpencodeChild(a),
  syncChild: (a) => syncOpencodeChildFromServer(a),
};
let deps: OpencodeDriverDeps = defaultDeps;

/* ────────────────────────────────────────────────────────────────────────── *
 * Constants
 * ────────────────────────────────────────────────────────────────────────── */

export const OPENCODE_STALE_SERVER_STATUS = "OpenCode will pick up the changed harness settings after this turn";
/** Equivalent of `opencodeResumeFailedStatusLine` in agents.ts (importing it would cycle once agents.ts wires this driver; a test pins the two together). */
export function opencodeResumeNotFoundStatus(sessionId: string): string {
  return `couldn't resume OpenCode session ${sessionId.slice(0, 8)}… — starting a fresh session`;
}

const ASK_RULE: OpencodePermissionRule = { action: "*", resource: "*", effect: "ask" };
const TITLE_MAX_CODE_POINTS = 100;
/** Stop: how long to wait for OpenCode's `interrupted` terminal before settling anyway. */
const DEFAULT_STOP_CONFIRM_MS = 10_000;
/** Stop: HTTP budget of the interrupt call itself. */
const DEFAULT_INTERRUPT_TIMEOUT_MS = 3_000;
/** How often a live turn asks the server whether its session is still running. */
const DEFAULT_LIVENESS_MS = 30_000;
/** The hub's `ready` can stay pending for minutes while it backs off; this turn gives up sooner. */
const DEFAULT_READY_MS = 20_000;
/** Snapshot paging: page size and the most pages one catch-up reads. */
const MESSAGE_PAGE_LIMIT = 200;
const MESSAGE_MAX_PAGES = 20;
/** Cooperative slicing (I9). */
const SLICE_MS = 15;
/** Live events held while a catch-up runs; past this the catch-up re-runs instead. */
const BUFFER_MAX = 50_000;
/** Sessions followed per catch-up when re-discovering children. */
const CHILD_SYNC_MAX = 50;
const CHILD_MAX_DEPTH = 4;
/** Attempts for a permission reply that fails on the transport. */
const REPLY_ATTEMPTS = 3;

let timings = {
  stopConfirmMs: DEFAULT_STOP_CONFIRM_MS,
  interruptTimeoutMs: DEFAULT_INTERRUPT_TIMEOUT_MS,
  livenessMs: DEFAULT_LIVENESS_MS,
  replyRetryMs: 300,
  readyMs: DEFAULT_READY_MS,
};

const TERMINAL_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

/* ────────────────────────────────────────────────────────────────────────── *
 * Small helpers
 * ────────────────────────────────────────────────────────────────────────── */

/** Start work nobody awaits; whatever it throws is logged, never unhandled. */
function background(p: Promise<unknown>): void {
  p.catch((e) => console.error("[opencode-driver] background work failed:", e));
}

function yieldTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 300 ? `${msg.slice(0, 300)}...` : msg;
}

function httpStatus(e: unknown): number {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : -1;
}

/** An answer to something the server no longer holds: not an error to show. */
function isStaleReply(e: unknown): boolean {
  const s = httpStatus(e);
  return s === 404 || s === 409;
}

function isTransportFailure(e: unknown): boolean {
  const s = httpStatus(e);
  return s === 0 || s >= 500;
}

function clampTitle(title: string | null | undefined): string | undefined {
  const t = (title ?? "").trim();
  if (t === "") return undefined;
  const points = Array.from(t);
  return points.length > TITLE_MAX_CODE_POINTS ? points.slice(0, TITLE_MAX_CODE_POINTS).join("") : t;
}

/** `provider/model` + variant -> OpenCode's model ref; the sentinel, null and anything without a provider send no model. */
export function opencodeModelRefFor(model: string | null, effort: string | null): OpencodeModelRef | null {
  const m = model?.trim() ?? "";
  if (m === "" || m === OPENCODE_DEFAULT_MODEL) return null;
  const slash = m.indexOf("/");
  if (slash <= 0 || slash === m.length - 1) return null;
  const variant = effort?.trim() ?? "";
  return {
    providerID: m.slice(0, slash),
    id: m.slice(slash + 1),
    ...(variant !== "" && variant !== "auto" ? { variant } : {}),
  };
}

function messageTime(m: unknown): number {
  const t = isRec(m) && isRec(m.time) ? m.time.created : undefined;
  return typeof t === "number" && Number.isFinite(t) ? t : 0;
}

function hasAskRule(rules: unknown): boolean {
  return Array.isArray(rules) && rules.some((r) => isRec(r) && r.action === "*" && r.resource === "*" && r.effect === "ask");
}

/** The permission card's tool call: OpenCode's own words, no agetor prose. */
function permissionToolCall(req: Rec, requestId: string): FxPermissionToolCall {
  const action = str(req.action) ?? "tool";
  const resources = Array.isArray(req.resources) ? req.resources.filter((r): r is string => typeof r === "string") : [];
  const source = isRec(req.source) ? req.source : null;
  const title = resources.length > 0 ? `${action}: ${resources.join(", ")}` : action;
  return {
    toolCallId: str(source?.id) ?? requestId,
    title: title.length > 500 ? `${title.slice(0, 500)}...` : title,
    kind: action,
    rawInput: { resources, metadata: req.metadata },
  };
}

/** A question form's fields on the shared ask card; null when it is not renderable as one. */
function questionFields(raw: unknown): OpencodeAskField[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: OpencodeAskField[] = [];
  for (const f of raw) {
    if (!isRec(f)) return null;
    const key = str(f.key);
    if (!key) return null;
    const title = str(f.title);
    const description = str(f.description);
    const options: OpencodeAskField["options"] = [];
    if (Array.isArray(f.options)) {
      for (const o of f.options) {
        if (!isRec(o)) continue;
        const value = str(o.value);
        if (!value) continue;
        const optDescription = str(o.description);
        options.push({ value, label: str(o.label) ?? value, ...(optDescription ? { description: optDescription } : {}) });
      }
    }
    out.push({
      key,
      question: description ?? title ?? key,
      ...(description && title ? { header: title } : {}),
      multiple: f.type === "multiselect",
      custom: f.custom === true || (f.custom === undefined && f.type !== "multiselect"),
      options,
    });
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * The turn core
 * ────────────────────────────────────────────────────────────────────────── */

type StartSpec =
  | { kind: "spawn"; prompt: string; title: string | null; resumeSessionId: string | null }
  | { kind: "attach"; sessionId: string; sinceMs: number; reason: "reattach" | "wake" };

interface ChildState {
  parent: string;
  depth: number;
  mapper: OpencodeEventMapper;
  settled: boolean;
}

interface SubagentCall {
  callId: string;
  background: boolean;
  description?: string;
  agent?: string;
  claimed: boolean;
}

function createTurn(a: Omit<OpencodeServerTurnArgs, "prompt" | "title" | "resumeSessionId">, start: StartSpec): OpencodeServerTurn {
  const { taskId, runId, harnessId, mode } = a;
  const startedAt = start.kind === "attach" ? start.sinceMs : Date.now();
  const modelRef = opencodeModelRefFor(a.model, a.effort);

  let sessionId: string | null = start.kind === "attach" ? start.sessionId : null;
  let client: OpencodeClient | null = null;
  let stopClient: OpencodeClient | null = null;
  let mapper: OpencodeEventMapper | null = null;
  let subscription: { unsubscribe(): void } | null = null;

  let settled = false;
  let detached = false;
  let killed = false;
  let promptSent = false;
  /** Our prompt (or, on attach, the execution) is known to be in flight on the server. */
  let delivered = start.kind === "attach";
  let ourMessageId: string | null = null;
  const deliveredIds = new Set<string>();

  let confirmTimer: ReturnType<typeof setTimeout> | null = null;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;
  let livenessBusy = false;

  /** Events held while a catch-up reads the snapshot. */
  let buffering = start.kind === "attach";
  let buffer: Array<{ e: OpencodeEnvelope; origin: OpencodeHubOrigin }> = [];
  let bufferOverflow = false;
  let catching: Promise<void> | null = null;
  let catchAgain = false;
  /** The sessions the hub reported as owned by this turn at the last resync (root, children, deeper). */
  let lastOwned: ReadonlyArray<OpencodeHubOrigin> = [];
  /** Server handle epoch (its start time), handed to the hub so a restarted server replaces the stream. */
  let serverEpoch: number | undefined;

  /** Permission requests / forms already taken up, and the ones with a card still open (id -> session). */
  const handledPerms = new Set<string>();
  const openPerms = new Map<string, string>();
  const ourPermReplies = new Set<string>();
  const handledForms = new Set<string>();
  const openForms = new Map<string, string>();
  const ourFormReplies = new Set<string>();
  let warnedNonQuestion = false;
  /** An empty Reject ends the OpenCode turn with `interrupted/shutdown`; remember we asked for it (D5). */
  let emptyRejectPending = false;

  const children = new Map<string, ChildState>();
  const subagentCalls: SubagentCall[] = [];
  const toolNames = new Map<string, string>();

  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });

  const inactive = (): boolean => settled || detached;

  function status(text: string): void {
    if (settled) return;
    try {
      if (a.onStatus) a.onStatus(text);
      else a.onChunk("status", text);
    } catch (e) {
      console.error("[opencode-driver] status sink failed:", e);
    }
  }

  function activity(): void {
    noteOpencodeActivity(harnessId);
  }

  function emit(chunks: OpencodeMappedChunk[]): void {
    for (const c of chunks) {
      try {
        if (c.replace) a.onReplace(c.lineUuid, c.data);
        else a.onChunk(c.stream, c.data, c.lineUuid);
      } catch (e) {
        console.error("[opencode-driver] chunk sink failed:", e);
      }
    }
  }

  /** Emit a large batch in short slices (I9). */
  async function emitCooperative(chunks: OpencodeMappedChunk[]): Promise<void> {
    let sliceStart = performance.now();
    for (const c of chunks) {
      emit([c]);
      if (performance.now() - sliceStart >= SLICE_MS) {
        await yieldTick();
        sliceStart = performance.now();
      }
    }
  }

  /* ── settling ─────────────────────────────────────────────────────────── */

  function clearTimers(): void {
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = null;
    if (livenessTimer) clearInterval(livenessTimer);
    livenessTimer = null;
  }

  function settle(code: number): void {
    if (settled) return;
    settled = true;
    clearTimers();
    try {
      subscription?.unsubscribe();
    } catch {
      /* already gone */
    }
    subscription = null;
    // A turn that is over leaves no card behind (the server clears its own).
    for (const rid of [...openPerms.keys()]) resolveOpencodeCardsForRequest(taskId, { requestId: rid });
    for (const fid of [...openForms.keys()]) resolveOpencodeCardsForRequest(taskId, { formId: fid });
    openPerms.clear();
    openForms.clear();
    buffer = [];
    activity();
    resolveDone(code);
  }

  function finish(t: OpencodeTerminal): void {
    activity();
    if (t.outcome === "succeeded") return settle(0);
    if (t.outcome === "failed") return settle(1); // the mapper already posted the error line
    const reason = (t.reason ?? "").replace(/[^a-z-]/gi, "").slice(0, 40);
    if (killed || reason === "user" || (reason === "shutdown" && emptyRejectPending)) return settle(130);
    status(`opencode: the turn was interrupted${reason ? ` (${reason})` : ""}`);
    settle(1);
  }

  function onRootTerminal(): void {
    const t = mapper?.terminal() ?? null;
    if (!t) return;
    // The tail of an earlier execution must not end this turn.
    if (!delivered) return;
    finish(t);
  }

  function markDelivered(): void {
    if (delivered) return;
    delivered = true;
    // A Stop that arrived before the server started the execution: interrupt now.
    if (killed && !settled) background(requestInterrupt());
  }

  /* ── cards ────────────────────────────────────────────────────────────── */

  async function replyWithRetry(what: string, send: () => Promise<void>): Promise<boolean> {
    for (let attempt = 1; attempt <= REPLY_ATTEMPTS; attempt++) {
      try {
        await send();
        return true;
      } catch (e) {
        if (isStaleReply(e)) return true; // the server no longer holds it; nothing to report
        if (!isTransportFailure(e) || attempt === REPLY_ATTEMPTS || inactive()) {
          status(`OpenCode didn't accept the ${what}: ${errText(e)}`);
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, timings.replyRetryMs * attempt));
        if (inactive()) return false;
      }
    }
    return false;
  }

  async function handlePermission(req: Rec): Promise<void> {
    const rid = str(req.id);
    const sid = str(req.sessionID) ?? sessionId;
    if (!rid || !sid || !client || handledPerms.has(rid)) return;
    handledPerms.add(rid);
    const c = client;
    ourPermReplies.add(rid);
    try {
      if (mode === "auto") {
        const ok = await replyWithRetry("permission", () => c.replyPermission(sid, rid, { decision: "once" }));
        if (!ok) handledPerms.delete(rid);
        return;
      }
      ourPermReplies.delete(rid); // a card is open: only a reply we send below is ours
      const reg = registerOpencodePermission({
        taskId,
        runId,
        sessionId: sid,
        requestId: rid,
        toolCall: permissionToolCall(req, rid),
        mode: mode === "plan" ? "plan" : "ask",
      });
      openPerms.set(rid, sid);
      activity();
      const answer = await reg.answer;
      openPerms.delete(rid);
      if (inactive() || "cancelled" in answer) return; // Stop interrupts the session itself
      activity();
      const message = answer.message !== undefined && answer.message !== "" ? answer.message : undefined;
      if (answer.decision === "reject" && message === undefined) emptyRejectPending = true;
      ourPermReplies.add(rid);
      const ok = await replyWithRetry("permission answer", () =>
        c.replyPermission(sid, rid, { decision: answer.decision, ...(message !== undefined ? { message } : {}) }),
      );
      if (!ok) {
        emptyRejectPending = false;
        handledPerms.delete(rid); // the next catch-up re-lists it and raises the card again
      }
    } catch (e) {
      handledPerms.delete(rid);
      openPerms.delete(rid);
      status(`OpenCode permission request failed: ${errText(e)}`);
    }
  }

  async function handleForm(form: unknown): Promise<void> {
    if (!isRec(form)) return;
    const fid = str(form.id);
    const sid = str(form.sessionID) ?? sessionId;
    if (!fid || !sid || !client || handledForms.has(fid)) return;
    handledForms.add(fid);
    const meta = isRec(form.metadata) ? form.metadata : {};
    const fields = meta.kind === "question" ? questionFields(form.fields) : null;
    if (!fields) {
      // An MCP elicitation or another kind of form: not ours to answer or cancel.
      if (!warnedNonQuestion) {
        warnedNonQuestion = true;
        console.warn("[opencode-driver] leaving a form that is not a question alone");
      }
      return;
    }
    const c = client;
    try {
      const reg = registerOpencodeAskQuestions({
        taskId,
        runId,
        sessionId: sid,
        formId: fid,
        ...(str(form.title) ? { title: str(form.title)! } : {}),
        fields,
      });
      openForms.set(fid, sid);
      activity();
      const answer = await reg.answer;
      openForms.delete(fid);
      if (inactive() || answer.outcome === "cancelled") return;
      activity();
      ourFormReplies.add(fid);
      let ok: boolean;
      if (answer.outcome === "answered") {
        ok = await replyWithRetry("answer", () => c.replyForm(sid, fid, answer.answer));
      } else if (answer.message !== undefined && answer.message !== "") {
        const message = answer.message;
        // A typed reason: the model continues with the user's words (the form is dismissed with them).
        ok = await replyWithRetry("answer", () => c.cancelForm(sid, fid, message));
      } else {
        ok = await replyWithRetry("answer", () => c.replyForm(sid, fid, {}));
      }
      if (!ok) handledForms.delete(fid);
    } catch (e) {
      handledForms.delete(fid);
      openForms.delete(fid);
      status(`OpenCode question failed: ${errText(e)}`);
    }
  }

  /** The server settled a request or form some other way: close our card without replying. */
  function serverSettled(kind: "permission" | "form", id: string | null): void {
    if (!id) return;
    if (kind === "permission") {
      if (ourPermReplies.has(id)) return;
      if (openPerms.delete(id)) resolveOpencodeCardsForRequest(taskId, { requestId: id });
    } else {
      if (ourFormReplies.has(id)) return;
      if (openForms.delete(id)) resolveOpencodeCardsForRequest(taskId, { formId: id });
    }
  }

  /* ── children ─────────────────────────────────────────────────────────── */

  function claimSubagentCall(): SubagentCall | undefined {
    const call = subagentCalls.find((c) => !c.claimed);
    if (call) call.claimed = true;
    return call;
  }

  function ensureChild(
    childId: string,
    parentId: string,
    depth: number,
    info?: { title?: string | null; agent?: string | null },
  ): ChildState | null {
    const known = children.get(childId);
    if (known) return known;
    const call = depth === 1 ? claimSubagentCall() : undefined;
    const state: ChildState = {
      parent: parentId,
      depth,
      mapper: createOpencodeEventMapper({ sessionId: childId }),
      settled: false,
    };
    children.set(childId, state);
    const title = str(info?.title) ?? call?.description;
    const agent = str(info?.agent) ?? call?.agent;
    try {
      deps.registerChild({
        taskId,
        runId,
        parentSessionId: parentId,
        childSessionId: childId,
        ...(title ? { title } : {}),
        ...(agent ? { agent } : {}),
        depth,
        ...(call ? { background: call.background } : {}),
      });
    } catch (e) {
      console.error("[opencode-driver] could not register a child session:", e);
    }
    return state;
  }

  function dispatchChild(e: OpencodeEnvelope, origin: OpencodeHubOrigin): void {
    const childId = origin.sessionId;
    const d = isRec(e.data) ? e.data : {};
    const state = ensureChild(childId, origin.childOf ?? sessionId ?? "", origin.depth, {
      title: e.type === "session.created" ? str(d.title) : null,
      agent: e.type === "session.created" ? str(d.agent) : null,
    });
    if (!state) return;
    const chunks = state.mapper.feed(e);
    if (chunks.length > 0) {
      try {
        deps.ingestChildChunks({ taskId, childSessionId: childId, chunks });
      } catch (err) {
        console.error("[opencode-driver] child ingest failed:", err);
      }
    }
    if (TERMINAL_EVENTS.has(e.type) && d.sessionID === childId) {
      const t = state.mapper.terminal();
      if (t && !state.settled) {
        state.settled = true;
        try {
          deps.settleChild({
            taskId,
            childSessionId: childId,
            outcome: t.outcome === "succeeded" ? "completed" : t.outcome === "failed" ? "failed" : "interrupted",
            ...(t.error ? { error: t.error } : {}),
          });
        } catch (err) {
          console.error("[opencode-driver] child settle failed:", err);
        }
      }
    }
  }

  /** Learn the session's children from the server and bring each one up to date (catch-up only). */
  async function syncChildren(): Promise<void> {
    if (!client || !sessionId) return;
    const c = client;
    const queue: Array<{ id: string; depth: number }> = [{ id: sessionId, depth: 0 }];
    const seen = new Set<string>([sessionId]);
    const toSync: string[] = [];
    // Everything the hub says this turn owns, including children created while the stream was down.
    for (const o of lastOwned) {
      if (!o.isChild || seen.has(o.sessionId)) continue;
      seen.add(o.sessionId);
      if (ensureChild(o.sessionId, o.childOf ?? sessionId, o.depth)) toSync.push(o.sessionId);
    }
    while (queue.length > 0 && seen.size <= CHILD_SYNC_MAX && !inactive()) {
      const cur = queue.shift()!;
      if (cur.depth >= CHILD_MAX_DEPTH) continue;
      let kids: unknown[];
      try {
        kids = await c.listChildren(cur.id);
      } catch {
        continue;
      }
      for (const k of kids) {
        if (!isRec(k)) continue;
        const id = str(k.id);
        if (!id || seen.has(id)) continue;
        // Children of earlier turns are not this run's business.
        if (!children.has(id) && messageTime(k) < startedAt - 2000 && !(isRec(k.time) && typeof k.time.created === "number" && k.time.created >= startedAt - 2000)) continue;
        seen.add(id);
        const state = ensureChild(id, cur.id, cur.depth + 1, { title: str(k.title), agent: str(k.agent) });
        if (state) {
          if (typeof k.outcome === "string") state.settled = true;
          toSync.push(id);
          queue.push({ id, depth: cur.depth + 1 });
        }
      }
      await yieldTick();
    }
    for (const [id, st] of children) if (!st.settled && !toSync.includes(id)) toSync.push(id);
    for (const id of toSync) {
      if (inactive()) return;
      try {
        await deps.syncChild({ taskId, runId, client: c, childSessionId: id });
      } catch (e) {
        console.error("[opencode-driver] child sync failed:", e);
      }
      await yieldTick();
    }
  }

  /* ── events ───────────────────────────────────────────────────────────── */

  function noteSubagentCall(type: string, d: Rec): void {
    if (type === "session.tool.input.started") {
      const id = str(d.id);
      const name = str(d.name);
      if (id && name) toolNames.set(id, name);
    } else if (type === "session.tool.called") {
      const id = str(d.id);
      if (!id || toolNames.get(id) !== "subagent") return;
      const input = isRec(d.input) ? d.input : {};
      subagentCalls.push({
        callId: id,
        background: input.background === true,
        ...(str(input.description) ? { description: str(input.description)! } : {}),
        ...(str(input.agent) ? { agent: str(input.agent)! } : {}),
        claimed: false,
      });
    }
  }

  function dispatch(e: OpencodeEnvelope, origin: OpencodeHubOrigin): void {
    if (inactive() || !mapper) return;
    const d = isRec(e.data) ? e.data : {};
    try {
      switch (e.type) {
        case "permission.asked":
          background(handlePermission(d));
          return;
        case "permission.replied":
          serverSettled("permission", str(d.requestID));
          return;
        case "form.created":
          background(handleForm(d.form));
          return;
        case "form.replied":
        case "form.cancelled":
          serverSettled("form", str(d.id));
          return;
        default:
          break;
      }
      if (origin.isChild) {
        dispatchChild(e, origin);
        return;
      }
      if (e.type === "session.inbox.delivered") {
        const inboxId = str(d.inboxID);
        if (inboxId) {
          deliveredIds.add(inboxId);
          if (ourMessageId !== null && inboxId === ourMessageId) markDelivered();
        }
      }
      noteSubagentCall(e.type, d);
      emit(mapper.feed(e));
      if (TERMINAL_EVENTS.has(e.type) && d.sessionID === sessionId) onRootTerminal();
    } catch (err) {
      console.error("[opencode-driver] event handling failed:", err);
    }
  }

  function onHubEvent(e: OpencodeEnvelope, origin: OpencodeHubOrigin): void {
    if (inactive()) return;
    if (buffering) {
      if (buffer.length >= BUFFER_MAX) {
        bufferOverflow = true;
        return;
      }
      buffer.push({ e, origin });
      return;
    }
    dispatch(e, origin);
  }

  /* ── catch-up ─────────────────────────────────────────────────────────── */

  /** The messages of the session from the turn's start on, oldest first (desc pages, reversed; bounded). */
  async function fetchMessagesAsc(c: OpencodeClient, sid: string, sinceMs: number): Promise<{ list: unknown[]; truncated: boolean }> {
    const pages: unknown[][] = [];
    let cursor: string | undefined;
    let truncated = false;
    for (let i = 0; i < MESSAGE_MAX_PAGES; i++) {
      const r = await c.listMessages(sid, cursor ? { limit: MESSAGE_PAGE_LIMIT, cursor } : { limit: MESSAGE_PAGE_LIMIT, order: "desc" });
      pages.push(r.data);
      cursor = r.cursor?.next;
      const reached = r.data.some(
        (m) =>
          (ourMessageId !== null && isRec(m) && m.id === ourMessageId) ||
          (isRec(m) && m.type === "idle" && messageTime(m) <= sinceMs),
      );
      if (reached || !cursor || r.data.length === 0) break;
      if (i === MESSAGE_MAX_PAGES - 1) truncated = true;
      await yieldTick();
    }
    const list: unknown[] = [];
    for (let p = pages.length - 1; p >= 0; p--) {
      const page = pages[p]!;
      for (let j = page.length - 1; j >= 0; j--) list.push(page[j]);
    }
    return { list, truncated };
  }

  /** The user (or synthetic) message that began this turn's execution. */
  function pickAnchor(list: unknown[], truncated: boolean): string | null {
    if (ourMessageId !== null && list.some((m) => isRec(m) && m.id === ourMessageId)) return ourMessageId;
    let lastIdle = -1;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (isRec(m) && m.type === "idle" && messageTime(m) <= startedAt) lastIdle = i;
    }
    // Truncated without finding the previous idle: only a message from the turn's own window counts.
    for (let i = lastIdle + 1; i < list.length; i++) {
      const m = list[i];
      if (!isRec(m) || (m.type !== "user" && m.type !== "synthetic")) continue;
      if (truncated && lastIdle < 0 && messageTime(m) < startedAt - 2000) continue;
      return str(m.id);
    }
    return null;
  }

  function idleAfter(list: unknown[], anchor: string): { outcome: string; error?: unknown } | null {
    const at = list.findIndex((m) => isRec(m) && m.id === anchor);
    if (at < 0) return null;
    for (let i = at + 1; i < list.length; i++) {
      const m = list[i];
      if (isRec(m) && m.type === "idle") {
        return { outcome: typeof m.outcome === "string" ? m.outcome : "succeeded", error: m.error };
      }
    }
    return null;
  }

  /** Re-list pending permissions and forms: raise cards the server still holds, close the ones it no longer does. */
  async function relistCards(c: OpencodeClient): Promise<void> {
    const sessions = new Set<string>([sessionId!]);
    for (const [id, st] of children) if (!st.settled) sessions.add(id);
    for (const o of lastOwned) if (!children.get(o.sessionId)?.settled) sessions.add(o.sessionId);
    for (const sid of sessions) {
      if (inactive()) return;
      try {
        const perms = await c.listPermissions(sid);
        const live = new Set<string>();
        for (const p of perms) {
          if (!isRec(p)) continue;
          const id = str(p.id);
          if (id) live.add(id);
          background(handlePermission({ ...p, sessionID: str(p.sessionID) ?? sid }));
        }
        for (const [rid, owner] of [...openPerms]) if (owner === sid && !live.has(rid)) serverSettled("permission", rid);
      } catch {
        /* a session that is gone, or a blip: the next catch-up retries */
      }
      try {
        const forms = await c.listForms(sid);
        const live = new Set<string>();
        for (const f of forms) {
          if (!isRec(f)) continue;
          const id = str(f.id);
          if (id) live.add(id);
          background(handleForm({ ...f, sessionID: str(f.sessionID) ?? sid }));
        }
        for (const [fid, owner] of [...openForms]) if (owner === sid && !live.has(fid)) serverSettled("form", fid);
      } catch {
        /* as above */
      }
    }
  }

  async function catchUpOnce(): Promise<void> {
    const c = client;
    const sid = sessionId;
    const m = mapper;
    if (!c || !sid || !m) return;
    buffering = true;
    let snapshotTerminal: { outcome: string; error?: unknown } | null = null;
    let anchorFound = false;
    let notActive = false;
    try {
      const { list, truncated } = await fetchMessagesAsc(c, sid, startedAt);
      if (inactive()) return;
      const anchor = pickAnchor(list, truncated);
      if (anchor) {
        anchorFound = true;
        const seed = m.beginSeed({ afterUserMessageId: anchor });
        for (let i = 0; i < list.length; i += MESSAGE_PAGE_LIMIT) {
          await emitCooperative(seed.push(list.slice(i, i + MESSAGE_PAGE_LIMIT)));
          if (inactive()) return;
        }
        seed.end();
        snapshotTerminal = idleAfter(list, anchor);
        if (!delivered && ourMessageId !== null) markDelivered();
      }
      await relistCards(c);
      if (inactive()) return;
      await syncChildren();
      if (inactive()) return;
      try {
        const active = await c.activeSessions();
        notActive = active[sid] === undefined;
      } catch {
        notActive = false;
      }
    } catch (e) {
      if (!inactive()) console.warn(`[opencode-driver] catch-up failed: ${errText(e)}`);
    } finally {
      buffering = false;
      const held = buffer;
      buffer = [];
      for (const item of held) {
        if (inactive()) break;
        dispatch(item.e, item.origin);
      }
      if (bufferOverflow) {
        bufferOverflow = false;
        catchAgain = true;
      }
    }
    if (inactive()) return;
    // The execution is over and the live terminal was lost (or came before we attached).
    if (notActive && snapshotTerminal) {
      const outcome = snapshotTerminal.outcome === "failed" || snapshotTerminal.outcome === "interrupted" ? snapshotTerminal.outcome : "succeeded";
      m.feed({
        type: `session.execution.${outcome}`,
        data: {
          sessionID: sid,
          ...(outcome === "failed" ? { error: snapshotTerminal.error } : {}),
          ...(outcome === "interrupted" ? { reason: "user" } : {}),
        },
      });
      delivered = true;
      onRootTerminal();
    } else if (notActive && start.kind === "attach" && !anchorFound) {
      status("OpenCode has no running turn for this session anymore");
      settle(1);
    }
  }

  function requestCatchUp(): Promise<void> {
    if (inactive() || !mapper || !client) return Promise.resolve();
    if (start.kind === "spawn" && !promptSent) return Promise.resolve();
    if (catching) {
      catchAgain = true;
      return catching;
    }
    catching = (async () => {
      try {
        do {
          catchAgain = false;
          await catchUpOnce();
        } while (catchAgain && !inactive());
      } catch (e) {
        console.warn(`[opencode-driver] catch-up failed: ${errText(e)}`);
      } finally {
        catching = null;
      }
    })();
    return catching;
  }

  function startLiveness(): void {
    if (livenessTimer || inactive()) return;
    livenessTimer = setInterval(() => {
      if (inactive() || livenessBusy || buffering || catching || !client || !sessionId || !delivered) return;
      const sid = sessionId;
      livenessBusy = true;
      client
        .activeSessions()
        .then((active) => {
          if (!inactive() && active[sid] === undefined) background(requestCatchUp());
        })
        .catch(() => {})
        .finally(() => {
          livenessBusy = false;
        });
    }, timings.livenessMs);
    (livenessTimer as unknown as { unref?: () => void }).unref?.();
  }

  /* ── stop ─────────────────────────────────────────────────────────────── */

  async function requestInterrupt(): Promise<void> {
    const c = stopClient;
    const sid = sessionId;
    if (!c || !sid || settled) return;
    let interrupted = false;
    try {
      interrupted = await c.interrupt(sid);
    } catch {
      return; // the confirm timer settles the turn
    }
    if (settled) return;
    // Nothing was running although our message was delivered: the execution already ended.
    if (!interrupted && delivered) settle(130);
    // Not delivered yet: markDelivered() interrupts again once the server starts it.
  }

  function kill(): void {
    if (killed || settled) return;
    killed = true;
    if (detached) return;
    if (!sessionId || !promptSent) {
      // Nothing of ours is running on the server yet; the start sequence stops at its next checkpoint.
      settle(130);
      return;
    }
    background(requestInterrupt());
    confirmTimer = setTimeout(() => {
      if (settled) return;
      status("OpenCode didn't confirm the stop");
      settle(130);
    }, timings.stopConfirmMs);
    (confirmTimer as unknown as { unref?: () => void }).unref?.();
  }

  async function steer(text: string): Promise<"accepted" | "unavailable"> {
    if (inactive() || killed || !client || !sessionId || !promptSent) return "unavailable";
    try {
      await client.prompt(sessionId, { text, delivery: "steer" });
    } catch {
      return "unavailable";
    }
    activity();
    return "accepted";
  }

  function detach(): void {
    if (settled || detached) return;
    detached = true;
    clearTimers();
    try {
      subscription?.unsubscribe();
    } catch {
      /* already gone */
    }
    subscription = null;
    buffer = [];
  }

  /* ── start ────────────────────────────────────────────────────────────── */

  async function connect(): Promise<OpencodeServerRef | null> {
    activity();
    let handle;
    try {
      handle = await deps.ensureServer({
        harnessId,
        bin: a.bin,
        env: a.env,
        cwd: a.serverCwd,
        isBusy: a.isBusy,
      });
    } catch (e) {
      status(`couldn't start the OpenCode server: ${errText(e)}`);
      settle(killed ? 130 : 1);
      return null;
    }
    if (inactive()) return null;
    activity();
    if (handle.stale) status(OPENCODE_STALE_SERVER_STATUS);
    serverEpoch = handle.startedAt;
    const ref: OpencodeServerRef = { url: handle.url, password: handle.password };
    client = createOpencodeClient(ref);
    stopClient = createOpencodeClient(ref, { timeoutMs: timings.interruptTimeoutMs });
    return ref;
  }

  /** `ready` bounded by this turn's own deadline: the hub may back off for minutes. */
  function awaitReady(ready: Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the OpenCode event stream did not open in time")), timings.readyMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      ready.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  function subscribe(ref: OpencodeServerRef, sid: string): Promise<void> {
    mapper = createOpencodeEventMapper({ sessionId: sid });
    // A variable, not a literal: `epoch` is optional on the hub's server param.
    const server = { key: harnessId, ...ref, ...(serverEpoch !== undefined ? { epoch: serverEpoch } : {}) };
    const sub = subscribeOpencodeSession(server, sid, {
      onEvent: onHubEvent,
      onResync: (owned) => {
        lastOwned = owned ?? [];
        background(requestCatchUp());
      },
      onServerLost: (err) => {
        if (inactive()) return;
        status(`OpenCode server connection lost${err ? `: ${errText(err)}` : ""}`);
        settle(killed ? 130 : 1);
      },
    });
    subscription = sub;
    return awaitReady(sub.ready);
  }

  /** The session this turn runs in: resumed, reconciled with the task's settings, or fresh. */
  async function ensureSession(c: OpencodeClient, s: Extract<StartSpec, { kind: "spawn" }>): Promise<string> {
    const agent = mode === "plan" ? "plan" : "build";
    if (s.resumeSessionId) {
      const existing = await c.getSession(s.resumeSessionId);
      if (existing) {
        await reconcileSession(c, s.resumeSessionId, existing, agent);
        return s.resumeSessionId;
      }
      status(opencodeResumeNotFoundStatus(s.resumeSessionId));
    }
    const title = clampTitle(s.title);
    const created = await c.createSession({
      directory: a.cwd,
      ...(title ? { title } : {}),
      agent,
      ...(modelRef ? { model: modelRef } : {}),
      ...(mode === "ask" ? { permissions: [ASK_RULE] } : {}),
    });
    const id = str(isRec(created) ? created.id : null);
    if (!id) throw new Error("OpenCode returned a session without an id");
    return id;
  }

  async function reconcileSession(c: OpencodeClient, id: string, existing: unknown, agent: string): Promise<void> {
    const cur = isRec(existing) ? existing : {};
    if (cur.agent !== agent) await c.switchAgent(id, agent);
    if (modelRef) {
      const m = isRec(cur.model) ? cur.model : {};
      const same = m.providerID === modelRef.providerID && m.id === modelRef.id && (modelRef.variant === undefined || m.variant === modelRef.variant);
      if (!same) await c.switchModel(id, modelRef);
    }
    const asking = hasAskRule(cur.permissions);
    if (mode === "ask" && !asking) {
      const rules = Array.isArray(cur.permissions) ? (cur.permissions as OpencodePermissionRule[]) : [];
      await c.updateSession(id, { permissions: [...rules, ASK_RULE] });
    } else if (mode !== "ask" && asking) {
      const rules = (cur.permissions as unknown[]).filter((r) => !(isRec(r) && r.action === "*" && r.resource === "*" && r.effect === "ask"));
      await c.updateSession(id, { permissions: rules as OpencodePermissionRule[] });
    }
  }

  async function runSpawn(s: Extract<StartSpec, { kind: "spawn" }>): Promise<void> {
    const ref = await connect();
    if (!ref || !client) return;
    const c = client;
    let sid: string;
    try {
      sid = await ensureSession(c, s);
    } catch (e) {
      if (!inactive()) {
        status(`couldn't open the OpenCode session: ${errText(e)}`);
        settle(1);
      }
      return;
    }
    if (inactive()) return;
    sessionId = sid;
    try {
      a.onSessionId(sid);
    } catch (e) {
      console.error("[opencode-driver] onSessionId failed:", e);
    }
    try {
      await subscribe(ref, sid);
    } catch (e) {
      if (!inactive()) {
        status(`couldn't watch the OpenCode session: ${errText(e)}`);
        settle(1);
      }
      return;
    }
    if (inactive()) return;
    promptSent = true; // set with the call below: no await between the checks above and the send
    try {
      const sent = await c.prompt(sid, { text: s.prompt, delivery: "steer" });
      ourMessageId = sent.id;
      if (deliveredIds.has(sent.id)) markDelivered();
    } catch (e) {
      if (!inactive()) {
        status(`OpenCode didn't accept the message: ${errText(e)}`);
        settle(1);
      }
      return;
    }
    startLiveness();
    // A Stop that landed while the prompt was in flight.
    if (killed && !settled) {
      background(requestInterrupt());
      if (!confirmTimer) {
        confirmTimer = setTimeout(() => {
          if (settled) return;
          status("OpenCode didn't confirm the stop");
          settle(130);
        }, timings.stopConfirmMs);
        (confirmTimer as unknown as { unref?: () => void }).unref?.();
      }
    }
  }

  async function runAttach(s: Extract<StartSpec, { kind: "attach" }>): Promise<void> {
    const ref = await connect();
    if (!ref) return;
    try {
      await subscribe(ref, s.sessionId);
    } catch (e) {
      if (!inactive()) {
        status(`couldn't watch the OpenCode session: ${errText(e)}`);
        settle(1);
      }
      return;
    }
    if (inactive()) return;
    promptSent = true; // the execution is already running on the server
    await requestCatchUp();
    // Whatever the catch-up buffered is drained; live events flow from here.
    if (!inactive()) startLiveness();
  }

  const guardedRun = (p: Promise<void>): void => {
    p.catch((e) => {
      if (inactive()) return;
      status(`OpenCode turn failed: ${errText(e)}`);
      settle(killed ? 130 : 1);
    });
  };
  if (start.kind === "spawn") guardedRun(runSpawn(start));
  else guardedRun(runAttach(start));

  return {
    kill,
    writeInput: () => false,
    done,
    steer,
    sessionId: () => sessionId,
    detach,
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Entry points
 * ────────────────────────────────────────────────────────────────────────── */

/** Start a turn on the harness's agetor-owned OpenCode server. Never throws; `done` never rejects. */
export function spawnOpencodeServerTurn(a: OpencodeServerTurnArgs): OpencodeServerTurn {
  return createTurn(a, {
    kind: "spawn",
    prompt: a.prompt,
    title: a.title ?? null,
    resumeSessionId: a.resumeSessionId ?? null,
  });
}

/** Join a turn that is already running on the server (agetor restart, or an execution the server started itself). */
export function attachOpencodeServerTurn(a: OpencodeServerAttachArgs): OpencodeServerTurn {
  return createTurn(a, { kind: "attach", sessionId: a.sessionId, sinceMs: a.sinceMs, reason: a.reason });
}

/** Test seams; production code never calls these. */
export const __forTest = {
  /** Replace some or all collaborators; returns the function that restores the previous set. */
  setDeps(over: Partial<OpencodeDriverDeps>): () => void {
    const prev = deps;
    deps = { ...deps, ...over };
    return () => {
      deps = prev;
    };
  },
  /** Override timings (stop confirmation, interrupt timeout, liveness period, reply retry); returns the restore function. */
  setTimings(over: Partial<typeof timings>): () => void {
    const prev = timings;
    timings = { ...timings, ...over };
    return () => {
      timings = prev;
    };
  },
};

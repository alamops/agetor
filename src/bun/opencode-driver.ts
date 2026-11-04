/**
 * The OpenCode v2 turn driver on the agetor-owned `opencode serve`
 * (docs/plans/opencode-server-driver.md, T9; decisions D4, D5, D7, D11, D12, R1, R4,
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
 *     a stale server answer (404/409) closes the card without an error (an
 *     answer the user gave gets a status line saying it was not applied).
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
 * closed, known children are re-synced, and the sessions that sync newly found
 * are re-listed too. An attach (a wake, a reattach) starts from the hub's owned
 * sessions, so a background child whose card a lingering driver left open is
 * taken over by the wake's driver.
 *
 * An idle marker after the anchor settles the turn from its outcome whether or
 * not the session is active again (the next execution is not ours: the hub's
 * open-execution tracking wakes for it), and the seed stops at that idle. Held
 * live events are then drained only up to the root's next
 * `session.execution.started`; the rest is replayed after the settle (a
 * lingering handle takes its children's events, anything else is dropped).
 *
 * Re-lists read the root and the children that may still hold a request: a
 * child whose subagent row is settled, or that this driver settled itself, is
 * never re-listed, synced, counted or interrupted again (the hub owns every
 * child the session ever had), and each loop is capped. A re-list closes only cards that were open before its request
 * went out; a card raised while the list was in flight stays.
 *
 * Children (subagents) are handed to `opencode-subagents.ts` (T12): their
 * events go through a per-child mapper into `ingestOpencodeChildChunks`, their
 * terminal into `settleOpencodeChild`.
 *
 * Lingering. A BACKGROUND child outlives the turn. When the root settles with a
 * background child still running (and no Stop, dispose, detach or lost server),
 * `done` resolves as usual but the driver stays subscribed in a child-only
 * mode: child events are ingested and settled, child permissions are answered
 * per mode (Auto: once; Ask/Plan: a card under this run), child questions raise
 * cards, and root events are ignored. It leaves when every background child
 * settled, on `dispose()` or `detach()`, after 24 h, or on the root's next
 * `session.execution.started` (it unsubscribes at once so the hub's wake path
 * takes that execution over). While lingering, open cards of children stay
 * answerable; cards of the root session close at settle. Leaving for the
 * root's next execution, and `detach()`, leave the children's open cards in
 * the registry unresolved: the next driver re-lists the server's requests and
 * takes the same cards over (deduped by request and form id), so resolving
 * them here would cancel its await. A driver whose card is cancelled by
 * someone else while it can still act re-raises it from the server's list.
 * `lingering()` tells the orchestrator to keep the handle.
 *
 * A boot can re-create a lingering handle for a run that settled before the
 * restart: `attachOpencodeServerLinger` resolves `done` 0 at once and lingers
 * exactly like a settled turn with open background children, after syncing the
 * task's running or orphaned child rows.
 *
 * Stop reaches the children: `kill()` and `dispose()` also interrupt every
 * unsettled child session this driver knows (and the hub's owned sessions), so a
 * background subagent does not keep running and later wake the stopped task.
 * The root goes first: `kill()` waits for the root's interrupt call (bounded by
 * the interrupt timeout), then hands back the parked steers (below), and only
 * then interrupts the children, so a child's "cancelled" item lands on the
 * parent after the root's execution ended, and the execution that item starts
 * finds no steer of ours left to deliver. When a child's stop can't be
 * confirmed (an interrupt failed or timed out), the task's `running` child rows
 * are parked `orphaned` (`deps.orphanChildrenOfTask`, K2), as they are when a
 * lingering handle loses its server or a linger gives up at its maximum duration;
 * a new turn parks just the adopted children the server lists as not executing
 * (`deps.orphanChild`), so the sync that follows settles them.
 * Only a child the server reports as interrupted is settled `interrupted`; one
 * that had already finished is synced to its real outcome instead.
 * Interrupting a background child makes OpenCode wake the parent with a
 * synthetic "subagent cancelled" message (r2 spike): every child this driver
 * interrupts is noted first, durably (`deps.noteChildStoppedByAgetor`, stored by
 * `opencode-subagents.ts`), so the orchestrator can tell that wake from one it
 * must follow (`wasOpencodeChildStoppedByAgetor` there), even after a restart.
 * An interrupt parks the root's undelivered inbox items instead of running them
 * (r3 spike): after a Stop whose root interrupt went through, this turn's own
 * parked steers are deleted from the inbox and their texts handed back to the
 * orchestrator (`requeueUndeliveredSteers`): as `texts` (the next turn) when the
 * removal is proven, as `uncertain` (the backlog tray) when it can't be proven
 * or a newer turn of the task already started (see `reclaimParkedSteers`).
 * With no requeue handler installed nothing is deleted. `done` waits for that,
 * never past the stop's confirm budget.
 *
 * A card closed while this driver can still act on it is re-raised from the
 * server's list only when another driver of this module closed it (a re-list
 * that no longer saw it, a settle, a linger leaving): those closes are noted
 * (`closeCardAsDriver`). A close nobody here noted is a Stop, delete, archive or
 * restart sweep (`cancelPendingForTask`), and the card stays closed.
 * `onUserStop` marks a stop of the root the orchestrator did not issue: an
 * `execution.interrupted{reason:"user"}` from another client.
 *
 * Reject. A Reject with the user's reason is sent with exactly that reason. A
 * Reject with no reason is sent with `OPENCODE_EMPTY_REJECT_MESSAGE` (one
 * space): OpenCode turns an empty or missing message into a decline that
 * stops the whole turn, while any non-empty message refuses the tool and lets
 * the model continue (owner decision R1). One reject refuses every other
 * pending request of the session too; their cards close when OpenCode's
 * `permission.replied` for them arrives (a reply we did not send).
 *
 * Connecting. `ensureOpencodeServer` is bounded by the turn's own deadline
 * (`connectMs`): past it the turn posts a status line and settles 1.
 *
 * Steering. `steer(text)` posts `prompt(delivery:"steer")` with a client
 * message id; the orchestrator writes the user bubble. Steers are sent one at
 * a time in call order. A steer that races the
 * very end of the turn can land after the execution closed; OpenCode then
 * starts a fresh execution for it. The hub detects that as a wake
 * SYNCHRONOUSLY, inside the same SSE dispatch that delivers the terminal event
 * (it fires when the last subscriber unsubscribes with an execution still
 * open, or at the next `execution.started` when nobody is subscribed). This
 * driver unsubscribes inside `settle()`, which runs inside that dispatch and
 * resolves `done` in the same synchronous step, so the wake handler can run
 * BEFORE the orchestrator's `done` handler has marked the run finished: the
 * orchestrator must defer such a wake (not refuse it) while a run row is still
 * `running` but its live handle has settled.
 */
import {
  createOpencodeClient,
  type OpencodeClient,
  type OpencodeEnvelope,
  type OpencodeModelRef,
  type OpencodePermissionRule,
  type OpencodeServerRef,
} from "./opencode-http.ts";
import {
  opencodeInboxItemCancelled,
  opencodeOwnedSessions,
  subscribeOpencodeSession,
  waitOpencodeInboxItemCancelled,
  type OpencodeHubOrigin,
} from "./opencode-hub.ts";
import {
  createOpencodeEventMapper,
  type OpencodeEventMapper,
  type OpencodeMappedChunk,
  type OpencodeTerminal,
} from "./opencode-events.ts";
import { ensureOpencodeServer, noteOpencodeActivity, noteOpencodeServerLost, type OpencodeServerSpec } from "./opencode-server.ts";
import {
  registerOpencodeAskQuestions,
  registerOpencodePermission,
  resolveOpencodeCardsForRequest,
  type FxPermissionToolCall,
  type OpencodeAskField,
} from "./interactions.ts";
import {
  ingestOpencodeChildChunks,
  listOpenOpencodeChildSessions,
  listSettledOpencodeChildSessions,
  noteOpencodeChildStoppedByAgetor,
  orphanOpencodeChild,
  orphanRunningOpencodeChildrenOfTask,
  registerOpencodeChildSession,
  settleOpencodeChild,
  syncOpencodeChildFromServer,
} from "./opencode-subagents.ts";
import { isRec, str, type Rec } from "./opencode-map-helpers.ts";
import type { SpawnedAgent } from "./claude-tmux.ts";
import { OPENCODE_DEFAULT_MODEL, opencodeResumeFailedStatusLine } from "../shared/opencode.ts";
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
  /**
   * Called exactly once, synchronously, BEFORE `done` resolves 130, when the root turn was stopped
   * some way this driver did not issue: an `execution.interrupted{reason:"user"}` from another
   * client. Not called for `kill()`/`dispose()`. The orchestrator marks the run cancelled here.
   */
  onUserStop?: () => void;
}

export interface OpencodeServerAttachArgs extends Omit<OpencodeServerTurnArgs, "prompt" | "title" | "resumeSessionId"> {
  sessionId: string;
  /** reattach: when the run started. wake: when the server's `execution.started` envelope was created. */
  sinceMs: number;
  reason: "reattach" | "wake";
}

/** `attachOpencodeServerLinger`: an attach without a turn to follow (see there). */
export type OpencodeServerLingerArgs = Omit<OpencodeServerAttachArgs, "reason" | "sinceMs">;

/** A running turn. `SpawnedAgent` with an awaitable `steer` (the orchestrator's `steer?` is a sync boolean). */
export interface OpencodeServerTurn extends Omit<SpawnedAgent, "steer"> {
  /**
   * Deliver text into the running turn. `"unavailable"`: nothing was sent, queue it as a new turn.
   * Concurrent calls are sent one at a time, in call order.
   */
  steer(text: string): Promise<"accepted" | "unavailable">;
  /** The OpenCode session id once known (null while the session is being created). */
  sessionId(): string | null;
  /**
   * Stop listening WITHOUT interrupting the server: unsubscribe, clear timers.
   * `done` stays pending and the turn keeps running on the server, for a
   * teardown that must not end the run (a core handing over, tests). On a
   * lingering handle it stops the linger the same silent way: nothing is
   * interrupted and the children's open cards stay unresolved for whoever
   * re-lists the server's requests next. No-op on a settled, non-lingering handle.
   */
  detach(): void;
  /**
   * True while the root turn is settled but background children are still being
   * followed (see the header). The orchestrator keeps the handle until this is
   * false (poll it after `done` and on child settles) or calls `dispose()`.
   */
  lingering(): boolean;
  /**
   * End everything this handle still does: stop lingering, interrupt the root
   * session if it is active, unsubscribe, close this driver's open cards. A live
   * (unsettled) turn settles 130. Idempotent; never throws.
   */
  dispose(): Promise<void>;
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
  /** Child sessions of this task whose subagent row is `running`, or `orphaned` recently enough to re-check (`listOpenOpencodeChildSessions`). */
  openChildSessions(taskId: string): string[];
  /** Child sessions of this task whose subagent row is settled, or orphaned past the re-check window: never followed again. */
  settledChildSessions(taskId: string): string[];
  /** Record, before the interrupt POST, that agetor itself is interrupting this child session (durable: survives a core restart). */
  noteChildStoppedByAgetor(a: { taskId: string; childSessionId: string }): void;
  /** The HTTP client factory (a test wraps it to watch what the driver asks of the client). */
  createClient: typeof createOpencodeClient;
  /**
   * A Stop took these steers of the run back out of OpenCode's inbox before they were delivered, texts in
   * the order they were sent (K3). `texts`: the removal is proven (the hub saw `session.inbox.cancelled`,
   * or a re-read inbox and the message list both lack the item); the orchestrator puts them at the front
   * of the task's follow-up queue. `uncertain`: a delete went out but the removal could not be proven
   * either way, or a newer turn of the task started since the Stop (the texts would be drained after it,
   * out of order); never dropped, the orchestrator stashes them in the task's backlog tray. The default
   * forwards to the handler installed with `setOpencodeSteerRequeueHandler`; with no handler the Stop
   * deletes nothing (see `reclaimParkedSteers`).
   */
  requeueUndeliveredSteers(a: { taskId: string; runId: string; texts: string[]; uncertain: string[] }): void;
  /**
   * Park the task's `running` OpenCode child rows `orphaned` (K2), so they stop holding the task and a
   * later sync against a server that answers settles or revives each one. Called when a lingering
   * handle loses its server, when a Stop could not confirm its children stopped, when a linger gives
   * up at its maximum duration with children unsettled.
   */
  orphanChildrenOfTask(taskId: string): void;
  /**
   * Park ONE child's `running` row `orphaned` (`orphanOpencodeChild`; a no-op for any other row): a new
   * turn found an adopted child the server positively lists as not executing. The task's other rows,
   * a live sibling's included, are left alone.
   */
  orphanChild(taskId: string, childSessionId: string): void;
  /** Hub K1: whether the hub saw this inbox item cancelled (true), watched and did not (false), or can't tell (null). */
  inboxItemCancelled(serverKey: string, sessionId: string, inboxId: string): boolean | null;
  /** Hub K1: resolve true as soon as that cancel is seen, else at `ms` with the meaning above. */
  waitInboxItemCancelled(serverKey: string, sessionId: string, inboxId: string, ms: number): Promise<boolean | null>;
}

/** The prompt body, plus `resume` (OpenCode: `false` admits the input without starting an execution). */
type PromptBody = Parameters<OpencodeClient["prompt"]>[1] & { resume?: boolean };

type SteerRequeueHandler = (a: { taskId: string; runId: string; texts: string[]; uncertain: string[] }) => void;
let steerRequeueHandler: SteerRequeueHandler | null = null;

/** Install (or clear, with null) where a Stop's undelivered steers go (see `requeueUndeliveredSteers`). Returns the previous one. */
export function setOpencodeSteerRequeueHandler(fn: SteerRequeueHandler | null): SteerRequeueHandler | null {
  const prev = steerRequeueHandler;
  steerRequeueHandler = fn;
  return prev;
}

const defaultDeps: OpencodeDriverDeps = {
  ensureServer: (spec: OpencodeServerSpec) => ensureOpencodeServer(spec),
  registerChild: (a) => registerOpencodeChildSession(a),
  ingestChildChunks: (a) => ingestOpencodeChildChunks(a),
  settleChild: (a) => settleOpencodeChild(a),
  syncChild: (a) => syncOpencodeChildFromServer(a),
  openChildSessions: (taskId) => listOpenOpencodeChildSessions(taskId),
  settledChildSessions: (taskId) => listSettledOpencodeChildSessions(taskId),
  noteChildStoppedByAgetor: (a) => noteOpencodeChildStoppedByAgetor(a),
  createClient: (ref, opts) => createOpencodeClient(ref, opts),
  requeueUndeliveredSteers: (a) => {
    if (steerRequeueHandler) steerRequeueHandler(a);
    else console.warn(`[opencode-driver] ${a.texts.length + a.uncertain.length} undelivered steer(s) of run ${a.runId} had nowhere to go`);
  },
  orphanChildrenOfTask: (taskId) => void orphanRunningOpencodeChildrenOfTask(taskId),
  orphanChild: (taskId, childSessionId) => void orphanOpencodeChild(taskId, childSessionId),
  inboxItemCancelled: (key, sid, id) => opencodeInboxItemCancelled(key, sid, id),
  waitInboxItemCancelled: (key, sid, id, ms) => waitOpencodeInboxItemCancelled(key, sid, id, ms),
};
let deps: OpencodeDriverDeps = defaultDeps;

/**
 * Whether a Stop's parked steers have somewhere to go: a handler is installed (the orchestrator's, or a
 * test's), or a test replaced the dep itself. Without one (a core handing over, a quit) the steers stay
 * parked in OpenCode's inbox, which delivers them with the session's next prompt.
 */
function canRequeueSteers(): boolean {
  return steerRequeueHandler !== null || deps.requeueUndeliveredSteers !== defaultDeps.requeueUndeliveredSteers;
}

/**
 * Turns started per task (spawn and attach), counted in this process. A Stop notes the count; when it
 * has moved by the time the Stop's steers are handed back, a newer turn of the task is already running
 * and the older steers would be drained after it, so they go to the backlog tray instead (review NIT6).
 */
const turnsStartedByTask = new Map<string, number>();
const TURNS_STARTED_MAX = 5000;
function noteTurnStarted(taskId: string): void {
  const n = (turnsStartedByTask.get(taskId) ?? 0) + 1;
  turnsStartedByTask.delete(taskId);
  turnsStartedByTask.set(taskId, n);
  while (turnsStartedByTask.size > TURNS_STARTED_MAX) {
    const oldest = turnsStartedByTask.keys().next().value;
    if (oldest === undefined) break;
    turnsStartedByTask.delete(oldest);
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Constants
 * ────────────────────────────────────────────────────────────────────────── */

export const OPENCODE_STALE_SERVER_STATUS = "OpenCode will pick up the changed harness settings after this turn";

/** The start of the status line a turn writes when the hub gave up on its server mid-turn; the orchestrator matches it to retire the turn's child rows. */
export const OPENCODE_SERVER_LOST_STATUS_PREFIX = "OpenCode server connection lost";

/**
 * The message of a Reject the user gave no reason for: one space, the only byte agetor adds to a
 * reply, and no words (I1). OpenCode 2.1.3 treats a missing or empty message as a decline that
 * interrupts the whole turn (`execution.interrupted{reason:"shutdown"}`), and any non-empty message
 * as feedback: the tool is refused and the model continues (owner decision R1). Live-verified, with
 * the source: docs/plans/opencode-server-driver-spikes.md, "Reject, duplicate ids and cancelled children".
 */
export const OPENCODE_EMPTY_REJECT_MESSAGE = " ";

/**
 * Status lines (UI-only) for an answer the user gave on a card OpenCode no longer holds: it answers the
 * reply 404/409 when another reply got there first, or when one Reject already declined the session's
 * other pending requests (live 2.1.3, r3 Q1) and the user clicked a sibling's card before its
 * `permission.replied` closed it.
 */
export const STALE_PERMISSION_ANSWER_STATUS = "OpenCode had already settled this permission request (answered or declined), so this answer was not applied";
export const STALE_FORM_ANSWER_STATUS = "OpenCode had already settled this question, so this answer was not applied";

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
/**
 * `ensureOpencodeServer` bounds each of its steps (adopt, stop, tmux, the start budget), together
 * about 30 s at worst; past this the turn stops waiting for it.
 */
const DEFAULT_CONNECT_MS = 45_000;
/** Snapshot paging: page size and the most pages one catch-up reads. */
const MESSAGE_PAGE_LIMIT = 200;
const MESSAGE_MAX_PAGES = 20;
/** Cooperative slicing (I9). */
const SLICE_MS = 15;
/** Live events held while a catch-up runs; past this the catch-up re-runs instead. */
const BUFFER_MAX = 50_000;
/** Checking whether a timed-out prompt landed: page size, most pages read back, and attempts on a failed read. */
const LANDED_LOOKUP_LIMIT = 50;
const LANDED_LOOKUP_MAX_PAGES = 20;
const LANDED_LOOKUP_ATTEMPTS = 3;
/** Sessions followed per catch-up when re-discovering children. */
const CHILD_SYNC_MAX = 50;
/** The client's `listChildren` page size (`opencode-http.ts`): a listing this long ran past one page. */
const LIST_CHILDREN_PAGE = 200;
const CHILD_MAX_DEPTH = 4;
/** Attempts for a permission reply that fails on the transport. */
const REPLY_ATTEMPTS = 3;
/** A failed permission or form reply is re-raised (card again) at most this many times per request. */
const REPLY_FAILURES_MAX = 3;
/** A failed catch-up while the turn is live is retried this many times, backing off from `catchRetryMs`. */
const CATCHUP_RETRIES = 5;
/** Lingering for background children gives up after this long. */
const DEFAULT_LINGER_MAX_MS = 24 * 60 * 60_000;

let timings = {
  /** Per-request HTTP budget of the main client; undefined: the client's default. */
  requestMs: undefined as number | undefined,
  /** How long `steer()` waits for the first prompt POST to return before giving up. */
  steerWaitMs: 20_000,
  catchRetryMs: 1000,
  lingerMaxMs: DEFAULT_LINGER_MAX_MS,
  stopConfirmMs: DEFAULT_STOP_CONFIRM_MS,
  interruptTimeoutMs: DEFAULT_INTERRUPT_TIMEOUT_MS,
  livenessMs: DEFAULT_LIVENESS_MS,
  replyRetryMs: 300,
  /** Pause before re-reading the messages after a failed landed-lookup (times the attempt number). */
  lookupRetryMs: 300,
  /** Stop: how long to wait for the hub's word on a deleted steer when the re-read could not prove its removal. */
  inboxCancelWaitMs: 2000,
  readyMs: DEFAULT_READY_MS,
  connectMs: DEFAULT_CONNECT_MS,
};

const TERMINAL_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

/* ── cards a driver closed on purpose (review N4) ───────────────────────── */

/**
 * Cards a driver of this module closed without replying (`closeOpenCards`, `serverSettled`), keyed by
 * task and request or form id. Another driver awaiting the same card reads its `cancelled` answer as
 * "closed by a driver" only when the key is here, and then re-raises it from the server's list; a
 * cancel with no note comes from `cancelPendingForTask` (Stop, delete, archive, a pipeline restart)
 * and must not bring the card back. A note is cleared when a card is registered again for its key
 * (the re-raise itself), and the oldest notes are dropped past a cap.
 */
const driverClosedCards = new Set<string>();
const DRIVER_CLOSED_CARDS_MAX = 1000;

function cardKey(taskId: string, kind: "permission" | "form", id: string): string {
  return `${taskId}\u0000${kind === "permission" ? "p" : "f"}\u0000${id}`;
}

/** Close a card as a driver (see `driverClosedCards`): the note goes in before the awaiters are released. */
function closeCardAsDriver(taskId: string, kind: "permission" | "form", id: string): void {
  const key = cardKey(taskId, kind, id);
  driverClosedCards.delete(key);
  driverClosedCards.add(key);
  while (driverClosedCards.size > DRIVER_CLOSED_CARDS_MAX) {
    const oldest = driverClosedCards.values().next().value;
    if (oldest === undefined) break;
    driverClosedCards.delete(oldest);
  }
  resolveOpencodeCardsForRequest(taskId, kind === "permission" ? { requestId: id } : { formId: id });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Small helpers
 * ────────────────────────────────────────────────────────────────────────── */

/** Start work nobody awaits; whatever it throws is logged, never unhandled. */
function background(p: Promise<unknown>): void {
  p.catch((e) => console.error("[opencode-driver] background work failed:", e));
}

const B62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
let lastIdValue = 0n;

/**
 * A client message id in OpenCode's own shape: `msg_` + the low 48 bits of
 * `ms * 4096 + counter` as 12 hex digits + 14 random base62 characters. The
 * schema only requires the `msg_` prefix (openapi `Session.Message.ID`); the
 * time-ordered body keeps our ids sorting with the server's, and the value is
 * strictly ascending within this process.
 */
export function newOpencodeMessageId(): string {
  let v = BigInt(Date.now()) * 4096n;
  if (v <= lastIdValue) v = lastIdValue + 1n;
  lastIdValue = v;
  const hex = (v & 0xffffffffffffn).toString(16).padStart(12, "0");
  const rnd = crypto.getRandomValues(new Uint8Array(14));
  let tail = "";
  for (const b of rnd) tail += B62[b % 62];
  return `msg_${hex}${tail}`;
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

/** A session's or step's model (`{providerID, id}` or a `provider/model` string) as `provider/model`; null when not told. */
function modelIdOf(m: unknown): string | null {
  if (typeof m === "string") return m.includes("/") ? m : null;
  if (!isRec(m)) return null;
  const provider = str(m.providerID);
  const id = str(m.id) ?? str(m.modelID);
  return provider && id ? `${provider}/${id}` : null;
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
  | { kind: "attach"; sessionId: string; sinceMs: number; reason: "reattach" | "wake" }
  | { kind: "linger"; sessionId: string };

interface ChildState {
  parent: string;
  depth: number;
  mapper: OpencodeEventMapper;
  settled: boolean;
  /** Launched with `background: true`, or found running on the server at a catch-up. It outlives the turn. */
  background: boolean;
  /**
   * Known to be alive now: this turn launched it, its events reached this driver, or the server listed
   * it among its active sessions. Only a confirmed background child holds a turn lingering: a child
   * adopted from a subagent row or a listing (an orphan a server crash cut off, which the server may
   * still list without an outcome) needs the server's positive word first (`confirmAdopted`).
   */
  confirmed: boolean;
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
  const onUserStop = a.onUserStop;
  const modelRef = opencodeModelRefFor(a.model, a.effort);
  if (start.kind !== "linger") noteTurnStarted(taskId);

  let sessionId: string | null = start.kind === "spawn" ? null : start.sessionId;
  let client: OpencodeClient | null = null;
  let stopClient: OpencodeClient | null = null;
  let mapper: OpencodeEventMapper | null = null;
  let subscription: { unsubscribe(): void } | null = null;

  let settled = start.kind === "linger";
  let detached = false;
  let killed = false;
  let disposed = false;
  /** The last `confirmAdopted` could not read the server's active sessions (see `confirmCarded`). */
  let livenessUnknown = false;
  /** Settled root turn, still following background children (see the header). */
  let lingerOn = start.kind === "linger";
  let lingerTimer: ReturnType<typeof setTimeout> | null = null;
  /** The hub gave up on the server: nothing to linger on. */
  let serverLost = false;
  let promptSent = false;
  /** The first prompt POST returned (spawn) or the execution is already running (attach): steering is possible. */
  let steerable = start.kind === "attach";
  const steerWaiters = new Set<() => void>();
  /** Our prompt (or, on attach, the execution) is known to be in flight on the server. */
  let delivered = start.kind !== "spawn";
  let ourMessageId: string | null = null;
  const deliveredIds = new Set<string>();

  let confirmTimer: ReturnType<typeof setTimeout> | null = null;
  /** A Stop's interrupts and steer hand-back (`kill`); `done` waits for it, capped by the confirm budget. */
  let stopTail: Promise<void> | null = null;
  let killedAt = 0;
  /** `turnsStartedByTask` for this task when the Stop came (see there). */
  let turnsAtKill = 0;
  /** This turn's steers, in the order they were accepted (a Stop hands back the ones never delivered). */
  const steered: Array<{ id: string; text: string; sentAt: number }> = [];
  /** Inbox ids the stream reported removed (`session.inbox.cancelled`): proof a delete really took the item. */
  const inboxCancelled = new Set<string>();
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
  /**
   * Failed replies per request or form id: the card is re-raised a few times, not forever. A card that
   * another driver of this module closed is re-raised apart from this count (each such close is a
   * separate event, so it can't loop on its own), and never uses it up.
   */
  const replyFailures = new Map<string, number>();
  /** A form that is not a question (an MCP elicitation, …) was reported once with a status line. */
  let warnedNonQuestion = false;

  const children = new Map<string, ChildState>();
  const subagentCalls: SubagentCall[] = [];
  const toolNames = new Map<string, string>();

  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });
  // A lingering-only handle (boot): its run settled before the restart.
  if (start.kind === "linger") resolveDone(0);

  function wakeSteerWaiters(): void {
    const waiting = [...steerWaiters];
    steerWaiters.clear();
    for (const w of waiting) w();
  }

  let userStopReported = false;
  function reportUserStop(): void {
    if (userStopReported || killed) return;
    userStopReported = true;
    try {
      onUserStop?.();
    } catch (e) {
      console.error("[opencode-driver] onUserStop failed:", e);
    }
  }

  /** The root turn no longer needs work (settled, or stopped listening). Lingering children are separate: see `canAct`. */
  const inactive = (): boolean => settled || detached;
  /** Whether this driver may still talk to the server: not stopped, and either live or lingering for children. */
  const canAct = (): boolean => !detached && !disposed && !killed && (!settled || lingerOn);

  function status(text: string): void {
    if (settled && !lingerOn) return;
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

  function unsubscribeHub(): void {
    try {
      subscription?.unsubscribe();
    } catch {
      /* already gone */
    }
    subscription = null;
  }

  /** Close open cards without replying. `rootOnly`: leave the cards of child sessions (lingering). */
  function closeOpenCards(rootOnly: boolean): void {
    for (const [rid, owner] of [...openPerms]) {
      if (rootOnly && owner !== sessionId) continue;
      openPerms.delete(rid);
      try {
        closeCardAsDriver(taskId, "permission", rid);
      } catch (e) {
        console.error("[opencode-driver] could not close a permission card:", e);
      }
    }
    for (const [fid, owner] of [...openForms]) {
      if (rootOnly && owner !== sessionId) continue;
      openForms.delete(fid);
      try {
        closeCardAsDriver(taskId, "form", fid);
      } catch (e) {
        console.error("[opencode-driver] could not close a question card:", e);
      }
    }
  }

  function shouldLinger(): boolean {
    if (killed || detached || disposed || serverLost || !subscription) return false;
    for (const st of children.values()) if (st.background && st.confirmed && !st.settled) return true;
    return false;
  }

  function hasUnsettledBackground(): boolean {
    for (const st of children.values()) if (st.background && st.confirmed && !st.settled) return true;
    return false;
  }

  /**
   * Stop following background children. `closeCards` false leaves their open cards in the registry
   * without resolving them: the root's next execution (a new turn or a wake) has its own driver,
   * which re-lists the server's open requests and takes the same cards over (they are deduped by
   * request and form id), so closing them here would cancel that driver's await.
   */
  function leaveLinger(closeCards = true): void {
    if (!lingerOn) return;
    lingerOn = false;
    if (lingerTimer) clearTimeout(lingerTimer);
    lingerTimer = null;
    unsubscribeHub();
    if (closeCards) closeOpenCards(false);
    else {
      openPerms.clear();
      openForms.clear();
    }
  }

  /** K2: the task's `running` child rows will hear nothing more from this driver; park them `orphaned`. */
  function orphanChildren(): void {
    try {
      deps.orphanChildrenOfTask(taskId);
    } catch (e) {
      console.error("[opencode-driver] could not orphan the task's child rows:", e);
    }
  }

  /** The linger reached its maximum duration: children still unsettled are left to a later sync (K2). */
  function lingerExpired(): void {
    lingerTimer = null;
    if (!lingerOn) return;
    let unsettled = false;
    for (const st of children.values()) if (st.background && !st.settled) unsettled = true;
    if (unsettled) orphanChildren();
    leaveLinger();
  }

  function settle(code: number): void {
    if (settled) return;
    settled = true;
    clearTimers();
    buffer = [];
    wakeSteerWaiters();
    const linger = shouldLinger();
    if (linger) {
      lingerOn = true;
      lingerTimer = setTimeout(lingerExpired, timings.lingerMaxMs);
      (lingerTimer as unknown as { unref?: () => void }).unref?.();
    } else {
      unsubscribeHub();
    }
    // A turn that is over leaves no card behind (the server clears its own); a lingering one keeps its children's.
    closeOpenCards(linger);
    activity();
    const tail = stopTail;
    if (killed && tail) {
      const left = Math.max(0, killedAt + timings.stopConfirmMs - Date.now());
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cap = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, left);
        (timer as unknown as { unref?: () => void }).unref?.();
      });
      void Promise.race([tail.catch(() => {}), cap]).then(() => {
        if (timer) clearTimeout(timer);
        resolveDone(code);
      });
      return;
    }
    resolveDone(code);
  }

  function finish(t: OpencodeTerminal): void {
    activity();
    if (t.outcome === "succeeded") return settle(0);
    if (t.outcome === "failed") return settle(1); // the mapper already posted the error line
    const reason = (t.reason ?? "").replace(/[^a-z-]/gi, "").slice(0, 40);
    if (killed) return settle(130);
    if (reason === "user") {
      reportUserStop(); // before done resolves: the orchestrator marks the run cancelled
      return settle(130);
    }
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

  /**
   * Send a reply, retrying transport failures. `staleNote`: the status line for an answer the user gave
   * on a card the server no longer holds (404/409: another reply, or one reject declining its siblings,
   * got there first); the card closes either way. Status lines are UI-only, never sent to the model.
   */
  async function replyWithRetry(what: string, send: () => Promise<void>, staleNote?: string): Promise<boolean> {
    for (let attempt = 1; attempt <= REPLY_ATTEMPTS; attempt++) {
      try {
        await send();
        return true;
      } catch (e) {
        if (isStaleReply(e)) {
          if (staleNote) status(staleNote);
          return true; // the server no longer holds it: nothing to retry
        }
        if (!isTransportFailure(e) || attempt === REPLY_ATTEMPTS || !canAct()) {
          status(`OpenCode didn't accept the ${what}: ${errText(e)}`);
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, timings.replyRetryMs * attempt));
        if (!canAct()) return false;
      }
    }
    return false;
  }

  /**
   * A reply failed (`failed`), or a card was closed by another driver while the server still holds the
   * request (`closed`): raise the card (or retry the auto-approval) again from the server's list. Failed
   * replies are re-raised a few times at most; a close does not count toward that cap. The caller drops
   * the id from its handled set right after this returns true, before the list answers.
   */
  function reraise(id: string, why: "failed" | "closed"): boolean {
    if (why === "failed") {
      const n = (replyFailures.get(id) ?? 0) + 1;
      replyFailures.set(id, n);
      if (n >= REPLY_FAILURES_MAX) return false;
    }
    const c = client;
    if (!c) return false;
    background(settled ? lingerResync() : relistCards(c));
    return true;
  }

  async function handlePermission(req: Rec): Promise<void> {
    const rid = str(req.id);
    const sid = str(req.sessionID) ?? sessionId;
    if (!rid || !sid || !client || handledPerms.has(rid) || !canAct()) return;
    handledPerms.add(rid);
    const c = client;
    ourPermReplies.add(rid);
    try {
      if (mode === "auto") {
        const ok = await replyWithRetry("permission", () => c.replyPermission(sid, rid, { decision: "once" }));
        if (!ok && reraise(rid, "failed")) handledPerms.delete(rid);
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
      driverClosedCards.delete(cardKey(taskId, "permission", rid)); // a card is open again: a later cancel is judged afresh
      openPerms.set(rid, sid);
      activity();
      const answer = await reg.answer;
      // Still ours to close: nobody in this driver closed it (serverSettled and closeOpenCards delete first).
      const closedElsewhere = openPerms.delete(rid);
      if (!canAct()) return; // Stop interrupts the session itself; no reply after it
      if ("cancelled" in answer) {
        // Closed by another driver of this task while this turn still acts on it: the server may still
        // hold the request, so take it up again from the server's list. A close no driver noted is a
        // Stop / delete / archive sweep (`cancelPendingForTask`): the card stays closed (review N4).
        if (closedElsewhere && driverClosedCards.has(cardKey(taskId, "permission", rid)) && reraise(rid, "closed")) handledPerms.delete(rid);
        return;
      }
      activity();
      const typed = answer.message !== undefined && answer.message.trim() !== "" ? answer.message : undefined;
      // A Reject always carries a message: the user's reason, or the one-space stand-in (see the constant).
      const message = answer.decision === "reject" ? (typed ?? OPENCODE_EMPTY_REJECT_MESSAGE) : typed;
      ourPermReplies.add(rid);
      const ok = await replyWithRetry(
        "permission answer",
        () => c.replyPermission(sid, rid, { decision: answer.decision, ...(message !== undefined ? { message } : {}) }),
        STALE_PERMISSION_ANSWER_STATUS,
      );
      if (!ok && reraise(rid, "failed")) handledPerms.delete(rid); // the card comes back from the server's list
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
    if (!fid || !sid || !client || handledForms.has(fid) || !canAct()) return;
    handledForms.add(fid);
    const meta = isRec(form.metadata) ? form.metadata : {};
    const fields = meta.kind === "question" ? questionFields(form.fields) : null;
    if (!fields) {
      // An MCP elicitation or another kind of form: not ours to answer or cancel. Say once that the turn
      // may be waiting on it, so a stalled turn is not a mystery.
      if (!warnedNonQuestion) {
        warnedNonQuestion = true;
        const kind = (str(meta.kind) ?? "").replace(/[^a-z0-9-]/gi, "").slice(0, 40);
        status(`OpenCode is waiting on a form that can't be shown here${kind ? ` (${kind})` : ""}: answer it in another OpenCode client, or stop the turn`);
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
      driverClosedCards.delete(cardKey(taskId, "form", fid));
      openForms.set(fid, sid);
      activity();
      const answer = await reg.answer;
      const closedElsewhere = openForms.delete(fid);
      if (!canAct()) return;
      if (answer.outcome === "cancelled") {
        // As for permissions: closed by another driver while the server may still hold the form.
        if (closedElsewhere && driverClosedCards.has(cardKey(taskId, "form", fid)) && reraise(fid, "closed")) handledForms.delete(fid);
        return;
      }
      activity();
      ourFormReplies.add(fid);
      let ok: boolean;
      if (answer.outcome === "answered") {
        ok = await replyWithRetry("answer", () => c.replyForm(sid, fid, answer.answer), STALE_FORM_ANSWER_STATUS);
      } else if (answer.message !== undefined && answer.message !== "") {
        const message = answer.message;
        // A typed reason: the model continues with the user's words (the form is dismissed with them).
        ok = await replyWithRetry("answer", () => c.cancelForm(sid, fid, message), STALE_FORM_ANSWER_STATUS);
      } else {
        ok = await replyWithRetry("answer", () => c.replyForm(sid, fid, {}), STALE_FORM_ANSWER_STATUS);
      }
      if (!ok && reraise(fid, "failed")) handledForms.delete(fid);
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
      if (openPerms.delete(id)) closeCardAsDriver(taskId, "permission", id);
    } else {
      if (ourFormReplies.has(id)) return;
      if (openForms.delete(id)) closeCardAsDriver(taskId, "form", id);
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
    info?: { title?: string | null; agent?: string | null; background?: boolean; model?: unknown },
  ): ChildState | null {
    const known = children.get(childId);
    if (known) return known;
    const call = depth === 1 ? claimSubagentCall() : undefined;
    const state: ChildState = {
      parent: parentId,
      depth,
      // The child's own model when its session says (a subagent can run another model); else the turn's.
      mapper: createOpencodeEventMapper({ sessionId: childId, model: modelIdOf(info?.model) ?? a.model }),
      settled: false,
      background: call ? call.background : info?.background === true,
      confirmed: !!call,
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
      model: e.type === "session.created" || e.type === "session.step.started" || e.type === "session.model.selected" ? d.model : null,
    });
    if (!state) return;
    state.confirmed = true; // a live event: it is running now
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
        if (lingerOn && !hasUnsettledBackground()) leaveLinger();
      }
    }
  }

  /** This task's settled child sessions: read once per pass (a sync, a re-list, a Stop) and shared by its steps. */
  function loadSettledRows(): ReadonlySet<string> {
    try {
      return new Set(deps.settledChildSessions(taskId));
    } catch (e) {
      console.error("[opencode-driver] could not list settled subagent rows:", e);
      return new Set();
    }
  }

  /**
   * A session's children. OpenCode lists them newest `time.updated` first and pages on that key, so a
   * child updated while the pages were read can slip across a page boundary and be skipped (r3 spike).
   * When the listing ran past one page, the first page is read once more (as one more full listing:
   * the client exposes no single page) and anything new is added; with one page nothing can be skipped.
   */
  async function listChildrenOnce(c: OpencodeClient, id: string): Promise<unknown[]> {
    const kids = await c.listChildren(id);
    if (kids.length < LIST_CHILDREN_PAGE) return kids;
    let again: unknown[];
    try {
      again = await c.listChildren(id);
    } catch {
      return kids;
    }
    const known = new Set(kids.map((k) => (isRec(k) ? str(k.id) : null)).filter((x): x is string => !!x));
    const fresh = again.filter((k) => isRec(k) && !!str(k.id) && !known.has(str(k.id)!));
    return fresh.length > 0 ? [...fresh, ...kids] : kids;
  }

  /**
   * Learn the session's children from the server and bring each one up to date (catch-up, and a
   * lingering resync). A child is followed when the hub owns it, when it is new in this turn's window,
   * or when this task's subagent table says it is still running or orphaned (a wake attach settles
   * the children of earlier turns that way). A child whose subagent row is already settled is never
   * followed again and does not count, and neither does a child this driver itself already settled
   * (its terminal reached this driver, or an earlier sync settled it): only followed children count
   * toward `CHILD_SYNC_MAX` (a task with many finished subagents still reaches its live one).
   * `settledRows` is the pass's one read of the settled rows, shared with the re-lists around it.
   */
  async function syncChildren(settledRows: ReadonlySet<string> = loadSettledRows()): Promise<void> {
    if (!client || !sessionId) return;
    const c = client;
    const root = sessionId;
    const open = new Set(deps.openChildSessions(taskId));
    const queue: Array<{ id: string; depth: number }> = [{ id: root, depth: 0 }];
    /** Dedupe only. */
    const seen = new Set<string>([root]);
    let followed = 0;
    const toSync: string[] = [];
    /** Settled by this driver: never followed, synced or counted again. */
    const doneHere = (id: string): boolean => children.get(id)?.settled === true;
    const follow = (id: string, state: ChildState | null): boolean => {
      if (!state) return false;
      toSync.push(id);
      followed++;
      return true;
    };
    // Everything the hub says this turn owns, including children created while the stream was down,
    // minus the ones of earlier turns that already settled (the hub owns the session's whole history).
    for (const o of lastOwned) {
      if (followed >= CHILD_SYNC_MAX) break;
      if (!o.isChild || seen.has(o.sessionId) || doneHere(o.sessionId)) continue;
      if (settledRows.has(o.sessionId) && !children.has(o.sessionId)) continue;
      seen.add(o.sessionId);
      // Still unsettled when the sync looks: it may well outlive this turn (see the linger rules).
      follow(o.sessionId, ensureChild(o.sessionId, o.childOf ?? root, o.depth, { background: true }));
    }
    while (queue.length > 0 && followed < CHILD_SYNC_MAX && canAct()) {
      const cur = queue.shift()!;
      if (cur.depth >= CHILD_MAX_DEPTH) continue;
      let kids: unknown[];
      try {
        kids = await listChildrenOnce(c, cur.id);
      } catch {
        continue;
      }
      for (const k of kids) {
        if (!isRec(k)) continue;
        const id = str(k.id);
        if (!id || seen.has(id) || doneHere(id)) continue;
        const created = isRec(k.time) && typeof k.time.created === "number" ? k.time.created : 0;
        // A child of an earlier turn is followed only while its row is still open.
        if (!children.has(id) && !open.has(id) && created < startedAt - 2000) continue;
        if (!children.has(id) && settledRows.has(id)) continue;
        if (followed >= CHILD_SYNC_MAX) break;
        seen.add(id);
        const finished = typeof k.outcome === "string";
        const state = ensureChild(id, cur.id, cur.depth + 1, { title: str(k.title), agent: str(k.agent), background: !finished, model: k.model });
        if (follow(id, state)) {
          if (finished) state!.settled = true;
          queue.push({ id, depth: cur.depth + 1 });
        }
      }
      await yieldTick();
    }
    // This task's open rows are synced even when the session tree does not list them.
    for (const id of open) {
      if (seen.has(id) || doneHere(id) || followed >= CHILD_SYNC_MAX) continue;
      seen.add(id);
      follow(id, ensureChild(id, root, 1, { background: true }));
    }
    for (const id of open) {
      const st = children.get(id);
      if (st) st.background = true; // its subagent row is still open: it outlives any turn
    }
    for (const [id, st] of children) if (!st.settled && !toSync.includes(id)) toSync.push(id);
    for (const id of toSync.slice(0, CHILD_SYNC_MAX)) {
      if (!canAct()) return;
      try {
        await deps.syncChild({ taskId, runId, client: c, childSessionId: id });
      } catch (e) {
        console.error("[opencode-driver] child sync failed:", e);
      }
      await yieldTick();
    }
    // What the sync settled no longer holds a lingering turn open.
    const stillOpen = new Set(deps.openChildSessions(taskId));
    for (const id of toSync) {
      const st = children.get(id);
      if (st && !st.settled && !stillOpen.has(id)) st.settled = true;
    }
    await confirmAdopted(c, false);
  }

  /**
   * Ask the server which adopted background children (unsettled, not yet confirmed) are executing:
   * those it lists are confirmed and may hold a linger; the rest are followed (cards, Stop) but hold
   * nothing, until an event of theirs shows them alive. When the listing can't be read, a child with
   * an open card counts as alive (a request the server holds is one, and closing its card at the
   * settle would strand it); one without stays unconfirmed. `retire` (a new turn, before its prompt):
   * also sync the unconfirmed ones in the background, so a dead orphan's row is settled for good. A
   * `running` row the server positively lists as not executing (a crash cut it off; the sync leaves a
   * `running` row with no outcome as it is) is parked `orphaned` first, that row alone (`orphanChild`),
   * so that sync settles it while a live sibling keeps its row and its hold. A session waiting on a
   * permission or a question is listed like a working one (r3 Q10), so a carded child is never taken for
   * dead; one that just finished is not listed (r3 Q11), and the sync settles it from its idle record.
   */
  async function confirmAdopted(c: OpencodeClient, retire: boolean): Promise<void> {
    const pendingIds = [...children].filter(([, st]) => st.background && !st.settled && !st.confirmed).map(([id]) => id);
    if (pendingIds.length === 0) return;
    let active: Record<string, unknown> | null = null;
    try {
      active = await c.activeSessions();
      livenessUnknown = false;
    } catch {
      active = null;
      livenessUnknown = true;
    }
    if (!active) confirmCarded();
    for (const id of pendingIds) {
      const st = children.get(id);
      if (!st || st.settled || st.confirmed) continue;
      if (active && active[id] !== undefined) {
        st.confirmed = true;
        continue;
      }
      if (!retire || !canAct()) continue;
      if (active) {
        // Positively not executing: parked first, so the sync below settles it (it leaves a `running` row as it is).
        try {
          deps.orphanChild(taskId, id);
        } catch (e) {
          console.error("[opencode-driver] could not orphan a child row:", e);
        }
      }
      background(deps.syncChild({ taskId, runId, client: c, childSessionId: id }));
    }
  }

  /** The server's active listing could not be read: confirm the adopted children that hold an open card. */
  function confirmCarded(): void {
    const carded = new Set<string>([...openPerms.values(), ...openForms.values()]);
    for (const [id, st] of children) if (!st.confirmed && !st.settled && carded.has(id)) st.confirmed = true;
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

  /** Permission and form events, for any session this turn owns. True when `e` was one of them. */
  function cardEvent(e: OpencodeEnvelope, d: Rec): boolean {
    switch (e.type) {
      case "permission.asked":
        background(handlePermission(d));
        return true;
      case "permission.replied":
        serverSettled("permission", str(d.requestID));
        return true;
      case "form.created":
        background(handleForm(d.form));
        return true;
      case "form.replied":
      case "form.cancelled":
        serverSettled("form", str(d.id));
        return true;
      default:
        return false;
    }
  }

  function dispatch(e: OpencodeEnvelope, origin: OpencodeHubOrigin): void {
    if (inactive() || !mapper) return;
    const d = isRec(e.data) ? e.data : {};
    try {
      if (origin.isChild) {
        const st = children.get(origin.sessionId);
        if (st) st.confirmed = true; // a live event of any kind: it is running now
      }
      if (cardEvent(e, d)) return;
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

  /** Lingering: child events only. The root's next execution ends the linger (the hub wakes for it). */
  function lingerEvent(e: OpencodeEnvelope, origin: OpencodeHubOrigin): void {
    const d = isRec(e.data) ? e.data : {};
    try {
      if (!origin.isChild) {
        // The next execution's driver owns the children's cards from here (see leaveLinger).
        if (e.type === "session.execution.started" && d.sessionID === sessionId) leaveLinger(false);
        return;
      }
      const st = children.get(origin.sessionId);
      if (st) st.confirmed = true;
      if (cardEvent(e, d)) return;
      dispatchChild(e, origin);
    } catch (err) {
      console.error("[opencode-driver] event handling failed:", err);
    }
  }

  function onHubEvent(e: OpencodeEnvelope, origin: OpencodeHubOrigin): void {
    if (e.type === "session.inbox.cancelled" && !origin.isChild && isRec(e.data) && e.data.sessionID === sessionId) {
      const inboxId = str(e.data.inboxID);
      if (inboxId && steered.some((m) => m.id === inboxId)) inboxCancelled.add(inboxId);
    }
    if (detached || disposed) return;
    if (settled) {
      if (lingerOn) lingerEvent(e, origin);
      return;
    }
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

  /** Hub resync while lingering: children's cards and state only. */
  async function lingerResync(): Promise<void> {
    const c = client;
    if (!c || !lingerOn || !canAct()) return;
    await relistAndSync(c);
    if (lingerOn && !hasUnsettledBackground()) leaveLinger();
  }

  /**
   * Re-list cards, re-sync children, then re-list the sessions the sync newly found (a wake or a
   * linger can learn of a background child only there, and its open request needs a card). One
   * read of the settled rows serves all three steps.
   */
  async function relistAndSync(c: OpencodeClient): Promise<void> {
    const settledRows = loadSettledRows();
    const listed = await relistCards(c, settledRows);
    if (!canAct()) return;
    await syncChildren(settledRows);
    if (!canAct()) return;
    const fresh = cardSessions(settledRows).filter((sid) => !listed.has(sid));
    if (fresh.length > 0) await relistCards(c, settledRows, fresh);
    // Children the sync found get their cards only from that second re-list.
    if (livenessUnknown) confirmCarded();
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

  /** The first `idle` marker after the anchor: how that execution ended, and where it sits in the list. */
  function idleAfter(list: unknown[], anchor: string): { outcome: string; error?: unknown; index: number } | null {
    const at = list.findIndex((m) => isRec(m) && m.id === anchor);
    if (at < 0) return null;
    for (let i = at + 1; i < list.length; i++) {
      const m = list[i];
      if (isRec(m) && m.type === "idle") {
        return { outcome: typeof m.outcome === "string" ? m.outcome : "succeeded", error: m.error, index: i };
      }
    }
    return null;
  }

  /**
   * The sessions whose cards a re-list reads: the root while live, then every child that may still
   * hold a request. A child whose subagent row is settled is skipped (the hub owns every child the
   * session ever had, and each costs two requests per re-list), and the list is capped.
   */
  function cardSessions(settledRows: ReadonlySet<string>): string[] {
    const sessions = new Set<string>();
    if (!settled && sessionId) sessions.add(sessionId);
    for (const [id, st] of children) if (!st.settled && !settledRows.has(id)) sessions.add(id);
    for (const o of lastOwned) {
      if (o.sessionId === sessionId || children.get(o.sessionId)?.settled || settledRows.has(o.sessionId)) continue;
      sessions.add(o.sessionId);
    }
    return [...sessions].slice(0, CHILD_SYNC_MAX);
  }

  /**
   * Re-list pending permissions and forms: raise cards the server still holds, close the ones it no
   * longer does. Only a card that was already open when the list was requested can be missing from
   * it: one opened while the request was in flight is newer than the list and stays.
   */
  async function relistCards(
    c: OpencodeClient,
    settledRows: ReadonlySet<string> = loadSettledRows(),
    only?: string[],
  ): Promise<Set<string>> {
    const listed = new Set<string>();
    for (const sid of only ?? cardSessions(settledRows)) {
      if (!canAct()) return listed;
      listed.add(sid);
      try {
        const before = [...openPerms].filter(([, owner]) => owner === sid).map(([rid]) => rid);
        const perms = await c.listPermissions(sid);
        const live = new Set<string>();
        for (const p of perms) {
          if (!isRec(p)) continue;
          const id = str(p.id);
          if (id) live.add(id);
          background(handlePermission({ ...p, sessionID: str(p.sessionID) ?? sid }));
        }
        for (const rid of before) if (openPerms.get(rid) === sid && !live.has(rid)) serverSettled("permission", rid);
      } catch {
        /* a session that is gone, or a blip: the next catch-up retries */
      }
      try {
        const before = [...openForms].filter(([, owner]) => owner === sid).map(([fid]) => fid);
        const forms = await c.listForms(sid);
        const live = new Set<string>();
        for (const f of forms) {
          if (!isRec(f)) continue;
          const id = str(f.id);
          if (id) live.add(id);
          background(handleForm({ ...f, sessionID: str(f.sessionID) ?? sid }));
        }
        for (const fid of before) if (openForms.get(fid) === sid && !live.has(fid)) serverSettled("form", fid);
      } catch {
        /* as above */
      }
    }
    return listed;
  }

  /** One catch-up. False when it could not read the server (the caller retries, capped). */
  async function catchUpOnce(): Promise<boolean> {
    const c = client;
    const sid = sessionId;
    const m = mapper;
    if (!c || !sid || !m) return true;
    buffering = true;
    let snapshotTerminal: { outcome: string; error?: unknown; index: number } | null = null;
    let anchorFound = false;
    let notActive = false;
    let ok = true;
    /** Held events from the root's next execution on: replayed only after this turn settled (see below). */
    let afterOurs: Array<{ e: OpencodeEnvelope; origin: OpencodeHubOrigin }> = [];
    try {
      const { list, truncated } = await fetchMessagesAsc(c, sid, startedAt);
      if (inactive()) return true;
      const anchor = pickAnchor(list, truncated);
      if (anchor) {
        anchorFound = true;
        snapshotTerminal = idleAfter(list, anchor);
        // Seed up to this turn's own idle: whatever follows belongs to the next execution.
        const upto = snapshotTerminal ? list.slice(0, snapshotTerminal.index + 1) : list;
        const seed = m.beginSeed({ afterUserMessageId: anchor });
        for (let i = 0; i < upto.length; i += MESSAGE_PAGE_LIMIT) {
          await emitCooperative(seed.push(upto.slice(i, i + MESSAGE_PAGE_LIMIT)));
          if (inactive()) return true;
        }
        seed.end();
        if (!delivered && ourMessageId !== null) markDelivered();
      }
      // Children the sync discovers (a wake's background subagents) get their cards from the second re-list.
      await relistAndSync(c);
      if (inactive()) return true;
      try {
        const active = await c.activeSessions();
        notActive = active[sid] === undefined;
      } catch {
        notActive = false;
      }
    } catch (e) {
      ok = false;
      if (!inactive()) console.warn(`[opencode-driver] catch-up failed: ${errText(e)}`);
    } finally {
      buffering = false;
      let held = buffer;
      buffer = [];
      if (snapshotTerminal) {
        // The snapshot says this turn's execution is over. Held events of the root's NEXT execution must
        // not reach this run: drain up to its `execution.started`, and keep the rest for after the settle.
        const cut = held.findIndex((it) => !it.origin.isChild && it.e.type === "session.execution.started" && isRec(it.e.data) && it.e.data.sessionID === sid);
        if (cut >= 0) {
          afterOurs = held.slice(cut);
          held = held.slice(0, cut);
        }
      }
      for (const item of held) {
        if (inactive()) break;
        dispatch(item.e, item.origin);
      }
      if (bufferOverflow) {
        bufferOverflow = false;
        catchAgain = true;
      }
    }
    // Once settled, the next execution's events go where any live event would: a lingering handle takes
    // its children's events (and leaves at that `execution.started`), anything else drops them.
    const replayAfterOurs = (): void => {
      const rest = afterOurs;
      afterOurs = [];
      if (!inactive()) return; // never into a live turn: that is the bug this split prevents
      for (const item of rest) onHubEvent(item.e, item.origin);
    };
    if (inactive()) {
      replayAfterOurs();
      return true;
    }
    if (snapshotTerminal) {
      // This turn's execution ended and the live terminal was lost (or came before we attached). A newer
      // execution may already be running; it is not ours, the hub's open-execution tracking wakes for it.
      const outcome = snapshotTerminal.outcome === "failed" || snapshotTerminal.outcome === "interrupted" ? snapshotTerminal.outcome : "succeeded";
      // An idle marker carries no interruption reason; none is invented (finish() decides from killed / empty reject).
      emit(
        m.feed({
          type: `session.execution.${outcome}`,
          data: { sessionID: sid, ...(outcome === "failed" ? { error: snapshotTerminal.error } : {}) },
        }),
      );
      delivered = true;
      onRootTerminal();
      replayAfterOurs();
    } else if (ok && notActive && start.kind === "attach" && !anchorFound) {
      status("OpenCode has no running turn for this session anymore");
      settle(1);
    }
    return ok;
  }

  function requestCatchUp(): Promise<void> {
    if (inactive() || !mapper || !client) return Promise.resolve();
    if (start.kind === "spawn" && !promptSent) return Promise.resolve();
    if (catching) {
      catchAgain = true;
      return catching;
    }
    catching = (async () => {
      let failures = 0;
      try {
        do {
          catchAgain = false;
          const ok = await catchUpOnce();
          if (!ok && !inactive() && failures < CATCHUP_RETRIES) {
            // Could not read the server: try again with a growing, capped pause.
            await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, timings.catchRetryMs * 2 ** failures)));
            failures++;
            catchAgain = true;
          }
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

  /** Interrupt the root session. True when the server says it interrupted a running execution. */
  async function requestInterrupt(): Promise<boolean> {
    const c = stopClient;
    const sid = sessionId;
    if (!c || !sid || settled) return false;
    let interrupted = false;
    try {
      interrupted = await c.interrupt(sid);
    } catch {
      return false; // the confirm timer settles the turn
    }
    if (settled) return interrupted;
    // Nothing was running although our message was delivered: the execution already ended.
    if (!interrupted && delivered) settle(130);
    // Not delivered yet: markDelivered() interrupts again once the server starts it.
    return interrupted;
  }

  /**
   * After a Stop whose root interrupt went through, BEFORE the children are interrupted: this turn's
   * steers that OpenCode had not delivered yet stay parked in the session's inbox and would ride into
   * whatever execution starts next (r3 spike), and interrupting a background child starts one at once
   * (its "subagent cancelled" item wakes the parent), so the parked steers are taken out first.
   *
   * Each one still parked is deleted. OpenCode answers the delete 204 even for an item it already
   * delivered, so a removal counts as proven only when the stream carried its `session.inbox.cancelled`
   * (seen here before the settle unsubscribed, or by the hub, K1), or when a re-read inbox and the
   * message list both lack it (a delivered item is listed with id = inboxID by the time it is reported
   * delivered, r3 Q9). A deleted steer the inbox still lists stayed parked (OpenCode delivers it with the
   * next prompt); one the message list shows was delivered: neither is handed back. When the reads fail,
   * the hub's word is awaited (bounded, `inboxCancelWaitMs`); a removal still unproven goes back as
   * `uncertain`, never dropped. Proven texts go back as `texts`, unless a newer turn of the task started
   * since the Stop (they would be drained after it, out of order): then they go back as `uncertain` too.
   *
   * Only an idle session is touched (no execution can deliver an item meanwhile), and only when someone
   * takes the texts: with no requeue handler (a core handing over, a quit) the steers stay parked.
   * Bounded: a few calls on the stop client, each under its timeout, and `done` stops waiting at the
   * confirm budget.
   */
  async function reclaimParkedSteers(): Promise<void> {
    const c = stopClient;
    const sid = sessionId;
    if (!c || !sid || steered.length === 0 || !canRequeueSteers()) return;
    const ours = [...steered];
    /** Every steer a delete went out for, whatever the call answered: only the reads below decide. */
    const sent: Array<{ id: string; text: string; sentAt: number }> = [];
    try {
      // Idle first: the interrupted execution has to be over before anything can be called parked.
      let idle = false;
      for (let attempt = 0; attempt < 3 && !idle; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, timings.lookupRetryMs * attempt));
        idle = (await c.activeSessions())[sid] === undefined;
      }
      if (!idle) return;
      const parked = new Set((await c.listInbox(sid)).map((i) => i.id));
      for (const m of ours) {
        if (!parked.has(m.id)) continue;
        sent.push(m);
        try {
          // True only says the server took the request (see the client): the removal is proven below.
          await c.cancelInboxItem(sid, m.id);
        } catch {
          /* it may or may not have landed: the reads below decide */
        }
      }
    } catch {
      // A read before any delete failed (each delete catches its own): nothing was deleted, whatever is
      // parked stays parked.
      return;
    }
    if (sent.length === 0) return;
    const cancelSeen = (id: string): boolean => {
      if (inboxCancelled.has(id)) return true;
      try {
        return deps.inboxItemCancelled(harnessId, sid, id) === true;
      } catch {
        return false;
      }
    };
    const proven = new Set<string>();
    const uncertainIds = new Set<string>();
    for (const m of sent) if (cancelSeen(m.id)) proven.add(m.id);
    const rest = sent.filter((m) => !proven.has(m.id));
    if (rest.length > 0) {
      let read: { still: Set<string>; found: Set<string> } | null = null;
      try {
        const still = new Set((await c.listInbox(sid)).map((i) => i.id));
        const scan = await scanMessages(c, sid, Math.min(...rest.map((m) => m.sentAt)), new Set(rest.map((m) => m.id)));
        // A scan that could not read back to the steers proves nothing about delivery.
        if (scan.complete) read = { still, found: scan.found };
      } catch {
        read = null;
      }
      if (read) {
        for (const m of rest) {
          if (cancelSeen(m.id) || (!read.still.has(m.id) && !read.found.has(m.id))) proven.add(m.id);
        }
      } else {
        const words = await Promise.all(
          rest.map((m) =>
            Promise.resolve()
              .then(() => deps.waitInboxItemCancelled(harnessId, sid, m.id, timings.inboxCancelWaitMs))
              .catch((): boolean | null => null),
          ),
        );
        rest.forEach((m, i) => {
          if (words[i] === true || inboxCancelled.has(m.id)) proven.add(m.id);
          else uncertainIds.add(m.id);
        });
      }
    }
    // A newer turn of the task is already running: the orchestrator would drain these after it.
    const overtaken = (turnsStartedByTask.get(taskId) ?? 0) !== turnsAtKill;
    const texts = overtaken ? [] : sent.filter((m) => proven.has(m.id)).map((m) => m.text);
    const uncertain = sent.filter((m) => uncertainIds.has(m.id) || (overtaken && proven.has(m.id))).map((m) => m.text);
    if (texts.length === 0 && uncertain.length === 0) return;
    try {
      deps.requeueUndeliveredSteers({ taskId, runId, texts, uncertain });
    } catch (e) {
      console.error("[opencode-driver] could not hand back the undelivered steers:", e);
    }
  }

  function armConfirm(): void {
    if (confirmTimer || settled) return;
    confirmTimer = setTimeout(() => {
      if (settled) return;
      status("OpenCode didn't confirm the stop");
      settle(130);
    }, timings.stopConfirmMs);
    (confirmTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Interrupt every unsettled child this driver knows (and the hub's owned children whose row is not
   * settled). Bounded, best effort. Only a child the server reports it actually interrupted is settled
   * `interrupted`; one that had already finished keeps its real outcome: a child this driver follows
   * (or whose row is still open) is synced from the server instead. When any of it could not be
   * confirmed (a call failed or timed out), the task's `running` rows are parked `orphaned` (K2).
   */
  async function interruptChildren(): Promise<void> {
    const c = stopClient;
    const sid = sessionId;
    if (!c || !sid) return;
    const settledRows = loadSettledRows();
    const openRows = new Set(deps.openChildSessions(taskId));
    const ids = new Set<string>();
    for (const [id, st] of children) if (!st.settled) ids.add(id);
    try {
      for (const o of opencodeOwnedSessions(harnessId, sid)) {
        if (o.isChild && !children.get(o.sessionId)?.settled && !settledRows.has(o.sessionId)) ids.add(o.sessionId);
      }
    } catch {
      /* the hub has no record: the known children are enough */
    }
    // Children past the cap are not interrupted at all: that is not a confirmed stop either.
    let unconfirmed = ids.size > CHILD_SYNC_MAX;
    const results = await Promise.allSettled(
      [...ids].slice(0, CHILD_SYNC_MAX).map(async (id) => {
        // Before the call, durably: the parent's "subagent cancelled" wake can arrive before the interrupt
        // answers, or in the next core after a restart.
        try {
          deps.noteChildStoppedByAgetor({ taskId, childSessionId: id });
        } catch (e) {
          console.error("[opencode-driver] could not note a stopped child:", e);
        }
        const wasRunning = await c.interrupt(id);
        const st = children.get(id);
        if (!wasRunning) {
          if (st || openRows.has(id)) await deps.syncChild({ taskId, runId, client: c, childSessionId: id });
          return;
        }
        if (st) st.settled = true;
        try {
          deps.settleChild({ taskId, childSessionId: id, outcome: "interrupted" });
        } catch (e) {
          console.error("[opencode-driver] child settle failed:", e);
        }
      }),
    );
    if (results.some((r) => r.status === "rejected")) unconfirmed = true;
    // An interrupt that failed or timed out: the server may be gone, and nothing may ever settle those
    // rows (K2). A child that is in fact still running is revived by a later sync.
    if (unconfirmed) orphanChildren();
  }

  function kill(): void {
    if (settled) {
      // A lingering handle has no turn to stop: stopping it means stopping what it follows.
      if (lingerOn && !killed) {
        killed = true;
        background(dispose());
      }
      return;
    }
    if (killed) return;
    killed = true;
    killedAt = Date.now();
    turnsAtKill = turnsStartedByTask.get(taskId) ?? 0;
    wakeSteerWaiters();
    if (detached) {
      settle(130); // nobody listens anymore; do not leave `done` pending
      return;
    }
    if (start.kind === "spawn" && !promptSent) {
      // Nothing of ours is running on the server yet; the start sequence stops at its next checkpoint.
      settle(130);
      return;
    }
    // A spawn with its prompt on the way, or an attach (the execution is already running): interrupt, and
    // settle anyway when OpenCode does not confirm. Without a client yet, `connect()` interrupts as soon as it has one.
    armConfirm();
    if (client) {
      // The root first, and waited for (its call is bounded by the interrupt timeout): a child's
      // "cancelled" item then lands on the parent after the root's execution ended, never inside it.
      // Then the parked steers are taken out, BEFORE any child is interrupted: that interrupt wakes the
      // parent at once, and the wake's execution would deliver them while they are being deleted.
      const tail = (async () => {
        const went = await requestInterrupt();
        if (went) await reclaimParkedSteers().catch((e) => console.error("[opencode-driver] steer hand-back failed:", e));
        await interruptChildren();
      })();
      background(tail);
      // `done` waits for the steers to be handed back (so they queue ahead of anything the settle
      // starts), never past the stop's confirm budget.
      stopTail = tail;
    }
  }

  /**
   * Send text to the session as a user message with our own message id. Re-posting the same id on the
   * same session is idempotent for DELIVERY (the text is delivered once; a 409 is an id clash with
   * another session's record, an error), but not for EXECUTION: a replay after the session went idle
   * runs an empty execution unless it carries `resume:false`, and agetor would mint a spurious run for
   * that execution (decision R3). Live facts: docs/plans/opencode-server-driver-spikes.md.
   *
   * A POST that timed out may have landed, so the id is looked up first (`lookupMessage`):
   *   - present: done, nothing is sent again;
   *   - absent (the session's history was read back past the send): sent again once, same id;
   *   - unknown (the reads failed, or the history is too long to read back): while an execution runs
   *     the plain resend is safe (it is delivered into it, or is a no-op); on an idle session the
   *     resend carries `resume:false` (admitted, nothing started), and the execution is started (one
   *     more plain post of the same id) only once a lookup shows the id absent from the delivered
   *     messages. If that lookup cannot tell either, the send fails rather than risk a second run.
   */
  async function sendUserMessage(c: OpencodeClient, sid: string, text: string): Promise<string> {
    const sentAt = Date.now();
    const id = newOpencodeMessageId();
    const body: PromptBody = { id, text, delivery: "steer" };
    try {
      await c.prompt(sid, body);
      return id;
    } catch (e) {
      if (!(httpStatus(e) === 0 && (e as { tag?: unknown }).tag === "Timeout")) throw e;
    }
    const seen = await lookupMessage(c, sid, id, sentAt);
    if (seen === "present") return id;
    if (seen === "absent") {
      await c.prompt(sid, body);
      return id;
    }
    let idle = true; // can't tell: take the path that never starts an execution by itself
    try {
      idle = (await c.activeSessions())[sid] === undefined;
    } catch {
      /* as above */
    }
    if (!idle) {
      await c.prompt(sid, body);
      return id;
    }
    const parkOnly: PromptBody = { ...body, resume: false };
    await c.prompt(sid, parkOnly);
    const after = await lookupMessage(c, sid, id, sentAt);
    if (after === "present") return id; // it had landed and run: nothing to start
    if (after === "absent") {
      await c.prompt(sid, body); // admitted, not run yet: this post schedules the execution that delivers it
      return id;
    }
    throw new Error("couldn't tell whether OpenCode received the message");
  }

  /**
   * Whether the session's delivered messages include `id`: `present`, `absent` (read back to an `idle`
   * marker older than the send, or to the start of the history), or `unknown`. A failed read is retried
   * a few times with a growing pause.
   */
  async function lookupMessage(c: OpencodeClient, sid: string, id: string, sinceMs: number): Promise<"present" | "absent" | "unknown"> {
    for (let attempt = 1; attempt <= LANDED_LOOKUP_ATTEMPTS; attempt++) {
      try {
        const r = await scanMessages(c, sid, sinceMs, new Set([id]));
        if (r.found.has(id)) return "present";
        return r.complete ? "absent" : "unknown";
      } catch {
        if (attempt < LANDED_LOOKUP_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, timings.lookupRetryMs * attempt));
      }
    }
    return "unknown";
  }

  /**
   * Read the session's messages newest first until every wanted id is found, or an `idle` marker
   * created before `sinceMs` is reached (a message delivered after `sinceMs` is listed after it), or the
   * history ends. `complete` is false when the page cap stopped the read first. Throws on a failed read.
   */
  async function scanMessages(c: OpencodeClient, sid: string, sinceMs: number, want: ReadonlySet<string>): Promise<{ found: Set<string>; complete: boolean }> {
    const found = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < LANDED_LOOKUP_MAX_PAGES; page++) {
      const r = await c.listMessages(sid, cursor ? { limit: LANDED_LOOKUP_LIMIT, cursor } : { limit: LANDED_LOOKUP_LIMIT, order: "desc" });
      for (const m of r.data) {
        if (!isRec(m)) continue;
        const mid = str(m.id);
        if (mid && want.has(mid)) {
          found.add(mid);
          if (found.size === want.size) return { found, complete: true };
        }
        if (m.type === "idle" && messageTime(m) < sinceMs) return { found, complete: true };
      }
      const next = r.cursor?.next;
      if (!next || next === cursor || r.data.length === 0) return { found, complete: true };
      cursor = next;
      await yieldTick();
    }
    return { found, complete: false };
  }

  /** Steers run one at a time, in call order: OpenCode delivers them in the order its POSTs land. */
  let steerChain: Promise<unknown> = Promise.resolve();
  function steer(text: string): Promise<"accepted" | "unavailable"> {
    const next = steerChain.then(() => steerNow(text));
    steerChain = next.catch(() => {});
    return next;
  }

  async function steerNow(text: string): Promise<"accepted" | "unavailable"> {
    if (!steerable && start.kind === "spawn" && !inactive() && !killed) {
      // The initial prompt is POSTed first: wait (bounded) for it to return, then send in order.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timings.steerWaitMs);
        (timer as unknown as { unref?: () => void }).unref?.();
        steerWaiters.add(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (inactive() || killed || !client || !sessionId || !steerable) return "unavailable";
    try {
      const sentAt = Date.now();
      steered.push({ id: await sendUserMessage(client, sessionId, text), text, sentAt });
    } catch {
      return "unavailable";
    }
    activity();
    return "accepted";
  }

  function detach(): void {
    if (detached) return;
    if (settled) {
      // A lingering handle stops following its children silently: no interrupt, and its open cards
      // stay unresolved in the registry for whoever re-lists the server's requests next (the next
      // core's linger or turn). Settled and not lingering: nothing left to stop.
      if (!lingerOn) return;
      detached = true;
      lingerOn = false;
      if (lingerTimer) clearTimeout(lingerTimer);
      lingerTimer = null;
      unsubscribeHub();
      openPerms.clear();
      openForms.clear();
      return;
    }
    detached = true;
    clearTimers();
    unsubscribeHub();
    buffer = [];
    wakeSteerWaiters();
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    try {
      clearTimers();
      const c = stopClient;
      const sid = sessionId;
      if (c && sid && (lingerOn || !settled)) {
        try {
          const active = await c.activeSessions();
          if (active[sid] !== undefined) await c.interrupt(sid);
        } catch {
          /* best effort: the server may already be gone */
        }
        await interruptChildren();
      }
      if (lingerOn) leaveLinger();
      settle(130);
      unsubscribeHub();
      closeOpenCards(false);
    } catch (e) {
      console.error("[opencode-driver] dispose failed:", e);
    }
  }

  /* ── start ────────────────────────────────────────────────────────────── */

  /** `ensureServer` bounded by this turn's own deadline (a wedged tmux or `ps` must not hold the turn forever). */
  function ensureWithDeadline(): Promise<Awaited<ReturnType<OpencodeDriverDeps["ensureServer"]>>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no answer within ${Math.round(timings.connectMs / 1000)} s`)),
        timings.connectMs,
      );
      (timer as unknown as { unref?: () => void }).unref?.();
      let started: Promise<Awaited<ReturnType<OpencodeDriverDeps["ensureServer"]>>>;
      try {
        started = deps.ensureServer({ harnessId, bin: a.bin, env: a.env, cwd: a.serverCwd, isBusy: a.isBusy });
      } catch (e) {
        clearTimeout(timer);
        reject(e);
        return;
      }
      started.then(
        (h) => {
          clearTimeout(timer);
          resolve(h);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  async function connect(): Promise<OpencodeServerRef | null> {
    activity();
    let handle;
    try {
      handle = await ensureWithDeadline();
    } catch (e) {
      status(`couldn't start the OpenCode server: ${errText(e)}`);
      if (settled) {
        // A boot linger that can't reach its server: the rows it was to follow would hold the task (K2).
        if (start.kind === "linger" && lingerOn) orphanChildren();
        leaveLinger();
      } else settle(killed ? 130 : 1);
      return null;
    }
    if (detached || disposed || (settled && !lingerOn)) return null;
    activity();
    if (handle.stale) status(OPENCODE_STALE_SERVER_STATUS);
    serverEpoch = handle.startedAt;
    const ref: OpencodeServerRef = { url: handle.url, password: handle.password };
    client = deps.createClient(ref, timings.requestMs !== undefined ? { timeoutMs: timings.requestMs } : {});
    stopClient = deps.createClient(ref, { timeoutMs: timings.interruptTimeoutMs });
    // A Stop that arrived while we were connecting (an attach: the execution is already running).
    if (killed && start.kind === "attach") background(requestInterrupt());
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
    // The turn's model picks the right quota hint for a 402 (only an OpenCode Zen model gets one).
    mapper = createOpencodeEventMapper({ sessionId: sid, model: a.model });
    // A variable, not a literal: `epoch` is optional on the hub's server param.
    const server = { key: harnessId, ...ref, ...(serverEpoch !== undefined ? { epoch: serverEpoch } : {}) };
    const sub = subscribeOpencodeSession(server, sid, {
      onEvent: onHubEvent,
      onResync: (owned) => {
        lastOwned = owned ?? [];
        if (settled) {
          if (lingerOn) background(lingerResync());
          return;
        }
        background(requestCatchUp());
      },
      onServerLost: (err) => {
        serverLost = true;
        noteOpencodeServerLost(harnessId);
        if (settled && lingerOn) {
          // The children this handle followed will be heard of no more: their rows must not stay `running` (K2).
          orphanChildren();
          lingerOn = false;
          if (lingerTimer) clearTimeout(lingerTimer);
          lingerTimer = null;
          subscription = null; // the hub already dropped us
          closeOpenCards(false);
          return;
        }
        if (inactive()) return;
        status(`${OPENCODE_SERVER_LOST_STATUS_PREFIX}${err ? `: ${errText(err)}` : ""}`);
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
      status(opencodeResumeFailedStatusLine(s.resumeSessionId));
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
    // A task whose model went back to the default (`modelRef` null) leaves the session's model as it is and
    // says nothing: OpenCode has no "unset", and the session's own choice is a valid default.
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
    // A request a previous (lingering) driver closed without replying gets its card again.
    refreshOwned();
    // Children of an earlier turn whose subagent row is still open: follow them (and linger for them).
    const open = new Set(deps.openChildSessions(taskId));
    for (const o of lastOwned) {
      if (o.isChild && open.has(o.sessionId)) ensureChild(o.sessionId, o.childOf ?? sid, o.depth, { background: true });
    }
    await relistCards(c);
    if (inactive()) return;
    // Only the ones the server says are executing (or, when it can't say, that hold a card the re-list
    // just raised) may hold this turn lingering: a crash's orphans may not.
    await confirmAdopted(c, true);
    if (inactive()) return;
    promptSent = true; // set with the call below: no await between the checks above and the send
    try {
      ourMessageId = await sendUserMessage(c, sid, s.prompt);
    } catch (e) {
      if (!inactive()) {
        status(`OpenCode didn't accept the message: ${errText(e)}`);
        settle(killed ? 130 : 1);
      }
      return;
    }
    steerable = true;
    wakeSteerWaiters();
    if (deliveredIds.has(ourMessageId)) {
      markDelivered();
      // The execution may have ended before the POST answered; its terminal was held back until now.
      onRootTerminal();
    }
    startLiveness();
    // A Stop that landed while the prompt was in flight.
    if (killed && !settled) background(requestInterrupt());
  }

  function refreshOwned(): void {
    if (!sessionId) return;
    try {
      lastOwned = opencodeOwnedSessions(harnessId, sessionId);
    } catch {
      lastOwned = [];
    }
  }

  async function runLinger(s: Extract<StartSpec, { kind: "linger" }>): Promise<void> {
    lingerTimer = setTimeout(lingerExpired, timings.lingerMaxMs);
    (lingerTimer as unknown as { unref?: () => void }).unref?.();
    const ref = await connect();
    if (!ref || !client) return;
    const c = client;
    try {
      await subscribe(ref, s.sessionId);
    } catch (e) {
      if (lingerOn) {
        status(`couldn't watch the OpenCode session: ${errText(e)}`);
        // Nothing will be heard of the rows this linger was to follow (K2).
        orphanChildren();
        leaveLinger();
      }
      return;
    }
    if (!lingerOn || !canAct()) return;
    refreshOwned();
    await relistAndSync(c);
    if (lingerOn && !hasUnsettledBackground()) leaveLinger();
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
    // The children the hub knows (a wake's background subagents, whose cards a lingering driver left
    // open for whoever drives the next execution): the catch-up re-lists and re-syncs them.
    refreshOwned();
    promptSent = true; // the execution is already running on the server
    await requestCatchUp();
    // Whatever the catch-up buffered is drained; live events flow from here.
    if (!inactive()) startLiveness();
  }

  const guardedRun = (p: Promise<void>): void => {
    p.catch((e) => {
      if (start.kind === "linger") {
        status(`OpenCode linger failed: ${errText(e)}`);
        leaveLinger();
        return;
      }
      if (inactive()) return;
      status(`OpenCode turn failed: ${errText(e)}`);
      settle(killed ? 130 : 1);
    });
  };
  if (start.kind === "spawn") guardedRun(runSpawn(start));
  else if (start.kind === "attach") guardedRun(runAttach(start));
  else guardedRun(runLinger(start));

  return {
    kill,
    writeInput: () => false,
    done,
    steer,
    sessionId: () => sessionId,
    detach,
    lingering: () => lingerOn,
    dispose,
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

/**
 * A lingering-only handle for a run that settled before an agetor restart, with background subagents
 * possibly still running (the orchestrator calls it at boot for a held `server=agetor` task). `done`
 * resolves 0 at once. The handle then follows the task's open child rows exactly like a settled turn:
 * it syncs the task's running or orphaned child rows, re-raises their cards, ingests and settles
 * their events, and leaves when they have settled, on the root's next execution, on `dispose()` or after 24 h.
 */
export function attachOpencodeServerLinger(a: OpencodeServerLingerArgs): OpencodeServerTurn {
  return createTurn(a, { kind: "linger", sessionId: a.sessionId });
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
  /** Close a card the way another driver of this module does (noted, so an awaiting driver re-raises it). */
  closeCardAsDriver(taskId: string, ids: { requestId?: string; formId?: string }): void {
    if (ids.requestId !== undefined) closeCardAsDriver(taskId, "permission", ids.requestId);
    if (ids.formId !== undefined) closeCardAsDriver(taskId, "form", ids.formId);
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

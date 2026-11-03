/**
 * OpenCode 2.x on the agetor-owned server: the orchestrator's half
 * (docs/plans/opencode-server-driver.md, T11; docs/architecture/harness-opencode.md).
 *
 * The driver (opencode-driver.ts) owns the turn; this module is the part that
 * needs the orchestrator's run state: which server turns this core is driving
 * and the handles still lingering for background subagents, steering a message
 * into a running turn, the wake of a session the server runs on its own (D7,
 * R3, R4), boot reattach and linger, the server's idle sweep and quit stop (D6)
 * and its busy gate (I3). Everything it needs from `orchestrator.ts` comes in
 * through {@link initOpencodeServerOrchestrator}'s deps object, so this file
 * never imports the orchestrator.
 */
import { randomUUID } from "node:crypto";
import type { AppendedEvent } from "./db.ts";
import { harnesses, runs, subagents, tasks } from "./db.ts";
import type { AgentKind, ColumnId, GlobalEvent, Harness, RunEvent, Task } from "../shared/types.ts";
import type { OpencodeTransport } from "../shared/opencode.ts";
import {
  attachOpencodeServerAgent,
  opencodeServerTurnOf,
  opencodeTransportOfTurn,
  type SpawnAgentArgs,
  type SpawnedAgent,
} from "./agents.ts";
import { peekCachedCliVersion } from "./agent-status.ts";
import { cancelPendingForTask, pendingCountsByTask } from "./interactions.ts";
import { wasOpencodeChildStoppedByAgetor, type OpencodeServerTurn } from "./opencode-driver.ts";
import {
  classifyOpencodeServer,
  getOpencodeServer,
  opencodeIdleSweep,
  stopIdleOpencodeServersSync,
} from "./opencode-server.ts";
import {
  closeOpencodeHub,
  setOpencodeWakeHandler,
  setOpencodeWatchLostHandler,
  watchOpencodeSessionsForWake,
  type OpencodeWakeTrigger,
} from "./opencode-hub.ts";
import { createOpencodeClient, type OpencodeEnvelope } from "./opencode-http.ts";
import { listOpenOpencodeChildSessions, ORPHAN_RECHECK_MAX_AGE_MS, opencodeTurnOfRun } from "./opencode-subagents.ts";

/** A chunk sink for one run, as `makeChunkHandler` builds it. */
type ChunkHandler = (stream: RunEvent["stream"], data: string, lineUuid?: string) => void;

/** The part of an orchestrator `active` entry this module reads (and flags cancelled). */
interface OpencodeActiveRun {
  taskId: string;
  cancelled: boolean;
}

/** What this module borrows from `orchestrator.ts` (its private run state and helpers). */
export interface OpencodeServerOrchestratorDeps {
  /** runId -> the live run handles (`active`). Read, and `cancelled` flagged on a Stop. */
  active: ReadonlyMap<string, OpencodeActiveRun>;
  /** Tasks with a start or send in flight (`startingTaskIds`); a wake claims it too. */
  startingTaskIds: Set<string>;
  releaseStartingClaim(taskId: string): void;
  /** True once this process is exiting (`freezeLaunches`). */
  launchesFrozen(): boolean;
  isTaskTearingDown(taskId: string): boolean;
  resolveHarness(harnessId: string): Harness | null;
  taskHarnessId(task: Pick<Task, "agent">): string;
  findLastSessionIdForHarness(taskId: string, column: "opencode_session_id", harnessId: string): string | null;
  makeChunkHandler(runId: string, taskId: string, kind: AgentKind, mode: Task["mode"]): ChunkHandler;
  registerActiveRun(runId: string, taskId: string, task: Task, agent: SpawnedAgent): void;
  attachDoneHandler(runId: string, taskId: string, agent: SpawnedAgent): void;
  consumePendingCancel(
    runId: string,
    taskId: string,
    agent: SpawnedAgent,
    onChunk: (stream: "status", data: string) => void,
    opts: { dropClaudeSession: boolean },
  ): Promise<boolean>;
  adoptPendingTaskCancel(taskId: string, runId: string): boolean;
  emit(e: RunEvent): void;
  emitGlobal(e: GlobalEvent): void;
  saveAndEmit(args: { runId: string; taskId: string; stream: RunEvent["stream"]; data: string }): AppendedEvent | null;
  saveStatusLineQuietly(runId: string, taskId: string, data: string): AppendedEvent | null;
  normalizeUserText(s: string): string;
  /** `spawnOpencodeTurnNow`: a new resume turn for `line` (`alreadyEchoed`: its bubble is on another run). */
  spawnFollowUpTurn(task: Task, taskId: string, line: string, alreadyEchoed: boolean): Promise<string | null>;
  /** taskId -> follow-ups for the next OpenCode turn (`opencodeTurnQueue`). */
  followUpQueue: Map<string, string[]>;
  isPipelineStepTaskId(taskId: string): boolean;
  stashQueuedFollowUpsOfStoppedStep(taskId: string, runId: string): void;
  opencodeTurnBreadcrumb(harness: Harness, task: Task, cliVersion: string | null, transport?: OpencodeTransport): string;
}

let deps!: OpencodeServerOrchestratorDeps;

/** Called once by `orchestrator.ts` at module load, before anything here runs. */
export function initOpencodeServerOrchestrator(d: OpencodeServerOrchestratorDeps): void {
  deps = d;
}

export interface OpencodeServerRun {
  taskId: string;
  harnessId: string;
  turn: OpencodeServerTurn;
}

/** runId -> the server-transport turn this core is driving. Entered when the turn registers, left by its done handler. */
const opencodeServerTurns = new Map<string, OpencodeServerRun>();

/**
 * After a server turn settles the driver may stay subscribed (child-only) while
 * background subagents it started are unsettled, answering their permissions
 * and raising their cards, until the root's next execution starts or the
 * children settle (`turn.lingering()`). `turn.dispose()` ends that.
 */
/** taskId -> settled-but-lingering turns. Not in `active`, so the task does not read as running. */
const lingeringOpencodeTurns = new Map<string, OpencodeServerRun[]>();

/** After a steer the server could not take: the line goes to the next turn. */
const OPENCODE_STEER_QUEUED_STATUS = "couldn't deliver to the running OpenCode turn — sending it next";

/** Stop: how long a delete/archive/agent switch waits for the driver to settle (it confirms or gives up within 10 s). */
const OPENCODE_SERVER_STOP_WAIT_MS = 12_000;

/** How often the idle sweep looks at the servers, and the budget of its "is anything executing" probe. */
const OPENCODE_SWEEP_INTERVAL_MS = 60_000;
const OPENCODE_ACTIVE_PROBE_MS = 5_000;

export function trackOpencodeServerTurn(runId: string, taskId: string, task: Task, agent: SpawnedAgent): void {
  const turn = opencodeServerTurnOf(agent);
  if (!turn) return;
  // The run's own harness: the turn runs on that harness's server even if the
  // task has been pointed at another one since.
  opencodeServerTurns.set(runId, { taskId, harnessId: deps.taskHarnessId(runs.get(runId) ?? task), turn });
  scheduleOpencodeWatchRefresh();
}

/** Called by the run's done handler. True when the run was a server-transport turn. */
export function forgetOpencodeServerTurn(runId: string): boolean {
  const entry = opencodeServerTurns.get(runId);
  if (!entry) return false;
  opencodeServerTurns.delete(runId);
  if (entry.turn.lingering()) {
    lingeringOpencodeTurns.set(entry.taskId, [...(lingeringOpencodeTurns.get(entry.taskId) ?? []), entry]);
  } else {
    noteOpencodeHarnessSettled(entry.harnessId);
  }
  scheduleOpencodeWatchRefresh();
  return true;
}

/** The task's handles that are still lingering; the ones that ended on their own are dropped. */
export function liveLingeringOpencodeTurns(taskId: string): OpencodeServerRun[] {
  const all = lingeringOpencodeTurns.get(taskId);
  if (!all) return [];
  const live = all.filter((e) => e.turn.lingering());
  if (live.length === 0) lingeringOpencodeTurns.delete(taskId);
  else if (live.length !== all.length) lingeringOpencodeTurns.set(taskId, live);
  for (const e of all) if (!live.includes(e)) noteOpencodeHarnessSettled(e.harnessId);
  return live;
}

/** End the task's lingering handles (delete, archive, agent switch, Stop with no run active). Bounded; never throws. */
export async function disposeLingeringOpencodeTurns(taskId: string): Promise<void> {
  const entries = lingeringOpencodeTurns.get(taskId);
  lingeringOpencodeTurns.delete(taskId);
  if (!entries || entries.length === 0) return;
  for (const e of entries) noteOpencodeHarnessSettled(e.harnessId);
  await Promise.all(
    entries.map((e) =>
      boundedOpencodeWait(e.turn.dispose().catch(() => undefined), OPENCODE_SERVER_STOP_WAIT_MS),
    ),
  );
}

function boundedOpencodeWait(p: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    p,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      (timer as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
}

/** True while this core drives a server-transport turn of the task. */
export function hasOpencodeServerTurn(taskId: string): boolean {
  for (const t of opencodeServerTurns.values()) if (t.taskId === taskId) return true;
  return false;
}

/**
 * The server-restart gate and the idle gate (I3): a harness's server is busy
 * while a server-transport turn of one of its tasks is live here (or a settled
 * one still lingers for background subagents), or any task on that harness has
 * a card open (a permission or question waits on the server holding the
 * request). `exceptRunId` leaves the asking turn itself out, so the restart
 * gate of its own `ensure` doesn't count the turn that is only starting.
 */
function opencodeHarnessBusy(harnessId: string, opts: { exceptRunId?: string } = {}): boolean {
  for (const [runId, t] of opencodeServerTurns) {
    if (t.harnessId === harnessId && runId !== opts.exceptRunId) return true;
  }
  for (const taskId of [...lingeringOpencodeTurns.keys()]) {
    if (liveLingeringOpencodeTurns(taskId).some((e) => e.harnessId === harnessId)) return true;
  }
  for (const [taskId, n] of pendingCountsByTask()) {
    if (n <= 0) continue;
    const task = tasks.get(taskId);
    if (task && deps.taskHarnessId(task) === harnessId) return true;
  }
  return false;
}

/** Overwrite a persisted tool_use whose name the mapper learned late, and re-broadcast it under its own row id. */
function replaceMainEvent(runId: string, taskId: string, lineUuid: string, data: string): void {
  try {
    if (!runs.replaceMainEventDataByLineUuid(runId, lineUuid, data)) return;
    const callId = (JSON.parse(data) as { id?: unknown } | null)?.id;
    const hit = typeof callId === "string" ? runs.findToolUseEvent(runId, callId) : null;
    if (hit) deps.emit({ id: hit.id, runId, taskId, stream: "tool_use", data, ts: Date.now() });
  } catch (err) {
    console.warn(`[agetor] opencode: couldn't replace event ${lineUuid} of run ${runId}:`, err);
  }
}

/**
 * How a driver turn came to be: a fresh prompt (`spawn`), or joining an
 * execution that is already running on the server (`attach`: a boot reattach,
 * a server wake, a boot linger for background subagents).
 */
export type OpencodeTurnJoin = "spawn" | "attach";

export function opencodeTurnHooksFor(
  harnessId: string,
  runId: string,
  taskId: string,
  join: OpencodeTurnJoin,
): NonNullable<SpawnAgentArgs["opencodeTurnHooks"]> {
  return {
    // The server's restart gate (I3). Only a fresh spawn leaves itself out: its
    // prompt has not reached the server yet, so a stale-settings restart of an
    // otherwise idle server loses nothing. An attach joins an execution the
    // server is running right now: restarting under it would kill that very
    // turn, so the gate is always closed for it.
    isBusy: () => (join === "spawn" ? opencodeHarnessBusy(harnessId, { exceptRunId: runId }) : true),
    onReplace: (lineUuid, data) => replaceMainEvent(runId, taskId, lineUuid, data),
    // Another client interrupted the root turn (not agetor): the run reads as
    // cancelled (task to ready, no failure), like a Stop here.
    onUserStop: () => {
      const handle = deps.active.get(runId);
      if (handle) handle.cancelled = true;
      deferredOpencodeWakes.delete(taskId);
    },
  };
}

/** A task whose last turn ran on the agetor-owned server (breadcrumb `server=agetor`). */
export function isOpencodeServerTask(taskId: string): boolean {
  const task = tasks.get(taskId);
  if (!task || deps.resolveHarness(task.agent)?.kind !== "opencode") return false;
  return opencodeTurnOfRun(task.runId)?.server === "agetor";
}

/**
 * A message sent while a server-transport turn runs: the user bubble goes on
 * the active run and the text is steered into the turn (no new run, no queue
 * entry). When the server can't take it (unreachable, the turn ending, an
 * earlier message already waiting in the queue, or a Stop in progress) it
 * queues for the next turn like `opencode run` does, with a status line saying
 * so. A turn that ended while the steer was in flight starts the message as
 * its own turn at once, since nothing would drain a queue for it.
 */
export async function steerOpencodeServerTurn(
  taskId: string,
  runId: string,
  turn: OpencodeServerTurn,
  line: string,
): Promise<string | null> {
  const queueEmpty = (deps.followUpQueue.get(taskId)?.length ?? 0) === 0;
  const stopping = deps.active.get(runId)?.cancelled === true;
  deps.saveAndEmit({ runId, taskId, stream: "user", data: deps.normalizeUserText(line) });
  let outcome: "accepted" | "unavailable" = "unavailable";
  const attempted = queueEmpty && !stopping;
  if (attempted) {
    try {
      outcome = await turn.steer(line);
    } catch (err) {
      console.warn(`[agetor] opencode steer failed for task ${taskId}:`, err);
    }
  }
  if (outcome === "accepted") return runId;
  if (attempted) deps.saveStatusLineQuietly(runId, taskId, OPENCODE_STEER_QUEUED_STATUS);
  const queue = (): void => {
    const q = deps.followUpQueue.get(taskId) ?? [];
    q.push(line);
    deps.followUpQueue.set(taskId, q);
  };
  const task = tasks.get(taskId);
  if (!task) return runId;
  // Still live (a Stop may be settling it): its done handler routes the queue —
  // into the backlog on a stopped pipeline step, else into the next turn.
  if (deps.active.has(runId)) {
    queue();
    return runId;
  }
  // Settled while the steer was in flight (it can wait up to ~20 s for the
  // turn's first prompt): its done handler has run, so route the line the way
  // it would have. The Stop is read afresh: one that landed during the wait
  // counts as much as one already in progress.
  const stoppedNow = stopping || runs.get(runId)?.status === "cancelled";
  if (stoppedNow && deps.isPipelineStepTaskId(taskId)) {
    // Nothing may run on a stopped step's behalf (`drainFollowUpQueues`).
    queue();
    deps.stashQueuedFollowUpsOfStoppedStep(taskId, runId);
    return runId;
  }
  // Nothing would drain a queue for this line: start it as its own turn,
  // unless another run of the task (or a start in flight) took over meanwhile:
  // that one drains the queue when it settles.
  const taken = deps.startingTaskIds.has(taskId) || [...deps.active.values()].some((h) => h.taskId === taskId);
  if (!taken) {
    const next = await deps.spawnFollowUpTurn(task, taskId, line, true);
    return next ?? runId;
  }
  queue();
  return runId;
}

/** Stop every server-transport turn of the task and cancel its open cards; never waits past the driver's own confirm window. */
export async function stopOpencodeServerTurnsOfTask(taskId: string, reason: string): Promise<void> {
  deferredOpencodeWakes.delete(taskId);
  const mine = [...opencodeServerTurns].filter(([, t]) => t.taskId === taskId);
  if (mine.length > 0) {
    for (const [runId] of mine) {
      const handle = deps.active.get(runId);
      if (handle) handle.cancelled = true;
    }
    cancelPendingForTask(taskId, reason);
    for (const [, t] of mine) t.turn.kill();
    await Promise.all(mine.map(([, t]) => boundedOpencodeWait(t.turn.done.catch(() => 0), OPENCODE_SERVER_STOP_WAIT_MS)));
  }
  await disposeLingeringOpencodeTurns(taskId);
}

/* ── Boot reattach ─────────────────────────────────────────────────────── */

/**
 * Reattach to a server-transport turn that was running when agetor stopped
 * (boot reconcile). The server lives in its own tmux session and keeps the
 * turn going, so this joins it: null (→ the run is orphaned) when no server
 * was adopted for the harness or it no longer has the session (`probe`, taken
 * for all runs at once by {@link probeOpencodeSessionsAtBoot}). An unreachable
 * server is not "gone": the driver tries and settles the run `failed` with a
 * status line if it can't.
 */
export function reattachOpencodeServerRun(
  row: { id: string; task_id: string; agent: string; opencode_session_id: string; started_at: number },
  task: Task,
  onChunk: ChunkHandler,
  probe: SessionProbe,
): SpawnedAgent | null {
  const harness = deps.resolveHarness(row.agent);
  if (!harness || harness.kind !== "opencode") return null;
  if (!getOpencodeServer(harness.id) || probe === "gone") return null;
  return attachOpencodeServerAgent({
    taskId: row.task_id,
    runId: row.id,
    harness,
    cwd: task.worktreePath ?? task.workdir,
    task,
    sessionId: row.opencode_session_id,
    sinceMs: row.started_at,
    reason: "reattach",
    onChunk,
    hooks: opencodeTurnHooksFor(harness.id, row.id, row.task_id, "attach"),
  });
}

/** Whether an adopted server still has a session: `unknown` when it could not be asked in time. */
export type SessionProbe = "ok" | "gone" | "unknown";

const OPENCODE_BOOT_PROBE_MS = 5_000;

/**
 * Ask the adopted servers about many sessions at once, under one overall
 * budget (a slow server must not hold the boot for every run in turn). A
 * missing server or a 404 is `gone`; an answer is `ok`; no answer in time or a
 * failure is `unknown`.
 */
export async function probeOpencodeSessionsAtBoot(
  items: { key: string; harnessId: string; sessionId: string }[],
): Promise<Map<string, SessionProbe>> {
  const out = new Map<string, SessionProbe>();
  if (items.length === 0) return out;
  const all = Promise.all(
    items.map(async (it) => {
      const server = getOpencodeServer(it.harnessId);
      if (!server) {
        out.set(it.key, "gone");
        return;
      }
      try {
        const session = await createOpencodeClient(server, { timeoutMs: OPENCODE_BOOT_PROBE_MS }).getSession(it.sessionId);
        out.set(it.key, session === null ? "gone" : "ok");
      } catch {
        out.set(it.key, "unknown");
      }
    }),
  );
  await boundedOpencodeWait(all, OPENCODE_BOOT_PROBE_MS + 500);
  return out;
}

/**
 * Tasks to listen for again at boot: on the agetor-owned server, last turn over
 * (no run of theirs is `running`), with OpenCode child sessions still worth
 * following (`listOpenOpencodeChildSessions`: rows `running`, or `orphaned`
 * within `ORPHAN_RECHECK_MAX_AGE_MS` — a restart or a hand-over left them). An
 * older orphan is never a reason to listen, or the linger would keep the
 * server alive on every boot.
 */
export function opencodeLingerCandidates(
  runningTaskIds: string[],
  now: number = Date.now(),
): { taskId: string; runId: string; harnessId: string; sessionId: string }[] {
  const ids = new Set<string>([
    ...subagents.taskIdsWithRunning(),
    ...subagents.opencodeOrphanedTaskIdsSince(now - ORPHAN_RECHECK_MAX_AGE_MS),
  ]);
  const live = new Set(runningTaskIds);
  const out: { taskId: string; runId: string; harnessId: string; sessionId: string }[] = [];
  for (const taskId of ids) {
    if (live.has(taskId)) continue;
    if (listOpenOpencodeChildSessions(taskId, now).length === 0) continue;
    const task = tasks.get(taskId);
    const harness = task && task.archivedAt == null ? deps.resolveHarness(task.agent) : null;
    if (!task || !harness || harness.kind !== "opencode") continue;
    const last = runs.listForTask(taskId)[0];
    if (!last?.opencodeSessionId || opencodeTurnOfRun(last.id)?.server !== "agetor") continue;
    out.push({ taskId, runId: last.id, harnessId: harness.id, sessionId: last.opencodeSessionId });
  }
  return out;
}

/* ── Server wake (D7) ──────────────────────────────────────────────────── */

/** harness id -> OpenCode session id -> task id: the sessions the hub watches for an execution the server starts by itself. */
let opencodeWakeTargets = new Map<string, Map<string, string>>();
let opencodeDriverStarted = false;
let opencodeWatchScheduled = false;
let opencodeWatchRefreshing = false;
let opencodeWatchDirty = false;
let opencodeSweepTimer: ReturnType<typeof setInterval> | null = null;
let opencodeSweepInFlight = false;

/** A wake the orchestrator could not act on because the task's own turn was still settling; retried once that turn is done. */
const deferredOpencodeWakes = new Map<
  string,
  { serverKey: string; sessionId: string; envelope: OpencodeEnvelope; trigger?: OpencodeWakeTrigger }
>();

const WAKE_SLICE_MS = 15;

/**
 * Recompute what the hub watches (D7): the session of every non-archived
 * task on an OpenCode harness whose last run recorded `server=agetor`. Cheap
 * to call; calls coalesce, and the work is sliced. A no-op before
 * `startOpencodeServerDriver()` (the wake handler is installed only after the
 * boot restore).
 */
export function scheduleOpencodeWatchRefresh(): void {
  if (!opencodeDriverStarted) return;
  if (opencodeWatchRefreshing) {
    opencodeWatchDirty = true;
    return;
  }
  if (opencodeWatchScheduled) return;
  opencodeWatchScheduled = true;
  setImmediate(() => {
    opencodeWatchScheduled = false;
    void runOpencodeWatchRefresh();
  });
}

async function runOpencodeWatchRefresh(): Promise<void> {
  opencodeWatchRefreshing = true;
  try {
    do {
      opencodeWatchDirty = false;
      await refreshOpencodeWatchesOnce();
    } while (opencodeWatchDirty && opencodeDriverStarted);
  } catch (err) {
    console.warn("[agetor] opencode: refreshing the wake watch failed:", err);
  } finally {
    opencodeWatchRefreshing = false;
  }
}

async function refreshOpencodeWatchesOnce(): Promise<void> {
  // The last run (any status) of every non-archived task that ever had an
  // OpenCode session, when it has one.
  const rows = runs.lastOpencodeSessionRunPerTask();
  const next = new Map<string, Map<string, string>>();
  let sliceStart = Date.now();
  for (const row of rows) {
    if (Date.now() - sliceStart > WAKE_SLICE_MS) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      sliceStart = Date.now();
      if (!opencodeDriverStarted) return;
    }
    const harness = deps.resolveHarness(row.agent);
    if (!harness || harness.kind !== "opencode") continue;
    if (opencodeTurnOfRun(row.runId)?.server !== "agetor") continue;
    let sessions = next.get(harness.id);
    if (!sessions) next.set(harness.id, (sessions = new Map()));
    sessions.set(row.sessionId, row.taskId);
  }
  const previous = opencodeWakeTargets;
  opencodeWakeTargets = next;
  for (const harnessId of new Set([...previous.keys(), ...next.keys()])) {
    const server = getOpencodeServer(harnessId);
    // No server: nothing to watch. Every turn that starts one schedules a refresh again.
    if (!server) continue;
    watchOpencodeSessionsForWake(
      harnessId,
      { url: server.url, password: server.password, epoch: server.startedAt },
      [...(next.get(harnessId)?.keys() ?? [])],
    );
  }
}

type OpencodeWakeDecision =
  | { kind: "go"; taskId: string; task: Task; harness: Harness }
  | { kind: "defer"; taskId: string }
  /** Nothing to do: not a session of ours, the process is exiting, or the execution is the one a Stop is interrupting. */
  | { kind: "refuse" }
  /** The session's task has no card to pull back (gone, archived, tearing down, moved to another harness, transport or session): stop the execution instead. */
  | { kind: "interrupt"; taskId: string };

/** How long the interrupt of an execution with no card waits for the server. */
const OPENCODE_WAKE_INTERRUPT_MS = 5_000;

/**
 * The checks a wake shares before and after the claim: whether the task a
 * watched session belongs to can still take a run on this server. The task
 * and its harness when it can; `"interrupt"` when it has no card to pull back.
 */
function opencodeWakeBlocker(
  serverKey: string,
  sessionId: string,
  taskId: string,
): { task: Task; harness: Harness } | "interrupt" {
  const task = tasks.get(taskId);
  if (!task || task.archivedAt != null || deps.isTaskTearingDown(taskId)) return "interrupt";
  const harness = deps.resolveHarness(task.agent);
  if (!harness || harness.kind !== "opencode" || harness.id !== serverKey || !harness.enabled) return "interrupt";
  // The transport the harness's turns take now (an unknown version reads as
  // the server: only a known 1.x CLI or the kill switch says otherwise).
  if (opencodeTransportOfTurn(peekCachedCliVersion(harness)) !== "server") return "interrupt";
  if (deps.findLastSessionIdForHarness(taskId, "opencode_session_id", harness.id) !== sessionId) return "interrupt";
  return { task, harness };
}

/**
 * Whether the server's own execution on `sessionId` becomes a run now (plan
 * D7, R3). Every check is synchronous (the hub calls the wake handler on its
 * read path), and the caller claims the task before anything awaits. A wake is
 * never refused because the user stopped the task earlier or parked its card
 * (Done, Backlog, Blocked): the run pulls the card back to Running. It is
 * INTERRUPTED when the task has no card to pull back (gone, archived, tearing
 * down, moved to another harness, transport or session), so nothing runs
 * unattended. It is REFUSED only when the session is not one of ours or the
 * process is exiting; the execution the user's Stop of the live run is
 * interrupting is dropped by that Stop (see below), and the tail of a child
 * agetor stopped is interrupted (`isTailOfAgetorStop`, plan R4). It DEFERS
 * when a start is in flight or one of the task's own runs is still live,
 * settling or being stopped (the execution may be the tail of that turn: a
 * steer that raced its end).
 */
function decideOpencodeWake(serverKey: string, sessionId: string): OpencodeWakeDecision {
  if (deps.launchesFrozen()) return { kind: "refuse" };
  const taskId = opencodeWakeTargets.get(serverKey)?.get(sessionId);
  if (!taskId) return { kind: "refuse" };
  const ok = opencodeWakeBlocker(serverKey, sessionId, taskId);
  if (ok === "interrupt") return { kind: "interrupt", taskId };
  // A start or send holds the task: decide again when it releases the claim.
  if (deps.startingTaskIds.has(taskId)) return { kind: "defer", taskId };
  // The task's own turn is still live or settling. The execution is usually
  // that turn's tail (a steer that landed right after `execution.succeeded`, or
  // a background child's result starting the next one), and the hub fires this
  // in the same dispatch that settled the driver, before the done handler has
  // moved the run row. Wait for the settle, then decide again. That includes a
  // turn the user is stopping: the execution it was running is over once the
  // Stop has settled; one OpenCode started meanwhile (a message steered into
  // the stopped turn that it had not consumed yet) is new work, and the retry
  // makes it a run (plan R3). A wake already waiting when the Stop landed is
  // dropped by the Stop itself (`dropDeferredOpencodeWake`): that execution is
  // the one being interrupted.
  if (runs.listForTask(taskId).some((r) => r.status === "running")) return { kind: "defer", taskId };
  for (const handle of deps.active.values()) if (handle.taskId === taskId) return { kind: "defer", taskId };
  return { kind: "go", taskId, task: ok.task, harness: ok.harness };
}

/**
 * Stop an execution the server started on a session whose task has no card to
 * pull back. Bounded and best effort: a server that can't be asked keeps it,
 * and nothing here throws.
 */
function interruptOrphanOpencodeExecution(serverKey: string, sessionId: string, taskId: string | null): void {
  if (taskId !== null) deferredOpencodeWakes.delete(taskId);
  const server = getOpencodeServer(serverKey);
  if (!server) return;
  void createOpencodeClient(server, { timeoutMs: OPENCODE_WAKE_INTERRUPT_MS })
    .interrupt(sessionId)
    .catch((err) => console.warn(`[agetor] opencode: couldn't stop the execution of session ${sessionId} (task ${taskId}):`, err));
}

/**
 * The execution is only OpenCode reporting a background child that agetor
 * itself interrupted (a Stop, delete, archive or harness switch): it wakes the
 * parent with a synthetic `state="cancelled"` result (plan R4). That is the
 * tail of the user's Stop, not new work, so it never becomes a run.
 */
function isTailOfAgetorStop(trigger: OpencodeWakeTrigger | undefined): boolean {
  return (
    trigger?.source === "subagent"
    && trigger.state === "cancelled"
    && typeof trigger.childID === "string"
    && wasOpencodeChildStoppedByAgetor(trigger.childID)
  );
}

/** The hub's wake handler: OpenCode started an execution on a watched session no agetor turn is listening to. */
function onOpencodeServerWake(
  serverKey: string,
  sessionId: string,
  envelope: OpencodeEnvelope,
  trigger?: OpencodeWakeTrigger,
): void {
  try {
    if (isTailOfAgetorStop(trigger)) {
      // Interrupt it, unless a live turn of the task (not one being stopped)
      // is listening to the session: that turn's driver owns what runs there.
      const taskId = opencodeWakeTargets.get(serverKey)?.get(sessionId) ?? null;
      const liveTurn = taskId !== null && [...deps.active.values()].some((h) => h.taskId === taskId && !h.cancelled);
      if (!liveTurn) interruptOrphanOpencodeExecution(serverKey, sessionId, taskId);
      return;
    }
    const decision = decideOpencodeWake(serverKey, sessionId);
    if (decision.kind === "refuse") return;
    if (decision.kind === "interrupt") {
      interruptOrphanOpencodeExecution(serverKey, sessionId, decision.taskId);
      return;
    }
    if (decision.kind === "defer") {
      deferredOpencodeWakes.set(decision.taskId, { serverKey, sessionId, envelope, trigger });
      return;
    }
    // Claim in this same synchronous run: nothing between the checks above and
    // the claim awaits, so a concurrent start/send for the task sees it.
    const { taskId } = decision;
    deps.startingTaskIds.add(taskId);
    queueMicrotask(() => {
      mintOpencodeWakeRun(taskId, serverKey, sessionId, envelope)
        .catch((err) => console.warn(`[agetor] opencode: wake of task ${taskId} failed:`, err))
        .finally(() => deps.releaseStartingClaim(taskId));
    });
  } catch (err) {
    console.warn("[agetor] opencode: wake handler failed:", err);
  }
}

/** Mint the run for a server-started execution (`origin: "agent"`), pull the card to Running from any column, and attach the driver to it. */
async function mintOpencodeWakeRun(
  taskId: string,
  serverKey: string,
  sessionId: string,
  envelope: OpencodeEnvelope,
): Promise<void> {
  // The claim is held; re-check what could have changed since the handler ran.
  const decision = decideOpencodeWakeClaimed(serverKey, sessionId, taskId);
  if (decision === "interrupt") {
    interruptOrphanOpencodeExecution(serverKey, sessionId, taskId);
    return;
  }
  if (!decision) return;
  const { task, harness } = decision;
  const newRunId = randomUUID();
  const now = Date.now();
  runs.insert({
    id: newRunId,
    taskId,
    agent: task.agent,
    status: "running",
    startedAt: now,
    endedAt: null,
    exitCode: null,
    // The execution runs inside the server's own tmux session, not one of its own.
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    antigravitySessionId: null,
    opencodeSessionId: sessionId,
    origin: "agent",
  });
  const prevColumn: ColumnId = task.column;
  tasks.update(taskId, { column: "running", runId: newRunId });
  deps.adoptPendingTaskCancel(taskId, newRunId);
  if (prevColumn !== "running") {
    deps.emitGlobal({ kind: "column", taskId, runId: newRunId, column: "running", prev: prevColumn, ts: now });
  }
  const onChunk = deps.makeChunkHandler(newRunId, taskId, "opencode", task.mode);
  onChunk("status", deps.opencodeTurnBreadcrumb(harness, task, null, "server"));
  onChunk("status", "OpenCode continued this session on its own");
  const agent = attachOpencodeServerAgent({
    taskId,
    runId: newRunId,
    harness,
    cwd: task.worktreePath ?? task.workdir,
    task,
    sessionId,
    sinceMs: typeof envelope.created === "number" ? envelope.created : now,
    reason: "wake",
    onChunk,
    hooks: opencodeTurnHooksFor(harness.id, newRunId, taskId, "attach"),
  });
  if (await deps.consumePendingCancel(newRunId, taskId, agent, onChunk, { dropClaudeSession: false })) return;
  deps.registerActiveRun(newRunId, taskId, task, agent);
  deps.attachDoneHandler(newRunId, taskId, agent);
}

/**
 * {@link decideOpencodeWake} again once the claim is held: the start/send
 * guards now see our own claim, so it only re-checks what the claim does not
 * cover. Null: a run of the task took over (it listens to the session), or the
 * session is no longer watched for this task.
 */
function decideOpencodeWakeClaimed(
  serverKey: string,
  sessionId: string,
  taskId: string,
): { task: Task; harness: Harness } | "interrupt" | null {
  if (deps.launchesFrozen()) return null;
  if (opencodeWakeTargets.get(serverKey)?.get(sessionId) !== taskId) return null;
  const ok = opencodeWakeBlocker(serverKey, sessionId, taskId);
  if (ok === "interrupt") return "interrupt";
  if (runs.listForTask(taskId).some((r) => r.status === "running")) return null;
  for (const handle of deps.active.values()) if (handle.taskId === taskId) return null;
  return ok;
}

/**
 * After a server-transport run settled (its done handler finished, queue
 * drained): decide again on a wake that arrived while it was settling. The
 * gates run afresh, so a run the drain just started still defers it. After a
 * Stop too: only a wake seen after the Stop began is still waiting here (the
 * Stop drops older ones), and that is an execution OpenCode started after the
 * interrupt. The driver's attach catches up from the message snapshot since
 * the execution started, so an execution that already ended by now still
 * lands as a run with its reply.
 */
export function retryDeferredOpencodeWake(taskId: string): void {
  const wake = deferredOpencodeWakes.get(taskId);
  if (!wake) return;
  deferredOpencodeWakes.delete(taskId);
  const created = typeof wake.envelope.created === "number" ? wake.envelope.created : 0;
  const latest = runs.listForTask(taskId)[0];
  if (latest && latest.startedAt > created) {
    // A run began after the execution did (a drained queue turn took the same
    // message over): wake only if the server still has the session executing.
    void (async () => {
      const server = getOpencodeServer(wake.serverKey);
      if (!server) return;
      try {
        const running = await createOpencodeClient(server, { timeoutMs: OPENCODE_ACTIVE_PROBE_MS }).activeSessions();
        if (!(wake.sessionId in running)) return;
      } catch {
        return;
      }
      onOpencodeServerWake(wake.serverKey, wake.sessionId, wake.envelope, wake.trigger);
    })();
    return;
  }
  onOpencodeServerWake(wake.serverKey, wake.sessionId, wake.envelope, wake.trigger);
}

/* ── Server lifecycle (D6) ─────────────────────────────────────────────── */

/**
 * What the last look at each harness's server found, kept for a quit, which
 * cannot await a probe of its own: whether a session was executing (or the
 * server could not be asked: counted busy), and when that look STARTED.
 * `null` until the first probe: nothing is known, so a quit stops nothing.
 */
let lastOpencodeProbe: Map<string, { executing: boolean; at: number }> | null = null;

/**
 * When a server turn or lingering handle on a harness last ended here. A probe
 * that started before it saw that turn's own execution, so it no longer says
 * anything about the server (see {@link opencodeExecutingAtLastProbe}).
 */
const lastOpencodeSettleAt = new Map<string, number>();

/** Re-probes already scheduled after a settle, one per harness. */
const opencodeReprobing = new Set<string>();

/**
 * A server turn or lingering handle on `harnessId` ended: the last probe's
 * "executing" may only have been that turn, so it stops counting, and a fresh
 * look is taken in the background for the quit to use.
 */
function noteOpencodeHarnessSettled(harnessId: string, now: number = Date.now()): void {
  lastOpencodeSettleAt.set(harnessId, now);
  if (!opencodeDriverStarted || opencodeReprobing.has(harnessId)) return;
  opencodeReprobing.add(harnessId);
  setImmediate(() => {
    void probeOpencodeServer(harnessId, OPENCODE_ACTIVE_PROBE_MS)
      .then((executing) => {
        if (executing !== null && lastOpencodeProbe) lastOpencodeProbe.set(harnessId, executing);
      })
      .finally(() => opencodeReprobing.delete(harnessId));
  });
}

/**
 * Whether the last probe of a harness's server, taken after its last settle
 * here, saw something executing. A probe older than the settle is stale (it
 * may only have seen the turn that has ended since); no probe at all means
 * "not executing" once a first probe has run (a server started since then).
 */
function opencodeExecutingAtLastProbe(harnessId: string): boolean {
  const mark = lastOpencodeProbe?.get(harnessId);
  if (!mark?.executing) return false;
  return mark.at >= (lastOpencodeSettleAt.get(harnessId) ?? 0);
}

/**
 * One look at a harness's server: `{executing}` (an unreachable server counts
 * as executing) stamped with the time the look started, or null when the
 * harness has no server.
 */
async function probeOpencodeServer(
  harnessId: string,
  timeoutMs: number,
): Promise<{ executing: boolean; reachable: boolean; at: number } | null> {
  const server = getOpencodeServer(harnessId);
  if (!server) return null;
  const at = Date.now();
  try {
    const running = await createOpencodeClient(server, { timeoutMs }).activeSessions();
    return { executing: Object.keys(running).length > 0, reachable: true, at };
  } catch {
    return { executing: true, reachable: false, at };
  }
}

/** One look at every OpenCode harness's server, in parallel; recorded for the quit. */
async function probeOpencodeServers(timeoutMs: number): Promise<{ executing: Set<string>; unreachable: Set<string> }> {
  const out = { executing: new Set<string>(), unreachable: new Set<string>() };
  const marks = new Map<string, { executing: boolean; at: number }>();
  await Promise.all(
    harnesses
      .list()
      .filter((h) => h.kind === "opencode")
      .map(async (h) => {
        const probe = await probeOpencodeServer(h.id, timeoutMs);
        if (!probe) return;
        marks.set(h.id, { executing: probe.executing, at: probe.at });
        if (probe.executing) out.executing.add(h.id);
        if (!probe.reachable) out.unreachable.add(h.id);
      }),
  );
  lastOpencodeProbe = marks;
  return out;
}

/**
 * One idle sweep: stop the servers idle for 30 minutes unless a turn or card is
 * using them OR the server reports an executing session (a background subagent
 * may be running with no agetor run). The async probe runs first, so the
 * predicate `opencodeIdleSweep` takes stays synchronous. A server that can't be
 * asked anything is stopped and forgotten (so nothing keeps reconnecting to it)
 * only when the manager has positive proof it is dead (`classifyOpencodeServer`:
 * refused, a persistent 401, or its host gone; a timeout alone never is), and
 * then only through the same idle window, start guard and busy re-check as any
 * other stop. Each harness's hub stream closes right after its own stop.
 * Single-flight.
 */
export async function runOpencodeIdleSweep(now: number = Date.now()): Promise<string[]> {
  if (opencodeSweepInFlight) return [];
  opencodeSweepInFlight = true;
  try {
    const probe = await probeOpencodeServers(OPENCODE_ACTIVE_PROBE_MS);
    const stopped: string[] = [];
    for (const id of probe.unreachable) {
      if (opencodeHarnessBusy(id)) continue;
      if ((await classifyOpencodeServer(id, OPENCODE_ACTIVE_PROBE_MS)) !== "dead") continue;
      // Re-checked after the await: a turn or card may have started meanwhile.
      const done = await opencodeIdleSweep(now, (hid) => hid !== id || opencodeHarnessBusy(hid));
      if (!done.includes(id)) continue;
      closeOpencodeHub(id);
      probe.executing.delete(id);
      stopped.push(id);
    }
    const known = harnesses.list().filter((h) => h.kind === "opencode" && getOpencodeServer(h.id)).map((h) => h.id);
    const inUse = (id: string): boolean => probe.executing.has(id) || opencodeHarnessBusy(id);
    for (const id of known) {
      // One server per pass, so its stream closes before the next stop starts.
      const done = await opencodeIdleSweep(now, (hid) => hid !== id || inUse(hid));
      if (done.includes(id)) {
        closeOpencodeHub(id);
        stopped.push(id);
      }
    }
    // Servers of harnesses that no longer exist: nothing to probe, only the plain gate.
    for (const id of await opencodeIdleSweep(now, (hid) => known.includes(hid) || inUse(hid))) {
      closeOpencodeHub(id);
      stopped.push(id);
    }
    if (stopped.length > 0) scheduleOpencodeWatchRefresh();
    return stopped;
  } catch (err) {
    console.warn("[agetor] opencode: idle sweep failed:", err);
    return [];
  } finally {
    opencodeSweepInFlight = false;
  }
}

/**
 * Start the server driver's background parts, once the boot restore is done
 * (after `markBootReady()`): the wake handler and its watch, and the idle sweep.
 */
export function startOpencodeServerDriver(): void {
  if (opencodeDriverStarted) return;
  opencodeDriverStarted = true;
  setOpencodeWakeHandler(onOpencodeServerWake);
  setOpencodeWatchLostHandler(() => scheduleOpencodeWatchRefresh());
  scheduleOpencodeWatchRefresh();
  // A quit can't await a probe: know what is executing from the start.
  void probeOpencodeServers(OPENCODE_ACTIVE_PROBE_MS).catch(() => {});
  opencodeSweepTimer = setInterval(() => {
    void runOpencodeIdleSweep();
  }, OPENCODE_SWEEP_INTERVAL_MS);
  (opencodeSweepTimer as unknown as { unref?: () => void }).unref?.();
}

/**
 * The process is going away or handing over: stop the driver's background
 * parts and close the hub's streams. The servers are left running (they live in
 * their own tmux sessions; the next core adopts them), and so are the turns.
 */
export function stopOpencodeServerDriver(): void {
  opencodeDriverStarted = false;
  // Detach, don't settle: closing the hub tells a live subscriber its server was
  // lost, which would fail a run that is still going fine on the server. The
  // next core reattaches the turns, and listens again for the background
  // subagents a lingering handle was following (its `detach` works on a settled
  // turn too: the linger just stops, the children keep running).
  for (const t of opencodeServerTurns.values()) t.turn.detach();
  for (const entries of lingeringOpencodeTurns.values()) for (const e of entries) e.turn.detach();
  // A detached turn is inert: it is no longer a turn this core drives.
  opencodeServerTurns.clear();
  lingeringOpencodeTurns.clear();
  if (opencodeSweepTimer) clearInterval(opencodeSweepTimer);
  opencodeSweepTimer = null;
  setOpencodeWakeHandler(null);
  setOpencodeWatchLostHandler(null);
  opencodeWakeTargets = new Map();
  deferredOpencodeWakes.clear();
  lastOpencodeProbe = null;
  lastOpencodeSettleAt.clear();
  closeOpencodeHub();
}

/**
 * A real stop of this core (a real quit of the app, `agetor daemon stop`, a CLI
 * daemon's idle exit): stop every OpenCode server nothing is using, fully
 * synchronously, because the process dies right after the hook that calls this
 * (Electrobun's `quit()` runs a synchronous forced exit). "Nothing is using" =
 * no turn, lingering handle or open card here, and no executing session at the
 * last probe taken since a turn on that harness last ended here (the re-probe
 * after each settle keeps it fresh); with no probe yet, nothing is stopped.
 * Returns the stopped ids.
 */
export function stopIdleOpencodeServersOnRealStop(): string[] {
  if (lastOpencodeProbe === null) return [];
  // Busy first: it also drops lingering handles that ended, noting their settle.
  return stopIdleOpencodeServersSync((id) => opencodeHarnessBusy(id) || opencodeExecutingAtLastProbe(id));
}

/**
 * The app's before-quit decision for the servers: a quit that hands the port to
 * the background host (armed, not "quit completely") leaves them for it to
 * adopt; any other quit is a real stop. Returns the stopped ids.
 */
export function stopOpencodeServersOnQuit(quit: { completely: boolean; backgroundArmed: boolean }): string[] {
  if (!quit.completely && quit.backgroundArmed) return [];
  return stopIdleOpencodeServersOnRealStop();
}

/** Test seam for the server driver's wake and watch state; production code never calls it. */
export const __opencodeServerForTest = {
  /** Feed the hub's wake handler directly (what the hub does when OpenCode starts an execution by itself). */
  wake(serverKey: string, sessionId: string, envelope: OpencodeEnvelope, trigger?: OpencodeWakeTrigger): void {
    onOpencodeServerWake(serverKey, sessionId, envelope, trigger);
  },
  /** Wakes waiting for their task's own run to settle. */
  deferredWakes(): number {
    return deferredOpencodeWakes.size;
  },
  /** Watch `sessionId` for `taskId` until the next refresh recomputes the targets (a wake racing that refresh). */
  pinWatch(serverKey: string, sessionId: string, taskId: string): void {
    let sessions = opencodeWakeTargets.get(serverKey);
    if (!sessions) opencodeWakeTargets.set(serverKey, (sessions = new Map()));
    sessions.set(sessionId, taskId);
  },
  /** The tasks a boot would listen for again (background subagents still worth following). */
  lingerCandidates(runningTaskIds: string[] = [], now?: number): { taskId: string; runId: string; harnessId: string; sessionId: string }[] {
    return opencodeLingerCandidates(runningTaskIds, now);
  },
  /** Follow-ups queued for the task's next OpenCode turn. */
  queuedFollowUps(taskId: string): number {
    return deps.followUpQueue.get(taskId)?.length ?? 0;
  },
  /** The task a watched session belongs to, or null when the session is not watched. */
  watchedTask(serverKey: string, sessionId: string): string | null {
    return opencodeWakeTargets.get(serverKey)?.get(sessionId) ?? null;
  },
  /** The hooks a turn of `runId` gets (its `isBusy` is the server's restart gate). */
  turnHooks(harnessId: string, runId: string, taskId: string, join: OpencodeTurnJoin = "spawn"): NonNullable<SpawnAgentArgs["opencodeTurnHooks"]> {
    return opencodeTurnHooksFor(harnessId, runId, taskId, join);
  },
  /** Server-transport turns this core drives, and settled turns still lingering for children. */
  liveTurns(): { driving: number; lingering: number } {
    let lingering = 0;
    for (const taskId of [...lingeringOpencodeTurns.keys()]) lingering += liveLingeringOpencodeTurns(taskId).length;
    return { driving: opencodeServerTurns.size, lingering };
  },
};


/** The server-transport turn this core drives for `runId`, if any (a message to it steers). */
export function opencodeServerTurnForRun(runId: string): OpencodeServerRun | null {
  return opencodeServerTurns.get(runId) ?? null;
}

/** Keep a handle that only listens for a settled session's background subagents (the boot linger). */
export function addLingeringOpencodeTurn(entry: OpencodeServerRun): void {
  lingeringOpencodeTurns.set(entry.taskId, [...(lingeringOpencodeTurns.get(entry.taskId) ?? []), entry]);
}

/** Forget a wake waiting on the task: the user stopped the run it was seen during, or the task is going away. */
export function dropDeferredOpencodeWake(taskId: string): void {
  deferredOpencodeWakes.delete(taskId);
}

/** Whether a wake is waiting on the task (retried when its start claim is released). */
export function hasDeferredOpencodeWake(taskId: string): boolean {
  return deferredOpencodeWakes.has(taskId);
}

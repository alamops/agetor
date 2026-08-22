import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { db, tasks, runs, harnesses, projects, subagents } from "./db.ts";
import { spawnAgent, toClaudeModelArg, type SpawnAgentArgs, type SpawnedAgent } from "./agents.ts";
import { checkHarness } from "./agent-status.ts";
import { resolveClaudePlan, upsertClaudePlanFromExitPlanMode, upsertDetectedPlan } from "./task-plans.ts";
import { deriveTodoProgress, summarizeTodoProgress } from "../shared/todo-progress.ts";
import {
  AGENT_OPTIONS,
  DEFAULT_BRANCH_CONFIG,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_TASK_TYPE,
  IDLE_SESSION_REAP_MS,
  MODEL_EFFORT_SUPPORT,
  SESSION_DIED_STATUS_PREFIX,
  TASK_TYPES,
  branchPattern,
  renderBranchTemplate,
  validateBranchName,
  type AgentKind,
  type Harness,
  type TaskType,
} from "../shared/types.ts";

/**
 * Resolve a task's harness id to its full row (falling back to a synthetic
 * built-in via `getByIdOrKind` so legacy `"claude-code"` / `"codex"` rows
 * still work even before the migration seed lands). Returns null for
 * dangling alias references — callers must surface a clear error rather
 * than silently picking a kind.
 */
function resolveHarness(harnessId: string): Harness | null {
  return harnesses.getByIdOrKind(harnessId);
}
import {
  cancelPendingForTask,
  countPendingForTask,
  setBroadcaster,
  setResolvedBroadcaster,
  type AnyRequest,
  type InteractionResolved,
} from "./interactions.ts";
import {
  CLAUDE_API_ERROR_STATUS_PREFIX,
  CLAUDE_UNKNOWN_COMMAND_STATUS_PREFIX,
  cycleToMode,
  type CycleResult,
  type ContinuationHooks,
  dropSession,
  killSessionByName,
  reattachSession,
  pasteFollowUp,
  sendSlashCommand,
  sendTurn,
  hasSessionState,
  sessionExists,
  sessionExistsByName,
  sessionIdleInfo,
  sessionLiveness,
  sessionNameFor,
  probeSessionActivity,
  jsonlPathFor,
  interruptTaskSession,
  setContinuationRunFactory,
  setHeldSessionProbe,
  setActiveRunProbe,
  setBackgroundTaskSettledHandler,
} from "./claude-tmux.ts";
import {
  dropCodexSession,
  reattachCodexSession,
} from "./codex-tmux.ts";
import {
  dropCursorSession,
  reattachCursorSession,
} from "./cursor-tmux.ts";
import {
  dropGeminiSession,
  reattachGeminiSession,
} from "./gemini-tmux.ts";
import {
  dropFxSession,
} from "./fx-acp.ts";
import {
  setSubagentEmitter,
  setSubagentSettleHook,
  setParkedDiscoveryHandler,
  settleSubagentById,
  orphanRunningSubagents,
  attachSubagentWatcher,
  pumpWatcherForHoldCheck,
} from "./claude-subagents.ts";
import {
  prepareWorkdir,
  removeWorktree,
  detachWorktree,
  repoRoot,
  resolveRef,
  branchName,
  ensureUniqueBranch,
  fetchBranch,
  WORKTREES_DIR,
  parseWorktreeGitPointer,
  pruneWorktrees,
  hasUncommittedChanges,
  getAheadCount,
  isMergedIntoDefaultBranch,
} from "./worktree.ts";
import { killTerminalsForTask } from "./terminals.ts";
import { ensureInstalledForCwd } from "./hook-installer.ts";
import type {
  ColumnId,
  GlobalEvent,
  RunEvent,
  RunStatus,
  Task,
  WorktreeGitStatus,
  WorktreeInfo,
  WorktreeStaleReason,
  WorktreeTeardownResult,
} from "../shared/types.ts";
import { WORKTREE_STALE_AFTER_MS } from "../shared/types.ts";
import { appendReferences } from "../shared/refs.ts";

type Listener = (e: RunEvent) => void;
const listeners = new Set<Listener>();

type GlobalListener = (e: GlobalEvent) => void;
const globalListeners = new Set<GlobalListener>();

interface ActiveRun {
  taskId: string;
  agent: Task["agent"];
  kill: () => void;
  cancelled: boolean;
  /**
   * Send a follow-up user message. For claude-code this routes through tmux
   * (paste-buffer + Enter) and creates a brand-new run row in `sendInput`.
   * For codex it writes to the spawned process's stdin and stays within the
   * same run row.
   */
  writeInput: (line: string) => boolean;
  /** Set when claude code emitted an `isApiErrorMessage` line during this
   *  run (e.g. 529 Overloaded). The chunk handler flips the column to
   *  `blocked` immediately; the done handler reads this on resolution to
   *  keep the column at `blocked` (instead of bouncing to `ready`) and
   *  record the run as `failed`. */
  apiError: boolean;
  /** Set when the run's tmux session died unexpectedly mid-turn (the driver
   *  emitted the `SESSION_DIED_STATUS_PREFIX` sentinel). Like `apiError`, the
   *  chunk handler flips the column to `blocked` immediately and the done
   *  handler reads this on resolution to keep it there (record the run as
   *  `failed`, not bounce to `ready`). */
  sessionDied: boolean;
  /** Set when claude's TUI rejected the pasted message as an unknown slash
   *  command (the driver emitted the `CLAUDE_UNKNOWN_COMMAND_STATUS_PREFIX`
   *  sentinel — no JSONL line was ever written for that turn). Like
   *  `apiError`/`sessionDied`, the chunk handler flips the column to
   *  `blocked` immediately and the done handler reads this on resolution to
   *  keep it there (record the run as `failed`, not bounce to `ready`). */
  unknownCommand: boolean;
}
const active = new Map<string, ActiveRun>(); // runId -> handle

// Guards `reapIdleSessions` against overlapping sweeps — the boot one-shot
// and the recurring `setInterval` in index.ts could otherwise both be
// in-flight if a sweep ever ran long (many candidate tasks, a slow tmux
// probe). A simple boolean is enough: sweeps are infrequent (every
// `SESSION_REAP_SWEEP_MS`) and idempotent, so skipping one entirely when
// another is still running just means its candidates get picked up next tick.
let reapInFlight = false;

// Archive/delete teardown (tmux session kill, terminal teardown, worktree
// detach/remove) is deferred onto a per-source-workdir FIFO queue so
// `archiveTask` can flip the DB column and respond in milliseconds instead of
// blocking on `spawnSync` tmux kills and `git worktree remove --force`/
// `prune`. The serialization is deliberate, not incidental: concurrent `git
// worktree remove`/`prune` invocations against the SAME source repo contend
// on git's internal locks (`.git/worktrees/.lock` etc.), so archiving several
// tasks that share a workdir must still tear them down one at a time — just
// not on the request's critical path. Tasks in *different* source repos have
// no such lock contention, so they get independent chains and never wait on
// each other — a big worktree removal for repo A must not stall a DELETE in
// unrelated repo B. `teardownTails` keys the chain by `task.workdir` (the raw
// string, not a resolved repo root — two tasks pointed at different subdirs
// of the same repo would therefore get separate chains and could still
// contend on git's locks; accepted as rare, and best-effort teardown plus the
// boot sweep heal any resulting strand). `teardowns` is unchanged: it lets
// callers (unarchive/start/delete, plus the boot-time sweep) await a specific
// task's in-flight teardown before touching the same worktree, keyed by task
// id as before — this still works under per-workdir chains because a task's
// workdir can't change while a teardown is pending (archived tasks are
// PATCH-frozen, and every materializing path awaits `pendingTeardown` first).
const teardownTails = new Map<string, Promise<void>>();
const teardowns = new Map<string, Promise<void>>();

/**
 * Chain `job` onto the teardown FIFO for `key` (the task's source `workdir`)
 * and track it per-task so `pendingTeardown` can be awaited by callers that
 * must not race a deferred teardown (unarchive, start, delete, the orphan
 * sweep). Errors from `job` are caught and logged — a single misbehaving
 * teardown must never break the chain for every task queued behind it on the
 * same workdir.
 */
function enqueueTeardown(taskId: string, key: string, job: () => Promise<void>): Promise<void> {
  const tail = teardownTails.get(key) ?? Promise.resolve();
  const p = tail
    .then(job)
    .catch((err) => {
      console.warn(`[agetor] deferred teardown failed for task ${taskId}:`, err);
    });
  teardownTails.set(key, p);
  p.finally(() => {
    // Only clear the entry if it's still the current tail for this key — a
    // later enqueue for the same workdir must not have its chain slot
    // clobbered by this settle, and this also bounds the map's size (an idle
    // workdir's entry is removed once its chain drains).
    if (teardownTails.get(key) === p) teardownTails.delete(key);
  });
  teardowns.set(taskId, p);
  p.finally(() => {
    // Only clear the entry if it's still ours — a later enqueue for the same
    // task (e.g. delete right after archive) must not have its promise
    // clobbered by this settle.
    if (teardowns.get(taskId) === p) teardowns.delete(taskId);
  });
  return p;
}

/**
 * Await any deferred teardown currently in flight (or queued) for `taskId`.
 * Resolves immediately when nothing is pending. Exported so `unarchiveTask`,
 * `startTask`, and the boot-time sweep can serialize against a still-running
 * archive/delete teardown before touching the same worktree, and so tests can
 * drain the queue deterministically.
 */
export function pendingTeardown(taskId: string): Promise<void> {
  return teardowns.get(taskId) ?? Promise.resolve();
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(e: RunEvent) {
  for (const fn of listeners) fn(e);
}

// The subagent watcher (armed inside the claude-tmux tailer) persists its
// tagged events itself but needs the orchestrator's SSE fan-out to reach the
// run panel. Register `emit` as its sink once, at module load — there's exactly
// one listener set and the subagent stream rides the same `/tasks/:id/events`
// channel the UI already subscribes to.
setSubagentEmitter(emit);

// A held task's terminal run is already `succeeded`, so nothing in the run
// lifecycle will ever move it out of `running` — the release has to be driven
// by the background agents themselves. Register the release as the subagent
// settle hook so the last-agent-finishing edge lands the card in `review`.
setSubagentSettleHook(maybeReleaseHeldTask);

// Parked-discovery: a subagent newly (or once again) `running` should pull a
// `review` card back to `running` — the mirror-image of the settle hook
// above. Registered here (not inline) so it's visible alongside the other
// claude-subagents.ts seams; see `pullBackParkedTask` below for the policy
// (only from `review`, only when the terminal run actually succeeded).
setParkedDiscoveryHandler(pullBackParkedTask);

// Continuation-run adoption: claude-tmux calls this when a genuinely-new
// content line arrives on a task's session with no turn in flight — the case
// a post-`end_turn` background-task auto-continuation produces. See
// `startContinuationRun` below.
setContinuationRunFactory(startContinuationRun);

// Death-watch during a #92 hold: keep polling `tmux has-session` even though
// no turn is in flight, so a session dying mid-hold is caught instead of
// silently stranding the card in `running` until the next boot. Reuses the
// existing DB-derived hold predicate — no new state to track.
setHeldSessionProbe(isHeldByBackgroundAgents);

// Run association for `signalSubagentApiError` (#93): answers "what run id
// is currently in flight for this task, per the orchestrator's OWN `active`
// map?" so a stale async subagent from an older run can't abort a newer
// run's turn. `task.runId` alone isn't enough — it's set the instant
// `startTask` inserts the run row, before `spawnAgent` returns and
// `registerActiveRun` populates `active`, and it's also left stale after a
// run resolves — so the extra `active.has` check (the exact idiom used
// throughout this file, e.g. the busy/idle branch in `sendInput`) is what
// actually answers "in flight right now."
setActiveRunProbe((taskId) => {
  const task = tasks.get(taskId);
  if (!task?.runId) return null;
  return active.has(task.runId) ? task.runId : null;
});

// Background-task settle signal: a parent task-notification JSONL line named
// the finishing agent/background-task id — settle that subagent row the same
// way a naturally-detected completion would (DB flip → lifecycle emit →
// settle hook → `maybeReleaseHeldTask`). Tolerant by design: a line whose id
// matches no row, or a duplicate fired again on reattach replay, is a no-op
// inside `settleSubagentById`. `source: "receipt"` (claude-subagents.ts fix 4)
// — this IS the live `<task-notification>` dispatch, the harness's own
// authoritative completion signal, so the settled row should resist a
// trailing assistant/attachment flush resurrecting it the way an inferred
// settle would allow.
setBackgroundTaskSettledHandler((_taskId, agentId) => {
  settleSubagentById(agentId, "completed", "receipt");
});

/**
 * Subscribe to the app-wide lifecycle stream — terminal run-status
 * transitions and column changes. Live-only: subscribers see events from the
 * moment they connect, never a replay. Drives the toast hook in the webview.
 */
export function subscribeGlobal(fn: GlobalListener): () => void {
  globalListeners.add(fn);
  return () => globalListeners.delete(fn);
}

function emitGlobal(e: GlobalEvent) {
  for (const fn of globalListeners) fn(e);
}

/**
 * Publish an app-wide lifecycle event from outside the orchestrator (e.g.
 * the auto-updater). Exported so subsystems with their own lifecycle don't
 * have to re-implement the listener set — there's exactly one
 * `subscribeGlobal` channel and the SSE endpoint that feeds the UI is wired
 * to it once.
 */
export function publishGlobalEvent(e: GlobalEvent): void {
  emitGlobal(e);
}

/** Canonicalize CR/LF in user-supplied text before it's emitted as a
 *  `user` stream event. The JSONL emit path in claude-tmux.ts does the
 *  same — keeping both sides symmetric guarantees the panel's dedup
 *  (keyed on `data.slice(0,200)`) collapses live + JSONL into one
 *  bubble even when the input arrived with Windows line endings
 *  (`\r\n`) from a clipboard paste. */
function normalizeUserText(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

/**
 * Update a task's column and broadcast the transition. Reads the row's
 * current column first so the global event carries `prev` — saves the UI
 * from keeping its own diff state. Pass `null` for `runId` when the change
 * isn't tied to a specific run (e.g. orphan reconciliation).
 */
function updateColumn(
  taskId: string,
  runId: string | null,
  next: ColumnId,
  reason?: "api-error" | "approval" | "session-died" | "unknown-command",
): void {
  const before = tasks.get(taskId);
  const prev: ColumnId | null = before?.column ?? null;
  tasks.update(taskId, { column: next });
  if (prev !== next) {
    emitGlobal({ kind: "column", taskId, runId, column: next, prev, ts: Date.now(), reason });
  }
}

/**
 * A task is "held" when its terminal run already succeeded but background
 * agents are still running. Derived purely from the DB (not the in-memory
 * `active` map) so the answer survives a restart and doesn't depend on
 * whether the subagent's settle fired before or after the run's completion
 * landed — either interleaving reads the same committed rows.
 *
 * Split into a pure `(task) => boolean` predicate plus a taskId-keyed
 * wrapper so callers that already hold a freshly-fetched `Task` row (e.g.
 * `reapIdleSessions`'s per-candidate guard) can reuse it without a second,
 * redundant `tasks.get`.
 */
function isTaskHeldByBackgroundAgents(task: Task): boolean {
  if (task.column !== "running" || task.runId == null) return false;
  if (runs.get(task.runId)?.status !== "succeeded") return false;
  return subagents.hasRunning(task.id);
}

function isHeldByBackgroundAgents(taskId: string): boolean {
  const task = tasks.get(taskId);
  return task ? isTaskHeldByBackgroundAgents(task) : false;
}

/**
 * Flip a held task to `review` once its last subagent finishes. Called on
 * every subagent completion (via the settle hook), so it must be cheap and
 * safe to call repeatedly — it no-ops unless the task is still held-and-clear:
 * the user hasn't moved the card, the terminal run still succeeded, and no
 * subagent is left running. A newer in-flight run (status !== succeeded) also
 * bails, so a held release can't stomp a follow-up turn's `running` state.
 */
function maybeReleaseHeldTask(taskId: string): void {
  const task = tasks.get(taskId);
  if (!task || task.column !== "running" || task.runId == null) return;
  if (runs.get(task.runId)?.status !== "succeeded") return;
  if (subagents.hasRunning(taskId)) return;
  updateColumn(taskId, task.runId, "review");
}

/**
 * Pull a `review` card back to `running` when a background agent is
 * discovered (newly, or once again) `running` for its task — the mirror
 * image of `maybeReleaseHeldTask` above. Fired from claude-subagents.ts'
 * `setParkedDiscoveryHandler` on every fresh-insert or resumed-running edge,
 * so it must be cheap and idempotent (a no-op call is the common case: most
 * discoveries happen while the card is already `running`, not `review`).
 *
 * Deliberately narrow — only `review → running`, and only when the card's
 * own terminal run actually `succeeded` (i.e. this looks like the #92 hold
 * shape: the visible turn finished, background work continued after it).
 * Never pulls from `done`/`blocked`/`ready`/`backlog` — those encode user
 * intent or an error state the discovery of a background agent must not
 * override.
 */
function pullBackParkedTask(taskId: string): void {
  const task = tasks.get(taskId);
  if (!task || task.column !== "review" || task.runId == null) return;
  if (runs.get(task.runId)?.status !== "succeeded") return;
  const runId = task.runId;
  updateColumn(taskId, runId, "running");
  const data = "background agent active — task pulled back to running";
  const ts = Date.now();
  runs.appendEvent(runId, "status", data);
  emit({ runId, taskId, stream: "status", data, ts });
}

/** Test hook: drive the event bus directly to verify SSE routing without
 *  needing a live agent. Not part of the public surface. */
export function __emitForTest(e: RunEvent): void {
  emit(e);
}

/** Test hook: drive the global event bus directly to verify the `/events`
 *  SSE wiring without orchestrating a real run. Not part of the public
 *  surface. */
export function __emitGlobalForTest(e: GlobalEvent): void {
  emitGlobal(e);
}

/**
 * Test hook: build and immediately fire a `makeChunkHandler` chunk for a
 * given run/task — the SAME handler real runs use (`runs.appendEvent` +
 * SSE emit + todo-progress/claude-plan detection + the api-error/
 * session-died/unknown-command sentinel checks). Lets orchestrator-level
 * tests (e.g. `orchestrator-claude-plan.test.ts`) drive synthetic
 * `tool_use`/`tool_result` chunks through the real detection pipeline
 * without a canned fake-driver scenario for every shape under test. Not
 * part of the public surface. */
export function __dispatchChunkForTest(
  runId: string,
  taskId: string,
  kind: AgentKind,
  stream: RunEvent["stream"],
  data: string,
): void {
  makeChunkHandler(runId, taskId, kind, null)(stream, data);
}

/**
 * Bridge: interactions.ts publishes new/resolved entries here so they ride the
 * same SSE stream the UI is already subscribed to (the UI distinguishes them
 * from regular log events via `stream === "interaction"`) AND the app-level
 * global bus so the notification hook can alert the user.
 *
 * Exported and idempotent because `setBroadcaster`/`setResolvedBroadcaster`
 * install a single process-wide callback: any code that overrides it (e.g. a
 * test capturing raw broadcasts) would otherwise permanently detach the global
 * emit. Tests that need the real wiring can re-call this to restore it.
 */
export function wireInteractionBroadcast(): void {
  setBroadcaster((req: AnyRequest) => {
    emit({
      runId: req.runId,
      taskId: req.taskId,
      stream: "interaction",
      data: JSON.stringify(req),
      ts: req.createdAt,
    });
    // Also ride the app-level bus so the notification hook can alert the user
    // even when no panel for this task is open (or it's open but the window is
    // backgrounded and can't repaint the card). The per-task `interaction`
    // event above only reaches the RunPanel subscribed to this task.
    emitGlobal({
      kind: "interaction",
      taskId: req.taskId,
      runId: req.runId,
      state: "pending",
      interactionId: req.id,
      ts: req.createdAt,
    });
  });

  // Companion bridge for the *removal* side. Every answer*/cancel* path in
  // interactions.ts calls into this, so the run panel can drop the card
  // immediately instead of waiting for a refresh poll. Without this, scraper
  // auto-cancel and run-cancellation leave stale cards in the panel (the
  // existing additions-only SSE plumbing has no way to signal "this is gone").
  setResolvedBroadcaster((res: InteractionResolved) => {
    emit({
      runId: res.runId,
      taskId: res.taskId,
      stream: "interaction_resolved",
      data: JSON.stringify({ id: res.id, kind: res.kind }),
      ts: Date.now(),
    });
    // App-level companion to the pending emit above — lets the notification
    // hook clear its "Waiting on you" alert once the last prompt is gone.
    emitGlobal({
      kind: "interaction",
      taskId: res.taskId,
      runId: res.runId,
      state: "resolved",
      interactionId: res.id,
      ts: Date.now(),
    });
  });
}

wireInteractionBroadcast();

// Companion bridge for the *removal* side. Every answer*/cancel* path
// in interactions.ts calls into this, so the run panel can drop the
// card immediately instead of waiting for a refresh poll. Without
// this, scraper auto-cancel and run-cancellation leave stale cards in
// the panel (the existing additions-only SSE plumbing has no way to
// signal "this is gone").
setResolvedBroadcaster((res: InteractionResolved) => {
  emit({
    runId: res.runId,
    taskId: res.taskId,
    stream: "interaction_resolved",
    data: JSON.stringify({ id: res.id, kind: res.kind }),
    ts: Date.now(),
  });
});

/**
 * Decide what to do with runs left in `status='running'` from a previous
 * agetor process. For claude-code runs whose tmux session is still alive
 * (the REPL is detached — it survives our exit), we *reattach* and resume
 * tailing claude's JSONL; the run stays in `running` and the user picks up
 * where they left off. Anything else (tmux gone, JSONL missing, codex run
 * whose child process died with us) is flipped to `orphaned`.
 *
 * We never enumerate-and-kill `agetor-*` sessions here. Agetor runs on the
 * user's *shared* default tmux socket, so a blind sweep would reap sessions
 * belonging to a different agetor instance (dev vs release DB) or to a
 * `bun test` run — the bug this deliberately avoids. Every kill agetor issues
 * is keyed to a specific task id from *this* instance's own DB (see the
 * per-row `killSessionByName` below, `killTaskSession` on delete/archive, and
 * codex's own teardown), so it can never touch a foreign instance's sessions.
 * A genuinely-leaked session (crash artifact, or a task deleted while agetor
 * was offline) is simply left alive rather than risk killing a live one.
 *
 * Called once at boot from `src/bun/index.ts`.
 */
export function reconcileOrphans(): number {
  // Sort newest-first so the at-most-one-reattach-per-task rule below keeps
  // the latest run row. If agetor crashed in the narrow window between
  // `sendTurnInExistingSession` inserting Run2 and `attachDoneHandler`
  // marking Run1 succeeded, the DB has two `running` rows for the same
  // task; only the latest reflects the user's current intent. Older
  // siblings get flipped to orphaned so we never have two SessionState
  // objects fighting for the same tmux session.
  const stale = db.query<{ id: string; task_id: string; tmux_session: string | null; claude_session_id: string | null; codex_session_id: string | null; cursor_session_id: string | null; gemini_session_id: string | null; fx_session_id: string | null; agent: string }, []>(
    `SELECT id, task_id, tmux_session, claude_session_id, codex_session_id, cursor_session_id, gemini_session_id, fx_session_id, agent FROM runs WHERE status = 'running' ORDER BY started_at DESC, id DESC`,
  ).all();

  const reattachedTaskIds = new Set<string>();
  const orphaned: { id: string; task_id: string; prevColumn: ColumnId | null }[] = [];

  for (const row of stale) {
    const task = tasks.get(row.task_id);
    const prevColumn: ColumnId | null = task?.column ?? null;
    const kind = resolveHarness(row.agent)?.kind ?? null;
    // claude-code, codex, cursor, and gemini runs can all be reattached when
    // their detached tmux session is still alive. The reattach key differs
    // by kind: claude needs its JSONL session uuid (`claude_session_id`),
    // codex needs its thread id (`codex_session_id`), cursor needs its
    // `session_id` (`cursor_session_id`), gemini needs its self-issued uuid
    // (`gemini_session_id`) — the per-run log path is derived from the run
    // id in every case. Note codex's, cursor's, gemini's, and fx's sessions
    // only live WHILE their turn is in flight (one process per turn), so a
    // reattachable one of those is by definition one that was still running
    // when agetor restarted. Also: if we already reattached a newer sibling
    // for this task, orphan the older one — only one SessionState can drive
    // a given tmux session at a time.
    const reattachKey =
      kind === "claude-code" ? row.claude_session_id
      : kind === "codex" ? row.codex_session_id
      : kind === "cursor" ? row.cursor_session_id
      : kind === "gemini" ? row.gemini_session_id
      : null;
    // fx is driven over ACP/stdio, not tmux — nothing to reattach to, so a
    // `running` fx row at boot always takes the orphaned→ready path.
    const canTryReattach =
      (kind === "claude-code" || kind === "codex" || kind === "cursor" || kind === "gemini")
      && task !== null
      && row.tmux_session !== null
      && reattachKey !== null
      && !reattachedTaskIds.has(row.task_id)
      && sessionExistsByName(row.tmux_session);

    if (canTryReattach && task) {
      const cwd = task.worktreePath ?? task.workdir;
      const harness = resolveHarness(task.agent);
      const onChunk = makeChunkHandler(row.id, row.task_id, kind as AgentKind, task.mode);
      const spawned = kind === "claude-code"
        ? reattachSession({
            taskId: row.task_id,
            cwd,
            sessionId: row.claude_session_id as string,
            configDir: harness?.home ?? null,
            onChunk,
            seenLineUuids: runs.seenLineUuidsForTask(row.task_id),
            mode: task.mode,
          })
        : kind === "codex"
        ? reattachCodexSession({
            taskId: row.task_id,
            runId: row.id,
            sessionName: row.tmux_session as string,
            onChunk,
            seenLineUuids: runs.seenLineUuidsForTask(row.task_id),
          })
        : kind === "cursor"
        ? reattachCursorSession({
            taskId: row.task_id,
            runId: row.id,
            sessionName: row.tmux_session as string,
            onChunk,
            seenLineUuids: runs.seenLineUuidsForTask(row.task_id),
          })
        : reattachGeminiSession({
            taskId: row.task_id,
            runId: row.id,
            sessionName: row.tmux_session as string,
            onChunk,
            seenLineUuids: runs.seenLineUuidsForTask(row.task_id),
          });
      if (spawned) {
        registerActiveRun(row.id, row.task_id, task, spawned);
        // Pre-seed `handle.apiError` when the prior process had already
        // emitted the api-error status to run_events for this run. The
        // reattach replay can't re-emit it — the assistant-line uuid is in
        // seenLineUuids, so `dispatchLine` short-circuits before the
        // mapper runs — so without this seed `attachDoneHandler` would
        // resolve with `wasApiError=false` and bounce the column from the
        // (correctly-persisted) `blocked` back to `review` on the first
        // pending-end-turn fire. `EXISTS` short-circuits on first match
        // and reads more clearly than `COUNT(*) > 0`.
        // subagent_id IS NULL: a subagent tailer's own transient api-error
        // status row (since #81) must not seed the main run's apiError.
        const priorApiError = db.query<{ found: 0 | 1 }, [string, string]>(
          `SELECT EXISTS(
             SELECT 1 FROM run_events
             WHERE run_id = ? AND stream = 'status' AND data LIKE ? AND subagent_id IS NULL
           ) AS found`,
        ).get(row.id, `${CLAUDE_API_ERROR_STATUS_PREFIX}%`)?.found ?? 0;
        if (priorApiError === 1) {
          const handle = active.get(row.id);
          if (handle) handle.apiError = true;
        }
        attachDoneHandler(row.id, row.task_id, spawned);
        reattachedTaskIds.add(row.task_id);
        // Visible seam in the run panel so the user can tell where the
        // process boundary is. Non-JSONL chunk → no dedup key needed.
        onChunk("status", "reconnected to live session after agetor restart");
        continue;
      }
      // JSONL missing despite live tmux — can't safely resume; kill the
      // session and fall through to orphan marking.
      killSessionByName(row.tmux_session as string);
    }
    orphaned.push({ id: row.id, task_id: row.task_id, prevColumn });
  }

  const now = Date.now();
  if (orphaned.length > 0) {
    const reconcile = db.transaction(() => {
      for (const row of orphaned) {
        db.run(
          `UPDATE runs SET status = 'orphaned', ended_at = ?, exit_code = -1 WHERE id = ?`,
          [now, row.id],
        );
        db.run(
          `INSERT INTO run_events (run_id, stream, data, ts) VALUES (?, ?, ?, ?)`,
          [row.id, "status", "orphaned — agetor restarted while this run was active", now],
        );
        db.run(
          `UPDATE tasks SET "column" = 'ready', run_id = NULL WHERE id = ? AND "column" = 'running'`,
          [row.task_id],
        );
      }
    });
    reconcile();
    for (const row of orphaned) {
      emitGlobal({
        kind: "run-status",
        taskId: row.task_id,
        runId: row.id,
        status: "orphaned",
        ts: now,
      });
      if (row.prevColumn === "running") {
        emitGlobal({ kind: "column", taskId: row.task_id, runId: null, column: "ready", prev: row.prevColumn, ts: now });
      }
    }
  }

  // Deliberately NO straggler sweep here. Sessions live on the shared default
  // tmux socket, so enumerating + killing every un-reattached `agetor-*`
  // session would reap a sibling instance's (dev vs release DB) or a test
  // run's live sessions. We reattach what we can, orphan the rest in the DB,
  // and leave any unaccounted-for session alive.
  if (reattachedTaskIds.size > 0) {
    console.log(`[agetor] reattached to ${reattachedTaskIds.size} live tmux session(s)`);
  }
  if (orphaned.length > 0) {
    console.log(`[agetor] orphaned ${orphaned.length} run(s) with no recoverable session`);
  }

  // Held tasks — and, more generally, ANY task with a stuck `running`
  // subagents row — are invisible to the pass above: their terminal run is
  // already `succeeded`, so it never appears in the `status='running'` scan
  // and nothing re-arms the subagent watcher that would eventually release
  // the card. Left alone, a restart strands them forever. This used to only
  // scan `tasks WHERE column = 'running'`, which covers the classic
  // held-in-running case but has a blind spot: a `review`/`done`-column task
  // whose subagents row is still `running` after a restart (the terminal run
  // resolved and moved the card out of `running` *before* the crash, so the
  // old scan skipped it entirely) was invisible here too — nothing ever
  // re-armed its watcher or orphaned its rows, and the badge/tab dot stayed
  // stuck forever. Source the wider set instead: every task with at least
  // one `running` subagents row, regardless of column.
  let reArmed = 0;
  let released = 0;
  const heldTaskIds = subagents.taskIdsWithRunning();
  for (const heldId of heldTaskIds) {
    const task = tasks.get(heldId);
    if (!task) continue;
    // Only claude-code writes subagent rows; a codex or cursor task can never
    // be held, so it never reaches here. Guard the session probe on kind for
    // clarity.
    if (resolveHarness(task.agent)?.kind !== "claude-code") continue;

    if (task.column === "running") {
      // Classic held-task path, unchanged: only proceed when the terminal run
      // has actually succeeded (i.e. this is a genuinely stuck "held for
      // background agents" task, not an ordinary run still legitimately in
      // progress that just happens to also have live subagent rows).
      if (!isHeldByBackgroundAgents(heldId)) continue;
      if (sessionExistsByName(sessionNameFor(heldId))) {
        const run = task.runId ? runs.get(task.runId) : null;
        // No JSONL session id means no watch directory to derive, so nothing will
        // ever observe these agents finishing. Treat it exactly like a dead
        // session and release, rather than leaving the card held forever.
        if (!run?.claudeSessionId) {
          orphanRunningSubagents(heldId);
          released++;
          continue;
        }
        const cwd = task.worktreePath ?? task.workdir;
        const harness = resolveHarness(task.agent);
        attachSubagentWatcher({
          taskId: heldId,
          jsonlPath: jsonlPathFor(cwd, run.claudeSessionId, harness?.home ?? null),
        });
        reArmed++;
      } else {
        // Session gone: no watcher could ever observe these agents finishing, so
        // flip the rows now. `orphanRunningSubagents` fires the settle hook →
        // `maybeReleaseHeldTask` → the card advances to `review`.
        orphanRunningSubagents(heldId);
        released++;
      }
      continue;
    }

    // Blind-spot path: any column other than `running` (review, done, ready,
    // blocked, archived or not). `isHeldByBackgroundAgents` doesn't apply
    // here — it only ever looks at `column === 'running'` rows — but the
    // task's terminal run resolved normally (that's how the card got out of
    // `running` before the crash), so `task.runId` still reliably points at
    // that succeeded run and its `claudeSessionId`. Mirror the exact same
    // session-alive / session-id-recoverable branch structure as above.
    // HARD INVARIANT: never kill or create tmux sessions here — only re-arm
    // watchers and flip DB rows.
    if (sessionExistsByName(sessionNameFor(heldId))) {
      const run = task.runId ? runs.get(task.runId) : null;
      if (!run?.claudeSessionId) {
        orphanRunningSubagents(heldId);
        released++;
        continue;
      }
      const cwd = task.worktreePath ?? task.workdir;
      const harness = resolveHarness(task.agent);
      attachSubagentWatcher({
        taskId: heldId,
        jsonlPath: jsonlPathFor(cwd, run.claudeSessionId, harness?.home ?? null),
      });
      reArmed++;
    } else {
      // Session gone: orphan the rows. Unlike the held-in-running case, the
      // settle hook's `maybeReleaseHeldTask` safely bails here (task.column
      // isn't `running`), so this only clears the stale subagent rows — it
      // does not move the card, which is already sitting wherever the user
      // (or the earlier normal completion) left it.
      orphanRunningSubagents(heldId);
      released++;
    }
  }
  if (reArmed > 0 || released > 0) {
    console.log(`[agetor] held tasks: re-armed ${reArmed} watcher(s), released ${released} background-agent row(s)`);
  }

  return orphaned.length;
}

/**
 * Wraps `spawnAgent` so a synchronous throw inside it — `buildCommand` can
 * throw before a process is ever spawned (gemini's argv-size cap, "model is
 * required", …) — can't strand the run row it was called for. Every call
 * site below has already inserted the run row and flipped the task to
 * `running` by the time it calls this, so on a throw there's persisted state
 * to unwind: emit the error as a stderr chunk, fail the run, and bounce the
 * task back to `ready` — the same recovery each call site already does for a
 * missing harness (see the neighboring `if (!harness)` branches). Returns
 * null on failure so callers can early-return exactly the way they already
 * do for a missing harness. `args` carries `runId`/`taskId`/`onChunk` itself
 * (see `SpawnAgentArgs`), so there's no separate parameter for them.
 */
function spawnAgentOrFail(args: SpawnAgentArgs): SpawnedAgent | null {
  try {
    return spawnAgent(args);
  } catch (err) {
    const { runId, taskId, onChunk } = args;
    const message = err instanceof Error ? err.message : String(err);
    onChunk("stderr", `failed to start agent: ${message}`);
    runs.update(runId, { status: "failed", endedAt: Date.now(), exitCode: -1 });
    tasks.update(taskId, { column: "ready", runId: null });
    return null;
  }
}

export async function startTask(taskId: string): Promise<{ runId: string } | { error: string }> {
  let task = tasks.get(taskId);
  if (!task) return { error: "task not found" };
  if (task.runId && active.has(task.runId)) return { error: "task already running" };

  // startTask auto-unarchives and materializes the worktree below — it must
  // not race a teardown archiveTask (or deleteTask) deferred for this task,
  // or a `detachWorktree`/`removeWorktree` still in flight could yank the
  // directory out from under the freshly-prepared one.
  await pendingTeardown(taskId);

  // Starting an archived task auto-unarchives it — otherwise the card would
  // move through columns (running → review/ready) while hidden behind the
  // archive filter, which is confusing at best.
  if (task.archivedAt != null) {
    task = tasks.update(taskId, { archivedAt: null }) ?? task;
  }

  const harness = resolveHarness(task.agent);
  if (!harness) {
    return { error: `harness "${task.agent}" not found — pick another in the task's settings` };
  }
  // Soft-delete gate: disabled harnesses still resolve (so historical rows
  // and currently-running children stay attributable), but new runs are
  // blocked. The user re-enables in Settings to recover.
  if (!harness.enabled) {
    return { error: `${harness.label} is disabled — re-enable it in Settings to start new runs.` };
  }
  const status = await checkHarness(harness);
  if (!status.available) {
    const hint = status.installHint ? ` Install it with: ${status.installHint}` : "";
    return { error: `${harness.label} is not available — ${status.reason}.${hint}` };
  }

  // Pass the branches other tasks have pinned. If materializing this task's
  // branch hits a create-time uniqueness race, the recovery re-pins to a name
  // that's free of both existing refs AND those not-yet-started pins.
  const prepared = await prepareWorkdir(task, {
    takenBranches: new Set(
      tasks.list()
        .filter((t) => t.id !== taskId)
        .map((t) => t.branch)
        .filter((b): b is string => Boolean(b)),
    ),
  });
  if ("error" in prepared) return { error: prepared.error };

  // Lazy-pin baseRef: workdir wasn't a git repo when the task was created but
  // is one now. Pin the sha actually used so re-runs stay reproducible.
  if (!task.baseRef && prepared.worktreePath) {
    const sha = await resolveRef(task.workdir, "HEAD");
    if (sha) tasks.update(taskId, { baseRef: sha });
  }

  const runId = randomUUID();
  const now = Date.now();
  const prevColumn: ColumnId = task.column;

  // Single transaction: flip the task into running with the new run id, branch,
  // worktree path; insert the run row. Either everything sticks or nothing does.
  const persist = db.transaction(() => {
    tasks.update(taskId, {
      column: "running",
      branch: prepared.branch,
      worktreePath: prepared.worktreePath,
      runId,
    });
    runs.insert({
      id: runId,
      taskId,
      agent: task.agent,
      status: "running",
      startedAt: now,
      endedAt: null,
      exitCode: null,
      // All four kinds now run in a per-task tmux session. fx is the
      // exception — it's driven over ACP/stdio, not tmux — but it still
      // gets a `tmuxSession` name here for symmetry with the run row shape;
      // `spawnFxViaAcp` simply doesn't use it.
      tmuxSession: sessionNameFor(taskId),
      // Filled in by spawnAgent's onSessionId callback once the session id is
      // known: claude's JSONL uuid → claudeSessionId, codex's thread_id →
      // codexSessionId, cursor's session_id → cursorSessionId, gemini's
      // self-issued uuid → geminiSessionId, fx's ACP session id →
      // fxSessionId. Exactly one is non-null per run.
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: null,
    });
  });
  persist();
  if (prevColumn !== "running") {
    emitGlobal({ kind: "column", taskId, runId, column: "running", prev: prevColumn, ts: now });
  }

  const promptWithRefs = appendReferences(task.prompt, task.references);

  const onChunk = makeChunkHandler(runId, taskId, harness.kind, task.mode);
  // Echo the initial prompt as a "user" event so the panel renders a
  // bubble for it right away — claude won't transcribe the prompt into
  // its JSONL until it boots (can take a few seconds). The JSONL-flush
  // path will emit the same line again once claude writes it; the run
  // panel's dedup keys user events on (runId, data) so we don't double
  // up.
  onChunk("user", normalizeUserText(promptWithRefs));

  const agent = spawnAgentOrFail({
    taskId,
    runId,
    harness,
    prompt: promptWithRefs,
    cwd: prepared.cwd,
    onChunk,
    onSessionId: (sessionId) => {
      runs.update(runId, harness.kind === "claude-code"
        ? { claudeSessionId: sessionId }
        : harness.kind === "codex"
        ? { codexSessionId: sessionId }
        : harness.kind === "cursor"
        ? { cursorSessionId: sessionId }
        : harness.kind === "gemini"
        ? { geminiSessionId: sessionId }
        : { fxSessionId: sessionId });
    },
    opts: { mode: task.mode, model: task.model ?? DEFAULT_MODEL[harness.kind], effort: task.effort, fast: task.fast, maxMode: task.maxMode },
  });
  if (!agent) return { error: "failed to start agent — check the run log for details" };
  registerActiveRun(runId, taskId, task, agent);
  emit({
    runId,
    taskId,
    stream: "status",
    data: `started — ${prepared.note} — agent=${task.agent}, model=${task.model ?? "—"}, mode=${task.mode ?? "auto"}`,
    ts: now,
  });

  attachDoneHandler(runId, taskId, agent);

  return { runId };
}

/** Cheap pre-filter before doing the more expensive JSON-parse + DB query a
 *  todo-family chunk triggers below — TodoWrite/TaskCreate/TaskUpdate chunks
 *  are rare (most chunks are assistant text, thinking, or unrelated tool
 *  calls), so a plain substring check keeps the hot path a single `includes`
 *  away from a no-op. Markers are the literal serialized `"name":"<Tool>"`
 *  envelope form (see `claude-tmux.ts`'s `JSON.stringify` of `tool_use`
 *  blocks — no spaces), not a bare tool name substring: agetor dogfoods
 *  itself, so an assistant/tool_result chunk quoting "TaskCreate" in prose
 *  (e.g. describing this very code) is a real false positive with the bare
 *  form, not a theoretical one.
 *
 *  Split by stream, mirroring `runs.todoRelevantEventsForTask`'s SQL LIKE
 *  filter in db.ts (same split, same reason): a `tool_use` row carries
 *  `"name":"<Tool>"`, but a `tool_result` row never does (`{toolUseId,
 *  content, isError}`) — its ONLY todo-family shape `deriveTodoProgress`
 *  ever consults is a `TaskCreate` result's `"Task #N created successfully"`
 *  text, so that's the marker for the `tool_result` side. Without this
 *  separate check, `tool_result` rows would never re-trigger the board
 *  summary, and a TaskCreate's claude-assigned number wouldn't be reflected
 *  until some unrelated LATER tool_use chunk happened to fire the recompute. */
const TODO_FAMILY_TOOL_USE_MARKERS = ['"name":"TodoWrite"', '"name":"TaskCreate"', '"name":"TaskUpdate"'];
const TODO_FAMILY_TOOL_RESULT_MARKER = "created successfully";

function isTodoFamilyChunk(stream: RunEvent["stream"], data: string): boolean {
  if (stream === "tool_use") return TODO_FAMILY_TOOL_USE_MARKERS.some((m) => data.includes(m));
  if (stream === "tool_result") return data.includes(TODO_FAMILY_TOOL_RESULT_MARKER);
  return false;
}

/**
 * Re-derive and persist the board-level `tasks.todo_progress` summary after a
 * todo-family `tool_use`/`tool_result` chunk lands. Works for every agent
 * kind — chunks are a generic `{stream,data}` shape, and gating this on
 * `kind` would be one more thing to keep in sync with whichever harnesses
 * grow Task-tools-style tools next (plan §3).
 *
 * Must be called AFTER `runs.appendEvent` has persisted the chunk that
 * triggered it (see the call site in `makeChunkHandler`, which appends
 * before running any detection): `runs.todoRelevantEventsForTask` re-reads
 * `run_events` synchronously via `bun:sqlite`, so the just-arrived chunk is
 * already in the result set — there is no separate "append the current
 * chunk in memory" step needed, and none is done here.
 *
 * Writes only when the derived summary actually changed (by value, not
 * reference — `deriveTodoProgress` re-parses the whole history every call),
 * so a `TaskUpdate` that round-trips to an unchanged summary (e.g. an
 * unknown taskId, tolerated as a no-op by `deriveTodoProgress`) doesn't
 * churn the row. Never throws — same "detection bugs must not break run
 * settlement" contract as `detectCursorPlan` (plan §7); the caller wraps
 * this in try/catch too, belt-and-braces.
 */
function maybeUpdateTodoProgress(taskId: string): void {
  const events = runs.todoRelevantEventsForTask(taskId);
  const summary = summarizeTodoProgress(deriveTodoProgress(events));
  const task = tasks.get(taskId);
  if (!task) return;
  const current = task.todoProgress ?? null;
  const changed = summary === null
    ? current !== null
    : current === null || current.completed !== summary.completed || current.total !== summary.total;
  if (changed) tasks.update(taskId, { todoProgress: summary });
}

/**
 * Claude-code-only: detect and persist `ExitPlanMode` plan history from the
 * generic chunk stream, mirroring `detectCursorPlan`'s "pure helper in
 * task-plans.ts + thin DB-touching wrapper here" split. Unlike cursor's
 * detection (run-settlement only), this runs on every `tool_use`/
 * `tool_result` chunk as it arrives — claude's plan-approval loop is a live
 * keystroke-driven flow the run panel needs to reflect in near-real-time
 * (plan §3/§6), not just after the run resolves.
 *
 * - `tool_use` chunk with `name === "ExitPlanMode"` → `upsertClaudePlanFromExitPlanMode`
 *   records a `pending` plan keyed by the tool_use's `id`, superseding any
 *   prior pending claude plan.
 * - `tool_result` chunk whose `toolUseId` matches a `pending` claude plan →
 *   `resolveClaudePlan` transitions it to `approved` (capturing an edited
 *   plan when present) or `rejected`.
 *
 * Re-reads `tasks.get` rather than trusting a snapshot, same race-avoidance
 * rationale as `detectCursorPlan`: `plans` can be mutated concurrently (e.g.
 * a PATCH edit path on some other plan kind, or two chunks for the same task
 * landing in close succession), and both `task-plans.ts` helpers are pure
 * transforms over whatever array they're handed. Never throws — same
 * try/catch-at-call-site contract as `detectCursorPlan`.
 *
 * Two cheap pre-filters keep `JSON.parse` off the common-case chunk (this
 * runs on EVERY `tool_use`/`tool_result` chunk of every claude-code run —
 * assistant text/thinking chunks never reach here at all, but tool chunks
 * for ordinary tools like Read/Write/Bash are still the overwhelming
 * majority, and a large `tool_result` — a big file read, a long command's
 * output — is exactly the case where an unconditional parse is wasteful):
 *  - `tool_use`: skip unless `data` contains the literal `"name":"ExitPlanMode"`
 *    envelope substring (see `claude-tmux.ts`'s unspaced `JSON.stringify`).
 *  - `tool_result`: skip unless the task already has a `pending` claude plan
 *    — `resolveClaudePlan` only ever acts on a `tool_result` whose
 *    `toolUseId` matches an existing pending plan, so with none pending
 *    there is nothing this chunk could possibly resolve. This read is cheap
 *    relative to parsing a potentially large result body, and results in
 *    exactly one `tasks.get` either way (reused below, not re-fetched).
 */
function maybeTrackClaudePlan(taskId: string, runId: string, stream: RunEvent["stream"], data: string): void {
  let task: Task | null;
  if (stream === "tool_use") {
    if (!data.includes('"name":"ExitPlanMode"')) return;
    task = null; // fetched below, after confirming the parse is worthwhile
  } else if (stream === "tool_result") {
    task = tasks.get(taskId);
    if (!task || !task.plans.some((p) => p.status === "pending")) return;
  } else {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const chunk = parsed as Record<string, unknown>;

  if (stream === "tool_use") {
    if (chunk.name !== "ExitPlanMode") return;
    const toolCallId = chunk.id;
    if (typeof toolCallId !== "string" || toolCallId.length === 0) return;
    const input = chunk.input;
    if (!input || typeof input !== "object") return;
    const plan = (input as Record<string, unknown>).plan;
    if (typeof plan !== "string" || plan.trim() === "") return;

    task = tasks.get(taskId);
    if (!task) return;
    const next = upsertClaudePlanFromExitPlanMode(task.plans, {
      toolCallId,
      runId,
      content: plan,
      now: Date.now(),
    });
    if (next !== task.plans) tasks.update(taskId, { plans: next });
    return;
  }

  // tool_result — `task` was already fetched (and confirmed to have a
  // pending plan) by the pre-filter above.
  const toolUseId = chunk.toolUseId;
  if (typeof toolUseId !== "string" || toolUseId.length === 0) return;
  const content = chunk.content;
  const resultText = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .map((x) => (x && typeof x === "object" && (x as { type?: string }).type === "text" ? (x as { text?: string }).text ?? "" : ""))
        .join("")
      : "";
  if (!resultText) return;

  const next = resolveClaudePlan(task!.plans, toolUseId, resultText, Date.now());
  if (next !== task!.plans) tasks.update(taskId, { plans: next });
}

/**
 * Per-run chunk handler. Appends every event to `run_events`, fans out to
 * SSE listeners, and runs the claude API-error → `blocked` flip.
 *
 * Note: there is no longer a codex approval-prompt heuristic. Codex now runs
 * non-interactively via `codex exec --json` (`--full-auto` auto-approves;
 * `ask` falls back to a read-only sandbox), so it never emits an interactive
 * "waiting on approval" prompt to its output stream — the old raw-stdout
 * heuristic had no signal to match. `mode` is retained on the signature for
 * symmetry with the claude path and possible future use.
 */
function makeChunkHandler(
  runId: string,
  taskId: string,
  kind: AgentKind,
  _mode: Task["mode"],
) {
  return (stream: RunEvent["stream"], data: string, lineUuid?: string) => {
    runs.appendEvent(runId, stream, data, lineUuid);
    emit({ runId, taskId, stream, data, ts: Date.now() });
    // Todo/task-tools board summary: re-derive + persist on any
    // TodoWrite/TaskCreate/TaskUpdate chunk, for every agent kind. Cheap
    // substring pre-filter keeps the common case (unrelated chunks) a no-op.
    if (isTodoFamilyChunk(stream, data)) {
      try {
        maybeUpdateTodoProgress(taskId);
      } catch {
        // Never let todo-progress derivation break run settlement.
      }
    }
    // Claude plan history: ExitPlanMode tool_use/tool_result pairs, claude
    // only — cursor's plan detection stays exclusively in `detectCursorPlan`
    // at run settlement.
    if (kind === "claude-code") {
      try {
        maybeTrackClaudePlan(taskId, runId, stream, data);
      } catch {
        // Never let plan-history tracking break run settlement.
      }
    }
    // Claude API-error path: claude-tmux emits a sentinel status chunk on
    // synthetic `isApiErrorMessage` lines (529, 400, …) and resolves the
    // turn. Flip to `blocked` here so the card stops sitting in `running`,
    // and mark the handle so `attachDoneHandler` doesn't bounce it back to
    // `ready` when the resolution lands a moment later.
    if (
      kind === "claude-code"
      && stream === "status"
      && data.startsWith(CLAUDE_API_ERROR_STATUS_PREFIX)
    ) {
      const handle = active.get(runId);
      if (handle && !handle.apiError) {
        handle.apiError = true;
        const task = tasks.get(taskId);
        if (task && task.runId === runId) {
          updateColumn(taskId, runId, "blocked", "api-error");
        }
      }
    }
    // Session-died path (both agents): the driver emits this sentinel when a
    // running turn's tmux session vanished. Flip to `blocked` so the card
    // stops sitting in `running`, and mark the handle so `attachDoneHandler`
    // keeps it there (and records `failed`) when the run settles a beat later.
    if (stream === "status" && data.startsWith(SESSION_DIED_STATUS_PREFIX)) {
      const handle = active.get(runId);
      if (handle && !handle.sessionDied) {
        handle.sessionDied = true;
        const task = tasks.get(taskId);
        if (task && task.runId === runId) {
          updateColumn(taskId, runId, "blocked", "session-died");
        }
      }
    }
    // Unknown-slash-command path (claude-code only): claude's TUI rejected
    // the pasted message as an unknown slash command — no JSONL line was
    // ever written for it, so claude-tmux's pane scraper is the only source
    // of this sentinel. Flip to `blocked` here so the card stops sitting in
    // `running`, and mark the handle so `attachDoneHandler` doesn't bounce
    // it back to `ready` when the resolution lands a moment later.
    if (
      kind === "claude-code"
      && stream === "status"
      && data.startsWith(CLAUDE_UNKNOWN_COMMAND_STATUS_PREFIX)
    ) {
      const handle = active.get(runId);
      if (handle && !handle.unknownCommand) {
        handle.unknownCommand = true;
        const task = tasks.get(taskId);
        if (task && task.runId === runId) {
          updateColumn(taskId, runId, "blocked", "unknown-command");
        }
      }
    }
  };
}

function registerActiveRun(
  runId: string,
  taskId: string,
  task: Task,
  agent: ReturnType<typeof spawnAgent>,
): void {
  active.set(runId, {
    taskId,
    agent: task.agent,
    kill: () => agent.kill(),
    cancelled: false,
    apiError: false,
    sessionDied: false,
    unknownCommand: false,
    writeInput: (line) => agent.writeInput(line),
  });
}

/**
 * Cursor-only: when a run resolves `succeeded`, check whether its LAST
 * `tool_use` event is `createPlanToolCall` — cursor's "finished after
 * planning" signature (plan §2, confirmed 5/5 on real runs) — and if so,
 * persist a `TaskPlan` record on the task. Kind is resolved the same way
 * `sendInput`'s cursor branch resolves it (`resolveHarness(task.agent)?.kind`)
 * so an aliased harness (multi-account) is still recognized as cursor.
 *
 * Re-reads `tasks.get` rather than trusting the `task` snapshot the caller
 * already has — `attachDoneHandler`'s two call sites for a given task can in
 * principle race a concurrent `plans` write (e.g. a PATCH edit landing
 * between the caller's fetch and this running), and `upsertDetectedPlan` is
 * a pure transform over whatever `plans` array it's given, so reading fresh
 * avoids clobbering that write.
 *
 * Never throws — the caller wraps this in try/catch too (belt-and-braces),
 * but every internal failure mode (malformed JSON, missing/empty plan text,
 * unexpected shapes) already resolves to a silent no-op here, matching plan
 * §7: a detection failure must never break run settlement.
 */
function detectCursorPlan(task: Task, runId: string): void {
  if (resolveHarness(task.agent)?.kind !== "cursor") return;

  const lastToolUse = runs.lastToolUseData(runId);
  if (lastToolUse === null) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(lastToolUse);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const chunk = parsed as Record<string, unknown>;
  if (chunk.name !== "createPlanToolCall") return;

  const callId = chunk.id;
  if (typeof callId !== "string" || callId.length === 0) return;
  const input = chunk.input;
  if (!input || typeof input !== "object") return;
  const createPlanToolCall = (input as Record<string, unknown>).createPlanToolCall;
  if (!createPlanToolCall || typeof createPlanToolCall !== "object") return;
  const args = (createPlanToolCall as Record<string, unknown>).args;
  if (!args || typeof args !== "object") return;
  const plan = (args as Record<string, unknown>).plan;
  if (typeof plan !== "string" || plan.trim() === "") return;
  const nameRaw = (args as Record<string, unknown>).name;
  const name = typeof nameRaw === "string" ? nameRaw : null;

  const fresh = tasks.get(task.id);
  if (!fresh) return;
  const nextPlans = upsertDetectedPlan(fresh.plans, {
    toolCallId: callId,
    runId,
    name,
    content: plan,
    now: Date.now(),
  });
  if (nextPlans !== fresh.plans) tasks.update(task.id, { plans: nextPlans });
}

/**
 * Wire the per-run `done` promise to its terminal DB / event side-effects.
 * Pulled out so `startTask` and `sendInput` (which also creates run rows for
 * claude-code) can share the lifecycle handling.
 */
function attachDoneHandler(
  runId: string,
  taskId: string,
  agent: ReturnType<typeof spawnAgent>,
): void {
  agent.done
    .then((code) => {
      const handle = active.get(runId);
      const wasCancelled = handle?.cancelled ?? false;
      const wasApiError = handle?.apiError ?? false;
      const wasSessionDied = handle?.sessionDied ?? false;
      const wasUnknownCommand = handle?.unknownCommand ?? false;
      active.delete(runId);

      // API error / session-death / unknown-command override the exit-code
      // mapping: the driver resolves the turn with code 0 (a clean end_turn
      // was staged), but the run really failed — record it as such so the
      // badge and history are honest.
      const newStatus: RunStatus = wasCancelled
        ? "cancelled"
        : (wasApiError || wasSessionDied || wasUnknownCommand) ? "failed"
        : code === 0 ? "succeeded" : "failed";
      runs.update(runId, { status: newStatus, endedAt: Date.now(), exitCode: code });
      // Only flip the task's column when the run that just resolved is
      // still the latest one. If the user pipelined a follow-up while
      // this run was in flight, `task.runId` already points at the
      // queued run — leave the task in `running` so the UI doesn't
      // briefly bounce to `review`/`ready` between turns. The global
      // run-status emit is gated on the same condition so the toast
      // hook doesn't fire "succeeded" mid-conversation for a turn the
      // user has already moved past.
      const task = tasks.get(taskId);
      // Cursor plan detection: runs whenever THIS run resolved `succeeded`,
      // not gated on `isTerminalRun` — a folded/superseded run's tool_use
      // history is just as real, and `upsertDetectedPlan`'s supersede
      // transition already handles a newer plan landing while an older one
      // is still pending. Wrapped so a detection bug can never break run
      // settlement (plan §7 blast radius).
      if (newStatus === "succeeded" && task) {
        try {
          detectCursorPlan(task, runId);
        } catch {
          // Never let plan detection break run settlement.
        }
      }
      const isTerminalRun = !!task && task.runId === runId;
      if (isTerminalRun) {
        // A clean success with background agents still in flight is HELD in
        // `running` rather than advanced to `review` — the run finished but the
        // task's work hasn't. `runs.update(..., "succeeded")` already landed
        // above, so the concurrent-settle path (`maybeReleaseHeldTask`) reads
        // the correct terminal status; whichever of the two fires last wins and
        // both interleavings converge on the right column, so no lock is needed.
        // Give the subagent watcher one synchronous cycle before asking it
        // whether anything is still running. The rows that answer that
        // question are created by the watcher's own poll, and a task that has
        // not discovered a background agent yet polls on the SLOW/DEEP_IDLE
        // tier (4-10s) — while this runs ~END_TURN_IDLE_FIRE_MS after the
        // turn's end_turn. So an agent (or a `/workflow`) launched in the
        // closing moments of a turn is usually NOT in the DB yet at this
        // point, and the card would flip to `review` only to be dragged back
        // by `pullBackParkedTask` a few seconds later — a visible bounce and a
        // misleading breadcrumb. Pumping here reads the launch line that is
        // already on disk and makes the hold decision deterministic.
        try {
          pumpWatcherForHoldCheck(taskId);
        } catch {
          // Belt-and-braces: the callee already swallows its own errors, but a
          // watcher problem must never derail run settlement.
        }
        const holdForSubagents =
          newStatus === "succeeded"
          && !wasCancelled
          && !wasApiError
          && !wasSessionDied
          && !wasUnknownCommand
          && subagents.hasRunning(taskId);
        if (holdForSubagents) {
          const runningCount = subagents.runningCountForTask(taskId);
          emit({
            runId,
            taskId,
            stream: "status",
            data: `background agents still running (${runningCount}) — holding in running`,
            ts: Date.now(),
          });
        } else {
          // Cancellation wins over api-error here, matching the newStatus
          // resolution above — a user-cancelled run shouldn't land in
          // `blocked` just because it had previously hit an API error.
          const nextColumn: ColumnId = wasCancelled
            ? "ready"
            : (wasApiError || wasSessionDied || wasUnknownCommand) ? "blocked"
            : newStatus === "succeeded" ? "review" : "ready";
          updateColumn(taskId, runId, nextColumn);
        }
      }
      emit({
        runId,
        taskId,
        stream: "status",
        data: wasCancelled ? `cancelled (exit:${code})` : `exit:${code}`,
        ts: Date.now(),
      });
      if (isTerminalRun) {
        emitGlobal({ kind: "run-status", taskId, runId, status: newStatus, ts: Date.now() });
      }
      // Spawn the next queued codex/cursor/gemini/fx follow-up, if any (no-op
      // for a task of a different kind).
      drainCodexQueue(taskId);
      drainCursorQueue(taskId);
      drainGeminiQueue(taskId);
      drainFxQueue(taskId);
    })
    .catch((err) => {
      const handle = active.get(runId);
      const wasCancelled = handle?.cancelled ?? false;
      const wasSessionDied = handle?.sessionDied ?? false;
      const wasUnknownCommand = handle?.unknownCommand ?? false;
      active.delete(runId);
      const newStatus: RunStatus = wasCancelled ? "cancelled" : "failed";
      runs.update(runId, { status: newStatus, endedAt: Date.now(), exitCode: -1 });
      const task = tasks.get(taskId);
      const isTerminalRun = !!task && task.runId === runId;
      if (isTerminalRun) {
        // A session-death / unknown-command that reaches the reject path (not
        // the case today — both drivers resolve on these — but keep the
        // column consistent with the resolve path if a future refactor ever
        // rejects instead).
        updateColumn(taskId, runId, (wasSessionDied || wasUnknownCommand) ? "blocked" : "ready");
      }
      emit({
        runId,
        taskId,
        stream: wasCancelled ? "status" : "stderr",
        data: wasCancelled ? "cancelled" : String(err),
        ts: Date.now(),
      });
      if (isTerminalRun) {
        emitGlobal({ kind: "run-status", taskId, runId, status: newStatus, ts: Date.now() });
      }
      // Spawn the next queued codex/cursor/gemini/fx follow-up, if any (no-op
      // for a task of a different kind).
      drainCodexQueue(taskId);
      drainCursorQueue(taskId);
      drainGeminiQueue(taskId);
      drainFxQueue(taskId);
    });
}

/**
 * Apply inline config edits to a live tmux session where possible — keeps
 * the claude conversation alive (and its accumulated context) across
 * mode/model/effort changes. Called by the PATCH /tasks/:id route after the
 * DB row is updated.
 *
 *   • Agent change (claude ↔ codex ↔ cursor ↔ gemini): kills any claude tmux
 *     session we had for this task. The new agent will spawn fresh on next Run.
 *   • Same-agent mode / model / effort change on a live claude session:
 *     for `/model` and `/effort` send the real slash command; for the
 *     permission mode there is no slash command, so we call `cycleToMode`
 *     which sends Shift+Tab keystrokes (or `/plan` when the target is plan).
 *     The session keeps running with the new posture.
 *   • Anything else (codex, cursor, gemini; no live session): no-op — the
 *     change just persists for the next spawn.
 */
export async function reconcileTaskSession(taskId: string, before: Task, after: Task): Promise<void> {
  const beforeKind = resolveHarness(before.agent)?.kind ?? null;
  const afterKind = resolveHarness(after.agent)?.kind ?? null;
  // Treat any harness id change as a session-killing event for claude — the
  // alias's HOME/env block changes, so the on-disk JSONL & login differ. Even
  // same-kind alias swaps (claude-work → claude-personal) need a fresh tmux.
  if (before.agent !== after.agent) {
    if (beforeKind === "claude-code") dropSession(taskId);
    else if (beforeKind === "codex") dropCodexSession(taskId);
    else if (beforeKind === "cursor") dropCursorSession(taskId);
    else if (beforeKind === "gemini") dropGeminiSession(taskId);
    else if (beforeKind === "fx") dropFxSession(taskId);
    // Any queued codex/cursor/gemini/fx follow-ups belong to the old agent —
    // drop them so a later drain doesn't spawn them against the new harness.
    codexTurnQueue.delete(taskId);
    cursorTurnQueue.delete(taskId);
    geminiTurnQueue.delete(taskId);
    fxTurnQueue.delete(taskId);
    // Cross-kind switches (e.g. claude-code → codex alias) leave mode/
    // model/effort ids that belong to the old kind's option set; the
    // next spawn would error or fall through to verbatim flags. Reset
    // them server-side so direct API edits get the same safety the
    // RunPanel's `onAgentChange` already applies client-side. Same-kind
    // alias swaps keep the picks — those ids stay valid.
    if (afterKind && beforeKind !== afterKind) {
      const nextMode = AGENT_OPTIONS[afterKind].modes[0]?.id ?? "auto";
      tasks.update(taskId, { mode: nextMode, model: null, effort: null, fast: false, maxMode: false });
    }
    return;
  }
  if (afterKind !== "claude-code") return;
  if (!sessionExists(taskId)) return;

  // `after.mode` guard: a PATCH that clears the mode (mode → null) leaves
  // the live session alone — the UI doesn't expose a "clear mode" control
  // and there's no canonical "unset" mode to dial claude back to, so
  // silently keeping the current posture is the least-surprising option.
  if (before.mode !== after.mode && after.mode) {
    const result = await cycleToMode(taskId, after.mode);
    emitModeChangeStatus(taskId, after.mode, result);
    // Only refresh the PreToolUse matcher when the mode change actually
    // took effect. Otherwise we'd narrow the matcher (e.g. to bypass's
    // narrow-no-mcp scope) while claude is still in the old mode — the
    // hook stops firing for routine Bash but claude's own permission
    // modal still pops inside tmux, deadlocking the run. The matcher is
    // set at spawn-time by `ensureInstalledForCwd` (narrow for auto/
    // bypass, full for everything else); leaving it in place on a
    // failed cycle preserves the existing intercept-and-surface flow,
    // which is the right fallback for "we couldn't switch modes."
    if (result.ok) {
      const cwd = after.worktreePath ?? after.workdir;
      const refreshed = ensureInstalledForCwd(cwd, after.mode);
      if (!refreshed) emitMatcherRefreshFailure(taskId, cwd);
    }
  }
  if (before.model !== after.model && after.model) {
    sendSlashCommand(taskId, `/model ${toClaudeModelArg(after.model)}`);
  }
  if (before.effort !== after.effort && after.effort) {
    sendSlashCommand(taskId, `/effort ${after.effort}`);
  }
}

/**
 * Surface a `cycleToMode` outcome on the task's most recent run so the user
 * sees it in the run panel. Both success and skip ride the `status` stream
 * — skipping is an orchestrator-side decision (e.g. asking for `bypass` on
 * a session that wasn't launched with the flag), not an agent error, so
 * `stderr` would mislead the user into thinking claude crashed. We
 * disambiguate with a "⚠️" prefix on the skip case. Silent when there's no
 * run row to attach to (shouldn't happen — a live tmux session implies at
 * least one prior run — but defensive).
 */
function emitModeChangeStatus(
  taskId: string,
  agetorMode: string,
  result: CycleResult,
): void {
  const recent = runs.listForTask(taskId)[0];
  if (!recent) return;
  const runId = recent.id;
  const ts = Date.now();
  const data = result.ok
    ? (result.via === "noop"
      ? null
      : `mode → ${agetorMode} (${result.via === "slash-plan" ? "via /plan" : `via Shift+Tab ×${result.presses}`})`)
    : formatModeChangeFailure(agetorMode, result);
  if (!data) return;
  runs.appendEvent(runId, "status", data);
  emit({ runId, taskId, stream: "status", data, ts });
}

/**
 * Tell the user when the PreToolUse hook matcher couldn't be rewritten
 * after a successful mode change. The mode itself did take effect on the
 * live session, so the user sees claude responding to the new posture —
 * but the on-disk matcher is stale, which on the next spawn (or on a
 * mid-session settings-reread, if claude does that) would surface routine
 * tools as approvals (or, in the other direction, swallow ones the user
 * wanted prompts for). The most common cause is the user having
 * hand-edited `.claude/settings.local.json` into malformed JSON — point
 * them at the file so they can fix it.
 */
function emitMatcherRefreshFailure(taskId: string, cwd: string): void {
  const recent = runs.listForTask(taskId)[0];
  if (!recent) return;
  const data = `⚠️ mode took effect but the hook matcher couldn't be refreshed — check ${cwd}/.claude/settings.local.json for malformed JSON. The matcher will sync on the next session start.`;
  runs.appendEvent(recent.id, "status", data);
  emit({ runId: recent.id, taskId, stream: "status", data, ts: Date.now() });
}

/**
 * Build the user-facing warning string for an unsuccessful `cycleToMode`
 * outcome. Switch is exhaustive on `result.reason` (a literal union); the
 * TS compiler flags any future reason that isn't handled here. The
 * verification-* reasons carry the most diagnostic value — we surface
 * the observed mode so the user can see exactly where claude landed.
 */
function formatModeChangeFailure(agetorMode: string, result: Extract<CycleResult, { ok: false }>): string {
  const seen = result.lastObserved ?? "unknown";
  switch (result.reason) {
    case "verification timed out": {
      // The auto opt-in modal is by far the most common reason a press
      // produces no JSONL event, but only when the target is `auto`. For
      // any other target the modal advice is misleading, so we drop it.
      const tail = agetorMode === "auto"
        ? " If this is the first time cycling to auto on this account, accept the opt-in prompt in the run panel and try again."
        : "";
      return `⚠️ mode change to ${agetorMode}: claude didn't acknowledge after ${result.attempts ?? "?"} attempt(s) (last seen: ${seen}).${tail}`;
    }
    case "verification mismatch":
      return `⚠️ mode change to ${agetorMode} failed after ${result.attempts ?? "?"} attempt(s) (claude landed on ${seen}). Your account may not have access to this mode — pick a different one in the task details.`;
    case "mode not in cycle":
      return `⚠️ mode change to ${agetorMode} skipped: '${result.target ?? agetorMode}' isn't in this session's Shift+Tab cycle — stop the run and start again with that mode at launch.`;
    case "no live session":
    case "current mode unknown":
      return `⚠️ mode change to ${agetorMode} skipped: ${result.reason} — stop the run and start again to apply.`;
  }
}

/**
 * Stop the active handle `h`'s task. `kill()` sends Ctrl+C to the tmux
 * session, which also clears claude's queued-input buffer, so every queued
 * run in this task is going down too. Mark each active handle as cancelled
 * so their done handlers record "cancelled" (not "failed") when their
 * slot's reject fires. Resolve any in-flight approval / question for this
 * task BEFORE the interrupt — otherwise the hook script's curl and the MCP
 * server's fetch would sit on a doomed HTTP response until their own
 * timeouts. Shared by `cancelRun` (Stop button) and `archiveTask`
 * (`stopRun`) so the two can't drift.
 */
function stopActiveHandle(h: ActiveRun, reason: string): void {
  for (const [, handle] of active) {
    if (handle.taskId === h.taskId) handle.cancelled = true;
  }
  cancelPendingForTask(h.taskId, reason);
  h.kill();
}

/**
 * Stop a task that's "held" (see `isHeldByBackgroundAgents`) — its terminal
 * run already succeeded but background agents are still running, so there's
 * no `active` handle to kill. Interrupt the live session and release the
 * hold. Shared by `cancelRun` (Stop button) and `archiveTask` (`stopRun`).
 */
function stopHeldTask(taskId: string, reason: string): void {
  cancelPendingForTask(taskId, reason);
  interruptTaskSession(taskId);
  orphanRunningSubagents(taskId);
}

export function cancelRun(runId: string): boolean {
  const h = active.get(runId);
  if (!h) {
    // A held task (turn succeeded, background agents still running) has no
    // `active` handle — `attachDoneHandler` dropped it before parking the card
    // in `running`. Its Stop button must still do something, or a background
    // agent that wedges without dying leaves the user no way out short of a
    // restart. Interrupt the live session and release the hold; the run itself
    // already succeeded, so the card advances to `review`.
    const taskId = runs.get(runId)?.taskId;
    if (!taskId || !isHeldByBackgroundAgents(taskId)) return false;
    stopHeldTask(taskId, "cancelled by user");
    return true;
  }
  // Stop targets the whole task, not just one run.
  stopActiveHandle(h, "cancelled by user");
  return true;
}

export type SendInputResult =
  | { delivered: true; runId: string }
  | { delivered: false; reason: string };

/**
 * Forward a line of user-supplied input to the agent. Behavior depends on
 * agent kind:
 *
 *   • claude-code: when the session is idle, each user message is its own
 *     turn → its own run row (paste into the live tmux session + a new turn
 *     slot via `sendTurn`). When a turn is already in flight, the message is
 *     *folded* into the active run instead (`pasteFollowUp` — paste into the
 *     session, record a user event on the current run, no new row/slot). This
 *     keeps at most one in-flight run per task so claude coalescing queued
 *     messages can't strand surplus run rows in `running`. See
 *     `sendTurnInExistingSession`.
 *
 *   • codex: each follow-up is queued and spawned as its own `codex exec
 *     resume <thread_id>` turn once the active turn resolves — codex `exec`
 *     is a one-shot process, not a REPL, so there's no live stdin to write
 *     to mid-turn. See `sendCodexTurn`/`drainCodexQueue`.
 *
 *   • cursor: same queue-and-resume shape as codex (`sendCursorTurn`/
 *     `drainCursorQueue`), spawning a fresh `cursor-agent --resume
 *     <session-id>` turn for each queued follow-up — cursor's CLI is
 *     one-shot per turn too.
 *
 *   • gemini: same queue-and-resume shape as codex (`sendGeminiTurn`/
 *     `drainGeminiQueue`), spawning `gemini --resume <session-id>` for each
 *     queued follow-up — gemini's CLI is one-shot per turn too.
 *
 *   • fx: same queue-and-resume shape as codex/cursor/gemini (`sendFxTurn`/
 *     `drainFxQueue`), resuming via fx's ACP session id for each queued
 *     follow-up — fx has no persistent REPL either (see fx-acp.ts).
 *
 * Archived / detached-worktree restore: a message to an archived task
 * auto-unarchives it (sending is an unambiguous signal of continued
 * interest), and if the task's worktree was detached (by archive) or is
 * otherwise missing on disk, it's rematerialized via `prepareWorkdir` before
 * dispatch — same deterministic path, branch, and history, so the resumed
 * turn lands in the same place the agent left off. A hard restore failure
 * (e.g. the branch was deleted or checked out elsewhere) is surfaced as a
 * `delivered: false` result rather than silently falling back to an
 * unisolated cwd.
 */
export async function sendInput(runId: string, line: string): Promise<SendInputResult> {
  const row = db.query<{ task_id: string; agent: string }, [string]>(
    `SELECT task_id, agent FROM runs WHERE id = ?`,
  ).get(runId);
  if (!row) return { delivered: false, reason: "run not found" };

  const task = tasks.get(row.task_id);
  if (!task) return { delivered: false, reason: "task not found" };

  if (task.archivedAt != null) {
    tasks.update(row.task_id, { archivedAt: null });
  }

  // Same race as unarchiveTask/startTask: a deferred archive teardown may
  // still be removing this task's worktree — let it finish before the
  // existsSync check decides whether a restore is needed.
  await pendingTeardown(row.task_id);

  if (task.worktreePath && !existsSync(task.worktreePath)) {
    // Re-fetch so the restore sees the just-cleared archivedAt (prepareWorkdir
    // doesn't care about it, but keeping the object fresh avoids acting on a
    // stale snapshot).
    const fresh = tasks.get(row.task_id) ?? task;
    try {
      const restored = await prepareWorkdir(fresh);
      if ("error" in restored) {
        return { delivered: false, reason: `worktree restore failed: ${restored.error}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { delivered: false, reason: `worktree restore failed: ${msg}` };
    }
  }

  const kind = resolveHarness(row.agent)?.kind;
  if (kind === "claude-code") {
    const result = sendClaudeTurn(row.task_id, line);
    return result
      ? { delivered: true, runId: result }
      : { delivered: false, reason: "internal: task lookup failed" };
  }
  if (kind === "codex") {
    const result = sendCodexTurn(row.task_id, line);
    return result
      ? { delivered: true, runId: result }
      : { delivered: false, reason: "internal: task lookup failed" };
  }
  if (kind === "cursor") {
    const result = sendCursorTurn(row.task_id, line);
    return result
      ? { delivered: true, runId: result }
      : { delivered: false, reason: "internal: task lookup failed" };
  }
  if (kind === "gemini") {
    const result = sendGeminiTurn(row.task_id, line);
    return result
      ? { delivered: true, runId: result }
      : { delivered: false, reason: "internal: task lookup failed" };
  }
  if (kind === "fx") {
    const result = sendFxTurn(row.task_id, line);
    return result
      ? { delivered: true, runId: result }
      : { delivered: false, reason: "internal: task lookup failed" };
  }
  return { delivered: false, reason: `unknown agent kind for "${row.agent}"` };
}

/**
 * Per-task queue of follow-up lines received while a codex turn is in flight.
 * codex `exec` can't take conversational input mid-turn (it's not a REPL), so
 * we hold the message and spawn a fresh `codex exec resume` turn for it once
 * the active turn resolves (`drainCodexQueue`, called from
 * `attachDoneHandler`). This is the codex analogue of claude's fold-while-busy
 * — but codex turns are discrete processes, so it's a real FIFO, not a
 * paste-into-the-live-session fold.
 */
const codexTurnQueue = new Map<string, string[]>();

/**
 * Send a follow-up to a codex task. Each follow-up is its own run row + its own
 * `codex exec resume <thread_id>` turn (sequential-turn model). When a turn is
 * already running, the message is queued; otherwise it spawns immediately.
 * Returns the run id the message was attached to, or null on lookup failure.
 */
function sendCodexTurn(taskId: string, line: string): string | null {
  const task = tasks.get(taskId);
  if (!task) return null;
  if (task.runId && active.has(task.runId)) {
    const q = codexTurnQueue.get(taskId) ?? [];
    q.push(line);
    codexTurnQueue.set(taskId, q);
    // Record the user bubble on the active run so the panel reflects it right
    // away; the queued turn that answers it lands as a later run row.
    const runId = task.runId;
    const data = normalizeUserText(line);
    runs.appendEvent(runId, "user", data);
    emit({ runId, taskId, stream: "user", data, ts: Date.now() });
    return runId;
  }
  return spawnCodexTurnNow(task, taskId, line);
}

/**
 * Spawn a fresh codex turn that resumes the task's prior conversation via
 * `codex exec resume <thread_id>`. New run row, new tmux session (the previous
 * turn's exited), same `thread_id` carried forward.
 */
function spawnCodexTurnNow(task: Task, taskId: string, line: string): string {
  const priorThreadId = findLastCodexSessionId(taskId);
  const cwd = task.worktreePath ?? task.workdir;
  const harness = resolveHarness(task.agent);

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
    tmuxSession: sessionNameFor(taskId),
    claudeSessionId: null,
    // Carry the thread id forward up front so a reattach mid-turn finds it even
    // before this run's own `thread.started` re-emits it. onSessionId below
    // re-stamps the same value (idempotent).
    codexSessionId: priorThreadId,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
  });
  const prevColumn: ColumnId = task.column;
  tasks.update(taskId, { column: "running", runId: newRunId });
  if (prevColumn !== "running") {
    emitGlobal({ kind: "column", taskId, runId: newRunId, column: "running", prev: prevColumn, ts: now });
  }

  const kind: AgentKind = harness?.kind ?? "codex";
  const onChunk = makeChunkHandler(newRunId, taskId, kind, task.mode);
  onChunk("user", normalizeUserText(line));
  onChunk(
    "status",
    priorThreadId
      ? `resuming codex thread ${priorThreadId.slice(0, 8)}…`
      : "no prior codex thread — starting fresh",
  );

  if (!harness) {
    onChunk("stderr", `harness "${task.agent}" not found — cannot resume`);
    runs.update(newRunId, { status: "failed", endedAt: Date.now(), exitCode: -1 });
    tasks.update(taskId, { column: "ready", runId: null });
    return newRunId;
  }

  const agent = spawnAgentOrFail({
    taskId,
    runId: newRunId,
    harness,
    prompt: line,
    cwd,
    onChunk,
    onSessionId: (sessionId) => {
      runs.update(newRunId, { codexSessionId: sessionId });
    },
    opts: {
      mode: task.mode,
      model: task.model ?? DEFAULT_MODEL[harness.kind],
      effort: task.effort,
      fast: task.fast,
      maxMode: task.maxMode,
      resumeSessionId: priorThreadId,
    },
  });
  if (!agent) return newRunId;
  registerActiveRun(newRunId, taskId, task, agent);
  attachDoneHandler(newRunId, taskId, agent);
  return newRunId;
}

/**
 * After a codex turn resolves, spawn the next queued follow-up (if any) as a
 * fresh resume turn. No-op for claude tasks (their queue is always empty) and
 * while a run is still active for the task.
 */
function drainCodexQueue(taskId: string): void {
  const q = codexTurnQueue.get(taskId);
  if (!q || q.length === 0) return;
  const task = tasks.get(taskId);
  // Task vanished, or its agent was switched away from codex while a turn was
  // in flight — abandon the stale queue. Without this guard, draining after a
  // codex→claude switch would spawn the follow-up against the new claude
  // harness with a codex thread id (`claude --resume <codexThreadId>`), which
  // claude rejects.
  if (!task || resolveHarness(task.agent)?.kind !== "codex") {
    codexTurnQueue.delete(taskId);
    return;
  }
  if (task.runId && active.has(task.runId)) return;
  const next = q.shift();
  if (q.length === 0) codexTurnQueue.delete(taskId);
  if (next !== undefined) spawnCodexTurnNow(task, taskId, next);
}

/** Most-recent codex thread id across the task's runs (for `resume`). */
function findLastCodexSessionId(taskId: string): string | null {
  const row = db.query<{ codex_session_id: string }, [string]>(
    `SELECT codex_session_id FROM runs
     WHERE task_id = ? AND codex_session_id IS NOT NULL
     ORDER BY started_at DESC
     LIMIT 1`,
  ).get(taskId);
  return row?.codex_session_id ?? null;
}

/**
 * Per-task queue of follow-up lines received while a cursor turn is in
 * flight. `cursor-agent -p` is one-shot per invocation (not a REPL), so we
 * hold the message and spawn a fresh `cursor-agent --resume <session_id>`
 * turn for it once the active turn resolves (`drainCursorQueue`, called from
 * `attachDoneHandler`). Structural clone of `codexTurnQueue` — see that
 * comment for the full rationale.
 */
const cursorTurnQueue = new Map<string, string[]>();

/**
 * Send a follow-up to a cursor task. Each follow-up is its own run row + its
 * own `cursor-agent --resume <session_id>` turn (sequential-turn model). When
 * a turn is already running, the message is queued; otherwise it spawns
 * immediately. Returns the run id the message was attached to, or null on
 * lookup failure.
 */
function sendCursorTurn(taskId: string, line: string): string | null {
  const task = tasks.get(taskId);
  if (!task) return null;
  if (task.runId && active.has(task.runId)) {
    const q = cursorTurnQueue.get(taskId) ?? [];
    q.push(line);
    cursorTurnQueue.set(taskId, q);
    // Record the user bubble on the active run so the panel reflects it right
    // away; the queued turn that answers it lands as a later run row.
    const runId = task.runId;
    const data = normalizeUserText(line);
    runs.appendEvent(runId, "user", data);
    emit({ runId, taskId, stream: "user", data, ts: Date.now() });
    return runId;
  }
  return spawnCursorTurnNow(task, taskId, line);
}

/**
 * Spawn a fresh cursor turn that resumes the task's prior conversation via
 * `cursor-agent --resume <session_id>`. New run row, new tmux session (the
 * previous turn's exited), same `session_id` carried forward.
 */
function spawnCursorTurnNow(task: Task, taskId: string, line: string): string {
  const priorSessionId = findLastCursorSessionId(taskId);
  const cwd = task.worktreePath ?? task.workdir;
  const harness = resolveHarness(task.agent);

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
    tmuxSession: sessionNameFor(taskId),
    claudeSessionId: null,
    codexSessionId: null,
    // Carry the session id forward up front so a reattach mid-turn finds it
    // even before this run's own first event re-emits it. onSessionId below
    // re-stamps the same value (idempotent).
    cursorSessionId: priorSessionId,
    geminiSessionId: null,
    fxSessionId: null,
  });
  const prevColumn: ColumnId = task.column;
  tasks.update(taskId, { column: "running", runId: newRunId });
  if (prevColumn !== "running") {
    emitGlobal({ kind: "column", taskId, runId: newRunId, column: "running", prev: prevColumn, ts: now });
  }

  const kind: AgentKind = harness?.kind ?? "cursor";
  const onChunk = makeChunkHandler(newRunId, taskId, kind, task.mode);
  onChunk("user", normalizeUserText(line));
  onChunk(
    "status",
    priorSessionId
      ? `resuming cursor session ${priorSessionId.slice(0, 8)}…`
      : "no prior cursor session — starting fresh",
  );

  if (!harness) {
    onChunk("stderr", `harness "${task.agent}" not found — cannot resume`);
    runs.update(newRunId, { status: "failed", endedAt: Date.now(), exitCode: -1 });
    tasks.update(taskId, { column: "ready", runId: null });
    return newRunId;
  }

  const agent = spawnAgentOrFail({
    taskId,
    runId: newRunId,
    harness,
    prompt: line,
    cwd,
    onChunk,
    onSessionId: (sessionId) => {
      runs.update(newRunId, { cursorSessionId: sessionId });
    },
    opts: {
      mode: task.mode,
      model: task.model ?? DEFAULT_MODEL[harness.kind],
      effort: task.effort,
      fast: task.fast,
      maxMode: task.maxMode,
      // Same generic resume-session field claude-code and codex already
      // thread through `spawnAgent` → `buildCommand` — cursor's `session_id`
      // rides the same `AgentRunOptions.resumeSessionId` contract rather than
      // a cursor-specific field name (see this function's file-level header
      // note on the resume option-field contract).
      resumeSessionId: priorSessionId,
    },
  });
  if (!agent) return newRunId;
  registerActiveRun(newRunId, taskId, task, agent);
  attachDoneHandler(newRunId, taskId, agent);
  return newRunId;
}

/**
 * After a cursor turn resolves, spawn the next queued follow-up (if any) as a
 * fresh resume turn. No-op for claude/codex/gemini tasks (their queue is
 * always empty) and while a run is still active for the task.
 */
function drainCursorQueue(taskId: string): void {
  const q = cursorTurnQueue.get(taskId);
  if (!q || q.length === 0) return;
  const task = tasks.get(taskId);
  // Task vanished, or its agent was switched away from cursor while a turn
  // was in flight — abandon the stale queue. Without this guard, draining
  // after a cursor→claude/codex/gemini switch would spawn the follow-up
  // against the new harness with a cursor session id, which the new harness
  // rejects.
  if (!task || resolveHarness(task.agent)?.kind !== "cursor") {
    cursorTurnQueue.delete(taskId);
    return;
  }
  if (task.runId && active.has(task.runId)) return;
  const next = q.shift();
  if (q.length === 0) cursorTurnQueue.delete(taskId);
  if (next !== undefined) spawnCursorTurnNow(task, taskId, next);
}

/** Most-recent cursor session id across the task's runs (for `--resume`). */
function findLastCursorSessionId(taskId: string): string | null {
  const row = db.query<{ cursor_session_id: string }, [string]>(
    `SELECT cursor_session_id FROM runs
     WHERE task_id = ? AND cursor_session_id IS NOT NULL
     ORDER BY started_at DESC
     LIMIT 1`,
  ).get(taskId);
  return row?.cursor_session_id ?? null;
}

/**
 * Per-task queue of follow-up lines received while a gemini turn is in
 * flight. Gemini's CLI is one-shot per turn (not a REPL), so — exactly like
 * codex — we hold the message and spawn a fresh `--resume <uuid>` turn for it
 * once the active turn resolves (`drainGeminiQueue`, called from
 * `attachDoneHandler`).
 */
const geminiTurnQueue = new Map<string, string[]>();

/**
 * Send a follow-up to a gemini task. Each follow-up is its own run row + its
 * own `gemini --resume <uuid>` turn (sequential-turn model, same as codex).
 * When a turn is already running, the message is queued; otherwise it spawns
 * immediately. Returns the run id the message was attached to, or null on
 * lookup failure.
 */
function sendGeminiTurn(taskId: string, line: string): string | null {
  const task = tasks.get(taskId);
  if (!task) return null;
  if (task.runId && active.has(task.runId)) {
    const q = geminiTurnQueue.get(taskId) ?? [];
    q.push(line);
    geminiTurnQueue.set(taskId, q);
    // Record the user bubble on the active run so the panel reflects it right
    // away; the queued turn that answers it lands as a later run row.
    const runId = task.runId;
    const data = normalizeUserText(line);
    runs.appendEvent(runId, "user", data);
    emit({ runId, taskId, stream: "user", data, ts: Date.now() });
    return runId;
  }
  return spawnGeminiTurnNow(task, taskId, line);
}

/**
 * Spawn a fresh gemini turn that resumes the task's prior conversation via
 * `gemini --resume <uuid>`. New run row, new tmux session (the previous
 * turn's exited), same self-issued session uuid carried forward — unlike
 * codex's thread id (discovered post-hoc from `thread.started`), gemini's
 * session id is already known synchronously, so it's stamped on the new run
 * row directly rather than via an `onSessionId` re-stamp.
 */
function spawnGeminiTurnNow(task: Task, taskId: string, line: string): string {
  const priorSessionId = findLastGeminiSessionId(taskId);
  const cwd = task.worktreePath ?? task.workdir;
  const harness = resolveHarness(task.agent);

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
    tmuxSession: sessionNameFor(taskId),
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: priorSessionId,
    fxSessionId: null,
  });
  const prevColumn: ColumnId = task.column;
  tasks.update(taskId, { column: "running", runId: newRunId });
  if (prevColumn !== "running") {
    emitGlobal({ kind: "column", taskId, runId: newRunId, column: "running", prev: prevColumn, ts: now });
  }

  const kind: AgentKind = harness?.kind ?? "gemini";
  const onChunk = makeChunkHandler(newRunId, taskId, kind, task.mode);
  onChunk("user", normalizeUserText(line));
  onChunk(
    "status",
    priorSessionId
      ? `resuming gemini session ${priorSessionId.slice(0, 8)}…`
      : "no prior gemini session — starting fresh",
  );

  if (!harness) {
    onChunk("stderr", `harness "${task.agent}" not found — cannot resume`);
    runs.update(newRunId, { status: "failed", endedAt: Date.now(), exitCode: -1 });
    tasks.update(taskId, { column: "ready", runId: null });
    return newRunId;
  }

  const agent = spawnAgentOrFail({
    taskId,
    runId: newRunId,
    harness,
    prompt: line,
    cwd,
    onChunk,
    // Normally re-stamps the same `priorSessionId` already written above
    // (idempotent) — kept for the edge case where a task somehow has no
    // prior session id yet (spawnAgent mints a fresh uuid via
    // crypto.randomUUID() when resumeSessionId is absent, and this is the
    // only way that freshly-minted id gets persisted).
    onSessionId: (sessionId) => {
      runs.update(newRunId, { geminiSessionId: sessionId });
    },
    opts: {
      mode: task.mode,
      model: task.model ?? DEFAULT_MODEL[harness.kind],
      effort: task.effort,
      fast: task.fast,
      maxMode: task.maxMode,
      resumeSessionId: priorSessionId,
    },
  });
  if (!agent) return newRunId;
  registerActiveRun(newRunId, taskId, task, agent);
  attachDoneHandler(newRunId, taskId, agent);
  return newRunId;
}

/**
 * After a gemini turn resolves, spawn the next queued follow-up (if any) as a
 * fresh resume turn. No-op while a run is still active for the task, or if
 * the task's agent was switched away from gemini mid-flight.
 */
function drainGeminiQueue(taskId: string): void {
  const q = geminiTurnQueue.get(taskId);
  if (!q || q.length === 0) return;
  const task = tasks.get(taskId);
  // Task vanished, or its agent was switched away from gemini while a turn
  // was in flight — abandon the stale queue. Without this guard, draining
  // after a gemini→claude switch would spawn the follow-up against the new
  // claude harness with a gemini session id, which claude rejects.
  if (!task || resolveHarness(task.agent)?.kind !== "gemini") {
    geminiTurnQueue.delete(taskId);
    return;
  }
  if (task.runId && active.has(task.runId)) return;
  const next = q.shift();
  if (q.length === 0) geminiTurnQueue.delete(taskId);
  if (next !== undefined) spawnGeminiTurnNow(task, taskId, next);
}

/** Most-recent gemini session id across the task's runs (for `--resume`). */
function findLastGeminiSessionId(taskId: string): string | null {
  const row = db.query<{ gemini_session_id: string }, [string]>(
    `SELECT gemini_session_id FROM runs
     WHERE task_id = ? AND gemini_session_id IS NOT NULL
     ORDER BY started_at DESC
     LIMIT 1`,
  ).get(taskId);
  return row?.gemini_session_id ?? null;
}

/**
 * Per-task queue of follow-up lines received while an fx turn is in flight.
 * fx is driven over ACP/stdio (`fx-acp.ts`), one turn per spawn — no
 * persistent REPL, no tmux session — so exactly like codex/cursor/gemini we
 * hold the message and spawn a fresh resumed turn once the active turn
 * resolves (`drainFxQueue`, called from `attachDoneHandler`).
 */
const fxTurnQueue = new Map<string, string[]>();

/**
 * Send a follow-up to an fx task. Each follow-up is its own run row + its own
 * resumed ACP turn (sequential-turn model, same as codex/cursor/gemini). When
 * a turn is already running, the message is queued; otherwise it spawns
 * immediately. Returns the run id the message was attached to, or null on
 * lookup failure.
 */
function sendFxTurn(taskId: string, line: string): string | null {
  const task = tasks.get(taskId);
  if (!task) return null;
  if (task.runId && active.has(task.runId)) {
    const q = fxTurnQueue.get(taskId) ?? [];
    q.push(line);
    fxTurnQueue.set(taskId, q);
    // Record the user bubble on the active run so the panel reflects it right
    // away; the queued turn that answers it lands as a later run row.
    const runId = task.runId;
    const data = normalizeUserText(line);
    runs.appendEvent(runId, "user", data);
    emit({ runId, taskId, stream: "user", data, ts: Date.now() });
    return runId;
  }
  return spawnFxTurnNow(task, taskId, line);
}

/**
 * Spawn a fresh fx turn that resumes the task's prior conversation via fx's
 * ACP session id. New run row, new spawn — fx has no persistent tmux session
 * to reuse (see fx-acp.ts) — same session id carried forward. Like codex's
 * thread id, fx's session id is DISCOVERED post-hoc (from ACP's `session/new`
 * response), so it's carried forward on the insert below and re-stamped
 * (idempotently) once `onSessionId` fires again for this turn.
 */
function spawnFxTurnNow(task: Task, taskId: string, line: string): string {
  const priorSessionId = findLastFxSessionId(taskId);
  const cwd = task.worktreePath ?? task.workdir;
  const harness = resolveHarness(task.agent);

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
    tmuxSession: sessionNameFor(taskId),
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: priorSessionId,
  });
  const prevColumn: ColumnId = task.column;
  tasks.update(taskId, { column: "running", runId: newRunId });
  if (prevColumn !== "running") {
    emitGlobal({ kind: "column", taskId, runId: newRunId, column: "running", prev: prevColumn, ts: now });
  }

  const kind: AgentKind = harness?.kind ?? "fx";
  const onChunk = makeChunkHandler(newRunId, taskId, kind, task.mode);
  onChunk("user", normalizeUserText(line));
  onChunk(
    "status",
    priorSessionId
      ? `resuming fx session ${priorSessionId.slice(0, 8)}…`
      : "no prior fx session — starting fresh",
  );

  if (!harness) {
    onChunk("stderr", `harness "${task.agent}" not found — cannot resume`);
    runs.update(newRunId, { status: "failed", endedAt: Date.now(), exitCode: -1 });
    tasks.update(taskId, { column: "ready", runId: null });
    return newRunId;
  }

  const agent = spawnAgentOrFail({
    taskId,
    runId: newRunId,
    harness,
    prompt: line,
    cwd,
    onChunk,
    onSessionId: (sessionId) => {
      runs.update(newRunId, { fxSessionId: sessionId });
    },
    opts: {
      mode: task.mode,
      model: task.model ?? DEFAULT_MODEL[harness.kind],
      effort: task.effort,
      fast: task.fast,
      maxMode: task.maxMode,
      resumeSessionId: priorSessionId,
    },
  });
  if (!agent) return newRunId;
  registerActiveRun(newRunId, taskId, task, agent);
  attachDoneHandler(newRunId, taskId, agent);
  return newRunId;
}

/**
 * After an fx turn resolves, spawn the next queued follow-up (if any) as a
 * fresh resume turn. No-op while a run is still active for the task, or if
 * the task's agent was switched away from fx mid-flight.
 */
function drainFxQueue(taskId: string): void {
  const q = fxTurnQueue.get(taskId);
  if (!q || q.length === 0) return;
  const task = tasks.get(taskId);
  // Task vanished, or its agent was switched away from fx while a turn was
  // in flight — abandon the stale queue. Without this guard, draining after
  // an fx→claude switch would spawn the follow-up against the new claude
  // harness with an fx session id, which claude rejects.
  if (!task || resolveHarness(task.agent)?.kind !== "fx") {
    fxTurnQueue.delete(taskId);
    return;
  }
  if (task.runId && active.has(task.runId)) return;
  const next = q.shift();
  if (q.length === 0) fxTurnQueue.delete(taskId);
  if (next !== undefined) spawnFxTurnNow(task, taskId, next);
}

/** Most-recent fx session id across the task's runs (for resume). */
function findLastFxSessionId(taskId: string): string | null {
  const row = db.query<{ fx_session_id: string }, [string]>(
    `SELECT fx_session_id FROM runs
     WHERE task_id = ? AND fx_session_id IS NOT NULL
     ORDER BY started_at DESC
     LIMIT 1`,
  ).get(taskId);
  return row?.fx_session_id ?? null;
}

/**
 * Send a follow-up prompt to a claude task. Always creates a new run row so
 * the run history shows each user message as its own entry.
 *
 *   • If we hold live in-memory session state AND the tmux session is not
 *     unambiguously gone, we paste the prompt into it as a fresh turn
 *     (`sendTurn`).
 *   • Otherwise (session gone, or a tmux session that outlived our process
 *     after a restart with no in-memory state) we spawn a brand-new session
 *     resuming via `claude --resume <sessionId>` so claude reloads the prior
 *     conversation from its JSONL and keeps going.
 *
 * Returns false only on internal lookup failure (missing task row). Sessions
 * are always recoverable as long as the task itself still exists.
 */
function sendClaudeTurn(taskId: string, line: string): string | null {
  const task = tasks.get(taskId);
  if (!task) return null;

  // Route to the live-session paste path unless we're SURE the session is
  // dead. `sessionLiveness` (not the raw `sessionExists` boolean it replaces
  // here) distinguishes an unambiguous `gone` from an `unreachable` probe —
  // the same tri-state #88 introduced for the death watch, because a bare
  // `.ok` boolean conflates "session absent" with "tmux hiccuped" (busy-server
  // EAGAIN under load). Boot reconciliation no longer sweeps idle sessions, so
  // a tmux session can outlive our process with no SessionState — in which
  // case `sendTurn` would reject with "no live session" — so we also require
  // in-memory state. `unreachable` (inconclusive) deliberately still takes the
  // non-destructive paste path: if the session really is dead the paste fails
  // gracefully and the death-watch/boot-reconcile recovers it later; routing
  // it to `spawnResumedSession` instead would risk its unconditional
  // pre-kill (`spawnClaudeViaTmux`) tearing down a live, possibly mid-turn
  // session over a transient probe failure. Only an unambiguous `gone` (or no
  // in-memory state at all) reaches the destructive respawn path.
  if (hasSessionState(taskId) && sessionLiveness(sessionNameFor(taskId)) !== "gone") {
    return sendTurnInExistingSession(task, taskId, line);
  }
  return spawnResumedSession(task, taskId, line);
}

function sendTurnInExistingSession(task: Task, taskId: string, line: string): string {
  // Fold-while-busy: if a turn is already in flight, paste the message into
  // the live session and record it on the ACTIVE run — no new run row, no new
  // turn slot. Claude's TUI queues the keystrokes and replays them as part of
  // the current response. This keeps at most one in-flight run per task, which
  // is what prevents the stranding bug: claude can coalesce several queued
  // messages into fewer `end_turn` events than messages, and one slot per
  // message would leave the surplus slots (and their run rows) stuck `running`
  // forever. `active.has(task.runId)` is true iff the latest run hasn't
  // resolved yet (registerActiveRun adds; attachDoneHandler deletes on done) —
  // a more reliable "in flight" signal than the polled `task.column`.
  if (task.runId && active.has(task.runId) && pasteFollowUp(taskId, line)) {
    const runId = task.runId;
    const data = normalizeUserText(line);
    // Record the user bubble optimistically — `pasteFollowUp` only confirms a
    // live session exists, not that claude consumed the keystrokes. If the
    // user hits Stop before claude drains its input buffer, Ctrl+C clears the
    // queued message (see `cancelRun`) and this bubble has no reply. That's the
    // same optimism `sendTurn` already runs with; the bubble correctly reflects
    // that the user did send the message.
    runs.appendEvent(runId, "user", data);
    emit({ runId, taskId, stream: "user", data, ts: Date.now() });
    return runId;
  }

  // Idle (or the paste raced a vanishing session): one run row per user turn —
  // the runs list mirrors the conversation history at turn granularity. The
  // race that used to make a fast claude reply land the new row as "succeeded"
  // before the UI ever observed the "running" transition no longer matters:
  // the unified task-level event stream surfaces the new user/assistant
  // messages live regardless of which run row they belong to.
  const newRunId = randomUUID();
  const now = Date.now();
  const inheritedSessionId = findLastClaudeSessionId(taskId);
  runs.insert({
    id: newRunId,
    taskId,
    agent: task.agent,
    status: "running",
    startedAt: now,
    endedAt: null,
    exitCode: null,
    tmuxSession: sessionNameFor(taskId),
    claudeSessionId: inheritedSessionId,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
  });
  const prevColumn: ColumnId = task.column;
  tasks.update(taskId, { column: "running", runId: newRunId });
  if (prevColumn !== "running") {
    emitGlobal({ kind: "column", taskId, runId: newRunId, column: "running", prev: prevColumn, ts: now });
  }

  const harness = resolveHarness(task.agent);
  const kind: AgentKind = harness?.kind ?? "claude-code";
  const onChunk = makeChunkHandler(newRunId, taskId, kind, task.mode);
  onChunk("user", normalizeUserText(line));

  const agent = sendTurn(taskId, line, onChunk);
  registerActiveRun(newRunId, taskId, task, agent);
  attachDoneHandler(newRunId, taskId, agent);
  return newRunId;
}

/**
 * Factory installed via `setContinuationRunFactory` (module init, above).
 * claude-tmux's `dispatchLine` calls this when a genuinely-new content line
 * arrives on a task's session with no turn in flight and nothing queued to
 * receive it — the case a post-`end_turn` background-task auto-continuation
 * produces (claude legitimately resolved the visible turn, then kept talking
 * once the delegated work finished). Mirrors the idle branch of
 * `sendTurnInExistingSession` above (run-row insert with an inherited
 * `claudeSessionId`, column pull-back to `running`, chunk handler, active-run
 * registration) minus the `sendTurn`/keystroke-paste step — claude is already
 * mid-response, so there's no prompt to send, only a new run row to listen
 * with.
 *
 * Returns `null` for a task the caller can't safely adopt a run for, which
 * falls back to claude-tmux's pre-existing `lastChunk` routing:
 *   - the synthetic `"__rebuild__"` taskId `rebuildEventsFromJsonl` uses for
 *     its local, DB-detached synthetic SessionState — that id can never
 *     resolve to a real task row via `tasks.get` either, but the check is
 *     spelled out explicitly so it's visible here (and testable) rather than
 *     relying on that incidental fact alone;
 *   - an unknown task (deleted out from under a live session); or
 *   - an archived task (no new run should reopen the card).
 *   - a non-claude-code task: continuations are a claude-JSONL concept (a
 *     background-task auto-continuation observed via `dispatchLine`'s tail of
 *     the session's own JSONL); codex is one-shot per turn and has no
 *     equivalent notion of "kept talking after end_turn", so there's nothing
 *     to adopt a run for. Only claude-tmux's `dispatchLine` calls this
 *     factory today, so this is defense in depth rather than a live path.
 */
function startContinuationRun(taskId: string): ContinuationHooks | null {
  if (taskId === "__rebuild__") return null;
  const task = tasks.get(taskId);
  if (!task || task.archivedAt != null) return null;
  if (resolveHarness(task.agent)?.kind !== "claude-code") return null;

  const newRunId = randomUUID();
  const now = Date.now();
  const inheritedSessionId = findLastClaudeSessionId(taskId);
  runs.insert({
    id: newRunId,
    taskId,
    agent: task.agent,
    status: "running",
    startedAt: now,
    endedAt: null,
    exitCode: null,
    tmuxSession: sessionNameFor(taskId),
    claudeSessionId: inheritedSessionId,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    origin: "continuation",
  });
  const prevColumn: ColumnId = task.column;
  // Continuation turns always pull the card to `running`, regardless of
  // prior column (mirrors the idle branch above, and matches the owner
  // decision in the plan: the session genuinely resumed talking, so the
  // card must reflect that live activity).
  tasks.update(taskId, { column: "running", runId: newRunId });
  if (prevColumn !== "running") {
    emitGlobal({ kind: "column", taskId, runId: newRunId, column: "running", prev: prevColumn, ts: now });
  }

  const harness = resolveHarness(task.agent);
  const kind: AgentKind = harness?.kind ?? "claude-code";
  const onChunk = makeChunkHandler(newRunId, taskId, kind, task.mode);
  onChunk("status", "auto-continued after background task");

  return {
    onChunk,
    onAdopted: (handle) => {
      registerActiveRun(newRunId, taskId, task, handle);
      attachDoneHandler(newRunId, taskId, handle);
    },
  };
}

/**
 * Spawn a brand-new tmux session for the task, resuming the previous run's
 * claude conversation via `claude --resume <sessionId>`. claude loads the
 * full prior conversation from its own JSONL (text + thinking + tool_use +
 * tool_result history) so we don't have to prepend any context text to the
 * new prompt — the next message is just the user's new line.
 *
 * Falls back to a fresh session (no --resume) when we don't have a tracked
 * sessionId on any prior run — that path exists for legacy rows created
 * before the claude_session_id column was added.
 *
 * Reuses the existing worktree (`task.worktreePath`) so the agent operates
 * on the same checkout as before.
 */
function spawnResumedSession(task: Task, taskId: string, line: string): string {
  const priorSessionId = findLastClaudeSessionId(taskId);
  const cwd = task.worktreePath ?? task.workdir;

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
    tmuxSession: sessionNameFor(taskId),
    claudeSessionId: priorSessionId,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
  });
  const prevColumn: ColumnId = task.column;
  tasks.update(taskId, { column: "running", runId: newRunId });
  if (prevColumn !== "running") {
    emitGlobal({ kind: "column", taskId, runId: newRunId, column: "running", prev: prevColumn, ts: now });
  }

  const harness = resolveHarness(task.agent);
  const kind: AgentKind = harness?.kind ?? "claude-code";
  const onChunk = makeChunkHandler(newRunId, taskId, kind, task.mode);
  onChunk("user", normalizeUserText(line));
  onChunk(
    "status",
    priorSessionId
      ? `resuming claude session ${priorSessionId.slice(0, 8)}…`
      : "no prior claude session — starting fresh",
  );

  if (!harness) {
    onChunk("stderr", `harness "${task.agent}" not found — cannot resume`);
    runs.update(newRunId, { status: "failed", endedAt: Date.now(), exitCode: -1 });
    tasks.update(taskId, { column: "ready", runId: null });
    return newRunId;
  }
  const agent = spawnAgentOrFail({
    taskId,
    runId: newRunId,
    harness,
    prompt: line,
    cwd,
    onChunk,
    onSessionId: (sessionId) => {
      runs.update(newRunId, { claudeSessionId: sessionId });
    },
    opts: {
      mode: task.mode,
      model: task.model ?? DEFAULT_MODEL[harness.kind],
      effort: task.effort,
      fast: task.fast,
      maxMode: task.maxMode,
      resumeSessionId: priorSessionId,
    },
  });
  if (!agent) return newRunId;

  registerActiveRun(newRunId, taskId, task, agent);
  attachDoneHandler(newRunId, taskId, agent);
  return newRunId;
}

/**
 * Find the most recently-recorded claude_session_id across the task's runs.
 * Iterating across runs (not just the latest) because a row may not have
 * had its sessionId stamped if the JSONL discovery raced — we still want to
 * resume the prior conversation if any earlier run has the id.
 */
function findLastClaudeSessionId(taskId: string): string | null {
  const row = db.query<{ claude_session_id: string }, [string]>(
    `SELECT claude_session_id FROM runs
     WHERE task_id = ? AND claude_session_id IS NOT NULL
     ORDER BY started_at DESC
     LIMIT 1`,
  ).get(taskId);
  return row?.claude_session_id ?? null;
}

export interface CreateTaskInput extends Partial<Task> {
  title: string;
  prompt: string;
  /** Optional ref name (branch / tag / sha). Defaults to "HEAD". Resolved to a sha at create time. */
  baseRef?: string;
  /**
   * Check the worktree out on this pre-existing branch (e.g. a PR's head
   * branch) instead of minting a fresh one. Requires worktree isolation and
   * a git `workdir`; sets `task.branchSource = "existing"` and pins `baseRef`
   * to the branch's current sha rather than resolving `baseRef`/`branch`
   * from a template.
   */
  existingBranch?: string;
}

/**
 * Create a task. When `isolation === "worktree"` and `workdir` is a git repo,
 * resolves the requested base (default "HEAD") to a concrete sha now, so re-runs
 * always start from the same commit even after the source repo moves. Returns
 * `{ error }` if a non-default base ref was specified but can't be resolved
 * (typo, deleted branch, etc.).
 */
export async function createTask(
  input: CreateTaskInput,
): Promise<{ task: Task } | { error: string }> {
  const now = Date.now();
  // Only the trimmed, explicitly-provided workdir counts as user intent. We
  // still fall back to process.cwd() for the task itself so direct API
  // callers don't break, but we DON'T register that fallback as a project —
  // the projects list should only contain folders the user actually chose.
  const explicitWorkdir = input.workdir?.trim() ? input.workdir.trim() : null;
  const workdir = explicitWorkdir ?? process.cwd();
  const isolation = input.isolation ?? "worktree";
  const requestedRef = input.baseRef?.trim() || "HEAD";
  const existingBranch = input.existingBranch?.trim() || null;

  let baseRef: string | null = null;
  let plannedBranch: string | null = null;
  let branchSource: Task["branchSource"] = "created";
  const workdirRoot = isolation === "worktree" ? await repoRoot(workdir) : null;

  if (existingBranch) {
    if (isolation !== "worktree" || !workdirRoot) {
      return {
        error: `existingBranch requires worktree isolation and a git repo — "${workdir}" isn't one, or isolation is "${isolation}"`,
      };
    }
    if (existingBranch.startsWith("-")) {
      return { error: `invalid branch name: ${existingBranch}` };
    }
    const validated = validateBranchName(existingBranch);
    if (!validated.ok) {
      return { error: `invalid branch name "${existingBranch}": ${validated.reason}` };
    }
    const collision = tasks.list().some(
      (t) => !t.archivedAt && t.workdir === workdir && t.branch === existingBranch,
    );
    if (collision) {
      return { error: `another task already has "${existingBranch}" checked out in ${workdir}` };
    }
    await fetchBranch(workdir, existingBranch);
    const sha =
      (await resolveRef(workdir, `refs/remotes/origin/${existingBranch}`)) ??
      (await resolveRef(workdir, `refs/heads/${existingBranch}`));
    if (!sha) {
      return { error: `branch not found: "${existingBranch}" (checked origin and local refs)` };
    }
    baseRef = sha;
    plannedBranch = existingBranch;
    branchSource = "existing";
  } else if (workdirRoot) {
    const sha = await resolveRef(workdir, requestedRef);
    if (!sha) {
      if (requestedRef !== "HEAD") {
        return { error: `base ref "${requestedRef}" not found in ${workdir}` };
      }
    } else {
      baseRef = sha;
    }
  }

  // Projects table is populated EXCLUSIVELY through the explicit folder
  // picker (POST /projects/pick) — never auto-added from a task's workdir.
  // Previously we upserted on every task create, which silently surfaced
  // worktree temp paths and stray ad-hoc dirs in the sidebar.

  const id = randomUUID();

  // Resolve the harness so we can default model/effort by kind. A bad alias
  // id is rejected up-front rather than persisted and surfacing as a launch
  // failure later. Falls back to the built-in claude-code id when the caller
  // omits `agent` entirely.
  const agentId = input.agent ?? "claude-code";
  const harness = resolveHarness(agentId);
  if (!harness) {
    return { error: `unknown harness "${agentId}"` };
  }
  const kind = harness.kind;
  const model = input.model ?? DEFAULT_MODEL[kind];
  // Haiku 4.5 (and any future model whose effort support list is empty) sends
  // null effort; every other model carries a real id.
  const effortSupport = MODEL_EFFORT_SUPPORT[kind][model];
  const effort = input.effort
    ?? (Array.isArray(effortSupport) && effortSupport.length === 0 ? null : DEFAULT_EFFORT[kind]);

  // Validate taskType against the known set so a bogus value can't poison
  // the row (the picker only ever sends one of the canonical ids, but
  // direct API callers don't have that constraint).
  const requestedType = input.taskType;
  const taskType: TaskType =
    requestedType && TASK_TYPES.some((t) => t.id === requestedType)
      ? requestedType
      : DEFAULT_TASK_TYPE;

  // Pin the branch name now so renaming the task later (before the first run)
  // doesn't produce a different name on each start attempt. Only set when the
  // workdir is a git repo. An explicit override (from the New Task sidebar's
  // editable branch field) wins when valid; otherwise the name is composed from
  // the project's branch nomenclature (falling back to the built-in defaults).
  // Either way, any branch-template tags (`<slug>`, `<project_name>`, `<type>`,
  // `<date>`, `<timestamp>`, `<token>`) are resolved server-side (the server is
  // authoritative for direct API callers and for `<timestamp>` at true creation
  // time) BEFORE validation, and the resolved name is made unique within the
  // repo so two same-title/type tasks don't collide on one branch. Skipped
  // entirely when `existingBranch` already pinned `plannedBranch` above.
  if (!existingBranch && workdirRoot) {
    const override = typeof input.branch === "string" ? input.branch.trim() : "";
    const token = id.replace(/-/g, "").slice(0, 6);
    const ctx = { title: input.title, projectName: basename(workdir), taskType, token, now: new Date() };
    let desired: string;
    if (override) {
      const rendered = renderBranchTemplate(override, ctx);
      const v = validateBranchName(rendered);
      if (!v.ok) {
        const detail = rendered !== override
          ? `invalid branch name "${rendered}" (from template "${override}"): ${v.reason}`
          : `invalid branch name "${override}": ${v.reason}`;
        return { error: detail };
      }
      desired = rendered;
    } else {
      const config = projects.get(workdir)?.branchConfig ?? DEFAULT_BRANCH_CONFIG;
      desired = renderBranchTemplate(branchPattern(config, taskType), ctx);
      // Defensive: a hand-edited/corrupt config shouldn't hard-fail task
      // creation — fall back to the legacy scheme if it produced an illegal name.
      if (!validateBranchName(desired).ok) desired = branchName({ id, title: input.title });
    }
    const taken = new Set(
      tasks.list().map((t) => t.branch).filter((b): b is string => Boolean(b)),
    );
    plannedBranch = await ensureUniqueBranch(workdirRoot, desired, taken);
  }

  const task = tasks.insert({
    id,
    title: input.title,
    prompt: input.prompt,
    column: input.column ?? "backlog",
    agent: agentId,
    workdir,
    isolation,
    taskType,
    branch: plannedBranch,
    branchSource,
    worktreePath: null,
    baseRef,
    // No PR exists for a brand-new task; set server-side by pull-create.
    prUrl: null,
    mode: input.mode ?? null,
    model,
    effort,
    fast: input.fast === true,
    maxMode: input.maxMode === true,
    references: input.references ?? [],
    // Brand-new tasks start with an empty backlog; drafts are added later from
    // the run panel.
    backlog: [],
    // Composer draft starts empty; autosaved from the run panel thereafter.
    draft: null,
    // Brand-new tasks have no detected Cursor/claude plans yet — populated
    // later by `attachDoneHandler` (cursor) or the chunk handler (claude).
    plans: [],
    // Brand-new tasks have no todo-family tool activity yet — populated
    // later by the chunk handler's `maybeUpdateTodoProgress`.
    todoProgress: null,
    runId: null,
    // Derived at fetch time via SQL EXISTS — supply `false` here so the
    // `Task` shape is complete; `tasks.insert` re-fetches and the real
    // value flows back to the caller.
    hasOpenableRun: false,
    // Derived from the in-memory interactions Maps in `interactions.ts`; a
    // brand-new task has no pending interactions, so 0 is the correct seed.
    pendingInteractionCount: 0,
    // Derived from the in-memory terminal manager in `terminals.ts`; a
    // brand-new task has no open terminals, so 0 is the correct seed.
    openTerminalCount: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  return { task };
}

/**
 * Shared teardown job for archiving a task — tmux/codex session kill, then
 * open terminal tabs, then `detachWorktree` — in that exact order, because a
 * live shell cwd'd inside the worktree would block `git worktree remove`.
 * Both `archiveTask` (the fresh-archive path AND the already-archived
 * re-enqueue path below) and the boot-time `sweepArchivedTeardowns` route
 * through this one function so the three call sites can never drift apart.
 *
 * The harness kind is resolved synchronously here, before the job closure is
 * built and handed to `enqueueTeardown` — same as the original inline code,
 * just no longer duplicated at each call site.
 *
 * `enqueueTeardown` deliberately swallows job errors to keep its per-workdir
 * FIFO chain alive for every other task queued behind this one (see its doc
 * comment) — so it can't just return the `detachWorktree` result. Instead the
 * result is captured in a closure variable (`result`, exposed via the
 * returned getter) that a caller reads AFTER awaiting `promise`. This is the
 * same idiom `deleteOrphanWorktree` already uses to get a real outcome out of
 * a swallowed job.
 */
function enqueueArchiveTeardown(
  task: Task,
  opts?: { force?: boolean },
): { promise: Promise<void>; result: () => WorktreeTeardownResult | undefined } {
  const kind = resolveHarness(task.agent)?.kind;
  let result: WorktreeTeardownResult | undefined;
  const promise = enqueueTeardown(task.id, task.workdir, async () => {
    // `enqueueTeardown` only guarantees this job runs after everything already
    // queued for `task.workdir` — it can sit behind other jobs for seconds,
    // and `task` was captured at ENQUEUE time by every call site (fresh
    // archive, already-archived re-enqueue, boot sweep). The
    // `pendingTeardown(taskId)` discipline elsewhere only protects
    // materialize-AFTER-teardown; it does nothing about the opposite
    // interleaving: `sendInput`/`startTask` clear `archivedAt` and start
    // `prepareWorkdir`'s multi-second `git worktree add` BEFORE a fresh
    // `archiveTask` call (e.g. the Worktrees page's delete button) can see the
    // half-built directory and enqueue a teardown job right behind it. By the
    // time that job reaches the front of the queue, the task has moved on —
    // tearing down with the stale `task` snapshot would rip out a worktree the
    // agent is (or is about to be) running in. So re-read the row here, at job
    // execution time, and bail if it moved: gone entirely, un-archived
    // (`archivedAt == null` — both `sendInput` and `startTask` clear it
    // *before* calling `prepareWorkdir`, so this check is the same signal that
    // closes the window), or a run has since started. A bail is reported as
    // `"failed"` (not `"no-worktree"`/`"already-absent"`, which the client
    // reads as silent success) because the directory is still there — the
    // caller should retry, not assume it's clean.
    //
    // The live-run check keys on `cancelled`, NOT on `active.has(runId)`:
    // `archiveTask({ stopRun: true })` — what the Worktrees page's delete
    // button always sends — stops the run via `stopActiveHandle`, which
    // flags the handle `cancelled` and kills it, but the `active.delete`
    // only happens later in the async exit handler. A bare `active.has`
    // would therefore see the run we ourselves just stopped, bail, and
    // report a bogus failure for every delete of a *running* worktree. A
    // handle that's present and NOT cancelled is the real signal: a run
    // that started after we enqueued, which we must not tear down under.
    const cur = tasks.get(task.id);
    const liveHandle = cur?.runId ? active.get(cur.runId) : undefined;
    if (!cur || cur.archivedAt == null || (liveHandle && !liveHandle.cancelled)) {
      result = { removed: false, reason: "failed" };
      return;
    }
    // Same contract as deleteTask: dropSession is non-throwing (it
    // best-efforts tmux teardown internally). Don't wrap — a silent catch
    // would hide a regression in claude-tmux from the next reviewer.
    if (kind === "claude-code") dropSession(cur.id);
    else if (kind === "codex") dropCodexSession(cur.id);
    else if (kind === "cursor") dropCursorSession(cur.id);
    else if (kind === "gemini") dropGeminiSession(cur.id);
    else if (kind === "fx") dropFxSession(cur.id);
    await killTerminalsForTask(cur.id);
    result = await detachWorktree(cur, { force: opts?.force });
  });
  return { promise, result: () => result };
}

/**
 * Archive a finished task: stamp `archivedAt`, kill its claude tmux session
 * AND any open terminal tabs (both best-effort) so no background shell outlives
 * the user's interest in the task — once archived the card is hidden, so the
 * user can no longer reach those shells to close them — then **detach** the
 * worktree from disk (`detachWorktree`): the checkout is removed to reclaim
 * space, but the branch, every commit, the run/run_events history, and
 * claude's external JSONL transcript all survive untouched. Sending a
 * follow-up message or unarchiving later rematerializes the worktree at the
 * same deterministic path (`prepareWorkdir`'s re-attach path) and resumes the
 * conversation right where it left off.
 *
 * Only allowed when the task is in the `done` column — archive is the
 * terminal step of the explicit review → done → archive flow. Pass
 * `{ force: true }` to bypass ONLY that column gate (e.g. the Worktrees page's
 * delete action, which archives a stale worktree's task regardless of where
 * it sits on the board) — the active-run rejection, `archivedAt` stamping,
 * and deferred teardown below are unchanged either way.
 *
 * Pass `{ stopRun: true }` to archive a task with an in-flight (or
 * held-by-background-agents) run anyway: the run is stopped exactly the way
 * the Stop button stops it (`stopActiveHandle`/`stopHeldTask`, shared with
 * `cancelRun`) before the normal archive path below proceeds. Without it,
 * the active-run guard stays in place as a backstop.
 *
 * Pass `{ forceWorktree: true }` to have the detach discard uncommitted
 * changes in the checkout rather than leaving it in place (threaded straight
 * through to `detachWorktree`'s `force` option) — an explicit, user-confirmed
 * opt-in from the Worktrees page, since it's a destructive, unrecoverable
 * discard of anything not committed.
 *
 * Pass `{ awaitTeardown: true }` to block until the deferred teardown above
 * has actually run and get its real `WorktreeTeardownResult` back as
 * `teardown` — the Worktrees page's delete action needs to know the
 * directory is truly gone before it refreshes the list, unlike the kanban
 * archive button, which stays fire-and-forget by leaving this unset.
 */
export async function archiveTask(
  taskId: string,
  opts?: { force?: boolean; stopRun?: boolean; forceWorktree?: boolean; awaitTeardown?: boolean },
): Promise<{ task: Task; teardown?: WorktreeTeardownResult } | { error: string }> {
  const task = tasks.get(taskId);
  if (!task) return { error: "task not found" };
  if (task.column !== "done" && !opts?.force) {
    return { error: "only tasks in Done can be archived" };
  }
  // Defence-in-depth: column='done' should imply no live run, but column is
  // freely PATCHable (drag-to-Done on a running card is allowed today). If a
  // run is still active, refuse rather than killing tmux out from under it —
  // the exit handler would then flip the now-archived task to 'ready' and
  // leave the row in a contradictory state — UNLESS the caller explicitly
  // asked us to stop it first (`stopRun`), in which case we do exactly what
  // the Stop button does before proceeding.
  if (task.runId && active.has(task.runId)) {
    if (!opts?.stopRun) {
      return { error: "task is still running — cancel the run before archiving" };
    }
    stopActiveHandle(active.get(task.runId)!, "task archived");
  } else if (opts?.stopRun && isHeldByBackgroundAgents(taskId)) {
    stopHeldTask(taskId, "task archived");
  }
  if (task.archivedAt != null) {
    // Already archived is normally a cheap no-op — repeat-archives (e.g. a
    // double click) shouldn't re-enqueue teardown work every time. But when
    // the worktree is STILL on disk, the previous teardown either never ran
    // (this instance crashed before the boot sweep got to it) or never
    // finished — and this is exactly the reported bug: the Worktrees page's
    // "archive & delete" action calls archive on a row that's already
    // archived, and the old bare `return { task }` here meant that row could
    // never be cleaned up. Re-enqueue instead, gated on the same
    // `worktreePath && existsSync(...)` condition `sweepArchivedTeardowns`
    // already uses at boot, so an ordinary repeat-archive with nothing left
    // to remove stays a bare return.
    if (task.worktreePath && existsSync(task.worktreePath)) {
      const { promise, result } = enqueueArchiveTeardown(task, { force: opts?.forceWorktree });
      if (opts?.awaitTeardown) {
        await promise;
        // A requested outcome should never come back silently absent — if
        // the job threw and enqueueTeardown swallowed it, `result()` is
        // still undefined here, so report it as a failed removal instead of
        // omitting `teardown` from the response.
        return { task, teardown: result() ?? { removed: false, reason: "failed" } };
      }
      void promise;
    } else if (opts?.awaitTeardown) {
      // Same "never come back silently absent" contract as the branch above,
      // for the case where there was never anything to tear down. Both
      // outcomes are successes for the client (nothing left to remove) — this
      // only stops the response from omitting `teardown` when it was asked
      // for, matching `WorktreeTeardownResult`'s documented contract.
      return {
        task,
        teardown: task.worktreePath
          ? { removed: false, reason: "already-absent" }
          : { removed: false, reason: "no-worktree" },
      };
    }
    return { task };
  }
  const updated = tasks.update(taskId, { archivedAt: Date.now() });
  if (!updated) return { error: "task not found" };
  // Turn queues are cheap in-memory bookkeeping (no I/O), so they're dropped
  // inline rather than folded into the deferred job.
  codexTurnQueue.delete(taskId);
  cursorTurnQueue.delete(taskId);
  geminiTurnQueue.delete(taskId);
  fxTurnQueue.delete(taskId);
  // Deferred: the actual teardown (tmux kill, terminal shells, worktree
  // detach) is pushed onto this task's source-workdir teardown queue rather
  // than awaited here, so `archiveTask` can flip the DB column and return in
  // milliseconds. Archiving several tasks against the same workdir back-to-
  // back no longer blocks each POST on `spawnSync` tmux kills or `git
  // worktree remove --force`/`prune` — those still run (serialized per
  // workdir, see `enqueueTeardown`), just off the request's critical path;
  // tasks in a different workdir proceed independently. Callers that must
  // not race a deferred teardown (unarchive, start, delete, the boot sweep)
  // await `pendingTeardown(taskId)` first. `awaitTeardown` is the one opt-in
  // exception: the Worktrees page explicitly wants to block on this specific
  // teardown to get a truthful result back.
  const { promise, result } = enqueueArchiveTeardown(updated, { force: opts?.forceWorktree });
  if (opts?.awaitTeardown) {
    await promise;
    return { task: updated, teardown: result() ?? { removed: false, reason: "failed" } };
  }
  void promise;
  return { task: updated };
}

/**
 * Reverse of `archiveTask`: clear the timestamp and, best-effort, restore the
 * worktree if `archiveTask` detached it (or it's otherwise missing on disk).
 * Restore failure doesn't block the unarchive — the card comes back either
 * way; a later send/start/terminal-open retries the restore lazily.
 */
export async function unarchiveTask(taskId: string): Promise<{ task: Task } | { error: string }> {
  const task = tasks.get(taskId);
  if (!task) return { error: "task not found" };
  if (task.archivedAt == null) return { task };
  // Wait out any teardown archiveTask deferred for this task BEFORE deciding
  // whether the worktree needs restoring. Without this, a still-in-flight
  // `detachWorktree` could delete the worktree right after the `existsSync`
  // check below decided it was still present (or right after a restore
  // recreated it), leaving the task unarchived but pointing at a directory
  // that's about to vanish out from under it.
  await pendingTeardown(taskId);
  const updated = tasks.update(taskId, { archivedAt: null });
  if (!updated) return { error: "task not found" };
  if (updated.worktreePath && updated.branch && !existsSync(updated.worktreePath)) {
    try {
      const restored = await prepareWorkdir(updated);
      if ("error" in restored) {
        console.warn(`[agetor] unarchiveTask: worktree restore failed for ${taskId}: ${restored.error}`);
      }
    } catch (err) {
      console.warn(`[agetor] unarchiveTask: worktree restore failed for ${taskId}:`, err);
    }
  }
  return { task: updated };
}

/**
 * Delete a task and best-effort tear down its worktree. Kills any active run
 * first so we don't leave a stale process around.
 */
export async function deleteTask(taskId: string): Promise<void> {
  const task = tasks.get(taskId);
  if (!task) return;
  if (task.runId && active.has(task.runId)) active.get(task.runId)?.kill();
  // Resolve any pending interactions for this task so hook scripts / MCP
  // children blocked on agetor unblock immediately. Done before dropSession
  // so the curl / fetch awaiters return before tmux kills them.
  cancelPendingForTask(taskId, "task deleted");
  // Kill the task's tmux session before tearing down the worktree so we don't
  // leave an orphaned session behind. For claude it outlives individual runs;
  // for codex/cursor/gemini it only exists during an in-flight turn —
  // dropCodexSession/dropCursorSession/dropGeminiSession also clear any
  // in-memory tailer. fx has no tmux session at all (ACP/stdio) — dropFxSession
  // just clears its in-memory state. No-op when no session exists.
  const deleteKind = resolveHarness(task.agent)?.kind;
  codexTurnQueue.delete(taskId);
  cursorTurnQueue.delete(taskId);
  geminiTurnQueue.delete(taskId);
  fxTurnQueue.delete(taskId);
  // Routed through the same per-workdir teardown queue archiveTask uses —
  // DELETE's semantics are unchanged (still awaited before `tasks.delete`
  // below), but this serializes it behind any archive teardown already in
  // flight for another task in the SAME source workdir, so two `git worktree
  // remove`/`prune` calls against the same repo never contend on git's locks
  // at the same time. A delete against an unrelated workdir is unaffected.
  await enqueueTeardown(taskId, task.workdir, async () => {
    if (deleteKind === "claude-code") dropSession(taskId);
    else if (deleteKind === "codex") dropCodexSession(taskId);
    else if (deleteKind === "cursor") dropCursorSession(taskId);
    else if (deleteKind === "gemini") dropGeminiSession(taskId);
    else if (deleteKind === "fx") dropFxSession(taskId);
    // Kill any open terminal tabs before removing the worktree — a live shell
    // sitting in the worktree dir would block `git worktree remove`. Awaited
    // so the shells are actually gone before we tear the directory down.
    await killTerminalsForTask(taskId);
    await removeWorktree(task);
  });
  // No per-task attachments directory to clean up — refs are path-only,
  // agetor never copied anything to disk.
  tasks.delete(taskId);
}

/**
 * Boot-time healing pass for teardowns that never ran: if agetor quit or
 * crashed between an `archiveTask` response landing (DB flipped, teardown
 * enqueued) and the deferred job actually executing, the in-memory queue is
 * gone on restart but the worktree is still sitting on disk. This also heals
 * the pre-existing crash-mid-archive case that could strand a worktree even
 * before teardown was deferred (a crash between the DB update and the old
 * synchronous `detachWorktree` call).
 *
 * `tasks.list()` already includes archived rows (no archived filter in its
 * query), so a plain scan is enough. Re-enqueues the identical teardown job
 * `archiveTask` would have run — session drop keyed to the task's own id,
 * `killTerminalsForTask`, `detachWorktree` — through the same per-workdir
 * queue (keyed on each task's own `workdir`), so it's serialized against
 * anything already in flight for that source repo without waiting on
 * unrelated repos' backlogs. Kills are always keyed to a specific task id
 * from this instance's own DB; this never enumerates or kills `agetor-*`
 * tmux sessions directly (the shared-socket rule reconcileOrphans documents
 * above applies here too).
 *
 * Fire-and-forget from the caller's perspective — returns the count enqueued,
 * not a promise, since it only needs to kick the jobs off.
 */
export function sweepArchivedTeardowns(): number {
  let enqueued = 0;
  for (const task of tasks.list()) {
    if (task.archivedAt == null) continue;
    if (!task.worktreePath) continue;
    if (!existsSync(task.worktreePath)) continue;
    // Defensive: an archived task shouldn't have a live run (archiveTask
    // refuses to archive one), but mirror that guard here too rather than
    // risk tearing down a worktree out from under an in-flight run.
    if (task.runId && active.has(task.runId)) continue;
    // No `force` — an explicit owner decision (see the plan doc): discarding
    // uncommitted work with no human in the loop, unattended at boot, is not
    // a trade worth making. A dirty worktree just stays stuck until the user
    // forces it from the Worktrees page.
    enqueueArchiveTeardown(task);
    enqueued++;
  }
  return enqueued;
}

/**
 * Idle-session reaper (T4, `docs/plans/reduce-cpu-and-memory.md` §3.1). Kills
 * the tmux session backing a claude-code task's REPL once it's sat idle —
 * no turn in flight, nothing waiting on the user, no session activity — for
 * `IDLE_SESSION_REAP_MS` (30min), reclaiming the ~300–500MB "node" process
 * and every per-session timer (`disposeSessionState`, invoked via
 * `dropSession`). A follow-up sent afterward still works: `sendClaudeTurn`
 * falls back to `spawnResumedSession` (`claude --resume <id>`) whenever
 * `hasSessionState` is false, so this is invisible to the user beyond a
 * slightly slower first reply.
 *
 * Candidates come ONLY from this instance's own DB — this must never
 * enumerate-and-kill tmux sessions (the shared-socket rule documented on
 * `reconcileOrphans` above applies here identically: a blind sweep would
 * reap a sibling agetor instance's or a `bun test` run's sessions). Probing
 * a specific candidate task id we already own (`probeSessionActivity`,
 * `sessionIdleInfo`) is fine — that's a keyed lookup, not a sweep. Codex and
 * gemini are never candidates: their sessions are one-shot per turn and
 * self-dispose (`codex-tmux.ts`, `gemini-tmux.ts`), so there's nothing to
 * reap.
 *
 * Two performance properties keep a sweep from becoming a synchronous burst
 * that stalls the main process for the duration of the scan (previously: N
 * non-archived claude tasks × ~5 DB queries + a blocking tmux probe each, all
 * in one event-loop turn):
 *  - **Cheap pre-filter.** `candidateIds` is derived entirely from the rows
 *    `tasks.list()` already fetched (no per-candidate `tasks.get` yet) and
 *    excludes any task that plainly can't own a session: archived, non-claude,
 *    or — the key trim — neither holding in-memory `SessionState` nor ever
 *    having started a run (`hasSessionState(t.id) || t.runId != null`). A
 *    never-started task fails both and drops out before it costs anything
 *    more than an array filter.
 *  - **Per-candidate yield.** `await Bun.sleep(0)` at the top of every loop
 *    iteration hands control back to the event loop between candidates, so
 *    HTTP requests, SSE pushes, and session tailers keep running throughout a
 *    sweep instead of queuing up behind it. This is what makes the pre-kill
 *    re-check below load-bearing rather than defensive-only: with real
 *    yields between iterations, a message that lands mid-sweep (starts a
 *    turn, opens a pending interaction) MUST be caught by a guard re-read
 *    immediately before the kill, not just the one the loop started with.
 *
 * Every guard is re-checked against a freshly-read task row immediately
 * before the kill, not from the snapshot the loop started with. Guard work
 * itself is hoisted to avoid redundant reads: `isReapable` takes the already
 * -fetched `Task` row and calls the pure `isTaskHeldByBackgroundAgents(task)`
 * predicate directly rather than the taskId-keyed `isHeldByBackgroundAgents`
 * wrapper, which would otherwise re-fetch the same row internally.
 *
 * Called once ~30s after boot (letting boot reattach settle first) and then
 * on a `SESSION_REAP_SWEEP_MS` interval from `src/bun/index.ts` and
 * `src/bun/headless.ts`.
 */
export async function reapIdleSessions(): Promise<{ reaped: string[] }> {
  if (reapInFlight) return { reaped: [] };
  reapInFlight = true;
  try {
    const reaped: string[] = [];
    const candidateIds = tasks
      .list()
      .filter(
        (t) =>
          t.archivedAt == null
          && resolveHarness(t.agent)?.kind === "claude-code"
          && (hasSessionState(t.id) || t.runId != null),
      )
      .map((t) => t.id);

    const isReapable = (task: Task): boolean => {
      if (task.runId && active.has(task.runId)) return false;
      if (isTaskHeldByBackgroundAgents(task)) return false;
      // `isTaskHeldByBackgroundAgents` only covers the `running`-column
      // #92 hold (main run succeeded, subagents still finishing) — it
      // requires `task.column === "running"`. Since #93
      // (`signalSubagentApiError`), a task can leave the `active` map via
      // `blocked` instead: one subagent's API error aborts the main turn
      // while SIBLING subagents are still legitimately running and tailed.
      // That case slips past the check above (column is `blocked`, not
      // `running`), so re-check independently of column/hold state — a
      // task with any running subagent row must never have its tmux
      // session reaped out from under agents still writing to it.
      if (subagents.hasRunning(task.id)) return false;
      if (countPendingForTask(task.id) > 0) return false;
      return true;
    };

    for (const taskId of candidateIds) {
      // Yield between candidates — see the perf-properties doc above. Safe
      // because every guard is re-checked against a fresh row immediately
      // before the kill below.
      await Bun.sleep(0);

      const task = tasks.get(taskId);
      if (!task || !isReapable(task)) continue;

      const idleInfo = sessionIdleInfo(taskId);
      let idleLongEnough: boolean;
      if (idleInfo) {
        idleLongEnough = idleInfo.idleMs >= IDLE_SESSION_REAP_MS;
      } else {
        // No in-memory SessionState — e.g. a done/review task whose session
        // survived a restart (boot reconciliation only reattaches `running`
        // rows). Probe tmux directly for the session's own activity clock
        // (`#{session_activity}`) instead of the previous `task.updatedAt`
        // heuristic, which could read stale on a task nobody touched through
        // agetor but that's still being used interactively in its terminal.
        // `null` means the session is already gone (or unreachable) — nothing
        // to reap. `attached === true` means a human has the pane open right
        // now — never reap that regardless of how long it's been idle by the
        // clock. Otherwise require BOTH tmux's activity clock AND the task
        // row's `updatedAt` past the threshold before reaping a session we
        // have no in-memory visibility into — the extra-conservative choice
        // called out in the review: a session could be driven by something
        // other than agetor (a human at the tmux client) bumping tmux's
        // activity clock without ever updating our DB row, or vice versa.
        const activity = probeSessionActivity(taskId);
        if (!activity) continue;
        if (activity.attached) continue;
        idleLongEnough =
          Date.now() - activity.activityAt >= IDLE_SESSION_REAP_MS
          && Date.now() - task.updatedAt >= IDLE_SESSION_REAP_MS;
      }
      if (!idleLongEnough) continue;

      // Re-check immediately before the kill against a fresh row — closes
      // the window between the idle check above (which may itself have
      // awaited a yield or a tmux probe) and the kill below.
      const fresh = tasks.get(taskId);
      if (!fresh || !isReapable(fresh)) continue;

      dropSession(taskId);
      reaped.push(taskId);

      const recent = runs.listForTask(taskId)[0];
      if (recent) {
        const data = findLastClaudeSessionId(taskId)
          ? "session hibernated after 30m idle — next message will resume it"
          : "session hibernated after 30m idle — no saved session id, next message starts a fresh context";
        // Idempotence backstop: a re-reap regression (e.g. the tmux 3.6a
        // `display-message` exact-match bug worked around in
        // `probeSessionActivity`, which made every probe look like "never
        // attached, idle since 1970" and re-reaped every candidate on every
        // sweep) must not re-spam the run with duplicate hibernate
        // breadcrumbs. A legitimate later hibernate always has intervening
        // events (resuming creates a new run / new events), so "the last
        // persisted event for this run is this exact breadcrumb" is safe to
        // treat as "already reaped, skip" — both the append AND the emit,
        // since an emit without persistence would still paint a new chip
        // client-side on every sweep.
        if (runs.lastEventData(recent.id) !== data) {
          runs.appendEvent(recent.id, "status", data);
          emit({ runId: recent.id, taskId, stream: "status", data, ts: Date.now() });
        }
      }
    }

    if (reaped.length > 0) {
      console.log(`[agetor] reaped ${reaped.length} idle claude session(s)`);
    }
    return { reaped };
  } finally {
    reapInFlight = false;
  }
}

/**
 * Enumerate every git worktree materialized on disk under `WORKTREES_DIR` and
 * cross-reference it against `tasks.list()` (the directory basename equals
 * the owning task's id by construction — see `worktreePath` in worktree.ts).
 * Backs `GET /worktrees`.
 *
 * Deliberately fs + DB only — no git subprocesses — so this stays cheap
 * enough to poll. Staleness is classified per `WorktreeStaleReason`:
 *  - `"orphaned"` — no task row for the dir (crash/failed teardown leftover).
 *  - `"archived"` — the owning task is archived but the dir is still present
 *    (teardown pending, failed, or skipped because the worktree was dirty).
 *  - `"inactive"` — not archived, no run in flight, no background
 *    agents/workflows still running, and the task hasn't been touched in
 *    over `WORKTREE_STALE_AFTER_MS`.
 *
 * Returns `[]` when `WORKTREES_DIR` doesn't exist yet (no worktree has ever
 * been created). Non-directory entries and dotfiles are skipped.
 */
export function listWorktrees(): WorktreeInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(WORKTREES_DIR);
  } catch {
    return [];
  }
  const taskById = new Map(tasks.list().map((t) => [t.id, t]));
  // One grouped query for the whole listing (same pattern the `/tasks` route
  // uses, backed by migration 042's partial index) instead of a per-row
  // lookup — cheap enough to run unconditionally, unlike a git subprocess.
  const runningByTask = subagents.runningCountsByTask();
  const out: WorktreeInfo[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const dirPath = join(WORKTREES_DIR, name);
    let isDir = false;
    try {
      isDir = statSync(dirPath).isDirectory();
    } catch {
      continue; // vanished between readdir and stat — skip rather than error
    }
    if (!isDir) continue;

    const task = taskById.get(name);
    const staleReasons: WorktreeStaleReason[] = [];
    // Same active-run check archiveTask uses for its defence-in-depth guard.
    const runActive = !!(task?.runId && active.has(task.runId));
    // Background agents/workflows (subagent rows) still writing to the
    // worktree must hold off the "inactive" flag even though the main run's
    // own `active` slot is long gone. Sourced from the grouped map above, so
    // this is a lookup, not a query — always `false` for an orphan (no task).
    const heldByBackgroundAgents = !!task && (runningByTask.get(task.id) ?? 0) > 0;
    if (!task) {
      // No owning row — nothing else applies (can't be archived or idle-by-age).
      staleReasons.push("orphaned");
    } else {
      // A worktree can carry both reasons at once (archived AND past the
      // inactivity threshold), so these are independent checks, not a chain.
      if (task.archivedAt != null) staleReasons.push("archived");
      if (
        !runActive
        && Date.now() - task.updatedAt > WORKTREE_STALE_AFTER_MS
        && !heldByBackgroundAgents
      ) {
        staleReasons.push("inactive");
      }
    }

    out.push({
      id: name,
      path: dirPath,
      taskId: task?.id ?? null,
      taskTitle: task?.title ?? null,
      column: task?.column ?? null,
      archivedAt: task?.archivedAt ?? null,
      taskUpdatedAt: task?.updatedAt ?? null,
      branch: task?.branch ?? null,
      // Owned worktree: the task's own workdir. Orphan: best-effort parse of
      // the `.git` pointer file — plain fs, no git subprocess.
      workdir: task?.workdir ?? parseWorktreeGitPointer(dirPath),
      runActive,
      heldByBackgroundAgents,
      stale: staleReasons.length > 0,
      staleReasons,
    });
  }
  return out;
}

/**
 * Resolve a worktree id (a directory basename under `WORKTREES_DIR`) to its
 * absolute path, with the confinement checks shared by every worktree-id
 * endpoint: no `/`, `\`, `..`, or empty string, and the resolved path must
 * be a direct child of `WORKTREES_DIR`, never the directory itself (guards
 * against ids like `"."` that pass the substring checks but normalize to
 * `WORKTREES_DIR` — an `rm -rf` there would delete every task's worktree).
 * Factored out of `deleteOrphanWorktree` so `worktreeGitStatus` shares the
 * exact same guard rather than a hand-copied one that could drift.
 */
function resolveWorktreeDir(id: string): { dir: string } | { error: string } {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) {
    return { error: "invalid worktree id" };
  }
  const dirPath = join(WORKTREES_DIR, id);
  if (basename(dirPath) !== id) {
    return { error: "invalid worktree id" };
  }
  return { dir: dirPath };
}

/**
 * Delete an orphaned worktree directory — one with no owning task row, so
 * there's no ticket for `archiveTask` to archive. Used by the Worktrees
 * page's delete action for `WorktreeInfo` rows where `taskId` is null.
 *
 * Refuses (rather than silently no-oping) when a task row for `id` still
 * exists — that worktree is owned, and the caller should archive the task
 * instead, which routes through the normal teardown path. `id` is validated
 * via `resolveWorktreeDir` so the resolved path can never escape
 * `WORKTREES_DIR`.
 *
 * Awaits `pendingTeardown(id)` before touching the directory — the fleet
 * invariant every worktree-touching path follows, in case a stale teardown
 * from a task that used to own this id is still draining. Never kills any
 * tmux session: an orphan has no owning task, and the fleet rule forbids
 * enumerate-and-kill of `agetor-*` sessions on the shared tmux socket.
 */
export async function deleteOrphanWorktree(id: string): Promise<{ ok: true } | { error: string }> {
  const resolved = resolveWorktreeDir(id);
  if ("error" in resolved) return resolved;
  const dirPath = resolved.dir;

  let isDir = false;
  try {
    isDir = statSync(dirPath).isDirectory();
  } catch {
    return { error: "worktree not found" };
  }
  if (!isDir) return { error: "worktree not found" };
  if (tasks.get(id)) {
    return { error: "this worktree is owned by an active task — archive the task instead" };
  }

  await pendingTeardown(id);

  // Best-effort: find the source repo before the dir is gone so we can prune
  // its stale `.git/worktrees/<id>` registration afterwards.
  const sourceRoot = parseWorktreeGitPointer(dirPath);

  // Run the rm + prune on the source repo's teardown FIFO (keyed by
  // sourceRoot, same as archiveTask/deleteTask's teardown) so an orphan
  // cleanup can't contend on git's `.git/worktrees/.lock` with a concurrent
  // same-repo archive/delete teardown. `enqueueTeardown` swallows job errors
  // — a single misbehaving teardown must not break the chain for every task
  // queued behind it — so the closure-captured `result` is how we still
  // surface a failed rm to the caller after the await. When the source repo
  // can't be determined, key by `dirPath` instead: there's no shared lock
  // domain to serialize against, so this degrades to a private one-entry
  // chain, behaviorally the same as running it inline.
  //
  // Caveat: archive/delete key their chains by the raw `task.workdir` string,
  // whereas `sourceRoot` here is the realpath'd repo root git wrote into the
  // `.git` pointer. If those aren't byte-identical (trailing slash, a symlinked
  // path, or a workdir that's a repo *subdir*), the orphan prune lands on a
  // different FIFO and could still race that repo's `.git/worktrees/.lock` —
  // the same best-effort limitation `teardownTails` already documents. Harmless
  // (a lost lock just skips one prune; the next worktree op in that repo clears
  // the stale registration), so not worth resolving the root to reconcile keys.
  let result: { ok: true } | { error: string } = { ok: true };
  await enqueueTeardown(id, sourceRoot ?? dirPath, async () => {
    try {
      await rm(dirPath, { recursive: true, force: true });
    } catch (err) {
      result = { error: `failed to remove worktree directory: ${err instanceof Error ? err.message : String(err)}` };
      return; // don't prune if the removal failed
    }
    if (sourceRoot) await pruneWorktrees(sourceRoot);
  });

  return result;
}

/**
 * On-demand live git status for a single worktree — dirty / ahead / merged —
 * composing `hasUncommittedChanges`, `getAheadCount`, and
 * `isMergedIntoDefaultBranch`. Deliberately not part of `listWorktrees` (fs +
 * DB only, safe to poll): each of these spawns a git subprocess, so this is
 * fetched per row on demand instead. Backs `GET /worktrees/:id/git-status`.
 *
 * Shares `resolveWorktreeDir`'s confinement with `deleteOrphanWorktree`, but
 * — unlike delete — does not refuse task-owned ids: git status is useful for
 * both orphan and task-backed worktrees, so callers can check staleness
 * before deciding whether to archive.
 *
 * For a task-backed id, resolves the live worktree dir + pinned base ref
 * from the task row (`worktreePath ?? workdir`, `baseRef`). For an orphan id
 * (no task row), uses the `WORKTREES_DIR/id` path directly with no base ref
 * — `getAheadCount` degrades to its unknown-but-not-blocking `0` in that
 * case, same contract as everywhere else `baseRef` may be null.
 */
export async function worktreeGitStatus(id: string): Promise<WorktreeGitStatus | { error: string }> {
  const resolved = resolveWorktreeDir(id);
  if ("error" in resolved) return resolved;

  const task = tasks.get(id);
  const dir = task ? task.worktreePath ?? task.workdir : resolved.dir;
  const baseRef = task ? task.baseRef ?? null : null;

  const dirty0 = await hasUncommittedChanges(dir);
  if (dirty0 === null) {
    return { dirty: false, ahead: 0, merged: null, ignored: true };
  }

  const [aheadResult, merged] = await Promise.all([
    getAheadCount(dir, baseRef),
    isMergedIntoDefaultBranch(dir),
  ]);

  return { dirty: dirty0, ahead: aheadResult ?? 0, merged, ignored: false };
}

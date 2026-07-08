import { randomUUID } from "node:crypto";
import { db, tasks, runs, harnesses } from "./db.ts";
import { spawnAgent, toClaudeModelArg } from "./agents.ts";
import { checkHarness } from "./agent-status.ts";
import {
  AGENT_OPTIONS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_TASK_TYPE,
  MODEL_EFFORT_SUPPORT,
  SESSION_DIED_STATUS_PREFIX,
  TASK_TYPES,
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
  setBroadcaster,
  setResolvedBroadcaster,
  type AnyRequest,
  type InteractionResolved,
} from "./interactions.ts";
import {
  CLAUDE_API_ERROR_STATUS_PREFIX,
  cycleToMode,
  type CycleResult,
  dropSession,
  killSessionByName,
  reattachSession,
  pasteFollowUp,
  sendSlashCommand,
  sendTurn,
  hasSessionState,
  sessionExists,
  sessionExistsByName,
  sessionLiveness,
  sessionNameFor,
} from "./claude-tmux.ts";
import {
  dropCodexSession,
  reattachCodexSession,
} from "./codex-tmux.ts";
import { setSubagentEmitter } from "./claude-subagents.ts";
import { prepareWorkdir, removeWorktree, repoRoot, resolveRef, branchName } from "./worktree.ts";
import { killTerminalsForTask } from "./terminals.ts";
import { ensureInstalledForCwd } from "./hook-installer.ts";
import type {
  ColumnId,
  GlobalEvent,
  RunEvent,
  RunStatus,
  Task,
} from "../shared/types.ts";
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
}
const active = new Map<string, ActiveRun>(); // runId -> handle

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
  reason?: "api-error" | "approval" | "session-died",
): void {
  const before = tasks.get(taskId);
  const prev: ColumnId | null = before?.column ?? null;
  tasks.update(taskId, { column: next });
  if (prev !== next) {
    emitGlobal({ kind: "column", taskId, runId, column: next, prev, ts: Date.now(), reason });
  }
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
  const stale = db.query<{ id: string; task_id: string; tmux_session: string | null; claude_session_id: string | null; codex_session_id: string | null; agent: string }, []>(
    `SELECT id, task_id, tmux_session, claude_session_id, codex_session_id, agent FROM runs WHERE status = 'running' ORDER BY started_at DESC, id DESC`,
  ).all();

  const reattachedTaskIds = new Set<string>();
  const orphaned: { id: string; task_id: string; prevColumn: ColumnId | null }[] = [];

  for (const row of stale) {
    const task = tasks.get(row.task_id);
    const prevColumn: ColumnId | null = task?.column ?? null;
    const kind = resolveHarness(row.agent)?.kind ?? null;
    // Both claude-code and codex runs can be reattached when their detached
    // tmux session is still alive. The reattach key differs by kind: claude
    // needs its JSONL session uuid (`claude_session_id`), codex needs its
    // thread id (`codex_session_id`) — the per-run log path is derived from
    // the run id. Note codex's session only lives WHILE its turn is in flight,
    // so a reattachable codex run is by definition one that was still running
    // when agetor restarted. Also: if we already reattached a newer sibling
    // for this task, orphan the older one — only one SessionState can drive a
    // given tmux session at a time.
    const reattachKey =
      kind === "claude-code" ? row.claude_session_id
      : kind === "codex" ? row.codex_session_id
      : null;
    const canTryReattach =
      (kind === "claude-code" || kind === "codex")
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
          })
        : reattachCodexSession({
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
  return orphaned.length;
}


export async function startTask(taskId: string): Promise<{ runId: string } | { error: string }> {
  const task = tasks.get(taskId);
  if (!task) return { error: "task not found" };
  if (task.runId && active.has(task.runId)) return { error: "task already running" };

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

  const prepared = await prepareWorkdir(task);
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
      // Both kinds now run in a per-task tmux session.
      tmuxSession: sessionNameFor(taskId),
      // Filled in by spawnAgent's onSessionId callback once the session id is
      // known: claude's JSONL uuid → claudeSessionId, codex's thread_id →
      // codexSessionId. Exactly one is non-null per run.
      claudeSessionId: null,
      codexSessionId: null,
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

  const agent = spawnAgent({
    taskId,
    runId,
    harness,
    prompt: promptWithRefs,
    cwd: prepared.cwd,
    onChunk,
    onSessionId: (sessionId) => {
      runs.update(runId, harness.kind === "claude-code"
        ? { claudeSessionId: sessionId }
        : { codexSessionId: sessionId });
    },
    opts: { mode: task.mode, model: task.model, effort: task.effort },
  });
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
    writeInput: (line) => agent.writeInput(line),
  });
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
      active.delete(runId);

      // API error / session-death override the exit-code mapping: the driver
      // resolves the turn with code 0 (a clean end_turn was staged), but the
      // run really failed — record it as such so the badge and history are
      // honest.
      const newStatus: RunStatus = wasCancelled
        ? "cancelled"
        : (wasApiError || wasSessionDied) ? "failed"
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
      const isTerminalRun = !!task && task.runId === runId;
      if (isTerminalRun) {
        // Cancellation wins over api-error here, matching the newStatus
        // resolution above — a user-cancelled run shouldn't land in
        // `blocked` just because it had previously hit an API error.
        const nextColumn: ColumnId = wasCancelled
          ? "ready"
          : (wasApiError || wasSessionDied) ? "blocked"
          : newStatus === "succeeded" ? "review" : "ready";
        updateColumn(taskId, runId, nextColumn);
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
      // Spawn the next queued codex follow-up, if any (no-op otherwise).
      drainCodexQueue(taskId);
    })
    .catch((err) => {
      const handle = active.get(runId);
      const wasCancelled = handle?.cancelled ?? false;
      const wasSessionDied = handle?.sessionDied ?? false;
      active.delete(runId);
      const newStatus: RunStatus = wasCancelled ? "cancelled" : "failed";
      runs.update(runId, { status: newStatus, endedAt: Date.now(), exitCode: -1 });
      const task = tasks.get(taskId);
      const isTerminalRun = !!task && task.runId === runId;
      if (isTerminalRun) {
        // A session-death that reaches the reject path (not the case today —
        // both drivers resolve on death — but keep the column consistent with
        // the resolve path if a future refactor ever rejects instead).
        updateColumn(taskId, runId, wasSessionDied ? "blocked" : "ready");
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
      // Spawn the next queued codex follow-up, if any (no-op otherwise).
      drainCodexQueue(taskId);
    });
}

/**
 * Apply inline config edits to a live tmux session where possible — keeps
 * the claude conversation alive (and its accumulated context) across
 * mode/model/effort changes. Called by the PATCH /tasks/:id route after the
 * DB row is updated.
 *
 *   • Agent change (claude ↔ codex): kills any claude tmux session we had
 *     for this task. The new agent will spawn fresh on next Run.
 *   • Same-agent mode / model / effort change on a live claude session:
 *     for `/model` and `/effort` send the real slash command; for the
 *     permission mode there is no slash command, so we call `cycleToMode`
 *     which sends Shift+Tab keystrokes (or `/plan` when the target is plan).
 *     The session keeps running with the new posture.
 *   • Anything else (codex; no live session): no-op — the change just
 *     persists for the next spawn.
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
    // Any queued codex follow-ups belong to the old agent — drop them so a
    // later drain doesn't spawn them against the new harness.
    codexTurnQueue.delete(taskId);
    // Cross-kind switches (e.g. claude-code → codex alias) leave mode/
    // model/effort ids that belong to the old kind's option set; the
    // next spawn would error or fall through to verbatim flags. Reset
    // them server-side so direct API edits get the same safety the
    // RunPanel's `onAgentChange` already applies client-side. Same-kind
    // alias swaps keep the picks — those ids stay valid.
    if (afterKind && beforeKind !== afterKind) {
      const nextMode = AGENT_OPTIONS[afterKind].modes[0]?.id ?? "auto";
      tasks.update(taskId, { mode: nextMode, model: null, effort: null });
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

export function cancelRun(runId: string): boolean {
  const h = active.get(runId);
  if (!h) return false;
  // Stop targets the whole task, not just one run. `kill()` sends Ctrl+C
  // to the tmux session, which also clears claude's queued-input buffer,
  // so every queued run in this task is going down too. Mark each
  // active handle as cancelled so their done handlers record "cancelled"
  // (not "failed") when their slot's reject fires.
  for (const [, handle] of active) {
    if (handle.taskId === h.taskId) handle.cancelled = true;
  }
  // Resolve any in-flight approval / question for this task BEFORE the
  // interrupt — otherwise the hook script's curl and the MCP server's
  // fetch would sit on a doomed HTTP response until their own timeouts.
  cancelPendingForTask(h.taskId, "cancelled by user");
  h.kill();
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
 *   • codex: writes to the active run's stdin (single-run model unchanged).
 */
export function sendInput(runId: string, line: string): SendInputResult {
  const row = db.query<{ task_id: string; agent: string }, [string]>(
    `SELECT task_id, agent FROM runs WHERE id = ?`,
  ).get(runId);
  if (!row) return { delivered: false, reason: "run not found" };

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

  const agent = spawnAgent({
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
      model: task.model,
      effort: task.effort,
      resumeSessionId: priorThreadId,
    },
  });
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
  const agent = spawnAgent({
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
      model: task.model,
      effort: task.effort,
      resumeSessionId: priorSessionId,
    },
  });

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

  let baseRef: string | null = null;
  const workdirRoot = isolation === "worktree" ? await repoRoot(workdir) : null;
  if (workdirRoot) {
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
  // Pin the branch name now so renaming the task later (before the first run)
  // doesn't produce a different branch name on each start attempt. Only set
  // when workdir is confirmed to be a git repo.
  const plannedBranch = workdirRoot ? branchName({ id, title: input.title }) : null;

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
    worktreePath: null,
    baseRef,
    mode: input.mode ?? null,
    model,
    effort,
    references: input.references ?? [],
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
 * Archive a finished task: stamp `archivedAt`, kill its claude tmux session
 * AND any open terminal tabs (both best-effort) so no background shell outlives
 * the user's interest in the task — once archived the card is hidden, so the
 * user can no longer reach those shells to close them. Worktree, run history,
 * and prompt stay intact for later reference.
 *
 * Only allowed when the task is in the `done` column — archive is the
 * terminal step of the explicit review → done → archive flow.
 */
export function archiveTask(taskId: string): { task: Task } | { error: string } {
  const task = tasks.get(taskId);
  if (!task) return { error: "task not found" };
  if (task.column !== "done") {
    return { error: "only tasks in Done can be archived" };
  }
  // Defence-in-depth: column='done' should imply no live run, but column is
  // freely PATCHable (drag-to-Done on a running card is allowed today). If a
  // run is still active, refuse rather than killing tmux out from under it —
  // the exit handler would then flip the now-archived task to 'ready' and
  // leave the row in a contradictory state.
  if (task.runId && active.has(task.runId)) {
    return { error: "task is still running — cancel the run before archiving" };
  }
  if (task.archivedAt != null) {
    return { task };
  }
  const updated = tasks.update(taskId, { archivedAt: Date.now() });
  if (!updated) return { error: "task not found" };
  // Same contract as deleteTask: dropSession is non-throwing (it best-efforts
  // tmux teardown internally). Don't wrap — a silent catch would hide a
  // regression in claude-tmux from the next reviewer.
  const archiveKind = resolveHarness(task.agent)?.kind;
  if (archiveKind === "claude-code") dropSession(taskId);
  else if (archiveKind === "codex") dropCodexSession(taskId);
  codexTurnQueue.delete(taskId);
  // Tear down terminal tabs too — same rationale as the tmux session above.
  // Fire-and-forget (archive keeps the worktree, so there's no removal race);
  // the synchronous part of killTerminalsForTask drops the tabs immediately,
  // the awaited part just reaps the shells. `.catch` keeps the async function's
  // best-effort failures from surfacing as an unhandled rejection.
  void killTerminalsForTask(taskId).catch(() => { /* best-effort */ });
  return { task: updated };
}

/** Reverse of `archiveTask`: clear the timestamp. No tmux work — sending a
 *  follow-up message on a non-archived task already spawns a fresh session via
 *  the resume path. */
export function unarchiveTask(taskId: string): { task: Task } | { error: string } {
  const task = tasks.get(taskId);
  if (!task) return { error: "task not found" };
  if (task.archivedAt == null) return { task };
  const updated = tasks.update(taskId, { archivedAt: null });
  if (!updated) return { error: "task not found" };
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
  // for codex it only exists during an in-flight turn — dropCodexSession also
  // clears any in-memory tailer. No-op when no session exists.
  const deleteKind = resolveHarness(task.agent)?.kind;
  if (deleteKind === "claude-code") dropSession(taskId);
  else if (deleteKind === "codex") dropCodexSession(taskId);
  codexTurnQueue.delete(taskId);
  // Kill any open terminal tabs before removing the worktree — a live shell
  // sitting in the worktree dir would block `git worktree remove`. Awaited so
  // the shells are actually gone before we tear the directory down.
  await killTerminalsForTask(taskId);
  await removeWorktree(task);
  // No per-task attachments directory to clean up — refs are path-only,
  // agetor never copied anything to disk.
  tasks.delete(taskId);
}

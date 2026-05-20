import { randomUUID } from "node:crypto";
import { db, tasks, runs, harnesses } from "./db.ts";
import { spawnAgent, toClaudeModelArg } from "./agents.ts";
import { checkHarness } from "./agent-status.ts";
import {
  AGENT_OPTIONS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  MODEL_EFFORT_SUPPORT,
  type AgentKind,
  type Harness,
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
  cycleToMode,
  type CycleResult,
  dropSession,
  listAgetorSessions,
  killSessionByName,
  reattachSession,
  sendSlashCommand,
  sendTurn,
  sessionExists,
  sessionExistsByName,
  sessionNameFor,
} from "./claude-tmux.ts";
import { prepareWorkdir, removeWorktree, repoRoot, resolveRef, branchName } from "./worktree.ts";
import type {
  ColumnId,
  GlobalEvent,
  RunEvent,
  RunStatus,
  Task,
} from "../shared/types.ts";
import { isApprovalPrompt } from "../shared/types.ts";
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
  /** Fires once when codex narrative output triggers an approval-prompt
   *  heuristic match. Stays unset on claude-code — interactive claude doesn't
   *  surface narrative through stdout that would false-positive. */
  blocked: boolean;
}
const active = new Map<string, ActiveRun>(); // runId -> handle

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(e: RunEvent) {
  for (const fn of listeners) fn(e);
}

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

/**
 * Update a task's column and broadcast the transition. Reads the row's
 * current column first so the global event carries `prev` — saves the UI
 * from keeping its own diff state. Pass `null` for `runId` when the change
 * isn't tied to a specific run (e.g. orphan reconciliation).
 */
function updateColumn(taskId: string, runId: string | null, next: ColumnId): void {
  const before = tasks.get(taskId);
  const prev: ColumnId | null = before?.column ?? null;
  tasks.update(taskId, { column: next });
  if (prev !== next) {
    emitGlobal({ kind: "column", taskId, runId, column: next, prev, ts: Date.now() });
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

// Bridge: interactions.ts publishes new pending entries here so they ride
// the same SSE stream the UI is already subscribed to. The UI distinguishes
// them from regular log events via `stream === "interaction"`.
setBroadcaster((req: AnyRequest) => {
  emit({
    runId: req.runId,
    taskId: req.taskId,
    stream: "interaction",
    data: JSON.stringify(req),
    ts: req.createdAt,
  });
});

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
 * Any leftover `agetor-*` tmux sessions that don't correspond to a still-
 * running DB row are killed at the end — stragglers from a crash or from
 * tasks that were deleted while detached.
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
  const stale = db.query<{ id: string; task_id: string; tmux_session: string | null; claude_session_id: string | null; agent: string }, []>(
    `SELECT id, task_id, tmux_session, claude_session_id, agent FROM runs WHERE status = 'running' ORDER BY started_at DESC, id DESC`,
  ).all();

  const reattachedTaskIds = new Set<string>();
  const orphaned: { id: string; task_id: string; prevColumn: ColumnId | null }[] = [];

  for (const row of stale) {
    const task = tasks.get(row.task_id);
    const prevColumn: ColumnId | null = task?.column ?? null;
    const kind = resolveHarness(row.agent)?.kind ?? null;
    // Only claude-code runs can be reattached (codex runs spawn a single
    // child process that died with us). Need a tmux session name, a
    // claude session id (for the JSONL path), and the session must still
    // be alive on this machine. Also: if we already reattached a newer
    // sibling for this task, orphan the older one — only one SessionState
    // can drive a given tmux session at a time.
    const canTryReattach =
      kind === "claude-code"
      && task !== null
      && row.tmux_session !== null
      && row.claude_session_id !== null
      && !reattachedTaskIds.has(row.task_id)
      && sessionExistsByName(row.tmux_session);

    if (canTryReattach && task) {
      const cwd = task.worktreePath ?? task.workdir;
      const harness = resolveHarness(task.agent);
      const onChunk = makeChunkHandler(row.id, row.task_id, kind, task.mode);
      const spawned = reattachSession({
        taskId: row.task_id,
        cwd,
        sessionId: row.claude_session_id as string,
        configDir: harness?.home ?? null,
        onChunk,
        seenLineUuids: runs.seenLineUuids(row.id),
      });
      if (spawned) {
        registerActiveRun(row.id, row.task_id, task, spawned);
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

  // Kill any leftover `agetor-*` tmux sessions whose task didn't reattach.
  // These are real stragglers — crash artifacts or sessions whose task was
  // deleted while agetor was down. Sessions matched to a reattached run
  // are spared (they're now driven by the new process's session state).
  let killedStragglers = 0;
  for (const name of listAgetorSessions()) {
    // Session names are `agetor-<taskId-prefix>` (first 12 chars). Spare
    // any session whose prefix matches a reattached taskId.
    const matchesReattached = [...reattachedTaskIds].some(
      (id) => name === sessionNameFor(id),
    );
    if (matchesReattached) continue;
    killSessionByName(name);
    killedStragglers++;
  }

  if (reattachedTaskIds.size > 0) {
    console.log(`[agetor] reattached to ${reattachedTaskIds.size} live tmux session(s)`);
  }
  if (orphaned.length > 0) {
    console.log(`[agetor] orphaned ${orphaned.length} run(s) with no recoverable session`);
  }
  if (killedStragglers > 0) {
    console.log(`[agetor] killed ${killedStragglers} stale tmux session(s) with no matching run`);
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
      tmuxSession: harness.kind === "claude-code" ? sessionNameFor(taskId) : null,
      // Filled in by spawnAgent's onSessionId callback once claude's JSONL
      // file is discovered. Null for codex (no comparable session id).
      claudeSessionId: null,
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
  onChunk("user", promptWithRefs);

  const agent = spawnAgent({
    taskId,
    harness,
    prompt: promptWithRefs,
    cwd: prepared.cwd,
    onChunk,
    onSessionId: (sessionId) => {
      runs.update(runId, { claudeSessionId: sessionId });
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
 * SSE listeners, and (for codex only) runs the approval-prompt heuristic
 * that flips the kanban column to `blocked` when the agent appears to be
 * waiting on the user. Claude doesn't need that heuristic — interactive
 * permission prompts surface inside the TUI, not in the JSONL stream, so the
 * column flip would never get a true positive there.
 */
function makeChunkHandler(
  runId: string,
  taskId: string,
  kind: AgentKind,
  mode: Task["mode"],
) {
  return (stream: RunEvent["stream"], data: string, lineUuid?: string) => {
    runs.appendEvent(runId, stream, data, lineUuid);
    emit({ runId, taskId, stream, data, ts: Date.now() });
    if (kind !== "codex") return;
    const handle = active.get(runId);
    const promptingMode = mode && mode !== "auto";
    if (
      handle
      && !handle.blocked
      && !handle.cancelled
      && promptingMode
      && isApprovalPrompt(data)
    ) {
      handle.blocked = true;
      updateColumn(taskId, runId, "blocked");
      emit({
        runId,
        taskId,
        stream: "status",
        data: "blocked — agent is waiting on user input",
        ts: Date.now(),
      });
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
    blocked: false,
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
      active.delete(runId);

      const newStatus: RunStatus = wasCancelled
        ? "cancelled"
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
        updateColumn(taskId, runId, newStatus === "succeeded" ? "review" : "ready");
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
    })
    .catch((err) => {
      const handle = active.get(runId);
      const wasCancelled = handle?.cancelled ?? false;
      active.delete(runId);
      const newStatus: RunStatus = wasCancelled ? "cancelled" : "failed";
      runs.update(runId, { status: newStatus, endedAt: Date.now(), exitCode: -1 });
      const task = tasks.get(taskId);
      const isTerminalRun = !!task && task.runId === runId;
      if (isTerminalRun) {
        updateColumn(taskId, runId, "ready");
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
 *   • claude-code: each user message is its own turn → its own run row. We
 *     paste the prompt into the live tmux session and queue a new run
 *     slot. If a turn is already in flight, claude's TUI accepts the
 *     keystrokes and replays the prompt as a *new* user turn once the
 *     current one ends — our session state mirrors that with a FIFO of
 *     resolveTurn slots so each queued run resolves on its own end_turn.
 *
 *   • codex: writes to the active run's stdin (single-run model unchanged).
 */
export function sendInput(runId: string, line: string): SendInputResult {
  const row = db.query<{ task_id: string; agent: string }, [string]>(
    `SELECT task_id, agent FROM runs WHERE id = ?`,
  ).get(runId);
  if (!row) return { delivered: false, reason: "run not found" };

  if (resolveHarness(row.agent)?.kind === "claude-code") {
    const result = sendClaudeTurn(row.task_id, line);
    return result
      ? { delivered: true, runId: result }
      : { delivered: false, reason: "internal: task lookup failed" };
  }

  const h = active.get(runId);
  if (!h) return { delivered: false, reason: "stdin is closed — the agent has already finished" };
  const ok = h.writeInput(line);
  if (ok) {
    const ts = Date.now();
    runs.appendEvent(runId, "user", line);
    emit({ runId, taskId: row.task_id, stream: "user", data: line, ts });
    return { delivered: true, runId };
  }
  return { delivered: false, reason: "stdin write failed" };
}

/**
 * Send a follow-up prompt to a claude task. Always creates a new run row so
 * the run history shows each user message as its own entry.
 *
 *   • If the task's tmux session is still alive, we paste the prompt into it
 *     as a fresh turn (`sendTurn`).
 *   • If the session is gone (app restart killed it, the previous run ended
 *     and tmux was torn down, etc.), we spawn a brand-new session and use a
 *     combined "previous context + new user message" prompt so claude has
 *     enough continuity to keep going.
 *
 * Returns false only on internal lookup failure (missing task row). Sessions
 * are always recoverable as long as the task itself still exists.
 */
function sendClaudeTurn(taskId: string, line: string): string | null {
  const task = tasks.get(taskId);
  if (!task) return null;

  if (sessionExists(taskId)) {
    return sendTurnInExistingSession(task, taskId, line);
  }
  return spawnResumedSession(task, taskId, line);
}

function sendTurnInExistingSession(task: Task, taskId: string, line: string): string {
  // One run row per user turn — the runs list mirrors the conversation
  // history at turn granularity. The race that used to make a fast claude
  // reply land the new row as "succeeded" before the UI ever observed the
  // "running" transition no longer matters: the unified task-level event
  // stream surfaces the new user/assistant messages live regardless of
  // which run row they belong to.
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
  });
  const prevColumn: ColumnId = task.column;
  tasks.update(taskId, { column: "running", runId: newRunId });
  if (prevColumn !== "running") {
    emitGlobal({ kind: "column", taskId, runId: newRunId, column: "running", prev: prevColumn, ts: now });
  }

  const harness = resolveHarness(task.agent);
  const kind: AgentKind = harness?.kind ?? "claude-code";
  const onChunk = makeChunkHandler(newRunId, taskId, kind, task.mode);
  onChunk("user", line);

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
  });
  const prevColumn: ColumnId = task.column;
  tasks.update(taskId, { column: "running", runId: newRunId });
  if (prevColumn !== "running") {
    emitGlobal({ kind: "column", taskId, runId: newRunId, column: "running", prev: prevColumn, ts: now });
  }

  const harness = resolveHarness(task.agent);
  const kind: AgentKind = harness?.kind ?? "claude-code";
  const onChunk = makeChunkHandler(newRunId, taskId, kind, task.mode);
  onChunk("user", line);
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

  const task = tasks.insert({
    id,
    title: input.title,
    prompt: input.prompt,
    column: input.column ?? "backlog",
    agent: agentId,
    workdir,
    isolation,
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
    createdAt: now,
    updatedAt: now,
  });
  return { task };
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
  // For claude tasks the tmux session outlives any individual run — kill it
  // here before tearing down the worktree so we don't leave an orphaned
  // session behind. No-op when the task is codex or no session exists.
  if (resolveHarness(task.agent)?.kind === "claude-code") dropSession(taskId);
  await removeWorktree(task);
  // No per-task attachments directory to clean up — refs are path-only,
  // agetor never copied anything to disk.
  tasks.delete(taskId);
}

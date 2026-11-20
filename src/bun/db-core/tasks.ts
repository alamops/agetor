import type { Database } from "bun:sqlite";
import { type AgentProfileSnapshot, type ImportedClaudeSession, type ImportedOpencodeSession, type PipelineRunState, type SentFileEntry, type Task, type TaskFxRecovery, type TaskType, parseTaskHarnessState, type TaskHarnessState, type TaskListArchived, type TaskPr, type TaskRepository } from "../../shared/types.ts";
import { mergeSentFiles as mergeSentFilesShared } from "../../shared/sent-files.ts";
import { parseTaskFxRecovery } from "../../shared/fx-recovery.ts";
import { isMultiRepoTask } from "../../shared/multi-repo.ts";
import { appendTaskPr, firstPrUrl, legacyTaskPrs, parseTaskPrs } from "../../shared/task-prs.ts";
import { foldPipelineStepCounts } from "./task-decoration.ts";
import { ImportedClaudeSessionTaken, ImportedOpencodeSessionTaken, isUniqueConstraintError } from "./errors.ts";
import { OPENABLE_STATUSES_SQL, type TaskCounts, type TaskRow, derivedRepositories, parseAgentProfileSnapshot, parseBacklog, parseDraft, parseImportedClaude, parseImportedOpencode, parsePipelineRunState, parsePlans, parseRefs, parseSentFiles, parseTaskRepositories, parseTodoProgress, readOpencodeServer, serializeRepositories, speedFields } from "./task-parsers.ts";


// db-core never imports the main-thread registries (`interactions.ts`,
// `terminals.ts`): the in-memory badge counts folded into a `Task` come in
// through this interface. A worker-thread connection takes the default, which
// reports none; `db.ts` passes the real registries on the main thread.
export interface TaskDecorationDeps {
  countPendingForTask(taskId: string): number;
  countTerminals(taskId: string): number;
  pendingCountsByTask(): Map<string, number>;
  terminalCountsByTask(): Map<string, number>;
}

export const NO_TASK_DECORATIONS: TaskDecorationDeps = {
  countPendingForTask: () => 0,
  countTerminals: () => 0,
  pendingCountsByTask: () => new Map(),
  terminalCountsByTask: () => new Map(),
};

export interface TasksDeps {
  /** Adopts a deleted task's handoff copies (`tasks.delete`). */
  harnessOrphanedCopies: { adoptFromTask(taskId: string): unknown };
  decorations?: TaskDecorationDeps;
}

export const toTaskRow = (r: TaskRow, counts: TaskCounts | undefined, decor: TaskDecorationDeps): Task => {
  const storedRepositories = parseTaskRepositories(r.repositories);
  const prs = parseTaskPrs(r.prs);
  return {
  id: r.id,
  title: r.title,
  prompt: r.prompt,
  column: r.column as Task["column"],
  agent: r.agent as Task["agent"],
  workdir: r.workdir,
  isolation: r.isolation as Task["isolation"],
  taskType: r.task_type as TaskType,
  branch: r.branch,
  branchSource: r.branch_source as Task["branchSource"],
  worktreePath: r.worktree_path,
  baseRef: r.base_ref,
  // Deprecated and derived from `prs` (the older single field), so older
  // clients keep working. Null for a multi-repository task, whose PRs live on
  // `repositories[].prs` and whose task-level list stays empty.
  prUrl: firstPrUrl(prs),
  prs,
  baseBranch: r.base_branch ?? null,
  issueUrl: r.issue_url,
  mode: r.mode,
  model: r.model,
  effort: r.effort,
  ...speedFields(r.speed),
  maxMode: r.max_mode === 1,
  opencodeServer: readOpencodeServer(r.opencode_server),
  references: parseRefs(r.refs),
  backlog: parseBacklog(r.backlog),
  draft: parseDraft(r.draft),
  plans: parsePlans(r.plans),
  runId: r.run_id,
  // `has_openable_run` comes back as SQLite's 0/1; missing means we didn't
  // join (e.g. insert/update returning the freshly-written shape, where
  // no runs exist yet → false is the right default).
  hasOpenableRun: r.has_openable_run === 1,
  pendingInteractionCount: counts?.pending ? (counts.pending.get(r.id) ?? 0) : decor.countPendingForTask(r.id),
  openTerminalCount: counts?.terminals ? (counts.terminals.get(r.id) ?? 0) : decor.countTerminals(r.id),
  todoProgress: parseTodoProgress(r.todo_progress),
  sentFiles: parseSentFiles(r.sent_files),
  fxRecovery: parseTaskFxRecovery(r.fx_recovery),
  agentProfileId: r.agent_profile_id ?? null,
  agentProfile: parseAgentProfileSnapshot(r.agent_profile),
  pipelineId: r.pipeline_id ?? null,
  pipelineRun: parsePipelineRunState(r.pipeline_run),
  pipelineParentId: r.pipeline_parent_id ?? null,
  pipelineStepId: r.pipeline_step_id ?? null,
  harnessState: parseTaskHarnessState(r.harness_state),
  checkoutBranch: r.checkout_branch ?? null,
  // Multi-repository rows keep their stored set — one entry included, once
  // repositories were removed down to one; every single-repository row (and
  // every legacy row, whose column is `'[]'`) derives exactly one entry from
  // the scalar columns so callers never branch on `undefined`.
  repositories: storedRepositories.length > 0 ? storedRepositories : derivedRepositories(r),
  // Derived, never stored in its own column: only a multi row stores its set
  // (see `tasks.insert`/`setRepositories`). Every multi/single decision reads
  // this through `isMultiRepoTask`, never the entry count.
  multiRepo: storedRepositories.length > 0,
  issueRepoPath: r.issue_repo_path ?? null,
  importedClaude: parseImportedClaude(r.imported_claude),
  importedOpencode: parseImportedOpencode(r.imported_opencode),
  // Derived, never stored: a monotonic-id watermark comparison, race-free by
  // construction (see migration 045's doc comment). NULL
  // `last_assistant_event_id` (no assistant event ever observed) always
  // reads as false, matching "an upgraded/brand-new DB starts all-read".
  unread: r.last_assistant_event_id != null && r.last_assistant_event_id > (r.last_seen_event_id ?? 0),
  // Derived, never stored: whether the task has ever observed a top-level
  // assistant event — the gate for "Mark as unread" (there's nothing to
  // honestly re-flag on a task that's never gotten a response).
  hasAssistantMessages: r.last_assistant_event_id != null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  archivedAt: r.archived_at,
  };
};

// LEFT JOIN + aggregation, so the runs scan happens once instead of once
// per task row. `MAX(...)` over a boolean gives us 1 if any matching run
// exists for the task, 0 otherwise (NULL coalesces to 0 via COALESCE).
export const TASKS_SELECT = `
  SELECT tasks.*,
         COALESCE(MAX(runs.status IN ${OPENABLE_STATUSES_SQL}), 0) AS has_openable_run
    FROM tasks
    LEFT JOIN runs ON runs.task_id = tasks.id
`;

export function makeTasks(conn: Database, deps: TasksDeps) {
  const { harnessOrphanedCopies } = deps;
  const decor = deps.decorations ?? NO_TASK_DECORATIONS;
  const { pendingCountsByTask, terminalCountsByTask } = decor;
  const toTask = (r: TaskRow, counts?: TaskCounts): Task => toTaskRow(r, counts, decor);

  /**
   * Compare-then-write one entry's `checkoutBranch` in a stored multi-repository
   * set (`tasks.setRepositoryCheckout`). An empty stored set is a
   * single-repository row, whose checkout lives in the scalar `checkout_branch`
   * column instead, so it is left alone. A stored set of ONE entry is a
   * multi-repository row whose other repositories were removed
   * (`removeTaskRepository`), so it is written like any multi row. Never bumps
   * `updated_at`: the column is server-managed
   * (docs/architecture/persistence.md).
   */
  function writeRepositoryCheckout(
    taskId: string,
    storedRepositories: string | null,
    repoName: string,
    value: string | null,
  ): void {
    const repos = parseTaskRepositories(storedRepositories);
    if (repos.length === 0) return;
    let changed = false;
    const next = repos.map((r) => {
      if (r.name !== repoName || r.checkoutBranch === value) return r;
      changed = true;
      return { ...r, checkoutBranch: value };
    });
    if (changed) conn.run(`UPDATE tasks SET repositories = ? WHERE id = ?`, [serializeRepositories(next), taskId]);
  }

  const tasks = {
    // Computes the pending-interaction and open-terminal grouped counts ONCE
    // for the whole result set (two single-pass scans over their respective
    // in-memory maps) instead of once per row via `toTask`'s per-task fallback
    // — this is the hot path hit by the 2s `/tasks` poll.
    //
    // `archived` filters in SQL, before the runs join and `toTask`'s parse, so
    // the board's `exclude` poll never touches an archived row (on a DB with
    // thousands of archived tasks that is most of the list's bytes). `keepIds`
    // are returned whatever their archive state. No argument returns every
    // task, which every in-process caller relies on.
    list(opts: { archived?: TaskListArchived; keepIds?: readonly string[] } = {}): Task[] {
      const archived = opts.archived ?? "include";
      const keepIds = opts.keepIds ?? [];
      let where = "";
      if (archived !== "include") {
        const state = archived === "exclude" ? "tasks.archived_at IS NULL" : "tasks.archived_at IS NOT NULL";
        where = keepIds.length > 0
          ? `WHERE (${state} OR tasks.id IN (${keepIds.map(() => "?").join(", ")}))`
          : `WHERE ${state}`;
      }
      const params = archived !== "include" ? [...keepIds] : [];
      const rows = conn.query<TaskRow, string[]>(
        `${TASKS_SELECT}
         ${where}
         GROUP BY tasks.id
         ORDER BY tasks.created_at DESC`,
      ).all(...params);
      // D11: fold each hidden step's pending count into its pipeline parent's.
      const pending = foldPipelineStepCounts(
        pendingCountsByTask(),
        rows.map((r) => ({ id: r.id, pipelineParentId: r.pipeline_parent_id })),
      );
      const counts: TaskCounts = { pending, terminals: terminalCountsByTask() };
      return rows.map((r) => toTask(r, counts));
    },
    /** Primary-key existence. Import backfill uses this instead of `get`,
     *  which joins runs and parses the whole row, once per transcript line. */
    exists(id: string): boolean {
      if (!id) return false;
      const row = conn.query<{ one: number }, [string]>(
        `SELECT 1 AS one FROM tasks WHERE id = ? LIMIT 1`,
      ).get(id);
      return row != null;
    },
    /** Tasks whose import is still `importing`. Reads only the provenance
     *  column and parses it in process, so a malformed blob cannot abort boot
     *  the way `json_extract` would, and resume does not pay for `list()`'s
     *  runs join or badge scans. */
    importingClaudeIds(): string[] {
      const rows = conn.query<{ id: string; imported_claude: string }, []>(
        `SELECT id, imported_claude FROM tasks WHERE imported_claude IS NOT NULL`,
      ).all();
      const ids: string[] = [];
      for (const row of rows) {
        if (parseImportedClaude(row.imported_claude)?.status === "importing") ids.push(row.id);
      }
      return ids;
    },
    /** Tasks whose OpenCode import is still `importing` — the
     *  {@link importingClaudeIds} counterpart, same in-process parse. */
    importingOpencodeIds(): string[] {
      const rows = conn.query<{ id: string; imported_opencode: string }, []>(
        `SELECT id, imported_opencode FROM tasks WHERE imported_opencode IS NOT NULL`,
      ).all();
      const ids: string[] = [];
      for (const row of rows) {
        if (parseImportedOpencode(row.imported_opencode)?.status === "importing") ids.push(row.id);
      }
      return ids;
    },
    get(id: string): Task | null {
      const row = conn.query<TaskRow, [string]>(
        `${TASKS_SELECT}
         WHERE tasks.id = ?
         GROUP BY tasks.id`,
      ).get(id);
      if (!row) return null;
      const task = toTask(row);
      // M17: a single-task read must show the same honest "waiting on you"
      // total `list()` already computes in its batched D11 pass above — every
      // consumer of `GET /tasks/:id` (and anything built on it, like
      // `withRunningSubagents` or `GET /tasks/:id/pipeline`) would otherwise
      // disagree with the board's 2s `/tasks` poll about whether a pipeline
      // parent has anything pending. Gated on `pipeline_id` (only ever set on
      // a real pipeline parent row, never on a step) so an ordinary task's
      // `get` pays no extra query.
      if (!row.pipeline_id) return task;
      let stepPending = 0;
      for (const step of this.stepsForParent(id)) stepPending += step.pendingInteractionCount;
      return stepPending > 0
        ? { ...task, pendingInteractionCount: task.pendingInteractionCount + stepPending }
        : task;
    },
    /** Every hidden step task of a pipeline parent (`pipeline_parent_id =
     *  parentId`), oldest first — the order steps were inserted in, which is
     *  also execution order for a linear run (a fan-out/join run interleaves
     *  by `created_at` same as any other insert order). Used by the pipeline
     *  runner and `GET /tasks/:id/pipeline`. Reuses `TASKS_SELECT` (not a bare
     *  `SELECT *`) so `hasOpenableRun` is computed the same way it is for
     *  every other task read in this file. */
    stepsForParent(parentId: string): Task[] {
      const rows = conn.query<TaskRow, [string]>(
        `${TASKS_SELECT}
         WHERE tasks.pipeline_parent_id = ?
         GROUP BY tasks.id
         ORDER BY tasks.created_at ASC, tasks.id ASC`,
      ).all(parentId);
      return rows.map((r) => toTask(r));
    },
    insert(t: Task): Task {
      conn.run(
        `INSERT INTO tasks
         (id, title, prompt, "column", agent, workdir, isolation, task_type,
          branch, branch_source, worktree_path, base_ref, base_branch, prs, issue_url, mode, model, effort, speed, max_mode, opencode_server, refs, backlog, draft, plans, todo_progress,
          agent_profile_id, agent_profile,
          pipeline_id, pipeline_run, pipeline_parent_id, pipeline_step_id,
          checkout_branch,
          repositories, issue_repo_path,
          last_assistant_event_id, last_seen_event_id,
          run_id, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          t.id, t.title, t.prompt, t.column, t.agent, t.workdir, t.isolation,
          t.taskType,
          t.branch, t.branchSource, t.worktreePath, t.baseRef,
          // `pr_url` is retired (migration 092) and stays NULL on new rows.
          t.baseBranch ?? null,
          // A caller still on the older shape (a `prUrl`, no `prs`) keeps its PR.
          JSON.stringify(t.prs ?? legacyTaskPrs(t.prUrl, t.checkoutBranch ?? t.branch, t.updatedAt)),
          t.issueUrl ?? null, t.mode, t.model, t.effort, t.speed, t.maxMode ? 1 : 0,
          readOpencodeServer(t.opencodeServer),
          JSON.stringify(t.references ?? []),
          JSON.stringify(t.backlog ?? []),
          t.draft ? JSON.stringify(t.draft) : null,
          JSON.stringify(t.plans ?? []),
          t.todoProgress ? JSON.stringify(t.todoProgress) : null,
          t.agentProfileId ?? null,
          t.agentProfile ? JSON.stringify(t.agentProfile) : null,
          t.pipelineId ?? null,
          t.pipelineRun ? JSON.stringify(t.pipelineRun) : null,
          t.pipelineParentId ?? null,
          t.pipelineStepId ?? null,
          t.checkoutBranch ?? null,
          // Multi-repo rows store their set; single-repo rows store '[]' and
          // `toTask` derives the one entry from the scalar columns above. A
          // pipeline step copying a one-repository multi parent passes
          // `multiRepo: true`, so it stores its one entry and stays multi.
          isMultiRepoTask(t) && t.repositories && t.repositories.length > 0 ? serializeRepositories(t.repositories) : "[]",
          t.issueRepoPath ?? null,
          // A brand-new task has never had an assistant event or a mark-seen
          // — both start NULL, which `toTask` reads as `unread: false`.
          null, null,
          t.runId, t.createdAt, t.updatedAt, t.archivedAt ?? null,
        ],
      );
      // Round-trip via `get` so the returned shape carries the computed
      // hasOpenableRun field (false for a brand-new task — but callers
      // that mutate t shouldn't accidentally get a stale shape).
      return this.get(t.id) ?? { ...t, hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0, todoProgress: t.todoProgress ?? null, sentFiles: null, fxRecovery: null, agentProfileId: t.agentProfileId ?? null, agentProfile: t.agentProfile ?? null, pipelineId: t.pipelineId ?? null, pipelineRun: t.pipelineRun ?? null, pipelineParentId: t.pipelineParentId ?? null, pipelineStepId: t.pipelineStepId ?? null, checkoutBranch: t.checkoutBranch ?? null, repositories: t.repositories ?? [], multiRepo: isMultiRepoTask(t), issueRepoPath: t.issueRepoPath ?? null, opencodeServer: readOpencodeServer(t.opencodeServer), importedClaude: null, importedOpencode: null, unread: false, hasAssistantMessages: false, archivedAt: null };
    },
    /** `fast` is excluded from the patch type: it is only the derived echo of
     *  `speed` (the column migration 072 dropped), so a caller changes the tier
     *  through `speed` alone. */
    update(id: string, patch: Partial<Omit<Task, "fast">>): Task | null {
      const current = this.get(id);
      if (!current) return null;
      const next: Task = { ...current, ...patch, id, updatedAt: Date.now() };
      // Deliberately does NOT touch last_assistant_event_id/last_seen_event_id
      // — those two columns are written exclusively by `noteAssistantEvent` /
      // `markSeen` below via their own targeted UPDATEs. `Task` only exposes
      // the derived `unread` boolean (see `toTask`), never the raw watermark
      // ints, so there is nothing for a generic patch to carry for these
      // columns anyway; omitting them from the SET clause is what makes an
      // unrelated field edit (title, column, …) leave the watermark untouched.
      // `sent_files` (migration 050) joins them as a third server-managed
      // column this clause skips — it's written only by `tasks.mergeSentFiles`
      // below via its own targeted UPDATE, on the same rationale: an unrelated
      // PATCH must not clobber a concurrent `SendUserFile` delivery, and (like
      // the watermarks) the write must not bump `updated_at` either, or the
      // board would re-render every task on every 2s poll.
      // `fx_recovery` (migration 051) joins the same skip list for the same
      // reason again: it's written only by `tasks.setFxRecovery` below via its
      // own targeted UPDATE, and a generic PATCH (title, column, mode, …)
      // landing mid-pause must never silently cancel a live auto-resume
      // schedule or wipe the paused badge — that write also never bumps
      // `updated_at`.
      // `agent_profile_id`/`agent_profile` (migration 053) join the same skip
      // list too: they're written only by `tasks.insert` (create time) and
      // `tasks.setAgentProfile` below via its own targeted UPDATE. A generic
      // PATCH must never clobber the point-in-time snapshot — most pointedly,
      // the copy-down of the profile's own fields (agent/model/effort/mode/
      // speed/maxMode) that `startTask` performs right before a task's first
      // run must not race a concurrent unrelated edit into silently detaching
      // the profile — and, like the watermarks/`sent_files`/`fx_recovery`,
      // this write never bumps `updated_at` either.
      // `pipeline_id`/`pipeline_run`/`pipeline_parent_id`/`pipeline_step_id`
      // (migration 058) join the same skip list: the first two are written
      // only by `tasks.insert` (create time) and `tasks.setPipelineRun` below
      // via its own targeted UPDATE, the last two only by `tasks.insert` and
      // never change again. A generic PATCH must never clobber a live run's
      // progress or a step task's fixed pipeline identity, and (like every
      // other server-managed column above) none of these writes bump
      // `updated_at`.
      // `checkout_branch` (migration 063) joins the same skip list: it's
      // written only by `tasks.insert` (create time) and
      // `tasks.setCheckoutBranch` below via its own targeted UPDATE. A generic
      // PATCH must never overwrite the last-observed checkout with whatever
      // stale copy the caller read earlier, and (like every other
      // server-managed column above) the write never bumps `updated_at`.
      // `imported_claude` (migration 068) and `imported_claude_session_id`
      // (migration 069) join the same skip list: both are written only by
      // `tasks.setImportedClaude` below, in one UPDATE. A generic PATCH must
      // never clobber an in-flight history backfill or drop the session claim,
      // and that write never bumps `updated_at`. `tasks.insert` leaves both
      // columns NULL.
      // `imported_opencode`/`imported_opencode_session_id` (migration 079)
      // join the same skip list on the same rationale: both are written only
      // by `tasks.setImportedOpencode` below. `opencode_server` (also 078) is
      // NOT skipped — it is an ordinary patchable launch field like `speed`.
      // `base_branch` and `prs` (migration 092) join the same skip list: the
      // first is written only by `tasks.insert` and never changes, the second
      // only by `tasks.appendPr`'s targeted UPDATE. `pr_url` is retired: the
      // column stays for a downgrade but nothing writes it any more. A generic
      // PATCH must never drop a recorded PR, and none of these writes bump
      // `updated_at`.
      // `harness_state` (migration 084) joins the same skip list: it is written
      // only by `tasks.setHarnessState` below (and the failover engine through
      // it). A generic PATCH must never clobber a pending swap, the retry
      // countdown or the lap's `tried` set, and that write never bumps
      // `updated_at`.
      conn.run(
        `UPDATE tasks SET
         title=?, prompt=?, "column"=?, agent=?, workdir=?, isolation=?, task_type=?,
         branch=?, branch_source=?, worktree_path=?, base_ref=?, issue_url=?, mode=?, model=?, effort=?, speed=?, max_mode=?, opencode_server=?, refs=?, backlog=?, draft=?, plans=?, todo_progress=?,
         run_id=?, updated_at=?, archived_at=?
       WHERE id=?`,
        [
          next.title, next.prompt, next.column, next.agent, next.workdir, next.isolation,
          next.taskType,
          next.branch, next.branchSource, next.worktreePath, next.baseRef, next.issueUrl ?? null, next.mode, next.model, next.effort, next.speed, next.maxMode ? 1 : 0,
          readOpencodeServer(next.opencodeServer),
          JSON.stringify(next.references ?? []),
          JSON.stringify(next.backlog ?? []),
          next.draft ? JSON.stringify(next.draft) : null,
          JSON.stringify(next.plans ?? []),
          next.todoProgress ? JSON.stringify(next.todoProgress) : null,
          next.runId, next.updatedAt, next.archivedAt ?? null, id,
        ],
      );
      // Re-fetch so hasOpenableRun reflects the row state immediately after
      // this UPDATE. Note: callers that update the task AND mutate runs in
      // the same db transaction (e.g. orchestrator's startTask) get a value
      // computed at the moment `update` runs — if a `runs.insert` follows,
      // the returned Task's hasOpenableRun won't see it. Subsequent
      // `tasks.get` / `tasks.list` calls after the txn commits will.
      return this.get(id) ?? next;
    },
    delete(id: string) {
      // The handoff rows cascade with the task; any copies they still hold are
      // orphaned first so a later sweep can remove them (migration 088).
      conn.transaction(() => {
        harnessOrphanedCopies.adoptFromTask(id);
        conn.run(`DELETE FROM tasks WHERE id = ?`, [id]);
      }).immediate();
    },
    /**
     * Mark a task's unread watermark caught-up-to-date: `last_seen_event_id`
     * catches up to `last_assistant_event_id` in a single guarded UPDATE, so
     * the read-then-write is atomic (no SELECT + UPDATE race) and the
     * statement no-ops entirely when the task is already caught up (the
     * common case — the panel-open/close effect fires on every selection
     * change). Called from `POST /tasks/:id/seen` on both open and close of
     * the run panel (plan §3). Returns the freshly updated Task, or null if
     * the task doesn't exist.
     */
    markSeen(taskId: string): Task | null {
      // No-op when already caught up, and no `updated_at` bump either way:
      // the watermark is server-managed read-state, not a task mutation, and
      // touching `updated_at` here would defeat `reconcileById`'s identity
      // preservation (every panel open/close would re-render the board).
      conn.run(
        `UPDATE tasks SET
         last_seen_event_id = last_assistant_event_id
       WHERE id = ?
         AND last_assistant_event_id IS NOT NULL
         AND COALESCE(last_seen_event_id, 0) < last_assistant_event_id`,
        [taskId],
      );
      return this.get(taskId);
    },
    /**
     * Mark a task's unread watermark back to un-caught-up: `last_seen_event_id`
     * is set to `last_assistant_event_id - 1` (not `0` or `NULL`) so exactly
     * the latest assistant message reads as unread — matching "one new
     * message" semantics for a future unread count, rather than an arbitrary
     * pile of history. Single guarded UPDATE, atomic (no SELECT + UPDATE
     * race). The `>=` guard makes this a no-op when the task is already
     * unread, so it can never move an already-lower watermark back up (e.g. a
     * stale double-click on "Mark as unread"). A task with no assistant event
     * yet (`last_assistant_event_id IS NULL`) is also a no-op — there is
     * nothing to honestly re-flag. Called from `DELETE /tasks/:id/seen`
     * (board's task context menu). Returns the freshly updated Task, or null
     * if the task doesn't exist.
     */
    markUnread(taskId: string): Task | null {
      // No `updated_at` bump, same reason as `markSeen`: this is server-managed
      // read-state, not a task mutation, and touching `updated_at` would defeat
      // `reconcileById`'s identity preservation.
      conn.run(
        `UPDATE tasks SET
         last_seen_event_id = last_assistant_event_id - 1
       WHERE id = ?
         AND last_assistant_event_id IS NOT NULL
         AND COALESCE(last_seen_event_id, 0) >= last_assistant_event_id`,
        [taskId],
      );
      return this.get(taskId);
    },
    /**
     * Monotonic bump of the unread watermark's producer side — called by the
     * orchestrator's chunk handler after persisting a top-level (non-subagent)
     * `assistant` event. Only writes when `eventId` is strictly greater than
     * the current value (or the column is still NULL), so an out-of-order
     * call — e.g. two chunks racing, or a reattach replay re-delivering an
     * older id — can never move the watermark backwards and spuriously
     * re-flag a task the user already caught up on.
     */
    noteAssistantEvent(taskId: string, eventId: number): void {
      // Deliberately does NOT bump `updated_at`: this fires on every assistant
      // chunk of a streaming task, and moving `updated_at` would change the
      // row's JSON on every 2s poll — defeating `reconcileById`'s identity
      // preservation and re-rendering the card/column/RunPanel while a task
      // merely streams. The `unread` flip itself changes the JSON when it
      // matters.
      conn.run(
        `UPDATE tasks SET
         last_assistant_event_id = ?
       WHERE id = ? AND (last_assistant_event_id IS NULL OR last_assistant_event_id < ?)`,
        [eventId, taskId, eventId],
      );
    },
    /**
     * Merge newly delivered `SendUserFile` files into a task's persisted
     * `sent_files` column — called by the orchestrator's chunk handler once a
     * `tool_result` confirms delivery (never on the tool_use alone). Reads the
     * row's current `sent_files`, merges via the shared
     * {@link mergeSentFilesShared} (dedupe by path, latest `sentAt` wins,
     * capped to `MAX_SENT_FILES`), and writes the result back with a single
     * targeted `UPDATE` — same pattern as `markSeen`/`markUnread`/
     * `noteAssistantEvent` above: no `updated_at` bump (this is server-managed
     * delivery state, not a task mutation, and bumping it would re-render
     * every task on every 2s poll), and it bypasses the generic `update`'s SET
     * clause entirely so a concurrent unrelated PATCH can't race it. An empty
     * `incoming` is a no-op that still returns the current `Task` (mirrors
     * `mergeSentFilesShared([...], [])` returning `existing` unchanged, minus
     * the wasted UPDATE). Returns `null` when the task doesn't exist.
     */
    mergeSentFiles(taskId: string, incoming: SentFileEntry[]): Task | null {
      const current = this.get(taskId);
      if (!current) return null;
      if (incoming.length === 0) return current;

      const merged = mergeSentFilesShared(current.sentFiles ?? [], incoming);
      conn.run(
        `UPDATE tasks SET sent_files = ? WHERE id = ?`,
        [JSON.stringify(merged), taskId],
      );
      return this.get(taskId);
    },
    /**
     * Overwrite a task's persisted fx pause + auto-resume state in one
     * targeted `UPDATE` — same pattern as `mergeSentFiles` above: no
     * `updated_at` bump (server-managed state, not a task mutation — bumping
     * it would re-render every task on every 2s poll) and it bypasses the
     * generic `update`'s SET clause entirely so a concurrent unrelated PATCH
     * can't race it. Called by the orchestrator at every point in the fx
     * pause lifecycle (§3 of `docs/plans/fx-recovery-follow-ups.md`):
     * recording a fresh pause, updating the `autoResume` schedule/counter as
     * the auto-resume engine schedules/fires/cancels a timer, and clearing
     * the row (`value: null`) once the pause chain ends. Doesn't check
     * whether the task exists first — an `UPDATE ... WHERE id = ?` against a
     * missing id simply matches zero rows, same as every other targeted
     * UPDATE in this file.
     */
    setFxRecovery(taskId: string, value: TaskFxRecovery | null): void {
      conn.run(
        `UPDATE tasks SET fx_recovery = ? WHERE id = ?`,
        [value ? JSON.stringify(value) : null, taskId],
      );
    },
    /**
     * Write (or clear) a task's harness-stack failover state in one targeted
     * UPDATE. Server-managed exactly like `setFxRecovery`: no `updated_at`
     * bump, and the generic `update` SET clause skips `harness_state`, so this
     * is the only writer. A missing task id matches zero rows.
     */
    setHarnessState(taskId: string, value: TaskHarnessState | null): Task | null {
      conn.run(
        `UPDATE tasks SET harness_state = ? WHERE id = ?`,
        [value ? JSON.stringify(value) : null, taskId],
      );
      return this.get(taskId);
    },
    /**
     * Write (or clear) a task's imported-Claude provenance in one targeted
     * UPDATE. No `updated_at` bump — same pattern as `setFxRecovery`. The
     * generic `update` SET clause skips this column, so this is the only
     * writer. A missing task id matches zero rows.
     *
     * Binding a `sessionId` that another task already holds throws
     * {@link ImportedClaudeSessionTaken}. The unique index on
     * `imported_claude_session_id` (migration 069) makes that write the atomic
     * claim: two commits cannot both succeed. The column is a copy of
     * `value.sessionId`, written in this same UPDATE — `tasks.insert` and
     * `tasks.update` leave it alone. Rewriting the same task's own session id
     * (backfill offset, status) does not conflict.
     *
     * `opts.claim === false` writes the JSON only and leaves
     * `imported_claude_session_id` untouched. A duplicate that lost the claim
     * can be marked failed without taking the session id.
     */
    setImportedClaude(
      taskId: string,
      value: ImportedClaudeSession | null,
      opts?: { claim?: boolean },
    ): Task | null {
      const claim = opts?.claim !== false;
      try {
        if (value && !claim) {
          conn.run(
            `UPDATE tasks SET imported_claude = ? WHERE id = ?`,
            [JSON.stringify(value), taskId],
          );
        } else {
          conn.run(
            `UPDATE tasks SET imported_claude = ?, imported_claude_session_id = ? WHERE id = ?`,
            [value ? JSON.stringify(value) : null, value ? value.sessionId : null, taskId],
          );
        }
      } catch (err) {
        if (value && claim && isUniqueConstraintError(err)) throw new ImportedClaudeSessionTaken(value.sessionId);
        throw err;
      }
      return this.get(taskId);
    },
    /** The task whose imported-Claude claim holds `sessionId`, if any.
     *  Served by `tasks_imported_claude_session_uidx`. A session that is owned
     *  only as a normal run (no provenance yet) is not returned — callers that
     *  mean "any run" also check `runs.hasClaudeSessionId`. */
    findByImportedSessionId(sessionId: string): Task | null {
      if (!sessionId) return null;
      const row = conn.query<{ id: string }, [string]>(
        `SELECT id FROM tasks WHERE imported_claude_session_id = ? LIMIT 1`,
      ).get(sessionId);
      return row ? this.get(row.id) : null;
    },
    /** True when `sessionId` is claimed by a task other than `taskId`.
     *  Callers that resume an imported session (Send, Retry) must refuse:
     *  the losing row of a duplicate still carries the session id inside
     *  `imported_claude` after migration 070 left its claim column NULL. */
    importedSessionHeldElsewhere(taskId: string, sessionId: string): boolean {
      if (!sessionId) return false;
      const holder = this.findByImportedSessionId(sessionId);
      return holder != null && holder.id !== taskId;
    },
    /** Every non-null `tasks.imported_claude_session_id`. Served by
     *  `tasks_imported_claude_session_uidx`. The claim is written before the
     *  seed run, so a crash between those writes still owns the session id.
     *  Pair with `runs.claudeSessionIds` via {@link hiddenClaudeSessionIds}. */
    importedClaudeSessionIds(): Set<string> {
      const rows = conn.query<{ imported_claude_session_id: string }, []>(
        `SELECT imported_claude_session_id FROM tasks WHERE imported_claude_session_id IS NOT NULL`,
      ).all();
      return new Set(rows.map((r) => r.imported_claude_session_id));
    },
    /**
     * Write (or clear) a task's imported-OpenCode provenance in one targeted
     * UPDATE — the OpenCode counterpart of {@link setImportedClaude}, same
     * contract: no `updated_at` bump, the only writer of `imported_opencode`
     * and `imported_opencode_session_id` (migration 079), a missing task id
     * matches zero rows.
     *
     * Binding a `sessionId` another task already holds throws
     * {@link ImportedOpencodeSessionTaken} — the unique index
     * `tasks_imported_opencode_session_uidx` makes the write the atomic claim.
     * `opts.claim === false` writes the JSON only and leaves the claim column
     * untouched, so a duplicate that lost the claim can be marked failed.
     */
    setImportedOpencode(
      taskId: string,
      value: ImportedOpencodeSession | null,
      opts?: { claim?: boolean },
    ): Task | null {
      const claim = opts?.claim !== false;
      try {
        if (value && !claim) {
          conn.run(
            `UPDATE tasks SET imported_opencode = ? WHERE id = ?`,
            [JSON.stringify(value), taskId],
          );
        } else {
          conn.run(
            `UPDATE tasks SET imported_opencode = ?, imported_opencode_session_id = ? WHERE id = ?`,
            [value ? JSON.stringify(value) : null, value ? value.sessionId : null, taskId],
          );
        }
      } catch (err) {
        if (value && claim && isUniqueConstraintError(err)) throw new ImportedOpencodeSessionTaken(value.sessionId);
        throw err;
      }
      return this.get(taskId);
    },
    /** The task whose imported-OpenCode claim holds `sessionId`, if any.
     *  Served by `tasks_imported_opencode_session_uidx`. A session owned only
     *  as a normal run is not returned — see `runs.hasOpencodeSessionId`. */
    findTaskByImportedOpencodeSession(sessionId: string): Task | null {
      if (!sessionId) return null;
      const row = conn.query<{ id: string }, [string]>(
        `SELECT id FROM tasks WHERE imported_opencode_session_id = ? LIMIT 1`,
      ).get(sessionId);
      return row ? this.get(row.id) : null;
    },
    /** True when `sessionId` is claimed by a task other than `taskId`. Send
     *  and Retry on an imported OpenCode session must refuse in that case. */
    importedOpencodeSessionHeldElsewhere(taskId: string, sessionId: string): boolean {
      if (!sessionId) return false;
      const holder = this.findTaskByImportedOpencodeSession(sessionId);
      return holder != null && holder.id !== taskId;
    },
    /** Every non-null `tasks.imported_opencode_session_id`. Served by
     *  `tasks_imported_opencode_session_uidx`. Pair with
     *  `runs.opencodeSessionIdsOwned` via {@link hiddenOpencodeSessionIds}. */
    importedOpencodeSessionIds(): Set<string> {
      const rows = conn.query<{ imported_opencode_session_id: string }, []>(
        `SELECT imported_opencode_session_id FROM tasks WHERE imported_opencode_session_id IS NOT NULL`,
      ).all();
      return new Set(rows.map((r) => r.imported_opencode_session_id));
    },
    /**
     * Record the branch agetor last observed checked out in a task's worktree
     * (`checkout_branch`, migration 063; `null` = detached HEAD / unknown) in
     * one targeted `UPDATE` — same pattern as `setFxRecovery` above: no
     * `updated_at` bump and it bypasses the generic `update`'s SET clause so a
     * concurrent unrelated PATCH can't race it. Compare-then-write
     * (`checkout_branch IS NOT ?`): an unchanged value matches zero rows, so a
     * repeated observation doesn't churn the row the webview's
     * `reconcileById` identity preservation depends on. A pipeline STEP row
     * (non-null `pipeline_parent_id`) also writes its parent in the same
     * transaction — step tasks share the parent's worktree and run through the
     * ordinary orchestrator start/settle paths, so mirroring here keeps the
     * parent card current with no runner change. Silently no-ops on an unknown
     * task id (zero rows match, same as every other targeted UPDATE here).
     */
    setCheckoutBranch(taskId: string, value: string | null): void {
      conn.transaction(() => {
        conn.run(
          `UPDATE tasks SET checkout_branch = ? WHERE id = ? AND checkout_branch IS NOT ?`,
          [value, taskId, value],
        );
        const row = conn
          .query<{ pipeline_parent_id: string | null }, [string]>(
            `SELECT pipeline_parent_id FROM tasks WHERE id = ?`,
          )
          .get(taskId);
        if (row?.pipeline_parent_id) {
          conn.run(
            `UPDATE tasks SET checkout_branch = ? WHERE id = ? AND checkout_branch IS NOT ?`,
            [value, row.pipeline_parent_id, value],
          );
        }
      }).immediate();
    },
    /**
     * Replace a task's pinned repository set (migration 087, issue #291) in one
     * targeted `UPDATE` — same pattern as `setCheckoutBranch` above: no
     * `updated_at` bump (the set is server-managed state) and it bypasses the
     * generic `update`'s SET clause entirely. Used at create time and after
     * worktree preparation to persist the materialized paths/branches. On a
     * single-repository row (nothing stored) a set of one entry stores `'[]'` on
     * purpose, so the row keeps deriving its entry from the scalar columns
     * (which the caller updates separately). A multi-repository row (something
     * stored) is never demoted, and never regrows: only incoming entries whose
     * workspace name the row still stores are kept (names are fixed at creation
     * and the only later change is `removeTaskRepository`, so a stale snapshot
     * a prepare took before a removal can't resurrect the removed entry), any
     * non-empty result is stored, one entry included, and an empty one leaves
     * the row untouched. An unknown id matches zero rows.
     *
     * The caller's array is a *snapshot* taken before one or more awaits
     * (`prepareTaskWorkdir` can take seconds), so it must not clobber fields
     * another writer stamped meanwhile. `prs` (append-only, stamped by
     * `appendRepositoryPr`), `baseBranch` (written at creation) and
     * `checkoutBranch` (last-seen drift, written by the dedicated
     * `setRepositoryCheckout` compare-then-write at every refresh point) are
     * therefore merged from the CURRENT row: a stored value wins, and the
     * incoming value is only used when nothing is stored yet (first
     * materialization). Callers that genuinely observed a new checkout record it
     * through `setRepositoryCheckout` after this call.
     */
    setRepositories(taskId: string, repos: TaskRepository[]): Task | null {
      const cur = this.get(taskId);
      const byName = new Map((cur?.repositories ?? []).map((r) => [r.name, r]));
      let stored: TaskRepository[];
      if (cur?.multiRepo) {
        stored = repos.filter((r) => byName.has(r.name));
        if (stored.length === 0) return cur;
      } else {
        stored = repos.length > 1 ? repos : [];
      }
      const merged = stored.map((r) => {
        const prev = byName.get(r.name);
        if (!prev) return r;
        const prs = prev.prs && prev.prs.length > 0 ? prev.prs : (r.prs ?? []);
        return {
          ...r,
          prs,
          prUrl: firstPrUrl(prs),
          baseBranch: prev.baseBranch ?? r.baseBranch ?? null,
          checkoutBranch: prev.checkoutBranch ?? r.checkoutBranch,
        };
      });
      conn.run(`UPDATE tasks SET repositories = ? WHERE id = ?`, [serializeRepositories(merged), taskId]);
      return this.get(taskId);
    },
    /**
     * Append one pull request to a single-repository task's `prs`, deduped by URL
     * (a repeated stamp is a no-op). No-op (returns the current row) for a
     * multi-repository task, whose PRs live on `repositories[].prs`
     * (`appendRepositoryPr`). The read-modify-write has no await between the get
     * and the UPDATE, so two concurrent stamps serialize on the JS turn. Never
     * bumps `updated_at`: server-managed (docs/architecture/persistence.md).
     */
    appendPr(taskId: string, entry: TaskPr): Task | null {
      const cur = this.get(taskId);
      if (!cur) return null;
      if (cur.multiRepo) return cur;
      const prs = appendTaskPr(cur.prs ?? [], entry);
      if (prs.length === (cur.prs ?? []).length) return cur;
      conn.run(`UPDATE tasks SET prs = ? WHERE id = ?`, [JSON.stringify(prs), taskId]);
      return this.get(taskId) ?? cur;
    },
    /**
     * Append one pull request to a multi-repository task's entry, deduped by URL.
     * `selector` matches by workspace name, selected path or worktree path.
     * No-op (returns the current row) for a single-repository task or an unknown
     * selector. Never bumps `updated_at`.
     */
    appendRepositoryPr(taskId: string, selector: string, entry: TaskPr): Task | null {
      const cur = this.get(taskId);
      if (!cur) return null;
      if (!cur.multiRepo) return cur;
      let changed = false;
      const next = (cur.repositories ?? []).map((r) => {
        const matches = r.name === selector || r.path === selector || r.worktreePath === selector;
        if (!matches) return r;
        const prs = appendTaskPr(r.prs ?? [], entry);
        if (prs.length === (r.prs ?? []).length) return r;
        changed = true;
        return { ...r, prs, prUrl: firstPrUrl(prs) };
      });
      if (changed) conn.run(`UPDATE tasks SET repositories = ? WHERE id = ?`, [serializeRepositories(next), taskId]);
      return this.get(taskId) ?? cur;
    },
    /**
     * Clear `issue_repo_path` when it still names `repoPath` — the repository
     * just removed from the task (`removeTaskRepository`), so no remaining
     * repository's PR claims `Closes #N` for an issue whose repository is gone.
     * Compare-then-write, targeted, never bumps `updated_at` (server-managed,
     * docs/architecture/persistence.md).
     */
    clearIssueRepoPath(taskId: string, repoPath: string): void {
      conn.run(`UPDATE tasks SET issue_repo_path = NULL WHERE id = ? AND issue_repo_path = ?`, [taskId, repoPath]);
    },
    /**
     * Record the branch last observed checked out in one multi-repository
     * worktree (`tasks.repositories[].checkoutBranch`), by workspace name.
     * Same targeted-UPDATE, no-`updated_at` contract as `setCheckoutBranch`;
     * compare-then-write so an unchanged observation never churns the row.
     *
     * Like `setCheckoutBranch`, a write on a pipeline step row is mirrored to
     * its parent in the same transaction: the steps share the parent's
     * worktrees, and the parent row is the pipeline's last-seen checkout (D14)
     * that the next step launch re-attaches to, so a drift a step observed must
     * not stay on the step alone. The parent's entry is matched by the same
     * workspace name; a parent without that entry (or without a multi set) is
     * left untouched.
     */
    setRepositoryCheckout(taskId: string, repoName: string, value: string | null): Task | null {
      let found = false;
      conn.transaction(() => {
        const row = conn
          .query<{ repositories: string | null; pipeline_parent_id: string | null }, [string]>(
            `SELECT repositories, pipeline_parent_id FROM tasks WHERE id = ?`,
          )
          .get(taskId);
        if (!row) return;
        found = true;
        writeRepositoryCheckout(taskId, row.repositories, repoName, value);
        if (row.pipeline_parent_id) {
          const parent = conn
            .query<{ repositories: string | null }, [string]>(`SELECT repositories FROM tasks WHERE id = ?`)
            .get(row.pipeline_parent_id);
          if (parent) writeRepositoryCheckout(row.pipeline_parent_id, parent.repositories, repoName, value);
        }
      }).immediate();
      return found ? this.get(taskId) : null;
    },
    /**
     * Bind (or detach, when both arguments are `null`) a task's agent profile
     * in one targeted `UPDATE` — same pattern as `setFxRecovery` above: no
     * `updated_at` bump (server-managed state, not a task mutation) and it
     * bypasses the generic `update`'s SET clause entirely so a concurrent
     * unrelated PATCH can't race it. Callers: `createTask` (initial bind),
     * `startTask` (freshening the snapshot from the live profile right before
     * a task's first run — see `docs/plans/agent-profiles.md` D2), and the
     * detach route (`profileId`/`snapshot` both `null`). Doesn't check whether
     * the task exists first — an `UPDATE ... WHERE id = ?` against a missing
     * id simply matches zero rows, same as every other targeted UPDATE here.
     */
    setAgentProfile(taskId: string, profileId: string | null, snapshot: AgentProfileSnapshot | null): Task | null {
      conn.run(
        `UPDATE tasks SET agent_profile_id = ?, agent_profile = ? WHERE id = ?`,
        [profileId, snapshot ? JSON.stringify(snapshot) : null, taskId],
      );
      return this.get(taskId);
    },
    /**
     * Only what `branchesPinnedByOtherTasks` reads, for every task that pins a
     * branch: `{id, branch, workdir, repositories: [{path, branch}]}`. Replaces
     * a full `list()` (every Task row, with its prompt, plans and harness state,
     * structured-cloned off the worker) on each start. A single-repository row's
     * `repositories` is the one entry derived from its own `workdir`/`branch`,
     * which the caller already pins from those fields, so only a stored
     * (multi-repository) set is returned. `tasks` is small and has no index on
     * `branch`; the scan is the whole table's two narrow columns, not its rows.
     */
    pinnedBranches(): { id: string; branch: string | null; workdir: string; repositories: { path: string; branch: string | null }[] }[] {
      const rows = conn.query<{ id: string; branch: string | null; workdir: string; repositories: string | null }, []>(
        `SELECT id, branch, workdir, repositories FROM tasks
          WHERE branch IS NOT NULL OR (repositories IS NOT NULL AND repositories != '[]' AND repositories != '')`,
      ).all();
      return rows.map((r) => ({
        id: r.id,
        branch: r.branch,
        workdir: r.workdir,
        repositories: parseTaskRepositories(r.repositories).map((repo) => ({ path: repo.path, branch: repo.branch })),
      }));
    },
    /**
     * Overwrite a pipeline PARENT task's `pipeline_run` state (`PipelineRunState`
     * JSON, migration 058) in one targeted `UPDATE` — same pattern as
     * `setAgentProfile`/`setFxRecovery` above: no `updated_at` bump (this is
     * server-managed run progress, not a task mutation — the runner calls this
     * on every state transition, and bumping `updated_at` on each one would
     * re-render every task on every 2s poll) and it bypasses the generic
     * `update`'s SET clause entirely so a concurrent unrelated PATCH can't
     * race a live run. `value: null` is the pre-first-run idle state written
     * once more explicitly by `tasks.insert`; this method's own callers
     * (`src/bun/pipeline-runner.ts`) never pass `null` in practice once a run
     * has started. Doesn't check whether the task exists first — an
     * `UPDATE ... WHERE id = ?` against a missing id simply matches zero rows,
     * same as every other targeted UPDATE in this file.
     */
    setPipelineRun(taskId: string, run: PipelineRunState | null): Task | null {
      conn.run(
        `UPDATE tasks SET pipeline_run = ? WHERE id = ?`,
        [run ? JSON.stringify(run) : null, taskId],
      );
      return this.get(taskId);
    },
    /**
     * Every non-archived task currently carrying a persisted fx pause whose
     * `autoResume` schedule is non-null — the boot-time re-arm input
     * (`rearmFxAutoResumes` in the orchestrator re-schedules a timer for each
     * one, since in-memory timers don't survive a process restart). A paused
     * task with `autoResume: null` (auto-resume off, exhausted, or cancelled)
     * is deliberately excluded — there is nothing to re-arm for it. Archived
     * tasks are excluded too: archiving cancels any pending auto-resume (see
     * the orchestrator's archive path), so a lingering row there would be
     * stale by construction.
     */
    listFxAutoResumePending(): Array<{ id: string; fxRecovery: TaskFxRecovery }> {
      return this.listFxRecovery().filter((row) => row.fxRecovery.autoResume);
    },
    /**
     * Every non-archived task carrying a persisted fx pause, with or without a
     * pending `autoResume` — the boot sweep's input (`rearmFxAutoResumes`
     * clears every row once the installed fx can no longer resume a pause).
     */
    listFxRecovery(): Array<{ id: string; fxRecovery: TaskFxRecovery }> {
      const rows = conn.query<{ id: string; fx_recovery: string | null }, []>(
        `SELECT id, fx_recovery FROM tasks WHERE fx_recovery IS NOT NULL AND archived_at IS NULL`,
      ).all();
      const out: Array<{ id: string; fxRecovery: TaskFxRecovery }> = [];
      for (const row of rows) {
        const fxRecovery = parseTaskFxRecovery(row.fx_recovery);
        if (fxRecovery) out.push({ id: row.id, fxRecovery });
      }
      return out;
    },
    /**
     * Tasks archived at or before `cutoffMs` (ms epoch, the unit of
     * `archived_at`), oldest archive first — the archived-history retention
     * pass's candidate list (docs/plans/non-blocking-session-restore.md, T8).
     * Un-archived tasks (`archived_at IS NULL`) never match. Ids and archive
     * times only: the pass walks each task's runs itself and must not
     * materialize full `Task` rows (with their JSON columns) for a table that
     * can hold thousands of archived tasks.
     */
    archivedBefore(cutoffMs: number): Array<{ id: string; archivedAt: number }> {
      return conn.query<{ id: string; archived_at: number }, [number]>(
        `SELECT id, archived_at FROM tasks
       WHERE archived_at IS NOT NULL AND archived_at <= ?
       ORDER BY archived_at ASC`,
      ).all(cutoffMs).map((r) => ({ id: r.id, archivedAt: r.archived_at }));
    },
  };
  return tasks;
}

export type Tasks = ReturnType<typeof makeTasks>;

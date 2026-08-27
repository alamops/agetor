import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import type { AgentKind, BacklogMessage, BranchNamingConfig, Harness, HarnessQuota, HarnessUsage, Project, SavedPrompt, Task, TaskDraft, TaskPlan, TaskReference, TaskType, Run, RunEventStream, Subagent, SubagentStatus } from "../shared/types.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { coreCredsPath } from "./core-creds.ts";
// Interactions live in-memory in `interactions.ts`. The import creates a
// cycle: db.ts → interactions.ts → db.ts (for `tasks`). It is safe ONLY
// because both modules access each other's exports exclusively from
// function bodies that run after module init — never at top level. Do
// NOT add a top-level call site in either direction (e.g. a `const x =
// tasks.get(...)` at module scope in interactions.ts) — under ESM live
// bindings the unresolved cycle becomes an undefined-binding crash at
// import time. Keep both sides lazy.
import { countPendingForTask, pendingCountsByTask } from "./interactions.ts";
// Same lazy-cycle contract as interactions.ts above: terminals.ts imports
// `tasks` from this module, and we call `countTerminals` only inside `toTask`
// (a function body), never at top level. Do not hoist this call site.
import { countTerminals, terminalCountsByTask } from "./terminals.ts";

// Hard guard against test fixtures silently leaking into the user's real
// SQLite db. `bun test` runs every *.test.ts file in one process, so the
// first import of db.ts wins — any test file that sets AGETOR_DATA_DIR in
// `beforeAll` (instead of at top level) loses the race and writes to
// ~/.agetor/agetor.sqlite. We discovered this the painful way: 10 fixture
// tasks + dozens of phantom projects polluted the production kanban.
// Under NODE_ENV=test, if no AGETOR_DATA_DIR was set we auto-allocate a
// throwaway dir — guarantees we never touch ~/.agetor under tests even if
// some test file forgot the top-level setup. Logged so the gap is visible
// in CI output.
if (process.env.NODE_ENV === "test" && !process.env.AGETOR_DATA_DIR) {
  process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-test-auto-"));
  console.warn(
    `[agetor:db] NODE_ENV=test with no AGETOR_DATA_DIR — auto-allocated `
    + `${process.env.AGETOR_DATA_DIR}. Set it at the TOP of the test file `
    + `(not in beforeAll) to silence this warning.`,
  );
}
const DATA_DIR = process.env.AGETOR_DATA_DIR
  ?? path.join(homedir(), ".agetor");
mkdirSync(DATA_DIR, { recursive: true });

export const dataDir = DATA_DIR;

/** Pidfile path. Written at boot by `index.ts`, read by `wipe-dev.ts` for
 *  liveness checks. Single source of truth so a future rename doesn't
 *  leave silent stragglers. */
export const pidFilePath = path.join(DATA_DIR, "agetor.pid");

/** Core credentials file (port + per-launch API token + owner pid/kind),
 *  written after the API server binds and read by the CLI/daemon to discover
 *  and authenticate to the running core. See `core-creds.ts`. */
export const credsFilePath = coreCredsPath(DATA_DIR);

export const db = new Database(path.join(DATA_DIR, "agetor.sqlite"));
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

const applied = migrate(db, migrations);
if (applied.length) console.log(`[agetor] applied migrations: ${applied.join(", ")}`);

type TaskRow = {
  id: string; title: string; prompt: string; column: string; agent: string;
  workdir: string; isolation: string;
  task_type: string;
  branch: string | null; worktree_path: string | null; base_ref: string | null;
  branch_source: string;
  pr_url: string | null;
  mode: string | null; model: string | null; effort: string | null;
  fast: number;
  max_mode: number;
  refs: string;
  backlog: string;
  draft: string | null;
  plans: string;
  todo_progress: string | null;
  // Unread-indicator watermark pair (migration 045). Not spread into `Task`
  // directly — only the derived `unread` boolean is (see `toTask`). Written
  // exclusively by `tasks.noteAssistantEvent` / `tasks.markSeen`, never by
  // the generic `insert`/`update` paths (see those methods for why).
  last_assistant_event_id: number | null;
  last_seen_event_id: number | null;
  run_id: string | null; created_at: number; updated_at: number;
  archived_at: number | null;
  /** SQLite EXISTS returns 0/1; we map to boolean in toTask. Computed via
   *  a correlated subquery in `list` / `get` — see those for the full SQL. */
  has_openable_run?: number;
};

/** Statuses that mean "this task has produced something worth re-opening
 *  the panel for". Failed / cancelled are explicit restart cases and
 *  don't qualify — the user almost always wants to re-Run those.
 *  Literals are inlined into the SQL (rather than `?`-bound) so the
 *  parameter tuple stays empty and bun:sqlite's parameter-typing stays
 *  simple. */
const OPENABLE_STATUSES_SQL = `('succeeded', 'running', 'orphaned')`;

const parseRefs = (raw: string): TaskReference[] => {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((r): TaskReference[] => {
      if (!r || typeof r !== "object") return [];
      const path = (r as { path?: unknown }).path;
      if (typeof path !== "string" || !path) return [];
      const isDirectory = Boolean((r as { isDirectory?: unknown }).isDirectory);
      return [{ path, isDirectory }];
    });
  } catch { return []; }
};

/** Coerce the raw refs value (already a TaskReference[]-ish) through the same
 *  sanitizer `parseRefs` applies to on-disk JSON, so a backlog item's refs are
 *  validated identically whether they come from the DB column or a fresh
 *  client payload. */
const sanitizeRefs = (value: unknown): TaskReference[] =>
  Array.isArray(value) ? parseRefs(JSON.stringify(value)) : [];

const parseBacklog = (raw: string): BacklogMessage[] => {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((m): BacklogMessage[] => {
      if (!m || typeof m !== "object") return [];
      const id = (m as { id?: unknown }).id;
      if (typeof id !== "string" || !id) return [];
      const text = (m as { text?: unknown }).text;
      const createdAt = (m as { createdAt?: unknown }).createdAt;
      return [{
        id,
        text: typeof text === "string" ? text : "",
        references: sanitizeRefs((m as { references?: unknown }).references),
        createdAt: typeof createdAt === "number" ? createdAt : 0,
      }];
    });
  } catch { return []; }
};

/** Every status a {@link TaskPlan} may carry. A row with an unrecognized
 *  status (future/foreign build, hand-edited DB) coerces to a NON-actionable
 *  state — "approved" when approvedAt proves an approval happened, else
 *  "superseded" — never "pending": approve is non-idempotent (writes a file,
 *  messages a live agent), so corruption must not resurrect an approve button.
 *  Losing the record entirely would still be worse, so it is kept. `rejected`
 *  (claude-code `ExitPlanMode` plans only — a resolved-but-not-approved
 *  outcome) is a real, non-corrupt terminal status, not a fallback target. */
const PLAN_STATUSES = new Set<string>(["pending", "approved", "superseded", "rejected"]);

const parsePlans = (raw: string): TaskPlan[] => {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((p): TaskPlan[] => {
      if (!p || typeof p !== "object") return [];
      const id = (p as { id?: unknown }).id;
      const toolCallId = (p as { toolCallId?: unknown }).toolCallId;
      const runId = (p as { runId?: unknown }).runId;
      const content = (p as { content?: unknown }).content;
      if (typeof id !== "string" || !id) return [];
      if (typeof toolCallId !== "string" || !toolCallId) return [];
      if (typeof runId !== "string" || !runId) return [];
      if (typeof content !== "string") return [];
      const name = (p as { name?: unknown }).name;
      const editedContent = (p as { editedContent?: unknown }).editedContent;
      const status = (p as { status?: unknown }).status;
      const createdAt = (p as { createdAt?: unknown }).createdAt;
      const approvedAt = (p as { approvedAt?: unknown }).approvedAt;
      const approvedEdited = (p as { approvedEdited?: unknown }).approvedEdited;
      const filePath = (p as { filePath?: unknown }).filePath;
      return [{
        id,
        toolCallId,
        runId,
        name: typeof name === "string" ? name : null,
        content,
        editedContent: typeof editedContent === "string" ? editedContent : null,
        // An unknown/corrupt status must never coerce to "pending" — that
        // would resurrect an already-approved (or superseded) plan as
        // actionable again, and `approvePlan`/the approve route are
        // non-idempotent (a second approval re-sends the message). Fall
        // back on whether `approvedAt` is set: a numeric timestamp means it
        // really was approved, so keep it "approved"; otherwise treat the
        // corrupt row as history that's no longer actionable.
        status: typeof status === "string" && PLAN_STATUSES.has(status)
          ? (status as TaskPlan["status"])
          : typeof approvedAt === "number"
            ? "approved"
            : "superseded",
        createdAt: typeof createdAt === "number" ? createdAt : 0,
        approvedAt: typeof approvedAt === "number" ? approvedAt : null,
        approvedEdited: approvedEdited === true,
        filePath: typeof filePath === "string" ? filePath : null,
      }];
    });
  } catch { return []; }
};

/** Parse the stored draft JSON, tolerating NULL (no draft), malformed JSON,
 *  and legacy/bad shapes — all collapse to `null` rather than throwing.
 *  References are sanitized through the same `sanitizeRefs` path as backlog
 *  items. An apparently-well-formed but effectively-empty draft (blank text,
 *  no references) also normalizes to `null` so a stray write can't leave a
 *  zombie draft that silently reappears in the composer. Non-empty text is
 *  otherwise preserved verbatim — no trimming of the stored value. */
const parseDraft = (raw: unknown): TaskDraft | null => {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const text = (parsed as { text?: unknown }).text;
    const draft: TaskDraft = {
      text: typeof text === "string" ? text : "",
      references: sanitizeRefs((parsed as { references?: unknown }).references),
    };
    if (!draft.text.trim() && draft.references.length === 0) return null;
    return draft;
  } catch { return null; }
};

/** Parse the stored `todo_progress` JSON, tolerating NULL (no todo-family
 *  tool call observed yet), malformed JSON, and unexpected shapes — all
 *  collapse to `null` rather than throwing, same treatment as `parseDraft`.
 *  Only `{ completed: number, total: number }` is accepted, and only when
 *  both are non-negative integers with `completed <= total`
 *  (`{completed:9,total:0}` or a negative count is exactly as invalid as a
 *  missing/wrong-typed field) — anything else is discarded wholesale rather
 *  than partially trusted, since a corrupt summary is worse than none. */
const parseTodoProgress = (raw: string | null): Task["todoProgress"] => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const completed = (parsed as { completed?: unknown }).completed;
    const total = (parsed as { total?: unknown }).total;
    if (
      typeof completed !== "number" || !Number.isInteger(completed) || completed < 0
      || typeof total !== "number" || !Number.isInteger(total) || total < 0
      || completed > total
    ) return null;
    return { completed, total };
  } catch { return null; }
};

/** Optional pre-computed grouped counts, threaded in by `tasks.list()` so a
 *  multi-row query does one pass over each in-memory registry instead of a
 *  per-row `countPendingForTask`/`countTerminals` scan (289 tasks × 2 linear
 *  scans on every 2s `/tasks` poll, before this). Single-task reads
 *  (`tasks.get`, `insert`, `update`) omit this and fall back to the
 *  per-task counters — called far less often than the poll. */
interface TaskCounts {
  pending?: Map<string, number>;
  terminals?: Map<string, number>;
}

const toTask = (r: TaskRow, counts?: TaskCounts): Task => ({
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
  prUrl: r.pr_url,
  mode: r.mode,
  model: r.model,
  effort: r.effort,
  fast: r.fast === 1,
  maxMode: r.max_mode === 1,
  references: parseRefs(r.refs),
  backlog: parseBacklog(r.backlog),
  draft: parseDraft(r.draft),
  plans: parsePlans(r.plans),
  runId: r.run_id,
  // `has_openable_run` comes back as SQLite's 0/1; missing means we didn't
  // join (e.g. insert/update returning the freshly-written shape, where
  // no runs exist yet → false is the right default).
  hasOpenableRun: r.has_openable_run === 1,
  pendingInteractionCount: counts?.pending ? (counts.pending.get(r.id) ?? 0) : countPendingForTask(r.id),
  openTerminalCount: counts?.terminals ? (counts.terminals.get(r.id) ?? 0) : countTerminals(r.id),
  todoProgress: parseTodoProgress(r.todo_progress),
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
});

// LEFT JOIN + aggregation, so the runs scan happens once instead of once
// per task row. `MAX(...)` over a boolean gives us 1 if any matching run
// exists for the task, 0 otherwise (NULL coalesces to 0 via COALESCE).
const TASKS_SELECT = `
  SELECT tasks.*,
         COALESCE(MAX(runs.status IN ${OPENABLE_STATUSES_SQL}), 0) AS has_openable_run
    FROM tasks
    LEFT JOIN runs ON runs.task_id = tasks.id
`;

export const tasks = {
  // Computes the pending-interaction and open-terminal grouped counts ONCE
  // for the whole result set (two single-pass scans over their respective
  // in-memory maps) instead of once per row via `toTask`'s per-task fallback
  // — this is the hot path hit by the 2s `/tasks` poll.
  list(): Task[] {
    const rows = db.query<TaskRow, []>(
      `${TASKS_SELECT}
         GROUP BY tasks.id
         ORDER BY tasks.created_at DESC`,
    ).all();
    const counts: TaskCounts = { pending: pendingCountsByTask(), terminals: terminalCountsByTask() };
    return rows.map((r) => toTask(r, counts));
  },
  get(id: string): Task | null {
    const row = db.query<TaskRow, [string]>(
      `${TASKS_SELECT}
         WHERE tasks.id = ?
         GROUP BY tasks.id`,
    ).get(id);
    return row ? toTask(row) : null;
  },
  insert(t: Task): Task {
    db.run(
      `INSERT INTO tasks
         (id, title, prompt, "column", agent, workdir, isolation, task_type,
          branch, branch_source, worktree_path, base_ref, pr_url, mode, model, effort, fast, max_mode, refs, backlog, draft, plans, todo_progress,
          last_assistant_event_id, last_seen_event_id,
          run_id, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t.id, t.title, t.prompt, t.column, t.agent, t.workdir, t.isolation,
        t.taskType,
        t.branch, t.branchSource, t.worktreePath, t.baseRef, t.prUrl ?? null, t.mode, t.model, t.effort, t.fast ? 1 : 0, t.maxMode ? 1 : 0,
        JSON.stringify(t.references ?? []),
        JSON.stringify(t.backlog ?? []),
        t.draft ? JSON.stringify(t.draft) : null,
        JSON.stringify(t.plans ?? []),
        t.todoProgress ? JSON.stringify(t.todoProgress) : null,
        // A brand-new task has never had an assistant event or a mark-seen
        // — both start NULL, which `toTask` reads as `unread: false`.
        null, null,
        t.runId, t.createdAt, t.updatedAt, t.archivedAt ?? null,
      ],
    );
    // Round-trip via `get` so the returned shape carries the computed
    // hasOpenableRun field (false for a brand-new task — but callers
    // that mutate t shouldn't accidentally get a stale shape).
    return this.get(t.id) ?? { ...t, hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0, todoProgress: t.todoProgress ?? null, unread: false, hasAssistantMessages: false, archivedAt: null };
  },
  update(id: string, patch: Partial<Task>): Task | null {
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
    db.run(
      `UPDATE tasks SET
         title=?, prompt=?, "column"=?, agent=?, workdir=?, isolation=?, task_type=?,
         branch=?, branch_source=?, worktree_path=?, base_ref=?, pr_url=?, mode=?, model=?, effort=?, fast=?, max_mode=?, refs=?, backlog=?, draft=?, plans=?, todo_progress=?,
         run_id=?, updated_at=?, archived_at=?
       WHERE id=?`,
      [
        next.title, next.prompt, next.column, next.agent, next.workdir, next.isolation,
        next.taskType,
        next.branch, next.branchSource, next.worktreePath, next.baseRef, next.prUrl ?? null, next.mode, next.model, next.effort, next.fast ? 1 : 0, next.maxMode ? 1 : 0,
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
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
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
    db.run(
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
    db.run(
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
    db.run(
      `UPDATE tasks SET
         last_assistant_event_id = ?
       WHERE id = ? AND (last_assistant_event_id IS NULL OR last_assistant_event_id < ?)`,
      [eventId, taskId, eventId],
    );
  },
};

/**
 * Per-task backlog of saved, not-yet-sent draft messages. Every op is a
 * read-modify-write on the task's `backlog` JSON column (via `tasks.update`)
 * and returns the freshly-updated Task, or null when the task is gone. Item
 * ids are minted here so clients never supply their own. Array order is the
 * display order the UI renders and the user reorders. All ops are pure list
 * transforms — there is no process side effect, so the server can call them
 * directly without going through the orchestrator.
 */
export const backlog = {
  add(taskId: string, input: { text: string; references?: TaskReference[] }): Task | null {
    const task = tasks.get(taskId);
    if (!task) return null;
    const item: BacklogMessage = {
      id: randomUUID(),
      text: input.text,
      references: sanitizeRefs(input.references),
      createdAt: Date.now(),
    };
    // Newest draft on top: the thing you just jotted is the one most likely
    // to be sent or edited next.
    return tasks.update(taskId, { backlog: [item, ...task.backlog] });
  },
  updateItem(
    taskId: string,
    itemId: string,
    patch: { text?: string; references?: TaskReference[] },
  ): Task | null {
    const task = tasks.get(taskId);
    if (!task) return null;
    // Unknown id → return the task unchanged rather than writing a no-op row.
    if (!task.backlog.some((m) => m.id === itemId)) return task;
    const next = task.backlog.map((m) =>
      m.id === itemId
        ? {
            ...m,
            text: patch.text !== undefined ? patch.text : m.text,
            references:
              patch.references !== undefined ? sanitizeRefs(patch.references) : m.references,
          }
        : m,
    );
    return tasks.update(taskId, { backlog: next });
  },
  remove(taskId: string, itemId: string): Task | null {
    const task = tasks.get(taskId);
    if (!task) return null;
    return tasks.update(taskId, {
      backlog: task.backlog.filter((m) => m.id !== itemId),
    });
  },
  /** Reorder the backlog to match `order` (item ids in the desired sequence).
   *  Ids not in the current backlog are ignored; items absent from `order` are
   *  appended in their existing relative order — so a stale or partial `order`
   *  can never silently drop a saved draft. */
  reorder(taskId: string, order: string[]): Task | null {
    const task = tasks.get(taskId);
    if (!task) return null;
    const byId = new Map(task.backlog.map((m) => [m.id, m]));
    const seen = new Set<string>();
    const next: BacklogMessage[] = [];
    for (const id of order) {
      const m = byId.get(id);
      if (m && !seen.has(id)) {
        next.push(m);
        seen.add(id);
      }
    }
    for (const m of task.backlog) if (!seen.has(m.id)) next.push(m);
    return tasks.update(taskId, { backlog: next });
  },
};

/**
 * The task's single composer draft — a pure wrapper over `tasks.update`, no
 * process side effect. `null` clears it (stored as SQL NULL by `update`).
 * References run through the same `sanitizeRefs` the read path (`parseDraft`)
 * applies, and an effectively-empty draft (blank text, no sanitized refs)
 * normalizes to `null` here too — otherwise a caller with junk refs could
 * write a non-null row that reads back as `null`, a zombie draft that never
 * shows up but never gets treated as absent either.
 */
export const drafts = {
  set(taskId: string, draft: TaskDraft | null): Task | null {
    if (draft) {
      const references = sanitizeRefs(draft.references);
      draft = draft.text.trim() || references.length > 0 ? { text: draft.text, references } : null;
    }
    return tasks.update(taskId, { draft });
  },
};

type ProjectRow = { path: string; name: string; added_at: number; branch_config: string | null };

/** Parse the stored branch-config JSON, tolerating legacy NULLs and bad data. */
function parseBranchConfig(raw: string | null): BranchNamingConfig | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && "rules" in v) return v as BranchNamingConfig;
  } catch {
    /* corrupt row — treat as "no custom config" so consumers use defaults */
  }
  return null;
}

const toProject = (r: ProjectRow): Project => ({
  path: r.path,
  name: r.name,
  addedAt: r.added_at,
  branchConfig: parseBranchConfig(r.branch_config),
});

export const projects = {
  list(): Project[] {
    return db.query<ProjectRow, []>(
      `SELECT * FROM projects ORDER BY added_at DESC`,
    ).all().map(toProject);
  },
  get(path: string): Project | null {
    const row = db.query<ProjectRow, [string]>(
      `SELECT * FROM projects WHERE path = ?`,
    ).get(path);
    return row ? toProject(row) : null;
  },
  /**
   * Insert if new, refresh `added_at` if already present. The refresh lets the
   * picker surface "recently used" paths at the top — every task creation
   * bumps its project to the front. `branch_config` is left untouched on
   * conflict so re-picking a project doesn't wipe its nomenclature.
   */
  upsert(path: string, name: string): Project {
    const now = Date.now();
    db.run(
      `INSERT INTO projects (path, name, added_at) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET added_at = excluded.added_at`,
      [path, name, now],
    );
    return this.get(path)!;
  },
  /**
   * Persist (or clear, with `null`) a project's branch nomenclature. Returns
   * the refreshed row, or null if the project isn't registered.
   */
  setBranchConfig(path: string, config: BranchNamingConfig | null): Project | null {
    db.run(
      `UPDATE projects SET branch_config = ? WHERE path = ?`,
      [config ? JSON.stringify(config) : null, path],
    );
    return this.get(path);
  },
  delete(path: string) {
    db.run(`DELETE FROM projects WHERE path = ?`, [path]);
  },
};

/**
 * Tiny key-value store for cross-session UI preferences. First customer:
 * NewTaskForm uses `lastModel:<agent>` / `lastEffort:<agent>` keys so the
 * pickers default to whatever the user last submitted, per agent. Values
 * are opaque strings; the meaning of a key lives in whichever caller
 * writes it.
 */
export const preferences = {
  get(key: string): string | null {
    const row = db.query<{ value: string }, [string]>(
      `SELECT value FROM preferences WHERE key = ?`,
    ).get(key);
    return row?.value ?? null;
  },
  list(): Record<string, string> {
    const rows = db.query<{ key: string; value: string }, []>(
      `SELECT key, value FROM preferences`,
    ).all();
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  },
  set(key: string, value: string): void {
    db.run(
      `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, Date.now()],
    );
  },
};

type HarnessRow = {
  id: string;
  kind: string;
  label: string;
  is_builtin: number;
  home: string | null;
  bin: string | null;
  env_json: string;
  enabled: number;
  created_at: number;
  updated_at: number;
};

const toHarness = (r: HarnessRow): Harness => {
  let env: Record<string, string> = {};
  try {
    const parsed = JSON.parse(r.env_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") env[k] = v;
      }
    }
  } catch { /* malformed env_json → empty */ }
  return {
    id: r.id,
    kind: r.kind as AgentKind,
    label: r.label,
    isBuiltin: r.is_builtin === 1,
    home: r.home,
    bin: r.bin,
    env,
    enabled: r.enabled === 1,
  };
};

export class HarnessInUseError extends Error {
  taskIds: string[];
  constructor(taskIds: string[]) {
    super(`harness in use by ${taskIds.length} task(s)`);
    this.taskIds = taskIds;
    this.name = "HarnessInUseError";
  }
}

export class HarnessBuiltinError extends Error {
  constructor(action: string) {
    super(`cannot ${action} a built-in harness`);
    this.name = "HarnessBuiltinError";
  }
}

const HARNESS_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

export interface HarnessInsertInput {
  id: string;
  kind: AgentKind;
  label: string;
  home?: string | null;
  bin?: string | null;
  env?: Record<string, string>;
}

export interface HarnessPatch {
  label?: string;
  home?: string | null;
  bin?: string | null;
  env?: Record<string, string>;
}

export const harnesses = {
  list(): Harness[] {
    return db
      .query<HarnessRow, []>(
        `SELECT * FROM harnesses ORDER BY is_builtin DESC, created_at ASC`,
      )
      .all()
      .map(toHarness);
  },
  get(id: string): Harness | null {
    const row = db
      .query<HarnessRow, [string]>(`SELECT * FROM harnesses WHERE id = ?`)
      .get(id);
    return row ? toHarness(row) : null;
  },
  /**
   * Resolve a harness id, falling back to a synthetic built-in when the id
   * looks like a known kind (legacy rows or freshly-deleted aliases). Used
   * at spawn time so an out-of-band missing row never silently picks the
   * wrong kind.
   */
  getByIdOrKind(id: string): Harness | null {
    const direct = this.get(id);
    if (direct) return direct;
    if (
      id === "claude-code" || id === "codex" || id === "cursor" ||
      id === "gemini" || id === "fx"
    ) {
      const label =
        id === "claude-code" ? "Claude Code"
        : id === "codex" ? "Codex"
        : id === "cursor" ? "Cursor"
        : id === "gemini" ? "Gemini CLI"
        : "fx.sh";
      return {
        id,
        kind: id,
        label,
        isBuiltin: true,
        home: null,
        bin: null,
        env: {},
        enabled: true,
      } satisfies Harness;
    }
    return null;
  },
  insert(input: HarnessInsertInput): Harness {
    if (!HARNESS_ID_RE.test(input.id)) {
      throw new Error(
        `invalid harness id "${input.id}" — must match ${HARNESS_ID_RE}`,
      );
    }
    if (
      input.kind !== "claude-code" && input.kind !== "codex" &&
      input.kind !== "cursor" && input.kind !== "gemini" &&
      input.kind !== "fx"
    ) {
      throw new Error(`unknown harness kind: ${input.kind}`);
    }
    const now = Date.now();
    const envJson = JSON.stringify(input.env ?? {});
    db.run(
      `INSERT INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.kind,
        input.label,
        input.home ?? null,
        input.bin ?? null,
        envJson,
        now,
        now,
      ],
    );
    return this.get(input.id) as Harness;
  },
  update(id: string, patch: HarnessPatch): Harness {
    const current = this.get(id);
    if (!current) throw new Error(`harness not found: ${id}`);
    if (current.isBuiltin) throw new HarnessBuiltinError("edit");
    const next = {
      label: patch.label ?? current.label,
      home: patch.home === undefined ? current.home : patch.home,
      bin: patch.bin === undefined ? current.bin : patch.bin,
      env: patch.env ?? current.env,
    };
    db.run(
      `UPDATE harnesses
         SET label = ?, home = ?, bin = ?, env_json = ?, updated_at = ?
       WHERE id = ?`,
      [
        next.label,
        next.home,
        next.bin,
        JSON.stringify(next.env),
        Date.now(),
        id,
      ],
    );
    return this.get(id) as Harness;
  },
  delete(id: string): void {
    const current = this.get(id);
    if (!current) return;
    if (current.isBuiltin) throw new HarnessBuiltinError("delete");
    const inUse = db
      .query<{ id: string }, [string]>(
        `SELECT id FROM tasks WHERE agent = ?`,
      )
      .all(id);
    if (inUse.length > 0) {
      throw new HarnessInUseError(inUse.map((r) => r.id));
    }
    db.run(`DELETE FROM harnesses WHERE id = ?`, [id]);
    // Drop any cached usage snapshot so a deleted alias doesn't leave an
    // orphaned harness_usage row (the table has no FK cascade by design).
    db.run(`DELETE FROM harness_usage WHERE harness_id = ?`, [id]);
  },
  /**
   * Soft delete / re-enable. Carve-out from `HarnessBuiltinError` — toggling
   * the enabled flag is allowed on built-ins too. Identity/config fields
   * (label, home, bin, env) remain immutable for built-ins via `update`.
   */
  setEnabled(id: string, enabled: boolean): Harness {
    const current = this.get(id);
    if (!current) throw new Error(`harness not found: ${id}`);
    db.run(
      `UPDATE harnesses SET enabled = ?, updated_at = ? WHERE id = ?`,
      [enabled ? 1 : 0, Date.now(), id],
    );
    return this.get(id) as Harness;
  },
  /**
   * Reports how many tasks reference this harness and which ones are
   * currently running. The UI uses this to warn before disabling.
   */
  usage(id: string): HarnessUsage {
    const total = db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM tasks WHERE agent = ?`,
      )
      .get(id);
    const running = db
      .query<{ id: string }, [string]>(
        `SELECT id FROM tasks WHERE agent = ? AND "column" = 'running'`,
      )
      .all(id);
    return {
      harnessId: id,
      runningTaskIds: running.map((r) => r.id),
      totalTaskCount: total?.n ?? 0,
    };
  },
};

type HarnessUsageRow = {
  harness_id: string;
  snapshot_json: string;
  updated_at: number;
};

/**
 * Latest per-harness usage/quota snapshot for the topbar usage tracker
 * (docs/plans/harness-usage-tracker.md). Standalone table, deliberately not
 * a column on `harnesses` — see migration 042's comment. `get`/`getAll`
 * parse defensively (a malformed or stale-shape snapshot is dropped rather
 * than thrown), mirroring `toHarness`'s handling of `env_json`.
 */
export const harnessUsage = {
  get(harnessId: string): HarnessQuota | null {
    const row = db
      .query<HarnessUsageRow, [string]>(
        `SELECT * FROM harness_usage WHERE harness_id = ?`,
      )
      .get(harnessId);
    if (!row) return null;
    try {
      return JSON.parse(row.snapshot_json) as HarnessQuota;
    } catch {
      return null;
    }
  },
  getAll(): HarnessQuota[] {
    const rows = db
      .query<HarnessUsageRow, []>(`SELECT * FROM harness_usage`)
      .all();
    const out: HarnessQuota[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.snapshot_json) as HarnessQuota);
      } catch {
        // malformed snapshot — skip rather than throw.
      }
    }
    return out;
  },
  upsert(quota: HarnessQuota): void {
    db.run(
      `INSERT INTO harness_usage (harness_id, snapshot_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(harness_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at`,
      [quota.harnessId, JSON.stringify(quota), Date.now()],
    );
  },
  delete(harnessId: string): void {
    db.run(`DELETE FROM harness_usage WHERE harness_id = ?`, [harnessId]);
  },
};

type SavedPromptRow = {
  id: string; name: string; content: string;
  created_at: number; updated_at: number;
};

const toSavedPrompt = (r: SavedPromptRow): SavedPrompt => ({
  id: r.id,
  name: r.name,
  content: r.content,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface SavedPromptInsertInput {
  name: string;
  content: string;
}

export interface SavedPromptPatch {
  name?: string;
  content?: string;
}

export const savedPrompts = {
  list(): SavedPrompt[] {
    return db
      .query<SavedPromptRow, []>(
        `SELECT * FROM saved_prompts ORDER BY created_at ASC, id ASC`,
      )
      .all()
      .map(toSavedPrompt);
  },
  get(id: string): SavedPrompt | null {
    const row = db
      .query<SavedPromptRow, [string]>(`SELECT * FROM saved_prompts WHERE id = ?`)
      .get(id);
    return row ? toSavedPrompt(row) : null;
  },
  insert(input: SavedPromptInsertInput): SavedPrompt {
    const id = randomUUID();
    const now = Date.now();
    db.run(
      `INSERT INTO saved_prompts (id, name, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, input.name, input.content, now, now],
    );
    return this.get(id) as SavedPrompt;
  },
  update(id: string, patch: SavedPromptPatch): SavedPrompt | null {
    const current = this.get(id);
    if (!current) return null;
    const next = {
      name: patch.name ?? current.name,
      content: patch.content ?? current.content,
    };
    db.run(
      `UPDATE saved_prompts SET name = ?, content = ?, updated_at = ? WHERE id = ?`,
      [next.name, next.content, Date.now(), id],
    );
    return this.get(id);
  },
  delete(id: string): boolean {
    const current = this.get(id);
    if (!current) return false;
    db.run(`DELETE FROM saved_prompts WHERE id = ?`, [id]);
    return true;
  },
};

type RunRow = {
  id: string; task_id: string; agent: string; status: string;
  started_at: number; ended_at: number | null; exit_code: number | null;
  tmux_session: string | null;
  claude_session_id: string | null;
  codex_session_id: string | null;
  cursor_session_id: string | null;
  gemini_session_id: string | null;
  fx_session_id: string | null;
  origin: string | null;
};

const toRun = (r: RunRow): Run => ({
  id: r.id,
  taskId: r.task_id,
  agent: r.agent as Run["agent"],
  status: r.status as Run["status"],
  startedAt: r.started_at,
  endedAt: r.ended_at,
  exitCode: r.exit_code,
  tmuxSession: r.tmux_session,
  claudeSessionId: r.claude_session_id,
  codexSessionId: r.codex_session_id,
  cursorSessionId: r.cursor_session_id,
  geminiSessionId: r.gemini_session_id,
  fxSessionId: r.fx_session_id,
  origin: (r.origin as Run["origin"]) ?? null,
});

export const runs = {
  listForTask(taskId: string): Run[] {
    return db.query<RunRow, [string]>(
      `SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC`,
    ).all(taskId).map(toRun);
  },
  get(id: string): Run | null {
    const row = db.query<RunRow, [string]>(`SELECT * FROM runs WHERE id = ?`).get(id);
    return row ? toRun(row) : null;
  },
  /** `r.origin` is optional on the `Run` type (most callers don't set it —
   *  only the continuation-run factory does) so `?? null` keeps a
   *  user-initiated run's row explicitly NULL rather than the JS `undefined`
   *  bun:sqlite would otherwise bind. */
  insert(r: Run): Run {
    db.run(
      `INSERT INTO runs (id, task_id, agent, status, started_at, ended_at, exit_code, tmux_session, claude_session_id, codex_session_id, cursor_session_id, gemini_session_id, fx_session_id, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.taskId, r.agent, r.status, r.startedAt, r.endedAt, r.exitCode, r.tmuxSession, r.claudeSessionId, r.codexSessionId, r.cursorSessionId, r.geminiSessionId, r.fxSessionId ?? null, r.origin ?? null],
    );
    return { ...r, origin: r.origin ?? null };
  },
  update(id: string, patch: Partial<Run>): Run | null {
    const row = db.query<RunRow, [string]>(`SELECT * FROM runs WHERE id = ?`).get(id);
    if (!row) return null;
    const current = toRun(row);
    const next: Run = { ...current, ...patch, id };
    db.run(
      `UPDATE runs SET status=?, ended_at=?, exit_code=?, claude_session_id=?, codex_session_id=?, cursor_session_id=?, gemini_session_id=?, fx_session_id=? WHERE id=?`,
      [next.status, next.endedAt, next.exitCode, next.claudeSessionId, next.codexSessionId, next.cursorSessionId, next.geminiSessionId, next.fxSessionId, id],
    );
    return next;
  },
  /** Events for a single run, in event-id order. `runId` is the same as
   *  the argument — included on every row so the shape matches
   *  `eventsForTask`, keeping the two helpers interchangeable to a
   *  caller that just wants `{ runId, stream, data, ts }`. */
  events(runId: string) {
    return db.query<
      { runId: string; stream: string; data: string; ts: number; subagentId: string | null },
      [string]
    >(
      `SELECT run_id as runId, stream, data, ts, subagent_id as subagentId
       FROM run_events
       WHERE run_id = ?
       ORDER BY id ASC`,
    ).all(runId);
  },
  /** The most recently persisted MAIN-stream event's raw `data` for a run
   *  (`subagent_id IS NULL`, like `seenLineUuidsForTask`), or `null` if the
   *  run has none yet.
   *
   *  Backs `reapIdleSessions`'s idempotence guard: a re-reap regression
   *  would try to append the identical hibernate breadcrumb to the same run
   *  again, and comparing against the last persisted event's exact text is
   *  enough to catch that without a full row fetch. The breadcrumb itself is
   *  a main-stream row, so a subagent row landing afterwards must not
   *  re-arm the guard — hence the filter. */
  lastEventData(runId: string): string | null {
    const row = db.query<{ data: string }, [string]>(
      `SELECT data FROM run_events WHERE run_id = ? AND subagent_id IS NULL ORDER BY id DESC LIMIT 1`,
    ).get(runId);
    return row ? row.data : null;
  },
  /** The most recently persisted MAIN-stream `tool_use` event's raw `data`
   *  for a run (`subagent_id IS NULL`, same rationale as `lastEventData`: a
   *  subagent's tool call must not be mistaken for the main run's), or
   *  `null` if the run has none.
   *
   *  Backs `detectCursorPlan`'s "is the run's last tool call a
   *  `createPlanToolCall`?" check. That used to be a full `runs.events(runId)`
   *  scan keeping only the last `tool_use` row — correct, but O(run length)
   *  on every settlement of every cursor run, even long ones with no plan at
   *  all. This is the same lookup expressed as a targeted, indexed query. */
  lastToolUseData(runId: string): string | null {
    const row = db.query<{ data: string }, [string]>(
      `SELECT data FROM run_events WHERE run_id = ? AND stream = 'tool_use' AND subagent_id IS NULL ORDER BY id DESC LIMIT 1`,
    ).get(runId);
    return row ? row.data : null;
  },
  /** All events across every run of a task, in event-id order (which is
   *  chronological — id is autoincrement, ts can collide when bursts of
   *  events land in the same Date.now() ms). Used by the unified
   *  task-level stream so the panel shows the whole conversation as one
   *  scrollback instead of per-run silos.
   *
   *  With no `opts` (or no `opts.limit`), returns the full unbounded
   *  ascending history — the original behavior, kept for existing callers
   *  (tests, `rebuildEventsFromJsonl`-adjacent tooling) that want everything.
   *
   *  With `opts.limit` set, returns only the MOST RECENT `limit` events:
   *  filters `id < opts.beforeId` when given, orders by id DESC, takes
   *  `limit`, then reverses so the caller still sees ascending order. This
   *  is what powers the capped SSE replay window and the `/events/page`
   *  paging route — both want "the newest N (before some cursor)", not
   *  "the first N". */
  eventsForTask(
    taskId: string,
    opts?: { beforeId?: number; limit?: number },
  ): Array<{ id: number; runId: string; stream: string; data: string; ts: number; subagentId: string | null }> {
    type Row = { id: number; runId: string; stream: string; data: string; ts: number; subagentId: string | null };
    if (opts?.limit) {
      const conditions = ["runs.task_id = ?"];
      const params: Array<string | number> = [taskId];
      if (opts.beforeId != null) {
        conditions.push("run_events.id < ?");
        params.push(opts.beforeId);
      }
      params.push(opts.limit);
      const rows = db.query<Row, Array<string | number>>(
        `SELECT run_events.id as id, run_events.run_id as runId, stream, data, ts, run_events.subagent_id as subagentId
         FROM run_events
         JOIN runs ON runs.id = run_events.run_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY run_events.id DESC
         LIMIT ?`,
      ).all(...params);
      return rows.reverse();
    }
    return db.query<Row, [string]>(
      `SELECT run_events.id as id, run_events.run_id as runId, stream, data, ts, run_events.subagent_id as subagentId
       FROM run_events
       JOIN runs ON runs.id = run_events.run_id
       WHERE runs.task_id = ?
       ORDER BY run_events.id ASC`,
    ).all(taskId);
  },
  /** Past sent user messages (main-stream only, blank ones excluded) across
   *  every task, regardless of harness — used to build a cross-task "message
   *  history" picker shared by all tasks. Byte-identical texts are collapsed
   *  to their most recent occurrence via `GROUP BY data` + `MAX(id)`:
   *  SQLite's bare-column-with-single-MAX semantics
   *  (https://www.sqlite.org/lang_select.html#bareagg) guarantees the other
   *  selected columns come from that same max-id row. */
  userMessageHistory(
    limit: number,
  ): Array<{ id: number; data: string; ts: number; taskId: string; taskTitle: string; taskWorkdir: string; projectName: string | null; taskAgent: string }> {
    type Row = { id: number; data: string; ts: number; taskId: string; taskTitle: string; taskWorkdir: string; projectName: string | null; taskAgent: string };
    return db.query<Row, [number]>(
      `SELECT MAX(run_events.id) as id, run_events.data as data, ts, tasks.id as taskId, tasks.title as taskTitle,
              tasks.workdir as taskWorkdir, projects.name as projectName, tasks.agent as taskAgent
       FROM run_events
       JOIN runs ON runs.id = run_events.run_id
       JOIN tasks ON tasks.id = runs.task_id
       LEFT JOIN projects ON projects.path = tasks.workdir
       WHERE run_events.stream = 'user'
         AND run_events.subagent_id IS NULL
         AND trim(run_events.data, char(32,9,10,13)) != ''
       GROUP BY run_events.data
       ORDER BY id DESC
       LIMIT ?`,
    ).all(limit);
  },
  /** Todo-family tool events for a task, across every run, in event-id
   *  (chronological) order — main-stream only (`subagent_id IS NULL`, same
   *  rationale as `lastEventData`/`lastToolUseData`: a background agent's own
   *  TodoWrite/TaskCreate/TaskUpdate calls track ITS todos, not the primary
   *  task's, and must not be mixed into the board summary).
   *
   *  Two different LIKE shapes for the two streams, deliberately NOT a
   *  single shared marker set (mirrors `isTodoFamilyChunk` in
   *  orchestrator.ts, same split for the same reason):
   *   - `tool_use` rows carry `"name":"<Tool>"` in their JSON envelope, so
   *     the filter matches that literal envelope form rather than a bare
   *     substring — a bare `LIKE '%TaskCreate%'` also matches an unrelated
   *     tool_result whose text happens to quote "TaskCreate" (this repo
   *     dogfoods itself, so that's a real false positive, not a theoretical
   *     one).
   *   - `tool_result` rows have NO tool name at all (`{toolUseId, content,
   *     isError}`) — only `TaskCreate`'s result is ever consulted by
   *     `deriveTodoProgress` (to resolve the "Task #N" number), and always
   *     via the fixed `"Task #N created successfully"` text Claude emits, so
   *     that's the cheapest-but-correct marker: cheaper than admitting every
   *     tool_result row for the task (most of which `deriveTodoProgress`
   *     would just discard by unmatched `toolUseId`), and correct because it
   *     targets the exact literal all TaskCreate results share.
   *  Backs the orchestrator chunk handler's board-summary update: rare
   *  chunks, so a full re-derive per call is cheap, and because the chunk
   *  handler always calls `runs.appendEvent` before running this query (see
   *  `makeChunkHandler`), the just-arrived chunk is already included — no
   *  separate "append the current chunk" step needed. */
  todoRelevantEventsForTask(taskId: string): Array<{ stream: string; data: string }> {
    return db.query<{ stream: string; data: string }, [string]>(
      `SELECT stream, data
       FROM run_events
       JOIN runs ON runs.id = run_events.run_id
       WHERE runs.task_id = ?
         AND run_events.subagent_id IS NULL
         AND (
           (run_events.stream = 'tool_use' AND (
             data LIKE '%"name":"TodoWrite"%'
             OR data LIKE '%"name":"TaskCreate"%'
             OR data LIKE '%"name":"TaskUpdate"%'
           ))
           OR (run_events.stream = 'tool_result' AND data LIKE '%created successfully%')
         )
       ORDER BY run_events.id ASC`,
    ).all(taskId);
  },
  /** Cheap existence check — is there at least one persisted event for this
   *  task older than `beforeId`? Backs the `hasMore` flag on both the SSE
   *  `replay_meta` frame and the `/events/page` paging route, so the client
   *  knows whether to keep showing "Load earlier" without fetching (and
   *  counting) the whole remaining history. */
  hasEventsBefore(taskId: string, beforeId: number): boolean {
    const row = db.query<{ 1: number }, [string, number]>(
      `SELECT 1 FROM run_events
       JOIN runs ON runs.id = run_events.run_id
       WHERE runs.task_id = ? AND run_events.id < ?
       LIMIT 1`,
    ).get(taskId, beforeId);
    return row !== null;
  },
  /**
   * Returns the inserted row's `id`, or `null` when nothing was actually
   * inserted — i.e. the `INSERT OR IGNORE` dedup path hit an existing
   * `(run_id, line_uuid)` row. Callers that only care about "did this event
   * land, and what's its id" (the unread-watermark detector in
   * `makeChunkHandler`) can rely on `null` meaning "already persisted
   * earlier, don't re-derive from it" rather than misreading a stale
   * `lastInsertRowid` left over from some unrelated prior statement on this
   * connection. Existing call sites all predate this return value and
   * simply don't use it.
   */
  appendEvent(
    runId: string,
    stream: RunEventStream,
    data: string,
    lineUuid?: string | null,
    subagentId?: string | null,
  ): number | null {
    // INSERT OR IGNORE only when a dedup key is provided. With NULL keys the
    // partial unique index (`WHERE line_uuid IS NOT NULL`) doesn't apply, so
    // non-JSONL events still insert unconditionally and we don't accidentally
    // suppress two genuinely distinct status/stderr rows that happen to share
    // (runId, NULL).
    if (lineUuid) {
      const result = db.run(
        `INSERT OR IGNORE INTO run_events (run_id, stream, data, ts, line_uuid, subagent_id) VALUES (?, ?, ?, ?, ?, ?)`,
        [runId, stream, data, Date.now(), lineUuid, subagentId ?? null],
      );
      return result.changes > 0 ? Number(result.lastInsertRowid) : null;
    }
    const result = db.run(
      `INSERT INTO run_events (run_id, stream, data, ts, subagent_id) VALUES (?, ?, ?, ?, ?)`,
      [runId, stream, data, Date.now(), subagentId ?? null],
    );
    return Number(result.lastInsertRowid);
  },
  /** Return every JSONL line uuid already persisted across *every* run of
   *  this task. Used by `reattachSession` to seed the in-memory dedup set so
   *  re-tailing the per-session JSONL from offset 0 (after an agetor
   *  restart) skips events we already streamed in the previous process.
   *
   *  Scoped to the task (not just the reattached run) on purpose: one tmux
   *  session = one JSONL file = all of a task's turns. The replay from
   *  offset 0 will encounter end_turn lines from prior, already-`succeeded`
   *  run rows; without those uuids in the dedup set the dispatcher would
   *  re-emit them onto the reattached (still-`running`) run's chunk
   *  handler — corrupting its event history and, worse, firing
   *  `onEndOfTurn` on the wrong turn and prematurely resolving the
   *  current run.
   *
   *  `subagent_id IS NULL`: this seeds the MAIN session tailer's dedup set
   *  only — subagent transcripts live in separate sidechain files and are
   *  deduped independently via `seenLineUuidsForSubagent`, keyed by
   *  `(run_id, subagent_id, line_uuid)`. Mixing subagent uuids into this set
   *  is a no-op in practice (uuid namespaces don't collide) but is the wrong
   *  scope conceptually, and matches the same filter applied elsewhere for
   *  subagent-tagged rows. */
  seenLineUuidsForTask(taskId: string): Set<string> {
    const rows = db.query<{ line_uuid: string }, [string]>(
      `SELECT e.line_uuid
       FROM run_events e
       JOIN runs r ON r.id = e.run_id
       WHERE r.task_id = ? AND e.line_uuid IS NOT NULL AND e.subagent_id IS NULL`,
    ).all(taskId);
    return new Set(rows.map((r) => r.line_uuid));
  },
  /** Line uuids already persisted for a single subagent's stream. Seeds the
   *  subagent tailer's in-memory dedup set on reattach so re-reading
   *  `agent-<id>.jsonl` from offset 0 doesn't double-insert/emit events the
   *  previous process already streamed. Scoped by subagent_id (independent of
   *  run_id), mirroring `seenLineUuidsForTask` for the main stream. */
  seenLineUuidsForSubagent(subagentId: string): Set<string> {
    const rows = db.query<{ line_uuid: string }, [string]>(
      `SELECT line_uuid FROM run_events
       WHERE subagent_id = ? AND line_uuid IS NOT NULL`,
    ).all(subagentId);
    return new Set(rows.map((r) => r.line_uuid));
  },
  /** Whether ANY persisted event for `subagentId` carries a `line_uuid`
   *  starting with `prefix` — a targeted probe for a marker key such as
   *  claude-subagents.ts's `monitor:<id>:terminal:` (an authoritative Monitor
   *  receipt on record), cheaper than materialising every uuid via
   *  `seenLineUuidsForSubagent` just to scan a chatty stream for one prefix.
   *  Compared with `substr` rather than `LIKE` so a `%`/`_` in the prefix
   *  can't widen the match. */
  hasLineUuidPrefixForSubagent(subagentId: string, prefix: string): boolean {
    const row = db.query<{ one: number }, [string, string, string]>(
      `SELECT 1 as one FROM run_events
       WHERE subagent_id = ? AND line_uuid IS NOT NULL AND substr(line_uuid, 1, length(?)) = ?
       LIMIT 1`,
    ).get(subagentId, prefix, prefix);
    return row !== null;
  },
};

interface SubagentRow {
  id: string;
  task_id: string;
  run_id: string | null;
  parent_kind: string;
  agent_type: string | null;
  description: string | null;
  spawn_depth: number;
  source_path: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  tool_use_id: string | null;
}

/** Every `parent_kind` the app understands. The column is plain TEXT with no
 *  CHECK constraint (see `022_subagents.sql`) precisely so new kinds need no
 *  migration — but an unknown value read back from a future/foreign build must
 *  still land on a member of the union, so `toSubagent` falls back to
 *  `"subagent"` for anything not listed here. Keep in sync with
 *  `Subagent.parentKind` in shared/types.ts. */
const PARENT_KINDS = new Set<string>(["subagent", "bg_session", "workflow", "workflow_agent", "monitor"]);

function toSubagent(r: SubagentRow): Subagent {
  return {
    id: r.id,
    taskId: r.task_id,
    runId: r.run_id,
    parentKind: PARENT_KINDS.has(r.parent_kind)
      ? (r.parent_kind as Subagent["parentKind"])
      : "subagent",
    agentType: r.agent_type,
    description: r.description,
    spawnDepth: r.spawn_depth,
    sourcePath: r.source_path,
    toolUseId: r.tool_use_id,
    status: r.status as SubagentStatus,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

export const subagents = {
  /** Every tracked subagent for a task, oldest first (spawn order — that's how
   *  the tab strip lays them out left-to-right after the pinned Main tab). */
  listForTask(taskId: string): Subagent[] {
    return db.query<SubagentRow, [string]>(
      `SELECT * FROM subagents WHERE task_id = ? ORDER BY started_at ASC, id ASC`,
    ).all(taskId).map(toSubagent);
  },
  get(id: string): Subagent | null {
    const row = db.query<SubagentRow, [string]>(`SELECT * FROM subagents WHERE id = ?`).get(id);
    return row ? toSubagent(row) : null;
  },
  /** Register a freshly-discovered subagent. Idempotent: re-discovering an
   *  existing id (e.g. the watcher restarts) is a no-op rather than resetting
   *  its status/timing. */
  insertIfAbsent(s: Subagent): void {
    db.run(
      `INSERT OR IGNORE INTO subagents
         (id, task_id, run_id, parent_kind, agent_type, description, spawn_depth, source_path, status, started_at, ended_at, tool_use_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.id, s.taskId, s.runId, s.parentKind, s.agentType, s.description, s.spawnDepth, s.sourcePath, s.status, s.startedAt, s.endedAt, s.toolUseId ?? null],
    );
  },
  setStatus(id: string, status: SubagentStatus, endedAt: number | null): void {
    db.run(`UPDATE subagents SET status = ?, ended_at = ? WHERE id = ?`, [status, endedAt, id]);
  },
  /** Backfill the tool_result correlation key for a row created before this
   *  column existed (or whose meta sidecar hadn't been read yet). Only fills
   *  a NULL — never overwrites an id already recorded, so a stale re-read of
   *  the sidecar can't clobber a value another path already set. */
  setToolUseId(id: string, toolUseId: string): void {
    db.run(`UPDATE subagents SET tool_use_id = ? WHERE id = ? AND tool_use_id IS NULL`, [toolUseId, id]);
  },
  /** Settle a single subagent by id — the DB half of an *externally*-detected
   *  completion (a parent task-notification naming the finishing agent, or
   *  boot reconciliation finding its session gone), as opposed to the
   *  watcher's own `checkDone` idle-detection. Idempotent: only flips a row
   *  whose status is currently `running`, so a duplicate/late signal (e.g.
   *  the watcher's own idle-detection racing the same completion) is a
   *  harmless no-op rather than double-firing `ended_at`. Returns whether a
   *  row actually changed, plus its `taskId` (cheap — same SELECT) so the
   *  caller can trigger the settle/release-hold bookkeeping without a second
   *  query. */
  markSettledById(id: string, status: "completed" | "orphaned"): { changed: boolean; taskId: string | null } {
    const row = db.query<SubagentRow, [string]>(
      `SELECT * FROM subagents WHERE id = ? AND status = 'running'`,
    ).get(id);
    if (!row) return { changed: false, taskId: null };
    const now = Date.now();
    db.run(`UPDATE subagents SET status = ?, ended_at = ? WHERE id = ?`, [status, now, id]);
    return { changed: true, taskId: row.task_id };
  },
  /** True when at least one subagent row for this task is still `running`. */
  hasRunning(taskId: string): boolean {
    const row = db.query<{ 1: number }, [string]>(
      `SELECT 1 FROM subagents WHERE task_id = ? AND status = 'running' LIMIT 1`,
    ).get(taskId);
    return row !== null;
  },
  /** True when at least one subagent row for ANY task is still `running` —
   *  the task-agnostic sibling of `hasRunning`, for whole-process idle checks
   *  (the headless daemon's idle-shutdown). `startedAfter`, when given,
   *  restricts the scan to rows started after that epoch-ms cutoff — the
   *  caller's escape hatch against a row that can never settle (a workflow
   *  container row, which has no staleness backstop, or a row left behind by
   *  an `AGETOR_TRACK_SUBAGENTS=0` no-op watcher): past the cutoff nothing is
   *  plausibly still going to finish it, so the idle check should stop
   *  treating it as live work. */
  hasAnyRunning(startedAfter?: number): boolean {
    const row =
      startedAfter != null
        ? db
            .query<{ 1: number }, [number]>(
              `SELECT 1 FROM subagents WHERE status = 'running' AND started_at > ? LIMIT 1`,
            )
            .get(startedAfter)
        : db.query<{ 1: number }, []>(
            `SELECT 1 FROM subagents WHERE status = 'running' LIMIT 1`,
          ).get();
    return row !== null;
  },
  /** How many of this task's subagents are `running`. Distinct from
   *  `runningCountsByTask` so a single-task caller doesn't scan every row. */
  runningCountForTask(taskId: string): number {
    const row = db.query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM subagents WHERE task_id = ? AND status = 'running'`,
    ).get(taskId);
    return row?.n ?? 0;
  },
  /** Flip every `running` row for this task to `orphaned` (ended_at = now).
   *  Returns the affected rows (post-update shape) so the caller can emit a
   *  `finished` lifecycle event per row. Returns [] when nothing was running. */
  orphanRunning(taskId: string, now: number): Subagent[] {
    const rows = db.query<SubagentRow, [string]>(
      `SELECT * FROM subagents WHERE task_id = ? AND status = 'running'`,
    ).all(taskId);
    if (rows.length === 0) return [];
    db.run(
      `UPDATE subagents SET status = 'orphaned', ended_at = ? WHERE task_id = ? AND status = 'running'`,
      [now, taskId],
    );
    return rows.map((r) => toSubagent({ ...r, status: "orphaned", ended_at: now }));
  },
  /** taskId -> count of `running` rows. One grouped query, for the board poll. */
  runningCountsByTask(): Map<string, number> {
    const rows = db.query<{ task_id: string; n: number }, []>(
      `SELECT task_id, COUNT(*) AS n FROM subagents WHERE status = 'running' GROUP BY task_id`,
    ).all();
    return new Map(rows.map((r) => [r.task_id, r.n]));
  },
  /** Distinct ids of every task with at least one `running` subagents row,
   *  regardless of the task's own `column`. Boot reconciliation's held-task
   *  pass used to source from `tasks WHERE column = 'running'`, which misses
   *  a task whose terminal run already resolved and moved the card to
   *  `review`/`done`/etc. before the crash — this is the wider source set
   *  that also catches that case. */
  taskIdsWithRunning(): string[] {
    const rows = db.query<{ task_id: string }, []>(
      `SELECT DISTINCT task_id FROM subagents WHERE status = 'running'`,
    ).all();
    return rows.map((r) => r.task_id);
  },
};

import { Database } from "bun:sqlite";
import { homedir, tmpdir } from "node:os";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import type { AgentKind, BranchNamingConfig, Harness, HarnessUsage, Project, Task, TaskReference, TaskType, Run, RunEventStream, Subagent, SubagentStatus } from "../shared/types.ts";
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
import { countPendingForTask } from "./interactions.ts";
// Same lazy-cycle contract as interactions.ts above: terminals.ts imports
// `tasks` from this module, and we call `countTerminals` only inside `toTask`
// (a function body), never at top level. Do not hoist this call site.
import { countTerminals } from "./terminals.ts";

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
  mode: string | null; model: string | null; effort: string | null;
  refs: string;
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

const toTask = (r: TaskRow): Task => ({
  id: r.id,
  title: r.title,
  prompt: r.prompt,
  column: r.column as Task["column"],
  agent: r.agent as Task["agent"],
  workdir: r.workdir,
  isolation: r.isolation as Task["isolation"],
  taskType: r.task_type as TaskType,
  branch: r.branch,
  worktreePath: r.worktree_path,
  baseRef: r.base_ref,
  mode: r.mode,
  model: r.model,
  effort: r.effort,
  references: parseRefs(r.refs),
  runId: r.run_id,
  // `has_openable_run` comes back as SQLite's 0/1; missing means we didn't
  // join (e.g. insert/update returning the freshly-written shape, where
  // no runs exist yet → false is the right default).
  hasOpenableRun: r.has_openable_run === 1,
  pendingInteractionCount: countPendingForTask(r.id),
  openTerminalCount: countTerminals(r.id),
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
  list(): Task[] {
    return db.query<TaskRow, []>(
      `${TASKS_SELECT}
         GROUP BY tasks.id
         ORDER BY tasks.created_at DESC`,
    ).all().map(toTask);
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
          branch, worktree_path, base_ref, mode, model, effort, refs,
          run_id, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t.id, t.title, t.prompt, t.column, t.agent, t.workdir, t.isolation,
        t.taskType,
        t.branch, t.worktreePath, t.baseRef, t.mode, t.model, t.effort,
        JSON.stringify(t.references ?? []),
        t.runId, t.createdAt, t.updatedAt, t.archivedAt ?? null,
      ],
    );
    // Round-trip via `get` so the returned shape carries the computed
    // hasOpenableRun field (false for a brand-new task — but callers
    // that mutate t shouldn't accidentally get a stale shape).
    return this.get(t.id) ?? { ...t, hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0, archivedAt: null };
  },
  update(id: string, patch: Partial<Task>): Task | null {
    const current = this.get(id);
    if (!current) return null;
    const next: Task = { ...current, ...patch, id, updatedAt: Date.now() };
    db.run(
      `UPDATE tasks SET
         title=?, prompt=?, "column"=?, agent=?, workdir=?, isolation=?, task_type=?,
         branch=?, worktree_path=?, base_ref=?, mode=?, model=?, effort=?, refs=?,
         run_id=?, updated_at=?, archived_at=?
       WHERE id=?`,
      [
        next.title, next.prompt, next.column, next.agent, next.workdir, next.isolation,
        next.taskType,
        next.branch, next.worktreePath, next.baseRef, next.mode, next.model, next.effort,
        JSON.stringify(next.references ?? []),
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
    if (id === "claude-code" || id === "codex") {
      return {
        id,
        kind: id,
        label: id === "claude-code" ? "Claude Code" : "Codex",
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
    if (input.kind !== "claude-code" && input.kind !== "codex") {
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

type RunRow = {
  id: string; task_id: string; agent: string; status: string;
  started_at: number; ended_at: number | null; exit_code: number | null;
  tmux_session: string | null;
  claude_session_id: string | null;
  codex_session_id: string | null;
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
  insert(r: Run): Run {
    db.run(
      `INSERT INTO runs (id, task_id, agent, status, started_at, ended_at, exit_code, tmux_session, claude_session_id, codex_session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.taskId, r.agent, r.status, r.startedAt, r.endedAt, r.exitCode, r.tmuxSession, r.claudeSessionId, r.codexSessionId],
    );
    return r;
  },
  update(id: string, patch: Partial<Run>): Run | null {
    const row = db.query<RunRow, [string]>(`SELECT * FROM runs WHERE id = ?`).get(id);
    if (!row) return null;
    const current = toRun(row);
    const next: Run = { ...current, ...patch, id };
    db.run(
      `UPDATE runs SET status=?, ended_at=?, exit_code=?, claude_session_id=?, codex_session_id=? WHERE id=?`,
      [next.status, next.endedAt, next.exitCode, next.claudeSessionId, next.codexSessionId, id],
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
  /** All events across every run of a task, in event-id order (which is
   *  chronological — id is autoincrement, ts can collide when bursts of
   *  events land in the same Date.now() ms). Used by the unified
   *  task-level stream so the panel shows the whole conversation as one
   *  scrollback instead of per-run silos. */
  eventsForTask(taskId: string) {
    return db.query<
      { runId: string; stream: string; data: string; ts: number; subagentId: string | null },
      [string]
    >(
      `SELECT run_events.run_id as runId, stream, data, ts, run_events.subagent_id as subagentId
       FROM run_events
       JOIN runs ON runs.id = run_events.run_id
       WHERE runs.task_id = ?
       ORDER BY run_events.id ASC`,
    ).all(taskId);
  },
  appendEvent(
    runId: string,
    stream: RunEventStream,
    data: string,
    lineUuid?: string | null,
    subagentId?: string | null,
  ) {
    // INSERT OR IGNORE only when a dedup key is provided. With NULL keys the
    // partial unique index (`WHERE line_uuid IS NOT NULL`) doesn't apply, so
    // non-JSONL events still insert unconditionally and we don't accidentally
    // suppress two genuinely distinct status/stderr rows that happen to share
    // (runId, NULL).
    if (lineUuid) {
      db.run(
        `INSERT OR IGNORE INTO run_events (run_id, stream, data, ts, line_uuid, subagent_id) VALUES (?, ?, ?, ?, ?, ?)`,
        [runId, stream, data, Date.now(), lineUuid, subagentId ?? null],
      );
    } else {
      db.run(
        `INSERT INTO run_events (run_id, stream, data, ts, subagent_id) VALUES (?, ?, ?, ?, ?)`,
        [runId, stream, data, Date.now(), subagentId ?? null],
      );
    }
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
}

function toSubagent(r: SubagentRow): Subagent {
  return {
    id: r.id,
    taskId: r.task_id,
    runId: r.run_id,
    parentKind: r.parent_kind === "bg_session" ? "bg_session" : "subagent",
    agentType: r.agent_type,
    description: r.description,
    spawnDepth: r.spawn_depth,
    sourcePath: r.source_path,
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
         (id, task_id, run_id, parent_kind, agent_type, description, spawn_depth, source_path, status, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.id, s.taskId, s.runId, s.parentKind, s.agentType, s.description, s.spawnDepth, s.sourcePath, s.status, s.startedAt, s.endedAt],
    );
  },
  setStatus(id: string, status: SubagentStatus, endedAt: number | null): void {
    db.run(`UPDATE subagents SET status = ?, ended_at = ? WHERE id = ?`, [status, endedAt, id]);
  },
};

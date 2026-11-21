import type { Database } from "bun:sqlite";
import type { Subagent, SubagentStatus } from "../../shared/types.ts";

export interface SubagentRow {
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
export const PARENT_KINDS = new Set<string>([
  "subagent",
  "bg_session",
  "workflow",
  "workflow_agent",
  "monitor",
  "opencode_subagent",
  "copilot_subagent",
]);

export function toSubagent(r: SubagentRow): Subagent {
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

/** The pseudo `source_path` prefix of an OpenCode child-session subagent row
 *  (`opencode-session:<child id>`, never a file). opencode-subagents.ts
 *  re-exports it as `OPENCODE_SUBAGENT_SOURCE_PREFIX`; it lives here so the
 *  SQL above can match it. */
export const OPENCODE_CHILD_SOURCE_PREFIX = "opencode-session:";

/** One OpenCode session still watched after its task let go of it (migration 083). */
export interface OpencodeWatchTombstone {
  sessionId: string;
  harnessId: string;
  taskId: string;
  expiresAt: number;
}

/** Outcome stored on `cursor_asks`. Null in the table means still open. */
export type CursorAskOutcome = "answered" | "skipped" | "cancelled";

export interface StoredCursorAsk {
  taskId: string;
  toolCallId: string;
  runId: string;
  payload: { title?: string; questions: unknown[] };
  outcome: CursorAskOutcome | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface CursorAskSqlRow {
  task_id: string;
  tool_call_id: string;
  run_id: string;
  payload_json: string;
  outcome: string | null;
  created_at: number;
  resolved_at: number | null;
}

export function toStoredCursorAsk(row: CursorAskSqlRow): StoredCursorAsk {
  let payload: StoredCursorAsk["payload"] = { questions: [] };
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      payload = {
        ...(typeof rec.title === "string" ? { title: rec.title } : {}),
        questions: Array.isArray(rec.questions) ? rec.questions : [],
      };
    }
  } catch {
    /* keep the empty payload — a corrupt row must not throw at boot */
  }
  const outcome = row.outcome === "answered" || row.outcome === "skipped" || row.outcome === "cancelled"
    ? row.outcome
    : null;
  return {
    taskId: row.task_id,
    toolCallId: row.tool_call_id,
    runId: row.run_id,
    payload,
    outcome,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export function makeSubagents(conn: Database) {
  const subagents = {
    /** Every tracked subagent for a task, oldest first (spawn order — that's how
     *  the tab strip lays them out left-to-right after the pinned Main tab). */
    listForTask(taskId: string): Subagent[] {
      return conn.query<SubagentRow, [string]>(
        `SELECT * FROM subagents WHERE task_id = ? ORDER BY started_at ASC, id ASC`,
      ).all(taskId).map(toSubagent);
    },
    get(id: string): Subagent | null {
      const row = conn.query<SubagentRow, [string]>(`SELECT * FROM subagents WHERE id = ?`).get(id);
      return row ? toSubagent(row) : null;
    },
    /** Register a freshly-discovered subagent. Idempotent: re-discovering an
     *  existing id (e.g. the watcher restarts) is a no-op rather than resetting
     *  its status/timing. */
    insertIfAbsent(s: Subagent): void {
      conn.run(
        `INSERT OR IGNORE INTO subagents
         (id, task_id, run_id, parent_kind, agent_type, description, spawn_depth, source_path, status, started_at, ended_at, tool_use_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [s.id, s.taskId, s.runId, s.parentKind, s.agentType, s.description, s.spawnDepth, s.sourcePath, s.status, s.startedAt, s.endedAt, s.toolUseId ?? null],
      );
    },
    setStatus(id: string, status: SubagentStatus, endedAt: number | null): void {
      conn.run(`UPDATE subagents SET status = ?, ended_at = ? WHERE id = ?`, [status, endedAt, id]);
    },
    /** Backfill the tool_result correlation key for a row created before this
     *  column existed (or whose meta sidecar hadn't been read yet). Only fills
     *  a NULL — never overwrites an id already recorded, so a stale re-read of
     *  the sidecar can't clobber a value another path already set. */
    setToolUseId(id: string, toolUseId: string): void {
      conn.run(`UPDATE subagents SET tool_use_id = ? WHERE id = ? AND tool_use_id IS NULL`, [toolUseId, id]);
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
      const row = conn.query<SubagentRow, [string]>(
        `SELECT * FROM subagents WHERE id = ? AND status = 'running'`,
      ).get(id);
      if (!row) return { changed: false, taskId: null };
      const now = Date.now();
      conn.run(`UPDATE subagents SET status = ?, ended_at = ? WHERE id = ?`, [status, now, id]);
      return { changed: true, taskId: row.task_id };
    },
    /** True when at least one subagent row for this task is still `running`. */
    hasRunning(taskId: string): boolean {
      const row = conn.query<{ 1: number }, [string]>(
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
          ? conn
              .query<{ 1: number }, [number]>(
                `SELECT 1 FROM subagents WHERE status = 'running' AND started_at > ? LIMIT 1`,
              )
              .get(startedAfter)
          : conn.query<{ 1: number }, []>(
              `SELECT 1 FROM subagents WHERE status = 'running' LIMIT 1`,
            ).get();
      return row !== null;
    },
    /** How many of this task's subagents are `running`. Distinct from
     *  `runningCountsByTask` so a single-task caller doesn't scan every row. */
    runningCountForTask(taskId: string): number {
      const row = conn.query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM subagents WHERE task_id = ? AND status = 'running'`,
      ).get(taskId);
      return row?.n ?? 0;
    },
    /** Flip every `running` row for this task to `orphaned` (ended_at = now).
     *  Returns the affected rows (post-update shape) so the caller can emit a
     *  `finished` lifecycle event per row. Returns [] when nothing was running. */
    orphanRunning(taskId: string, now: number): Subagent[] {
      const rows = conn.query<SubagentRow, [string]>(
        `SELECT * FROM subagents WHERE task_id = ? AND status = 'running'`,
      ).all(taskId);
      if (rows.length === 0) return [];
      conn.run(
        `UPDATE subagents SET status = 'orphaned', ended_at = ? WHERE task_id = ? AND status = 'running'`,
        [now, taskId],
      );
      return rows.map((r) => toSubagent({ ...r, status: "orphaned", ended_at: now }));
    },
    /** Settle every `running` subagent row of ONE run to `status` (ended_at =
     *  `now`). Run-scoped (unlike `orphanRunning`, which is task-scoped), for
     *  drivers that own their subagents' lifecycle and close them all when the
     *  parent run settles. Only `running` rows change, so a row a driver already
     *  settled keeps its own status and timestamp. Returns the number of rows
     *  changed. */
    settleRunningForRun(runId: string, status: SubagentStatus, now: number): number {
      // Counted with RETURNING, not `.changes`: bun's `.changes` also counts the
      // rows migration 093's revision triggers write (task_revs, task_rev_meta).
      return conn.query<{ id: string }, [SubagentStatus, number, string]>(
        `UPDATE subagents SET status = ?, ended_at = ? WHERE run_id = ? AND status = 'running' RETURNING id`,
      ).all(status, now, runId).length;
    },
    /** taskId -> count of `running` rows. One grouped query, for the board poll. */
    runningCountsByTask(): Map<string, number> {
      const rows = conn.query<{ task_id: string; n: number }, []>(
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
      const rows = conn.query<{ task_id: string }, []>(
        `SELECT DISTINCT task_id FROM subagents WHERE status = 'running'`,
      ).all();
      return rows.map((r) => r.task_id);
    },
    /** Tasks with an OpenCode subagent row `orphaned` at or after `sinceMs`
     *  (its `ended_at`, else its start): the boot linger's candidates besides
     *  the running rows. */
    opencodeOrphanedTaskIdsSince(sinceMs: number): string[] {
      // `idx_subagents_opencode_status` (082) carries both terms; pinned so a
      // planner without `sqlite_stat1` can't fall back to a table scan.
      const rows = conn.query<{ task_id: string }, [number]>(
        `SELECT DISTINCT task_id FROM subagents INDEXED BY idx_subagents_opencode_status
        WHERE status = 'orphaned' AND parent_kind = 'opencode_subagent' AND COALESCE(ended_at, started_at) >= ?`,
      ).all(sinceMs);
      return rows.map((r) => r.task_id);
    },
    /** The child session ids of a task's OpenCode subagent rows that are done
     *  with: settled (`completed`/`failed`/`cancelled`), or `orphaned` before
     *  `orphanedBeforeMs` (its `ended_at`, else its start). The driver's relist
     *  skips these. Status-filtered through `idx_subagents_opencode_status`
     *  (082), so a relist doesn't load every subagent row of the task. */
    settledOpencodeChildSessionIds(taskId: string, orphanedBeforeMs: number): string[] {
      const rows = conn.query<{ child: string }, [string, number]>(
        `SELECT substr(source_path, ${OPENCODE_CHILD_SOURCE_PREFIX.length + 1}) AS child
         FROM subagents INDEXED BY idx_subagents_opencode_status
        WHERE status IN ('completed', 'failed', 'cancelled', 'orphaned') AND task_id = ?1
          AND parent_kind = 'opencode_subagent'
          AND substr(source_path, 1, ${OPENCODE_CHILD_SOURCE_PREFIX.length}) = '${OPENCODE_CHILD_SOURCE_PREFIX}'
          AND (status != 'orphaned' OR COALESCE(ended_at, started_at) < ?2)
        ORDER BY started_at ASC, id ASC`,
      ).all(taskId, orphanedBeforeMs);
      return rows.map((r) => r.child).filter((c) => c.length > 0);
    },
  };
  return subagents;
}

export function makeOpencodeStoppedChildren(conn: Database) {
  /**
   * The OpenCode child sessions agetor itself interrupted (migration 082,
   * decision R4). Only `opencode-subagents.ts` reads and writes it. Every
   * statement goes through the primary key or the `stopped_at` index.
   */
  const opencodeStoppedChildren = {
    /** Record (or refresh) the note for a child, and drop notes older than
     *  `pruneBeforeMs` in the same transaction. */
    note(childSessionId: string, taskId: string, at: number, pruneBeforeMs: number): void {
      conn.transaction(() => {
        conn.run(`DELETE FROM opencode_stopped_children WHERE stopped_at < ?`, [pruneBeforeMs]);
        conn.run(
          `INSERT INTO opencode_stopped_children (child_session_id, task_id, stopped_at) VALUES (?, ?, ?)
           ON CONFLICT(child_session_id) DO UPDATE SET task_id = excluded.task_id, stopped_at = excluded.stopped_at`,
          [childSessionId, taskId, at],
        );
      }).immediate();
    },
    /** When agetor last noted this child as stopped (epoch ms), or null. */
    stoppedAt(childSessionId: string): number | null {
      const row = conn.query<{ at: number }, [string]>(
        `SELECT stopped_at AS at FROM opencode_stopped_children WHERE child_session_id = ?`,
      ).get(childSessionId);
      return row ? row.at : null;
    },
  };
  return opencodeStoppedChildren;
}

export function makeOpencodeWatchTombstones(conn: Database) {
  /**
   * The OpenCode sessions watched after their task was deleted, archived or
   * switched to another harness (migration 083): an execution the server starts
   * on one is interrupted. Only `orchestrator-opencode-server.ts` reads and
   * writes it. Bounded: expired rows go on every write, and the table keeps at
   * most `max` rows (the ones expiring last).
   */
  const opencodeWatchTombstones = {
    /** Record (or extend) a tombstone per session until `expiresAt`, dropping expired rows and the overflow in the same transaction. */
    put(
      rows: { sessionId: string; harnessId: string; taskId: string }[],
      expiresAt: number,
      now: number,
      max = 500,
    ): void {
      conn.transaction(() => {
        conn.run(`DELETE FROM opencode_watch_tombstones WHERE expires_at <= ?`, [now]);
        for (const r of rows) {
          conn.run(
            `INSERT INTO opencode_watch_tombstones (session_id, harness_id, task_id, expires_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET harness_id = excluded.harness_id, task_id = excluded.task_id,
               expires_at = MAX(expires_at, excluded.expires_at)`,
            [r.sessionId, r.harnessId, r.taskId, expiresAt],
          );
        }
        // Fewer than `max` rows: the subquery is NULL and nothing goes.
        conn.run(
          `DELETE FROM opencode_watch_tombstones WHERE expires_at < (
           SELECT expires_at FROM opencode_watch_tombstones ORDER BY expires_at DESC LIMIT 1 OFFSET ?)`,
          [Math.max(0, max - 1)],
        );
      }).immediate();
    },
    /** The tombstones still in force at `now`, soonest to expire first (at most `limit`). */
    live(now: number, limit = 500): OpencodeWatchTombstone[] {
      return conn
        .query<OpencodeWatchTombstone, [number, number]>(
          `SELECT session_id AS sessionId, harness_id AS harnessId, task_id AS taskId, expires_at AS expiresAt
           FROM opencode_watch_tombstones WHERE expires_at > ? ORDER BY expires_at ASC LIMIT ?`,
        )
        .all(now, limit);
    },
  };
  return opencodeWatchTombstones;
}

export function makeCursorAsks(conn: Database) {
  /** Insert a pending Cursor question. A second insert for the same task and
   *  tool call does not clobber a row that already exists (resolved or not). */
  function insertCursorAsk(row: {
    taskId: string;
    toolCallId: string;
    runId: string;
    payload: unknown;
    createdAt?: number;
  }): void {
    conn.run(
      `INSERT OR IGNORE INTO cursor_asks (task_id, tool_call_id, run_id, payload_json, outcome, created_at, resolved_at)
     VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
      [row.taskId, row.toolCallId, row.runId, JSON.stringify(row.payload), row.createdAt ?? Date.now()],
    );
  }

  /** Mark one question resolved. A row that already has an outcome is left
   *  alone, so a late cancel cannot overwrite an answer. */
  function resolveCursorAsk(taskId: string, toolCallId: string, outcome: CursorAskOutcome): void {
    conn.run(
      `UPDATE cursor_asks SET outcome = ?, resolved_at = ? WHERE task_id = ? AND tool_call_id = ? AND outcome IS NULL`,
      [outcome, Date.now(), taskId, toolCallId],
    );
  }

  /** Unanswered questions, oldest first. Boot rebuild reads this instead of
   *  scanning `run_events`. */
  function listOpenCursorAsks(): StoredCursorAsk[] {
    const rows = conn.query<CursorAskSqlRow, []>(
      `SELECT task_id, tool_call_id, run_id, payload_json, outcome, created_at, resolved_at
     FROM cursor_asks WHERE outcome IS NULL ORDER BY created_at ASC, tool_call_id ASC`,
    ).all();
    return rows.map(toStoredCursorAsk);
  }
  return { insertCursorAsk, resolveCursorAsk, listOpenCursorAsks };
}

import type { Task, TaskListArchived } from "../../../shared/types.ts";
import { NO_TASK_DECORATIONS, TASKS_SELECT, toTaskRow } from "../tasks.ts";
import type { TaskRow } from "../task-parsers.ts";
import { defineOp } from "./define.ts";

// `tasks.changedSince`: the read behind `GET /tasks?delta=1`
// (docs/plans/non-blocking-core.md, T12; docs/architecture/core-responsiveness.md
// "Delta and push"). It answers "what changed since this cursor" from the
// revision log migration 093's triggers maintain, in ONE deferred read
// transaction, so the rev it reports and the rows it returns are one snapshot:
// a write landing after the snapshot is simply in the NEXT call's range
// (`rev > since`), never skipped.

/** The revision-log range scan. Planned as `SEARCH task_revs USING INDEX
 *  idx_task_revs_rev (rev>? AND rev<?)`: pinned by `task-list-delta.test.ts`. */
export const CHANGED_SINCE_SQL =
  `SELECT task_id, deleted FROM task_revs WHERE rev > ? AND rev <= ?`;

/** Running-subagent counts for a set of tasks (the `runningSubagents` decoration). */
const RUNNING_COUNTS_SQL =
  `SELECT task_id, COUNT(*) AS n FROM subagents WHERE status = 'running' AND task_id IN `;

/** Ids per `IN (...)` statement: well under SQLite's variable limit even with `keep`. */
const ID_CHUNK = 400;

export interface ChangedSinceCursor {
  /** `task_rev_meta.epoch` of the database the cursor was minted against. */
  epoch: string;
  rev: number;
}

export interface ChangedSinceResult {
  epoch: string;
  /** The `task_rev_meta.rev` this answer is consistent with: the next cursor. */
  rev: number;
  /** True when the answer is every row that passes the filter (no cursor, or a
   *  cursor from another epoch). `removedIds` is then empty. */
  snapshot: boolean;
  /** Changed rows that pass the filter. Badge counts are zero here (the worker
   *  has no registries); the main thread overlays them. */
  tasks: Task[];
  /** Changed rows that are deleted, or no longer pass the filter. */
  removedIds: string[];
  /** `runningSubagents` for each returned task that has any (absent = 0). */
  running: Record<string, number>;
}

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export const deltaOps = {
  "tasks.changedSince": defineOp({
    tx: false,
    run: (
      { conn, modules },
      since: ChangedSinceCursor | null,
      archived: TaskListArchived,
      keepIds: readonly string[],
    ): ChangedSinceResult => {
      const read = conn.transaction((): ChangedSinceResult => {
        const meta = conn
          .query<{ epoch: string; rev: number }, []>(`SELECT epoch, rev FROM task_rev_meta WHERE id = 1`)
          .get();
        if (!meta) throw new Error("task_rev_meta is missing (migration 093)");
        const running = (ids: readonly string[] | null): Record<string, number> => {
          const out: Record<string, number> = {};
          if (ids === null) {
            for (const r of conn
              .query<{ task_id: string; n: number }, []>(
                `SELECT task_id, COUNT(*) AS n FROM subagents WHERE status = 'running' GROUP BY task_id`,
              )
              .all()) out[r.task_id] = r.n;
            return out;
          }
          for (const part of chunks(ids, ID_CHUNK)) {
            for (const r of conn
              .query<{ task_id: string; n: number }, string[]>(
                `${RUNNING_COUNTS_SQL}(${part.map(() => "?").join(", ")}) GROUP BY task_id`,
              )
              .all(...part)) out[r.task_id] = r.n;
          }
          return out;
        };

        if (!since || since.epoch !== meta.epoch || !(since.rev <= meta.rev)) {
          const all = modules.tasks.list({ archived, keepIds });
          return {
            epoch: meta.epoch,
            rev: meta.rev,
            snapshot: true,
            tasks: all,
            removedIds: [],
            running: running(null),
          };
        }

        const changed = conn
          .query<{ task_id: string; deleted: number }, [number, number]>(CHANGED_SINCE_SQL)
          .all(since.rev, meta.rev);
        const removed = new Set<string>();
        const live: string[] = [];
        for (const c of changed) {
          if (c.deleted) removed.add(c.task_id);
          else live.push(c.task_id);
        }
        const state =
          archived === "exclude" ? "tasks.archived_at IS NULL"
          : archived === "only" ? "tasks.archived_at IS NOT NULL"
          : null;
        const keep = state && keepIds.length > 0 ? keepIds : [];
        const filter = state
          ? keep.length > 0
            ? ` AND (${state} OR tasks.id IN (${keep.map(() => "?").join(", ")}))`
            : ` AND ${state}`
          : "";
        const rows: TaskRow[] = [];
        for (const part of chunks(live, ID_CHUNK)) {
          rows.push(
            ...conn
              .query<TaskRow, string[]>(
                `${TASKS_SELECT} WHERE tasks.id IN (${part.map(() => "?").join(", ")})${filter} GROUP BY tasks.id`,
              )
              .all(...part, ...keep),
          );
        }
        const returned = new Set(rows.map((r) => r.id));
        for (const id of live) if (!returned.has(id)) removed.add(id);
        const tasks = rows.map((r) => toTaskRow(r, undefined, NO_TASK_DECORATIONS));
        return {
          epoch: meta.epoch,
          rev: meta.rev,
          snapshot: false,
          tasks,
          removedIds: [...removed],
          running: running(tasks.map((t) => t.id)),
        };
      });
      return read();
    },
  }),

  /** The database's epoch and current rev: the push emitter caches the epoch at
   *  boot and takes the rev from the worker reply piggyback. */
  "tasks.deltaMeta": defineOp({
    tx: false,
    run: ({ conn }): { epoch: string; rev: number } => {
      const meta = conn
        .query<{ epoch: string; rev: number }, []>(`SELECT epoch, rev FROM task_rev_meta WHERE id = 1`)
        .get();
      if (!meta) throw new Error("task_rev_meta is missing (migration 093)");
      return meta;
    },
  }),
};

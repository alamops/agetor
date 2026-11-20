import { statSync } from "node:fs";
import { defineOp, type OpCtx } from "./define.ts";

// Archived-history retention and Compact (`src/bun/retention.ts`,
// docs/architecture/persistence.md). The pass itself stays a cooperative job on
// the main thread (paging, trimming, yielding between slices); what touches the
// connection beyond a single db-core method runs here, inside the worker.

/** One rewritten `run_events` row: its id and the trimmed payload. */
export interface RetentionRewrite {
  id: number;
  data: string;
}

/** The database file sizes and page counts behind `GET /db/stats`. */
export interface RetentionDbFileStats {
  fileBytes: number;
  walBytes: number;
  pageSize: number;
  pageCount: number;
  freelistCount: number;
}

/** True while `taskId` still exists and is archived at or before `cutoff`.
 *  A single-column read (not `tasks.get`, which also folds pipeline step
 *  aggregates): it runs once per written chunk. */
function stillEligible({ conn }: OpCtx, taskId: string, cutoff: number): boolean {
  const row = conn
    .query<{ archived_at: number | null }, [string]>(`SELECT archived_at FROM tasks WHERE id = ?`)
    .get(taskId);
  return row !== null && row.archived_at !== null && row.archived_at <= cutoff;
}

function fileBytes(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/** Sizes of the connection's own database file and its WAL. `conn.filename`
 *  is the path the connection opened, so this reads the right file whichever
 *  data dir (or test database) the worker serves. */
function dbFileBytes({ conn }: OpCtx): { fileBytes: number; walBytes: number } {
  const main = conn.filename;
  return { fileBytes: fileBytes(main), walBytes: fileBytes(`${main}-wal`) };
}

function pragmaNumber({ conn }: OpCtx, name: "page_size" | "page_count" | "freelist_count"): number {
  const row = conn.query<Record<string, number>, []>(`PRAGMA ${name}`).get();
  const v = row ? Object.values(row)[0] : 0;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export const retentionOps = {
  /** `stillEligible` on its own: the pre-cleanup check and the empty-chunk
   *  flush of `runArchivedHistoryRetentionPass`. */
  "retention.stillEligible": defineOp({
    tx: false,
    run: (ctx, taskId: string, cutoff: number): boolean => stillEligible(ctx, taskId, cutoff),
  }),

  /** What a task's sweep key is built from: its run ids (oldest first, as
   *  `runs.runIdsForTask` orders them) and the newest event id across them.
   *  One hop per candidate instead of one per run. */
  "retention.taskSweepInputs": defineOp({
    tx: false,
    run: ({ modules }, taskId: string): { runIds: string[]; maxEventId: number } => {
      const runIds = modules.runs.runIdsForTask(taskId);
      let maxEventId = 0;
      for (const runId of runIds) maxEventId = Math.max(maxEventId, modules.runs.maxEventIdForRun(runId));
      return { runIds, maxEventId };
    },
  }),

  /** Write one chunk of trimmed rows, but only while the task is still
   *  archived at or before `cutoff`, checked inside the same transaction (the
   *  pass yields between chunks, so the user can unarchive the task in
   *  between). Returns false, writing nothing, when it no longer is. */
  "retention.writeChunk": defineOp({
    tx: true,
    run: (ctx, taskId: string, cutoff: number, batch: RetentionRewrite[]): boolean => {
      if (!stillEligible(ctx, taskId, cutoff)) return false;
      for (const r of batch) ctx.modules.runs.replaceEventData(r.id, r.data);
      return true;
    },
  }),

  /** File sizes and page counts for `dbStats`. */
  "retention.fileStats": defineOp({
    tx: false,
    run: (ctx): RetentionDbFileStats => ({
      ...dbFileBytes(ctx),
      pageSize: pragmaNumber(ctx, "page_size"),
      pageCount: pragmaNumber(ctx, "page_count"),
      freelistCount: pragmaNumber(ctx, "freelist_count"),
    }),
  }),

  /** `VACUUM` the database, then truncate the WAL. Not a transaction: VACUUM
   *  cannot run inside one. Runs whole on the worker, so every other database
   *  call waits behind it for its full duration. */
  "retention.compact": defineOp({
    tx: false,
    run: (ctx): { beforeBytes: number; afterBytes: number; durationMs: number } => {
      const before = dbFileBytes(ctx);
      const startedAt = performance.now();
      ctx.conn.exec("VACUUM");
      ctx.conn.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
      const durationMs = Math.round(performance.now() - startedAt);
      const after = dbFileBytes(ctx);
      return {
        beforeBytes: before.fileBytes + before.walBytes,
        afterBytes: after.fileBytes + after.walBytes,
        durationMs,
      };
    },
  }),
};

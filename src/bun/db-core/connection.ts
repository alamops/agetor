import type { Database } from "bun:sqlite";

/** The pragmas every Agetor SQLite connection runs with. Shared by `db.ts`
 *  (the test / in-process connection) and the worker's connection so the two
 *  cannot drift. */
export function applyConnectionPragmas(conn: Database, busyTimeoutMs = 5000): void {
  conn.exec("PRAGMA journal_mode = WAL;");
  // WAL + NORMAL is SQLite's documented sweet spot for a local single-writer
  // app. WAL already makes every transaction atomic and the database consistent
  // across an app crash AND a power loss; NORMAL merely stops forcing an fsync
  // at every commit (FULL — the default — does). That fsync was being paid on
  // every streamed `run_events` row and every unread-watermark bump: dozens of
  // disk flushes a minute while an agent works, buying durability for the last
  // few milliseconds of a log that is re-derivable from the agent's own JSONL.
  // A battery/CPU win with no correctness cost — the only thing NORMAL gives
  // up is that a kernel panic mid-stream may roll back the final commit(s).
  conn.exec("PRAGMA synchronous = NORMAL;");
  conn.exec("PRAGMA foreign_keys = ON;");
  // 64 MB page cache (negative = KiB) and a 256 MB memory map: the board's
  // projection and the run-events reads stay in memory instead of re-reading
  // pages (docs/plans/non-blocking-core.md, T8).
  conn.exec("PRAGMA cache_size = -65536;");
  conn.exec("PRAGMA mmap_size = 268435456;");
  // The worker's connection owns this file in production, so a writer never
  // contends with another Agetor connection. The wait covers the rare external
  // one: the `sqlite3` CLI, a backup, or Compact's `wal_checkpoint(TRUNCATE)`
  // waiting on a reader. It runs on the worker thread, so waiting never blocks
  // the event loop. The `db.ts` singleton (tests, and the `AGETOR_DB_MODE=inprocess`
  // kill switch, which IS honored in production, docs/plans/non-blocking-core.md
  // section 5) runs on the main thread, where a long wait would freeze the event
  // loop: outside tests it asks for SHORT_BUSY_TIMEOUT_MS after its migrations ran.
  conn.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
}

/** The wait the main-thread connection (kill-switch mode) uses once migrated. */
export const SHORT_BUSY_TIMEOUT_MS = 100;

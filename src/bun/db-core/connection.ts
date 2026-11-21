import type { Database } from "bun:sqlite";

/** The pragmas every Agetor SQLite connection runs with. Shared by `db.ts`
 *  (the test / in-process connection) and the worker's connection so the two
 *  cannot drift. */
/** SQLite page cache for every Agetor connection, in KiB (64 MiB). */
export const SQLITE_CACHE_KIB = 65_536;
/** Most of the database file SQLite reads through a memory map (256 MiB). */
export const DB_MMAP_SIZE_BYTES = 256 * 1024 * 1024;

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
  // 64 MiB page cache (negative = KiB) instead of SQLite's 2 MiB default, and a
  // 256 MiB memory map: the board's projection and the run-events reads stay in
  // memory instead of re-reading pages (docs/architecture/persistence.md). The
  // map serves reads from the OS file cache without the extra copy into
  // SQLite's buffers (macOS reclaims those pages under memory pressure); the
  // trade-off is that a disk read error surfaces as SIGBUS rather than
  // SQLITE_IOERR. `temp_store = MEMORY` keeps GROUP BY / ORDER BY scratch
  // b-trees off disk; changing it drops every TEMP object already on the
  // connection, so it runs here, before anything else touches the connection.
  conn.exec(`PRAGMA cache_size = ${-SQLITE_CACHE_KIB};`);
  conn.exec(`PRAGMA mmap_size = ${DB_MMAP_SIZE_BYTES};`);
  conn.exec("PRAGMA temp_store = MEMORY;");
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

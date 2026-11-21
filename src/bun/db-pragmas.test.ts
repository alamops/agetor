// The core's single SQLite connection is opened with its read-side tuning
// (docs/architecture/persistence.md): a larger page cache, a memory map, and
// in-memory temp storage, on top of WAL + NORMAL + foreign keys.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

// Top-level: db.ts opens on first import, and the first import in the process
// wins (another file may have opened it already; the settings are the same).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-db-pragmas-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

afterAll(() => rmTestDataDir(DATA_DIR));

const pragma = async (name: string): Promise<unknown> => {
  const { db } = await import("./db.ts");
  const row = db.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get();
  return row ? Object.values(row)[0] : undefined;
};

test("the connection uses a 64 MiB page cache", async () => {
  const { SQLITE_CACHE_KIB } = await import("./db-core/connection.ts");
  expect(SQLITE_CACHE_KIB).toBe(65536);
  expect(await pragma("cache_size")).toBe(-SQLITE_CACHE_KIB);
});

test("the connection memory-maps up to 256 MiB of the file", async () => {
  const { DB_MMAP_SIZE_BYTES } = await import("./db-core/connection.ts");
  expect(DB_MMAP_SIZE_BYTES).toBe(256 * 1024 * 1024);
  expect(await pragma("mmap_size")).toBe(DB_MMAP_SIZE_BYTES);
});

test("temp b-trees stay in memory", async () => {
  // 2 = MEMORY.
  expect(await pragma("temp_store")).toBe(2);
});

test("the durability settings are unchanged", async () => {
  expect(await pragma("journal_mode")).toBe("wal");
  // 1 = NORMAL.
  expect(await pragma("synchronous")).toBe(1);
  expect(await pragma("foreign_keys")).toBe(1);
});

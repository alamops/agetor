/**
 * Two-connection behaviour of db-core's write transactions (docs/plans/
 * non-blocking-core.md section 3, the transitional two-writer state): every
 * write transaction begins IMMEDIATE, and the orphan-copy stamp is derived from
 * the table inside that transaction. Both connections are on one temp WAL file;
 * nothing here imports db.ts, so no data-dir singleton is involved.
 */
import { test, expect, afterAll, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { applyConnectionPragmas } from "./db-core/connection.ts";
import { makeHarnessStore } from "./db-core/harnesses.ts";
import { defineOp, runOp } from "./db-core/ops/index.ts";
import type { OpCtx } from "./db-core/ops/index.ts";

const dir = mkdtempSync(path.join(tmpdir(), "agetor-db-core-tx-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function openPair(name: string): [Database, Database] {
  const file = path.join(dir, `${name}.sqlite`);
  const a = new Database(file);
  applyConnectionPragmas(a);
  migrate(a, migrations);
  const b = new Database(file);
  applyConnectionPragmas(b);
  // The other writer fails at once instead of waiting, so a lock held by `a`
  // shows up as an error rather than a 5 s stall.
  b.exec("PRAGMA busy_timeout = 0;");
  return [a, b];
}

function isBusy(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return /SQLITE_BUSY|database is locked/i.test(String((e as { code?: string }).code ?? "") + String(e));
  }
}

describe("write transactions begin IMMEDIATE", () => {
  test("runOp: a read-then-write op holds the write lock from its first read, so it cannot go stale", () => {
    const [a, b] = openPair("runop");
    a.run(`INSERT INTO preferences (key, value, updated_at) VALUES ('k', '1', 0)`);
    const bBusy: boolean[] = [];
    const op = defineOp({
      tx: true,
      run: ({ conn }: OpCtx): number => {
        const v = Number(conn.query<{ value: string }, []>(`SELECT value FROM preferences WHERE key = 'k'`).get()!.value);
        // Another connection tries to commit between the read and the write.
        bBusy.push(isBusy(() => b.run(`UPDATE preferences SET value = '100' WHERE key = 'k'`)));
        conn.run(`UPDATE preferences SET value = ? WHERE key = 'k'`, [String(v + 1)]);
        return v + 1;
      },
    });
    expect(runOp(op as never, { conn: a, modules: {} as never }, [])).toBe(2);
    expect(bBusy).toEqual([true]);
    expect(a.query<{ value: string }, []>(`SELECT value FROM preferences WHERE key = 'k'`).get()!.value).toBe("2");
    a.close();
    b.close();
  });

  test("red proof: the same sequence in a deferred transaction fails with SQLITE_BUSY_SNAPSHOT", () => {
    const [a, b] = openPair("deferred");
    a.run(`INSERT INTO preferences (key, value, updated_at) VALUES ('k', '1', 0)`);
    const deferred = a.transaction(() => {
      a.query(`SELECT value FROM preferences WHERE key = 'k'`).get();
      b.run(`UPDATE preferences SET value = '100' WHERE key = 'k'`); // commits mid-transaction
      a.run(`UPDATE preferences SET value = '2' WHERE key = 'k'`); // upgrade on a stale snapshot
    });
    expect(() => deferred()).toThrow(/SQLITE_BUSY|database is locked/i);
    a.close();
    b.close();
  });

  test("a db-core factory write transaction takes the write lock before its first read", () => {
    const [a, b] = openPair("factory");
    const seen: boolean[] = [];
    // Observe the stamp read inside harnessOrphanedCopies.add: while it runs,
    // the other connection must already be locked out.
    const spy = new Proxy(a, {
      get(target, prop) {
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        if (typeof v !== "function") return v;
        if (prop === "query") {
          return (sql: string) => {
            if (/SELECT MAX\(created_at\) AS m FROM harness_orphaned_copies/.test(sql)) {
              seen.push(isBusy(() => b.run(`INSERT INTO preferences (key, value, updated_at) VALUES ('probe', 'x', 0)`)));
            }
            return target.query(sql);
          };
        }
        return v.bind(target);
      },
    }) as Database;
    makeHarnessStore(spy).harnessOrphanedCopies.add("h", "claude_session_id", "s", ["/p"]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
    a.close();
    b.close();
  });
});

describe("orphan stamps across two connections", () => {
  const stamps = (c: Database) =>
    c.query<{ path: string; created_at: number }, []>(`SELECT path, created_at FROM harness_orphaned_copies ORDER BY path`).all();

  test("a connection whose own stamp is behind still stamps above the other's mark", () => {
    const [a, b] = openPair("stamps-behind");
    b.exec("PRAGMA busy_timeout = 5000;");
    const storeA = makeHarnessStore(a);
    const storeB = makeHarnessStore(b);
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      storeB.harnessOrphanedCopies.add("h", "claude_session_id", "s0", ["/b0"]); // B remembers stamp T
      storeA.harnessOrphanedCopies.add("h", "claude_session_id", "s1", ["/a1"]); // A stamps T + 1
      const mark = storeA.harnessOrphanedCopies.sweepMark();
      // B's remembered stamp is behind the table; a per-instance counter would repeat `mark` here.
      storeB.harnessOrphanedCopies.add("h", "claude_session_id", "s2", ["/new"]);
      storeA.harnessOrphanedCopies.forget("h", "claude_session_id", "s2", ["/new"], { notAfter: mark });
      expect(stamps(a).map((r) => r.path)).toContain("/new");
    } finally {
      Date.now = realNow;
    }
    a.close();
    b.close();
  });

  test("a sweep mark on one connection is below a record the other stamps in the same millisecond", () => {
    const [a, b] = openPair("stamps");
    b.exec("PRAGMA busy_timeout = 5000;");
    const storeA = makeHarnessStore(a);
    const storeB = makeHarnessStore(b);
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000; // freeze the clock: every stamp lands in one millisecond
    try {
      storeA.harnessOrphanedCopies.add("h", "claude_session_id", "s1", ["/old"]);
      const mark = storeA.harnessOrphanedCopies.sweepMark();
      // A different connection records a newer copy while A's sweep is running.
      storeB.harnessOrphanedCopies.add("h", "claude_session_id", "s2", ["/new"]);
      const rows = Object.fromEntries(stamps(a).map((r) => [r.path, r.created_at]));
      expect(rows["/old"]!).toBeLessThanOrEqual(mark);
      expect(rows["/new"]!).toBeGreaterThan(mark);
      storeA.harnessOrphanedCopies.forget("h", "claude_session_id", "s2", ["/new"], { notAfter: mark });
      expect(stamps(a).map((r) => r.path)).toContain("/new");
      // Two writers adding in turn never repeat a stamp.
      storeA.harnessOrphanedCopies.add("h", "claude_session_id", "s3", ["/a"]);
      storeB.harnessOrphanedCopies.add("h", "claude_session_id", "s4", ["/b"]);
      const all = stamps(a).map((r) => r.created_at);
      expect(new Set(all).size).toBe(all.length);
    } finally {
      Date.now = realNow;
    }
    a.close();
    b.close();
  });
});

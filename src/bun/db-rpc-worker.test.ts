/**
 * db-rpc against a REAL worker thread (docs/plans/non-blocking-core.md, T8, X4).
 * The worker opens its own temp database file, never the db.ts singleton, so
 * this file imports neither db.ts nor anything that opens a connection on the
 * main thread. AGETOR_DB_MODE is forced to `worker` while the tests run and
 * restored afterwards.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { makeRun, makeTask } from "./db-rpc-test-util.ts";
import { createCoreWorker } from "./worker-entry.ts";

// Set before db-path.ts (imported by db-rpc.ts) reads it: it would otherwise
// auto-allocate a data dir and warn. db-path freezes this directory for the whole
// `bun test` process, so a later file's db.ts opens its sqlite file here: this
// file must never delete it.
const dataDir = process.env.AGETOR_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), "agetor-db-rpc-worker-data-"));
process.env.AGETOR_DATA_DIR = dataDir;

const savedEnv = {
  AGETOR_DB_MODE: process.env.AGETOR_DB_MODE,
  AGETOR_CORE_WORKER_ENTRY: process.env.AGETOR_CORE_WORKER_ENTRY,
};
process.env.AGETOR_DB_MODE = "worker";
process.env.AGETOR_CORE_WORKER_ENTRY = path.join(import.meta.dir, "core-worker.ts");

type RpcModule = typeof import("./db-rpc.ts");
type CoreWorkerLike = import("./worker-entry.ts").CoreWorkerLike;
let rpcm: RpcModule;
const tmpDirs: string[] = [];
const clients: Array<ReturnType<RpcModule["createDbRpc"]>> = [];

function freshDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-db-rpc-worker-"));
  tmpDirs.push(dir);
  return path.join(dir, "agetor.sqlite");
}

/** A client over its own database file, with every worker it starts recorded. */
function newClient(opts: Partial<Parameters<RpcModule["createDbRpc"]>[0]> = {}) {
  const workers: CoreWorkerLike[] = [];
  const dbPath = opts.dbPath ?? freshDbPath();
  const factory = opts.workerFactory;
  const rpc = rpcm.createDbRpc({
    mode: "worker",
    dbPath,
    ...opts,
    workerFactory: (p) => {
      const w = factory ? factory(p) : createCoreWorker("db", { dbPath: p });
      workers.push(w);
      return w;
    },
  });
  clients.push(rpc);
  return { rpc, workers, dbPath };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  rpcm = await import("./db-rpc.ts");
});

afterAll(async () => {
  for (const c of clients) await c.closeDb({ timeoutMs: 1000 }).catch(() => {});
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("worker lifecycle", () => {
  test("opens, migrates (093 applied) and reports ready", async () => {
    const { rpc, dbPath } = newClient();
    await rpc.dbReady();
    const check = new Database(dbPath, { readonly: true });
    try {
      const ids = check.query<{ id: string }, []>(`SELECT id FROM _migrations`).all().map((r) => r.id);
      expect(ids.some((id) => id.startsWith("093"))).toBe(true);
      expect(check.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM task_rev_meta`).get()!.n).toBe(1);
    } finally {
      check.close();
    }
  });

  test("the connection carries the shared pragmas", async () => {
    const { rpc, dbPath } = newClient();
    await rpc.dbReady();
    // WAL is persistent in the file; the others are per-connection, so they are
    // proven in db-core/connection through a fresh handler connection.
    const { openWorkerDb } = await import("./workers/db-handler.ts");
    const wdb = openWorkerDb(dbPath);
    try {
      const pragma = (name: string) => Object.values(wdb.conn.query<Record<string, number | string>, []>(`PRAGMA ${name}`).get()!)[0];
      expect(pragma("journal_mode")).toBe("wal");
      expect(pragma("synchronous")).toBe(1);
      expect(pragma("foreign_keys")).toBe(1);
      expect(pragma("cache_size")).toBe(-65536);
      expect(pragma("busy_timeout")).toBe(5000);
      expect(Number(pragma("mmap_size"))).toBeGreaterThan(0);
    } finally {
      wdb.close();
    }
  });

  test("a call made before ready waits for the worker and resolves", async () => {
    const { rpc } = newClient();
    // No dbReady(): the first call starts the worker and queues behind it.
    const first = rpc.call("tasks", "list", []);
    const second = rpc.call("preferences", "get", ["nope"]);
    expect(await first).toEqual([]);
    expect(await second).toBeNull();
  });

  test("a worker that cannot open the database rejects the call and the next call retries", async () => {
    // A directory is not a database file.
    const dir = mkdtempSync(path.join(tmpdir(), "agetor-db-rpc-bad-"));
    tmpDirs.push(dir);
    const { rpc } = newClient({ dbPath: dir });
    await expect(rpc.call("tasks", "list", [])).rejects.toBeInstanceOf(rpcm.DbUnavailableError);
    await expect(rpc.dbReady()).rejects.toBeInstanceOf(rpcm.DbUnavailableError);
  });

  test("a worker that never reports ready is cut off by the ready timeout", async () => {
    const silent = (): CoreWorkerLike => ({
      postMessage() {},
      terminate() {},
      addEventListener() {},
    });
    const { rpc } = newClient({ workerFactory: silent, readyTimeoutMs: 50 });
    await expect(rpc.call("tasks", "list", [])).rejects.toThrow("not ready within 50 ms");
  });
});

describe("ordering and consistency", () => {
  test("insert then get is consistent, and an error keeps its class", async () => {
    const { rpc } = newClient();
    const t = makeTask();
    await rpc.call("tasks", "insert", [t]);
    const got = (await rpc.call("tasks", "get", [t.id])) as { id: string; title: string } | null;
    expect(got?.id).toBe(t.id);
    expect(got?.title).toBe("db-rpc");
    expect(await rpc.call("tasks", "get", [randomUUID()])).toBeNull();
    // A throw inside a db-core method crosses the thread as its real class.
    const { HarnessBuiltinError } = await import("./db-core/errors.ts");
    const harnesses = (await rpc.call("harnesses", "list", [])) as Array<{ id: string; isBuiltin: boolean }>;
    const builtin = harnesses.find((h) => h.isBuiltin)!;
    await expect(rpc.call("harnesses", "assertDeletable", [builtin.id])).rejects.toBeInstanceOf(HarnessBuiltinError);
  });

  test("a Set result survives the thread hop", async () => {
    const { rpc } = newClient();
    expect(await rpc.call("hiddenSessionIds", "hiddenClaudeSessionIds", [])).toBeInstanceOf(Set);
  });

  test("a tx op rolls back inside the worker", async () => {
    const { rpc } = newClient();
    const k = `k-${randomUUID()}`;
    await expect(rpc.op("__test.setPreferences", [[[k, "a"], [`${k}2`, "b"]], 1])).rejects.toThrow("forced failure");
    expect(await rpc.call("preferences", "get", [k])).toBeNull();
    expect(await rpc.op("__test.setPreferences", [[[k, "a"]], null])).toBe(1);
    expect(await rpc.call("preferences", "get", [k])).toBe("a");
  });

  test("2,000 sequential appendEvent calls resolve in id order", async () => {
    const { rpc } = newClient();
    const t = makeTask();
    await rpc.call("tasks", "insert", [t]);
    const run = makeRun(t.id);
    await rpc.call("runs", "insert", [run]);
    // Fired without awaiting each one: the replies must still come back in order.
    const replies: Array<Promise<unknown>> = [];
    const order: number[] = [];
    for (let i = 0; i < 2000; i++) {
      replies.push(rpc.call("runs", "appendEvent", [run.id, "stdout", `line ${i}`]).then((r) => {
        order.push(i);
        return r;
      }));
    }
    const results = (await Promise.all(replies)) as Array<{ id: number }>;
    expect(order).toEqual(Array.from({ length: 2000 }, (_, i) => i));
    for (let i = 1; i < results.length; i++) expect(results[i]!.id).toBeGreaterThan(results[i - 1]!.id);
    const events = (await rpc.call("runs", "events", [run.id])) as Array<{ data: string }>;
    expect(events.map((e) => e.data)).toEqual(Array.from({ length: 2000 }, (_, i) => `line ${i}`));
  }, 60_000);

  test("onRevChanged fires on a worker write and not on a read", async () => {
    const { rpc } = newClient();
    await rpc.call("tasks", "list", []);
    const seen: number[] = [];
    rpc.onRevChanged((r) => seen.push(r));
    await rpc.call("tasks", "list", []);
    expect(seen).toEqual([]);
    await rpc.call("tasks", "insert", [makeTask()]);
    expect(seen.length).toBe(1);
    expect(rpc.currentRev()).toBe(seen[0]!);
  });
});

describe("main thread stays responsive", () => {
  test("a heavy read runs while a 5 ms timer keeps ticking (max gap < 100 ms)", async () => {
    const { rpc } = newClient();
    const t = makeTask();
    await rpc.call("tasks", "insert", [t]);
    const run = makeRun(t.id);
    await rpc.call("runs", "insert", [run]);
    // ~50 MB of events: 50 rows of 1 MB, posted from the main thread.
    const chunk = "x".repeat(1024 * 1024);
    for (let i = 0; i < 50; i++) await rpc.call("runs", "appendEvent", [run.id, "stdout", `${i}:${chunk}`]);

    let last = performance.now();
    let maxGap = 0;
    let ticks = 0;
    const timer = setInterval(() => {
      const nowMs = performance.now();
      maxGap = Math.max(maxGap, nowMs - last);
      last = nowMs;
      ticks++;
    }, 5);
    try {
      // The worker scans and sizes all 50 MB (the byte walk), returning a bounded window.
      const t0 = performance.now();
      const window = (await rpc.call("runs", "eventsForTask", [t.id, { limit: 1000, maxBytes: 2 * 1024 * 1024 }])) as unknown[];
      const heavyMs = performance.now() - t0;
      // And a second heavy read, the full 50 MB table scan inside the worker.
      const t1 = performance.now();
      const all = (await rpc.call("runs", "events", [run.id])) as Array<{ data: string }>;
      const fullMs = performance.now() - t1;
      expect(window.length).toBeGreaterThan(0);
      expect(all.length).toBe(50);
      console.info(`[db-rpc-worker.test] heavy windowed read ${heavyMs.toFixed(0)} ms, full 50 MB read ${fullMs.toFixed(0)} ms, ${ticks} ticks, max main-thread gap ${maxGap.toFixed(1)} ms`);
      expect(ticks).toBeGreaterThan(5);
      expect(maxGap).toBeLessThan(100);
    } finally {
      clearInterval(timer);
    }
  }, 120_000);
});

describe("crash and restart", () => {
  test("a crash rejects in-flight calls with DbRestartingError and the next call succeeds", async () => {
    const { rpc, workers } = newClient();
    await rpc.dbReady();
    const t = makeTask();
    await rpc.call("tasks", "insert", [t]);
    // Queue a crash and a call behind it: the crash kills the worker before the call is answered.
    workers[0]!.postMessage({ kind: "__crash" });
    const inflight = rpc.call("tasks", "get", [t.id]);
    await expect(inflight).rejects.toBeInstanceOf(rpcm.DbRestartingError);
    // The worker restarted on its own; the data (on disk) is still there.
    const got = (await rpc.call("tasks", "get", [t.id])) as { id: string } | null;
    expect(got?.id).toBe(t.id);
    expect(workers.length).toBe(2);
  });

  test("calls queued during the restart run on the new worker", async () => {
    const { rpc, workers } = newClient();
    await rpc.dbReady();
    workers[0]!.postMessage({ kind: "__crash" });
    await sleep(100); // the crash has landed; the restart is underway
    expect(await rpc.call("preferences", "get", ["nope"])).toBeNull();
    expect(workers.length).toBe(2);
  });

  test("restarts are capped per window, then calls reject until the window passes", async () => {
    let clock = 1_000_000;
    const { rpc, workers } = newClient({ maxRestartsPerWindow: 2, restartWindowMs: 10_000, now: () => clock });
    await rpc.dbReady();
    const crashAndWait = async (n: number) => {
      workers[n]!.postMessage({ kind: "__crash" });
      await sleep(150);
    };
    await crashAndWait(0); // restart 1
    await rpc.dbReady();
    await crashAndWait(1); // restart 2
    await rpc.dbReady();
    expect(workers.length).toBe(3);
    await crashAndWait(2); // third failure in the window: no restart
    expect(workers.length).toBe(3);
    await expect(rpc.call("tasks", "list", [])).rejects.toBeInstanceOf(rpcm.DbUnavailableError);
    await expect(rpc.dbReady()).rejects.toThrow("restarted too often");
    clock += 10_001; // the window has passed
    expect(await rpc.call("tasks", "list", [])).toEqual([]);
    expect(workers.length).toBe(4);
  });
});

describe("close", () => {
  test("closeDb drains in-flight calls, then terminates the worker", async () => {
    const { rpc, workers } = newClient();
    await rpc.dbReady();
    const pendingCalls = Array.from({ length: 200 }, (_, i) => rpc.call("preferences", "get", [`k${i}`]));
    const closing = rpc.closeDb({ timeoutMs: 5000 });
    // New calls are refused as soon as close begins.
    await expect(rpc.call("tasks", "list", [])).rejects.toBeInstanceOf(rpcm.DbUnavailableError);
    await closing;
    expect(await Promise.all(pendingCalls)).toEqual(Array.from({ length: 200 }, () => null));
    // Terminated: the worker no longer answers.
    let answered = false;
    workers[0]!.addEventListener("message", () => { answered = true; });
    try { workers[0]!.postMessage({ id: 1, kind: "call", module: "tasks", method: "list", args: [] }); } catch { /* terminated */ }
    await sleep(100);
    expect(answered).toBe(false);
    await expect(rpc.call("tasks", "list", [])).rejects.toBeInstanceOf(rpcm.DbUnavailableError);
  });

  test("closeDb past its timeout rejects what is still waiting", async () => {
    const silent = (): CoreWorkerLike => ({
      postMessage() {},
      terminate() {},
      addEventListener() {},
    });
    const { rpc } = newClient({ workerFactory: silent, readyTimeoutMs: 60_000 });
    const stuck = rpc.call("tasks", "list", []);
    // Observe the rejection without `expect(...).rejects`, which waits for the
    // promise synchronously and would block the timer that settles it.
    const outcome = stuck.then(() => null, (e: unknown) => e);
    await rpc.closeDb({ timeoutMs: 50 });
    expect(await outcome).toBeInstanceOf(rpcm.DbUnavailableError);
  });
});

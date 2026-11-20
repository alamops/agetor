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
import { BUILD_ID } from "./build-id.ts";
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

/** Poll until `cond` holds, failing after `timeoutMs`. */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** Crash a worker and wait for its close event (the client's own listener, added
 *  first, has already run by then, so the restart decision is made). */
async function crash(w: CoreWorkerLike): Promise<void> {
  const closed = new Promise<void>((resolve) => w.addEventListener("close", () => resolve()));
  w.postMessage({ kind: "__crash" });
  await Promise.race([closed, sleep(10_000).then(() => { throw new Error("timed out waiting for the worker to close"); })]);
}

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
    const { rpc, workers } = newClient({ dbPath: dir });
    const first = await rpc.call("tasks", "list", []).then(() => null, (e: unknown) => e);
    expect(first).toBeInstanceOf(rpcm.DbUnavailableError);
    expect((first as Error).message).toContain("could not open the database");
    expect(workers.length).toBe(1);
    // The failure is not a tight restart loop, but the NEXT call starts a fresh worker.
    const second = await rpc.dbReady().then(() => null, (e: unknown) => e);
    expect(second).toBeInstanceOf(rpcm.DbUnavailableError);
    expect((second as Error).message).toContain("could not open the database");
    expect(workers.length).toBe(2);
  });

  test("a slow migration is not cut off by the ready timeout, and the worker is neither terminated nor restarted", async () => {
    let terminations = 0;
    const { rpc, workers } = newClient({
      readyTimeoutMs: 1000,
      workerFactory: (p) => {
        // The worker stalls 2.5 s after opening and before migrating: longer than the ready timeout.
        const w = createCoreWorker("db", { dbPath: p, testMigrateDelayMs: 2500 });
        const terminate = w.terminate.bind(w);
        w.terminate = () => { terminations++; return terminate(); };
        return w;
      },
    });
    const t0 = performance.now();
    await rpc.dbReady();
    expect(performance.now() - t0).toBeGreaterThan(1500);
    expect(await rpc.call("tasks", "list", [])).toEqual([]);
    expect(terminations).toBe(0);
    expect(workers.length).toBe(1);
  }, 30_000);

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

  test("tasks.changedSince runs in the worker: snapshot, then a delta, a tombstone and a filtered removal", async () => {
    const { rpc } = newClient();
    const a = makeTask();
    const b = makeTask();
    await rpc.call("tasks", "insert", [a]);
    await rpc.call("tasks", "insert", [b]);
    type Res = { epoch: string; rev: number; snapshot: boolean; tasks: Array<{ id: string }>; removedIds: string[]; running: Record<string, number> };
    const snap = (await rpc.op("tasks.changedSince", [null, "exclude", []])) as Res;
    expect(snap.snapshot).toBe(true);
    expect(snap.tasks.map((t) => t.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    const cursor = { epoch: snap.epoch, rev: snap.rev };

    await rpc.call("tasks", "update", [a.id, { title: "changed" }]);
    await rpc.call("tasks", "update", [b.id, { archivedAt: Date.now() }]);
    const d = (await rpc.op("tasks.changedSince", [cursor, "exclude", []])) as Res;
    expect(d.snapshot).toBe(false);
    expect(d.tasks.map((t) => t.id)).toEqual([a.id]);
    expect(d.removedIds).toEqual([b.id]);
    expect(d.rev).toBeGreaterThan(cursor.rev);
    const kept = (await rpc.op("tasks.changedSince", [cursor, "exclude", [b.id]])) as Res;
    expect(kept.tasks.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());

    await rpc.call("tasks", "delete", [a.id]);
    const gone = (await rpc.op("tasks.changedSince", [{ epoch: d.epoch, rev: d.rev }, "exclude", []])) as Res;
    expect(gone.removedIds).toEqual([a.id]);
    // Another database's epoch snapshots.
    const other = (await rpc.op("tasks.changedSince", [{ epoch: "0".repeat(16), rev: 0 }, "exclude", []])) as Res;
    expect(other.snapshot).toBe(true);
  });

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
  test("a heavy read runs while a 5 ms timer keeps ticking (max gap <= max(100 ms, 3 x the idle baseline))", async () => {
    const { rpc } = newClient();
    const t = makeTask();
    await rpc.call("tasks", "insert", [t]);
    const run = makeRun(t.id);
    await rpc.call("runs", "insert", [run]);
    // ~50 MB of events: 50 rows of 1 MB, posted from the main thread.
    const chunk = "x".repeat(1024 * 1024);
    for (let i = 0; i < 50; i++) await rpc.call("runs", "appendEvent", [run.id, "stdout", `${i}:${chunk}`]);

    // Baseline in the same run, with no load: how late a 5 ms timer is on this
    // machine right now. The bound scales with it, so a loaded CI box does not
    // flake, while a read that ran on the main thread (hundreds of ms) still fails.
    let last = performance.now();
    let maxGap = 0;
    let ticks = 0;
    const timer = setInterval(() => {
      const nowMs = performance.now();
      maxGap = Math.max(maxGap, nowMs - last);
      last = nowMs;
      ticks++;
    }, 5);
    await sleep(400);
    const baselineGap = maxGap;
    expect(ticks).toBeGreaterThan(0);
    last = performance.now();
    maxGap = 0;
    ticks = 0;
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
      console.info(`[db-rpc-worker.test] heavy windowed read ${heavyMs.toFixed(0)} ms, full 50 MB read ${fullMs.toFixed(0)} ms, ${ticks} ticks, max main-thread gap ${maxGap.toFixed(1)} ms (baseline ${baselineGap.toFixed(1)} ms)`);
      expect(ticks).toBeGreaterThan(5);
      expect(maxGap).toBeLessThanOrEqual(Math.max(100, baselineGap * 3));
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
    await crash(workers[0]!); // the crash has landed; the restart is underway
    await waitFor(() => workers.length === 2, "the restarted worker");
    expect(await rpc.call("preferences", "get", ["nope"])).toBeNull();
    expect(workers.length).toBe(2);
  });

  test("restarts are capped per window, then calls reject until the window passes", async () => {
    let clock = 1_000_000;
    const { rpc, workers } = newClient({ maxRestartsPerWindow: 2, restartWindowMs: 10_000, now: () => clock });
    await rpc.dbReady();
    const crashAndWait = async (n: number) => {
      await crash(workers[n]!);
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

describe("worker console output", () => {
  test("a worker's console.log reaches the main-thread console with the db-worker prefix", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      const { rpc } = newClient();
      await rpc.dbReady(); // a fresh database logs "applied migrations" from inside the worker
      await waitFor(() => lines.some((l) => l.startsWith("[agetor:db-worker] ") && l.includes("applied migrations")), "the forwarded log line", 5000);
    } finally {
      console.log = original;
    }
  });

  test("log messages use the matching console method, a malformed one is ignored, and none is a reply", async () => {
    const warned: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
    const listeners = new Map<string, (ev: unknown) => void>();
    const emit = (data: unknown) => listeners.get("message")?.({ data });
    const fake: CoreWorkerLike = {
      postMessage(m) {
        const req = m as { id?: number; kind?: string };
        if (req.kind !== "call") return;
        emit({ log: { level: "warn", text: "from the worker" } });
        emit({ log: "junk" });
        emit({ log: { level: "nonsense", text: 5 } });
        emit({ id: req.id, ok: true, result: "answer", rev: 0 });
      },
      terminate() {},
      addEventListener(type, listener) { listeners.set(type, listener); },
    };
    try {
      const { rpc } = newClient({ workerFactory: () => fake });
      const first = rpc.call("preferences", "get", ["k"]);
      emit({ ready: true, buildId: BUILD_ID });
      expect(await first).toBe("answer");
      expect(warned).toEqual(["[agetor:db-worker] from the worker"]);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("close", () => {
  test("closeDb asks the worker to close its connection before terminating it", async () => {
    const events: string[] = [];
    const { rpc, dbPath } = newClient({
      workerFactory: (p) => {
        const w = createCoreWorker("db", { dbPath: p });
        const post = w.postMessage.bind(w);
        w.postMessage = (m: unknown) => {
          const kind = (m as { kind?: string }).kind;
          if (kind === "close") events.push("close-requested");
          post(m);
        };
        const terminate = w.terminate.bind(w);
        w.terminate = () => { events.push("terminated"); return terminate(); };
        return w;
      },
    });
    await rpc.dbReady();
    await rpc.call("tasks", "insert", [makeTask()]);
    await rpc.closeDb({ timeoutMs: 2000 });
    expect(events).toEqual(["close-requested", "terminated"]);
    // The last connection closed: SQLite checkpointed and removed (or emptied) the WAL.
    const { existsSync, statSync } = await import("node:fs");
    const wal = `${dbPath}-wal`;
    expect(!existsSync(wal) || statSync(wal).size === 0).toBe(true);
  });

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
    // A terminated worker never answers; give a live one ample time to prove otherwise.
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

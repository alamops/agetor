/**
 * Boot ordering of the db worker (docs/plans/non-blocking-core.md §3, T9):
 *   - `awaitDbReady` retries a rejected `dbReady()` with a capped backoff and
 *     logs each failure; it stops when told the process is shutting down;
 *   - the boot gate stays closed until `dbReady()` resolves while the ownership
 *     probes (/health, /info) keep answering;
 *   - `drainCoreForQuit` flushes the log then closes the worker, and a worker
 *     that never closes cannot hold a quit past its bound.
 * The code under test is pure, but boot-db.ts imports the db facade, which
 * loads db.ts: the data dir is a temp dir set before any static import runs.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-boot-wiring-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
const { awaitDbReady, createQuitSequencer, drainCoreForQuit, runQuitSequence } = await import("./boot-db.ts");
const { bootReadySignal, gateRoutesUntilReady } = await import("./boot-gate.ts");

afterAll(() => {
  rmTestDataDir(DATA_DIR);
});

describe("awaitDbReady", () => {
  test("retries a failing dbReady with a doubling, capped backoff, logging each failure", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const logs: string[] = [];
    const ok = await awaitDbReady({
      ready: async () => {
        attempts++;
        if (attempts < 6) throw new Error("worker could not start");
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      logError: (m) => logs.push(m),
      backoffStartMs: 100,
      backoffMaxMs: 500,
    });
    expect(ok).toBe(true);
    expect(attempts).toBe(6);
    expect(sleeps).toEqual([100, 200, 400, 500, 500]);
    expect(logs).toHaveLength(5);
    expect(logs[0]).toContain("worker could not start");
  });

  test("stops retrying once the process is shutting down", async () => {
    let stopped = false;
    let attempts = 0;
    const ok = await awaitDbReady({
      ready: async () => {
        attempts++;
        throw new Error("nope");
      },
      sleep: async () => {
        stopped = true;
      },
      isStopped: () => stopped,
      logError: () => {},
    });
    expect(ok).toBe(false);
    expect(attempts).toBe(1);
  });
});

describe("boot gate vs dbReady", () => {
  test("routes stay shut until dbReady resolves; /health and /info answer meanwhile", async () => {
    const { ready, markReady } = bootReadySignal();
    const routes = gateRoutesUntilReady(
      {
        "/health": () => new Response("health"),
        "/info": () => new Response("info"),
        "/tasks": () => new Response("tasks"),
      },
      ready,
      ["/health", "/info"],
    );
    let releaseDb!: () => void;
    const dbReadyPromise = new Promise<void>((r) => {
      releaseDb = r;
    });
    // The entry points' order: wait for the db, then (reconcile), then open the gate.
    const boot = (async () => {
      await awaitDbReady({ ready: () => dbReadyPromise });
      markReady();
    })();

    const req = new Request("http://x/tasks");
    expect(await (routes["/health"] as () => Response)().text()).toBe("health");
    expect(await (routes["/info"] as () => Response)().text()).toBe("info");
    let served = false;
    const held = Promise.resolve((routes["/tasks"] as (r: Request) => unknown)(req)).then((r) => {
      served = true;
      return r as Response;
    });
    await Bun.sleep(30);
    expect(served).toBe(false);

    releaseDb();
    await boot;
    expect(await (await held).text()).toBe("tasks");
  });

  test("a dbReady that keeps failing never opens the gate", async () => {
    const { ready, markReady } = bootReadySignal();
    let open = false;
    void ready.then(() => {
      open = true;
    });
    let stop = false;
    const boot = awaitDbReady({
      ready: async () => {
        throw new Error("down");
      },
      sleep: (ms) => Bun.sleep(Math.min(ms, 5)),
      isStopped: () => stop,
      logError: () => {},
    }).then((ok) => {
      if (ok) markReady();
    });
    await Bun.sleep(40);
    expect(open).toBe(false);
    stop = true;
    await boot;
    expect(open).toBe(false);
  });
});

describe("runQuitSequence", () => {
  test("effects run (and settle) before the drain, while the db is still open", async () => {
    const order: string[] = [];
    let dbOpen = true;
    await runQuitSequence({
      effects: async () => {
        await Bun.sleep(10);
        order.push(`effects:db-open=${dbOpen}`);
      },
      drain: async () => {
        order.push("drain");
        dbOpen = false;
      },
    });
    expect(order).toEqual(["effects:db-open=true", "drain"]);
  });

  test("a failing effect is logged and the drain still runs", async () => {
    const logs: string[] = [];
    let drained = false;
    await runQuitSequence({
      effects: () => {
        throw new Error("boom");
      },
      drain: async () => {
        drained = true;
      },
      log: (m) => logs.push(m),
    });
    expect(drained).toBe(true);
    expect(logs[0]).toContain("boom");
  });

  test("a hung effect cannot block the quit past the bound", async () => {
    const logs: string[] = [];
    const started = Date.now();
    await runQuitSequence({
      effects: () => new Promise<void>(() => {}),
      drain: async () => {},
      maxMs: 50,
      log: (m) => logs.push(m),
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(logs.some((l) => l.includes("timed out"))).toBe(true);
  });

  test("sequencer: the first pass vetoes and runs effects then drain once; the second pass allows and does nothing", async () => {
    const calls: string[] = [];
    const requeued = Promise.withResolvers<{ completely: boolean }>();
    const sequencer = createQuitSequencer({
      run: () =>
        runQuitSequence({
          effects: () => {
            calls.push("effects");
          },
          drain: async () => {
            calls.push("drain");
          },
        }),
      requeue: (opts) => {
        calls.push("requeue");
        requeued.resolve(opts);
      },
    });
    expect(sequencer.allowQuit(false)).toBe(false);
    expect(sequencer.allowQuit(true)).toBe(false); // absorbed; its `completely` is kept
    expect(await requeued.promise).toEqual({ completely: true });
    expect(sequencer.allowQuit(false)).toBe(true);
    expect(sequencer.allowQuit(false)).toBe(true);
    expect(calls).toEqual(["effects", "drain", "requeue"]);
  });
});

describe("drainCoreForQuit", () => {
  test("flushes the log first, then closes the worker with the 3 s bound", async () => {
    const order: string[] = [];
    await drainCoreForQuit({
      flush: async () => {
        order.push("flush");
      },
      close: async (opts) => {
        order.push(`close:${opts.timeoutMs}`);
      },
    });
    expect(order).toEqual(["flush", "close:3000"]);
  });

  test("a close that never settles cannot hold the quit past the bound", async () => {
    const started = Date.now();
    await drainCoreForQuit({
      flush: async () => {},
      close: () => new Promise<void>(() => {}),
      maxMs: 50,
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a throwing flush or close never rejects", async () => {
    await drainCoreForQuit({
      flush: async () => {
        throw new Error("flush");
      },
      close: async () => {
        throw new Error("close");
      },
    });
  });
});

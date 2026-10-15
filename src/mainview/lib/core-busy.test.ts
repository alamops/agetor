import { describe, expect, test } from "bun:test";
import {
  createCoreBusyMonitor,
  PENDING_THRESHOLD_MS,
  PROBE_TIMEOUT_MS,
  REPROBE_INTERVAL_MS,
  type CoreBusyDeps,
  type CoreBusyFetch,
} from "./core-busy.ts";

/** A virtual clock with manually-advanced timers, so the 3 s threshold and
 *  the 2 s re-probe cadence run in microseconds. */
function makeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: ((fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as CoreBusyDeps["setTimeout"],
    clearTimeout: ((h: ReturnType<typeof setTimeout>) => {
      timers.delete(h as unknown as number);
    }) as CoreBusyDeps["clearTimeout"],
    /** Advances virtual time, firing due timers in order, and lets the
     *  microtasks each one queues (the async probe) run before the next. */
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of timers) {
          if (entry[1].at <= target && (due === null || entry[1].at < due[1].at)) due = entry;
        }
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
    pendingTimers: () => timers.size,
  };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

type ProbeMode = "ok" | "fail" | "hang";

function makeHealth(initial: ProbeMode) {
  let mode: ProbeMode = initial;
  const calls: string[] = [];
  const fetchImpl: CoreBusyFetch = (url, init) => {
    calls.push(url);
    if (mode === "ok") return Promise.resolve(new Response("ok"));
    if (mode === "fail") return Promise.reject(new TypeError("Load failed"));
    // "hang": never answers until the probe's own abort fires.
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  };
  return {
    fetchImpl,
    calls,
    set(next: ProbeMode) {
      mode = next;
    },
  };
}

function setup(mode: ProbeMode) {
  const clock = makeClock();
  const health = makeHealth(mode);
  const monitor = createCoreBusyMonitor({
    fetchImpl: health.fetchImpl,
    base: "http://core",
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { clock, health, monitor };
}

/** A tracked request the test settles by hand. */
function deferred() {
  let resolve!: (v: string) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("core-busy monitor", () => {
  test("no probe while every request is younger than the threshold", async () => {
    const { clock, health, monitor } = setup("fail");
    const req = deferred();
    void monitor.trackRequest(req.promise);
    await clock.advance(PENDING_THRESHOLD_MS - 1);
    expect(health.calls).toEqual([]);
    expect(monitor.getBusy()).toBe(false);
    req.resolve("done");
    await flush();
    await clock.advance(10_000);
    expect(health.calls).toEqual([]);
    expect(clock.pendingTimers()).toBe(0);
  });

  test("a failed probe flips busy, a later success clears it", async () => {
    const { clock, health, monitor } = setup("fail");
    let notified = 0;
    monitor.subscribe(() => notified++);
    const req = deferred();
    void monitor.trackRequest(req.promise);
    await clock.advance(PENDING_THRESHOLD_MS);
    expect(health.calls).toEqual(["http://core/health"]);
    expect(monitor.getBusy()).toBe(true);
    expect(notified).toBe(1);

    health.set("ok");
    await clock.advance(REPROBE_INTERVAL_MS);
    expect(health.calls.length).toBe(2);
    expect(monitor.getBusy()).toBe(false);
    expect(notified).toBe(2);
    req.resolve("done");
    await flush();
  });

  test("a hung probe counts as no answer once its abort fires", async () => {
    const { clock, monitor } = setup("hang");
    const req = deferred();
    void monitor.trackRequest(req.promise);
    await clock.advance(PENDING_THRESHOLD_MS);
    expect(monitor.getBusy()).toBe(false);
    await clock.advance(PROBE_TIMEOUT_MS);
    expect(monitor.getBusy()).toBe(true);
    req.resolve("done");
    await flush();
  });

  test("in-flight requests draining clears busy and stops probing", async () => {
    const { clock, health, monitor } = setup("fail");
    const req = deferred();
    void monitor.trackRequest(req.promise);
    await clock.advance(PENDING_THRESHOLD_MS);
    expect(monitor.getBusy()).toBe(true);
    req.resolve("done");
    await flush();
    expect(monitor.getBusy()).toBe(false);
    const calls = health.calls.length;
    await clock.advance(30_000);
    expect(health.calls.length).toBe(calls);
    expect(clock.pendingTimers()).toBe(0);
  });

  test("suspended → no probe and no banner; resuming starts clean", async () => {
    const { clock, health, monitor } = setup("fail");
    const release = monitor.suspend();
    const req = deferred();
    void monitor.trackRequest(req.promise);
    await clock.advance(PENDING_THRESHOLD_MS * 3);
    expect(health.calls).toEqual([]);
    expect(monitor.getBusy()).toBe(false);
    release();
    release(); // idempotent
    // The request is already past the threshold, so resuming probes now.
    await flush();
    expect(health.calls.length).toBe(1);
    expect(monitor.getBusy()).toBe(true);
    req.resolve("done");
    await flush();
  });

  test("a suspension hides an already-visible banner until it ends", async () => {
    const { clock, monitor } = setup("fail");
    const req = deferred();
    void monitor.trackRequest(req.promise);
    await clock.advance(PENDING_THRESHOLD_MS);
    expect(monitor.getBusy()).toBe(true);
    const release = monitor.suspend();
    expect(monitor.getBusy()).toBe(false);
    release();
    await flush();
    expect(monitor.getBusy()).toBe(true);
    req.resolve("done");
    await flush();
  });

  test("tracking never changes the request's outcome", async () => {
    const { clock, monitor } = setup("fail");
    const ok = deferred();
    const bad = deferred();
    const okTracked = monitor.trackRequest(ok.promise);
    const badTracked = monitor.trackRequest(bad.promise);
    await clock.advance(PENDING_THRESHOLD_MS * 2);
    ok.resolve("value");
    const err = new Error("boom");
    bad.reject(err);
    expect(await okTracked).toBe("value");
    await expect(badTracked).rejects.toBe(err);
  });

  test("the probe never aborts the tracked request", async () => {
    const { clock, monitor } = setup("hang");
    let aborted = false;
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => {
      aborted = true;
    });
    const req = deferred();
    const tracked = monitor.trackRequest(req.promise);
    await clock.advance(PENDING_THRESHOLD_MS + PROBE_TIMEOUT_MS + REPROBE_INTERVAL_MS * 3);
    expect(aborted).toBe(false);
    req.resolve("late");
    expect(await tracked).toBe("late");
  });
});

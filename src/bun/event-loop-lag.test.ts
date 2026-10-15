/**
 * Unit tests for the event-loop-lag monitor (docs/plans/non-blocking-session-restore.md,
 * T3). Real timers with a small `sampleMs`, plus one injected-clock case so the
 * attribution/collapse rules are pinned without depending on wall-clock sleeps.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  beginLagLabel,
  currentLagLabel,
  setLagStallSink,
  startLagMonitor,
  stopLagMonitor,
  type LagStall,
} from "./event-loop-lag";

const reports: LagStall[] = [];
const warnings: string[] = [];
let realWarn: typeof console.warn;

/** Resolve once `n` stalls have been reported (or fail the test after `ms`). */
async function waitForReports(n: number, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (reports.length < n) {
    if (Date.now() > deadline) throw new Error(`expected ${n} stall report(s), saw ${reports.length}`);
    await Bun.sleep(5);
  }
}

beforeEach(() => {
  reports.length = 0;
  warnings.length = 0;
  realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  setLagStallSink((s) => reports.push(s));
});

afterEach(() => {
  stopLagMonitor();
  setLagStallSink(null);
  console.warn = realWarn;
});

describe("event-loop-lag monitor", () => {
  test("a Bun.sleepSync(1200) inside a label produces exactly one report naming it", async () => {
    // sampleMs 100 keeps the measured lag within 100 ms of the 1200 ms block,
    // comfortably over the 1000 ms stall bar.
    startLagMonitor({ sampleMs: 100, stallMs: 1000, force: true });
    const ctx = { taskId: "task-1", runId: "run-1" };
    const end = beginLagLabel("attach subagent watcher · task task-1", ctx);
    Bun.sleepSync(1200);
    end();
    await waitForReports(1);
    // Give a few more ticks the chance to (wrongly) double-report.
    await Bun.sleep(300);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.label).toBe("attach subagent watcher · task task-1");
    expect(reports[0]!.ctx).toEqual(ctx);
    expect(reports[0]!.lagMs).toBeGreaterThanOrEqual(1000);
    const lines = warnings.filter((w) => w.includes("core was unresponsive"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[agetor\] core was unresponsive for \d+\.\ds during attach subagent watcher · task task-1$/,
    );
  });

  test("nested labels report the innermost", async () => {
    startLagMonitor({ sampleMs: 20, stallMs: 150, force: true });
    const endOuter = beginLagLabel("boot reattach · task t", { taskId: "t" });
    const endInner = beginLagLabel("attach subagent watcher · task t", { taskId: "t", runId: "r" });
    Bun.sleepSync(400);
    endInner();
    endOuter();
    await waitForReports(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.label).toBe("attach subagent watcher · task t");
    expect(reports[0]!.ctx).toEqual({ taskId: "t", runId: "r" });
  });

  test("a stall with no label reports as idle", async () => {
    startLagMonitor({ sampleMs: 20, stallMs: 150, force: true });
    Bun.sleepSync(400);
    await waitForReports(1);
    expect(reports[0]!.label).toBeNull();
    expect(reports[0]!.ctx).toBeNull();
    expect(warnings.some((w) => w.endsWith("during idle"))).toBe(true);
  });

  test("a short block under the stall bar is not reported", async () => {
    startLagMonitor({ sampleMs: 20, stallMs: 300, force: true });
    const end = beginLagLabel("quick", { taskId: "t" });
    Bun.sleepSync(80);
    end();
    await Bun.sleep(120);
    expect(reports).toHaveLength(0);
  });

  test("consecutive stalls under one label collapse into a single report", async () => {
    startLagMonitor({ sampleMs: 20, stallMs: 100, force: true });
    const end = beginLagLabel("chunked job", { taskId: "t" });
    Bun.sleepSync(200);
    // Stay inside the label across a tick boundary and block again before the
    // next sample can fire — two consecutive over-threshold samples.
    await waitForReports(1);
    Bun.sleepSync(200);
    await Bun.sleep(100);
    end();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.label).toBe("chunked job");
    // A quiet sample resets the collapse: the same label stalling again later is
    // a fresh report.
    const again = beginLagLabel("chunked job", { taskId: "t" });
    Bun.sleepSync(200);
    again();
    await waitForReports(2);
    expect(reports).toHaveLength(2);
  });

  test("injected clock: label attribution follows the begin/end interval", async () => {
    let clock = 0;
    startLagMonitor({ sampleMs: 5, stallMs: 1000, now: () => clock, force: true });
    const endA = beginLagLabel("short", { taskId: "a" });
    clock += 5;
    endA();
    const endB = beginLagLabel("long", { taskId: "b" });
    clock += 2000;
    endB();
    await waitForReports(1);
    expect(reports[0]!.label).toBe("long");
    expect(reports[0]!.ctx).toEqual({ taskId: "b" });
    expect(reports[0]!.lagMs).toBe(2005 - 5);
  });

  test("a disposer is idempotent and removes exactly its own entry", () => {
    expect(currentLagLabel()).toBeNull();
    const endA = beginLagLabel("a", { taskId: "ta" });
    const endB = beginLagLabel("b");
    expect(currentLagLabel()).toEqual({ label: "b", ctx: null });
    // Dispose the OUTER first — the inner must stay current.
    endA();
    expect(currentLagLabel()).toEqual({ label: "b", ctx: null });
    endA(); // second call is a no-op and must not pop "b"
    expect(currentLagLabel()).toEqual({ label: "b", ctx: null });
    endB();
    endB();
    expect(currentLagLabel()).toBeNull();
  });

  test("a throwing sink does not break the sampler", async () => {
    setLagStallSink(() => {
      throw new Error("sink boom");
    });
    startLagMonitor({ sampleMs: 20, stallMs: 100, force: true });
    Bun.sleepSync(200);
    await Bun.sleep(80);
    expect(warnings.some((w) => w.includes("sink threw"))).toBe(true);
    // The sampler is still alive: a second, separate stall is still logged.
    await Bun.sleep(40); // a quiet tick resets the collapse
    Bun.sleepSync(200);
    await Bun.sleep(80);
    expect(warnings.filter((w) => w.includes("core was unresponsive")).length).toBe(2);
  });

  test("is disabled under bun test unless forced", async () => {
    // NODE_ENV is "test" here: startLagMonitor() without `force` must not start.
    expect(process.env.NODE_ENV).toBe("test");
    const prior = process.env.AGETOR_LAG_MONITOR;
    delete process.env.AGETOR_LAG_MONITOR;
    try {
      startLagMonitor({ sampleMs: 20, stallMs: 100 });
      Bun.sleepSync(200);
      await Bun.sleep(80);
      expect(reports).toHaveLength(0);
      // AGETOR_LAG_MONITOR=1 forces it on even under test…
      process.env.AGETOR_LAG_MONITOR = "1";
      startLagMonitor({ sampleMs: 20, stallMs: 100 });
      Bun.sleepSync(200);
      await waitForReports(1);
      stopLagMonitor();
      reports.length = 0;
      // …and =0 forces it off, even where it would otherwise run.
      process.env.AGETOR_LAG_MONITOR = "0";
      startLagMonitor({ sampleMs: 20, stallMs: 100 });
      Bun.sleepSync(200);
      await Bun.sleep(80);
      expect(reports).toHaveLength(0);
    } finally {
      if (prior === undefined) delete process.env.AGETOR_LAG_MONITOR;
      else process.env.AGETOR_LAG_MONITOR = prior;
    }
  });

  test("startLagMonitor is idempotent and stopLagMonitor stops the sampler", async () => {
    startLagMonitor({ sampleMs: 20, stallMs: 100, force: true });
    startLagMonitor({ sampleMs: 20, stallMs: 100, force: true }); // no second timer chain
    Bun.sleepSync(200);
    await waitForReports(1);
    await Bun.sleep(80);
    expect(reports).toHaveLength(1); // a doubled sampler would have reported twice
    stopLagMonitor();
    reports.length = 0;
    Bun.sleepSync(250);
    await Bun.sleep(80);
    expect(reports).toHaveLength(0);
  });
});

import { describe, expect, test } from "bun:test";
import { createQuitLaunchGate, type QuitLaunchGateDeps } from "./quit-launch-gate.ts";

// The before-quit hold (quit-launch-gate.ts): every effect is a fake, and the
// wait resolves when the test says so.

function harness(opts: { pending: number; requeueThrows?: boolean }) {
  let pending = opts.pending;
  let resolveWait: ((settled: boolean) => void) | null = null;
  const calls = { freezes: 0, waits: [] as number[], requeues: [] as Array<{ completely: boolean }>, logs: [] as string[] };
  const deps: QuitLaunchGateDeps = {
    launchesInFlight: () => pending,
    waitForLaunchesToSettle: (timeoutMs) => {
      calls.waits.push(timeoutMs);
      return new Promise<boolean>((r) => {
        resolveWait = r;
      });
    },
    freezeLaunches: () => {
      calls.freezes++;
    },
    requeueQuit: (o) => {
      calls.requeues.push(o);
      if (opts.requeueThrows) throw new Error("quit failed");
    },
    timeoutMs: 8_000,
    log: (m) => calls.logs.push(m),
  };
  return {
    gate: createQuitLaunchGate(deps),
    calls,
    setPending: (n: number) => {
      pending = n;
    },
    settle: async (settled: boolean) => {
      resolveWait!(settled);
      // Let the `.then` chain run.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("createQuitLaunchGate", () => {
  test("nothing launching: the quit goes through at once (after freezing new work)", () => {
    const h = harness({ pending: 0 });
    expect(h.gate.holdQuit(false)).toBe(false);
    expect(h.gate.isWaiting()).toBe(false);
    expect(h.calls.freezes).toBe(1);
    expect(h.calls.waits).toHaveLength(0);
    expect(h.calls.requeues).toHaveLength(0);
  });

  test("a launch in flight: the quit is held, then re-issued once launches settle; the re-issued quit passes", async () => {
    const h = harness({ pending: 2 });
    expect(h.gate.holdQuit(false)).toBe(true);
    expect(h.gate.isWaiting()).toBe(true);
    expect(h.calls.waits).toEqual([8_000]);
    expect(h.calls.requeues).toHaveLength(0);

    h.setPending(0);
    await h.settle(true);
    expect(h.calls.requeues).toEqual([{ completely: false }]);
    expect(h.gate.isWaiting()).toBe(false);

    // The re-issued quit's before-quit: let through, even with a launch that
    // started meanwhile (the freeze already refuses those).
    h.setPending(1);
    expect(h.gate.holdQuit(false)).toBe(false);
    expect(h.calls.waits).toHaveLength(1);
  });

  test("a quit asked for while waiting is absorbed, and a complete quit upgrades the held one", async () => {
    const h = harness({ pending: 1 });
    expect(h.gate.holdQuit(false)).toBe(true);
    expect(h.gate.holdQuit(false)).toBe(true);
    expect(h.gate.holdQuit(true)).toBe(true);
    expect(h.calls.waits).toHaveLength(1);
    await h.settle(true);
    expect(h.calls.requeues).toEqual([{ completely: true }]);
  });

  test("the bound running out still re-issues the quit (and says so)", async () => {
    const h = harness({ pending: 1 });
    expect(h.gate.holdQuit(true)).toBe(true);
    await h.settle(false);
    expect(h.calls.requeues).toEqual([{ completely: true }]);
    expect(h.calls.logs.some((m) => m.includes("quitting anyway"))).toBe(true);
  });

  test("a requeue that throws returns the gate to idle so the next Cmd+Q is not swallowed", async () => {
    const h = harness({ pending: 1, requeueThrows: true });
    expect(h.gate.holdQuit(false)).toBe(true);
    await h.settle(true);
    expect(h.gate.isWaiting()).toBe(false);
    h.setPending(0);
    expect(h.gate.holdQuit(false)).toBe(false);
  });
});

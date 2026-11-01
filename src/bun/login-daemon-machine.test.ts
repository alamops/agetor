import { describe, expect, test } from "bun:test";
import { CORE_EXIT_PARK, SUPERVISOR_EXIT_BUNDLE_CHANGED } from "./daemon-mode.ts";
import {
  BUNDLE_GIVE_UP_MS,
  backoffDelay,
  BUNDLE_STABLE_MS,
  CHILD_KILL_WAIT_MS,
  CRASH_BACKOFF_BASE_MS,
  CRASH_HEALTHY_MS,
  DEFAULT_CONFIG,
  HANDBACK_MARKER_MAX_AGE_MS,
  HANDOFF_GRACE_MS,
  UPDATE_GRACE_MS,
  initialState,
  lastExitOf,
  persistedPhase,
  step,
  type Action,
  type MachineConfig,
  type MachineState,
  type StepResult,
  type TickInputs,
} from "./login-daemon-machine.ts";

// The machine is pure: a fake clock is just the `now` we put in each tick.
const T0 = 1_000_000;

function tick(now: number, over: Partial<TickInputs> = {}): TickInputs {
  return {
    now,
    liveCore: false,
    stopRequested: false,
    sigterm: false,
    bundleSig: undefined,
    childExit: null,
    childAlive: false,
    ...over,
  };
}

const types = (r: StepResult) => r.actions.map((a) => a.type);
const find = <T extends Action["type"]>(r: StepResult, t: T) =>
  r.actions.find((a): a is Extract<Action, { type: T }> => a.type === t);
const exitCode = (r: StepResult) => find(r, "exit")?.code;
const written = (r: StepResult) => find(r, "writeState");

/** A started supervisor whose core child is up (booted from an empty world). */
function runningState(opts: { bundleSig?: string | null } = {}): MachineState {
  const init = initialState({ now: T0, handbackMarker: false, liveCore: false, ...opts });
  const r = step(init, tick(T0));
  expect(r.state.phase).toBe("running");
  return r.state;
}

describe("start of process (initialState)", () => {
  test("a live core exists → parked, no child", () => {
    const s = initialState({ now: T0, handbackMarker: false, liveCore: true });
    expect(s.phase).toBe("parked");
    const r = step(s, tick(T0 + 1000, { liveCore: true }));
    expect(r.state.phase).toBe("parked");
    expect(r.actions).toEqual([]);
  });

  test("no core → waiting with a due deadline, so the first tick boots", () => {
    const s = initialState({ now: T0, handbackMarker: false, liveCore: false });
    expect(s).toMatchObject({ phase: "waiting", deadline: T0 });
    const r = step(s, tick(T0));
    expect(types(r)).toContain("spawnCore");
    expect(written(r)).toMatchObject({ state: "running" });
    expect(r.state.phase).toBe("running");
  });

  test("after an update (lastExit bundle-changed) it waits the 30 s grace before booting", () => {
    const s = initialState({ now: T0, lastExit: "bundle-changed", handbackMarker: false, liveCore: false });
    expect(s).toMatchObject({ phase: "waiting", deadline: T0 + UPDATE_GRACE_MS });
    expect(UPDATE_GRACE_MS).toBe(30_000);

    const early = step(s, tick(T0 + UPDATE_GRACE_MS - 1));
    expect(early.actions).toEqual([]);
    expect(early.state.phase).toBe("waiting");

    const due = step(s, tick(T0 + UPDATE_GRACE_MS));
    expect(types(due)).toContain("spawnCore");
  });

  test("a fresh handback marker gives the same 30 s grace", () => {
    const s = initialState({ now: T0, handbackMarker: true, liveCore: false });
    expect(s).toMatchObject({ phase: "waiting", deadline: T0 + 30_000 });
    expect(step(s, tick(T0 + 29_999)).actions).toEqual([]);
    expect(types(step(s, tick(T0 + 30_000)))).toContain("spawnCore");
  });

  test("no marker and no bundle-changed → no grace at all", () => {
    for (const lastExit of [undefined, "stop", "sigterm", "crash"] as const) {
      const s = initialState({ now: T0, lastExit, handbackMarker: false, liveCore: false });
      expect(s).toMatchObject({ phase: "waiting", deadline: T0 });
    }
  });

  test("during the update grace the relaunching app taking the port parks us", () => {
    const s = initialState({ now: T0, handbackMarker: true, liveCore: false });
    const r = step(s, tick(T0 + 5000, { liveCore: true }));
    expect(r.state.phase).toBe("parked");
    expect(types(r)).not.toContain("spawnCore");
    expect(written(r)).toMatchObject({ state: "parked" });
  });

  test("the update grace takes precedence over an already-live core at start", () => {
    const s = initialState({ now: T0, handbackMarker: true, liveCore: true });
    expect(s.phase).toBe("waiting");
  });

  test("updateGraceMs is overridable", () => {
    const s = initialState({ now: T0, handbackMarker: true, liveCore: false, updateGraceMs: 500 });
    expect(s).toMatchObject({ deadline: T0 + 500 });
  });

  test("the handback marker age limit is two minutes", () => {
    expect(HANDBACK_MARKER_MAX_AGE_MS).toBe(120_000);
  });
});

describe("parking behind the app", () => {
  test("while parked with a live core: nothing happens, tick after tick", () => {
    let s = initialState({ now: T0, handbackMarker: false, liveCore: true });
    for (let i = 1; i <= 5; i++) {
      const r = step(s, tick(T0 + i * 1000, { liveCore: true }));
      expect(r.actions).toEqual([]);
      s = r.state;
    }
    expect(s.phase).toBe("parked");
  });

  test("parked and the live core is gone → boot", () => {
    const s = initialState({ now: T0, handbackMarker: false, liveCore: true });
    const r = step(s, tick(T0 + 1000, { liveCore: false }));
    expect(types(r)).toContain("spawnCore");
    expect(r.state.phase).toBe("running");
    expect(written(r)).toMatchObject({ state: "running" });
  });

  test("waiting with a future deadline and a live core → park, not boot", () => {
    const s = initialState({ now: T0, handbackMarker: true, liveCore: false });
    const r = step(s, tick(T0 + 1000, { liveCore: true }));
    expect(r.state.phase).toBe("parked");
    expect(types(r)).not.toContain("spawnCore");
  });

  test("waiting with a due deadline and a live core → park (the core wins over the boot)", () => {
    const s = initialState({ now: T0, handbackMarker: false, liveCore: false });
    const r = step(s, tick(T0, { liveCore: true }));
    expect(r.state.phase).toBe("parked");
    expect(types(r)).not.toContain("spawnCore");
  });
});

describe("core child exits", () => {
  test("exit 0 → supervisor exits 0 (launchd keeps it down) and records lastExit stop", () => {
    const s = runningState();
    const r = step(s, tick(T0 + 5000, { childExit: { code: 0, signal: null } }));
    expect(exitCode(r)).toBe(0);
    expect(written(r)).toMatchObject({ state: "stopped", lastExit: "stop" });
    expect(r.state.phase).toBe("exited");
    expect(lastExitOf(r.state)).toBe("stop");
    // The state write precedes the exit so the file is on disk before we go.
    expect(types(r).indexOf("writeState")).toBeLessThan(types(r).indexOf("exit"));
  });

  test("exit 76 → waiting with the 15 s handoff grace, state written as waiting", () => {
    const s = runningState();
    const now = T0 + 5000;
    const r = step(s, tick(now, { childExit: { code: CORE_EXIT_PARK, signal: null } }));
    expect(r.state).toMatchObject({ phase: "waiting", deadline: now + HANDOFF_GRACE_MS });
    expect(HANDOFF_GRACE_MS).toBe(15_000);
    expect(written(r)).toMatchObject({ state: "waiting" });
    expect(find(r, "exit")).toBeUndefined();
  });

  test("after the handoff grace with no core → boot again", () => {
    const s = runningState();
    const now = T0 + 5000;
    const w = step(s, tick(now, { childExit: { code: CORE_EXIT_PARK, signal: null } })).state;

    const early = step(w, tick(now + HANDOFF_GRACE_MS - 1));
    expect(early.actions).toEqual([]);
    expect(early.state.phase).toBe("waiting");

    const due = step(w, tick(now + HANDOFF_GRACE_MS));
    expect(types(due)).toContain("spawnCore");
    expect(due.state.phase).toBe("running");
  });

  test("the app appearing during the handoff grace → park, no boot", () => {
    const s = runningState();
    const now = T0 + 5000;
    const w = step(s, tick(now, { childExit: { code: CORE_EXIT_PARK, signal: null } })).state;
    const r = step(w, tick(now + 3000, { liveCore: true }));
    expect(r.state.phase).toBe("parked");
    expect(types(r)).not.toContain("spawnCore");
    // ...and it keeps parking after the grace would have expired.
    const later = step(r.state, tick(now + HANDOFF_GRACE_MS + 5000, { liveCore: true }));
    expect(later.actions).toEqual([]);
  });

  test("handoff grace is configurable", () => {
    const s = runningState();
    const cfg: MachineConfig = { ...DEFAULT_CONFIG, handoffGraceMs: 200 };
    const r = step(s, tick(T0 + 10, { childExit: { code: CORE_EXIT_PARK, signal: null } }), cfg);
    expect(r.state).toMatchObject({ phase: "waiting", deadline: T0 + 210 });
  });

  test("a crash (non-zero code) → waiting with a 1 s backoff, lastExit crash, supervisor stays up", () => {
    for (const code of [1, 2, 137, 75]) {
      const r = step(runningState(), tick(T0 + 1000, { childExit: { code, signal: null } }));
      expect(find(r, "exit")).toBeUndefined();
      expect(r.state).toMatchObject({ phase: "waiting", deadline: T0 + 1000 + CRASH_BACKOFF_BASE_MS });
      expect(written(r)).toMatchObject({ state: "waiting", lastExit: "crash" });
    }
  });

  test("death by signal (null code) is a crash too", () => {
    const r = step(runningState(), tick(T0 + 1000, { childExit: { code: null, signal: "SIGSEGV" } }));
    expect(r.state).toMatchObject({ phase: "waiting", deadline: T0 + 1000 + CRASH_BACKOFF_BASE_MS });
    expect(written(r)).toMatchObject({ lastExit: "crash" });
  });

  test("backoffDelay doubles from the base and is capped", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 100].map((n) => backoffDelay(n))).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
    ]);
    expect(backoffDelay(0)).toBe(1000);
    expect(backoffDelay(3, { ...DEFAULT_CONFIG, crashBackoffBaseMs: 10, crashBackoffMaxMs: 25 })).toBe(25);
  });

  /** Drive a crash-looping core: boot on the due tick, crash `uptime` later. */
  function crashLoop(rounds: number, uptime: number, cfg: MachineConfig = DEFAULT_CONFIG) {
    let state: MachineState = initialState({ now: T0, handbackMarker: false, liveCore: false });
    let now = T0;
    const waits: number[] = [];
    for (let i = 0; i < rounds; i++) {
      const boot = step(state, tick(now), cfg);
      expect(types(boot)).toContain("spawnCore");
      now += uptime;
      const crash = step(boot.state, tick(now, { childExit: { code: 1, signal: null } }), cfg);
      expect(crash.state.phase).toBe("waiting");
      const deadline = (crash.state as { deadline: number }).deadline;
      // Not due one ms early: no hot loop.
      expect(types(step(crash.state, tick(deadline - 1), cfg))).not.toContain("spawnCore");
      waits.push(deadline - now);
      state = crash.state;
      now = deadline;
    }
    return waits;
  }

  test("a core that crashes at boot is retried with exponential backoff up to the cap", () => {
    expect(crashLoop(9, 10)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  });

  test("a core that stayed up past crashHealthyMs starts the streak over", () => {
    let state: MachineState = initialState({ now: T0, handbackMarker: false, liveCore: false });
    let now = T0;
    const crashAfter = (uptime: number): number => {
      const boot = step(state, tick(now));
      now += uptime;
      const crash = step(boot.state, tick(now, { childExit: { code: 1, signal: null } }));
      const deadline = (crash.state as { deadline: number }).deadline;
      state = crash.state;
      const wait = deadline - now;
      now = deadline;
      return wait;
    };
    expect(crashAfter(10)).toBe(1000);
    expect(crashAfter(10)).toBe(2000);
    expect(crashAfter(10)).toBe(4000);
    expect(crashAfter(CRASH_HEALTHY_MS)).toBe(1000); // healthy run: back to the base delay
    expect(crashAfter(10)).toBe(2000);
  });

  test("a live core owning the port during the backoff parks the supervisor and clears the streak", () => {
    const crash = step(runningState(), tick(T0 + 10, { childExit: { code: 1, signal: null } }));
    const parked = step(crash.state, tick(T0 + 20, { liveCore: true }));
    expect(parked.state.phase).toBe("parked");
    expect(types(parked)).not.toContain("spawnCore");
    expect((parked.state.common as { failures?: number }).failures).toBe(0);
  });

  test("repeated exit 76 with no live core backs off beyond the handoff grace instead of looping", () => {
    let state: MachineState = initialState({ now: T0, handbackMarker: false, liveCore: false });
    let now = T0;
    const waits: number[] = [];
    for (let i = 0; i < 9; i++) {
      const boot = step(state, tick(now));
      expect(types(boot)).toContain("spawnCore");
      now += 100; // the core finds the port held and parks right away
      const r = step(boot.state, tick(now, { childExit: { code: CORE_EXIT_PARK, signal: null } }));
      expect(r.state.phase).toBe("waiting");
      const deadline = (r.state as { deadline: number }).deadline;
      expect(types(step(r.state, tick(deadline - 1)))).not.toContain("spawnCore");
      waits.push(deadline - now);
      state = r.state;
      now = deadline;
    }
    // The 15 s grace is the floor while the doubling is below it, then it grows
    // to the 60 s cap.
    expect(waits).toEqual([15_000, 15_000, 15_000, 15_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  test("a single exit 76 after a long healthy run is a plain handoff: the 15 s grace, streak reset", () => {
    const boot = step(initialState({ now: T0, handbackMarker: false, liveCore: false }), tick(T0));
    const r = step(boot.state, tick(T0 + CRASH_HEALTHY_MS, { childExit: { code: CORE_EXIT_PARK, signal: null } }));
    expect(r.state).toMatchObject({ phase: "waiting", deadline: T0 + CRASH_HEALTHY_MS + HANDOFF_GRACE_MS });
    expect((r.state.common as { failures?: number }).failures).toBe(1);
  });

  test("a stop request or SIGTERM during a crash backoff still exits 0", () => {
    const crash = step(runningState(), tick(T0 + 10, { childExit: { code: 1, signal: null } }));
    const r = step(crash.state, tick(T0 + 20, { stopRequested: true }));
    expect(exitCode(r)).toBe(0);
    expect(written(r)).toMatchObject({ state: "stopped", lastExit: "stop" });
  });

  test("a running child that is simply still up changes nothing, but its pid is tracked", () => {
    const s = runningState();
    const same = step(s, tick(T0 + 1000, { childAlive: true }));
    expect(same.actions).toEqual([]);
    const tracked = step(s, tick(T0 + 2000, { childAlive: true, childPid: 777 }));
    expect(tracked.state).toMatchObject({ phase: "running", pid: 777 });
    expect(tracked.actions).toEqual([]);
  });
});

describe("SIGTERM and stop requests", () => {
  for (const [name, over, reason] of [
    ["SIGTERM", { sigterm: true }, "sigterm"],
    ["stop request", { stopRequested: true }, "stop"],
  ] as const) {
    describe(name, () => {
      test("with a live child: forward SIGTERM, wait, then exit 0 once it has gone", () => {
        const s = runningState();
        const now = T0 + 10_000;
        const r1 = step(s, tick(now, { ...over, childAlive: true }));
        expect(find(r1, "signalChild")).toEqual({ type: "signalChild", signal: "SIGTERM" });
        expect(r1.state.phase).toBe("stopping");
        expect(find(r1, "exit")).toBeUndefined();

        // Still alive a moment later: just wait.
        const r2 = step(r1.state, tick(now + 1000, { childAlive: true }));
        expect(r2.actions).toEqual([]);

        // The child exits: now we leave with 0 and record why.
        const r3 = step(r2.state, tick(now + 2000, { childExit: { code: 0, signal: null } }));
        expect(exitCode(r3)).toBe(0);
        expect(written(r3)).toMatchObject({ state: "stopped", lastExit: reason });
      });

      test("the child exiting by SIGTERM (null code) still ends in exit 0, not a crash", () => {
        const r1 = step(runningState(), tick(T0 + 1000, { ...over, childAlive: true }));
        const r2 = step(r1.state, tick(T0 + 2000, { childExit: { code: null, signal: "SIGTERM" } }));
        expect(exitCode(r2)).toBe(0);
        expect(written(r2)).toMatchObject({ lastExit: reason });
      });

      test("a child that never exits is SIGKILLed after 25 s, and we exit 0 once it is reaped", () => {
        expect(CHILD_KILL_WAIT_MS).toBe(25_000);
        const now = T0 + 10_000;
        const r1 = step(runningState(), tick(now, { ...over, childAlive: true }));

        const before = step(r1.state, tick(now + CHILD_KILL_WAIT_MS - 1, { childAlive: true }));
        expect(before.actions).toEqual([]);

        const kill = step(before.state, tick(now + CHILD_KILL_WAIT_MS, { childAlive: true }));
        expect(find(kill, "signalChild")).toEqual({ type: "signalChild", signal: "SIGKILL" });
        expect(find(kill, "exit")).toBeUndefined();

        // SIGKILL is sent once.
        const again = step(kill.state, tick(now + CHILD_KILL_WAIT_MS + 1000, { childAlive: true }));
        expect(again.actions.filter((a) => a.type === "signalChild")).toEqual([]);

        const reaped = step(again.state, tick(now + CHILD_KILL_WAIT_MS + 1500, { childAlive: false }));
        expect(exitCode(reaped)).toBe(0);
        expect(written(reaped)).toMatchObject({ lastExit: reason });
      });

      test("a child that survives even SIGKILL does not hold the supervisor forever", () => {
        const now = T0 + 10_000;
        const r1 = step(runningState(), tick(now, { ...over, childAlive: true }));
        const kill = step(r1.state, tick(now + CHILD_KILL_WAIT_MS, { childAlive: true }));
        const stuck = step(kill.state, tick(now + CHILD_KILL_WAIT_MS + 5000, { childAlive: true }));
        expect(exitCode(stuck)).toBe(0);
      });

      test("with no child (parked / waiting): exit 0 immediately, nothing to signal", () => {
        for (const s of [
          initialState({ now: T0, handbackMarker: false, liveCore: true }),
          initialState({ now: T0, handbackMarker: true, liveCore: false }),
        ]) {
          const r = step(s, tick(T0 + 1000, { ...over }));
          expect(exitCode(r)).toBe(0);
          expect(types(r)).not.toContain("signalChild");
          expect(written(r)).toMatchObject({ state: "stopped", lastExit: reason });
        }
      });

      test("when the child already exited in the same tick, no SIGTERM is sent", () => {
        const r = step(runningState(), tick(T0 + 1000, { ...over, childExit: { code: 0, signal: null } }));
        expect(types(r)).not.toContain("signalChild");
        expect(exitCode(r)).toBe(0);
        expect(written(r)).toMatchObject({ lastExit: reason });
      });
    });
  }

  test("kill wait is configurable", () => {
    const cfg: MachineConfig = { ...DEFAULT_CONFIG, childKillWaitMs: 100 };
    const r1 = step(runningState(), tick(T0 + 1000, { sigterm: true, childAlive: true }), cfg);
    const r2 = step(r1.state, tick(T0 + 1100, { childAlive: true }), cfg);
    expect(find(r2, "signalChild")).toEqual({ type: "signalChild", signal: "SIGKILL" });
  });

  test("once stopping, further stop requests and signals change nothing", () => {
    const r1 = step(runningState(), tick(T0 + 1000, { sigterm: true, childAlive: true }));
    const r2 = step(r1.state, tick(T0 + 1500, { sigterm: true, stopRequested: true, childAlive: true }));
    expect(r2.actions).toEqual([]);
    expect(r2.state.phase).toBe("stopping");
  });

  test("an exited machine ignores everything", () => {
    const exited = step(runningState(), tick(T0 + 1000, { sigterm: true })).state;
    expect(exited.phase).toBe("exited");
    const r = step(exited, tick(T0 + 2000, { liveCore: false, stopRequested: true }));
    expect(r.actions).toEqual([]);
    expect(r.state).toBe(exited);
  });
});

describe("app bundle change", () => {
  const SIG_A = "10:1000";
  const SIG_B = "11:2000";
  const SIG_C = "12:3000";

  test("a changed Info.plist while running does NOT signal the child until the new bundle is stable", () => {
    const s = runningState({ bundleSig: SIG_A });
    const r = step(s, tick(T0 + 1000, { bundleSig: SIG_B, childAlive: true }));
    expect(r.state.phase).toBe("bundle-wait");
    expect(types(r)).not.toContain("signalChild");
    expect(types(r)).not.toContain("exit");
    // Still reported as running to anyone reading login-daemon.json.
    expect(persistedPhase(r.state)).toBe("running");
  });

  test("stable for 2 s (two ticks ≥ 2 s apart) → SIGTERM the child → exit 75 with lastExit bundle-changed", () => {
    expect(BUNDLE_STABLE_MS).toBe(2000);
    const s = runningState({ bundleSig: SIG_A });
    const t = T0 + 1000;
    const r1 = step(s, tick(t, { bundleSig: SIG_B, childAlive: true }));
    const r1b = step(r1.state, tick(t + 1999, { bundleSig: SIG_B, childAlive: true }));
    expect(r1b.state.phase).toBe("bundle-wait");
    expect(r1b.actions).toEqual([]);

    const r2 = step(r1b.state, tick(t + 2000, { bundleSig: SIG_B, childAlive: true }));
    expect(find(r2, "signalChild")).toEqual({ type: "signalChild", signal: "SIGTERM" });
    expect(r2.state).toMatchObject({ phase: "stopping", reason: "bundle-changed", exitCode: SUPERVISOR_EXIT_BUNDLE_CHANGED });

    const r3 = step(r2.state, tick(t + 3000, { bundleSig: SIG_B, childExit: { code: 0, signal: null } }));
    expect(exitCode(r3)).toBe(75);
    expect(written(r3)).toMatchObject({ state: "stopped", lastExit: "bundle-changed" });
  });

  test("the signature changing again restarts the stability clock", () => {
    const s = runningState({ bundleSig: SIG_A });
    const t = T0 + 1000;
    const r1 = step(s, tick(t, { bundleSig: SIG_B, childAlive: true }));
    // Mid-copy: the plist changes again.
    const r2 = step(r1.state, tick(t + 1000, { bundleSig: SIG_C, childAlive: true }));
    // 2.5 s after the first sighting but only 1.5 s after the last change: not stable.
    const r3 = step(r2.state, tick(t + 2500, { bundleSig: SIG_C, childAlive: true }));
    expect(r3.state.phase).toBe("bundle-wait");
    expect(types(r3)).not.toContain("signalChild");
    // 2 s after the last change: stable.
    const r4 = step(r3.state, tick(t + 3000, { bundleSig: SIG_C, childAlive: true }));
    expect(find(r4, "signalChild")?.signal).toBe("SIGTERM");
  });

  test("a missing Info.plist (mid-copy) is never 'stable'; we give up after 120 s and exit 75 anyway", () => {
    expect(BUNDLE_GIVE_UP_MS).toBe(120_000);
    const s = runningState({ bundleSig: SIG_A });
    const t = T0 + 1000;
    const r1 = step(s, tick(t, { bundleSig: null, childAlive: true }));
    expect(r1.state.phase).toBe("bundle-wait");
    // Long past the stability window, still missing.
    const mid = step(r1.state, tick(t + BUNDLE_GIVE_UP_MS - 1, { bundleSig: null, childAlive: true }));
    expect(mid.state.phase).toBe("bundle-wait");
    expect(types(mid)).not.toContain("signalChild");

    const giveUp = step(mid.state, tick(t + BUNDLE_GIVE_UP_MS, { bundleSig: null, childAlive: true }));
    expect(find(giveUp, "signalChild")?.signal).toBe("SIGTERM");
    const done = step(giveUp.state, tick(t + BUNDLE_GIVE_UP_MS + 500, { bundleSig: null, childExit: { code: 0, signal: null } }));
    expect(exitCode(done)).toBe(75);
  });

  test("the give-up also applies to a plist that keeps changing", () => {
    const s = runningState({ bundleSig: SIG_A });
    const t = T0;
    let r = step(s, tick(t + 1000, { bundleSig: "x:0", childAlive: true }));
    for (let i = 1; i < 100; i++) {
      r = step(r.state, tick(t + 1000 + i * 1000, { bundleSig: `x:${i}`, childAlive: true }));
      expect(r.state.phase).toBe("bundle-wait");
    }
    // 120 s after the first sighting, even though the signature never held still.
    const end = step(r.state, tick(t + 1000 + BUNDLE_GIVE_UP_MS, { bundleSig: "x:final", childAlive: true }));
    expect(find(end, "signalChild")?.signal).toBe("SIGTERM");
  });

  test("parked/waiting (no child): exits 75 as soon as the bundle is stable, with nothing to signal", () => {
    const s = initialState({ now: T0, handbackMarker: false, liveCore: true, bundleSig: SIG_A });
    const t = T0 + 1000;
    const r1 = step(s, tick(t, { liveCore: true, bundleSig: SIG_B }));
    expect(r1.state.phase).toBe("bundle-wait");
    expect(persistedPhase(r1.state)).toBe("parked");
    const r2 = step(r1.state, tick(t + 2000, { liveCore: true, bundleSig: SIG_B }));
    expect(exitCode(r2)).toBe(75);
    expect(types(r2)).not.toContain("signalChild");
    expect(written(r2)).toMatchObject({ state: "stopped", lastExit: "bundle-changed" });
  });

  test("a child that dies during the wait needs no SIGTERM", () => {
    const s = runningState({ bundleSig: SIG_A });
    const t = T0 + 1000;
    const r1 = step(s, tick(t, { bundleSig: SIG_B, childAlive: true }));
    const r2 = step(r1.state, tick(t + 2000, { bundleSig: SIG_B, childExit: { code: 1, signal: null } }));
    expect(types(r2)).not.toContain("signalChild");
    expect(exitCode(r2)).toBe(75);
  });

  test("an unchanged signature, or checks switched off (undefined), never trigger a wait", () => {
    const withSig = runningState({ bundleSig: SIG_A });
    for (let i = 1; i <= 5; i++) {
      const r = step(withSig, tick(T0 + i * 1000, { bundleSig: SIG_A, childAlive: true }));
      expect(r.state.phase).toBe("running");
    }
    const off = runningState();
    const r = step(off, tick(T0 + 1000, { bundleSig: SIG_B, childAlive: true }));
    expect(r.state.phase).toBe("running");
    const dropped = step(withSig, tick(T0 + 1000, { bundleSig: undefined, childAlive: true }));
    expect(dropped.state.phase).toBe("running");
  });

  test("the thresholds are configurable", () => {
    const cfg: MachineConfig = { ...DEFAULT_CONFIG, bundleStableMs: 10, bundleGiveUpMs: 1000 };
    const s = runningState({ bundleSig: SIG_A });
    const r1 = step(s, tick(T0 + 100, { bundleSig: SIG_B, childAlive: true }), cfg);
    const r2 = step(r1.state, tick(T0 + 110, { bundleSig: SIG_B, childAlive: true }), cfg);
    expect(find(r2, "signalChild")?.signal).toBe("SIGTERM");
  });
});

describe("order of checks within one tick", () => {
  test("a stop request wins over a boot that is due (no spawnCore)", () => {
    const s = initialState({ now: T0, handbackMarker: false, liveCore: false });
    const r = step(s, tick(T0, { stopRequested: true }));
    expect(types(r)).not.toContain("spawnCore");
    expect(exitCode(r)).toBe(0);
    expect(written(r)).toMatchObject({ lastExit: "stop" });
  });

  test("SIGTERM wins over a boot that is due", () => {
    const s = initialState({ now: T0, handbackMarker: false, liveCore: false });
    const r = step(s, tick(T0, { sigterm: true }));
    expect(types(r)).not.toContain("spawnCore");
    expect(exitCode(r)).toBe(0);
  });

  test("SIGTERM wins over a stop request in the same tick", () => {
    const r = step(runningState(), tick(T0 + 1000, { sigterm: true, stopRequested: true, childAlive: true }));
    expect(r.state).toMatchObject({ phase: "stopping", reason: "sigterm" });
  });

  test("stop wins over a changed bundle (exit 0, not 75)", () => {
    const s = runningState({ bundleSig: "a" });
    const r = step(s, tick(T0 + 1000, { stopRequested: true, bundleSig: "b", childAlive: true }));
    expect(r.state).toMatchObject({ phase: "stopping", reason: "stop", exitCode: 0 });
  });

  test("a stop request during a bundle wait still wins and exits 0", () => {
    const s = runningState({ bundleSig: "a" });
    const w = step(s, tick(T0 + 1000, { bundleSig: "b", childAlive: true })).state;
    expect(w.phase).toBe("bundle-wait");
    const r = step(w, tick(T0 + 1500, { bundleSig: "b", stopRequested: true, childAlive: true }));
    expect(r.state).toMatchObject({ phase: "stopping", reason: "stop", exitCode: 0 });
  });

  test("a bundle change wins over a live core / boot: we leave instead of parking or spawning", () => {
    const s = initialState({ now: T0, handbackMarker: false, liveCore: false, bundleSig: "a" });
    const r = step(s, tick(T0, { bundleSig: "b" }));
    expect(r.state.phase).toBe("bundle-wait");
    expect(types(r)).not.toContain("spawnCore");
  });

  test("a child exit and a stop in the same tick: the stop reason is recorded and the child is not re-signalled", () => {
    const r = step(runningState(), tick(T0 + 1000, { stopRequested: true, childExit: { code: CORE_EXIT_PARK, signal: null } }));
    expect(exitCode(r)).toBe(0);
    expect(written(r)).toMatchObject({ lastExit: "stop" });
    expect(types(r)).not.toContain("spawnCore");
  });
});

describe("purity and bookkeeping", () => {
  function deepFreeze<T>(o: T): T {
    if (o && typeof o === "object") {
      Object.freeze(o);
      for (const v of Object.values(o as object)) deepFreeze(v);
    }
    return o;
  }

  test("step never mutates its state or inputs and is deterministic", () => {
    const s = deepFreeze(runningState({ bundleSig: "a" }));
    const inputs = deepFreeze(tick(T0 + 1000, { bundleSig: "b", childAlive: true }));
    const a = step(s, inputs);
    const b = step(s, inputs);
    expect(a).toEqual(b);
  });

  test("persistedPhase maps every machine phase onto the file's vocabulary", () => {
    const run = runningState({ bundleSig: "a" });
    expect(persistedPhase(run)).toBe("running");
    expect(persistedPhase(initialState({ now: T0, handbackMarker: false, liveCore: true }))).toBe("parked");
    expect(persistedPhase(initialState({ now: T0, handbackMarker: false, liveCore: false }))).toBe("waiting");
    const stopping = step(run, tick(T0 + 1, { sigterm: true, childAlive: true })).state;
    expect(persistedPhase(stopping)).toBe("running");
    const exited = step(stopping, tick(T0 + 2, { childExit: { code: 0, signal: null } })).state;
    expect(persistedPhase(exited)).toBe("stopped");
  });

  test("lastExit carries into the next state write (e.g. boot after an update keeps bundle-changed)", () => {
    const s = initialState({ now: T0, lastExit: "bundle-changed", handbackMarker: false, liveCore: false, updateGraceMs: 0 });
    const r = step(s, tick(T0));
    expect(written(r)).toMatchObject({ state: "running", lastExit: "bundle-changed" });
  });

  test("every terminal path logs and writes state before it exits", () => {
    const paths: StepResult[] = [
      step(runningState(), tick(T0 + 1, { childExit: { code: 0, signal: null } })),
      step(runningState(), tick(T0 + 1, { stopRequested: true })),
      step(initialState({ now: T0, handbackMarker: false, liveCore: true }), tick(T0 + 1, { sigterm: true })),
    ];
    for (const r of paths) {
      const t = types(r);
      expect(t).toContain("log");
      expect(t.indexOf("writeState")).toBeGreaterThanOrEqual(0);
      expect(t.indexOf("writeState")).toBeLessThan(t.indexOf("exit"));
    }
  });
});

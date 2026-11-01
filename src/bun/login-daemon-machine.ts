import { CORE_EXIT_PARK, SUPERVISOR_EXIT_BUNDLE_CHANGED } from "./daemon-mode.ts";

/**
 * The login-item supervisor's decision logic, as a pure function
 * (docs/plans/always-on-host.md §3.1/§3.2). `login-daemon.ts` owns every side
 * effect (the clock, the creds file, the control file, the core child, the
 * state file); this module only turns "what the world looks like this tick"
 * into "what to do about it", so every row of the §3.2 table is unit-testable
 * without a process, a timer or a filesystem.
 *
 * LEAF MODULE: imports `daemon-mode.ts` (itself a leaf) only. The supervisor
 * runs with no database open; nothing reachable from here may import `db.ts`.
 *
 * The supervisor is the launchd job's process for its whole life. It runs the
 * headless core as a child while no live core owns the port, and "parks" (runs
 * no child, stays alive) while the app owns it. Exit codes are launchd's
 * contract: 0 = stop until next login (KeepAlive SuccessfulExit:false), any
 * non-zero = restart (75 = restart from the new bundle after an update).
 *
 * Check order every tick (the plan's table order, which is also the priority):
 *   1. sigterm            → stop (lastExit "sigterm")
 *   2. stopRequested      → stop (lastExit "stop")
 *   3. bundleChange       → wait for the new bundle to settle, then exit 75
 *   4. child exit         → classify (0 stop · 76 park/handoff · else crash)
 *   5. waiting / parked   → park behind a live core, or boot one
 * so a stop request wins over a boot in the same tick.
 */

/** Tick period of the IO loop. */
export const TICK_MS = 1000;
/** After the core exits 76 (it handed the port to the app), how long to wait
 *  for the app to bind before booting the core again. */
export const HANDOFF_GRACE_MS = 15_000;
/** At process start after an update (previous exit "bundle-changed", or a
 *  fresh handback marker): give the relaunching app this long to take the port
 *  before the supervisor boots a core. */
export const UPDATE_GRACE_MS = 30_000;
/** The new bundle's Info.plist must be unchanged for this long before the
 *  supervisor exits 75, so launchd doesn't restart it from a half-copied app. */
export const BUNDLE_STABLE_MS = 2_000;
/** Stop waiting for a stable Info.plist after this long and exit 75 anyway. */
export const BUNDLE_GIVE_UP_MS = 120_000;
/** SIGTERM → SIGKILL escalation for the core child. The core's own shutdown()
 *  gets this long (launchd's ExitTimeOut is 30 s). */
export const CHILD_KILL_WAIT_MS = 25_000;
/** A handback marker older than this is ignored at process start. */
export const HANDBACK_MARKER_MAX_AGE_MS = 120_000;
/** First retry delay after an early core exit; doubles per consecutive one. */
export const CRASH_BACKOFF_BASE_MS = 1_000;
/** Ceiling of that doubling. */
export const CRASH_BACKOFF_MAX_MS = 60_000;
/** A core that stayed up this long before exiting was healthy: the failure
 *  streak (and so the backoff) starts over. */
export const CRASH_HEALTHY_MS = 120_000;
/** After SIGKILL, how long to keep waiting for the child to be reaped before
 *  the supervisor exits regardless. */
const KILL_REAP_MS = 5_000;

/** Timing knobs; the IO layer overrides them from env seams for tests. */
export interface MachineConfig {
  handoffGraceMs: number;
  updateGraceMs: number;
  bundleStableMs: number;
  bundleGiveUpMs: number;
  childKillWaitMs: number;
  /** Backoff after a core exit that is not a clean stop: base, cap, and the
   *  uptime that resets the streak. */
  crashBackoffBaseMs: number;
  crashBackoffMaxMs: number;
  crashHealthyMs: number;
}

export const DEFAULT_CONFIG: MachineConfig = {
  handoffGraceMs: HANDOFF_GRACE_MS,
  updateGraceMs: UPDATE_GRACE_MS,
  bundleStableMs: BUNDLE_STABLE_MS,
  bundleGiveUpMs: BUNDLE_GIVE_UP_MS,
  childKillWaitMs: CHILD_KILL_WAIT_MS,
  crashBackoffBaseMs: CRASH_BACKOFF_BASE_MS,
  crashBackoffMaxMs: CRASH_BACKOFF_MAX_MS,
  crashHealthyMs: CRASH_HEALTHY_MS,
};

/** Delay before the `failures`-th consecutive retry (1-based): base, 2x base,
 *  4x base … capped. Pure; exported for the tests. */
export function backoffDelay(failures: number, cfg: MachineConfig = DEFAULT_CONFIG): number {
  const n = Math.max(1, Math.floor(failures));
  // Clamp the exponent so 2 ** n can't overflow to Infinity on a long streak.
  return Math.min(cfg.crashBackoffMaxMs, cfg.crashBackoffBaseMs * 2 ** Math.min(n - 1, 30));
}

export type LastExit = "stop" | "sigterm" | "bundle-changed" | "crash";
/** The `state` field of `login-daemon.json`. */
export type PersistedPhase = "parked" | "waiting" | "running" | "stopped";
type BundleOrigin = "parked" | "waiting" | "running";

export type MachineState =
  /** Between children: a grace period, or "no live core, boot on this tick". */
  | { phase: "waiting"; deadline: number; common: Common }
  /** A live core owns the port; no child of ours runs. */
  | { phase: "parked"; common: Common }
  /** The core child is up. `pid` mirrors the IO layer's child. */
  | { phase: "running"; pid: number | null; common: Common }
  /** Info.plist changed: waiting for the new bundle to settle. */
  | {
      phase: "bundle-wait";
      since: number;
      lastSig: string | null;
      stableSince: number | null;
      /** What we were doing when the change was noticed. A running child is
       *  only SIGTERMed once the wait is over. */
      origin: BundleOrigin;
      common: Common;
    }
  /** The child was SIGTERMed; waiting for it to go before exiting. */
  | {
      phase: "stopping";
      reason: Exclude<LastExit, "crash">;
      exitCode: number;
      killAt: number;
      killedAt: number | null;
      common: Common;
    }
  | { phase: "exited"; code: number; common: Common };

interface Common {
  /** Info.plist signature at process start; `undefined` = bundle checks off. */
  startSig: string | null | undefined;
  /** Why the previous child / process ended, once something has. */
  lastExit: LastExit | undefined;
  /** Consecutive core exits (crash, or 76 with no live core taking over) not
   *  separated by a healthy run or a live core owning the port. */
  failures?: number;
  /** When the current core child was booted. */
  bootedAt?: number;
}

export interface TickInputs {
  now: number;
  /** A creds file whose pid is alive and is not our own child. */
  liveCore: boolean;
  /** The control file asked for a stop (already consumed). */
  stopRequested: boolean;
  sigterm: boolean;
  /** Current `ino:mtimeMs` of Info.plist, `null` if missing, `undefined` when
   *  bundle checks are off. */
  bundleSig: string | null | undefined;
  /** The child's exit, delivered once on the tick after it happened. */
  childExit: { code: number | null; signal: string | null } | null;
  /** The IO layer holds a child that has not exited. */
  childAlive: boolean;
  childPid?: number | null;
}

export type Action =
  | { type: "spawnCore" }
  | { type: "signalChild"; signal: "SIGTERM" | "SIGKILL" }
  | { type: "writeState"; state: PersistedPhase; lastExit?: LastExit }
  | { type: "exit"; code: number }
  | { type: "log"; message: string };

export interface StepResult {
  state: MachineState;
  actions: Action[];
}

export interface InitialOpts {
  now: number;
  /** `lastExit` from the previous `login-daemon.json`, if any. */
  lastExit?: LastExit;
  /** A fresh (< HANDBACK_MARKER_MAX_AGE_MS) handback marker was consumed. */
  handbackMarker: boolean;
  liveCore: boolean;
  /** Info.plist signature at start; omit to disable bundle checks. */
  bundleSig?: string | null;
  updateGraceMs?: number;
}

/**
 * "Start of process" (§3.2): after an update there is a grace period for the
 * relaunching app to take the port; otherwise park behind a live core, or boot
 * on the first tick (a `waiting` state whose deadline is already due).
 */
export function initialState(opts: InitialOpts): MachineState {
  const common: Common = { startSig: opts.bundleSig, lastExit: opts.lastExit };
  const updating = opts.lastExit === "bundle-changed" || opts.handbackMarker;
  if (updating) {
    return {
      phase: "waiting",
      deadline: opts.now + (opts.updateGraceMs ?? UPDATE_GRACE_MS),
      common,
    };
  }
  if (opts.liveCore) return { phase: "parked", common };
  return { phase: "waiting", deadline: opts.now, common };
}

/** The `state` value written to `login-daemon.json` for a machine state. */
export function persistedPhase(s: MachineState): PersistedPhase {
  switch (s.phase) {
    case "waiting":
      return "waiting";
    case "parked":
      return "parked";
    case "running":
    case "stopping":
      return "running";
    case "bundle-wait":
      return s.origin;
    case "exited":
      return "stopped";
  }
}

function exitNow(
  s: MachineState,
  code: number,
  lastExit: LastExit | undefined,
  actions: Action[],
  message: string,
): StepResult {
  const common: Common = { ...s.common, lastExit: lastExit ?? s.common.lastExit };
  actions.push({ type: "log", message });
  actions.push({ type: "writeState", state: "stopped", lastExit: common.lastExit });
  actions.push({ type: "exit", code });
  return { state: { phase: "exited", code, common }, actions };
}

/** Begin a stop: SIGTERM a live child and wait for it, or exit right away. */
function beginStop(
  s: MachineState,
  inputs: TickInputs,
  reason: Exclude<LastExit, "crash">,
  exitCode: number,
  cfg: MachineConfig,
  actions: Action[],
): StepResult {
  const childUp =
    (s.phase === "running" || s.phase === "bundle-wait") &&
    inputs.childAlive &&
    inputs.childExit === null;
  if (!childUp) {
    return exitNow(s, exitCode, reason, actions, `login-daemon: ${reason} — no core child, exiting ${exitCode}`);
  }
  actions.push({ type: "log", message: `login-daemon: ${reason} — SIGTERM to core, waiting up to ${cfg.childKillWaitMs} ms` });
  actions.push({ type: "signalChild", signal: "SIGTERM" });
  return {
    state: {
      phase: "stopping",
      reason,
      exitCode,
      killAt: inputs.now + cfg.childKillWaitMs,
      killedAt: null,
      common: { ...s.common, lastExit: reason },
    },
    actions,
  };
}

function boot(
  s: MachineState,
  actions: Action[],
  why: string,
  now: number,
): StepResult {
  actions.push({ type: "log", message: `login-daemon: ${why} — booting core` });
  actions.push({ type: "spawnCore" });
  actions.push({ type: "writeState", state: "running", lastExit: s.common.lastExit });
  return {
    state: { phase: "running", pid: null, common: { ...s.common, bootedAt: now } },
    actions,
  };
}

/** Failure streak after a core that was booted at `common.bootedAt` exited at
 *  `now`: a healthy run restarts it, so a core that crashes once a day always
 *  gets the base delay. */
function nextFailures(common: Common, now: number, cfg: MachineConfig): number {
  const healthy = common.bootedAt !== undefined && now - common.bootedAt >= cfg.crashHealthyMs;
  return (healthy ? 0 : (common.failures ?? 0)) + 1;
}

/** Emit a `writeState` for a phase change that did not already emit one. */
function finish(prev: MachineState, res: StepResult): StepResult {
  const already = res.actions.some((a) => a.type === "writeState");
  if (already) return res;
  if (
    persistedPhase(prev) !== persistedPhase(res.state) ||
    prev.common.lastExit !== res.state.common.lastExit
  ) {
    res.actions.push({
      type: "writeState",
      state: persistedPhase(res.state),
      lastExit: res.state.common.lastExit,
    });
  }
  return res;
}

/**
 * One tick. Pure: never reads a clock or a file, never mutates `state`.
 * See the module comment for the check order.
 */
export function step(
  state: MachineState,
  inputs: TickInputs,
  cfg: MachineConfig = DEFAULT_CONFIG,
): StepResult {
  const actions: Action[] = [];
  const { now } = inputs;

  if (state.phase === "exited") return { state, actions };

  // A stop is already in flight: only its completion matters now.
  if (state.phase === "stopping") {
    if (inputs.childExit !== null || !inputs.childAlive) {
      return exitNow(
        state,
        state.exitCode,
        state.reason,
        actions,
        `login-daemon: core stopped, exiting ${state.exitCode}`,
      );
    }
    if (state.killedAt === null && now >= state.killAt) {
      actions.push({ type: "log", message: "login-daemon: core ignored SIGTERM — SIGKILL" });
      actions.push({ type: "signalChild", signal: "SIGKILL" });
      return { state: { ...state, killedAt: now }, actions };
    }
    if (state.killedAt !== null && now >= state.killedAt + KILL_REAP_MS) {
      return exitNow(
        state,
        state.exitCode,
        state.reason,
        actions,
        `login-daemon: core not reaped after SIGKILL, exiting ${state.exitCode}`,
      );
    }
    return { state, actions };
  }

  // 1–2. sigterm, then a stop request (consumed by the IO layer either way).
  if (inputs.sigterm) return beginStop(state, inputs, "sigterm", 0, cfg, actions);
  if (inputs.stopRequested) return beginStop(state, inputs, "stop", 0, cfg, actions);

  // 3. A changed (or missing) Info.plist: wait for the new bundle to settle,
  //    then leave with 75 so launchd relaunches us from it.
  const startSig = state.common.startSig;
  if (state.phase === "bundle-wait") {
    let { lastSig, stableSince } = state;
    const sig = inputs.bundleSig === undefined ? lastSig : inputs.bundleSig;
    if (sig !== lastSig) {
      lastSig = sig;
      stableSince = sig === null ? null : now;
    } else if (sig !== null && stableSince === null) {
      stableSince = now;
    }
    // The child may have gone while we waited; nothing to terminate then.
    const childGone = inputs.childExit !== null || !inputs.childAlive;
    const origin: BundleOrigin = childGone && state.origin === "running" ? "waiting" : state.origin;
    const settled = sig !== null && stableSince !== null && now - stableSince >= cfg.bundleStableMs;
    const gaveUp = now - state.since >= cfg.bundleGiveUpMs;
    if (settled || gaveUp) {
      const why = settled
        ? "new bundle is stable"
        : `gave up waiting for a stable bundle after ${cfg.bundleGiveUpMs} ms`;
      actions.push({ type: "log", message: `login-daemon: ${why}` });
      const next: MachineState = { ...state, origin, lastSig, stableSince };
      return beginStop(next, inputs, "bundle-changed", SUPERVISOR_EXIT_BUNDLE_CHANGED, cfg, actions);
    }
    const next: MachineState = { ...state, lastSig, stableSince, origin };
    return finish(state, { state: next, actions });
  }
  if (startSig !== undefined && inputs.bundleSig !== undefined && inputs.bundleSig !== startSig) {
    actions.push({
      type: "log",
      message: `login-daemon: bundle Info.plist changed (${startSig ?? "missing"} → ${inputs.bundleSig ?? "missing"}) — waiting for it to settle`,
    });
    const origin: BundleOrigin = state.phase;
    const childGone = inputs.childExit !== null || !inputs.childAlive;
    const next: MachineState = {
      phase: "bundle-wait",
      since: now,
      lastSig: inputs.bundleSig,
      stableSince: inputs.bundleSig === null ? null : now,
      origin: origin === "running" && childGone ? "waiting" : origin,
      common: state.common,
    };
    return finish(state, { state: next, actions });
  }

  // 4. The child exited.
  if (state.phase === "running") {
    const exit = inputs.childExit;
    if (exit !== null) {
      if (exit.code === 0) {
        return exitNow(state, 0, "stop", actions, "login-daemon: core exited 0 — stopping until next login");
      }
      const failures = nextFailures(state.common, now, cfg);
      if (exit.code === CORE_EXIT_PARK) {
        // A genuine handoff to the app is followed by that app owning the port
        // (we park on the next tick). A 76 that repeats with nobody taking
        // over (a port held by something that isn't a live core) must not
        // reboot a core every grace period forever: back off like a crash.
        const wait = Math.max(cfg.handoffGraceMs, failures > 1 ? backoffDelay(failures, cfg) : 0);
        actions.push({
          type: "log",
          message: `login-daemon: core exited ${CORE_EXIT_PARK} (handoff, streak ${failures}) — waiting ${wait} ms for the app`,
        });
        return finish(state, {
          state: {
            phase: "waiting",
            deadline: now + wait,
            common: { ...state.common, failures },
          },
          actions,
        });
      }
      // A crash stays in-process with exponential backoff: the supervisor's own
      // restarts are paced by launchd's 10 s throttle only, and a streak resets
      // nothing there, so a core that dies at boot would respawn forever.
      const what = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
      const delay = backoffDelay(failures, cfg);
      actions.push({
        type: "log",
        message: `login-daemon: core crashed (${what}, streak ${failures}) — retrying in ${delay} ms`,
      });
      return finish(state, {
        state: {
          phase: "waiting",
          deadline: now + delay,
          common: { ...state.common, lastExit: "crash", failures },
        },
        actions,
      });
    }
    if (inputs.childPid !== undefined && inputs.childPid !== state.pid) {
      return { state: { ...state, pid: inputs.childPid }, actions };
    }
    return { state, actions };
  }

  // 5. waiting / parked.
  if (state.phase === "waiting") {
    if (inputs.liveCore) {
      actions.push({ type: "log", message: "login-daemon: a live core owns the port — parking" });
      return finish(state, {
        state: { phase: "parked", common: { ...state.common, failures: 0 } },
        actions,
      });
    }
    if (now >= state.deadline) return boot(state, actions, "grace over, no live core", now);
    return { state, actions };
  }
  // parked
  if (inputs.liveCore) return { state, actions };
  return boot(state, actions, "the live core is gone", now);
}

/** Convenience for the IO layer: the state's last recorded exit. */
export function lastExitOf(s: MachineState): LastExit | undefined {
  return s.common.lastExit;
}

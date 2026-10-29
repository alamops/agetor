import { closeSync, openSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { childEnv, coreSpawn } from "./core-spawn.ts";
import { isPidAlive, readCoreCreds, resolveDataDir } from "./core-creds.ts";
import { daemonLog, daemonLogPath } from "./daemon-log.ts";
import {
  DEFAULT_CONFIG,
  HANDBACK_MARKER_MAX_AGE_MS,
  TICK_MS,
  initialState,
  persistedPhase,
  step,
  type Action,
  type MachineConfig,
  type MachineState,
  type PersistedPhase,
  type TickInputs,
} from "./login-daemon-machine.ts";
import {
  readLoginDaemonState,
  takeHandbackMarker,
  takeSupervisorStop,
  writeLoginDaemonState,
  type LoginDaemonState,
} from "./login-daemon-state.ts";

/**
 * The login-item supervisor: the process launchd runs for the job's whole life
 * (docs/plans/always-on-host.md §3.1). It runs the headless core as a child
 * while no live core owns the port, and parks (no child, still alive) while the
 * app owns it. All decisions live in the pure `login-daemon-machine.ts`; this
 * file only gathers each tick's inputs and carries out the machine's actions.
 *
 * NEVER import `db.ts` here, directly or through another module: the
 * supervisor has no database, and importing it would create and migrate
 * `agetor.sqlite` in the data dir while the supervisor merely sits parked.
 * Allowed: `core-creds`, `daemon-log`, `daemon-mode`, `login-daemon-state`,
 * `core-spawn` (→ `disclaim`), node built-ins and package.json. `login-daemon-
 * isolation` in I2 pins this with a fresh-data-dir check.
 *
 * Environment:
 *  - `AGETOR_LOGIN_ITEM_BUNDLE`  the app bundle (set by the Swift helper's `run`)
 *  - `AGETOR_LOGIN_ITEM_LABEL`   the launchd label (set by the helper)
 *  - `AGETOR_LOGIN_DAEMON_CORE`  test/dev seam: the core entry to run instead of
 *                                `<bundle>/Contents/Resources/app/daemon/headless.js`
 *  - `AGETOR_LOGIN_DAEMON_TICK_MS`           test seam: tick period (default 1000)
 *  - `AGETOR_LOGIN_DAEMON_HANDOFF_GRACE_MS`  test seam: wait after a core exits 76 (15000)
 *  - `AGETOR_LOGIN_DAEMON_UPDATE_GRACE_MS`   test seam: grace after an update (30000)
 * The core child's stdout/stderr go to `<dataDir>/daemon.log`.
 */

/** A running core child as the supervisor sees it. */
export interface CoreChild {
  pid: number;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  /** Resolves once, when the child has exited. */
  exited: Promise<{ code: number | null; signal: string | null }>;
}

export interface SupervisorDeps {
  now(): number;
  tickMs: number;
  config: MachineConfig;
  /** Previous run's `lastExit` and whether a fresh handback marker existed. */
  startup: { lastExit: LoginDaemonState["lastExit"]; handbackMarker: boolean };
  /** A creds file whose pid is alive, other than `exceptPid` (our own child). */
  liveCore(exceptPid: number | null): boolean;
  /** Consume the stop control file. */
  takeStop(): boolean;
  /** `ino:mtimeMs` of Info.plist, null when missing, undefined = no bundle. */
  bundleSig(): string | null | undefined;
  spawnCore(): CoreChild;
  writeState(fields: {
    state: PersistedPhase;
    corePid: number | null;
    lastExit: LoginDaemonState["lastExit"];
  }): void;
  log(message: string): void;
}

export interface Supervisor {
  /** Runs until the machine exits; resolves with the process exit code. */
  run(): Promise<number>;
  /** Equivalent to receiving SIGTERM/SIGINT. */
  sigterm(): void;
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  let sigterm = false;
  let child: CoreChild | null = null;
  let childExit: { code: number | null; signal: string | null } | null = null;
  let wake: (() => void) | null = null;

  // A wake that lands while a tick is still executing must not be lost.
  let pendingWake = false;
  const poke = (): void => {
    const w = wake;
    wake = null;
    if (w) w();
    else pendingWake = true;
  };
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (pendingWake) {
        pendingWake = false;
        resolve();
        return;
      }
      const t = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });

  const execute = (actions: Action[]): number | null => {
    let exitCode: number | null = null;
    for (const a of actions) {
      switch (a.type) {
        case "log":
          deps.log(a.message);
          break;
        case "spawnCore": {
          try {
            const c = deps.spawnCore();
            child = c;
            childExit = null;
            void c.exited.then((e) => {
              if (child === c) childExit = e;
              poke();
            });
          } catch (e) {
            // A core that cannot even start is a crash: let launchd's throttle
            // pace the retries rather than spinning here.
            deps.log(`login-daemon: failed to spawn core: ${(e as Error).message}`);
            childExit = { code: 1, signal: null };
          }
          break;
        }
        case "signalChild":
          try {
            child?.kill(a.signal);
          } catch {
            /* already gone */
          }
          break;
        case "writeState":
          try {
            deps.writeState({
              state: a.state,
              corePid: a.state === "running" ? (child?.pid ?? null) : null,
              lastExit: a.lastExit,
            });
          } catch (e) {
            deps.log(`login-daemon: cannot write state file: ${(e as Error).message}`);
          }
          break;
        case "exit":
          exitCode = a.code;
          break;
      }
    }
    return exitCode;
  };

  const run = async (): Promise<number> => {
    const bundleSig = deps.bundleSig();
    let state: MachineState = initialState({
      now: deps.now(),
      lastExit: deps.startup.lastExit,
      handbackMarker: deps.startup.handbackMarker,
      liveCore: deps.liveCore(null),
      bundleSig,
      updateGraceMs: deps.config.updateGraceMs,
    });
    deps.log(
      `login-daemon: start — ${state.phase}${
        state.phase === "waiting" && state.deadline > deps.now()
          ? ` (grace ${state.deadline - deps.now()} ms)`
          : ""
      }`,
    );
    try {
      deps.writeState({ state: persistedPhase(state), corePid: null, lastExit: state.common.lastExit });
    } catch (e) {
      deps.log(`login-daemon: cannot write state file: ${(e as Error).message}`);
    }

    for (;;) {
      const exitSeen = childExit;
      const inputs: TickInputs = {
        now: deps.now(),
        liveCore: deps.liveCore(child?.pid ?? null),
        stopRequested: deps.takeStop(),
        sigterm,
        bundleSig: deps.bundleSig(),
        childExit: exitSeen,
        childAlive: child !== null && childExit === null,
        childPid: child?.pid ?? null,
      };
      const res = step(state, inputs, deps.config);
      state = res.state;
      // The exit is delivered exactly once; the handle is released with it.
      if (exitSeen !== null) {
        child = null;
        childExit = null;
      }
      const code = execute(res.actions);
      if (code !== null) return code;
      await sleep(deps.tickMs);
    }
  };

  return {
    run,
    sigterm() {
      sigterm = true;
      poke();
    },
  };
}

// ---------------------------------------------------------------------------
// Real dependencies and the process entry point.

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function readVersion(bundle: string | undefined): string {
  if (bundle) {
    try {
      const v = JSON.parse(
        readFileSync(path.join(bundle, "Contents", "Resources", "version.json"), "utf8"),
      ) as { version?: unknown };
      if (typeof v.version === "string" && v.version) return v.version;
    } catch {
      /* fall through */
    }
  }
  return typeof pkg.version === "string" && pkg.version ? pkg.version : "dev";
}

function plistSignature(bundle: string): string | null {
  try {
    const st = statSync(path.join(bundle, "Contents", "Info.plist"));
    return `${st.ino}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

/** Resolve the core entry, or null with the reason logged. */
function resolveCoreEntry(bundle: string | undefined): string | null {
  const override = process.env.AGETOR_LOGIN_DAEMON_CORE;
  if (override) return override;
  if (bundle) return path.join(bundle, "Contents", "Resources", "app", "daemon", "headless.js");
  return null;
}

export async function main(): Promise<number> {
  const dataDir = resolveDataDir();
  const bundle = process.env.AGETOR_LOGIN_ITEM_BUNDLE || undefined;
  const coreEntry = resolveCoreEntry(bundle);
  if (!coreEntry) {
    daemonLog(
      "login-daemon: neither AGETOR_LOGIN_ITEM_BUNDLE nor AGETOR_LOGIN_DAEMON_CORE is set — nothing to run",
    );
    return 1;
  }
  const label = process.env.AGETOR_LOGIN_ITEM_LABEL ?? "";
  const version = readVersion(bundle);
  const startedAt = Date.now();

  const config: MachineConfig = {
    ...DEFAULT_CONFIG,
    handoffGraceMs: envMs("AGETOR_LOGIN_DAEMON_HANDOFF_GRACE_MS", DEFAULT_CONFIG.handoffGraceMs),
    updateGraceMs: envMs("AGETOR_LOGIN_DAEMON_UPDATE_GRACE_MS", DEFAULT_CONFIG.updateGraceMs),
  };
  const tickMs = envMs("AGETOR_LOGIN_DAEMON_TICK_MS", TICK_MS) || TICK_MS;

  const previous = readLoginDaemonState(dataDir);
  const marker = takeHandbackMarker(HANDBACK_MARKER_MAX_AGE_MS, dataDir);

  const supervisor = createSupervisor({
    now: () => Date.now(),
    tickMs,
    config,
    startup: { lastExit: previous?.lastExit, handbackMarker: marker !== null },
    liveCore(exceptPid) {
      // Pid liveness only — no HTTP probe every second. An app (`kind:"app"`)
      // counts, our own child does not.
      const creds = readCoreCreds(dataDir);
      if (!creds || creds.pid === process.pid) return false;
      if (exceptPid !== null && creds.pid === exceptPid) return false;
      return isPidAlive(creds.pid);
    },
    takeStop: () => takeSupervisorStop(dataDir),
    bundleSig: () => (bundle ? plistSignature(bundle) : undefined),
    spawnCore() {
      // Rotate-then-open: daemonLog truncates an oversized log on its first write.
      daemonLog(`login-daemon: spawning core ${coreEntry}`);
      const fd = openSync(daemonLogPath, "a");
      try {
        const proc = coreSpawn([process.execPath, coreEntry], {
          env: childEnv({ AGETOR_LAUNCHED_BY: "login-item" }),
          stdin: "ignore",
          stdout: fd,
          stderr: fd,
        });
        return {
          pid: proc.pid,
          kill: (signal) => {
            proc.kill(signal);
          },
          exited: proc.exited.then(() => ({
            code: proc.exitCode,
            signal: proc.signalCode ?? null,
          })),
        };
      } finally {
        // The child holds its own copy of the descriptor.
        closeSync(fd);
      }
    },
    writeState(fields) {
      writeLoginDaemonState(
        {
          pid: process.pid,
          state: fields.state,
          corePid: fields.corePid,
          bundlePath: bundle ?? "",
          version,
          label,
          startedAt,
          updatedAt: Date.now(),
          ...(fields.lastExit ? { lastExit: fields.lastExit } : {}),
        },
        dataDir,
      );
    },
    log: daemonLog,
  });

  const onSignal = (): void => supervisor.sigterm();
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  return supervisor.run();
}

if (import.meta.main) {
  void main().then(
    (code) => process.exit(code),
    (e) => {
      daemonLog(`login-daemon: fatal: ${(e as Error).stack ?? e}`);
      process.exit(1);
    },
  );
}

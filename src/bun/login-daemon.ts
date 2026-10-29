import { closeSync, openSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { childEnv, coreSpawn } from "./core-spawn.ts";
import {
  LIVE_CORE_CONNECT_TIMEOUT_MS,
  isPidAlive,
  portAcceptsConnections,
  probeLiveCore,
  readCoreCreds,
  resolveDataDir,
  type CoreCreds,
} from "./core-creds.ts";
import { daemonLog, daemonLogPath, rotateDaemonLogIfNeeded } from "./daemon-log.ts";
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
  SUPERVISOR_HEARTBEAT_MS,
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
  /** A live core (other than `exceptPid`, our own child) owns the port. May be
   *  async: the real one confirms over HTTP, not just by pid. */
  liveCore(exceptPid: number | null): boolean | Promise<boolean>;
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
  /** How often an otherwise idle supervisor refreshes its state file's
   *  heartbeat (default `SUPERVISOR_HEARTBEAT_MS`). */
  heartbeatMs?: number;
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
  let lastStateWriteAt = 0;
  const heartbeatMs = deps.heartbeatMs ?? SUPERVISOR_HEARTBEAT_MS;

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
            // A core that cannot even start is a crash: the machine's crash
            // backoff paces the retries.
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
          lastStateWriteAt = deps.now();
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
      liveCore: await deps.liveCore(null),
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
    lastStateWriteAt = deps.now();
    try {
      deps.writeState({ state: persistedPhase(state), corePid: null, lastExit: state.common.lastExit });
    } catch (e) {
      deps.log(`login-daemon: cannot write state file: ${(e as Error).message}`);
    }

    for (;;) {
      const exitSeen = childExit;
      const inputs: TickInputs = {
        now: deps.now(),
        liveCore: await deps.liveCore(child?.pid ?? null),
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
      // Idle heartbeat: lets readers tell this supervisor from a process that
      // recycled its pid (see `liveSupervisor`).
      if (deps.now() - lastStateWriteAt >= heartbeatMs) {
        execute([
          {
            type: "writeState",
            state: persistedPhase(state),
            ...(state.common.lastExit ? { lastExit: state.common.lastExit } : {}),
          },
        ]);
      }
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

/** How often the supervisor checks whether daemon.log needs rotating. */
const DAEMON_LOG_ROTATE_CHECK_MS = 60_000;

/** How long a confirmed verdict is reused before probing again. */
export const LIVE_CORE_PROBE_TTL_MS = 5_000;
/** Failed checks in a row before a core previously seen live is declared gone
 *  (one slow answer on a loaded machine must not make us boot a second core). */
export const LIVE_CORE_FAILURES_TO_DROP = 2;
export { LIVE_CORE_CONNECT_TIMEOUT_MS, portAcceptsConnections };

export interface LiveCoreCheckDeps {
  readCreds(): CoreCreds | null;
  selfPid: number;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  probe?: (creds: CoreCreds) => Promise<boolean>;
  /** Loopback connect check (`portAcceptsConnections`). */
  portListening?: (port: number) => Promise<boolean>;
  ttlMs?: number;
}

/**
 * "Does a live core own the port?", robust to a recycled pid AND to a core
 * that is alive but momentarily unresponsive.
 *
 * The creds file names a pid, but after a crash that pid can belong to an
 * unrelated process, and trusting it would park the supervisor behind nothing
 * forever. So a pid that has never answered is confirmed with `probeLiveCore`
 * (/health identifies agetor, authenticated /info accepts the token) — no
 * answer, no park.
 *
 * Once a creds key (pid + startedAt + port) has answered, a failed probe no
 * longer counts against it while its pid is alive and its port still accepts
 * connections: the app's Bun thread routinely blocks for seconds to minutes
 * while it keeps the port (native Open panels, `showMessageBox`, Compact's
 * VACUUM), and dropping it then would make the supervisor boot a core every
 * backoff step that only loses the bind. A recycled pid can't hide behind this:
 * a crashed core's port stops accepting, and a different key starts over at
 * "never answered". A failed probe whose port refuses counts towards
 * `LIVE_CORE_FAILURES_TO_DROP`.
 *
 * The probe runs at most once per `ttlMs` per key — the dead-pid and no-creds
 * cases cost nothing.
 */
export function createLiveCoreCheck(deps: LiveCoreCheckDeps): (exceptPid: number | null) => Promise<boolean> {
  const now = deps.now ?? Date.now;
  const alive = deps.isPidAlive ?? isPidAlive;
  const probe = deps.probe ?? ((c: CoreCreds) => probeLiveCore(c, 2_000));
  const portListening = deps.portListening ?? ((port: number) => portAcceptsConnections(port));
  const ttl = deps.ttlMs ?? LIVE_CORE_PROBE_TTL_MS;
  let cache: { key: string; at: number; live: boolean; confirmed: boolean; failures: number } | null = null;

  return async (exceptPid) => {
    const creds = deps.readCreds();
    if (!creds || creds.pid === deps.selfPid) return false;
    if (exceptPid !== null && creds.pid === exceptPid) return false;
    if (!alive(creds.pid)) return false;
    const key = `${creds.pid}:${creds.startedAt}:${creds.port}`;
    const t = now();
    if (cache && cache.key === key && t - cache.at < ttl) return cache.live;
    const prev = cache && cache.key === key ? cache : null;
    if (await probe(creds)) {
      cache = { key, at: t, live: true, confirmed: true, failures: 0 };
    } else if (prev?.confirmed && (await portListening(creds.port))) {
      // Answered before, pid alive, port held: busy, not gone.
      cache = { key, at: t, live: true, confirmed: true, failures: 0 };
    } else {
      const failures = (prev?.failures ?? 0) + 1;
      const live = prev?.live === true && failures < LIVE_CORE_FAILURES_TO_DROP;
      cache = { key, at: t, live, confirmed: prev?.confirmed ?? false, failures };
    }
    return cache.live;
  };
}

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

  // The core child writes daemon.log through an inherited descriptor, never
  // through daemonLog, so its output alone would never trigger rotation:
  // check on a slow timer (copy-truncate, so the child's O_APPEND fd keeps
  // writing into the live file). Unref'd: the supervisor loop keeps us alive.
  setInterval(() => {
    rotateDaemonLogIfNeeded();
  }, DAEMON_LOG_ROTATE_CHECK_MS).unref();

  const liveCoreCheck = createLiveCoreCheck({
    readCreds: () => readCoreCreds(dataDir),
    selfPid: process.pid,
  });

  const previous = readLoginDaemonState(dataDir);
  const marker = takeHandbackMarker(HANDBACK_MARKER_MAX_AGE_MS, dataDir);

  const supervisor = createSupervisor({
    now: () => Date.now(),
    tickMs,
    config,
    startup: { lastExit: previous?.lastExit, handbackMarker: marker !== null },
    liveCore: (exceptPid) => liveCoreCheck(exceptPid),
    takeStop: () => takeSupervisorStop(dataDir, { supervisorStartedAt: startedAt }),
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
          heartbeatAt: Date.now(),
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

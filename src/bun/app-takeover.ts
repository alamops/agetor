import type { CoreCreds } from "./core-creds.ts";
import { HANDOFF_LAUNCH_SETTLE_MS } from "./daemon-mode.ts";

/**
 * Binding the API port when the desktop app boots (docs/plans/always-on-host.md
 * §3.6, grill D6/C16). The port can be held by:
 *
 *  - a `cli-daemon` core — a daemon the CLI started, or the login-item core
 *    (its creds are `kind: "cli-daemon"` too). The app asks it to HAND OFF
 *    (`POST /daemon/shutdown {mode:"handoff"}`: a login-item core parks under its
 *    supervisor instead of exiting, a plain daemon exits), waits for the port,
 *    then binds and becomes the owner;
 *  - a daemon that has bound but not yet written its creds file, or a login race
 *    where the daemon is mid-boot: the creds read is racy for a moment, so the
 *    read and the bind are retried every 250 ms for up to 5 s (C16);
 *  - a live core whose JS thread is blocked (a VACUUM from `agetor compact`, a
 *    native panel): its pid is alive and the kernel still accepts connections
 *    on the port, but `/health` can't answer. The retry window then grows to
 *    `TAKEOVER_BLOCKED_CORE_WAIT_MS` instead of giving up after 5 s and exiting
 *    with "port held" while the core is merely busy;
 *  - another live app, or a foreign process (a stale agetor, OTLP gRPC which
 *    also defaults to 4317): neither is ours to evict, so this throws the
 *    original bind error and the caller fails loudly, as it always has.
 *
 * Every effect is injected, so the whole decision table runs under fakes (U5).
 * Generic over the server type so the unit tests need no real `Bun.serve`.
 */

export interface AcquireApiPortDeps<S> {
  /** Bind the API server; throws when the port is held. */
  start: () => S;
  /** The creds file of whichever core currently owns the port, or null. */
  readCreds: () => CoreCreds | null;
  /** True when `creds` names a live, authenticated core (`probeLiveCore`). */
  probe: (creds: CoreCreds) => Promise<boolean>;
  fetch: typeof fetch;
  /** Resolves true once nothing answers on `port` (`waitForPortFree`). */
  waitForPortFree: (port: number, timeoutMs: number) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Is `pid` still running (`isPidAlive`)? Omitted = never extend the wait. */
  isPidAlive?: (pid: number) => boolean;
  /** Does anything accept a loopback TCP connect on `port`
   *  (`portAcceptsConnections`)? Omitted = never extend the wait. */
  portListening?: (port: number) => Promise<boolean>;
  log?: (msg: string) => void;
}

/** How long the app keeps retrying when the port is held but no live creds name
 *  the holder (C16). */
export const TAKEOVER_RETRY_WINDOW_MS = 5_000;
/** How long the app keeps waiting, in all, while the creds name a core whose
 *  pid is alive and whose port accepts connections but whose probe fails — a
 *  blocked core that will answer once its thread is free. */
export const TAKEOVER_BLOCKED_CORE_WAIT_MS = 60_000;
/** Retry cadence inside that window. */
export const TAKEOVER_RETRY_INTERVAL_MS = 250;
/** How long to wait for a handed-off core to release the port: the core first
 *  waits up to `HANDOFF_LAUNCH_SETTLE_MS` for its in-flight agent launches,
 *  then needs a few seconds to tear down. */
export const TAKEOVER_PORT_FREE_TIMEOUT_MS = HANDOFF_LAUNCH_SETTLE_MS + 10_000;
/** Bound on the handoff request itself; the daemon drops the connection as it
 *  parks or exits, so a normal answer never takes this long. */
const HANDOFF_REQUEST_TIMEOUT_MS = 5_000;

export async function acquireApiPort<S>(deps: AcquireApiPortDeps<S>): Promise<S> {
  let firstError: unknown;
  try {
    return deps.start();
  } catch (e) {
    firstError = e;
  }

  const startedAt = deps.now();
  const deadline = startedAt + TAKEOVER_RETRY_WINDOW_MS;
  const blockedDeadline = startedAt + TAKEOVER_BLOCKED_CORE_WAIT_MS;
  let loggedBlocked = false;
  for (;;) {
    const creds = deps.readCreds();
    let blocked = false;
    if (creds) {
      let live = false;
      try {
        live = await deps.probe(creds);
      } catch {
        live = false;
      }
      if (live) {
        // A live app owner is not ours to evict; only a daemon hands off.
        if (creds.kind !== "cli-daemon") throw firstError;
        return await handOff(deps, creds, firstError);
      }
      // Only worth checking once the short window is spent.
      if (deps.now() >= deadline) blocked = await isBlockedCore(deps, creds);
    }
    if (blocked && !loggedBlocked) {
      loggedBlocked = true;
      deps.log?.(
        `[agetor] the core on port ${creds?.port} (pid ${creds?.pid}) is alive but not answering — waiting for it…`,
      );
    }
    if (deps.now() >= (blocked ? blockedDeadline : deadline)) throw firstError;
    await deps.sleep(TAKEOVER_RETRY_INTERVAL_MS);
    // The holder may have been a daemon between its bind and its creds write,
    // or a core that has just exited: bind again before re-reading the creds.
    try {
      return deps.start();
    } catch {
      /* still held — loop and look at the creds again */
    }
  }
}

/** The creds' core is running and its port is listening, so a failed probe
 *  means it is busy, not gone. */
async function isBlockedCore<S>(deps: AcquireApiPortDeps<S>, creds: CoreCreds): Promise<boolean> {
  if (!deps.isPidAlive || !deps.portListening) return false;
  if (!deps.isPidAlive(creds.pid)) return false;
  try {
    return await deps.portListening(creds.port);
  } catch {
    return false;
  }
}

async function handOff<S>(
  deps: AcquireApiPortDeps<S>,
  creds: CoreCreds,
  firstError: unknown,
): Promise<S> {
  deps.log?.("[agetor] a CLI daemon owns the API port — requesting handoff…");
  try {
    const res = await deps.fetch(`http://127.0.0.1:${creds.port}/daemon/shutdown`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode: "handoff" }),
      signal: AbortSignal.timeout(HANDOFF_REQUEST_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
  } catch {
    /* the daemon drops the connection as it parks or exits — expected */
  }
  if (!(await deps.waitForPortFree(creds.port, TAKEOVER_PORT_FREE_TIMEOUT_MS))) {
    throw firstError;
  }
  try {
    return deps.start();
  } catch {
    // Released the port but something else took it first: report the bind
    // problem the user would otherwise have hit.
    throw firstError;
  }
}

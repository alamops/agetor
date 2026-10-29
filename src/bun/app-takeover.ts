import type { CoreCreds } from "./core-creds.ts";

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
  log?: (msg: string) => void;
}

/** How long the app keeps retrying when the port is held but no live creds name
 *  the holder (C16). */
export const TAKEOVER_RETRY_WINDOW_MS = 5_000;
/** Retry cadence inside that window. */
export const TAKEOVER_RETRY_INTERVAL_MS = 250;
/** How long to wait for a handed-off core to release the port. */
export const TAKEOVER_PORT_FREE_TIMEOUT_MS = 10_000;
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

  const deadline = deps.now() + TAKEOVER_RETRY_WINDOW_MS;
  for (;;) {
    const creds = deps.readCreds();
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
    }
    if (deps.now() >= deadline) throw firstError;
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

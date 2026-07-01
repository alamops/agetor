import pkg from "../../package.json" with { type: "json" };
import { API_TOKEN } from "./api-config.ts";
import { db, dataDir } from "./db.ts";
import { reconcileOrphans } from "./orchestrator.ts";
import { startApiServer, attachedClientCount } from "./server.ts";
import { rehydratePath } from "./login-path.ts";
import { refreshDiscoveredModels } from "./agent-discovery.ts";
import {
  writeCoreCreds,
  removeCoreCreds,
  readCoreCreds,
  probeLiveCore,
} from "./core-creds.ts";
import { daemonLog } from "./daemon-log.ts";

/**
 * Headless Agetor core — the same Bun server + orchestrator the desktop app
 * runs, minus Electrobun (no window, menu, updater, or before-quit confirm).
 * The `agetor` CLI auto-spawns this when no live core exists so the CLI works
 * with the app closed; it shares the same `$AGETOR_DATA_DIR` state, so tasks
 * created here also show up in the app.
 *
 * `runDaemon` is exported (not run on import) so the compiled CLI binary can
 * carry the server stack but only boot it under the hidden `__daemon`
 * subcommand — every client command lazy-loads this module, so `bun src/cli`
 * never opens the database just to run `agetor ls`.
 */

const IDLE_CHECK_MS = 30_000;
/** Default idle-shutdown after 5 min with no run and no attached client.
 *  `AGETOR_DAEMON_IDLE_MS=0` disables idle shutdown (daemon stays up). */
const IDLE_TIMEOUT_MS = Number(
  process.env.AGETOR_DAEMON_IDLE_MS ?? 5 * 60 * 1000,
);

function hasRunningRuns(): boolean {
  try {
    return (
      db
        .query<{ one: number }, []>(
          "SELECT 1 AS one FROM runs WHERE status = 'running' LIMIT 1",
        )
        .get() != null
    );
  } catch {
    return false;
  }
}

let shuttingDown = false;
function shutdown(reason: string, code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  daemonLog(`shutting down (${reason})`);
  try {
    removeCoreCreds(dataDir);
  } catch {
    /* best-effort */
  }
  process.exit(code);
}

export async function runDaemon(): Promise<void> {
  process.env.AGETOR_HEADLESS = "1";
  daemonLog(`cli-daemon starting — pid ${process.pid}, version ${pkg.version}`);

  // Same PATH hydration + orphan reconciliation the app does at boot, so the
  // daemon can find claude/codex/tmux and doesn't leave stale "running" cards.
  rehydratePath();
  reconcileOrphans();
  void refreshDiscoveredModels();

  let server: ReturnType<typeof startApiServer>;
  try {
    server = startApiServer(); // no native deps → native routes return 501
  } catch (e) {
    // Port busy. If a live core already owns it (the app launched, or another
    // daemon won a startup race), exit quietly — the CLI re-discovers the
    // winner via the creds file. Otherwise it's a real conflict.
    const creds = readCoreCreds(dataDir);
    if (creds && (await probeLiveCore(creds))) {
      daemonLog("port already owned by a live core — exiting quietly");
      process.exit(0);
    }
    daemonLog(`failed to bind API: ${(e as Error)?.message ?? String(e)}`);
    process.exit(1);
  }

  writeCoreCreds(
    {
      // `server.port` is typed `number | undefined`, but a bound server always
      // has a numeric port.
      port: server.port!,
      token: API_TOKEN,
      pid: process.pid,
      kind: "cli-daemon",
      version: pkg.version,
      startedAt: Date.now(),
    },
    dataDir,
  );
  daemonLog(`cli-daemon listening on http://127.0.0.1:${server.port}`);

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Idle-shutdown loop: exit once nothing is running AND no client is attached
  // for longer than the timeout. The interval is unref'd so it never keeps the
  // process alive on its own — the listening server does that.
  if (IDLE_TIMEOUT_MS > 0) {
    let idleSince: number | null = null;
    const timer = setInterval(() => {
      if (hasRunningRuns() || attachedClientCount() > 0) {
        idleSince = null;
        return;
      }
      if (idleSince == null) idleSince = Date.now();
      else if (Date.now() - idleSince >= IDLE_TIMEOUT_MS) shutdown("idle timeout");
    }, IDLE_CHECK_MS);
    timer.unref();
  }
}

// `bun src/bun/headless.ts` runs the daemon directly (dev); importing this
// module from the CLI bundle does not.
if (import.meta.main) void runDaemon();

import pkg from "../../package.json" with { type: "json" };
import { API_TOKEN } from "./api-config.ts";
import { db, dataDir, subagents } from "./db.ts";
import { reconcileOrphans, reapIdleSessions } from "./orchestrator.ts";
import { startApiServer, attachedClientCount } from "./server.ts";
import { rehydratePath } from "./login-path.ts";
import { refreshDiscoveredModels } from "./agent-discovery.ts";
import { reapLiveFxProcs } from "./fx-acp.ts";
import {
  writeCoreCreds,
  removeCoreCreds,
  readCoreCreds,
  probeLiveCore,
} from "./core-creds.ts";
import { daemonLog } from "./daemon-log.ts";
import { SESSION_REAP_SWEEP_MS, USAGE_POLL_SWEEP_MS } from "../shared/types.ts";
import { pollAllUsage } from "./usage/poller.ts";

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
/** Default idle-shutdown after 5 min with no run, no running background
 *  agent/workflow, and no attached client.
 *  `AGETOR_DAEMON_IDLE_MS=0` disables idle shutdown (daemon stays up). */
const IDLE_TIMEOUT_MS = Number(
  process.env.AGETOR_DAEMON_IDLE_MS ?? 5 * 60 * 1000,
);

/** Ceiling on how long a `running` subagent row alone can hold the daemon up.
 *  Two row classes can never settle on their own: workflow container rows are
 *  deliberately exempt from the `STALE_SUBAGENT_SETTLE_MS` backstop
 *  (claude-subagents.ts) — they're settled only by their completion
 *  notification or user action — and rows created while
 *  `AGETOR_TRACK_SUBAGENTS=0` is set are no-op stubs nothing will ever flip
 *  to `completed`. Without a ceiling either one pins the daemon alive
 *  forever. Past this ceiling the daemon may idle-exit exactly as it did
 *  before this feature existed: the detached tmux session survives the exit,
 *  and the next boot's `reconcileOrphans` reattaches or orphans it. */
const SUBAGENT_HOLD_MAX_MS = 6 * 60 * 60 * 1000; // 6h

/** Set once a swallowed `hasRunningWork` error has been logged, so a
 *  sustained failure (e.g. SQLITE_BUSY) doesn't spam the log every 30s —
 *  but a daemon that idle-exited during a DB failure window is still
 *  diagnosable from the single line it did emit. */
let loggedHasRunningWorkError = false;

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

/** Daemon-wide "is anything still working?" — running runs OR running
 *  background agents/workflows (subagent rows started within
 *  `SUBAGENT_HOLD_MAX_MS`). Exported for tests. */
export function hasRunningWork(): boolean {
  if (hasRunningRuns()) return true;
  try {
    return subagents.hasAnyRunning(Date.now() - SUBAGENT_HOLD_MAX_MS);
  } catch (err) {
    if (!loggedHasRunningWorkError) {
      loggedHasRunningWorkError = true;
      daemonLog(
        `hasRunningWork: subagents.hasAnyRunning failed, treating as idle: ${(err as Error)?.message ?? String(err)}`,
      );
    }
    return false;
  }
}

let shuttingDown = false;
function shutdown(reason: string, code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  daemonLog(`shutting down (${reason})`);
  // fx-acp.ts's own SIGINT/SIGTERM/SIGHUP handlers always reap `fx acp`
  // children but only call `process.exit` themselves when they're the sole
  // listener for that signal — since this module registers its own
  // SIGINT/SIGTERM handlers below (making fx-acp's handler NOT the sole
  // listener), fx-acp steps back and this shutdown path is what actually
  // owns the exit sequence. That means this is also the path responsible for
  // reaping any live fx children — do it explicitly, before the rest of
  // teardown, rather than relying on fx-acp's handler to have done it.
  reapLiveFxProcs();
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

  // Idle-session reaper (docs/plans/reduce-cpu-and-memory.md §3.1, T4):
  // mirrors index.ts's wiring so the headless daemon doesn't accumulate the
  // same idle claude REPLs the desktop app now reaps. A 30s delay before the
  // first sweep lets `reconcileOrphans` above finish reattaching live
  // sessions first. Both timers are `.unref()`'d — like the idle-shutdown
  // timer below, a reap timer must never be what keeps this process alive;
  // the daemon's own idle-shutdown path (and its resulting `process.exit`)
  // has to remain reachable regardless of these firing.
  const reapPostBootTimer = setTimeout(() => {
    reapIdleSessions().catch((err) => {
      daemonLog(`idle-session reap (post-boot) failed: ${(err as Error)?.message ?? String(err)}`);
    });
  }, 30_000);
  reapPostBootTimer.unref();
  const reapIntervalTimer = setInterval(() => {
    reapIdleSessions().catch((err) => {
      daemonLog(`idle-session reap (interval) failed: ${(err as Error)?.message ?? String(err)}`);
    });
  }, SESSION_REAP_SWEEP_MS);
  reapIntervalTimer.unref();

  // Per-harness usage poller (docs/plans/harness-usage-tracker.md §7): mirrors
  // index.ts's wiring so the headless daemon also keeps quota snapshots fresh.
  // Both timers are `.unref()`'d — usage polling stops the moment the daemon
  // idle-shuts, by design, since there's no attached UI left to update.
  const usagePostBootTimer = setTimeout(() => {
    pollAllUsage().catch((err) => {
      daemonLog(`usage poll (post-boot) failed: ${(err as Error)?.message ?? String(err)}`);
    });
  }, 20_000);
  usagePostBootTimer.unref();
  const usageIntervalTimer = setInterval(() => {
    pollAllUsage().catch((err) => {
      daemonLog(`usage poll sweep failed: ${(err as Error)?.message ?? String(err)}`);
    });
  }, USAGE_POLL_SWEEP_MS);
  usageIntervalTimer.unref();

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
      if (hasRunningWork() || attachedClientCount() > 0) {
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

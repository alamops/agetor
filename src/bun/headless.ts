import pkg from "../../package.json" with { type: "json" };
import { CLI_TOKEN, formatHostForUrl, getApiPort, resolveApiHost } from "./api-config.ts";
import { db, dataDir, subagents, preferences } from "./db.ts";
import { reconcileOrphans, rearmFxAutoResumes, reapIdleSessions, stopFxAutoResumeTimers } from "./orchestrator.ts";
import { initPipelineRunner, reconcilePipelineRuns } from "./pipeline-runner.ts";
import { startLagMonitor, stopLagMonitor } from "./event-loop-lag.ts";
import { scheduleRetention, stopRetentionTimers } from "./retention.ts";
import { ensureDisclaimedServer } from "./tmux-resolution.ts";
import { DISCLAIM_PREF_KEY } from "./disclaim.ts";
import { initDisclaimSwitch } from "./disclaim-switch.ts";
import { startApiServer, attachedClientCount } from "./server.ts";
import { rehydratePath } from "./login-path.ts";
import { refreshAllModels, startPeriodicDiscovery } from "./model-discovery.ts";
import { reapLiveFxProcs } from "./fx-acp.ts";
import {
  writeCoreCreds,
  removeCoreCreds,
  readCoreCreds,
  probeLiveCore,
} from "./core-creds.ts";
import { daemonLog } from "./daemon-log.ts";
import { bootReadySignal } from "./boot-gate.ts";
import { CORE_EXIT_PARK, launchedBy, resolveIdleTimeoutMs } from "./daemon-mode.ts";
import {
  installHeadlessNotifications,
  isHeadlessNotificationsEnabled,
  type HeadlessNotificationSink,
} from "./headless-notifications.ts";
import { SESSION_REAP_SWEEP_MS, USAGE_POLL_SWEEP_MS } from "../shared/types.ts";
import { pollAllUsage } from "./usage/poller.ts";
import { resumeIncompleteImports } from "./claude-session-import.ts";
import { resumeIncompleteOpencodeImports } from "./opencode-session-import.ts";
import { checkAllHarnesses } from "./agent-status.ts";
import { applyHarnessAutoEnable } from "./harness-auto-enable.ts";

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
// The idle-shutdown timeout comes from `resolveIdleTimeoutMs()` (daemon-mode.ts),
// read when `runDaemon` starts: a CLI-spawned daemon exits after 5 min with no
// run, no running background agent/workflow and no attached client; the
// background login-item core never idle-exits; `AGETOR_DAEMON_IDLE_MS`
// overrides both (`0` = never). See docs/plans/always-on-host.md §1 item 2.

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
/** True once THIS process wrote the creds file. A core that never bound (it
 *  lost the port to a live core, or got a signal mid-boot) must not delete the
 *  winner's creds on its way out. */
let ownsCreds = false;
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
  // Same reasoning for the auto-resume engine's in-memory timers (Phase 8
  // review #7): `fxAutoResumeTimers` entries are `.unref()`'d so they never
  // block a clean exit on their own, but stopping them explicitly here keeps
  // shutdown from racing a timer that fires mid-teardown (spawning a new fx
  // run against a process that's already tearing everything else down). Does
  // not touch any persisted `fxRecovery` row — `rearmFxAutoResumes()` re-arms
  // them from the DB on the next boot.
  stopFxAutoResumeTimers();
  // Retention: abort a running pass between chunks and clear its timers; stop
  // the lag sampler. Trimmed rows stay trimmed, the next boot resumes.
  stopRetentionTimers();
  stopLagMonitor();
  // Remove the creds file only when it is still ours: the pid check also
  // covers a successor (the app taking over) that already rewrote it.
  if (ownsCreds && readCoreCreds(dataDir)?.pid === process.pid) {
    try {
      removeCoreCreds(dataDir);
    } catch {
      /* best-effort */
    }
  }
  process.exit(code);
}

export async function runDaemon(): Promise<void> {
  process.env.AGETOR_HEADLESS = "1";
  const mode = launchedBy();
  const isLoginItem = mode === "login-item";
  const idleTimeoutMs = resolveIdleTimeoutMs();
  daemonLog(
    `cli-daemon starting — pid ${process.pid}, version ${pkg.version}, launchedBy=${mode}, idle=${idleTimeoutMs > 0 ? idleTimeoutMs : "off"}`,
  );
  // Signal handlers go in first, not after the bind: the login-item supervisor
  // SIGTERMs its core child whenever launchd stops the job, which can land
  // mid-boot. `shutdown()` only removes creds this process wrote.
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Validate AGETOR_API_HOST before any boot work. An unusable value would
  // otherwise only surface at bind time, where Bun reports it as "Is port N in
  // use?" and the catch below would treat it as a port conflict. Logged to
  // stderr as well as daemon.log so a foreground run (e.g. a container's
  // entrypoint) shows it too.
  const apiHost = resolveApiHost();
  if (!apiHost.ok) {
    daemonLog(`refusing to start: ${apiHost.error}`);
    console.error(`[agetor] refusing to start: ${apiHost.error}`);
    process.exit(1);
  }

  // Same PATH hydration + orphan reconciliation the app does at boot, so the
  // daemon can find claude/codex/tmux and doesn't leave stale "running" cards.
  // Same order as index.ts's desktop boot path (boot-gate.ts): bind, then
  // restore, then `markBootReady()`. Routes wait on the ready signal, so the
  // API never serves `/tasks`/`/runs` while a `status='running'` row from a
  // previous process is still being reattached or flipped to `orphaned`
  // underneath it (CLAUDE.md §5). A restore throw is logged and ends the
  // process with exit 1 — no swallow.
  rehydratePath();
  // Event-loop lag monitor (docs/plans/non-blocking-session-restore.md, decision
  // C): one `.unref()`'d sampler that names whatever held the single main thread
  // for >= 1 s (a labelled `beginLagLabel` span, else a bare "no label" warning).
  // `sampleMs: 100`, not the 500 ms default: lag is measured as actual - expected
  // fire time, so a block that starts mid-interval is under-measured by up to
  // `sampleMs`; at 100 ms a 1.1 s block reliably crosses the 1 s stall bar.
  // Started BEFORE the boot restore below (not after the API is up) so the
  // `boot reattach` / `reattach session` / watcher-seed labels it exists to
  // attribute are actually sampled. Unref'd, so an early boot failure can never
  // be held open by it; every shutdown path calls `stopLagMonitor()`.
  startLagMonitor({ sampleMs: 100 });

  // Bind BEFORE the boot restore (boot-gate.ts): the bind is the ownership
  // claim. A core that loses the port exits before it reattaches a session or
  // touches a run the owner is driving (at login the app and this core can
  // race for the port).
  const { ready: bootReady, markReady: markBootReady } = bootReadySignal();

  // Headless OS notifications (docs/plans/always-on-host.md §3.7): the core
  // posts the same one-per-task notifications the app's webview does, since
  // no webview is around to decide. Installed only after the bind (a core
  // that loses the port must not post), so the server gets a forwarding sink
  // that drops anything sent before then.
  // Passed to the server only when headless notifications are on, so a core
  // that never posts keeps answering `POST /notifications` with 501 — the CLI's
  // `logs --notify` then falls back to the installed app's helper instead of
  // reading a silent drop as delivered.
  let notificationSink: HeadlessNotificationSink | null = null;
  const notifications = isHeadlessNotificationsEnabled()
    ? {
        post: (n: Parameters<HeadlessNotificationSink["post"]>[0]) => notificationSink?.post(n),
        remove: (r: Parameters<HeadlessNotificationSink["remove"]>[0]) => notificationSink?.remove(r),
      }
    : undefined;

  let server: ReturnType<typeof startApiServer>;
  try {
    // No native deps → native routes return 501.
    server = startApiServer({
      hostname: apiHost.host,
      notifications,
      // `POST /daemon/shutdown`: "stop" exits 0 (for a login-item core, its
      // supervisor then stays stopped until the next login); "handoff" is the
      // app taking the port, which a login-item core answers with
      // CORE_EXIT_PARK so its supervisor parks and boots it again once the
      // app quits. A CLI daemon exits 0 either way, as before.
      // Every route but the ownership probes (and /daemon/shutdown, so the app
      // can take the port from a core that is still booting) waits for the
      // boot restore below.
      ready: bootReady,
      onShutdownRequest: (request) =>
        shutdown(
          `shutdown request (${request})`,
          request === "handoff" && isLoginItem ? CORE_EXIT_PARK : 0,
        ),
    });
  } catch (e) {
    // Port busy. If a live core already owns it (the app launched, or another
    // daemon won a startup race), exit quietly — the CLI re-discovers the
    // winner via the creds file. Nothing was restored yet, so a losing core
    // never touched the winner's runs. A login-item core exits CORE_EXIT_PARK
    // either way: with a live owner its supervisor parks; with no readable
    // owner (the app between its bind and its creds write, or a foreign
    // process) the supervisor waits and retries with backoff instead of
    // counting a crash. Otherwise it's a real conflict.
    const creds = readCoreCreds(dataDir);
    if (creds && (await probeLiveCore(creds))) {
      daemonLog("port already owned by a live core — exiting quietly");
      process.exit(isLoginItem ? CORE_EXIT_PARK : 0);
    }
    daemonLog(
      `failed to bind API on ${formatHostForUrl(apiHost.host)}:${getApiPort()}: ${(e as Error)?.message ?? String(e)}`,
    );
    process.exit(isLoginItem ? CORE_EXIT_PARK : 1);
  }

  writeCoreCreds(
    {
      // `server.port` is typed `number | undefined`, but a bound server always
      // has a numeric port.
      port: server.port!,
      // The CLI-scoped token, never the master (D3): this file is readable by
      // anything running as the user, an agent included, so it carries only the
      // credential the CLI routes need. The master stays in memory (the app's
      // webview gets it by other means; a headless core has none).
      token: CLI_TOKEN,
      pid: process.pid,
      kind: "cli-daemon",
      version: pkg.version,
      startedAt: Date.now(),
      // C15: `kind` stays "cli-daemon" so older CLIs and apps still hand off
      // from it; the extra field tells newer ones it's the background core.
      ...(isLoginItem ? { launchedBy: "login-item" as const } : {}),
    },
    dataDir,
  );
  ownsCreds = true;

  // A restore that throws must not leave a bound server whose routes wait on a
  // ready signal that never comes.
  try {
    // Must run before reconcileOrphans(): reconciliation issues `has-session`
    // probes against agetor's tmux socket, and the first tmux command to
    // touch a socket auto-starts its server — un-disclaimed, if this didn't
    // run first — leaving every session that server ever hosts un-disclaimed
    // too.
    //
    // The disclaim switch is decided first (docs/plans/master-token-agent-read.md
    // P4/P5, D6): headless has no dialog, so the switch is always on and a stored
    // "off" (which an agent could have written to the SQLite file) is ignored
    // with one log line. It has to be settled before any agent host starts.
    await initDisclaimSwitch("headless", {
      readPref: () => preferences.get(DISCLAIM_PREF_KEY),
      writePref: (v) => preferences.set(DISCLAIM_PREF_KEY, v),
      log: daemonLog,
    });
    await ensureDisclaimedServer();
    // Same ordering as index.ts's desktop boot path: wire the pipeline runner
    // to the global lifecycle stream before reconcileOrphans() so a step
    // task's boot-time orphan→ready transition reaches it too.
    initPipelineRunner();
    await reconcileOrphans();
    // M16: same ordering as index.ts's desktop boot path — reconcile every
    // pipeline parent left mid-flight by a prior crash/restart right after
    // reconcileOrphans() resolves every step task's own orphan→ready
    // transition. `daemonLog`, not `console.log` — see the rearm comment below.
    const reconciledPipelineRunCount = await reconcilePipelineRuns();
    if (reconciledPipelineRunCount > 0) {
      daemonLog(`reconciled ${reconciledPipelineRunCount} pipeline run(s)`);
    }
    // Re-arm in-memory auto-resume timers for every fx task still carrying a
    // pending schedule — same rationale as index.ts's desktop boot path (see
    // its comment): an in-memory `setTimeout` handle never survives a process
    // restart. `daemonLog`, not `console.log` — this process has no console a
    // user can see.
    const rearmedFxAutoResumeCount = await rearmFxAutoResumes();
    if (rearmedFxAutoResumeCount > 0) {
      daemonLog(`re-armed ${rearmedFxAutoResumeCount} fx auto-resume(s)`);
    }
  } catch (err) {
    daemonLog(`boot restore failed: ${(err as Error)?.stack ?? String(err)}`);
    shutdown("boot restore failed", 1);
    return;
  }
  // Same boot-sweep + periodic-refresh pair as index.ts's desktop boot path
  // (see its comment for the full rationale) — the daemon needs the same
  // model-discovery freshness the app gets, and `startPeriodicDiscovery`'s
  // timer is `.unref()`'d internally, satisfying this file's rule that a
  // background timer must never be what keeps the daemon alive past its own
  // idle-shutdown path.
  void refreshAllModels();
  startPeriodicDiscovery();

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



  // The boot restore is done: let the routes through.
  markBootReady();

  // The desktop process resumes a crashed Claude import from its launch scan.
  // This process never runs that scan, so resume here too — otherwise a task
  // left `importing` stays unable to Send. Scheduled only after the API binds:
  // a process that fails to bind and exits after probing the live core must
  // not start backfill. Deferred so it does not block the listener coming up;
  // unref'd so a quiet daemon can still idle-shut. The next boot continues
  // from the stored offset.
  const importResumeTimer = setTimeout(() => {
    resumeIncompleteImports().catch((err) => {
      daemonLog(`claude session import resume failed: ${(err as Error)?.message ?? String(err)}`);
    });
  }, 0);
  importResumeTimer.unref();

  // Same for an OpenCode import left `importing` by a crash.
  const opencodeImportResumeTimer = setTimeout(() => {
    resumeIncompleteOpencodeImports().catch((err) => {
      daemonLog(`opencode session import resume failed: ${(err as Error)?.message ?? String(err)}`);
    });
  }, 0);
  opencodeImportResumeTimer.unref();

  // D-14: turn on built-in harnesses whose CLI is installed. Once, after the
  // API binds; `GET /harnesses` repeats it as CLIs appear later. Never blocks
  // boot, and a failed probe only skips this pass.
  setTimeout(() => {
    checkAllHarnesses()
      .then((statuses) => applyHarnessAutoEnable(statuses))
      .catch((err) => {
        daemonLog(`harness auto-enable failed: ${(err as Error)?.message ?? String(err)}`);
      });
  }, 0).unref();

  // Archived-history retention: first pass ~90 s after boot (after the API is
  // up and restore/seed work has settled), then every 24 h; each fire reads the
  // preference fresh. Also re-armed on demand by `PUT /preferences/...`.
  scheduleRetention();

  // A non-loopback bind's warning is printed once by startApiServer, to
  // stderr — which `spawnDaemon` points at this same daemon.log.
  daemonLog(`cli-daemon listening on http://${formatHostForUrl(apiHost.host)}:${server.port}`);

  if (notifications) {
    try {
      notificationSink = installHeadlessNotifications().sink;
    } catch (err) {
      daemonLog(`headless notifications unavailable: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  // Idle-shutdown loop: exit once nothing is running AND no client is attached
  // for longer than the timeout. The interval is unref'd so it never keeps the
  // process alive on its own — the listening server does that.
  if (idleTimeoutMs > 0) {
    let idleSince: number | null = null;
    const timer = setInterval(() => {
      if (hasRunningWork() || attachedClientCount() > 0) {
        idleSince = null;
        return;
      }
      if (idleSince == null) idleSince = Date.now();
      else if (Date.now() - idleSince >= idleTimeoutMs) shutdown("idle timeout");
    }, IDLE_CHECK_MS);
    timer.unref();
  }
}

// `bun src/bun/headless.ts` runs the daemon directly (dev); importing this
// module from the CLI bundle does not.
if (import.meta.main) void runDaemon();

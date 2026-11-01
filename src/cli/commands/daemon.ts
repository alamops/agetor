import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ensureCore, stopCore, waitForCore } from "../daemon/supervisor.ts";
import { AgetorClient, ApiError, discoverCore, type CoreInfo } from "../api-client.ts";
import { resolveDataDir } from "../../bun/core-creds.ts";
import {
  loginItemHelper,
  type HelperInfo,
  type LoginItemHelper,
} from "../../bun/login-item-helper.ts";
import {
  liveSupervisor,
  requestSupervisorStop,
} from "../../bun/login-daemon-state.ts";
// A leaf on purpose: `background.ts` (the controller) imports db.ts, which
// would open and migrate the user's SQLite just to print a status line.
import { deriveBackgroundStatus } from "../../bun/background-derive.ts";
import type {
  BackgroundRegistration,
  BackgroundStatus,
  BackgroundUnavailableReason,
} from "../../shared/types.ts";
import { escapeControlChars } from "../../shared/terminal-text.ts";
import { ensureOpts } from "../context.ts";
import { c, out, printJson } from "../output.ts";
import type { Flags } from "../context.ts";

const DAEMON_USAGE =
  "usage: agetor daemon <status | start | stop | background [status | off]>";

/** How long `daemon start` waits for the login-item core to come up after
 *  re-registering it (plan C17). */
const BACKGROUND_START_WAIT_MS = 20_000;

/** Drop the token before printing — creds are secret. */
function publicCore(core: CoreInfo) {
  return {
    kind: core.kind,
    pid: core.pid,
    port: core.port,
    version: core.version,
    startedAt: core.startedAt,
    launchedBy: core.launchedBy ?? null,
  };
}

const UNAVAILABLE_TEXT: Record<BackgroundUnavailableReason, string> = {
  "not-macos": "only available on macOS",
  "dev-build": "not available in a dev build",
  unsigned: "this build is not signed",
  "not-in-applications": "Agetor is not installed in Applications",
  "helper-missing": "the login-item helper is missing from this install",
  "other-install": "another Agetor install owns the login item",
  "helper-failed": "the login-item helper failed",
};

/** One human line for `BackgroundStatus` (state first, then who/where). */
export function formatBackground(b: BackgroundStatus): string {
  const ids: string[] = [];
  if (b.label) ids.push(b.label);
  if (b.supervisorPid !== null) ids.push(`supervisor pid ${b.supervisorPid}`);
  if (b.corePid !== null) ids.push(`core pid ${b.corePid}`);
  let head: string;
  switch (b.state) {
    case "running":
      head = c.green("running");
      break;
    case "parked":
      head = c.cyan("parked") + c.dim(" (the app owns the port)");
      break;
    case "starting":
      head = c.cyan("starting");
      break;
    case "stopped":
      head =
        c.yellow("stopped") +
        c.dim(" (turned on, but not running — `agetor daemon start` starts it)");
      break;
    case "needs-approval":
      head =
        c.yellow("needs approval") +
        c.dim(" (allow Agetor in System Settings › Login Items)");
      break;
    case "off":
      head = c.gray("off");
      break;
    case "unavailable":
      head =
        c.gray("unavailable") +
        (b.unavailableReason ? c.dim(` (${UNAVAILABLE_TEXT[b.unavailableReason]})`) : "");
      break;
  }
  const tail = ids.length ? c.dim(` · ${ids.join(" · ")}`) : "";
  const detail = b.detail ? c.dim(` — ${escapeControlChars(b.detail)}`) : "";
  return `${head}${tail}${detail}`;
}

/**
 * The background state with no core to ask (plan D2): the installed app's
 * login-item helper plus the supervisor's state file, fed through the same
 * derivation the core uses. Never starts a daemon. `remoteAccess` is `false`
 * here — it lives in the core's database, which a CLI with no core can't read.
 */
async function offlineBackground(
  dataDir: string,
): Promise<{ status: BackgroundStatus; helper: LoginItemHelper | null }> {
  const helper = loginItemHelper(dataDir, { forCli: true });
  let info: HelperInfo | null = null;
  let registration: BackgroundRegistration | null = null;
  let helperError: string | undefined;
  if (helper) {
    try {
      info = await helper.info();
      registration = await helper.status();
    } catch (e) {
      helperError = e instanceof Error ? e.message : String(e);
    }
  }
  const status = deriveBackgroundStatus({
    platform: process.platform,
    info,
    helperError,
    registration,
    supervisor: liveSupervisor(dataDir),
    isLoginItemCore: false,
    selfPid: null,
    dataDir,
    home: homedir(),
    remoteAccess: false,
  });
  return { status, helper };
}

/**
 * Background status for `daemon status` / `daemon background status`: ask the
 * live core when there is one, derive it offline when there isn't. `null`
 * means a live core that couldn't answer (one older than this CLI).
 */
async function backgroundFor(
  core: CoreInfo | null,
  dataDir: string,
): Promise<{ status: BackgroundStatus | null; note?: string }> {
  if (!core) return { status: (await offlineBackground(dataDir)).status };
  try {
    return { status: await new AgetorClient(core).getBackground() };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      return { status: null, note: "the running agetor core is older than this CLI" };
    }
    return { status: null, note: e instanceof Error ? e.message : String(e) };
  }
}

function backgroundLine(b: { status: BackgroundStatus | null; note?: string }): string {
  return `background: ${
    b.status ? formatBackground(b.status) : c.dim(`unknown — ${escapeControlChars(b.note ?? "")}`)
  }`;
}

export async function cmdDaemon(args: string[], flags: Flags): Promise<void> {
  const sub = args[0] ?? "status";
  const dataDir = flags.dataDir ?? resolveDataDir();
  // `parseArgs` leaves any non-global flag in the positionals, so a stray
  // `--foo` lands here and is refused the way the house commands refuse it.
  if (sub !== "background" && args.length > 1) throw new Error(DAEMON_USAGE);
  switch (sub) {
    case "start": {
      const live = await discoverCore(flags.dataDir);
      if (!live) {
        const { status, helper } = await offlineBackground(dataDir);
        // Enabled in macOS but no supervisor alive (it was stopped until the
        // next login): bring the login item back instead of starting an
        // unrelated CLI daemon next to it (plan C17).
        if (status.state === "stopped" && helper) {
          const res = await helper.reregister();
          if (!res.ok) {
            throw new Error(
              `could not start the background core: ${escapeControlChars(
                res.error?.message ?? "the login-item helper refused",
              )}`,
            );
          }
          const core = await waitForCore(flags.dataDir, BACKGROUND_START_WAIT_MS);
          if (!core) {
            throw new Error(
              `the background core did not come up within ${BACKGROUND_START_WAIT_MS / 1000}s — see ${path.join(dataDir, "daemon.log")}`,
            );
          }
          if (flags.json) return printJson(publicCore(core));
          out(
            `${c.green("●")} started the background core — 127.0.0.1:${core.port} · v${core.version} · pid ${core.pid}`,
          );
          return;
        }
      }
      const core = live ?? (await ensureCore(ensureOpts(flags)));
      if (flags.json) return printJson(publicCore(core));
      const what =
        core.kind === "app" ? "already running (app)" : "ready (cli-daemon)";
      out(
        `${c.green("●")} core ${what} — 127.0.0.1:${core.port} · v${core.version} · pid ${core.pid}`,
      );
      return;
    }
    case "stop": {
      const { stopped, launchedBy } = await stopCore(flags.dataDir);
      if (stopped) {
        if (flags.json) return printJson({ stopped, launchedBy: launchedBy ?? null });
        out(
          launchedBy === "login-item"
            ? `${c.yellow("○")} stopped — the background core starts again at next login (turn it off with \`agetor daemon background off\`)`
            : `${c.yellow("○")} shutdown requested`,
        );
        return;
      }
      // No core, but the login-item supervisor may be idling between children
      // (`waiting`) and about to boot one: ask it to stand down.
      const supervisor = liveSupervisor(dataDir);
      if (supervisor?.state === "waiting") {
        requestSupervisorStop(dataDir);
        if (flags.json) return printJson({ stopped: false, supervisorStopRequested: true });
        out(
          `${c.yellow("○")} no core was running — asked the background supervisor (pid ${supervisor.pid}) to stand down`,
        );
        return;
      }
      if (flags.json) return printJson({ stopped: false });
      out(`${c.gray("○")} no core was running`);
      return;
    }
    case "status": {
      const core = await discoverCore(flags.dataDir);
      const background = await backgroundFor(core, dataDir);
      if (flags.json) {
        return printJson(
          core
            ? { running: true, ...publicCore(core), background: background.status }
            : { running: false, background: background.status },
        );
      }
      if (!core) {
        out(`${c.gray("○")} no Agetor core running`);
        out(backgroundLine(background));
        return;
      }
      out(
        `${c.green("●")} ${c.bold(core.kind)}${
          core.launchedBy ? ` · launchedBy ${core.launchedBy}` : ""
        } · 127.0.0.1:${core.port} · v${core.version} · pid ${core.pid}`,
      );
      out(backgroundLine(background));
      tailLog(flags.dataDir);
      return;
    }
    case "background":
      return cmdDaemonBackground(args.slice(1), flags, dataDir);
    default:
      throw new Error(
        `unknown daemon subcommand: ${escapeControlChars(sub)} (use start | stop | status | background)`,
      );
  }
}

async function cmdDaemonBackground(
  args: string[],
  flags: Flags,
  dataDir: string,
): Promise<void> {
  const sub = args[0] ?? "status";
  if (args.length > 1) throw new Error(DAEMON_USAGE);
  switch (sub) {
    case "status": {
      // Stays offline when no core is live — it must never start a daemon.
      const background = await backgroundFor(await discoverCore(flags.dataDir), dataDir);
      if (flags.json) return printJson(background.status);
      out(backgroundLine(background));
      return;
    }
    case "off": {
      const core = await ensureCore(ensureOpts(flags));
      let status: BackgroundStatus;
      try {
        status = await new AgetorClient(core).turnOffBackground();
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          throw new Error("the running agetor core is older than this CLI — restart or update it");
        }
        throw e;
      }
      if (flags.json) return printJson(status);
      out(backgroundLine({ status }));
      return;
    }
    default:
      throw new Error(
        `unknown daemon background subcommand: ${escapeControlChars(sub)} (use status | off)`,
      );
  }
}

function tailLog(dataDir: string | undefined, n = 6): void {
  const logPath = path.join(dataDir ?? resolveDataDir(), "daemon.log");
  try {
    const lines = readFileSync(logPath, "utf8")
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      // A status check wants recent activity, not the boot roster — drop the
      // verbose migration list and the PATH probe.
      .filter((l) => !/applied migrations|PATH rehydrated/.test(l));
    if (lines.length) {
      out(c.dim(`\n${logPath}:`));
      for (const l of lines.slice(-n)) out(c.dim("  " + l));
    }
  } catch {
    /* no log yet */
  }
}

import { readFileSync } from "node:fs";
import path from "node:path";
import { ensureCore, stopDaemon } from "../daemon/supervisor.ts";
import { discoverCore, type CoreInfo } from "../api-client.ts";
import { resolveDataDir } from "../../bun/core-creds.ts";
import { c, out, printJson } from "../output.ts";
import type { Flags } from "../context.ts";

/** Drop the token before printing — creds are secret. */
function publicCore(core: CoreInfo) {
  return {
    kind: core.kind,
    pid: core.pid,
    port: core.port,
    version: core.version,
    startedAt: core.startedAt,
  };
}

export async function cmdDaemon(args: string[], flags: Flags): Promise<void> {
  const sub = args[0] ?? "status";
  switch (sub) {
    case "start": {
      const core = await ensureCore({ dataDir: flags.dataDir, port: flags.port });
      if (flags.json) return printJson(publicCore(core));
      const what =
        core.kind === "app" ? "already running (app)" : "ready (cli-daemon)";
      out(
        `${c.green("●")} core ${what} — 127.0.0.1:${core.port} · v${core.version} · pid ${core.pid}`,
      );
      return;
    }
    case "stop": {
      const stopped = await stopDaemon(flags.dataDir);
      if (flags.json) return printJson({ stopped });
      out(stopped ? `${c.yellow("○")} shutdown requested` : `${c.gray("○")} no core was running`);
      return;
    }
    case "status": {
      const core = await discoverCore(flags.dataDir);
      if (flags.json) {
        return printJson(core ? { running: true, ...publicCore(core) } : { running: false });
      }
      if (!core) {
        out(`${c.gray("○")} no Agetor core running`);
        return;
      }
      out(
        `${c.green("●")} ${c.bold(core.kind)} · 127.0.0.1:${core.port} · v${core.version} · pid ${core.pid}`,
      );
      tailLog(flags.dataDir);
      return;
    }
    default:
      throw new Error(`unknown daemon subcommand: ${sub} (use start | stop | status)`);
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

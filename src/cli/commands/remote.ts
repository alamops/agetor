import { getClient, type Flags } from "../context.ts";
import { ApiError } from "../api-client.ts";
import { c, out, printJson } from "../output.ts";
import { escapeControlChars } from "../../shared/terminal-text.ts";
import type { RemoteAccessStatus } from "../../shared/types.ts";

/**
 * `agetor remote [status | off]` — remote access (preview), the switch that
 * will let the Agetor Companion app reach this Mac (docs/plans/always-on-host.md
 * §3.5). Nothing pairs yet, so this only reports and turns it OFF.
 *
 * There is deliberately no `on`: only the app's native "Remote Access…" box can
 * turn it on, so an agent (or any program holding the CLI token) can never
 * open the Mac to a remote client. `off` is always allowed, for the same
 * reason in reverse.
 */

const REMOTE_USAGE = "usage: agetor remote [status | off]";

/** Run a remote-access call, turning a 404 (a core without these routes) into
 *  an actionable message — same wording as the bundle commands. */
async function remoteCall(fn: () => Promise<RemoteAccessStatus>): Promise<RemoteAccessStatus> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      throw new Error("the running agetor core is older than this CLI — restart or update it");
    }
    throw e;
  }
}

export async function cmdRemote(args: string[], flags: Flags): Promise<void> {
  const sub = args[0] ?? "status";
  // `parseArgs` leaves any non-global flag in the positionals, so a stray
  // `--foo` lands here and is refused like the house commands refuse it.
  if (args.length > 1) throw new Error(REMOTE_USAGE);
  if (sub !== "status" && sub !== "off") {
    throw new Error(
      `unknown remote subcommand: ${escapeControlChars(sub)} (use status | off)`,
    );
  }
  const client = await getClient(flags);
  const status = await remoteCall(() =>
    sub === "off" ? client.turnOffRemoteAccess() : client.getRemoteAccess(),
  );
  if (flags.json) return printJson(status);
  out(
    `Remote access (preview): ${status.enabled ? c.green("on") : c.gray("off")}`,
  );
}

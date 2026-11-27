import { getClient, type Flags } from "../context.ts";
import { ApiError } from "../api-client.ts";
import { c, out, printJson, table } from "../output.ts";
import { COMPANION_ENABLED } from "../../shared/build-flags.ts";
import { escapeControlChars, escapeFreeText } from "../../shared/terminal-text.ts";
import type { RemoteDeviceDto, RemoteDevicesResult } from "../../shared/remote-types.ts";
import type { RemoteAccessStatus } from "../../shared/types.ts";

/**
 * `agetor remote [status | off | devices | revoke <device> | revoke-all --yes | log [--limit N]]` — remote access for the Agetor
 * Companion app (docs/architecture/remote-gateway.md).
 *
 * There is deliberately no `on` and no `pair`: only the app's native "Remote Access…" box can turn it on and only the app's "Pair a Phone…"
 * window can pair, so an agent (or any program holding the CLI token) can never open the Mac to a remote client or enroll a phone. What the
 * CLI CAN do is remove authority: turn it off, revoke one phone, revoke all. Everything a phone supplied (its name, a route in the log) is
 * printed through `escapeControlChars` / `escapeFreeText`.
 */

const REMOTE_USAGE = COMPANION_ENABLED
  ? "usage: agetor remote [status | off | devices | revoke <device> | revoke-all --yes | log [--limit N]]"
  : "usage: agetor remote [status | off]";
const DEVICE_SUBS = new Set(["devices", "revoke", "revoke-all", "log"]);
const NOT_AVAILABLE = "remote devices are not available in this build";

/** A 404 from a core without these routes is an actionable message; `companion-unavailable` says the build ships without the Companion. */
async function remoteCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      if (/companion-unavailable/.test(e.message)) throw new Error(NOT_AVAILABLE);
      throw new Error("the running agetor core is older than this CLI — restart or update it");
    }
    throw e;
  }
}

/** The device a user means: an id prefix (at least 4 characters) or an exact name; an ambiguous or unknown one is refused with the candidates. */
export function resolveDevice(devices: RemoteDeviceDto[], query: string): RemoteDeviceDto {
  const q = query.trim();
  if (q.length === 0) throw new Error("which device? (an id prefix or its exact name; see `agetor remote devices`)");
  const byName = devices.filter((d) => d.name === q);
  const byId = q.length >= 4 ? devices.filter((d) => d.id.startsWith(q.toLowerCase())) : [];
  const matches = [...new Map([...byName, ...byId].map((d) => [d.id, d])).values()];
  if (matches.length === 1) return matches[0]!;
  const list = (ds: RemoteDeviceDto[]) => ds.map((d) => `  ${d.id.slice(0, 8)}  ${escapeControlChars(d.name)}`).join("\n");
  if (matches.length === 0) throw new Error(`no device matches "${escapeControlChars(q)}" (an id prefix of 4+ characters, or an exact name):\n${list(devices)}`);
  throw new Error(`"${escapeControlChars(q)}" matches ${matches.length} devices; use a longer id prefix:\n${list(matches)}`);
}

function ago(ts: number | null): string {
  if (ts === null) return "never";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function printStatus(s: RemoteAccessStatus): void {
  out(`Remote access (preview): ${s.enabled ? c.green("on") : c.gray("off")}`);
  if (!s.companion) return;
  out(`Mac name: ${escapeControlChars(s.macName)}`);
  out(`Relay: ${s.relay.url ? escapeControlChars(s.relay.url) : "none configured"} (${s.relay.state})`);
  out(`Devices: ${s.devices.trusted} trusted${s.devices.untrusted > 0 ? `, ${s.devices.untrusted} not trusted` : ""}`);
  for (const t of s.attachedTerminals) out(`Phone terminal: ${escapeControlChars(t.deviceName)} on task ${escapeControlChars(t.taskId)}`);
  if (s.bindWarning) out(c.yellow(escapeFreeText(s.bindWarning)));
}

function trustText(d: RemoteDeviceDto): string {
  return d.trust === "trusted" ? "trusted" : d.trust === "revoked" ? "revoked" : d.trust === "bad-signature" ? "NOT TRUSTED (signature)" : "NOT TRUSTED (status)";
}

function printDevices(r: RemoteDevicesResult): void {
  if (r.devices.length === 0) return out("No phones are paired. Pair one from Agetor › Remote Access › Pair a Phone…");
  out(
    table(
      ["ID", "NAME", "PLATFORM", "LEVEL", "TRUST", "LAST SEEN", "ONLINE"],
      r.devices.map((d) => [d.id.slice(0, 8), escapeControlChars(d.name), d.platform, d.level, trustText(d), ago(d.lastSeenAt), d.online ? "yes" : ""]),
    ),
  );
}

export async function cmdRemote(args: string[], flags: Flags): Promise<void> {
  const sub = args[0] ?? "status";
  const allowed = COMPANION_ENABLED ? ["status", "off", ...DEVICE_SUBS] : ["status", "off"];
  if (!allowed.includes(sub)) {
    throw new Error(`unknown remote subcommand: ${escapeControlChars(sub)} (use ${allowed.join(" | ").replace("revoke-all", "revoke-all --yes")})`);
  }
  // `parseArgs` leaves any non-global flag in the positionals, so a stray `--foo` lands here and is refused like the house commands do.
  const rest = args.slice(1);

  if (sub === "status" || sub === "off") {
    if (rest.length > 0) throw new Error(REMOTE_USAGE);
    const client = await getClient(flags);
    const status = await remoteCall(() => (sub === "off" ? client.turnOffRemoteAccess() : client.getRemoteAccess()));
    if (flags.json) return printJson(status);
    return printStatus(status);
  }

  if (sub === "devices") {
    if (rest.length > 0) throw new Error(REMOTE_USAGE);
    const client = await getClient(flags);
    const r = await remoteCall(() => client.getRemoteDevices());
    if (flags.json) return printJson(r);
    return printDevices(r);
  }

  if (sub === "revoke") {
    if (rest.length !== 1) throw new Error("usage: agetor remote revoke <device>  (an id prefix or its exact name)");
    const client = await getClient(flags);
    const { devices } = await remoteCall(() => client.getRemoteDevices());
    const d = resolveDevice(devices, rest[0]!);
    await remoteCall(() => client.revokeRemoteDevice(d.id));
    if (flags.json) return printJson({ ok: true, revoked: d.id });
    return out(`Revoked ${escapeControlChars(d.name)} (${d.id.slice(0, 8)}). Its session, if any, has ended.`);
  }

  if (sub === "revoke-all") {
    const unknown = rest.filter((a) => a !== "--yes");
    if (unknown.length > 0) throw new Error("usage: agetor remote revoke-all --yes");
    if (!rest.includes("--yes")) {
      throw new Error("revoke-all ends every phone's access and every phone must pair again: run `agetor remote revoke-all --yes` to do it");
    }
    const client = await getClient(flags);
    await remoteCall(() => client.revokeAllRemoteDevices());
    if (flags.json) return printJson({ ok: true });
    return out("Revoked every phone and replaced this Mac's key. Every phone must pair again.");
  }

  // log [--limit N]
  let limit = 20;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--limit" && rest[i + 1] !== undefined) {
      limit = Number(rest[++i]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("--limit must be an integer from 1 to 500");
    } else {
      throw new Error("usage: agetor remote log [--limit N]");
    }
  }
  const client = await getClient(flags);
  const log = await remoteCall(() => client.getRemoteLog({ limit }));
  if (flags.json) return printJson(log);
  out(log.chain.ok ? c.green("audit chain: intact") : c.red(`audit chain: BROKEN at row ${log.chain.firstBadSeq}`));
  out(
    table(
      ["SEQ", "TIME", "ACTION", "DEVICE", "ROUTE", "RESULT"],
      log.rows.map((r) => [
        String(r.seq),
        new Date(r.ts).toISOString().replace("T", " ").slice(0, 19),
        escapeControlChars(r.action),
        r.deviceId ? r.deviceId.slice(0, 8) : "",
        r.route ? escapeFreeText(r.route) : "",
        escapeFreeText(r.outcome ?? r.resultCode ?? ""),
      ]),
    ),
  );
}

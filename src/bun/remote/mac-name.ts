/**
 * The Mac's name as the phone shows it (grill D16): the `remoteMacName` preference, else the computer name (`scutil --get ComputerName`),
 * else the hostname, cleaned of control and invisible characters and capped at 40. It goes in the `hello` and Settings edits it.
 */
import os from "node:os";
import { cleanDeviceName } from "@agetor/remote-protocol/messages";
import { coreSpawnSync } from "../core-spawn.ts";

export const MAC_NAME_PREF = "remoteMacName";

export interface MacNameDeps {
  preference?: () => Promise<string | null | undefined>;
  computerName?: () => string | null;
  hostname?: () => string;
}

function scutilComputerName(): string | null {
  try {
    const r = coreSpawnSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 });
    return r.status === 0 ? String(r.stdout).trim() : null;
  } catch {
    return null;
  }
}

async function defaultPreference(): Promise<string | null> {
  const { preferences } = await import("../db-async.ts");
  return (await preferences.get(MAC_NAME_PREF)) ?? null;
}

/** The cleaned name, never empty ("Mac" at worst). */
export async function macName(deps: MacNameDeps = {}): Promise<string> {
  const candidates: Array<string | null | undefined> = [];
  try {
    candidates.push(await (deps.preference ?? defaultPreference)());
  } catch {
    candidates.push(null);
  }
  candidates.push((deps.computerName ?? scutilComputerName)());
  candidates.push((deps.hostname ?? os.hostname)());
  for (const c of candidates) {
    const cleaned = c ? cleanDeviceName(c) : "";
    if (cleaned) return cleaned;
  }
  return "Mac";
}

/** Validate a name the owner typed in Settings: cleaned, at most 40 characters, not empty. Returns the cleaned name or null. */
export function validateMacName(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 400) return null;
  const cleaned = cleanDeviceName(raw);
  return cleaned.length > 0 ? cleaned : null;
}

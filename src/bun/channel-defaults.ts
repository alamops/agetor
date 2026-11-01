import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DEV_API_PORT } from "./dev-defaults.ts";

/**
 * Canary and dev-channel app builds default to the dev data dir (`~/.agetor-dev`)
 * and port (4318), so signed-build QA never touches the real `~/.agetor` and
 * matches the launchd job of that channel (docs/plans/always-on-host.md, C11).
 *
 * ORDER MATTERS: `index.ts` imports this module FIRST. ES modules evaluate in
 * import order, so the side effect at the bottom of this file runs before
 * `db.ts` (which reads `AGETOR_DATA_DIR` and opens SQLite at import time) and
 * before `api-config.ts` reads `AGETOR_API_PORT`.
 *
 * LEAF MODULE: imports only `node:*` and `./dev-defaults.ts`, never `db.ts` —
 * importing it must not open a database, and for the same reason it can't be
 * allowed to reach one. Source runs (`bun run dev`, tests) are untouched: the
 * channel is read from `<exe dir>/../Resources/version.json`, which exists only
 * next to the packaged app's bundled bun binary; next to a source-run bun
 * (`~/.bun/bin/bun`) there is no such file, so the channel reads null and
 * nothing is set. Stable builds also set nothing. An env var that is already
 * set is never overridden, key by key.
 */

/** Channels that default to the dev data dir and port. */
const DEV_LIKE_CHANNELS = new Set(["canary", "dev"]);

/**
 * Fill in `AGETOR_DATA_DIR` and `AGETOR_API_PORT` on `env` for a canary/dev
 * channel, leaving any already-set value alone. Returns the keys it set (empty
 * for stable, unknown or null channels, or when everything was already set).
 */
export function applyChannelDefaults(
  env: NodeJS.ProcessEnv,
  channel: string | null,
  home: string,
): string[] {
  if (channel === null || !DEV_LIKE_CHANNELS.has(channel)) return [];
  const set: string[] = [];
  if (env.AGETOR_DATA_DIR === undefined) {
    env.AGETOR_DATA_DIR = path.join(home, ".agetor-dev");
    set.push("AGETOR_DATA_DIR");
  }
  if (env.AGETOR_API_PORT === undefined) {
    env.AGETOR_API_PORT = String(DEV_API_PORT);
    set.push("AGETOR_API_PORT");
  }
  return set;
}

/**
 * The release channel baked into the packaged app, from
 * `<dirname(execPath)>/../Resources/version.json` (`Contents/MacOS/bun` →
 * `Contents/Resources/version.json`). Null when the file is absent, unparsable
 * or carries no string `channel` — i.e. in every source run.
 */
export function readBundleChannel(execPath: string = process.execPath): string | null {
  try {
    const file = path.join(path.dirname(execPath), "..", "Resources", "version.json");
    const v = JSON.parse(readFileSync(file, "utf8")) as { channel?: unknown };
    return typeof v?.channel === "string" ? v.channel : null;
  } catch {
    return null;
  }
}

const applied = applyChannelDefaults(process.env, readBundleChannel(), homedir());
if (applied.length > 0) {
  console.log(
    `[agetor] canary/dev build: using ${process.env.AGETOR_DATA_DIR}, port ${process.env.AGETOR_API_PORT}`,
  );
}

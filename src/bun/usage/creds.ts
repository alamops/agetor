/**
 * Claude credential/config path resolution + macOS Keychain read, for the
 * per-harness usage tracker (docs/plans/harness-usage-tracker.md, section 2
 * "Credential/config resolution per kind" and Wave B1).
 *
 * Mirrors `harnessEnv` (src/bun/agents.ts:207-246) and `jsonlPathFor`'s
 * fresh/legacy fallback (src/bun/claude-tmux.ts:2076-2087): claude-code uses
 * `CLAUDE_CONFIG_DIR=<home>` (HOME is never overridden, so the main account's
 * creds still resolve against the real macOS Keychain). `home=null` means
 * "inherit the agetor process env" — the built-in main account.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Harness } from "../../shared/types.ts";

/**
 * Path to the `.claude.json` claude reads/writes for this harness.
 *  - main (`harness.home === null`): `~/.claude.json` — HOME is untouched
 *    for this harness, so this is the CLI's real config file.
 *  - alias (`harness.home` set): `<home>/.claude.json` — claude treats
 *    `CLAUDE_CONFIG_DIR` as the `.claude/` equivalent, and `.claude.json`
 *    lives directly under it (not nested under a `.claude/` segment).
 */
export function claudeDotJsonPath(harness: Harness): string {
  if (harness.home) return path.join(harness.home, ".claude.json");
  return path.join(homedir(), ".claude.json");
}

/**
 * Path to the OAuth credentials file for an *alias* harness, or `null` for
 * the main account (whose credentials live in the macOS Keychain instead —
 * see `readKeychainClaudeToken` below). Mirrors `jsonlPathFor`'s fresh/legacy
 * fallback: try the new-layout path (`<home>/.credentials.json`) first, then
 * the legacy `<home>/.claude/.credentials.json` (from when agetor set
 * `HOME=<home>` instead of `CLAUDE_CONFIG_DIR=<home>`).
 */
export function claudeCredentialsPath(harness: Harness): string | null {
  if (!harness.home) return null;
  const fresh = path.join(harness.home, ".credentials.json");
  if (existsSync(fresh)) return fresh;
  const legacy = path.join(harness.home, ".claude", ".credentials.json");
  if (existsSync(legacy)) return legacy;
  // Neither exists yet — return the fresh (new-layout) path so callers get a
  // consistent "expected but missing" location rather than a legacy guess.
  return fresh;
}

/** How long a failed/denied Keychain read is cached before we try again.
 *  Avoids prompting the user (or hammering `security`) on every poll cycle —
 *  mirrors CodexBar's consent model (plan section 3). */
const KEYCHAIN_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** Module-level cooldown state. `null` = no recent failure. */
let keychainCooldownUntilMs: number | null = null;

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * Read the main Claude account's OAuth token from the macOS Keychain
 * (`security find-generic-password -s "Claude Code-credentials" -w`), the
 * only place it lives for `home=null` harnesses (plan section 2). Never
 * throws — any failure (denied prompt, missing entry, malformed JSON,
 * non-macOS) resolves to `null` and arms a cooldown so repeated callers
 * don't retrigger a Keychain prompt every poll cycle.
 *
 * The spawn is raced against a hard timeout: reading this item from a
 * binary other than the `claude` CLI that created it triggers a *blocking*
 * macOS ACL dialog that never resolves until the user clicks. Without the
 * timeout that hang would propagate up through the poller's in-flight guard
 * and wedge every future sweep (the `finally` that clears `pollInFlight`
 * would never run). On timeout we kill the process, arm the cooldown, and
 * return null so the caller falls through to the `.claude.json` cache.
 */
const KEYCHAIN_SPAWN_TIMEOUT_MS = 3000;

export async function readKeychainClaudeToken(): Promise<string | null> {
  const now = Date.now();
  if (keychainCooldownUntilMs !== null && now < keychainCooldownUntilMs) {
    return null;
  }
  try {
    const proc = Bun.spawn(
      ["security", "find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
      { stdout: "pipe", stderr: "pipe" },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }, KEYCHAIN_SPAWN_TIMEOUT_MS);
    let stdout: string;
    let exitCode: number;
    try {
      [stdout, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (timedOut || exitCode !== 0) {
      keychainCooldownUntilMs = now + KEYCHAIN_COOLDOWN_MS;
      return null;
    }
    const parsed = JSON.parse(stdout.trim());
    const token = parsed?.claudeAiOauth?.accessToken;
    if (typeof token !== "string" || !token) {
      keychainCooldownUntilMs = now + KEYCHAIN_COOLDOWN_MS;
      return null;
    }
    return token;
  } catch {
    keychainCooldownUntilMs = now + KEYCHAIN_COOLDOWN_MS;
    return null;
  }
}

/**
 * Resolve the OAuth token (+ granted scopes) for a claude-code harness:
 * alias harnesses read the on-disk `.credentials.json`, the main account
 * falls back to the Keychain. Never throws — any failure resolves to
 * `{ token: null, scopes: [] }` so callers can always fall through to the
 * `.claude.json` cache fallback (plan section 3, "API-first → file-fallback,
 * always resolves").
 */
export async function readClaudeToken(
  harness: Harness,
): Promise<{ token: string | null; scopes: string[] }> {
  try {
    const credsPath = claudeCredentialsPath(harness);
    if (credsPath && existsSync(credsPath)) {
      const raw = await Bun.file(credsPath).text();
      const parsed = JSON.parse(raw);
      const token = parsed?.claudeAiOauth?.accessToken;
      const scopes = parsed?.claudeAiOauth?.scopes;
      if (typeof token === "string" && token) {
        return { token, scopes: Array.isArray(scopes) ? scopes : [] };
      }
    }
  } catch {
    // fall through
  }
  // The macOS Keychain item ("Claude Code-credentials") holds the MAIN
  // account's token only — an aliased harness (home set) must NEVER fall
  // back to it, or its meters would silently show a *different account's*
  // usage (observed live: three accounts all reporting the main account's
  // numbers). An alias with no on-disk creds gets no token; the caller then
  // falls through to the alias's own `.claude.json` cache, which is at
  // least the right account.
  if (harness.home !== null) {
    return { token: null, scopes: [] };
  }
  const keychainToken = await readKeychainClaudeToken();
  if (keychainToken) {
    // The keychain blob doesn't separately expose scopes to us via `-w`
    // (that flag prints only the secret); assume `user:profile` is granted
    // since the main account is what the interactive `claude` CLI logs in
    // with, and that login flow requests it. `fetchClaudeQuota` treats a
    // missing scope as "skip API, use cache" — if this assumption is wrong
    // for a given account, the 401 from the API call falls through to the
    // cache path anyway, so it fails soft either way.
    return { token: keychainToken, scopes: ["user:profile"] };
  }
  return { token: null, scopes: [] };
}

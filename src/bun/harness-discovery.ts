import { readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { ClaudeAccount, DiscoveredAccount } from "../shared/types.ts";
import { safeReadJsonCached } from "./commands.ts";

/**
 * Discovery of existing Claude config dirs (multi-account support) and the
 * shared "which config dir / which account is this harness actually using"
 * resolution that agent-status and the discovery route both need.
 *
 * All pure lookups over the filesystem — no LLM, no network, no DB writes.
 * Every function takes an options bag with injectable `homeDir`/`env` so
 * tests run against a mkdtemp tree instead of the real `$HOME`.
 */

export interface DiscoveryOptions {
  /** Override for `os.homedir()` (tests). */
  homeDir?: string;
  /** Override for `process.env` (tests) — only CLAUDE_CONFIG_DIR is read. */
  env?: Record<string, string | undefined>;
}

/**
 * The config dir a claude-code harness actually resolves to at spawn time.
 * A `home` override wins; otherwise the built-in inherits the agetor
 * process env (`agents.ts:harnessEnv` sets nothing when `home` is null, so
 * the spawned claude sees agetor's own CLAUDE_CONFIG_DIR if one is set);
 * otherwise claude's default `~/.claude`.
 */
export function effectiveClaudeConfigDir(home: string | null, opts: DiscoveryOptions = {}): string {
  if (home) return home;
  const env = opts.env ?? process.env;
  if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
  return path.join(opts.homeDir ?? homedir(), ".claude");
}

/**
 * Read the `oauthAccount` identity block for a config dir. Blob location
 * rule (same as `commands.ts`'s extension discovery): an override dir keeps
 * `.claude.json` INSIDE it, while the default `~/.claude` keeps it as a
 * sibling at `~/.claude.json`. We try in-dir first and fall back to the
 * HOME sibling only for the default dir — this also covers the edge where
 * CLAUDE_CONFIG_DIR is explicitly set to `~/.claude`.
 *
 * Returns null for a missing/unparsable blob or a logged-out account.
 * Never returns tokens or `accountUuid`.
 */
export function readClaudeAccount(configDir: string, opts: DiscoveryOptions = {}): ClaudeAccount | null {
  const home = opts.homeDir ?? homedir();
  const candidates = [path.join(configDir, ".claude.json")];
  if (path.resolve(configDir) === path.join(home, ".claude")) {
    candidates.push(path.join(home, ".claude.json"));
  }
  for (const blobPath of candidates) {
    // Read as an account file (`readAccountFileText`, no-follow.ts): a harness
    // home is agent-writable, so while disclaiming a `.claude.json` symlinked
    // into a protected folder is never opened by the core, and a FIFO there
    // never blocks it. A user's own symlinked blob still reads with the
    // switch off.
    const blob = safeReadJsonCached(blobPath, { accountFile: true });
    const oauth = blob?.oauthAccount;
    if (oauth && typeof oauth.emailAddress === "string" && oauth.emailAddress) {
      return {
        email: oauth.emailAddress,
        displayName: typeof oauth.displayName === "string" ? oauth.displayName : null,
        billingType: typeof oauth.billingType === "string" ? oauth.billingType : null,
      };
    }
  }
  return null;
}

/** `.claude-adevinta` → `claude-adevinta`; an arbitrary dir name gets a
 *  `claude-` prefix so the suggested id reads as a claude harness. The UI's
 *  `uniqueHarnessId` bumps collisions before save. */
export function suggestHarnessId(configDir: string): string {
  const base = path.basename(configDir).replace(/^\.+/, "");
  const slug = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "claude-account";
  return slug.includes("claude") ? slug : `claude-${slug}`;
}

function safeRealpath(p: string): string {
  try { return realpathSync(p); } catch { return path.resolve(p); }
}

/**
 * Find existing Claude config dirs no registered harness points at yet.
 *
 * Candidates: every `~/.claude*` directory, plus the process (or injected)
 * CLAUDE_CONFIG_DIR. A candidate qualifies only if its config blob carries a
 * logged-in `oauthAccount` — that's what separates a real account dir from
 * caches/plugin dirs matching the glob. Excluded: the built-in's effective
 * config dir and every dir in `registeredHomes` (pass each harness's `home`;
 * nulls resolve to the built-in's effective dir). Deduped by realpath so a
 * symlinked dir can't appear twice; the user-visible path is reported.
 */
export function discoverClaudeAccounts(
  registeredHomes: (string | null)[],
  opts: DiscoveryOptions = {},
): DiscoveredAccount[] {
  const home = opts.homeDir ?? homedir();
  const env = opts.env ?? process.env;

  const candidates: string[] = [];
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(".claude")) {
        candidates.push(path.join(home, entry.name));
      }
    }
  } catch { /* unreadable HOME — nothing to discover */ }
  if (env.CLAUDE_CONFIG_DIR) candidates.push(env.CLAUDE_CONFIG_DIR);

  const excluded = new Set<string>(
    [effectiveClaudeConfigDir(null, opts), ...registeredHomes.filter((h): h is string => !!h)]
      .map(safeRealpath),
  );

  const seen = new Set<string>();
  const out: DiscoveredAccount[] = [];
  for (const dir of candidates) {
    const real = safeRealpath(dir);
    if (seen.has(real) || excluded.has(real)) continue;
    seen.add(real);
    const account = readClaudeAccount(dir, opts);
    if (!account) continue;
    out.push({
      configDir: dir,
      email: account.email,
      displayName: account.displayName,
      billingType: account.billingType,
      suggestedHarnessId: suggestHarnessId(dir),
    });
  }
  return out.sort((a, b) => a.configDir.localeCompare(b.configDir));
}

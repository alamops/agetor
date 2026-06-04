import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./db.ts";
import { isValidPermissionEntry } from "../shared/claude-permissions.ts";

/**
 * Keeps a per-task `<cwd>/.claude/settings.local.json` clean for claude's
 * interactive session. agetor is non-invasive: it installs NO PreToolUse
 * hook, NO MCP server, and NO CLAUDE.md addendum. AskUserQuestion /
 * ExitPlanMode / tool-permission prompts all run natively in the tmux pane
 * and are surfaced through the scraper.
 *
 * What this module still does on every spawn:
 *  - STRIPS any stale agetor PreToolUse hook entry a previous build wrote
 *    (recognised by the `agetor-approval-hook.sh` command suffix), so an
 *    upgrading install stops POSTing to the long-removed /approvals
 *    endpoint and never deadlocks.
 *  - STRIPS any stale `mcpServers.agetor` registration a previous build
 *    wrote (recognised by the well-known key name), so claude doesn't error
 *    on launch trying to spawn a now-deleted MCP launcher.
 *  - Self-heals `permissions.allow` entries claude's parser would reject —
 *    owned worktrees only (the file is agetor scratch there).
 *
 * For isolation=worktree tasks the settings file lives at
 * `<worktree>/.claude/settings.local.json` — agetor's owned tree. For
 * isolation=none tasks we merge into `<workdir>/.claude/settings.local.json`
 * (see `ensureInstalledMerged`) so we never trash a user-authored file.
 *
 * Everything is idempotent: re-running on a file we already cleaned is a
 * no-op.
 */

/**
 * Per-task settings management is side-effect only now — there are no
 * materialised paths to hand back. The return type stays as a thin record so
 * call sites can distinguish "did something" (object) from "skipped — bad cwd
 * or malformed file" (null).
 */
export interface InstalledPaths {
  /** The settings.local.json file we wrote (or would have written). */
  settingsFile: string;
}

export function ensureInstalled(cwd: string): InstalledPaths | null {
  // We own the worktree dir, but the settings.local.json INSIDE it may still
  // hold `permissions.allow` entries we have to preserve across re-spawns:
  // legacy entries from older agetor builds, rules the user hand-added, and
  // entries left over from a direct `claude` invocation inside the worktree.
  // A fresh-object write would clobber those, so owned-worktree installs use
  // the same merge path as user-repo installs — only relaxed on the
  // malformed-JSON branch (we wrote the file last; if it's malformed, that's
  // our bug to recover from, not the user's data).
  return applyAgetorSettings(cwd, {
    refuseOnMalformed: false,
    sanitizeAllow: true,
  });
}

/**
 * Conservative installer: only writes the settings file when the cwd is
 * inside agetor's owned worktree namespace. Used by claude-tmux to avoid
 * accidentally touching a user's source repo when isolation is off.
 */
export function ensureInstalledIfOwned(cwd: string): InstalledPaths | null {
  const owned = path.resolve(dataDir, "worktrees") + path.sep;
  if (!path.resolve(cwd).startsWith(owned)) return null;
  // Guard against an exotic case where the dir was deleted between
  // prepareWorkdir and spawn (unlikely, but cheap to check).
  if (!existsSync(cwd)) return null;
  return ensureInstalled(cwd);
}

/** Filename suffix every materialised agetor hook script used. Recognising
 *  by suffix (not full path) means stale entries from a previous
 *  `AGETOR_DATA_DIR` location still get cleaned up — without this, a user
 *  who reset `~/.agetor` would accumulate dead `PreToolUse` rows on every
 *  reinstall. */
const AGETOR_HOOK_SUFFIX = "agetor-approval-hook.sh";

/** Well-known key under `mcpServers` that older agetor builds registered the
 *  `ask_user` MCP server under. We never re-add it; we only strip it so an
 *  upgrading install doesn't keep a dead registration pointing at a deleted
 *  launcher (which makes claude error on launch). */
const AGETOR_MCP_KEY = "agetor";

function isAgetorHookEntry(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const inner = (e as { hooks?: unknown }).hooks;
  if (!Array.isArray(inner)) return false;
  return inner.some((h) => {
    if (!h || typeof h !== "object") return false;
    const cmd = (h as { command?: unknown }).command;
    return typeof cmd === "string" && cmd.endsWith(AGETOR_HOOK_SUFFIX);
  });
}

/**
 * Merge-friendly installer for the user's source repo (isolation=none).
 *
 * Safe-merge semantics so we don't trash a user-authored settings file:
 *  1. Read the existing JSON if any. **Refuse to write when the file
 *     exists but isn't valid JSON** — overwriting a mid-edit broken file
 *     could lose user config the merge claims to preserve.
 *  2. Strip out any pre-existing agetor PreToolUse hook entry (recognised
 *     by command suffix) and the well-known `mcpServers.agetor` key so
 *     reinstalls clean up dead registrations a previous build wrote.
 *  3. Leave everything else (permissions allow-lists, other hooks, other
 *     MCP servers, anything else future claude versions add) untouched.
 *  4. Never write a CLAUDE.md — that's the user's file, and agetor no
 *     longer ships a system-prompt addendum.
 *
 * Returns null when the cwd doesn't exist OR the existing settings file
 * is malformed; otherwise the settings file path.
 */
export function ensureInstalledMerged(cwd: string): InstalledPaths | null {
  return applyAgetorSettings(cwd, {
    refuseOnMalformed: true,
    sanitizeAllow: false,
  });
}

interface ApplyOpts {
  /** When the existing settings.local.json is unparseable, refuse to write
   *  (preserves the user's broken edit so they can fix it). When false,
   *  log and proceed with an empty base — for owned worktrees, the file
   *  is ours and a malformed state is our bug to recover from. */
  refuseOnMalformed: boolean;
  /** Strip `permissions.allow` entries claude's parser would reject (empty/
   *  paren/newline patterns earlier "Allow always" saves wrote). Owned
   *  worktrees only — the file is agetor scratch there, so self-healing it
   *  is safe. For user repos we leave their version-controlled rules alone;
   *  claude's own startup dialog already surfaces a bad rule, and deleting
   *  the user's data on every session start would be a surprise mutation. */
  sanitizeAllow: boolean;
}

/**
 * Shared merge logic for both ensureInstalled (owned worktrees) and
 * ensureInstalledMerged (user repos). Reads the existing settings.local.json,
 * strips only the stale keys agetor owns (`hooks.PreToolUse` agetor entries,
 * `mcpServers.agetor`), optionally self-heals `permissions.allow`, and writes
 * back atomically. All other keys are preserved verbatim.
 */
function applyAgetorSettings(
  cwd: string,
  opts: ApplyOpts,
): InstalledPaths | null {
  if (!existsSync(cwd)) return null;

  const settingsDir = path.join(cwd, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  const settingsFile = path.join(settingsDir, "settings.local.json");

  // Read & parse existing settings.
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    let raw: string;
    try { raw = readFileSync(settingsFile, "utf8"); } catch (e) {
      console.error(
        `[agetor:hook-installer] cannot read ${settingsFile}: ${(e as Error).message}. ` +
        `Skipping settings install.`,
      );
      return null;
    }
    if (raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          settings = parsed as Record<string, unknown>;
        } else if (opts.refuseOnMalformed) {
          console.error(
            `[agetor:hook-installer] ${settingsFile} is not a JSON object (got ` +
            `${Array.isArray(parsed) ? "array" : typeof parsed}). Skipping merge.`,
          );
          return null;
        } else {
          console.warn(
            `[agetor:hook-installer] ${settingsFile} is not a JSON object — overwriting (owned worktree).`,
          );
        }
      } catch (e) {
        if (opts.refuseOnMalformed) {
          console.error(
            `[agetor:hook-installer] refusing to merge: ${settingsFile} is not valid JSON. ` +
            `Fix or delete the file to enable interactive approval cards. (${(e as Error).message})`,
          );
          return null;
        }
        console.warn(
          `[agetor:hook-installer] overwriting malformed ${settingsFile}: ${(e as Error).message}`,
        );
      }
    }
  }

  // Hooks: agetor never installs a PreToolUse hook. The two modal-deadlock
  // tools (AskUserQuestion / ExitPlanMode) run natively now, and tool-call
  // approvals fall to claude's own permission modals — both surfaced through
  // the tmux pane scraper. We still STRIP any stale agetor hook entry a
  // previous build wrote, so upgrading installs clean up the old interception
  // on the next spawn (and never POST to the removed /approvals endpoint). If
  // that leaves PreToolUse empty, drop the key so we don't leave an empty
  // array behind in the user's settings file.
  const hooks = (settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks))
    ? settings.hooks as Record<string, unknown>
    : {};
  const preToolUseRaw = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse as unknown[] : [];
  const preToolUse = preToolUseRaw.filter((e) => !isAgetorHookEntry(e));
  if (preToolUse.length > 0) {
    hooks.PreToolUse = preToolUse;
  } else {
    delete hooks.PreToolUse;
  }
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;

  // MCP server: agetor never registers one. We STRIP any stale
  // `mcpServers.agetor` a previous build wrote, so an upgrading install
  // doesn't keep a dead registration pointing at a now-deleted launcher —
  // claude would otherwise error trying to spawn it at launch. We only touch
  // the well-known `agetor` key; every other MCP server is left untouched. If
  // dropping it empties the object, drop `mcpServers` too (mirrors the empty-
  // PreToolUse handling above).
  if (settings.mcpServers && typeof settings.mcpServers === "object" && !Array.isArray(settings.mcpServers)) {
    const mcp = settings.mcpServers as Record<string, unknown>;
    if (AGETOR_MCP_KEY in mcp) {
      delete mcp[AGETOR_MCP_KEY];
      if (Object.keys(mcp).length === 0) delete settings.mcpServers;
      else settings.mcpServers = mcp;
    }
  }

  // Sanitize permissions.allow: strip any entry claude's settings parser
  // would reject (empty/paren/newline patterns earlier versions wrote).
  // Left in place they make claude halt on a startup recovery dialog the
  // moment the session launches. Runs on every session start, so this
  // self-heals a settings file poisoned by an old "Allow always" save.
  // Owned worktrees only (opts.sanitizeAllow) — we never silently delete a
  // user repo's own permission rules.
  if (opts.sanitizeAllow) {
    const perms = settings.permissions;
    if (perms && typeof perms === "object" && !Array.isArray(perms)) {
      const allow = (perms as Record<string, unknown>).allow;
      if (Array.isArray(allow)) {
        (perms as Record<string, unknown>).allow = allow.filter(
          (e): e is string => typeof e === "string" && isValidPermissionEntry(e),
        );
      }
    }
  }

  writeJsonAtomic(settingsFile, settings);

  return { settingsFile };
}

/** Atomic JSON write: stringify, write to a sibling tempfile, rename onto
 *  the target. rename is atomic on POSIX, so a partial write can never
 *  leave the destination corrupted. Crucial for settings.local.json which
 *  hook-installer merges into on every task spawn while preserving any
 *  pre-existing user / legacy entries underneath. */
function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

/**
 * Always-install entry point. Picks the right strategy based on whether
 * cwd is one of our worktrees (self-heal-safe) or the user's source repo
 * (refuse-on-malformed merge). Used by `spawnClaudeViaTmux` regardless of
 * isolation mode so stale agetor interception gets cleaned up on both paths.
 * The `mode` argument is accepted for call-site compatibility but no longer
 * influences behaviour — agetor installs nothing mode-specific any more.
 */
export function ensureInstalledForCwd(
  cwd: string,
  _mode?: string | null | undefined,
): InstalledPaths | null {
  const owned = path.resolve(dataDir, "worktrees") + path.sep;
  if (path.resolve(cwd).startsWith(owned)) {
    if (!existsSync(cwd)) return null;
    return ensureInstalled(cwd);
  }
  return ensureInstalledMerged(cwd);
}

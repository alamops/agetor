import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pkg from "../../package.json" with { type: "json" };
import { dataDir } from "./db.ts";
import { isValidPermissionEntry } from "../shared/claude-permissions.ts";

// Bundled source text — pulled in at build time so the packaged app doesn't
// need to know about absolute paths inside the dev tree. The MCP server is
// shipped the same way (rather than as a separate file inside the packaged
// Resources tree) because electrobun-build collapses everything under
// `src/bun/` into a single `index.js`; a sibling `mcp/agetor-mcp.ts` would
// not survive the bundle, leaving claude's MCP launcher pointing at a path
// that doesn't exist — and claude blocks on the initialize handshake long
// enough that our JSONL discovery times out before the first event lands.
import hookSource from "./hooks/agetor-approval-hook.sh" with { type: "text" };
import systemPromptText from "./hooks/agetor-system-prompt.md" with { type: "text" };
// TypeScript resolves the relative `.ts` path as a real module and ignores
// the text attribute, so it complains about the missing default export.
// Bun honors the attribute and ships the file contents as a string — exactly
// what we want for materialising the MCP server source at install time.
// @ts-expect-error — text-import on a `.ts` source file
import mcpServerSource from "./mcp/agetor-mcp.ts" with { type: "text" };

/**
 * Installs the PreToolUse hook script, the MCP-server launcher, and the
 * per-task `.claude/settings.local.json` that wires them into claude's
 * interactive session.
 *
 *   $AGETOR_DATA_DIR/bin/agetor-approval-hook.sh   # the bash hook
 *   $AGETOR_DATA_DIR/bin/agetor-mcp.sh             # launcher → bun runs the ts
 *   $AGETOR_DATA_DIR/bin/agetor-system-prompt.md   # --append-system-prompt body
 *
 * For isolation=worktree tasks the settings file lives at
 * `<worktree>/.claude/settings.local.json` — agetor's owned tree, so we
 * fully overwrite it. When the worktree is removed (deleteTask →
 * removeWorktree) the settings file goes with it.
 *
 * For isolation=none tasks we merge into `<workdir>/.claude/settings.local.json`
 * (see `ensureInstalledMerged`) so claude in the user's source repo also
 * routes approvals + clarifying questions through agetor's UI.
 *
 * Uninstall caveat: when the user stops using agetor, the merged
 * PreToolUse + mcpServers entries stay in their repos. Each subsequent
 * claude run will try our hook script, fail fast (curl: connection
 * refused → fail-open → `ask`), and behave correctly — but the dead
 * config remains. There's no `agetor uninstall` flow yet; users have
 * to clean these up manually if they care.
 *
 * Everything is idempotent: each call rewrites the bin scripts (so a bug fix
 * to the hook source ships at next launch without an uninstall step) and
 * either overwrites or merge-updates the settings file.
 */

const MCP_VERSION_SENTINEL = "__AGETOR_VERSION__";

let cachedBinDir: string | null = null;

/** Resolve `<dataDir>/bin/<name>` and ensure the bin/ directory exists. */
function binPath(name: string): string {
  if (!cachedBinDir) {
    cachedBinDir = path.join(dataDir, "bin");
    mkdirSync(cachedBinDir, { recursive: true });
  }
  return path.join(cachedBinDir, name);
}

let materialised = false;

/** Public hook for the boot sequence (index.ts): force the shared-file
 *  materialisation to happen eagerly on startup, BEFORE the first task
 *  spawn. Without this, the bin/ scripts on disk hold whatever the
 *  previous agetor process wrote — so a `claude` invocation made directly
 *  in a hook-installed repo, between agetor restart and first task,
 *  would run a stale script. Idempotent: subsequent calls no-op via the
 *  `materialised` flag below. */
export function prewarmSharedFiles(): void {
  materialiseSharedFiles();
}

/** Write the static, task-agnostic files (hook script + system-prompt
 *  addendum + MCP launcher). Idempotent — runs at most once per agetor
 *  process. The MCP launcher is *.sh that exec's `bun` at the path resolved
 *  at install time. */
function materialiseSharedFiles(): { hookScript: string; mcpLauncher: string; systemPromptFile: string } {
  const hookScript = binPath("agetor-approval-hook.sh");
  const mcpLauncher = binPath("agetor-mcp.sh");
  const systemPromptFile = binPath("agetor-system-prompt.md");

  if (!materialised) {
    writeFileSync(hookScript, hookSource);
    chmodSync(hookScript, 0o755);

    // Resolve `bun` to an absolute path AT INSTALL TIME so the launcher we
    // write doesn't depend on claude's PATH (Electrobun-launched processes
    // sometimes get a sanitised PATH that's missing Homebrew, etc.).
    // `Bun.which` caches PATH at process startup — pass the current PATH
    // explicitly so it picks up whatever `rehydratePath()` injected at boot.
    // If it still can't find one, fall back to `bun` and let claude's child
    // shell try its luck.
    const bunPath = Bun.which("bun", { PATH: process.env.PATH }) ?? "bun";
    // Materialise the MCP server's source next to the launcher so the
    // launcher can point at a real path. We can't reference
    // `import.meta.dir/mcp/agetor-mcp.ts` because electrobun-build inlines
    // every src/bun/* into one index.js — the source file is not shipped.
    const mcpScript = binPath("agetor-mcp.ts");
    // Substitute the version sentinel so the MCP server's `serverInfo.version`
    // tracks package.json. The substitution has to happen here (not inside
    // agetor-mcp.ts itself) because the source is shipped as text and the
    // materialised copy lives at <dataDir>/bin/agetor-mcp.ts, where the
    // relative path `../../package.json` doesn't exist — so the MCP file
    // can't import pkg directly. Whoever writes the file has to inject the
    // value.
    //
    // The sentinel-presence assertion makes a refactor that drops the
    // sentinel fail loudly at startup. Without it, .replace would silently
    // no-op and ship `serverInfo.version: "__AGETOR_VERSION__"` to claude
    // forever — and no test catches it (agetor-mcp.test.ts spawns the
    // in-place file, which is supposed to contain the sentinel).
    if (!mcpServerSource.includes(MCP_VERSION_SENTINEL)) {
      throw new Error(
        `agetor-mcp.ts is missing the ${MCP_VERSION_SENTINEL} sentinel — ` +
        `serverInfo.version would ship stale. Re-add the sentinel or update hook-installer.ts.`,
      );
    }
    const materialisedMcpSource = mcpServerSource.replaceAll(
      MCP_VERSION_SENTINEL,
      pkg.version,
    );
    writeFileSync(mcpScript, materialisedMcpSource);
    const launcherSource = [
      "#!/usr/bin/env bash",
      "# Spawned by claude as the `agetor` MCP server. `bun` is resolved to",
      "# an absolute path by the installer so this works even when claude's",
      "# subshell has a sanitised PATH.",
      "",
      "# Bypass when not running under agetor: same env-var + /health probe",
      "# as agetor-approval-hook.sh. Exiting before `exec bun` means claude",
      "# sees the MCP process die before the handshake — it logs one warning",
      "# and continues without our `ask_user` tool, instead of registering a",
      "# tool that throws on every call.",
      `if [ -z "$AGETOR_API_PORT" ] || [ -z "$AGETOR_API_TOKEN" ] || [ -z "$AGETOR_TASK_ID" ]; then exit 0; fi`,
      `HEALTH=$(curl -fsS -m 1 "http://127.0.0.1:\${AGETOR_API_PORT}/health" 2>/dev/null)`,
      `case "$HEALTH" in *'"app":"agetor"'*) ;; *) exit 0 ;; esac`,
      "",
      `exec ${JSON.stringify(bunPath)} ${JSON.stringify(mcpScript)} "$@"`,
      "",
    ].join("\n");
    writeFileSync(mcpLauncher, launcherSource);
    chmodSync(mcpLauncher, 0o755);

    writeFileSync(systemPromptFile, systemPromptText);

    materialised = true;
  }

  return { hookScript, mcpLauncher, systemPromptFile };
}

/**
 * Per-task: write `<cwd>/.claude/settings.local.json` wiring our hook +
 * MCP server. Safe to overwrite (`.local.json` is gitignore-convention).
 * No-op when `cwd` is the user's raw workdir — we only install in the
 * worktree we own (caller is responsible for the gate).
 */
export interface InstalledPaths {
  hookScript: string;
  mcpLauncher: string;
  systemPromptFile: string;
}

/**
 * How wide the install reaches for a given task.
 *  - "full": PreToolUse matches every tool (`.*`) and the agetor MCP +
 *    CLAUDE.md addendum are wired in. Used for interactive modes (ask,
 *    plan, acceptEdits, unknown future modes, default null).
 *  - "narrow": PreToolUse matches only AskUserQuestion + ExitPlanMode (the
 *    two claude built-ins that draw a TUI modal). MCP + CLAUDE.md still
 *    installed. Used for `auto` so non-modal tool calls run un-gated but
 *    the deadlock-prone modal tools still route to agetor's UI.
 *  - "narrow-no-mcp": narrow PreToolUse only. No MCP, no CLAUDE.md.
 *    Used for `bypass` — truly hands-off, but we still need the narrow
 *    hook so a stray AskUserQuestion/ExitPlanMode call doesn't deadlock.
 */
export type InstallScope = "full" | "narrow" | "narrow-no-mcp";

const FULL_MATCHER = ".*";
const NARROW_MATCHER = "^(AskUserQuestion|ExitPlanMode)$";

/** Picks the install scope for a given task mode. Unknown / null → full —
 *  safer to over-route than to leak hands-off behaviour into a mode the
 *  user didn't opt into. */
export function installScopeForMode(mode: string | null | undefined): InstallScope {
  if (mode === "bypass") return "narrow-no-mcp";
  if (mode === "auto") return "narrow";
  return "full";
}

function matcherForScope(scope: InstallScope): string {
  return scope === "full" ? FULL_MATCHER : NARROW_MATCHER;
}

function includeMcpForScope(scope: InstallScope): boolean {
  return scope !== "narrow-no-mcp";
}

export function ensureInstalled(cwd: string, scope: InstallScope = "full"): InstalledPaths {
  // Even though we own the worktree dir, the settings.local.json INSIDE it
  // is shared with `saveAllowRule` (which appends `permissions.allow`
  // entries). A fresh-object write would clobber those rules on every task
  // re-spawn. So owned-worktree installs use the same merge path as
  // user-repo installs, only relaxed on the malformed-JSON branch (we
  // wrote the file last; if it's malformed, that's our bug to recover
  // from, not the user's data).
  //
  // We DO write the CLAUDE.md addendum here (unlike ensureInstalledMerged
  // which leaves user repos alone). The addendum teaches claude when to
  // prefer the `ask_user` MCP tool over plain-text clarification — the
  // central training signal for one of agetor's main value-adds. The
  // worktree is agetor-owned scratch, not user code; writing there is
  // fine. For the edge case where a user `cd`s into a worktree and runs
  // claude directly (no agetor → MCP launcher bypasses → tool not
  // registered), the addendum itself instructs the agent to fall back to
  // plain-text questions on a tool-not-found error.
  const result = applyAgetorSettings(cwd, scope, {
    writeClaudeMd: true,
    refuseOnMalformed: false,
    sanitizeAllow: true,
  });
  // For owned worktrees the caller has already existsSync'd the dir, so
  // null returns only happen on truly unexpected I/O errors. Fall back to
  // the materialised bin paths so the caller's signature contract holds.
  return result ?? materialiseSharedFiles();
}

/**
 * Conservative installer: only writes the settings file when the cwd is
 * inside agetor's owned worktree namespace. Used by claude-tmux to avoid
 * accidentally dropping settings into a user's source repo when isolation
 * is off.
 */
export function ensureInstalledIfOwned(cwd: string, scope: InstallScope = "full"): InstalledPaths | null {
  const owned = path.resolve(dataDir, "worktrees") + path.sep;
  if (!path.resolve(cwd).startsWith(owned)) return null;
  // Guard against an exotic case where the dir was deleted between
  // prepareWorkdir and spawn (unlikely, but cheap to check).
  if (!existsSync(cwd)) return null;
  return ensureInstalled(cwd, scope);
}

/** Filename suffix every materialised agetor hook script uses. Recognising
 *  by suffix (not full path) means stale entries from a previous
 *  `AGETOR_DATA_DIR` location still get cleaned up — without this, a user
 *  who reset `~/.agetor` would accumulate dead `PreToolUse` rows on every
 *  reinstall. */
const AGETOR_HOOK_SUFFIX = "agetor-approval-hook.sh";
const AGETOR_MCP_LAUNCHER_SUFFIX = "agetor-mcp.sh";

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

function isAgetorMcpServer(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const cmd = (entry as { command?: unknown }).command;
  return typeof cmd === "string" && cmd.endsWith(AGETOR_MCP_LAUNCHER_SUFFIX);
}

/**
 * Merge-friendly installer for the user's source repo (isolation=none).
 *
 * Without this, Bash / Edit / other approval prompts from claude fall back
 * to the in-TUI modal that agetor can't see — the user has to attach
 * tmux just to click "Yes". Installing our PreToolUse hook + ask_user MCP
 * into `<workdir>/.claude/settings.local.json` routes every approval and
 * clarifying question through the UI cards instead.
 *
 * Safe-merge semantics so we don't trash a user-authored settings file:
 *  1. Read the existing JSON if any. **Refuse to write when the file
 *     exists but isn't valid JSON** — overwriting a mid-edit broken file
 *     could lose user config the merge claims to preserve.
 *  2. Strip out any pre-existing agetor entries (recognised by command
 *     suffix, robust against `AGETOR_DATA_DIR` changes) so reinstalls
 *     don't accumulate dead rows pointing at old data-dir paths.
 *  3. Append our fresh PreToolUse entry; same for the `agetor`
 *     mcpServers key (overwriting our own previous registration only —
 *     a user-named `agetor` MCP server is left alone since its command
 *     won't match our suffix).
 *  4. Leave everything else (permissions allow-lists, other hooks,
 *     other MCP servers) untouched.
 *  5. Skip the CLAUDE.md write entirely — that's the user's file.
 *
 * Returns null when the cwd doesn't exist OR the existing settings file
 * is malformed; otherwise the installed paths.
 */
export function ensureInstalledMerged(cwd: string, scope: InstallScope = "full"): InstalledPaths | null {
  return applyAgetorSettings(cwd, scope, {
    writeClaudeMd: false,
    refuseOnMalformed: true,
    sanitizeAllow: false,
  });
}

interface ApplyOpts {
  /** Write `<cwd>/.claude/CLAUDE.md` (the ask_user system-prompt addendum).
   *  Owned worktrees only — never overwrite a user's own CLAUDE.md. */
  writeClaudeMd: boolean;
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
 * mutates only the keys agetor owns (`hooks.PreToolUse` agetor entries,
 * `mcpServers.agetor`), and writes back atomically. All other keys
 * (`permissions`, user-authored hooks, other MCP servers, anything else
 * future versions of claude may add) are preserved verbatim.
 *
 * The key invariant: re-running this on a file that already contains
 * agetor's stale entries plus the user's `saveAllowRule`-written
 * `permissions.allow` produces a result with the fresh agetor entries
 * AND the unchanged permissions.allow.
 */
function applyAgetorSettings(
  cwd: string,
  scope: InstallScope,
  opts: ApplyOpts,
): InstalledPaths | null {
  if (!existsSync(cwd)) return null;
  const paths = materialiseSharedFiles();

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

  // Hooks: strip stale agetor entries, then append our fresh one with the
  // matcher this scope requires (narrow for auto/bypass, full otherwise).
  const hooks = (settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks))
    ? settings.hooks as Record<string, unknown>
    : {};
  const preToolUseRaw = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse as unknown[] : [];
  const preToolUse = preToolUseRaw.filter((e) => !isAgetorHookEntry(e));
  preToolUse.push({
    matcher: matcherForScope(scope),
    hooks: [{ type: "command", command: paths.hookScript }],
  });
  hooks.PreToolUse = preToolUse;
  settings.hooks = hooks;

  // MCP server: overwrite our own previous registration; never clobber a
  // user-named `agetor` MCP server (one whose `command` doesn't end with
  // our launcher suffix). For the bypass scope we *strip* our own previous
  // registration if any — that mode is meant to be modal-free, so we
  // shouldn't leave a stale `ask_user` channel that earlier runs installed.
  const haveBun = Bun.which("bun", { PATH: process.env.PATH }) !== null;
  const wantMcp = includeMcpForScope(scope) && haveBun;
  const mcp = (settings.mcpServers && typeof settings.mcpServers === "object" && !Array.isArray(settings.mcpServers))
    ? settings.mcpServers as Record<string, unknown>
    : {};
  const existing = mcp.agetor;
  if (wantMcp) {
    if (!existing || isAgetorMcpServer(existing)) {
      mcp.agetor = { command: paths.mcpLauncher };
    }
    settings.mcpServers = mcp;
  } else if (existing && isAgetorMcpServer(existing)) {
    delete mcp.agetor;
    if (Object.keys(mcp).length === 0) {
      delete settings.mcpServers;
    } else {
      settings.mcpServers = mcp;
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

  // Project-level CLAUDE.md teaches claude about the `ask_user` MCP tool.
  // Reliable across modes (interactive + headless both read it). Skipped
  // when there's no MCP server registration — claude doesn't have the
  // tool, so we shouldn't lie about it. Also skipped for user repos
  // (writeClaudeMd=false) — we never overwrite the user's own CLAUDE.md.
  if (opts.writeClaudeMd && wantMcp) {
    writeFileSync(path.join(settingsDir, "CLAUDE.md"), systemPromptText);
  }

  return paths;
}

/** Atomic JSON write: stringify, write to a sibling tempfile, rename onto
 *  the target. rename is atomic on POSIX, so a partial write can never
 *  leave the destination corrupted. Crucial for settings.local.json which
 *  multiple subsystems (hook-installer, interactions/saveAllowRule) merge
 *  into during normal operation. */
function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

/**
 * Always-install entry point. Picks the right strategy based on whether
 * cwd is one of our worktrees (overwrite is safe) or the user's source
 * repo (merge is required). Used by `spawnClaudeViaTmux` regardless of
 * isolation mode so AskUserQuestion / ExitPlanMode interception works on
 * both paths. The `mode` argument controls install scope — see
 * `installScopeForMode`.
 */
export function ensureInstalledForCwd(
  cwd: string,
  mode: string | null | undefined,
): InstalledPaths | null {
  const scope = installScopeForMode(mode);
  const owned = path.resolve(dataDir, "worktrees") + path.sep;
  if (path.resolve(cwd).startsWith(owned)) {
    if (!existsSync(cwd)) return null;
    return ensureInstalled(cwd, scope);
  }
  return ensureInstalledMerged(cwd, scope);
}

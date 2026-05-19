import { lstatSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import path from "node:path";

/**
 * Claude Code's native installer drops the binary at
 * `~/.local/share/claude/versions/<VERSION>` and points `~/.local/bin/claude`
 * at it. The CLI persists `installMethod: "native"` in `$HOME/.claude.json`
 * after onboarding, and on every subsequent launch validates that marker by
 * checking that `$HOME/.local/bin/claude` exists — if not, it bails with
 * `installMethod is native, but claude command not found at <path>`.
 *
 * For multi-account harnesses we override HOME so each account gets its own
 * `.claude/` / `.claude.json`. But the integrity check then points at the
 * *new* HOME's `.local/bin/claude`, which we never populated — so claude
 * refuses to start after the first onboarding launch.
 *
 * The fix is purely filesystem-side: pre-create `<harnessHome>/.local/bin/`
 * and symlink `claude` to the system installation. Tracking the *symlink*
 * rather than the resolved binary means harness logins pick up auto-updates
 * for free (the system symlink retargets to the new version, the harness
 * symlink-to-symlink walks through to it).
 *
 * This is claude-native-install-specific. npm-global / homebrew / other
 * install methods don't write `installMethod: "native"` and don't trigger
 * the check.
 */

const NATIVE_INSTALL_MARKER = `${path.sep}.local${path.sep}share${path.sep}claude${path.sep}versions${path.sep}`;

export interface ClaudeNativeInstall {
  /** Symlink path to symlink into harness homes (e.g. /Users/x/.local/bin/claude). */
  symlink: string;
  /** Resolved binary path (e.g. /Users/x/.local/share/claude/versions/2.1.143). */
  binary: string;
}

/**
 * Return the system claude install if it is a native install, else null.
 * Resolution mirrors `resolveBin()` for built-in claude-code: `Bun.which`
 * with an explicit PATH to dodge Bun's startup PATH cache.
 *
 * Detection is purely structural — we walk the realpath of whatever
 * `claude` resolves to and check for the native-install path marker. This
 * avoids depending on `homedir()` (the user might run with a non-standard
 * HOME and still be on a native install).
 */
export function detectClaudeNativeInstall(): ClaudeNativeInstall | null {
  const symlink = Bun.which("claude", { PATH: process.env.PATH });
  if (!symlink) return null;
  try {
    const binary = realpathSync(symlink);
    if (!binary.includes(NATIVE_INSTALL_MARKER)) return null;
    return { symlink, binary };
  } catch {
    return null;
  }
}

export interface LinkResult {
  /** True if we created a new symlink, false if a no-op. */
  linked: boolean;
  /** Path of the link target (system claude symlink), if any. */
  target: string | null;
  /** Human-readable explanation, useful for logging. */
  reason: string;
}

/**
 * Ensure `<home>/.local/bin/claude` exists and points at the system native
 * claude install. Idempotent: if anything already lives at the target path
 * (symlink, file, dir), leave it alone. Errors never propagate — harness
 * creation must succeed even if we can't link.
 */
export function linkClaudeNativeBinIntoHome(home: string): LinkResult {
  const install = detectClaudeNativeInstall();
  if (!install) {
    return { linked: false, target: null, reason: "system claude is not a native install" };
  }

  const binDir = path.join(home, ".local", "bin");
  const target = path.join(binDir, "claude");

  // Use `lstatSync` (not `existsSync`) so dangling symlinks from a previous
  // botched setup are also treated as "already present" — clobbering them
  // could mask real problems the user should see.
  try {
    lstatSync(target);
    return { linked: false, target: install.symlink, reason: `${target} already exists — left alone` };
  } catch {
    /* not present, proceed */
  }

  try {
    mkdirSync(binDir, { recursive: true });
    symlinkSync(install.symlink, target);
    return { linked: true, target: install.symlink, reason: `linked ${target} → ${install.symlink}` };
  } catch (e) {
    return {
      linked: false,
      target: install.symlink,
      reason: `failed to link ${target}: ${(e as Error).message}`,
    };
  }
}

/**
 * Wrapper called from the harness create/update handlers. Logs the outcome
 * to the bun console so support has a breadcrumb when a multi-account setup
 * still fails. Returns the result so callers (and tests) can inspect.
 */
export function prepareClaudeHarnessHome(home: string): LinkResult {
  const result = linkClaudeNativeBinIntoHome(home);
  if (result.linked) {
    console.log(`[harness-setup] ${result.reason}`);
  } else if (result.reason.startsWith("failed")) {
    console.warn(`[harness-setup] ${result.reason}`);
  }
  return result;
}

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { TMUX_MISSING_REASON, type AgentKind, type Harness, type HarnessStatus } from "../shared/types.ts";
import { resolveBin, harnessEnv } from "./agents.ts";
import { harnesses } from "./db.ts";
import { resolveTmuxBin } from "./tmux-resolution.ts";
import { detectClaudeNativeInstall } from "./harness-setup.ts";

const VERSION_PROBE_TIMEOUT_MS = 2000;

const INSTALL_HINTS: Record<AgentKind, string> = {
  "claude-code": "npm i -g @anthropic-ai/claude-code",
  "codex": "npm i -g @openai/codex",
};

async function probeVersion(bin: string, env: Record<string, string>): Promise<string | null> {
  const proc = Bun.spawn([bin, "--version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Merge the harness env on top of the process env so e.g. an alias with
    // a custom HOME still finds its node binary on PATH. We don't override
    // PATH here — bin resolution already happened via resolveBinPath().
    env: { ...process.env, ...env },
  });

  const timer = setTimeout(() => {
    try { proc.kill(); } catch { /* already gone */ }
  }, VERSION_PROBE_TIMEOUT_MS);

  try {
    const code = await proc.exited;
    if (code !== 0) return null;
    const out = await new Response(proc.stdout).text();
    return out.trim().split("\n")[0]?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve an executable name to an absolute path. Absolute paths bypass `$PATH`
 * and are checked for existence directly — `Bun.which` only searches `$PATH`
 * and returns null for absolute paths, which would falsely report a hand-
 * specified `bin` as missing.
 *
 * **Pass `{ PATH: process.env.PATH }` explicitly.** Without it, `Bun.which`
 * uses the PATH snapshot Bun captured at process startup, which on a packaged
 * macOS .app is launchd's minimal `/usr/bin:/bin:/usr/sbin:/sbin` — none of
 * `claude` / `codex` / `tmux` live there. `rehydratePath()` (called at boot)
 * mutates `process.env.PATH` to include the user's login-shell PATH, but
 * `Bun.which`'s internal cache won't see the mutation. The options object
 * forces a fresh lookup against whatever we currently have on `process.env`.
 */
function resolveBinPath(bin: string): string | null {
  if (!bin) return null;
  if (isAbsolute(bin)) return existsSync(bin) ? bin : null;
  return Bun.which(bin, { PATH: process.env.PATH });
}

/**
 * claude-code drives its interactive REPL through a per-task tmux session
 * (see `src/bun/claude-tmux.ts`). Without tmux the claude path can't run at
 * all, so we treat its absence the same way we treat a missing claude binary:
 * `available: false` plus an install hint. Codex is unaffected.
 */
const TMUX_INSTALL_HINT = "brew install tmux (macOS) or apt install tmux (Debian/Ubuntu)";

/**
 * Surfaced when a claude-code alias with a custom HOME is missing the
 * native-install integrity-check symlink. `orchestrator.startTask` self-heals
 * on the next run, so the cure is usually "just run the task again"; the
 * second-line workaround is recreating the alias.
 */
const CLAUDE_NATIVE_REPAIR_HINT = "Start a task on this alias once — agetor will repair it. Or remove and re-add the alias in Settings.";

export async function checkHarness(harness: Harness): Promise<HarnessStatus> {
  const bin = resolveBin(harness);
  const path = resolveBinPath(bin);
  if (!path) {
    return {
      harnessId: harness.id,
      kind: harness.kind,
      bin,
      available: false,
      path: null,
      version: null,
      reason: `\`${bin}\` not found on PATH`,
      installHint: INSTALL_HINTS[harness.kind],
    };
  }

  if (harness.kind === "claude-code") {
    const tmuxPath = resolveBinPath(resolveTmuxBin());
    if (!tmuxPath) {
      return {
        harnessId: harness.id,
        kind: harness.kind,
        bin,
        available: false,
        path,
        version: null,
        reason: TMUX_MISSING_REASON,
        installHint: TMUX_INSTALL_HINT,
      };
    }

    // Native-install integrity check: claude validates `$HOME/.local/bin/claude`
    // exists on every interactive launch — but `--version` short-circuits the
    // check, so probeVersion would happily green-light a misconfigured alias
    // whose tasks then explode at spawn time. Catch the gap explicitly when:
    //   - the alias overrides HOME (built-in claude-code has home=null)
    //   - the alias didn't pin a custom bin (we're using the system claude)
    //   - the system claude is actually a native install
    if (harness.home && !harness.bin && detectClaudeNativeInstall()) {
      const integrityPath = join(harness.home, ".local", "bin", "claude");
      if (!existsSync(integrityPath)) {
        return {
          harnessId: harness.id,
          kind: harness.kind,
          bin,
          available: false,
          path,
          version: null,
          reason: `${integrityPath} missing — claude's native-install integrity check will fail at launch`,
          installHint: CLAUDE_NATIVE_REPAIR_HINT,
        };
      }
    }
  }

  const version = await probeVersion(path, harnessEnv(harness));
  return {
    harnessId: harness.id,
    kind: harness.kind,
    bin,
    available: true,
    path,
    version,
    reason: null,
    installHint: null,
  };
}

/**
 * Probe every registered harness — built-ins plus user aliases. Used by the
 * `/agents` (legacy) and `/harnesses` (preferred) endpoints. Concurrent;
 * each probe times out independently after VERSION_PROBE_TIMEOUT_MS.
 */
export function checkAllHarnesses(): Promise<HarnessStatus[]> {
  return Promise.all(harnesses.list().map(checkHarness));
}

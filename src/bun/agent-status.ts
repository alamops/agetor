import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { TMUX_MISSING_REASON, type AgentKind, type Harness, type HarnessStatus } from "../shared/types.ts";
import { resolveBin, harnessEnv } from "./agents.ts";
import { harnesses } from "./db.ts";
import { resolveTmuxBin } from "./tmux-resolution.ts";

const VERSION_PROBE_TIMEOUT_MS = 2000;

const INSTALL_HINTS: Record<AgentKind, string> = {
  "claude-code": "npm i -g @anthropic-ai/claude-code",
  "codex": "npm i -g @openai/codex",
  "cursor": "curl https://cursor.com/install -fsS | bash",
  "gemini": "npm i -g @google/gemini-cli",
  "fx": "curl -fsSL https://fx.sh/setup.sh | bash",
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
 * The bare name `fx` collides with a popular npm JSON-viewer CLI. A
 * `--version` exit-status check alone can't tell them apart, so for fx
 * harnesses we additionally probe `--help` and look for a marker string
 * unique to Vercel's fx ("coding agent" — real fx v0.0.4 says "Fast, native
 * coding agent for the terminal"; the JSON viewer's says "Terminal JSON
 * viewer"). Doesn't gate on exit code — some CLIs exit non-zero for --help.
 */
async function probeHelp(bin: string, env: Record<string, string>): Promise<string | null> {
  const proc = Bun.spawn([bin, "--help"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });

  const timer = setTimeout(() => {
    try { proc.kill(); } catch { /* already gone */ }
  }, VERSION_PROBE_TIMEOUT_MS);

  try {
    await proc.exited;
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return `${out}\n${err}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run `[bin, ...args]` and return stdout, or `null` on a non-zero exit, a
 * spawn/read error, or the `VERSION_PROBE_TIMEOUT_MS` timeout — the same
 * shape/timeout budget as `probeVersion`/`probeHelp`. Generic (not
 * fx-specific) so a future JSON sub-command probe on another kind can reuse
 * it; today only `probeStatus` calls it.
 */
async function probeJson(bin: string, args: string[], env: Record<string, string>): Promise<string | null> {
  const proc = Bun.spawn([bin, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });

  const timer = setTimeout(() => {
    try { proc.kill(); } catch { /* already gone */ }
  }, VERSION_PROBE_TIMEOUT_MS);

  try {
    const code = await proc.exited;
    if (code !== 0) return null;
    return await new Response(proc.stdout).text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fx-only login probe: `fx status --json` is spike-verified to run
 * unauthenticated with zero filesystem writes, so it's safe to run on every
 * status check (unlike a probe that might trigger a login flow or write
 * config). Strictly FAIL-OPEN — returns `{ loggedIn: null, authHelp: null }`
 * for anything it can't confidently parse, never a false "logged out":
 *   - the test/e2e stub binaries (`AGETOR_FX_BIN` overrides) don't implement
 *     `status --json` at all and will exit non-zero / print nothing, which
 *     must never be mistaken for "missing" and block a run;
 *   - a future fx renaming or dropping the `auth` field must degrade to
 *     "unknown", not "logged out" — see A1 in the plan doc: the authenticated
 *     value of `auth` is unverified, only `"missing"` is confirmed.
 * Only `auth === "missing"` (from a real fx binary that answered the probe)
 * is treated as a positive "logged out" signal; every other parseable value
 * is treated as logged in.
 */
async function probeStatus(bin: string, env: Record<string, string>): Promise<{ loggedIn: boolean | null; authHelp: string | null }> {
  const out = await probeJson(bin, ["status", "--json"], env);
  if (!out) return { loggedIn: null, authHelp: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return { loggedIn: null, authHelp: null };
  }

  if (typeof parsed !== "object" || parsed === null) return { loggedIn: null, authHelp: null };
  const auth = (parsed as Record<string, unknown>).auth;
  if (typeof auth !== "string") return { loggedIn: null, authHelp: null };

  if (auth === "missing") {
    const authHelp = (parsed as Record<string, unknown>).auth_help;
    return {
      loggedIn: false,
      authHelp: typeof authHelp === "string" ? authHelp : "Run fx login to sign in.",
    };
  }

  return { loggedIn: true, authHelp: null };
}

const FX_HELP_MARKER = "coding agent";
const FX_WRONG_BINARY_HINT =
  "found a different 'fx' binary (JSON viewer?) — install Vercel fx: curl -fsSL https://fx.sh/setup.sh | bash or set AGETOR_FX_BIN";

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
      loggedIn: null,
      authHelp: null,
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
        loggedIn: null,
        authHelp: null,
      };
    }

    // Note: claude's native-install integrity check (`$HOME/.local/bin/claude`
    // exists) used to require pre-linking into the harness HOME because we
    // re-homed the spawn. Now that we re-home via CLAUDE_CONFIG_DIR instead
    // (HOME stays at the real user home), the integrity check resolves against
    // the system install and always passes — no per-harness symlink needed.
  }

  const version = await probeVersion(path, harnessEnv(harness));

  // fx-only pre-flight auth state. `available: true` regardless — the binary
  // IS installed and IS Vercel's fx; being logged out is a separate state
  // that startTask gates on separately (see plan doc §3.3 T5), not something
  // this probe reports as unavailable.
  let loggedIn: boolean | null = null;
  let authHelp: string | null = null;

  if (harness.kind === "fx" && version !== null) {
    const helpOutput = await probeHelp(path, harnessEnv(harness));
    const looksLikeFx = helpOutput?.toLowerCase().includes(FX_HELP_MARKER) ?? false;
    if (!looksLikeFx) {
      return {
        harnessId: harness.id,
        kind: harness.kind,
        bin,
        available: false,
        path,
        version,
        reason: `\`${bin}\` doesn't look like Vercel fx`,
        installHint: FX_WRONG_BINARY_HINT,
        loggedIn: null,
        authHelp: null,
      };
    }

    ({ loggedIn, authHelp } = await probeStatus(path, harnessEnv(harness)));
  }

  return {
    harnessId: harness.id,
    kind: harness.kind,
    bin,
    available: true,
    path,
    version,
    reason: null,
    installHint: null,
    loggedIn,
    authHelp,
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

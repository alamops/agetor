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
 * viewer"; re-verified present on v0.0.6 and v0.0.7 — the marker probe is
 * still safe). Doesn't gate on exit code — some CLIs exit non-zero for --help.
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
 * Two combinations are treated as a positive "logged out" signal; every other
 * parseable value — including any absent or non-boolean field along the way —
 * is treated as logged in, exactly as before:
 *   - `auth === "missing"` (from a real fx binary that answered the probe);
 *   - `auth !== "missing"` but `auth_expired === true` (strict boolean) AND
 *     `auth_refreshable === false` (strict boolean) — a 0.0.7+ expired,
 *     non-refreshable login. Real `fx acp` would fail this at `initialize`
 *     with fx's own raw -32600 anyway (see fx-acp.ts's `RpcError.rawMessage`
 *     passthrough for that same code), so a friendly pre-flight refusal here
 *     is strictly better than letting the run fail unexplained later. An
 *     expired login that's still refreshable (`auth_refreshable` anything but
 *     strict `false` — absent, non-boolean, or `true`) stays fail-open on
 *     purpose: fx may silently refresh the token on real use (`fx acp`), and
 *     this passive probe never attempts a refresh, so it can't prove the
 *     login is actually dead — blocking here would be a false "logged out"
 *     for a session fx would happily revive.
 *
 * This expired-login gate is exempt entirely when `auth` is one of the
 * env-key values (`"AI_GATEWAY_API_KEY"` / `"VERCEL_OIDC_TOKEN"`) — those
 * `auth` values mean the ACTIVE auth mechanism is the env key, not a stored
 * login, so a stale *stored* login must never refuse a run that would
 * authenticate via the key. Whether fx even emits `auth_expired` alongside
 * env-key auth is unobserved (these fields were only ever seen on real `fx
 * login` accounts, never on an env-key-authenticated probe), and the gate
 * deliberately exempts them anyway so the long-standing guarantee "a
 * key-authenticated user is never gated out here" stays literally true. The
 * expired-login gate thus applies only to login-style `auth` values (e.g.
 * `"fx login"`, provider subscription logins like `"fx login codex"`).
 *
 * Empirically verified auth values (real fx binary, v0.0.6 and v0.0.7 —
 * `HOME` pointed at an empty dir so no ambient credentials leak in): no
 * credentials at all → `auth:"missing"` + `auth_help`; `AI_GATEWAY_API_KEY`
 * set → `auth:"AI_GATEWAY_API_KEY"`; `VERCEL_OIDC_TOKEN` set → `auth:
 * "VERCEL_OIDC_TOKEN"` — i.e. env-var auth IS reflected in the probe's
 * output, and since this probe runs with the same `harnessEnv(harness)` a
 * real spawn uses, a key-authenticated user is never gated out here. The
 * probe writes no files.
 *
 * 0.0.7 additions (verified 2026-08-31 against a live fx 0.0.7 binary, build
 * cef08aa0f178, real logged-in account): `status --json` gained an
 * always-present `mcp:{connection_check,servers,configuration_issues,
 * inspection_error}` object and `mcp_config_warning` — both purely additive
 * and ignored here by construction (only `auth`, `auth_help`, `auth_expired`,
 * `auth_refreshable` are read, matching every JSON-parsing probe's
 * unknown-fields-are-fine contract) — plus `auth_expired`, `auth_refreshable`,
 * and `team` appearing on real login accounts. Observed live on one such
 * account with an expired session: `auth:"fx login"`, `auth_expired:true`,
 * `auth_refreshable:true`, `team` present — i.e. real accounts do exercise
 * the refreshable branch above, and in that state passive probes (this one
 * included) see the unauthenticated model catalog, which is a separate,
 * already-fail-open concern (`discoverFx`), not this gate's job.
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
  const record = parsed as Record<string, unknown>;
  const auth = record.auth;
  if (typeof auth !== "string") return { loggedIn: null, authHelp: null };

  if (auth === "missing") {
    const authHelp = record.auth_help;
    return {
      loggedIn: false,
      authHelp: typeof authHelp === "string" ? authHelp : "Run fx login to sign in.",
    };
  }

  // 0.0.7+: an authenticated-but-expired, non-refreshable login. Strict on
  // both booleans by design — see the doc comment above for why every other
  // combination (absent/non-boolean/`auth_refreshable !== false`) must stay
  // fail-open instead of joining this branch. Env-key auth is exempt from
  // this gate entirely (see the doc comment above) — the active auth
  // mechanism there is the key, not a stored login, so a stale stored login
  // must never refuse a run that would authenticate via the key.
  if (
    auth !== "AI_GATEWAY_API_KEY" &&
    auth !== "VERCEL_OIDC_TOKEN" &&
    record.auth_expired === true &&
    record.auth_refreshable === false
  ) {
    const authHelp = record.auth_help;
    return {
      loggedIn: false,
      authHelp:
        typeof authHelp === "string" ? authHelp : "fx login has expired — run fx login to sign in again.",
    };
  }

  return { loggedIn: true, authHelp: null };
}

type StatusProbeResult = { loggedIn: boolean | null; authHelp: string | null };

const STATUS_CACHE_TTL_MS = 60_000;
const statusCache = new Map<string, { value: StatusProbeResult; expiresAt: number }>();

/**
 * Memoized wrapper around `probeStatus`, keyed by `${harness.id}:${path}` (the
 * resolved binary path, not just the harness id — an alias whose `bin`
 * changes mid-session shouldn't inherit a stale entry keyed only on id).
 * `checkAllHarnesses()` runs every 15s (`App.tsx`'s poll) and, until this
 * cache existed, each tick re-spawned `fx status --json` for every fx
 * harness forever — auth state changes rarely enough that a 60s staleness
 * window is an easy trade for cutting that to one spawn per minute.
 *
 * `freshAuth: true` bypasses the cache read (a user who just ran `fx login`
 * must not be told "still logged out" for up to 60s), but the freshly-probed
 * result is still written back to the cache so the *next* poll tick benefits
 * from it instead of immediately re-probing.
 */
async function getCachedStatus(
  harness: Harness,
  path: string,
  env: Record<string, string>,
  opts: { freshAuth?: boolean } | undefined,
): Promise<StatusProbeResult> {
  const key = `${harness.id}:${path}`;
  if (!opts?.freshAuth) {
    const cached = statusCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }
  const value = await probeStatus(path, env);
  statusCache.set(key, { value, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
  return value;
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

/**
 * `opts.freshAuth` bypasses the fx auth-status cache (see `getCachedStatus`
 * above) for this one call. Start (`orchestrator.ts`'s `startTask`) passes
 * `{ freshAuth: true }` — a user who just ran `fx login` must not be refused
 * for up to `STATUS_CACHE_TTL_MS` by a stale cached `false`. The 15s
 * `/harnesses` poll can tolerate that staleness for its own purpose (it's
 * just painting a status dot), so it omits the option and reads from cache
 * — but `loggedIn` now has a second consumer: `mergeModelOptions`'s rule 7
 * (`src/shared/model-options.ts`) uses it to decide whether a picker trusts
 * the harness's discovered catalog. A stale cached `false` therefore also
 * transiently collapses the model list to the non-gated curated rows for up
 * to `STATUS_CACHE_TTL_MS` — self-healing on the next post-expiry poll, and
 * never hit by `startTask` itself since that call always passes
 * `freshAuth: true`.
 */
export async function checkHarness(harness: Harness, opts?: { freshAuth?: boolean }): Promise<HarnessStatus> {
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
    const env = harnessEnv(harness);
    // Run concurrently, not sequentially: probeStatus doesn't actually depend
    // on probeHelp's outcome to execute (only on whether we end up trusting
    // its result), so serializing them just to preserve read order was
    // costing an extra ~2s worst-case per fx check (3 sequential 2s-budget
    // probes vs. version's 2s + max(help, status)'s 2s = 4s total).
    const [helpOutput, status] = await Promise.all([
      probeHelp(path, env),
      getCachedStatus(harness, path, env, opts),
    ]);
    const looksLikeFx = helpOutput?.toLowerCase().includes(FX_HELP_MARKER) ?? false;
    if (!looksLikeFx) {
      // `status` was still fetched (and cached) above, but this binary isn't
      // confirmed to be Vercel's fx, so its auth state is meaningless here —
      // discarded in favor of the null/null the wrong-binary path always
      // reported.
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

    ({ loggedIn, authHelp } = status);
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
  return Promise.all(harnesses.list().map((h) => checkHarness(h)));
}

// Exposed for tests: clears the fx auth-status memoization (see
// `getCachedStatus`/`statusCache` above) so a test isn't left racing a TTL
// window set by an earlier test's probe against the same harness id + path.
export const __testing = { clearStatusCache: () => statusCache.clear() };

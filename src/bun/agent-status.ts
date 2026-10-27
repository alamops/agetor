import { existsSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { TMUX_MISSING_REASON, type AgentKind, type ClaudeAccount, type Harness, type HarnessStatus } from "../shared/types.ts";
import { opencodeMajor } from "../shared/opencode.ts";
import { resolveBin, harnessEnv } from "./agents.ts";
import { accountUsageSummary } from "./account-usage.ts";
import { harnesses } from "./db.ts";
import { effectiveClaudeConfigDir, readClaudeAccount } from "./harness-discovery.ts";
import { resolveTmuxBin } from "./tmux-resolution.ts";

const VERSION_PROBE_TIMEOUT_MS = 2000;

/**
 * Per-kind install command. Surfaced on an unavailable harness's status
 * (`installHint`), and the fallback of `upgradeHintFor` below (for the npm /
 * curl installers the install command also upgrades an installed CLI).
 */
export const INSTALL_HINTS: Record<AgentKind, string> = {
  "claude-code": "npm i -g @anthropic-ai/claude-code",
  "codex": "npm i -g @openai/codex",
  "cursor": "curl https://cursor.com/install -fsS | bash",
  "gemini": "npm i -g @google/gemini-cli",
  "fx": "curl -fsSL https://fx.sh/setup.sh | bash",
  "antigravity": "brew install --cask antigravity-cli",
  "opencode": "brew install opencode",
};

/**
 * Homebrew formula/cask name per kind, for `upgradeHintFor`. Only kinds that
 * are actually distributed through Homebrew; cursor and fx aren't, so a
 * cursor/fx binary under a Homebrew prefix falls through to the kind's own
 * self-update / reinstall command.
 */
const BREW_PACKAGES: Partial<Record<AgentKind, string>> = {
  "codex": "codex",
  "claude-code": "claude-code",
  "gemini": "gemini-cli",
  "antigravity": "antigravity-cli",
  "opencode": "opencode",
};

/**
 * Whether `binPath` looks like a Homebrew-managed install — it sits under
 * the Apple-silicon prefix (`/opt/homebrew/`) or the Intel Cellar /
 * Caskroom. The path is also resolved through its symlinks (best-effort —
 * a path that doesn't exist is judged on its literal spelling): a real path
 * under `/usr/local/Cellar/` or `/usr/local/Caskroom/` catches an Intel
 * `/usr/local/bin` symlink, and a real path inside a `node_modules`
 * directory is an npm global install that merely lives under Homebrew's
 * node prefix (`/opt/homebrew/bin/codex` → `…/lib/node_modules/@openai/codex/…`),
 * for which `brew upgrade` would fail with "not installed".
 */
function isHomebrewInstall(binPath: string): boolean {
  let real = binPath;
  try {
    real = realpathSync(binPath);
  } catch {
    // Missing / unreadable — judge the literal path.
  }
  if (real.includes("/node_modules/")) return false;
  const underBrew = (p: string) =>
    p.startsWith("/opt/homebrew/") || p.startsWith("/usr/local/Cellar/") || p.startsWith("/usr/local/Caskroom/");
  return underBrew(binPath) || underBrew(real);
}

/**
 * The command that UPGRADES an installed `kind` CLI found at `binPath` (the
 * resolved path `checkHarness` reports as `HarnessStatus.path`, or null when
 * unknown). Used as the "Upgrade with: …" hint of the per-model
 * minimum-CLI-version pre-flight (`minCliVersionError` in orchestrator.ts),
 * where the install command can be the wrong advice:
 *   - a Homebrew-managed codex / claude-code / gemini → `brew upgrade <pkg>`
 *     (`codex`, `claude-code`, `gemini-cli`) — reinstalling via npm would
 *     leave a second, shadowed copy behind;
 *   - claude-code otherwise → `claude update` (its self-updater covers both
 *     the native and the npm install);
 *   - cursor → `cursor-agent update`;
 *   - opencode otherwise → `opencode upgrade` (Homebrew → `brew upgrade opencode`);
 *   - anything else → the kind's `INSTALL_HINTS` entry (the npm / curl
 *     installers upgrade in place).
 */
export function upgradeHintFor(kind: AgentKind, binPath: string | null): string {
  if (binPath && isHomebrewInstall(binPath)) {
    const pkg = BREW_PACKAGES[kind];
    if (pkg) return `brew upgrade ${pkg}`;
  }
  if (kind === "claude-code") return "claude update";
  if (kind === "cursor") return "cursor-agent update";
  if (kind === "antigravity") return "agy update";
  if (kind === "opencode") return "opencode upgrade";
  return INSTALL_HINTS[kind];
}

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
 * still safe; re-verified 0.0.8 (2026-09-08; `--help` still "Fast, native
 * coding agent for the terminal.", `fx acp --help` still only
 * `--model`/`--log-file`)); re-verified through fx 0.0.10 (binary probes of
 * the 0.0.9 and 0.0.10 release builds, 2026-09-14): the marker line is
 * unchanged on both — only the banner and the `-c`/`--continue` copy
 * shifted ("latest" session → "remembered workspace session"), neither of
 * which this probe reads. Doesn't gate on exit code — some CLIs exit
 * non-zero for --help.
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
 *
 * `omitEnv` names variables removed from the merged env (`process.env` plus
 * `env`) before the spawn — `probeStatus` strips `FX_PERMISSION_MODE`, which
 * would otherwise mask the profile value `status --json` reports.
 */
async function probeJson(
  bin: string,
  args: string[],
  env: Record<string, string>,
  omitEnv: readonly string[] = [],
): Promise<string | null> {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  for (const key of omitEnv) delete merged[key];
  const proc = Bun.spawn([bin, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: merged,
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
 *     `auth_refreshable === false` (strict boolean) — a 0.0.7+ (unchanged
 *     through 0.0.10) expired, non-refreshable login. Real `fx acp` would fail this at
 *     `initialize` with fx's own raw -32600 anyway (see fx-acp.ts's
 *     `RpcError.rawMessage` passthrough for that same code), so a friendly
 *     pre-flight refusal here is strictly better than letting the run fail
 *     unexplained later. An expired login that's still refreshable
 *     (`auth_refreshable` anything but strict `false` — absent, non-boolean,
 *     or `true`) stays fail-open on purpose: fx may silently refresh the
 *     token on real use (`fx acp`), and this passive probe never attempts a
 *     refresh, so it can't prove the login is actually dead — blocking here
 *     would be a false "logged out" for a session fx would happily revive.
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
 *
 * Re-verified against fx 0.0.8 (binary probe, 2026-09-08, build_revision
 * 43c11dcc34a9): the `status --json` builder is byte-identical to 0.0.7
 * (`output_contracts.zig`), so nothing above changes. Confirmed facts, not
 * schema changes: `auth_expired` is present in the payload only when `true`
 * (absent — not `false` — on a fresh/non-expired probe) and
 * `mcp_config_warning` only when there's an actual warning, so their absence
 * on a given probe is normal, not evidence of a dropped field. There's a new
 * possible `auth` value, `"host managed"` (a space, not a hyphen), emitted
 * when the fx process runs under `FX_AUTH_MODE=host-managed` (an
 * embedding-host feature) — agetor never sets that var, and if it were ever
 * seen here the existing "every other parseable value ⇒ loggedIn:true"
 * fallthrough already handles it correctly: the embedding host owns
 * credentials in that mode, so there's nothing for this gate to check. The
 * payload carries `build_revision` (0.0.8 measured: `"43c11dcc34a9"`) but no
 * top-level `version` field. The other always-present fields — `kind`,
 * `update_channel`, `build_channel`, `permission_mode`, `workspace`,
 * `history_turns`, `session_permission_grants`, `agent_step_limit`, and the
 * `mcp{connection_check,servers,configuration_issues,inspection_error}`
 * object — are, as before, ignored here by construction (`permission_mode`
 * only until 0.0.14 made it worth reading — see below).
 *
 * Re-verified through fx 0.0.10 (binary probes of the 0.0.9 and 0.0.10
 * release builds + a full v0.0.8→v0.0.10 source diff, 2026-09-14): the
 * `status --json` builder is still unchanged (the only diff in
 * `output_contracts.zig` across the whole range removed a dead helper) —
 * every field, the `auth` vocabulary, the `auth_help` text, and the
 * fail-open contract above all hold as written. Still no top-level
 * `version` field. `build_revision` reads `"e26e97ec4040"` on 0.0.9 and
 * `"1210c2756ea8"` on 0.0.10 (distinct per build, as expected).
 * `permission_mode` echoes `yolo`/`auto`/`ask` exactly as before,
 * `full-access` still reads back as `yolo`, and an invalid
 * `FX_PERMISSION_MODE` still falls back silently to `auto` (no error) —
 * identical on 0.0.8, 0.0.9, and 0.0.10.
 *
 * Re-verified against fx 0.0.14 (binary probe of the release build
 * 1a070af32cdf, isolated HOMEs, 2026-10-22): `--help` still reads "Fast,
 * native coding agent for the terminal." (so `FX_HELP_MARKER` matches), and
 * the auth fields (`auth`, `auth_help`, `auth_refreshable`) and their
 * vocabulary are unchanged, so the login gate above holds as written.
 * 0.0.14 adds `mode`, `modes`, `effort` and `ultrafast_requested` (ignored
 * here) beside `permission_mode`, which is now load-bearing: 0.0.14's
 * `session/set_mode` writes the chosen mode into the user's own
 * `~/.fx/settings.json`, and `permission_mode` reports, in order, the
 * `FX_PERMISSION_MODE` env override, else that saved profile value (`"ask"`
 * with `{"permission_mode":"ask"}` saved), else `"auto"`. This probe
 * therefore runs with `FX_PERMISSION_MODE` REMOVED from its env — whether it
 * came from agetor's process env or from the harness's own env map — so the
 * value reflects the profile the user's interactive fx starts in, not an
 * override. It is returned as `permissionMode` (any non-empty string; `null`
 * when the field is absent, not a string, or the probe failed) and surfaced
 * as `HarnessStatus.fxProfilePermissionMode`, which drives the "fx starts in
 * Ask" hint in Settings and `agetor harness ls`. It is read independently of
 * the auth fields: a payload whose `auth` can't be parsed still reports it.
 * `status --json` still writes nothing under an empty `HOME`.
 */
async function probeStatus(bin: string, env: Record<string, string>): Promise<StatusProbeResult> {
  const failed: StatusProbeResult = { loggedIn: null, authHelp: null, permissionMode: null };
  const out = await probeJson(bin, ["status", "--json"], env, ["FX_PERMISSION_MODE"]);
  if (!out) return failed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return failed;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return failed;
  const record = parsed as Record<string, unknown>;
  const permissionMode =
    typeof record.permission_mode === "string" && record.permission_mode.length > 0
      ? record.permission_mode
      : null;
  const auth = record.auth;
  if (typeof auth !== "string") return { loggedIn: null, authHelp: null, permissionMode };

  if (auth === "missing") {
    const authHelp = record.auth_help;
    return {
      loggedIn: false,
      authHelp: typeof authHelp === "string" ? authHelp : "Run fx login to sign in.",
      permissionMode,
    };
  }

  // 0.0.7+ (unchanged through 0.0.10): an authenticated-but-expired,
  // non-refreshable login. Strict on both booleans by design — see the doc
  // comment above for why every other combination
  // (absent/non-boolean/`auth_refreshable !== false`) must stay fail-open
  // instead of joining this branch. Env-key auth is exempt from
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
      permissionMode,
    };
  }

  return { loggedIn: true, authHelp: null, permissionMode };
}

type StatusProbeResult = {
  loggedIn: boolean | null;
  authHelp: string | null;
  /** `status --json` `permission_mode`, probed without `FX_PERMISSION_MODE`. */
  permissionMode: string | null;
};

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

/**
 * `cachedCliVersion` memo, keyed like `statusCache` (`harness.id:path`).
 * Every OpenCode invocation — `--version` included — writes XDG dirs and
 * appends to its log (spike A12), and the version is read by the start
 * pre-flight, the argv builder and the 15s `/harnesses` poll, so one probe
 * per minute is shared by all of them. `checkHarness` primes it from its own
 * `--version` probe, so the poll never costs a second spawn.
 */
const versionCache = new Map<string, { value: string; expiresAt: number }>();

/**
 * The env a status/version probe runs with: the harness's spawn env, plus —
 * for OpenCode — `OPENCODE_DISABLE_AUTOUPDATE=1` unless the harness's own env
 * map says otherwise, same as every spawn and discovery probe: a background
 * poll must never self-update the binary.
 */
function probeEnvFor(harness: Harness): Record<string, string> {
  const env = harnessEnv(harness);
  if (harness.kind === "opencode") env.OPENCODE_DISABLE_AUTOUPDATE ??= "1";
  return env;
}

/**
 * The harness binary's `--version` first line (e.g. `opencode v2.1.3`,
 * `1.19.4`), memoized for 60 s per `harness.id:path`. A failed probe (a
 * timeout under load, a transient spawn error) is never cached — the next
 * call retries — but it returns the last version this binary reported, if
 * any, rather than `null`: `null` reads as "unknown → v2" downstream, which
 * would hand a v1 install v2-only flags (`--standalone`, `-m id#variant`).
 * `null` only when the binary isn't found or has never answered.
 */
export async function cachedCliVersion(harness: Harness): Promise<string | null> {
  const path = resolveBinPath(resolveBin(harness));
  if (!path) return null;
  const key = `${harness.id}:${path}`;
  const hit = versionCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await probeVersion(path, probeEnvFor(harness));
  if (value !== null) {
    versionCache.set(key, { value, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
    return value;
  }
  return hit?.value ?? null;
}

type CommandOutput = { code: number; stdout: string; stderr: string };

/**
 * Like `probeJson` but keeps stdout AND stderr plus the exit code (a v1
 * OpenCode clack box may land on either stream) and never rejects. `null` on
 * a spawn error or the `VERSION_PROBE_TIMEOUT_MS` timeout.
 */
async function probeOutput(bin: string, args: string[], env: Record<string, string>): Promise<CommandOutput | null> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
  } catch {
    return null;
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch { /* already gone */ }
  }, VERSION_PROBE_TIMEOUT_MS);
  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);
    return timedOut ? null : { code, stdout, stderr };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Whether an `opencode auth list` answer shows no usable credential at all
 * (`true`), at least one (`false`), or can't be read (`null`). Spike Q9/A9:
 *  - v2 `auth list --standalone --format json` → a JSON array, `[]` when
 *    empty; an env key is a connection of `type: "env"` in a non-empty list;
 *  - v1 has no `--format`: a clack text box ending `N credentials`, plus an
 *    `Environment` box ending `N environment variable(s)` when env keys are
 *    set. Empty iff `0 credentials` and no environment-variable line.
 */
export function parseOpencodeAuthList(out: string, major: 1 | 2): boolean | null {
  if (major === 2) {
    try {
      const parsed: unknown = JSON.parse(out);
      return Array.isArray(parsed) ? parsed.length === 0 : null;
    } catch {
      return null;
    }
  }
  const text = out.replace(ANSI_RE, "");
  const creds = /(\d+) credentials?/.exec(text);
  if (!creds) return null;
  const env = /(\d+) environment variables?/.exec(text);
  return Number(creds[1]) === 0 && (!env || Number(env[1]) === 0);
}

/** What OpenCode 1 prints when OpenCode 2's `opencode.db` is in its data dir. */
const OPENCODE_V1_DB_CONFLICT_RE = /Database is not empty and has no session table/;
const OPENCODE_V1_DB_CONFLICT = "v1-db-conflict" as const;
/**
 * What a harness's `auth list` probe concluded: `true` = no credentials,
 * `false` = some, `null` = the probe failed, `"v1-db-conflict"` = an OpenCode 1
 * binary refused to run because OpenCode 2 already created `opencode.db` in the
 * same home (the probe never read credentials, so it says nothing about them).
 */
type AuthProbeResult = boolean | null | typeof OPENCODE_V1_DB_CONFLICT;
const authCache = new Map<string, { value: AuthProbeResult; expiresAt: number }>();

async function probeOpencodeAuth(
  bin: string,
  env: Record<string, string>,
  version: Promise<string | null>,
): Promise<AuthProbeResult> {
  // Start with the v2 form so it overlaps the version probe: it is the only
  // form that never starts the background service (`--standalone`), and a v1
  // binary rejects `--standalone` outright (exit 1), so it can't misfire.
  const v2Args = ["auth", "list", "--standalone", "--format", "json"];
  let v2 = await probeOutput(bin, v2Args, env);
  const major = opencodeMajor(await version);
  // A v2 that has never run in this home loses the race to create
  // `opencode.db` against a concurrent `--standalone` discovery probe and
  // exits 1 ("Standalone server exited before reporting readiness", live W4
  // smoke). Retry once — the 60 s cache would otherwise hide the notice.
  if (major === 2 && (!v2 || v2.code !== 0)) v2 = await probeOutput(bin, v2Args, env);
  if (v2 && v2.code === 0) {
    const parsed = parseOpencodeAuthList(v2.stdout, 2);
    if (parsed !== null) return parsed;
  }
  if (major !== 1) return null;
  const v1 = await probeOutput(bin, ["auth", "list"], env);
  if (!v1) return null;
  const v1Text = `${v1.stdout}\n${v1.stderr}`;
  // v1 and v2 can't share one data dir: once v2 has created `opencode.db`,
  // every v1 command in that home fails with this message (live W4 smoke).
  if (OPENCODE_V1_DB_CONFLICT_RE.test(v1Text.replace(ANSI_RE, ""))) return OPENCODE_V1_DB_CONFLICT;
  if (v1.code !== 0) return null;
  return parseOpencodeAuthList(v1Text, 1);
}

/**
 * Memoized (60 s, `harness.id:path` plus the probe env, like
 * `getCachedStatus`) credential check behind the OpenCode "no credentials"
 * notice. Failures are cached too — a broken `auth list` shouldn't be
 * re-spawned on every poll tick. The env is part of the key because it
 * carries the harness home (`HOME`/`XDG_*`): editing a harness's home or env
 * points it at other credentials, and the old answer must not outlive that
 * (live W4 smoke: a home change kept the old notice for a minute).
 */
async function getCachedOpencodeAuth(
  harness: Harness,
  path: string,
  env: Record<string, string>,
  version: Promise<string | null>,
): Promise<AuthProbeResult> {
  const key = `${harness.id}:${path}:${JSON.stringify(Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))}`;
  const cached = authCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await probeOpencodeAuth(path, env, version);
  authCache.set(key, { value, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
  return value;
}

const OPENCODE_NO_CREDENTIALS_NOTICE = "No OpenCode credentials found — run `opencode auth login`";
const OPENCODE_V1_DB_CONFLICT_NOTICE =
  "OpenCode 1 can't read the data OpenCode 2 wrote in this home — give this harness its own Home in Settings → Harnesses";
const OPENCODE_V2_AVAILABLE_NOTICE = "OpenCode 2 is available: `opencode upgrade --major`";

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
 * Account identity + local usage rollup for a claude-code harness — attached
 * to every status shape (including the unavailable ones: "claude missing but
 * the account dir is logged in" is still useful in Settings). Other kinds
 * get nulls; their auth files are a separate follow-up. Live quota/limit
 * utilization is a separate concern — this is purely the local, historical,
 * no-network token rollup.
 */
function claudeAccountFields(harness: Harness): { account: ClaudeAccount | null; usage: HarnessStatus["usage"] } {
  if (harness.kind !== "claude-code") return { account: null, usage: null };
  const configDir = effectiveClaudeConfigDir(harness.home);
  return { account: readClaudeAccount(configDir), usage: accountUsageSummary(configDir) };
}

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
  const accountFields = claudeAccountFields(harness);
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
      fxProfilePermissionMode: null,
      ...accountFields,
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
        fxProfilePermissionMode: null,
        ...accountFields,
      };
    }

    // Note: claude's native-install integrity check (`$HOME/.local/bin/claude`
    // exists) used to require pre-linking into the harness HOME because we
    // re-homed the spawn. Now that we re-home via CLAUDE_CONFIG_DIR instead
    // (HOME stays at the real user home), the integrity check resolves against
    // the system install and always passes — no per-harness symlink needed.
  }

  const env = probeEnvFor(harness);
  // Started now, awaited below: the OpenCode credential probe overlaps it.
  const versionProbe = probeVersion(path, env);
  const authProbe = harness.kind === "opencode" ? getCachedOpencodeAuth(harness, path, env, versionProbe) : null;
  const version = await versionProbe;
  if (version !== null) versionCache.set(`${harness.id}:${path}`, { value: version, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });

  // fx-only pre-flight auth state. `available: true` regardless — the binary
  // IS installed and IS Vercel's fx; being logged out is a separate state
  // that startTask gates on separately (see plan doc §3.3 T5), not something
  // this probe reports as unavailable.
  let loggedIn: boolean | null = null;
  let authHelp: string | null = null;
  let fxProfilePermissionMode: string | null = null;

  // OpenCode informational notices. Neutral on purpose: keyless Zen models
  // exist, so a missing credential never blocks a run (`loggedIn` stays null).
  const notices: string[] = [];
  const noCredentials = authProbe ? await authProbe : null;
  if (harness.kind === "opencode" && version !== null) {
    if (noCredentials === OPENCODE_V1_DB_CONFLICT) notices.push(OPENCODE_V1_DB_CONFLICT_NOTICE);
    else if (noCredentials === true) notices.push(OPENCODE_NO_CREDENTIALS_NOTICE);
    if (opencodeMajor(version) === 1) notices.push(OPENCODE_V2_AVAILABLE_NOTICE);
  }

  if (harness.kind === "fx" && version !== null) {
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
        fxProfilePermissionMode: null,
        ...accountFields,
      };
    }

    ({ loggedIn, authHelp } = status);
    fxProfilePermissionMode = status.permissionMode;
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
    fxProfilePermissionMode,
    ...(notices.length > 0 ? { notices } : {}),
    ...accountFields,
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
export const __testing = {
  clearStatusCache: () => {
    statusCache.clear();
    versionCache.clear();
    authCache.clear();
  },
};

import { test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentKind, Harness } from "../shared/types.ts";

// agent-status.ts imports `harnesses` from db.ts, which opens its sqlite
// connection at module-load time — a plain top-level `import` is hoisted
// ahead of any other code in this file, so AGETOR_DATA_DIR must be set
// before a *dynamic* import instead (same pattern as harnesses.test.ts).
// Without this, this file (or whichever file `bun test` loads first) can
// silently open the real ~/.agetor-dev database.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-agent-status-db-"));
const { checkHarness, __testing } = await import("./agent-status.ts");

function builtin(kind: AgentKind): Harness {
  return { id: kind, kind, label: kind, isBuiltin: true, home: null, bin: null, env: {}, enabled: true };
}
const checkAgent = (kind: AgentKind) => checkHarness(builtin(kind));

// Capture once at load so the integrity-check tests below can restore the
// file's entry PATH regardless of how the prior test interleaved.
const ORIGINAL_PATH = process.env.PATH;
let sandbox: string | null = null;

beforeEach(() => {
  delete process.env.AGETOR_CODEX_BIN;
  delete process.env.AGETOR_CLAUDE_BIN;
  delete process.env.AGETOR_GEMINI_BIN;
  delete process.env.AGETOR_FX_BIN;
  delete process.env.AGETOR_TMUX_BIN;
  sandbox = null;
  // The fx auth-status memoization (agent-status.ts's getCachedStatus) is
  // module-level state that would otherwise leak between tests that happen
  // to reuse a harness id + path.
  __testing.clearStatusCache();
});

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

test("returns available=true with version for a real binary (claude needs tmux too)", async () => {
  // /bin/echo stands in for both claude and tmux so the dual probe passes
  // without either CLI installed. We don't assert the version string — just
  // that the probe completes and reports available.
  process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
  process.env.AGETOR_TMUX_BIN = "/bin/echo";
  const status = await checkAgent("claude-code");
  expect(status.available).toBe(true);
  expect(status.path).toBe("/bin/echo");
  expect(status.reason).toBeNull();
});

test("claude-code is unavailable when tmux is missing, with the install hint", async () => {
  process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
  process.env.AGETOR_TMUX_BIN = "definitely-not-tmux-xyz123";
  const status = await checkAgent("claude-code");
  expect(status.available).toBe(false);
  expect(status.reason).toContain("tmux");
  expect(status.installHint).toContain("tmux");
});

test("returns available=false with install hint when the bin is missing", async () => {
  process.env.AGETOR_CODEX_BIN = "definitely-not-a-real-binary-xyz123";
  const status = await checkAgent("codex");
  expect(status.available).toBe(false);
  expect(status.path).toBeNull();
  expect(status.reason).toContain("not found on PATH");
  expect(status.installHint).toContain("codex");
});

test("returns available=true with version for a real gemini binary (no tmux dependency, like codex)", async () => {
  process.env.AGETOR_GEMINI_BIN = "/bin/echo";
  const status = await checkAgent("gemini");
  expect(status.available).toBe(true);
  expect(status.path).toBe("/bin/echo");
  expect(status.reason).toBeNull();
});

test("gemini returns available=false with install hint when the bin is missing", async () => {
  process.env.AGETOR_GEMINI_BIN = "definitely-not-a-real-binary-xyz123";
  const status = await checkAgent("gemini");
  expect(status.available).toBe(false);
  expect(status.path).toBeNull();
  expect(status.reason).toContain("not found on PATH");
  expect(status.installHint).toContain("gemini");
});

/**
 * Plant a fake native-install layout on PATH so the probe finds a working
 * `claude` binary at <sandbox>/system/.local/bin/claude. Returns the harness
 * config-dir root the alias under test will use.
 *
 * Shape mirrors the real install:
 *   <sandbox>/system/.local/share/claude/versions/<v>   (binary file)
 *   <sandbox>/system/.local/bin/claude                  (symlink → version)
 */
function plantFakeNativeClaude(): { harnessHome: string } {
  sandbox = mkdtempSync(path.join(tmpdir(), "agetor-agent-status-"));
  const systemHome = path.join(sandbox, "system");
  const versionsDir = path.join(systemHome, ".local", "share", "claude", "versions");
  const sysBinDir = path.join(systemHome, ".local", "bin");
  mkdirSync(versionsDir, { recursive: true });
  mkdirSync(sysBinDir, { recursive: true });
  const realBinary = path.join(versionsDir, "9.9.9");
  writeFileSync(realBinary, "#!/bin/sh\necho 9.9.9 (fake)\n", { mode: 0o755 });
  symlinkSync(realBinary, path.join(sysBinDir, "claude"));
  process.env.PATH = `${sysBinDir}:${process.env.PATH}`;
  // tmux probe needs to pass — point at any binary that exits 0 on --version.
  process.env.AGETOR_TMUX_BIN = "/bin/echo";

  const harnessHome = path.join(sandbox, "harness");
  mkdirSync(harnessHome, { recursive: true });
  return { harnessHome };
}

test("claude-code alias with a CLAUDE_CONFIG_DIR override is available without pre-linking the harness home", async () => {
  // Regression: previously we set HOME=<harness home> on spawn and so had to
  // pre-link <harness home>/.local/bin/claude to satisfy claude's native-
  // install integrity check. After switching to CLAUDE_CONFIG_DIR=<home> the
  // user's real $HOME is unchanged, the integrity check resolves against the
  // system install, and no per-harness symlink is required.
  const { harnessHome } = plantFakeNativeClaude();
  const alias: Harness = {
    id: "claude-alt",
    kind: "claude-code",
    label: "Claude (alt)",
    isBuiltin: false,
    home: harnessHome,
    bin: null,
    env: {},
    enabled: true,
  };

  const status = await checkHarness(alias);
  expect(status.available).toBe(true);
  expect(status.reason).toBeNull();
});

// --- fx --------------------------------------------------------------------
// fx's probe is the only one with a second, help-text stage: the bare name
// `fx` collides with a popular npm JSON-viewer CLI, so a `--version`
// exit-status check alone can't distinguish them — checkHarness additionally
// probes `--help` and looks for a marker string unique to Vercel's fx
// ("coding agent"). See agent-status.ts's probeHelp/FX_HELP_MARKER.

test("fx returns available=false with install hint when the bin is missing", async () => {
  process.env.AGETOR_FX_BIN = "definitely-not-a-real-binary-xyz123";
  const status = await checkAgent("fx");
  expect(status.available).toBe(false);
  expect(status.path).toBeNull();
  expect(status.reason).toContain("not found on PATH");
  expect(status.installHint).toContain("fx.sh");
});

/**
 * Plant a fake `fx` binary at <dir>/fx that answers `--version` with exit 0
 * plus a version string, and `--help` with `helpText` on stdout — mirroring
 * the dual-probe contract `checkHarness` runs for kind `"fx"`
 * (probeVersion, then probeHelp gated on a non-null version). Returns the
 * fake binary's absolute path; registers the containing dir in `sandbox` so
 * `afterEach` cleans it up.
 */
function plantFakeFxBin(helpText: string): string {
  sandbox = mkdtempSync(path.join(tmpdir(), "agetor-agent-status-fx-"));
  const bin = path.join(sandbox, "fx");
  writeFileSync(
    bin,
    `#!/bin/sh\n`
      + `if [ "$1" = "--version" ]; then echo "0.0.4"; exit 0; fi\n`
      + `if [ "$1" = "--help" ]; then echo "${helpText}"; exit 0; fi\n`
      + `exit 1\n`,
    { mode: 0o755 },
  );
  return bin;
}

test("fx returns available=true when --version succeeds and --help contains the 'coding agent' marker", async () => {
  process.env.AGETOR_FX_BIN = plantFakeFxBin("Fast, native coding agent for the terminal");
  const status = await checkAgent("fx");
  expect(status.available).toBe(true);
  expect(status.version).toBe("0.0.4");
  expect(status.reason).toBeNull();
  expect(status.installHint).toBeNull();
});

test("fx returns available=false with the wrong-binary hint when --help lacks the marker (e.g. the npm JSON-viewer 'fx')", async () => {
  process.env.AGETOR_FX_BIN = plantFakeFxBin("Terminal JSON viewer");
  const status = await checkAgent("fx");
  expect(status.available).toBe(false);
  expect(status.version).toBe("0.0.4");
  expect(status.reason).toContain("doesn't look like Vercel fx");
  expect(status.installHint).toContain("fx.sh");
});

// --- fx login pre-flight (probeStatus / `fx status --json`) ----------------
// Only reached once the --version/--help dual-probe above already identifies
// the binary as real fx. `probeStatus` is strictly FAIL-OPEN: only a
// positively-parsed `auth === "missing"` counts as logged out; anything else
// (empty output, non-JSON, non-zero exit, an unrecognized shape) must degrade
// to `loggedIn: null`, never a false "logged out" — see agent-status.ts's
// probeStatus doc comment.

/**
 * Plant a fake `fx` binary that satisfies the --version/--help dual probe
 * (so `checkHarness` actually reaches probeStatus) and additionally answers
 * `status <anything>` (covers the real `status --json` invocation) per the
 * `statusBody` shell snippet supplied by the caller — e.g. `echo '...'; exit
 * 0` or just `exit 1`. Registers the containing dir in `sandbox` for cleanup.
 */
function plantFakeFxStatusBin(statusBody: string): string {
  sandbox = mkdtempSync(path.join(tmpdir(), "agetor-agent-status-fx-status-"));
  const bin = path.join(sandbox, "fx");
  writeFileSync(
    bin,
    `#!/bin/sh\n`
      + `if [ "$1" = "--version" ]; then echo "0.0.6"; exit 0; fi\n`
      + `if [ "$1" = "--help" ]; then echo "Fast, native coding agent for the terminal"; exit 0; fi\n`
      + `if [ "$1" = "status" ]; then\n  ${statusBody}\nfi\n`
      + `exit 1\n`,
    { mode: 0o755 },
  );
  return bin;
}

test("fx status --json auth:missing with auth_help -> loggedIn:false, authHelp verbatim, available stays true", async () => {
  process.env.AGETOR_FX_BIN = plantFakeFxStatusBin(
    `echo '{"auth":"missing","auth_help":"Run fx login"}'\n  exit 0`,
  );
  const status = await checkAgent("fx");
  expect(status.available).toBe(true);
  expect(status.loggedIn).toBe(false);
  expect(status.authHelp).toBe("Run fx login");
});

test("fx status --json auth:missing without auth_help -> fallback authHelp text", async () => {
  process.env.AGETOR_FX_BIN = plantFakeFxStatusBin(`echo '{"auth":"missing"}'\n  exit 0`);
  const status = await checkAgent("fx");
  expect(status.available).toBe(true);
  expect(status.loggedIn).toBe(false);
  // Exact fallback string from probeStatus (agent-status.ts) — asserted
  // verbatim so a future copy edit there is caught here too.
  expect(status.authHelp).toBe("Run fx login to sign in.");
});

test("fx status --json auth:ok (any non-'missing' value) -> loggedIn:true, authHelp:null", async () => {
  process.env.AGETOR_FX_BIN = plantFakeFxStatusBin(`echo '{"auth":"ok","plan":"pro"}'\n  exit 0`);
  const status = await checkAgent("fx");
  expect(status.available).toBe(true);
  expect(status.loggedIn).toBe(true);
  expect(status.authHelp).toBeNull();
});

test("fx status --json prints nothing -> fail-open (loggedIn:null, authHelp:null), available still true", async () => {
  process.env.AGETOR_FX_BIN = plantFakeFxStatusBin(`exit 0`);
  const status = await checkAgent("fx");
  expect(status.available).toBe(true);
  expect(status.loggedIn).toBeNull();
  expect(status.authHelp).toBeNull();
});

test("fx status --json prints non-JSON -> fail-open (loggedIn:null, authHelp:null)", async () => {
  process.env.AGETOR_FX_BIN = plantFakeFxStatusBin(`echo 'not json at all'\n  exit 0`);
  const status = await checkAgent("fx");
  expect(status.available).toBe(true);
  expect(status.loggedIn).toBeNull();
  expect(status.authHelp).toBeNull();
});

test("fx status --json exits non-zero (even with parseable JSON on stdout) -> fail-open (loggedIn:null)", async () => {
  process.env.AGETOR_FX_BIN = plantFakeFxStatusBin(`echo '{"auth":"missing"}'\n  exit 1`);
  const status = await checkAgent("fx");
  expect(status.available).toBe(true);
  expect(status.loggedIn).toBeNull();
  expect(status.authHelp).toBeNull();
});

test("a non-fx kind never populates loggedIn/authHelp (stays null even when available)", async () => {
  process.env.AGETOR_CODEX_BIN = "/bin/echo";
  const status = await checkAgent("codex");
  expect(status.available).toBe(true);
  expect(status.loggedIn).toBeNull();
  expect(status.authHelp).toBeNull();
});

// --- fx status --json expired-login gate (0.0.7+) ---------------------------
// New in 0.0.7: a login-style `auth` value (not "missing", not an env-key
// value) can also read as logged-out when `auth_expired === true` AND
// `auth_refreshable === false` — both strict booleans. Every other shape
// (absent fields, a refreshable expiry, or a non-boolean value on either
// field) stays fail-open (loggedIn:true), exactly as pre-0.0.7. Env-key auth
// (`AI_GATEWAY_API_KEY`/`VERCEL_OIDC_TOKEN`) is exempt from this gate
// entirely — see agent-status.ts's probeStatus doc comment.

test("fx status --json expired + non-refreshable login, no auth_help -> loggedIn:false, fallback expired-login text", async () => {
  process.env.AGETOR_FX_BIN = plantFakeFxStatusBin(
    `echo '{"auth":"fx login","auth_expired":true,"auth_refreshable":false}'\n  exit 0`,
  );
  const status = await checkAgent("fx");
  expect(status.available).toBe(true);
  expect(status.loggedIn).toBe(false);
  // Exact fallback string from probeStatus (agent-status.ts) — asserted
  // verbatim so a future copy edit there is caught here too.
  expect(status.authHelp).toBe("fx login has expired — run fx login to sign in again.");
});

test("fx status --json expired + non-refreshable login, with auth_help -> authHelp verbatim from fx", async () => {
  process.env.AGETOR_FX_BIN = plantFakeFxStatusBin(
    `echo '{"auth":"fx login","auth_expired":true,"auth_refreshable":false,"auth_help":"custom fx text"}'\n  exit 0`,
  );
  const status = await checkAgent("fx");
  expect(status.loggedIn).toBe(false);
  expect(status.authHelp).toBe("custom fx text");
});

test("fx status --json expired but still refreshable -> stays fail-open, loggedIn:true", async () => {
  process.env.AGETOR_FX_BIN = plantFakeFxStatusBin(
    `echo '{"auth":"fx login","auth_expired":true,"auth_refreshable":true}'\n  exit 0`,
  );
  const status = await checkAgent("fx");
  expect(status.loggedIn).toBe(true);
  expect(status.authHelp).toBeNull();
});

test("fx status --json 0.0.6-shaped payload (auth_expired/auth_refreshable absent entirely) -> loggedIn:true (pre-0.0.7 regression)", async () => {
  process.env.AGETOR_FX_BIN = plantFakeFxStatusBin(`echo '{"auth":"fx login"}'\n  exit 0`);
  const status = await checkAgent("fx");
  expect(status.loggedIn).toBe(true);
  expect(status.authHelp).toBeNull();
});

test('fx status --json auth_expired is a non-boolean string ("yes") -> fails open, loggedIn:true', async () => {
  process.env.AGETOR_FX_BIN = plantFakeFxStatusBin(
    `echo '{"auth":"fx login","auth_expired":"yes","auth_refreshable":false}'\n  exit 0`,
  );
  const status = await checkAgent("fx");
  expect(status.loggedIn).toBe(true);
  expect(status.authHelp).toBeNull();
});

test("fx status --json auth_expired is a non-boolean number (1) -> fails open, loggedIn:true", async () => {
  process.env.AGETOR_FX_BIN = plantFakeFxStatusBin(
    `echo '{"auth":"fx login","auth_expired":1,"auth_refreshable":false}'\n  exit 0`,
  );
  const status = await checkAgent("fx");
  expect(status.loggedIn).toBe(true);
  expect(status.authHelp).toBeNull();
});

test('fx status --json auth_refreshable is a non-boolean string ("false") -> fails open, loggedIn:true', async () => {
  process.env.AGETOR_FX_BIN = plantFakeFxStatusBin(
    `echo '{"auth":"fx login","auth_expired":true,"auth_refreshable":"false"}'\n  exit 0`,
  );
  const status = await checkAgent("fx");
  expect(status.loggedIn).toBe(true);
  expect(status.authHelp).toBeNull();
});

test("fx status --json auth_refreshable is a non-boolean number (0) -> fails open, loggedIn:true", async () => {
  process.env.AGETOR_FX_BIN = plantFakeFxStatusBin(
    `echo '{"auth":"fx login","auth_expired":true,"auth_refreshable":0}'\n  exit 0`,
  );
  const status = await checkAgent("fx");
  expect(status.loggedIn).toBe(true);
  expect(status.authHelp).toBeNull();
});

test("fx status --json auth:AI_GATEWAY_API_KEY is exempt from the expired-login gate -> always loggedIn:true", async () => {
  process.env.AGETOR_FX_BIN = plantFakeFxStatusBin(
    `echo '{"auth":"AI_GATEWAY_API_KEY","auth_expired":true,"auth_refreshable":false}'\n  exit 0`,
  );
  const status = await checkAgent("fx");
  expect(status.loggedIn).toBe(true);
  expect(status.authHelp).toBeNull();
});

test("fx status --json auth:VERCEL_OIDC_TOKEN is exempt from the expired-login gate -> always loggedIn:true", async () => {
  process.env.AGETOR_FX_BIN = plantFakeFxStatusBin(
    `echo '{"auth":"VERCEL_OIDC_TOKEN","auth_expired":true,"auth_refreshable":false}'\n  exit 0`,
  );
  const status = await checkAgent("fx");
  expect(status.loggedIn).toBe(true);
  expect(status.authHelp).toBeNull();
});

/**
 * A realistic full 0.0.7 `status --json` payload — the additive fields real
 * fx 0.0.7 emits (`mcp`, `mcp_config_warning`, `team`, plus ordinary account/
 * config metadata) alongside the fields probeStatus actually reads (`auth`,
 * `auth_help`, `auth_expired`, `auth_refreshable`). Every unread field must be
 * silently ignored (probeStatus's unknown-fields-are-fine contract) rather
 * than causing a parse failure or a fail-open result.
 */
function fullFxStatusPayload(authRefreshable: boolean): string {
  return JSON.stringify({
    version: "0.0.7",
    auth: "fx login",
    auth_help: null,
    auth_expired: true,
    auth_refreshable: authRefreshable,
    team: "acme",
    account: "user@example.com",
    default_model: "zai/glm-5.3-flash",
    config_path: "/home/user/.fx/config.json",
    log_file: "/home/user/.fx/logs/fx.log",
    sandbox: "none",
    updated_at: "2026-08-31T00:00:00Z",
    mcp: {
      connection_check: "not_checked",
      servers: [],
      configuration_issues: [],
      inspection_error: null,
    },
    mcp_config_warning: null,
  });
}

test("fx status --json full realistic 0.0.7 payload (mcp/team/etc additive fields) with auth_refreshable:true -> parses fine, loggedIn:true", async () => {
  process.env.AGETOR_FX_BIN = plantFakeFxStatusBin(`echo '${fullFxStatusPayload(true)}'\n  exit 0`);
  const status = await checkAgent("fx");
  expect(status.available).toBe(true);
  expect(status.loggedIn).toBe(true);
  expect(status.authHelp).toBeNull();
});

test("fx status --json full realistic 0.0.7 payload with auth_refreshable:false -> parses fine, loggedIn:false", async () => {
  process.env.AGETOR_FX_BIN = plantFakeFxStatusBin(`echo '${fullFxStatusPayload(false)}'\n  exit 0`);
  const status = await checkAgent("fx");
  expect(status.available).toBe(true);
  expect(status.loggedIn).toBe(false);
  // auth_help is explicitly `null` in this payload (a real fx omitting a
  // string there), so probeStatus's fallback text kicks in.
  expect(status.authHelp).toBe("fx login has expired — run fx login to sign in again.");
});

// --- fx status cache (getCachedStatus / statusCache in agent-status.ts) ----
// `checkHarness`'s fx-only auth pre-flight spawns `fx status --json`. Without
// memoization the 15s `/harnesses` poll (App.tsx's checkAllHarnesses) would
// re-spawn it on every tick forever, for every fx harness. These tests count
// spawns via a fake binary that appends a line to a counter file each time
// `status` is invoked, rather than asserting on wall-clock timing.

/**
 * Plant a fake `fx` binary that satisfies the --version/--help dual probe and
 * answers `status <anything>` with a fixed `{"auth":"ok"}", appending one line
 * to `counterFile` per invocation so tests can assert spawn counts.
 */
function plantFakeFxStatusCountingBin(counterFile: string): string {
  sandbox = mkdtempSync(path.join(tmpdir(), "agetor-agent-status-fx-cache-"));
  const bin = path.join(sandbox, "fx");
  writeFileSync(
    bin,
    `#!/bin/sh\n`
      + `if [ "$1" = "--version" ]; then echo "0.0.6"; exit 0; fi\n`
      + `if [ "$1" = "--help" ]; then echo "Fast, native coding agent for the terminal"; exit 0; fi\n`
      + `if [ "$1" = "status" ]; then\n  echo x >> "${counterFile}"\n  echo '{"auth":"ok"}'\n  exit 0\nfi\n`
      + `exit 1\n`,
    { mode: 0o755 },
  );
  return bin;
}

function countInvocations(counterFile: string): number {
  try {
    return readFileSync(counterFile, "utf8").split("\n").filter((l) => l.length > 0).length;
  } catch {
    return 0;
  }
}

test("checkHarness memoizes fx status --json: a second call within the TTL doesn't re-spawn", async () => {
  const counterDir = mkdtempSync(path.join(tmpdir(), "agetor-agent-status-fx-counter-"));
  const counterFile = path.join(counterDir, "count");
  try {
    process.env.AGETOR_FX_BIN = plantFakeFxStatusCountingBin(counterFile);
    const harness = builtin("fx");

    const first = await checkHarness(harness);
    expect(first.loggedIn).toBe(true);
    const second = await checkHarness(harness);
    expect(second.loggedIn).toBe(true);

    expect(countInvocations(counterFile)).toBe(1);
  } finally {
    rmSync(counterDir, { recursive: true, force: true });
  }
});

test("checkHarness({ freshAuth: true }) bypasses the cache and re-spawns status --json every call", async () => {
  const counterDir = mkdtempSync(path.join(tmpdir(), "agetor-agent-status-fx-counter-"));
  const counterFile = path.join(counterDir, "count");
  try {
    process.env.AGETOR_FX_BIN = plantFakeFxStatusCountingBin(counterFile);
    const harness = builtin("fx");

    await checkHarness(harness, { freshAuth: true });
    await checkHarness(harness, { freshAuth: true });

    expect(countInvocations(counterFile)).toBe(2);
  } finally {
    rmSync(counterDir, { recursive: true, force: true });
  }
});

test("checkHarness re-probes once the cached entry's TTL has expired (stale-cache-then-fresh)", async () => {
  const counterDir = mkdtempSync(path.join(tmpdir(), "agetor-agent-status-fx-counter-"));
  const counterFile = path.join(counterDir, "count");
  try {
    process.env.AGETOR_FX_BIN = plantFakeFxStatusCountingBin(counterFile);
    const harness = builtin("fx");

    await checkHarness(harness);
    expect(countInvocations(counterFile)).toBe(1);

    // Still within the TTL: cache hit, no second spawn.
    await checkHarness(harness);
    expect(countInvocations(counterFile)).toBe(1);

    // Jump the clock past the 60s TTL — the next call must re-probe.
    setSystemTime(new Date(Date.now() + 61_000));
    try {
      await checkHarness(harness);
      expect(countInvocations(counterFile)).toBe(2);
    } finally {
      setSystemTime(); // restore real time for subsequent tests
    }
  } finally {
    rmSync(counterDir, { recursive: true, force: true });
  }
});

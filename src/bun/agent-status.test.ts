import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const { checkHarness } = await import("./agent-status.ts");

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
  delete process.env.AGETOR_TMUX_BIN;
  sandbox = null;
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

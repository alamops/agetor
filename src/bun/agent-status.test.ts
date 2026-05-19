import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkHarness } from "./agent-status.ts";
import type { AgentKind, Harness } from "../shared/types.ts";

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

/**
 * Plant a fake native-install layout on PATH so detectClaudeNativeInstall
 * recognises the system claude as native. Returns the harness HOME root and
 * the binary path agent-status will probe via --version.
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

test("claude-code alias is unavailable when the native-install integrity symlink is missing", async () => {
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
  expect(status.available).toBe(false);
  expect(status.reason).toContain(".local/bin/claude");
  expect(status.reason).toContain("integrity check");
  expect(status.installHint).toContain("repair");
});

test("claude-code alias is available when the integrity symlink is present", async () => {
  const { harnessHome } = plantFakeNativeClaude();
  // Pre-populate the same symlink that prepareClaudeHarnessHome would create.
  const harnessBin = path.join(harnessHome, ".local", "bin");
  mkdirSync(harnessBin, { recursive: true });
  // Point at any string — existsSync only checks for presence, and probeVersion
  // runs the actual system claude (via resolveBin → Bun.which), not this link.
  symlinkSync("/bin/echo", path.join(harnessBin, "claude"));

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

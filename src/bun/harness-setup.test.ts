import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readlinkSync, lstatSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { detectClaudeNativeInstall, linkClaudeNativeBinIntoHome } from "./harness-setup.ts";

let sandbox: string;
// Capture once at module load so every test restores to the file's entry
// PATH — not whatever a previous test happened to set. `afterEach`'s restore
// becomes obviously correct regardless of test interleaving.
const ORIGINAL_PATH = process.env.PATH;

/**
 * Construct a fake native-install layout under `<sandbox>/system/`:
 *   .local/share/claude/versions/<v>   (real binary file)
 *   .local/bin/claude                  (symlink → the version file)
 * and put the bin dir on PATH so `Bun.which("claude")` resolves to it.
 *
 * Returns the symlink path that detectClaudeNativeInstall is expected to return.
 */
function installFakeClaude(version = "9.9.9"): { symlink: string; binary: string } {
  const systemHome = path.join(sandbox, "system");
  const versionsDir = path.join(systemHome, ".local", "share", "claude", "versions");
  const binDir = path.join(systemHome, ".local", "bin");
  mkdirSync(versionsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const binary = path.join(versionsDir, version);
  // Marker file masquerading as the binary — detectClaudeNativeInstall only
  // checks path shape, never executes anything.
  writeFileSync(binary, "#!/bin/sh\necho fake claude\n", { mode: 0o755 });
  const symlink = path.join(binDir, "claude");
  symlinkSync(binary, symlink);
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  return { symlink, binary };
}

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "agetor-harness-setup-"));
});

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  rmSync(sandbox, { recursive: true, force: true });
});

test("detectClaudeNativeInstall recognizes the native install layout", () => {
  const { symlink, binary } = installFakeClaude();
  const detected = detectClaudeNativeInstall();
  expect(detected).not.toBeNull();
  expect(detected!.symlink).toBe(symlink);
  // realpath canonicalises symlinks (e.g. /var → /private/var on macOS),
  // so compare against the canonicalised expectation.
  expect(detected!.binary).toBe(realpathSync(binary));
});

test("detectClaudeNativeInstall returns null when claude is not a native install", () => {
  // Put a non-native fake on PATH (lives directly in a flat bin dir, not
  // under `.local/share/claude/versions/`).
  const binDir = path.join(sandbox, "npm-style", "bin");
  mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, "claude");
  writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  expect(detectClaudeNativeInstall()).toBeNull();
});

test("linkClaudeNativeBinIntoHome populates a fresh harness HOME with the integrity symlink", () => {
  const { symlink } = installFakeClaude();
  const harnessHome = path.join(sandbox, "harness", "claude-alt");
  mkdirSync(harnessHome, { recursive: true });

  const result = linkClaudeNativeBinIntoHome(harnessHome);
  expect(result.linked).toBe(true);
  expect(result.target).toBe(symlink);

  const linkedPath = path.join(harnessHome, ".local", "bin", "claude");
  expect(existsSync(linkedPath)).toBe(true);
  expect(lstatSync(linkedPath).isSymbolicLink()).toBe(true);
  // We point at the system *symlink*, not the resolved version binary, so
  // future auto-updates retarget transparently.
  expect(readlinkSync(linkedPath)).toBe(symlink);
});

test("linkClaudeNativeBinIntoHome is idempotent — second call leaves an existing link alone", () => {
  installFakeClaude();
  const harnessHome = path.join(sandbox, "harness", "claude-idempotent");
  mkdirSync(harnessHome, { recursive: true });

  const first = linkClaudeNativeBinIntoHome(harnessHome);
  expect(first.linked).toBe(true);

  const second = linkClaudeNativeBinIntoHome(harnessHome);
  expect(second.linked).toBe(false);
  expect(second.reason).toMatch(/already exists/);
});

test("linkClaudeNativeBinIntoHome is a no-op when system claude isn't a native install", () => {
  const binDir = path.join(sandbox, "npm-style", "bin");
  mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, "claude");
  writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
  process.env.PATH = `${binDir}:${process.env.PATH}`;

  const harnessHome = path.join(sandbox, "harness", "claude-noop");
  mkdirSync(harnessHome, { recursive: true });

  const result = linkClaudeNativeBinIntoHome(harnessHome);
  expect(result.linked).toBe(false);
  expect(result.reason).toMatch(/not a native install/);
  expect(existsSync(path.join(harnessHome, ".local", "bin", "claude"))).toBe(false);
});

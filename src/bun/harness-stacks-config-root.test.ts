// The single config-root resolver (harness-config-root.ts, review S17): every
// reader of an account's files must land where the spawn's `harnessEnv`
// points the CLI, including the env-map HOME and blank-value cases.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

// claude-session-scan.ts reaches db.ts through its imports on some paths;
// keep any database this file opens in a temp dir (CLAUDE.md, Tests).
process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-config-root-"));

const root = await import("./harness-config-root.ts");
const { claudeConfigDirsToScan } = await import("./claude-session-scan.ts");

const KEYS = ["CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;
const saved = new Map<string, string | undefined>();
beforeEach(() => {
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});
afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("claude", () => {
  test("precedence: env map CLAUDE_CONFIG_DIR, home, process, env-map HOME, real home", () => {
    expect(root.claudeConfigDirFor({ home: "/h", env: { CLAUDE_CONFIG_DIR: "/pin", HOME: "/eh" } })).toBe("/pin");
    expect(root.claudeConfigDirFor({ home: "/h", env: { HOME: "/eh" } })).toBe("/h");
    expect(root.claudeConfigDirFor({ home: null, env: { HOME: "/eh" } })).toBe("/eh/.claude");
    expect(root.claudeJsonDirFor({ home: null, env: { HOME: "/eh" } })).toBe("/eh");
    expect(root.claudeConfigDirEnvFor({ home: null, env: { HOME: "/eh" } })).toBeNull();
    expect(root.claudeConfigDirFor({ home: null })).toBe(path.join(homedir(), ".claude"));
    expect(root.claudeJsonDirFor({ home: null })).toBe(homedir());

    process.env.CLAUDE_CONFIG_DIR = "/proc";
    // The inherited process value reaches the spawn ahead of an env-map HOME.
    expect(root.claudeConfigDirFor({ home: null, env: { HOME: "/eh" } })).toBe("/proc");
    expect(root.claudeJsonDirFor({ home: null, env: { HOME: "/eh" } })).toBe("/proc");
    expect(root.claudeConfigDirEnvFor({ home: null, env: {} })).toBe("/proc");
  });

  test("blank values are unset", () => {
    expect(root.claudeConfigDirFor({ home: "/h", env: { CLAUDE_CONFIG_DIR: "" } })).toBe("/h");
    expect(root.claudeJsonDirFor({ home: "/h", env: { CLAUDE_CONFIG_DIR: " " } })).toBe("/h");
    expect(root.claudeConfigDirFor({ home: null, env: { HOME: "  " } })).toBe(path.join(homedir(), ".claude"));
    process.env.CLAUDE_CONFIG_DIR = "   ";
    expect(root.claudeConfigDirFor({ home: null })).toBe(path.join(homedir(), ".claude"));
    expect(root.claudeConfigDirEnvFor({ home: null })).toBeNull();
  });

  test("the session scanner reads an env-map HOME account's root", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "agetor-scan-home-"));
    const envHome = mkdtempSync(path.join(tmpdir(), "agetor-scan-envhome-"));
    mkdirSync(path.join(envHome, ".claude"), { recursive: true });
    const dirs = claudeConfigDirsToScan({
      homeDir: fakeHome,
      env: {},
      harnesses: [{ id: "c-envhome", kind: "claude-code", home: null, env: { HOME: envHome } }],
    });
    expect(dirs).toContain(path.join(envHome, ".claude"));
  });
});

describe("codex", () => {
  test("precedence: env map CODEX_HOME, <home>/.codex, process, env-map HOME, real home", () => {
    expect(root.codexHomeFor({ home: "/h", env: { CODEX_HOME: "/pin", HOME: "/eh" } })).toBe("/pin");
    expect(root.codexHomeFor({ home: "/h", env: { HOME: "/eh" } })).toBe("/h/.codex");
    expect(root.codexHomeFor({ home: null, env: { HOME: "/eh" } })).toBe("/eh/.codex");
    expect(root.codexHomeFor({ home: null })).toBe(path.join(homedir(), ".codex"));
    process.env.CODEX_HOME = "/proc";
    expect(root.codexHomeFor({ home: null, env: { HOME: "/eh" } })).toBe("/proc");
    expect(root.codexHomeFor({ home: "/h" })).toBe("/h/.codex");
  });

  test("blank values are unset", () => {
    expect(root.codexHomeFor({ home: "/h", env: { CODEX_HOME: "" } })).toBe("/h/.codex");
    process.env.CODEX_HOME = " ";
    expect(root.codexHomeFor({ home: null, env: { HOME: "/eh" } })).toBe("/eh/.codex");
  });
});

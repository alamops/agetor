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
const { buildCommand, harnessEnv, fakeTranscriptDirFor } = await import("./agents.ts");
const { pinClaudeConfigDir, buildClaudeSessionEnv, claudeReadRootsForLaunch } = await import("./claude-tmux.ts");
const shared = await import("../shared/harness-config-root.ts");

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
    // The spawn pin is the env map / home only: an env-map HOME alone pins
    // nothing, so claude keeps its unsuffixed keychain item (CR1, R-M1).
    expect(root.claudeConfigDirOverrideFor({ home: null, env: { HOME: "/eh" } })).toBeNull();
    expect(root.claudeConfigDirOverrideFor({ home: "/h", env: { HOME: "/eh" } })).toBe("/h");
    expect(root.claudeConfigDirOverrideFor({ home: "/h", env: { CLAUDE_CONFIG_DIR: "/pin" } })).toBe("/pin");
    expect(root.claudeConfigDirFor({ home: null })).toBe(path.join(homedir(), ".claude"));
    expect(root.claudeJsonDirFor({ home: null })).toBe(homedir());

    process.env.CLAUDE_CONFIG_DIR = "/proc";
    // The inherited process value reaches the spawn ahead of an env-map HOME.
    expect(root.claudeConfigDirFor({ home: null, env: { HOME: "/eh" } })).toBe("/proc");
    expect(root.claudeJsonDirFor({ home: null, env: { HOME: "/eh" } })).toBe("/proc");
    expect(root.claudeConfigDirEnvFor({ home: null, env: {} })).toBe("/proc");
    expect(root.claudeConfigDirOverrideFor({ home: null, env: {} })).toBeNull();
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

  test("the pin is what harnessEnv pins: env map, else <home>/.codex, never an env-map HOME", () => {
    expect(root.codexHomeOverrideFor({ home: null, env: { HOME: "/eh" } })).toBeNull();
    expect(root.codexHomeOverrideFor({ home: "/h", env: {} })).toBe("/h/.codex");
    expect(root.codexHomeOverrideFor({ home: "/h", env: { CODEX_HOME: "/pin" } })).toBe("/pin");
    const shapes: Array<{ home: string | null; env: Record<string, string> }> = [
      { home: null, env: { HOME: "/eh" } },
      { home: "/h", env: {} },
      { home: "/h", env: { CODEX_HOME: "/pin", HOME: "/eh" } },
      { home: null, env: {} },
    ];
    for (const shape of shapes) {
      const env = harnessEnv({ id: "c", kind: "codex", label: "c", isBuiltin: false, enabled: true, bin: null, ...shape } as never);
      expect(env.CODEX_HOME ?? null, JSON.stringify(shape)).toBe(root.codexHomeOverrideFor(shape));
    }
  });

  test("blank values are unset", () => {
    expect(root.codexHomeFor({ home: "/h", env: { CODEX_HOME: "" } })).toBe("/h/.codex");
    process.env.CODEX_HOME = " ";
    expect(root.codexHomeFor({ home: null, env: { HOME: "/eh" } })).toBe("/eh/.codex");
  });
});

/**
 * Parity (CR1, review R-M1): for every account shape, the directories the
 * real spawn env makes claude read (buildCommand → harnessEnv →
 * pinClaudeConfigDir, read back by claudeReadRootsForLaunch: claude's own
 * `CLAUDE_CONFIG_DIR || <HOME>/.claude` rule) are exactly what the readers'
 * claudeConfigDirFor / claudeJsonDirFor return.
 */
describe("claude spawn ↔ reader parity", () => {
  const harness = (shape: { home: string | null; env: Record<string, string> }) =>
    ({ id: "claude-shape", kind: "claude-code", label: "shape", isBuiltin: false, enabled: true, bin: null, ...shape }) as never;

  const shapes: Array<{ name: string; home: string | null; env: Record<string, string>; proc?: string; configDir: string; jsonDir: string; pinned: string | null }> = [
    { name: "built-in", home: null, env: {}, configDir: path.join(homedir(), ".claude"), jsonDir: homedir(), pinned: null },
    { name: "built-in + process dir", home: null, env: {}, proc: "/proc-dir", configDir: "/proc-dir", jsonDir: "/proc-dir", pinned: "/proc-dir" },
    { name: "home", home: "/h/claude-b", env: {}, configDir: "/h/claude-b", jsonDir: "/h/claude-b", pinned: "/h/claude-b" },
    { name: "home with trailing slash (hashed as given)", home: "/h/claude-b/", env: {}, configDir: "/h/claude-b/", jsonDir: "/h/claude-b/", pinned: "/h/claude-b/" },
    { name: "env CLAUDE_CONFIG_DIR", home: null, env: { CLAUDE_CONFIG_DIR: "/pin" }, configDir: "/pin", jsonDir: "/pin", pinned: "/pin" },
    { name: "env CLAUDE_CONFIG_DIR over home", home: "/h", env: { CLAUDE_CONFIG_DIR: "/pin" }, configDir: "/pin", jsonDir: "/pin", pinned: "/pin" },
    { name: "env HOME only", home: null, env: { HOME: "/eh" }, configDir: "/eh/.claude", jsonDir: "/eh", pinned: null },
    { name: "env HOME only + process dir", home: null, env: { HOME: "/eh" }, proc: "/proc-dir", configDir: "/proc-dir", jsonDir: "/proc-dir", pinned: "/proc-dir" },
    { name: "env HOME only + blank process dir", home: null, env: { HOME: "/eh" }, proc: "   ", configDir: "/eh/.claude", jsonDir: "/eh", pinned: null },
    { name: "home + env HOME", home: "/h", env: { HOME: "/eh" }, configDir: "/h", jsonDir: "/h", pinned: "/h" },
    { name: "blank env CLAUDE_CONFIG_DIR + home", home: "/h", env: { CLAUDE_CONFIG_DIR: " " }, configDir: "/h", jsonDir: "/h", pinned: "/h" },
    { name: "blank env HOME", home: null, env: { HOME: "  " }, configDir: path.join(homedir(), ".claude"), jsonDir: homedir(), pinned: null },
  ];

  for (const shape of shapes) {
    test(shape.name, () => {
      if (shape.proc !== undefined) process.env.CLAUDE_CONFIG_DIR = shape.proc;
      const h = harness(shape);
      const built = buildCommand(h, "hello", { model: "sonnet", effort: "medium" });
      const launch = pinClaudeConfigDir(built.cmd, buildClaudeSessionEnv(built.env ?? {}), root.claudeConfigDirOverrideFor(h));
      // What claude receives as CLAUDE_CONFIG_DIR (the keychain hash input).
      const unset = launch.argv[0] === "/usr/bin/env" && launch.argv[2] === "CLAUDE_CONFIG_DIR";
      const received = unset ? null : launch.env.CLAUDE_CONFIG_DIR ?? null;
      expect(received).toBe(shape.pinned);
      expect(root.claudeConfigDirEnvFor(h)).toBe(shape.pinned);

      const reads = claudeReadRootsForLaunch(launch, homedir());
      expect(reads.configDir).toBe(shape.configDir);
      expect(reads.claudeJsonDir).toBe(shape.jsonDir);
      expect(root.claudeConfigDirFor(h)).toBe(reads.configDir);
      expect(root.claudeJsonDirFor(h)).toBe(reads.claudeJsonDir);
    });
  }

  test("an env-map HOME account spawns exactly as before stacks: no CLAUDE_CONFIG_DIR (R-M1)", () => {
    const h = harness({ home: null, env: { HOME: "/eh" } });
    const built = buildCommand(h, "hello", { model: "sonnet", effort: "medium" });
    const launch = pinClaudeConfigDir(built.cmd, buildClaudeSessionEnv(built.env ?? {}), root.claudeConfigDirOverrideFor(h));
    expect(launch.argv.slice(0, 3)).toEqual(["/usr/bin/env", "-u", "CLAUDE_CONFIG_DIR"]);
    expect(launch.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(launch.env.HOME).toBe("/eh");
  });

  test("the fake driver writes its transcript where that spawn would, never into the built-in root", () => {
    expect(fakeTranscriptDirFor({ home: null, env: { HOME: "/eh" } })).toBe("/eh/.claude");
    expect(fakeTranscriptDirFor({ home: "/h", env: {} })).toBe("/h");
    expect(fakeTranscriptDirFor({ home: null, env: {} })).toBeNull();
    process.env.CLAUDE_CONFIG_DIR = "/proc-dir";
    expect(fakeTranscriptDirFor({ home: null, env: {} })).toBeNull();
  });
});

describe("shared precedence (CR6)", () => {
  test("joinRootPath matches path.posix.join", () => {
    const bases = ["/a", "/a/", "/a//b", "/a/./b", "/a/b/..", "a", "a/../..", "./x", "/", "//x", "/a/b/../../.."];
    const segments = [".claude", ".codex", "./x", "../y", "z/"];
    for (const base of bases) {
      for (const segment of segments) {
        expect(shared.joinRootPath(base, segment), `${base} + ${segment}`).toBe(path.posix.join(base, segment));
      }
    }
  });

  test("resolvers take the process values as parameters", () => {
    const proc = { homeDir: "/real", claudeConfigDir: null, codexHome: null };
    expect(shared.resolveClaudeRoot({ home: null, env: { HOME: "/eh" } }, proc)).toMatchObject({
      source: "env-home", pin: null, configDirEnv: null, configDir: "/eh/.claude", claudeJsonDir: "/eh",
    });
    expect(shared.resolveClaudeRoot({ home: null }, { ...proc, claudeConfigDir: "/p" })).toMatchObject({
      source: "process", pin: null, configDirEnv: "/p", configDir: "/p", claudeJsonDir: "/p",
    });
    expect(shared.resolveClaudeRoot({ home: null }, proc).configDir).toBe("/real/.claude");
    expect(shared.resolveCodexRoot({ home: null, env: { HOME: "/eh" } }, proc)).toEqual({
      source: "env-home", pin: null, codexHome: "/eh/.codex",
    });
    expect(shared.resolveCodexRoot({ home: "/h" }, { ...proc, codexHome: "/p" })).toEqual({
      source: "home", pin: "/h/.codex", codexHome: "/h/.codex",
    });
    expect(shared.resolveCodexRoot({ home: null }, proc).codexHome).toBe("/real/.codex");
  });
});

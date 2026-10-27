import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Harness } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// End-to-end proof that the spawn wrapper really routes core spawns through
// the disclaim helper (docs/plans/master-token-agent-read.md, G1/D21/TT9).
// `AGETOR_DISCLAIM_BIN` points at a recording stub: it appends its argv to a
// log and then `exec "$@"`s, which is exactly what the real helper does
// (native/disclaim/disclaim.c) minus the TCC bit. So a spawn "went through the
// helper" iff its command shows up in the stub's log, and a planted program
// (git's `core.fsmonitor`) is a grandchild of that disclaimed process.
//
// darwin only: elsewhere `disclaimEnabled()` is false by design.

process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-disclaim-int-db-"));
const testDataDir = process.env.AGETOR_DATA_DIR;

const onDarwin = process.platform === "darwin";
const suite = onDarwin ? describe : describe.skip;

let setDisclaimSwitch: (on: boolean) => void;
let getDisclaimSwitch: () => boolean;
let hasUncommittedChanges: (dir: string) => Promise<boolean | null>;
let checkHarness: (h: Harness) => Promise<{ available: boolean; version: string | null }>;
let agentStatusTesting: { clearStatusCache: () => void };
let spawnTmuxNewSession: (tmux: string, args: string[]) => Promise<{ status: number | null; stderr: string }>;
let resetTmuxServerEnvCleared: () => void;

beforeAll(async () => {
  ({ setDisclaimSwitch, getDisclaimSwitch } = await import("./disclaim.ts"));
  ({ hasUncommittedChanges } = await import("./worktree.ts"));
  const status = await import("./agent-status.ts");
  checkHarness = status.checkHarness;
  agentStatusTesting = status.__testing;
  const tmuxRes = await import("./tmux-resolution.ts");
  spawnTmuxNewSession = tmuxRes.spawnTmuxNewSession;
  resetTmuxServerEnvCleared = tmuxRes.__resetTmuxServerEnvClearedForTest;
});

afterAll(() => {
  rmTestDataDir(testDataDir);
});

// `bun test` runs every file in one process: save and restore everything this
// file changes, per test.
const ENV_KEYS = [
  "AGETOR_DISCLAIM_BIN",
  "AGETOR_TMUX_BIN",
  "AGETOR_CODEX_BIN",
  "AGETOR_API_TOKEN",
  "AGETOR_TMUX_SOCKET",
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let savedSwitch = true;
let scratch: string;
let disclaimLog: string;

/** Write an executable sh script. */
function script(name: string, body: string): string {
  const file = path.join(scratch, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function recordingDisclaim(): string {
  return script("disclaim-stub", `printf '%s\\n' "$*" >> '${disclaimLog}'\nexec "$@"`);
}

function logLines(): string[] {
  return existsSync(disclaimLog) ? readFileSync(disclaimLog, "utf8").split("\n").filter(Boolean) : [];
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  savedSwitch = getDisclaimSwitch?.() ?? true;
  scratch = mkdtempSync(path.join(tmpdir(), "agetor-disclaim-int-"));
  disclaimLog = path.join(scratch, "disclaim.log");
  process.env.AGETOR_DISCLAIM_BIN = recordingDisclaim();
  setDisclaimSwitch(true);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setDisclaimSwitch(savedSwitch);
});

function git(cwd: string, ...args: string[]): void {
  const res = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
}

suite("core spawns run through the disclaim helper", () => {
  test("G1: a repo-planted core.fsmonitor program runs as a child of the disclaimed git", async () => {
    const repo = path.join(scratch, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    const marker = path.join(scratch, "fsmonitor-ran");
    // The hook records whether it can see the master token. The core scrubs it
    // from every child, so it must read as unset even though the parent has it.
    const hook = script(
      "fsmonitor-hook",
      `printf 'token=%s\\n' "\${AGETOR_API_TOKEN-unset}" >> '${marker}'\nexit 0`,
    );
    git(repo, "config", "core.fsmonitor", hook);

    process.env.AGETOR_API_TOKEN = "master-token-for-test";
    const result = await hasUncommittedChanges(repo);
    expect(result).not.toBeNull();

    const lines = logLines();
    // Both the repo probe and the status call went through the helper.
    expect(lines.some((l) => /\bgit\b.*\brev-parse\b/.test(l))).toBe(true);
    expect(lines.some((l) => /\bgit\b.*\bstatus --porcelain\b/.test(l))).toBe(true);
    // The planted program ran (git runs it during `status`)...
    expect(existsSync(marker)).toBe(true);
    // ...without the master token.
    expect(readFileSync(marker, "utf8")).toContain("token=unset");
  });

  test("a harness probe runs through the helper", async () => {
    const stubBin = script("fake-codex", `echo "codex-cli 9.9.9"`);
    process.env.AGETOR_CODEX_BIN = stubBin;
    agentStatusTesting.clearStatusCache();
    const harness: Harness = {
      id: "codex",
      kind: "codex",
      label: "codex",
      isBuiltin: true,
      home: null,
      bin: null,
      env: {},
      enabled: true,
    };
    const status = await checkHarness(harness);
    expect(status.available).toBe(true);
    expect(status.version).toContain("9.9.9");
    expect(logLines().some((l) => l.includes(stubBin) && l.includes("--version"))).toBe(true);
  });

  test("a tmux client call runs through the helper without the master token", async () => {
    const envLog = path.join(scratch, "tmux-env.log");
    const tmuxStub = script(
      "fake-tmux",
      `printf 'argv=%s token=%s\\n' "$*" "\${AGETOR_API_TOKEN-unset}" >> '${envLog}'\nexit 0`,
    );
    process.env.AGETOR_TMUX_BIN = tmuxStub;
    process.env.AGETOR_TMUX_SOCKET = "agetor-disclaim-int";
    process.env.AGETOR_API_TOKEN = "master-token-for-test";
    resetTmuxServerEnvCleared();

    const res = await spawnTmuxNewSession(tmuxStub, ["new-session", "-d", "-s", "probe"]);
    expect(res.status).toBe(0);

    // The client call itself (D22) and the server start both went via the helper.
    const lines = logLines().filter((l) => l.includes(tmuxStub));
    expect(lines.some((l) => l.includes("new-session -d -s probe"))).toBe(true);
    expect(lines.some((l) => l.includes("start-server"))).toBe(true);
    // The helper is invoked with the target already resolved to an absolute path.
    expect(lines.every((l) => l.startsWith(`${tmuxStub} `))).toBe(true);

    // No tmux client saw the token, and the stale-server cleanup ran once.
    const envRecords = readFileSync(envLog, "utf8").split("\n").filter(Boolean);
    expect(envRecords.length).toBeGreaterThanOrEqual(3);
    expect(envRecords.every((r) => r.endsWith("token=unset"))).toBe(true);
    expect(envRecords.some((r) => r.includes("set-environment -g -u AGETOR_API_TOKEN"))).toBe(true);
  });

  test("with the switch off nothing goes through the helper", async () => {
    setDisclaimSwitch(false);
    const repo = path.join(scratch, "repo-off");
    mkdirSync(repo);
    git(repo, "init", "-q");
    const result = await hasUncommittedChanges(repo);
    expect(result).not.toBeNull();
    expect(logLines()).toEqual([]);
  });
});

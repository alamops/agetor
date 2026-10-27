import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

// Top-level: db.ts (imported transitively by tmux-resolution.ts) captures
// AGETOR_DATA_DIR at first import — the convention every db-importing test
// follows. A `beforeAll` would race with whichever
// test file's import wins the module-cache race in `bun test`'s single
// process, so this must be a genuine dynamic `import()` deferred until
// after the env var below is set, not a static import.
const testDataDir = mkdtempSync(path.join(tmpdir(), "agetor-tmux-resolution-"));
process.env.AGETOR_DATA_DIR = testDataDir;

let deriveTmuxSocketName: (dataDirPath: string) => string;
let tmuxSocketName: () => string | null;
let tmuxSocketArgs: () => string[];
let buildEnsureServerArgv: (tmuxBin: string) => string[];
let ensureDisclaimedServer: () => Promise<void>;
let resetTmuxServerEnvCleared: () => void;
let setDisclaimSwitch: (on: boolean) => void;
let dataDir: string;

beforeAll(async () => {
  ({
    deriveTmuxSocketName,
    tmuxSocketName,
    tmuxSocketArgs,
    buildEnsureServerArgv,
    ensureDisclaimedServer,
    __resetTmuxServerEnvClearedForTest: resetTmuxServerEnvCleared,
  } = await import("./tmux-resolution.ts"));
  ({ setDisclaimSwitch } = await import("./disclaim.ts"));
  ({ dataDir } = await import("./db.ts"));
});

afterAll(() => {
  rmTestDataDir(testDataDir);
});

// CRITICAL env hygiene (known repo gotcha, see CLAUDE.md's env-leak
// incidents): save every env var / preference this file touches and
// restore it after each case so nothing leaks into another test file.
const ORIGINAL = {
  AGETOR_TMUX_SOCKET: process.env.AGETOR_TMUX_SOCKET,
  AGETOR_TMUX_BIN: process.env.AGETOR_TMUX_BIN,
  AGETOR_DISCLAIM_BIN: process.env.AGETOR_DISCLAIM_BIN,
  NODE_ENV: process.env.NODE_ENV,
};

function restoreEnv(key: keyof typeof ORIGINAL): void {
  const value = ORIGINAL[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  (Object.keys(ORIGINAL) as (keyof typeof ORIGINAL)[]).forEach(restoreEnv);
});

afterEach(() => {
  (Object.keys(ORIGINAL) as (keyof typeof ORIGINAL)[]).forEach(restoreEnv);
  setDisclaimSwitch(true);
});

// --- deriveTmuxSocketName --------------------------------------------------

test('deriveTmuxSocketName: "~/.agetor" -> "agetor"', () => {
  expect(deriveTmuxSocketName("/Users/x/.agetor")).toBe("agetor");
});

test('deriveTmuxSocketName: "~/.agetor-dev" -> "agetor-dev"', () => {
  expect(deriveTmuxSocketName("/Users/x/.agetor-dev")).toBe("agetor-dev");
});

test("deriveTmuxSocketName: sanitizes characters outside [A-Za-z0-9_-]", () => {
  expect(deriveTmuxSocketName("/Users/x/.age tor!@#")).toBe("age-tor---");
});

test("deriveTmuxSocketName: strips a leading dash so tmux can't read the socket as an option", () => {
  expect(deriveTmuxSocketName("/Users/x/-weird")).toBe("weird");
  expect(deriveTmuxSocketName("/Users/x/.-y")).toBe("y");
  expect(deriveTmuxSocketName("/Users/x/---")).toBe("agetor");
});

test('deriveTmuxSocketName: empty-basename edge falls back to "agetor"', () => {
  expect(deriveTmuxSocketName("/Users/x/...")).toBe("agetor");
  expect(deriveTmuxSocketName("")).toBe("agetor");
});

// --- buildEnsureServerArgv --------------------------------------------------

// The disclaim wrapping moved into coreSpawn (core-spawn.ts, the only caller of
// disclaimArgv): the argv built here must stay the plain tmux command, or the
// helper would be exec'd twice (P3).
test("buildEnsureServerArgv: the plain tmux command, never pre-wrapped with the disclaim helper", () => {
  process.env.AGETOR_DISCLAIM_BIN = "/bin/echo";
  setDisclaimSwitch(true);
  process.env.AGETOR_TMUX_SOCKET = "foo";
  expect(buildEnsureServerArgv("/path/to/tmux")).toEqual(["/path/to/tmux", "-L", "foo", "start-server"]);
  setDisclaimSwitch(false);
  expect(buildEnsureServerArgv("/path/to/tmux")).toEqual(["/path/to/tmux", "-L", "foo", "start-server"]);
});

// --- ensureDisclaimedServer --------------------------------------------------

test("ensureDisclaimedServer: resolves without throwing", async () => {
  process.env.AGETOR_TMUX_BIN = "/bin/echo";
  process.env.AGETOR_DISCLAIM_BIN = "/bin/echo";
  await expect(ensureDisclaimedServer()).resolves.toBeUndefined();
});

test("ensureDisclaimedServer: never throws when tmux is not installed", async () => {
  process.env.AGETOR_TMUX_BIN = "definitely-not-tmux-xyz123";
  await expect(ensureDisclaimedServer()).resolves.toBeUndefined();
});

test.skipIf(process.platform !== "darwin")(
  "ensureDisclaimedServer: start-server goes through the helper, then clears a stale AGETOR_API_TOKEN from the server env exactly once per process",
  async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "agetor-tmux-resolution-stub-"));
    const log = path.join(scratch, "calls.log");
    const disclaimStub = path.join(scratch, "disclaim");
    const tmuxStub = path.join(scratch, "tmux");
    // The disclaim stub records what it is asked to run, then execs it (like the
    // real helper). The tmux stub records its own env view of the token.
    writeFileSync(disclaimStub, `#!/bin/sh\nprintf 'disclaim %s\\n' "$*" >> '${log}'\nexec "$@"\n`);
    writeFileSync(tmuxStub, `#!/bin/sh\nprintf 'tmux token=%s %s\\n' "\${AGETOR_API_TOKEN-unset}" "$*" >> '${log}'\nexit 0\n`);
    chmodSync(disclaimStub, 0o755);
    chmodSync(tmuxStub, 0o755);
    process.env.AGETOR_DISCLAIM_BIN = disclaimStub;
    process.env.AGETOR_TMUX_BIN = tmuxStub;
    process.env.AGETOR_TMUX_SOCKET = "agetor-tmux-res-test";
    const savedToken = process.env.AGETOR_API_TOKEN;
    process.env.AGETOR_API_TOKEN = "master-token-for-test";
    setDisclaimSwitch(true);
    resetTmuxServerEnvCleared();
    try {
      await ensureDisclaimedServer();
      await ensureDisclaimedServer();
      const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
      const starts = lines.filter((l) => l.startsWith("disclaim ") && l.includes("start-server"));
      const clears = lines.filter((l) => l.startsWith("disclaim ") && l.includes("set-environment -g -u AGETOR_API_TOKEN"));
      expect(starts).toHaveLength(2); // start-server is idempotent, repeated each call
      expect(starts[0]).toBe(`disclaim ${tmuxStub} -L agetor-tmux-res-test start-server`);
      expect(clears).toHaveLength(1); // the stale-env cleanup is once per process
      expect(lines.some((l) => l.startsWith("tmux ") && l.includes("set-environment -g -u AGETOR_API_TOKEN"))).toBe(true);
      // No tmux client saw the master token.
      expect(lines.filter((l) => l.startsWith("tmux ")).every((l) => l.startsWith("tmux token=unset "))).toBe(true);
    } finally {
      if (savedToken === undefined) delete process.env.AGETOR_API_TOKEN;
      else process.env.AGETOR_API_TOKEN = savedToken;
      resetTmuxServerEnvCleared();
    }
  },
);

// --- tmuxSocketName ----------------------------------------------------------

test('tmuxSocketName: AGETOR_TMUX_SOCKET="foo" -> "foo"', () => {
  process.env.AGETOR_TMUX_SOCKET = "foo";
  expect(tmuxSocketName()).toBe("foo");
});

test('tmuxSocketName: AGETOR_TMUX_SOCKET="default" -> null', () => {
  process.env.AGETOR_TMUX_SOCKET = "default";
  expect(tmuxSocketName()).toBeNull();
});

test('tmuxSocketName: NODE_ENV="test" with no override -> "agetor-test"', () => {
  delete process.env.AGETOR_TMUX_SOCKET;
  process.env.NODE_ENV = "test";
  expect(tmuxSocketName()).toBe("agetor-test");
});

test("tmuxSocketName: production branch derives from dataDir when NODE_ENV is unset", () => {
  delete process.env.AGETOR_TMUX_SOCKET;
  const savedNodeEnv = process.env.NODE_ENV;
  try {
    delete process.env.NODE_ENV;
    expect(tmuxSocketName()).toBe(deriveTmuxSocketName(dataDir));
  } finally {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  }
});

test("tmuxSocketArgs: mirrors tmuxSocketName() as -L flags, or [] for the default socket", () => {
  process.env.AGETOR_TMUX_SOCKET = "foo";
  expect(tmuxSocketArgs()).toEqual(["-L", "foo"]);
  process.env.AGETOR_TMUX_SOCKET = "default";
  expect(tmuxSocketArgs()).toEqual([]);
});

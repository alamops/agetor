import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

// Top-level: db.ts (imported transitively by both tmux-resolution.ts and
// disclaim.ts) captures AGETOR_DATA_DIR at first import — see the same
// convention in disclaim.test.ts. A `beforeAll` would race with whichever
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
let DISCLAIM_PREF_KEY: string;
let preferences: typeof import("./db.ts").preferences;
let dataDir: string;

beforeAll(async () => {
  ({
    deriveTmuxSocketName,
    tmuxSocketName,
    tmuxSocketArgs,
    buildEnsureServerArgv,
    ensureDisclaimedServer,
  } = await import("./tmux-resolution.ts"));
  ({ DISCLAIM_PREF_KEY } = await import("./disclaim.ts"));
  ({ preferences, dataDir } = await import("./db.ts"));
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
  preferences.set(DISCLAIM_PREF_KEY, "true");
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

test.skipIf(process.platform !== "darwin")(
  "buildEnsureServerArgv: prepends AGETOR_DISCLAIM_BIN when enabled",
  () => {
    process.env.AGETOR_DISCLAIM_BIN = "/bin/echo";
    preferences.set(DISCLAIM_PREF_KEY, "true");
    const argv = buildEnsureServerArgv("/path/to/tmux");
    expect(argv[0]).toBe("/bin/echo");
    expect(argv).toContain("/path/to/tmux");
    expect(argv).toContain("start-server");
  },
);

test.skipIf(process.platform !== "darwin")(
  'buildEnsureServerArgv: passthrough when the pref is the literal string "false"',
  () => {
    process.env.AGETOR_DISCLAIM_BIN = "/bin/echo";
    preferences.set(DISCLAIM_PREF_KEY, "false");
    const argv = buildEnsureServerArgv("/path/to/tmux");
    expect(argv[0]).toBe("/path/to/tmux");
    expect(argv).toContain("start-server");
  },
);

// --- ensureDisclaimedServer --------------------------------------------------

test("ensureDisclaimedServer: resolves without throwing", async () => {
  process.env.AGETOR_TMUX_BIN = "/bin/echo";
  process.env.AGETOR_DISCLAIM_BIN = "/bin/echo";
  await expect(ensureDisclaimedServer()).resolves.toBeUndefined();
});

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

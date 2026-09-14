import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import — see the same
// convention repeated across every sibling *.test.ts that imports db.ts
// (task-unread.test.ts, db-sent-files.test.ts, …). A `beforeAll` would race
// with whichever test file's import wins the module-cache race in
// `bun test`'s single process — disclaim.ts imports db.ts (for the
// `preferences` store), so this file needs the same guard.
const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-disclaim-"));
process.env.AGETOR_DATA_DIR = dataDir;

let DISCLAIM_PREF_KEY: string;
let bundledDisclaimPath: () => string;
let resolveDisclaimBin: () => string;
let disclaimAvailable: () => boolean;
let computeDisclaimEnabled: (opts: {
  platform: NodeJS.Platform;
  prefDisabled: boolean;
  available: boolean;
}) => boolean;
let disclaimEnabled: () => boolean;
let disclaimArgv: (argv: string[]) => string[];
let preferences: typeof import("./db.ts").preferences;

beforeAll(async () => {
  ({
    DISCLAIM_PREF_KEY,
    bundledDisclaimPath,
    resolveDisclaimBin,
    disclaimAvailable,
    computeDisclaimEnabled,
    disclaimEnabled,
    disclaimArgv,
  } = await import("./disclaim.ts"));
  ({ preferences } = await import("./db.ts"));
});

afterAll(() => {
  rmTestDataDir(dataDir);
});

const ORIGINAL_DISCLAIM_BIN = process.env.AGETOR_DISCLAIM_BIN;

// Ambient state (the env override + the preference row) must never leak
// between cases — restore both after every test.
afterEach(() => {
  if (ORIGINAL_DISCLAIM_BIN === undefined) delete process.env.AGETOR_DISCLAIM_BIN;
  else process.env.AGETOR_DISCLAIM_BIN = ORIGINAL_DISCLAIM_BIN;
  // Any value other than the literal "false" reads as "enabled" (the
  // default) — this resets the pref to that default state rather than
  // leaving whatever a prior case wrote.
  preferences.set(DISCLAIM_PREF_KEY, "true");
});

test("computeDisclaimEnabled: darwin + enabled + available -> true", () => {
  expect(
    computeDisclaimEnabled({ platform: "darwin", prefDisabled: false, available: true }),
  ).toBe(true);
});

test("computeDisclaimEnabled: non-darwin -> false regardless of other flags", () => {
  expect(
    computeDisclaimEnabled({ platform: "linux", prefDisabled: false, available: true }),
  ).toBe(false);
  expect(
    computeDisclaimEnabled({ platform: "win32", prefDisabled: false, available: true }),
  ).toBe(false);
});

test("computeDisclaimEnabled: prefDisabled -> false", () => {
  expect(
    computeDisclaimEnabled({ platform: "darwin", prefDisabled: true, available: true }),
  ).toBe(false);
});

test("computeDisclaimEnabled: unavailable -> false", () => {
  expect(
    computeDisclaimEnabled({ platform: "darwin", prefDisabled: false, available: false }),
  ).toBe(false);
});

test("resolveDisclaimBin: honors AGETOR_DISCLAIM_BIN env override", () => {
  process.env.AGETOR_DISCLAIM_BIN = "/custom/path/to/disclaim";
  expect(resolveDisclaimBin()).toBe("/custom/path/to/disclaim");
});

test("resolveDisclaimBin: falls back to bundledDisclaimPath() when the env override is unset", () => {
  delete process.env.AGETOR_DISCLAIM_BIN;
  expect(resolveDisclaimBin()).toBe(bundledDisclaimPath());
});

test("disclaimAvailable: true when AGETOR_DISCLAIM_BIN points at a file that exists", () => {
  process.env.AGETOR_DISCLAIM_BIN = process.execPath; // any real file on disk
  expect(disclaimAvailable()).toBe(true);
});

test("disclaimAvailable: false when AGETOR_DISCLAIM_BIN points at a missing file", () => {
  process.env.AGETOR_DISCLAIM_BIN = "/definitely/does/not/exist/disclaim";
  expect(disclaimAvailable()).toBe(false);
});

// These two exercise the real disclaimEnabled()/disclaimArgv() gating end to
// end, so they need to actually run on darwin (the only platform Agetor
// ships on — see CLAUDE.md); skip rather than fail on any other host.
test.skipIf(process.platform !== "darwin")(
  "disclaimArgv: prepends AGETOR_DISCLAIM_BIN when enabled",
  () => {
    process.env.AGETOR_DISCLAIM_BIN = "/bin/echo";
    preferences.set(DISCLAIM_PREF_KEY, "true");
    expect(disclaimEnabled()).toBe(true);
    expect(disclaimArgv(["some-cmd", "--flag"])).toEqual(["/bin/echo", "some-cmd", "--flag"]);
  },
);

test.skipIf(process.platform !== "darwin")(
  'disclaimArgv: passthrough (unchanged) when the pref is the literal string "false"',
  () => {
    process.env.AGETOR_DISCLAIM_BIN = "/bin/echo";
    preferences.set(DISCLAIM_PREF_KEY, "false");
    expect(disclaimEnabled()).toBe(false);
    expect(disclaimArgv(["some-cmd", "--flag"])).toEqual(["some-cmd", "--flag"]);
  },
);

// Smoke test for the actual compiled helper — only runs once `bun run
// vendor:disclaim` has produced vendor/disclaim/disclaim; never fails just
// because the binary hasn't been built yet in this checkout.
const COMPILED_HELPER = path.join(process.cwd(), "vendor", "disclaim", "disclaim");

test.skipIf(!existsSync(COMPILED_HELPER))(
  "compiled disclaim helper execs the target command",
  async () => {
    const proc = Bun.spawn([COMPILED_HELPER, "/bin/echo", "hi"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(out).toBe("hi\n");
    expect(code).toBe(0);
  },
);

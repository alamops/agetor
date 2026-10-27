import { test, expect, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  DISCLAIM_PREF_KEY,
  bundledDisclaimPath,
  resolveDisclaimBin,
  disclaimAvailable,
  computeDisclaimEnabled,
  disclaimEnabled,
  disclaimArgv,
  isDisclaimOffValue,
  getDisclaimSwitch,
  setDisclaimSwitch,
} from "./disclaim.ts";

// disclaim.ts no longer touches db.ts (P4: the switch is in memory), so this
// file needs no AGETOR_DATA_DIR. Ambient state (the env override + the
// in-memory switch) must never leak between cases — bun runs every test file
// in one process — so both are restored after every test.
const ORIGINAL_DISCLAIM_BIN = process.env.AGETOR_DISCLAIM_BIN;
const ORIGINAL_SWITCH = getDisclaimSwitch();

afterEach(() => {
  if (ORIGINAL_DISCLAIM_BIN === undefined) delete process.env.AGETOR_DISCLAIM_BIN;
  else process.env.AGETOR_DISCLAIM_BIN = ORIGINAL_DISCLAIM_BIN;
  setDisclaimSwitch(ORIGINAL_SWITCH);
});

test("DISCLAIM_PREF_KEY keeps its stored name", () => {
  expect(DISCLAIM_PREF_KEY).toBe("disclaimSpawnedAgents");
});

test('isDisclaimOffValue: only the literal "false" means off', () => {
  expect(isDisclaimOffValue("false")).toBe(true);
  for (const v of ["true", "", "False", "0", "off", " false", null, undefined]) {
    expect(isDisclaimOffValue(v)).toBe(false);
  }
});

test("the in-memory switch defaults on and round-trips", () => {
  // The module-level default (before any test touched it) is ON.
  expect(ORIGINAL_SWITCH).toBe(true);
  setDisclaimSwitch(false);
  expect(getDisclaimSwitch()).toBe(false);
  setDisclaimSwitch(true);
  expect(getDisclaimSwitch()).toBe(true);
});

test("disclaim.ts does not import db.ts (P4)", async () => {
  const src = await Bun.file(path.join(import.meta.dir, "disclaim.ts")).text();
  expect(src).not.toMatch(/from\s+["']\.\/db(\.ts)?["']/);
});

test("computeDisclaimEnabled: darwin + enabled + available -> true", () => {
  expect(
    computeDisclaimEnabled({ platform: "darwin", switchOn: true, available: true }),
  ).toBe(true);
});

test("computeDisclaimEnabled: non-darwin -> false regardless of other flags", () => {
  expect(
    computeDisclaimEnabled({ platform: "linux", switchOn: true, available: true }),
  ).toBe(false);
  expect(
    computeDisclaimEnabled({ platform: "win32", switchOn: true, available: true }),
  ).toBe(false);
});

test("computeDisclaimEnabled: switch off -> false", () => {
  expect(
    computeDisclaimEnabled({ platform: "darwin", switchOn: false, available: true }),
  ).toBe(false);
});

test("computeDisclaimEnabled: unavailable -> false", () => {
  expect(
    computeDisclaimEnabled({ platform: "darwin", switchOn: true, available: false }),
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
    setDisclaimSwitch(true);
    expect(disclaimEnabled()).toBe(true);
    expect(disclaimArgv(["some-cmd", "--flag"])).toEqual(["/bin/echo", "some-cmd", "--flag"]);
  },
);

test.skipIf(process.platform !== "darwin")(
  "disclaimArgv: passthrough (unchanged) when the switch is off",
  () => {
    process.env.AGETOR_DISCLAIM_BIN = "/bin/echo";
    setDisclaimSwitch(false);
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

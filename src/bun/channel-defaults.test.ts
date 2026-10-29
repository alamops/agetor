import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyChannelDefaults, readBundleChannel } from "./channel-defaults.ts";
import { DEV_API_PORT } from "./dev-defaults.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const HOME = "/Users/someone";
const root = mkdtempSync(path.join(tmpdir(), "agetor-channel-"));
afterAll(() => {
  rmTestDataDir(root);
});

describe("applyChannelDefaults", () => {
  for (const channel of ["canary", "dev"]) {
    test(`${channel} defaults to the dev data dir and port and reports the keys it set`, () => {
      const env: NodeJS.ProcessEnv = {};
      const set = applyChannelDefaults(env, channel, HOME);
      expect(set.sort()).toEqual(["AGETOR_API_PORT", "AGETOR_DATA_DIR"]);
      expect(env.AGETOR_DATA_DIR).toBe(path.join(HOME, ".agetor-dev"));
      expect(env.AGETOR_API_PORT).toBe(String(DEV_API_PORT));
    });
  }

  test("stable, an unknown channel and null set nothing", () => {
    for (const channel of ["stable", "beta", "", "CANARY", null]) {
      const env: NodeJS.ProcessEnv = {};
      expect(applyChannelDefaults(env, channel, HOME)).toEqual([]);
      expect(env).toEqual({});
    }
  });

  test("never overrides a value that is already set, key by key", () => {
    const both: NodeJS.ProcessEnv = { AGETOR_DATA_DIR: "/custom", AGETOR_API_PORT: "9999" };
    expect(applyChannelDefaults(both, "canary", HOME)).toEqual([]);
    expect(both).toEqual({ AGETOR_DATA_DIR: "/custom", AGETOR_API_PORT: "9999" });

    const dirOnly: NodeJS.ProcessEnv = { AGETOR_DATA_DIR: "/custom" };
    expect(applyChannelDefaults(dirOnly, "dev", HOME)).toEqual(["AGETOR_API_PORT"]);
    expect(dirOnly.AGETOR_DATA_DIR).toBe("/custom");
    expect(dirOnly.AGETOR_API_PORT).toBe(String(DEV_API_PORT));

    const portOnly: NodeJS.ProcessEnv = { AGETOR_API_PORT: "9999" };
    expect(applyChannelDefaults(portOnly, "dev", HOME)).toEqual(["AGETOR_DATA_DIR"]);
    expect(portOnly.AGETOR_API_PORT).toBe("9999");
    expect(portOnly.AGETOR_DATA_DIR).toBe(path.join(HOME, ".agetor-dev"));
  });

  test("an empty-string value counts as set", () => {
    const env: NodeJS.ProcessEnv = { AGETOR_DATA_DIR: "" };
    expect(applyChannelDefaults(env, "canary", HOME)).toEqual(["AGETOR_API_PORT"]);
    expect(env.AGETOR_DATA_DIR).toBe("");
  });

  test("is idempotent", () => {
    const env: NodeJS.ProcessEnv = {};
    applyChannelDefaults(env, "canary", HOME);
    expect(applyChannelDefaults(env, "canary", HOME)).toEqual([]);
  });
});

describe("readBundleChannel", () => {
  /** <root>/<name>/Contents/MacOS/bun with an optional Resources/version.json. */
  function fakeBundle(name: string, versionJson: string | null): string {
    const contents = path.join(root, name, "Contents");
    mkdirSync(path.join(contents, "MacOS"), { recursive: true });
    mkdirSync(path.join(contents, "Resources"), { recursive: true });
    if (versionJson !== null) writeFileSync(path.join(contents, "Resources", "version.json"), versionJson);
    return path.join(contents, "MacOS", "bun");
  }

  test("reads the channel next to the bundled bun", () => {
    expect(readBundleChannel(fakeBundle("a", JSON.stringify({ version: "1.0.0", channel: "canary" })))).toBe("canary");
    expect(readBundleChannel(fakeBundle("b", JSON.stringify({ channel: "stable" })))).toBe("stable");
  });

  test("null when version.json is absent (every source run)", () => {
    expect(readBundleChannel(fakeBundle("c", null))).toBeNull();
    expect(readBundleChannel(path.join(root, "nowhere", "Contents", "MacOS", "bun"))).toBeNull();
  });

  test("null when it is unparsable or carries no string channel", () => {
    expect(readBundleChannel(fakeBundle("d", "{not json"))).toBeNull();
    expect(readBundleChannel(fakeBundle("e", JSON.stringify({ version: "1.0.0" })))).toBeNull();
    expect(readBundleChannel(fakeBundle("f", JSON.stringify({ channel: 3 })))).toBeNull();
    expect(readBundleChannel(fakeBundle("g", "null"))).toBeNull();
  });

  test("end to end: a canary bundle layout yields the dev defaults", () => {
    const channel = readBundleChannel(fakeBundle("h", JSON.stringify({ channel: "canary" })));
    const env: NodeJS.ProcessEnv = {};
    applyChannelDefaults(env, channel, HOME);
    expect(env.AGETOR_API_PORT).toBe(String(DEV_API_PORT));
  });

  test("a source-run bun reads null, so importing the module changes nothing here", () => {
    expect(readBundleChannel()).toBeNull();
  });
});

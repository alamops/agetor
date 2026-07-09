import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { resolveNotifier, buildNotifierArgs } from "./notifier.ts";

describe("buildNotifierArgs", () => {
  test("title only → --title + always-present empty --message", () => {
    expect(buildNotifierArgs({ title: "T" })).toEqual(["--title", "T", "--message", ""]);
  });

  test("body populates --message", () => {
    expect(buildNotifierArgs({ title: "T", body: "B" })).toEqual([
      "--title", "T", "--message", "B",
    ]);
  });

  test("subtitle appears only when provided", () => {
    expect(buildNotifierArgs({ title: "T", subtitle: "S" })).toEqual([
      "--title", "T", "--message", "", "--subtitle", "S",
    ]);
  });

  test("url appears only when provided", () => {
    expect(buildNotifierArgs({ title: "T", url: "agetor://task/abc" })).toEqual([
      "--title", "T", "--message", "", "--url", "agetor://task/abc",
    ]);
  });

  test("silent:true adds --silent", () => {
    expect(buildNotifierArgs({ title: "T", silent: true })).toEqual([
      "--title", "T", "--message", "", "--silent",
    ]);
  });

  test("silent:false does NOT add --silent (sound plays)", () => {
    expect(buildNotifierArgs({ title: "T", silent: false })).toEqual([
      "--title", "T", "--message", "",
    ]);
  });

  test("silent:undefined does NOT add --silent", () => {
    expect(buildNotifierArgs({ title: "T", silent: undefined })).toEqual([
      "--title", "T", "--message", "",
    ]);
  });

  test("full combo keeps fixed order: title, message, subtitle, url, silent", () => {
    expect(
      buildNotifierArgs({
        title: "T",
        body: "B",
        subtitle: "S",
        url: "agetor://task/abc",
        silent: true,
      }),
    ).toEqual([
      "--title", "T",
      "--message", "B",
      "--subtitle", "S",
      "--url", "agetor://task/abc",
      "--silent",
    ]);
  });
});

describe("resolveNotifier", () => {
  const ENV_VAR = "AGETOR_NOTIFIER_BIN";
  let original: string | undefined;

  // Snapshot/restore only inside before/afterEach — mutating process.env at a
  // bun-test file's top level leaks into sibling test files.
  beforeEach(() => {
    original = process.env[ENV_VAR];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = original;
  });

  test("returns the env override verbatim (not existence-checked)", () => {
    process.env[ENV_VAR] = "/custom/path/to/notifier";
    expect(resolveNotifier()).toBe("/custom/path/to/notifier");
  });

  test("override wins over any bundled/dev resolution", () => {
    process.env[ENV_VAR] = "/override/wins";
    expect(resolveNotifier()).toBe("/override/wins");
  });

  test("without an override, resolves to the helper exe path or null", () => {
    delete process.env[ENV_VAR];
    const r = resolveNotifier();
    // Environment-dependent (the bundled path only exists in the packaged
    // .app; the dev path only after `bun run vendor:notifier`), so assert the
    // shape: either null or the AgetorNotifier.app inner executable.
    expect(
      r === null || r.endsWith("AgetorNotifier.app/Contents/MacOS/notifier"),
    ).toBe(true);
  });
});

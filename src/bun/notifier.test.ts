import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveNotifier, buildNotifierArgs } from "./notifier.ts";

describe("buildNotifierArgs", () => {
  test("title only: message present but empty, no optional flags", () => {
    expect(buildNotifierArgs({ title: "T" })).toEqual(["-title", "T", "-message", ""]);
  });

  test("title + body: message carries the body", () => {
    expect(buildNotifierArgs({ title: "T", body: "B" })).toEqual([
      "-title",
      "T",
      "-message",
      "B",
    ]);
  });

  test("subtitle only appears when given", () => {
    expect(buildNotifierArgs({ title: "T", subtitle: "S" })).toEqual([
      "-title",
      "T",
      "-message",
      "",
      "-subtitle",
      "S",
    ]);
  });

  test("open only appears when url is given", () => {
    expect(buildNotifierArgs({ title: "T", url: "agetor://task/abc" })).toEqual([
      "-title",
      "T",
      "-message",
      "",
      "-open",
      "agetor://task/abc",
    ]);
  });

  test("sender only appears when given", () => {
    expect(buildNotifierArgs({ title: "T", sender: "sh.alamops.agetor" })).toEqual([
      "-title",
      "T",
      "-message",
      "",
      "-sender",
      "sh.alamops.agetor",
    ]);
  });

  test("silent: false appends -sound default", () => {
    expect(buildNotifierArgs({ title: "T", silent: false })).toEqual([
      "-title",
      "T",
      "-message",
      "",
      "-sound",
      "default",
    ]);
  });

  test("silent: true appends no sound flag", () => {
    expect(buildNotifierArgs({ title: "T", silent: true })).toEqual(["-title", "T", "-message", ""]);
  });

  test("silent: undefined appends no sound flag", () => {
    expect(buildNotifierArgs({ title: "T" })).toEqual(["-title", "T", "-message", ""]);
  });

  test("fixed flag order: title, message, subtitle, open, sender, sound", () => {
    expect(
      buildNotifierArgs({
        title: "T",
        body: "B",
        subtitle: "S",
        url: "agetor://task/abc",
        sender: "sh.alamops.agetor",
        silent: false,
      }),
    ).toEqual([
      "-title",
      "T",
      "-message",
      "B",
      "-subtitle",
      "S",
      "-open",
      "agetor://task/abc",
      "-sender",
      "sh.alamops.agetor",
      "-sound",
      "default",
    ]);
  });
});

describe("resolveNotifier", () => {
  const ENV_VAR = "AGETOR_TERMINAL_NOTIFIER_BIN";
  let originalEnvVar: string | undefined;
  let originalPath: string | undefined;

  beforeEach(() => {
    originalEnvVar = process.env[ENV_VAR];
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    if (originalEnvVar === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = originalEnvVar;

    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  test("returns the env override verbatim when set", () => {
    process.env[ENV_VAR] = "/custom/path/to/terminal-notifier";
    expect(resolveNotifier()).toBe("/custom/path/to/terminal-notifier");
  });

  test("returns null when override is unset and PATH has no terminal-notifier", () => {
    delete process.env[ENV_VAR];
    const emptyDir = mkdtempSync(path.join(tmpdir(), "agetor-notifier-empty-path-"));
    process.env.PATH = emptyDir;
    expect(resolveNotifier()).toBeNull();
  });
});

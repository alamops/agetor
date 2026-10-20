import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  resolveNotifier,
  buildNotifierArgs,
  buildTaskNotifierPostArgs,
  buildNotifierRemoveArgs,
  buildNotifierListArgs,
  resolveInstalledAppNotifier,
} from "./notifier.ts";

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

  test("full combo with the dedupe flags appends them after the original order", () => {
    expect(
      buildNotifierArgs({
        title: "T",
        body: "B",
        subtitle: "S",
        url: "agetor://task/abc",
        silent: true,
        id: "agetor.task.abc",
        kind: "waiting",
        urgency: "needs-you",
        soundOver: ["quiet", "unknown"],
      }),
    ).toEqual([
      "--title", "T",
      "--message", "B",
      "--subtitle", "S",
      "--url", "agetor://task/abc",
      "--silent",
      "--id", "agetor.task.abc",
      "--kind", "waiting",
      "--urgency", "needs-you",
      "--sound-over", "quiet",
      "--sound-over", "unknown",
    ]);
  });

  test("an empty soundOver adds no --sound-over", () => {
    expect(buildNotifierArgs({ title: "T", id: "x", soundOver: [] })).toEqual([
      "--title", "T", "--message", "", "--id", "x",
    ]);
  });
});

describe("buildTaskNotifierPostArgs", () => {
  test("a needs-you kind sounds over quiet and unknown entries", () => {
    expect(
      buildTaskNotifierPostArgs({ title: "T", body: "B", taskId: "t1", kind: "blocked" }),
    ).toEqual([
      "--title", "T",
      "--message", "B",
      "--url", "agetor://task/t1",
      "--id", "agetor.task.t1",
      "--kind", "blocked",
      "--urgency", "needs-you",
      "--sound-over", "quiet",
      "--sound-over", "unknown",
    ]);
  });

  test("a quiet kind never sounds over a delivered entry", () => {
    expect(
      buildTaskNotifierPostArgs({ title: "T", subtitle: "S", silent: true, taskId: "t2", kind: "succeeded" }),
    ).toEqual([
      "--title", "T",
      "--message", "",
      "--subtitle", "S",
      "--url", "agetor://task/t2",
      "--silent",
      "--id", "agetor.task.t2",
      "--kind", "succeeded",
      "--urgency", "quiet",
    ]);
  });

  test("no kind stores no kind and posts as quiet", () => {
    expect(buildTaskNotifierPostArgs({ title: "T", taskId: "t3" })).toEqual([
      "--title", "T",
      "--message", "",
      "--url", "agetor://task/t3",
      "--id", "agetor.task.t3",
      "--urgency", "quiet",
    ]);
  });

  test("the task id is percent-encoded in the url but verbatim in the id", () => {
    const args = buildTaskNotifierPostArgs({ title: "T", taskId: "a/b" });
    expect(args).toContain("agetor://task/a%2Fb");
    expect(args).toContain("agetor.task.a/b");
  });
});

describe("buildNotifierRemoveArgs / buildNotifierListArgs", () => {
  test("unconditional remove targets the id and the old-style url", () => {
    expect(buildNotifierRemoveArgs({ id: "agetor.task.t1", url: "agetor://task/t1" })).toEqual([
      "--remove", "--id", "agetor.task.t1", "--url", "agetor://task/t1",
    ]);
  });

  test("conditional remove adds one --if-kind per kind", () => {
    expect(
      buildNotifierRemoveArgs({ id: "agetor.task.t1", url: "agetor://task/t1", ifKinds: ["waiting", "blocked"] }),
    ).toEqual([
      "--remove", "--id", "agetor.task.t1", "--url", "agetor://task/t1",
      "--if-kind", "waiting",
      "--if-kind", "blocked",
    ]);
  });

  test("list mode is a single flag", () => {
    expect(buildNotifierListArgs()).toEqual(["--list"]);
  });
});

describe("resolveInstalledAppNotifier", () => {
  const ENV_VAR = "AGETOR_NOTIFIER_BIN";
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV_VAR];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = original;
  });

  test("the env override wins and is returned verbatim", () => {
    process.env[ENV_VAR] = "/custom/notifier";
    expect(resolveInstalledAppNotifier()).toBe("/custom/notifier");
  });

  test("without an override, resolves to the installed app's helper or null", () => {
    delete process.env[ENV_VAR];
    const r = resolveInstalledAppNotifier();
    expect(
      r === null ||
        r === "/Applications/Agetor.app/Contents/Resources/app/bin/AgetorNotifier.app/Contents/MacOS/notifier",
    ).toBe(true);
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

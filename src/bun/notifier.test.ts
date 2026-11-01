import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  resolveNotifier,
  mayUseInstalledAppNotifier,
  buildNotifierArgs,
  buildTaskNotifierPostArgs,
  buildNotifierRemoveArgs,
  buildNotifierListArgs,
  resolveInstalledAppNotifier,
  NOTIFIER_LIST_HEADER,
  notifierListAcked,
  notifierPostAcked,
  notifierRemoveAcked,
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

  const SUFFIX = "Contents/Resources/app/bin/AgetorNotifier.app/Contents/MacOS/notifier";

  test("prefers /Applications over ~/Applications", () => {
    delete process.env[ENV_VAR];
    const seen: string[] = [];
    const r = resolveInstalledAppNotifier({ home: "/Users/someone", exists: (p) => { seen.push(p); return true; } });
    expect(r).toBe(`/Applications/Agetor.app/${SUFFIX}`);
    expect(seen).toEqual([`/Applications/Agetor.app/${SUFFIX}`]);
  });

  test("falls back to ~/Applications/Agetor.app", () => {
    delete process.env[ENV_VAR];
    const home = "/Users/someone";
    const r = resolveInstalledAppNotifier({ home, exists: (p) => p.startsWith(`${home}/Applications/`) });
    expect(r).toBe(`${home}/Applications/Agetor.app/${SUFFIX}`);
  });

  test("null when neither location holds the helper", () => {
    delete process.env[ENV_VAR];
    expect(resolveInstalledAppNotifier({ home: "/Users/someone", exists: () => false })).toBeNull();
  });

  test("the override wins over the seams too", () => {
    process.env[ENV_VAR] = "/custom/notifier";
    expect(resolveInstalledAppNotifier({ home: "/h", exists: () => true })).toBe("/custom/notifier");
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

describe("resolveNotifier: installed-app fallback gate", () => {
  const none = () => false;
  const installed = () => "/Applications/Agetor.app/installed/notifier";

  test("a dev / worktree core (no login-item launch, no opt-in) never falls back to the release app's helper", () => {
    expect(resolveNotifier({ env: {}, exists: none, installedApp: installed })).toBeNull();
    expect(resolveNotifier({ env: { AGETOR_LAUNCHED_BY: "cli" }, exists: none, installedApp: installed })).toBeNull();
    expect(resolveNotifier({ env: { AGETOR_NOTIFIER_USE_INSTALLED_APP: "0" }, exists: none, installedApp: installed })).toBeNull();
  });

  test("a login-item core falls back to the installed app's helper", () => {
    expect(resolveNotifier({ env: { AGETOR_LAUNCHED_BY: "login-item" }, exists: none, installedApp: installed })).toBe(
      "/Applications/Agetor.app/installed/notifier",
    );
  });

  test("AGETOR_NOTIFIER_USE_INSTALLED_APP=1 is an explicit opt-in", () => {
    expect(resolveNotifier({ env: { AGETOR_NOTIFIER_USE_INSTALLED_APP: "1" }, exists: none, installedApp: installed })).toBe(
      "/Applications/Agetor.app/installed/notifier",
    );
  });

  test("the bundled or vendor helper still wins over the installed app, for any core", () => {
    expect(
      resolveNotifier({ env: { AGETOR_LAUNCHED_BY: "login-item" }, exists: (p) => p.includes("vendor"), installedApp: installed }),
    ).toContain("vendor");
  });

  test("the override wins regardless of the gate", () => {
    expect(resolveNotifier({ env: { AGETOR_NOTIFIER_BIN: "/o" }, exists: none, installedApp: installed })).toBe("/o");
  });

  test("mayUseInstalledAppNotifier reads the environment", () => {
    expect(mayUseInstalledAppNotifier({})).toBe(false);
    expect(mayUseInstalledAppNotifier({ AGETOR_LAUNCHED_BY: "login-item" })).toBe(true);
    expect(mayUseInstalledAppNotifier({ AGETOR_NOTIFIER_USE_INSTALLED_APP: "1" })).toBe(true);
  });
});

describe("helper acks", () => {
  test("list: the header must be the first line", () => {
    expect(notifierListAcked(`${NOTIFIER_LIST_HEADER}\n`)).toBe(true);
    expect(notifierListAcked(`${NOTIFIER_LIST_HEADER}\nagetor://task/a\n`)).toBe(true);
    expect(notifierListAcked("")).toBe(false);
    expect(notifierListAcked(`agetor://task/a\n${NOTIFIER_LIST_HEADER}\n`)).toBe(false);
  });

  test("remove: a `removed <n>` line", () => {
    expect(notifierRemoveAcked("removed 0\n")).toBe(true);
    expect(notifierRemoveAcked("removed 3\n")).toBe(true);
    expect(notifierRemoveAcked("")).toBe(false);
    expect(notifierRemoveAcked("removed\n")).toBe(false);
  });

  test("post: `posted <id>` for exactly the requested id", () => {
    expect(notifierPostAcked("posted agetor.task.t1\n", "agetor.task.t1")).toBe(true);
    expect(notifierPostAcked("posted 3F2504E0-4F89\n", "agetor.task.t1")).toBe(false);
    expect(notifierPostAcked("", "agetor.task.t1")).toBe(false);
  });

  test("post: the ack may sit among other lines, but another task's id never counts", () => {
    expect(notifierPostAcked("some log line\nposted agetor.task.t1\n", "agetor.task.t1")).toBe(true);
    expect(notifierPostAcked("posted agetor.task.t10\n", "agetor.task.t1")).toBe(false);
    expect(notifierPostAcked("posted agetor.task.t1-extra\n", "agetor.task.t1")).toBe(false);
  });

  test("remove: the ack line may follow other output, but a count must be a whole line", () => {
    expect(notifierRemoveAcked("note\nremoved 2\n")).toBe(true);
    expect(notifierRemoveAcked("removed 2 entries\n")).toBe(false);
    expect(notifierRemoveAcked("not removed 2\n")).toBe(false);
  });
});

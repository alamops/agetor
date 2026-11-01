import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDaemonLogger } from "./daemon-log.ts";

let dir = "";
let file = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "agetor-daemon-log-"));
  file = path.join(dir, "daemon.log");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createDaemonLogger", () => {
  test("appends timestamped lines and never throws on an unwritable path", () => {
    const log = createDaemonLogger({ path: file });
    log("hello");
    expect(readFileSync(file, "utf8")).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] hello\n$/);
    expect(() => createDaemonLogger({ path: path.join(dir, "no", "such", "dir", "x.log") })("x")).not.toThrow();
  });

  test("an oversized file is copied to .1 and truncated before the next line", () => {
    writeFileSync(file, "a".repeat(100));
    const log = createDaemonLogger({ path: file, maxBytes: 50, checkEveryMs: 0 });
    log("fresh");
    expect(readFileSync(`${file}.1`, "utf8")).toBe("a".repeat(100));
    const live = readFileSync(file, "utf8");
    expect(live).toContain("fresh");
    expect(live).not.toContain("aaaa");
  });

  test("keeps two generations and drops the oldest", () => {
    const log = createDaemonLogger({ path: file, maxBytes: 10, keep: 2, checkEveryMs: 0 });
    for (const tag of ["first", "second", "third"]) {
      writeFileSync(file, `${tag}${"-".repeat(20)}`);
      log("x");
    }
    expect(readFileSync(`${file}.1`, "utf8")).toStartWith("third");
    expect(readFileSync(`${file}.2`, "utf8")).toStartWith("second");
    expect(existsSync(`${file}.3`)).toBe(false);
  });

  test("a file under the limit is left alone", () => {
    writeFileSync(file, "small");
    createDaemonLogger({ path: file, maxBytes: 50, checkEveryMs: 0 })("x");
    expect(existsSync(`${file}.1`)).toBe(false);
    expect(readFileSync(file, "utf8")).toStartWith("small");
  });

  test("the size check is throttled", () => {
    let t = 1_000_000;
    const log = createDaemonLogger({ path: file, maxBytes: 50, checkEveryMs: 60_000, now: () => t });
    log("first"); // checks (nothing to rotate), arms the throttle
    writeFileSync(file, "b".repeat(200));
    log("second"); // within the throttle window: no stat, no rotation
    expect(existsSync(`${file}.1`)).toBe(false);
    t += 60_000;
    log("third");
    expect(existsSync(`${file}.1`)).toBe(true);
  });

  test("rotateIfNeeded ignores the throttle and reports whether it rotated", () => {
    const log = createDaemonLogger({ path: file, maxBytes: 50, checkEveryMs: 60_000 });
    expect(log.rotateIfNeeded()).toBe(false); // no file yet
    writeFileSync(file, "c".repeat(200));
    expect(log.rotateIfNeeded()).toBe(true);
    expect(statSync(file).size).toBe(0);
  });

  test("a descriptor opened O_APPEND (the core child's stdout) keeps writing into the live file after rotation", () => {
    writeFileSync(file, "d".repeat(100));
    const fd = openSync(file, "a");
    try {
      const log = createDaemonLogger({ path: file, maxBytes: 50, checkEveryMs: 0 });
      log("rotate now");
      writeSync(fd, "child console line\n");
      const live = readFileSync(file, "utf8");
      expect(live).toContain("child console line");
      expect(live).not.toContain("\0"); // no sparse hole where the old bytes were
      expect(readFileSync(`${file}.1`, "utf8")).not.toContain("child console line");
    } finally {
      closeSync(fd);
    }
  });
});

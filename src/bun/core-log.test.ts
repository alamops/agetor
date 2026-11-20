import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installCoreLog } from "./core-log.ts";
import { createDaemonLogger } from "./daemon-log.ts";

const dir = mkdtempSync(path.join(tmpdir(), "agetor-core-log-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeConsole() {
  const printed: string[] = [];
  const mk = (m: string) => (...args: unknown[]) => { printed.push(`${m}:${args.join(" ")}`); };
  const target = { log: mk("log"), info: mk("info"), warn: mk("warn"), error: mk("error"), debug: mk("debug") };
  return { target, printed };
}

test("every console method still prints and is copied to the log with its level", () => {
  const { target, printed } = fakeConsole();
  const lines: string[] = [];
  const uninstall = installCoreLog({ logger: (l) => lines.push(l), target });
  target.warn("[agetor] core was unresponsive for %s s during %s", "2.5", "attach subagent watcher");
  target.log("plain", 3);
  target.error(new Error("boom"));
  expect(printed[0]).toContain("warn:");
  expect(printed).toHaveLength(3);
  expect(lines[0]).toBe("WARN [agetor] core was unresponsive for 2.5 s during attach subagent watcher");
  expect(lines[1]).toBe("LOG plain 3");
  expect(lines[2]).toStartWith("ERROR Error: boom");
  uninstall();
  target.log("after");
  expect(lines).toHaveLength(3);
  expect(printed).toHaveLength(4);
});

test("a throwing logger never reaches the caller", () => {
  const { target, printed } = fakeConsole();
  const uninstall = installCoreLog({ logger: () => { throw new Error("disk full"); }, target });
  expect(() => target.warn("still fine")).not.toThrow();
  expect(printed).toEqual(["warn:still fine"]);
  uninstall();
});

test("the log file is created owner-only and gets timestamped lines", () => {
  const file = path.join(dir, "core.log");
  const { target } = fakeConsole();
  const uninstall = installCoreLog({ logger: createDaemonLogger({ path: file, mode: 0o600 }), target });
  target.warn("hello");
  uninstall();
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] WARN hello\n$/);
});

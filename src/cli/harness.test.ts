import { test, expect } from "bun:test";
import { parseHarnessFlags } from "./commands/harness.ts";

test("parseHarnessFlags parses label / kind / bin", () => {
  const f = parseHarnessFlags(["--label", "My Alias", "--kind", "claude-code", "--bin", "/usr/bin/claude"]);
  expect(f.label).toBe("My Alias");
  expect(f.kind).toBe("claude-code");
  expect(f.bin).toBe("/usr/bin/claude");
  expect(f.binSet).toBe(true);
});

test("parseHarnessFlags: repeated --env builds a map and keeps '=' in values", () => {
  const f = parseHarnessFlags(["--env", "A=1", "--env", "B=x=y"]);
  expect(f.env).toEqual({ A: "1", B: "x=y" });
});

test("parseHarnessFlags: --home none clears to null and marks homeSet", () => {
  const cleared = parseHarnessFlags(["--home", "none"]);
  expect(cleared.home).toBeNull();
  expect(cleared.homeSet).toBe(true);

  const set = parseHarnessFlags(["--home", "/abs/dir"]);
  expect(set.home).toBe("/abs/dir");
  expect(set.homeSet).toBe(true);
});

test("parseHarnessFlags rejects a malformed --env and a missing flag value", () => {
  expect(() => parseHarnessFlags(["--env", "noequals"])).toThrow();
  expect(() => parseHarnessFlags(["--label"])).toThrow(); // flagValue: no value
  expect(() => parseHarnessFlags(["--home", "--bin", "/x"])).toThrow(); // flag-as-value
});

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveRefs } from "./refs.ts";

test("resolveRefs makes paths absolute and flags directories", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-refs-"));
  const file = path.join(dir, "a.txt");
  writeFileSync(file, "x");
  const refs = resolveRefs([file, dir]);
  expect(refs[0]).toEqual({ path: file, isDirectory: false });
  expect(refs[1]).toEqual({ path: dir, isDirectory: true });
  rmSync(dir, { recursive: true, force: true });
});

test("resolveRefs resolves a relative path to absolute and tolerates a missing file", () => {
  const refs = resolveRefs(["./nope-does-not-exist-xyz.png"]);
  expect(path.isAbsolute(refs[0]!.path)).toBe(true);
  expect(refs[0]!.path.endsWith("nope-does-not-exist-xyz.png")).toBe(true);
  expect(refs[0]!.isDirectory).toBe(false);
});

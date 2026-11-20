import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunTmpdir, pidAlive, removeRunTmpdir, runTmpdirPid, sweepStaleRunTmpdirs } from "./test-run-tmpdir.ts";

// Each test works in its own base directory, so a sweep can only ever see the
// fixtures planted here.
const bases: string[] = [];
function makeBase(): string {
  const base = mkdtempSync(path.join(tmpdir(), "agt-run-tmpdir-test-"));
  bases.push(base);
  return base;
}
afterEach(() => {
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

const PREFIX = "agt-run-";

test("runTmpdirPid reads the owner pid only from a well-formed run-root name", () => {
  expect(runTmpdirPid("agt-run-1234-AbC123", PREFIX)).toBe(1234);
  expect(runTmpdirPid("agt-run-1234-AbC12", PREFIX)).toBeNull(); // short suffix
  expect(runTmpdirPid("agt-run-x1234-AbC123", PREFIX)).toBeNull();
  expect(runTmpdirPid("agetor-wt-repo-AbC123", PREFIX)).toBeNull();
  expect(runTmpdirPid("agt-e2e-run-77-AbC123", "agt-e2e-run-")).toBe(77);
});

test("pidAlive is true for this process", () => {
  expect(pidAlive(process.pid)).toBe(true);
});

test("the sweep removes dead runs' roots and keeps live, own and unrelated entries", () => {
  const base = makeBase();
  const dead = path.join(base, `${PREFIX}111-aaaaaa`);
  const alive = path.join(base, `${PREFIX}222-bbbbbb`);
  const own = path.join(base, `${PREFIX}${process.pid}-cccccc`);
  const unrelated = path.join(base, "agetor-wt-repo-dddddd");
  const lookalike = path.join(base, `${PREFIX}333-toolongsuffix`);
  for (const d of [dead, alive, own, unrelated, lookalike]) mkdirSync(d);
  writeFileSync(path.join(dead, "leftover.txt"), "x");

  const removed = sweepStaleRunTmpdirs(base, PREFIX, (pid) => pid === 222);

  expect(removed).toEqual([dead]);
  expect(existsSync(dead)).toBe(false);
  for (const d of [alive, own, unrelated, lookalike]) expect(existsSync(d)).toBe(true);
});

test("the sweep never throws on a missing base", () => {
  expect(sweepStaleRunTmpdirs(path.join(makeBase(), "missing"), PREFIX)).toEqual([]);
});

test("createRunTmpdir names the root after this pid, and removeRunTmpdir deletes it with its contents", () => {
  const base = makeBase();
  mkdirSync(path.join(base, `${PREFIX}999999-eeeeee`)); // dead (no such pid)
  const root = createRunTmpdir(base, PREFIX);
  expect(runTmpdirPid(path.basename(root), PREFIX)).toBe(process.pid);
  // Creating swept the dead run's root.
  expect(readdirSync(base)).toEqual([path.basename(root)]);

  mkdirSync(path.join(root, "agetor-fixture-ffffff", "nested"), { recursive: true });
  removeRunTmpdir(root);
  expect(existsSync(root)).toBe(false);
  // Removing again is a no-op, never a throw.
  removeRunTmpdir(root);
});

test("the bun preload pointed TMPDIR at this run's root", () => {
  if (process.env.AGETOR_TEST_KEEP_TMPDIR === "1") return;
  expect(runTmpdirPid(path.basename(tmpdir()), PREFIX)).toBe(process.pid);
});

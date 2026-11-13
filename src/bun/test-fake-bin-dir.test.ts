import { test, expect } from "bun:test";
import { existsSync, mkdirSync, statSync, utimesSync } from "node:fs";
import path from "node:path";
import { FAKE_BIN_ROOT, STALE_FAKE_BIN_MS, fakeBinDir } from "./test-fake-bin-dir.ts";

test("fakeBinDir — makes a fresh directory under /tmp, never under $TMPDIR", () => {
  const dir = fakeBinDir("agetor-helper-test-");
  expect(statSync(dir).isDirectory()).toBe(true);
  expect(path.dirname(dir)).toBe(FAKE_BIN_ROOT);
  expect(path.basename(dir).startsWith("agetor-helper-test-")).toBe(true);
  expect(FAKE_BIN_ROOT.startsWith("/tmp/")).toBe(true);
  expect(fakeBinDir("agetor-helper-test-")).not.toBe(dir);
});

test("fakeBinDir — the first call in a process sweeps stale entries and leaves fresh ones", async () => {
  // Fresh module instance, so its once-per-process sweep has not run yet.
  const mod = await import(`./test-fake-bin-dir.ts?sweep=${Date.now()}`);
  mkdirSync(FAKE_BIN_ROOT, { recursive: true });
  const stale = path.join(FAKE_BIN_ROOT, `agetor-helper-stale-${process.pid}`);
  const fresh = path.join(FAKE_BIN_ROOT, `agetor-helper-fresh-${process.pid}`);
  mkdirSync(stale, { recursive: true });
  mkdirSync(fresh, { recursive: true });
  const old = (Date.now() - STALE_FAKE_BIN_MS - 60_000) / 1000;
  utimesSync(stale, old, old);
  mod.fakeBinDir("agetor-helper-test-");
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
});

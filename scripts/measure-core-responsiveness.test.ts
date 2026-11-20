// Refusal tests for scripts/measure-core-responsiveness.ts (review finding M2).
// Run with: bun test ./scripts/measure-core-responsiveness.test.ts
// (bunfig.toml scopes bare `bun test` to src/, so this file is run by path.)
//
// Each case runs the script as a child with HOME pointing at a temp dir that
// stands in for the real home, so the real ~/.agetor and ~/.agetor-dev are
// never read. Every refusal must exit 2 before anything is written.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dir, "measure-core-responsiveness.ts");
const fakeHome = realpathSync(mkdtempSync(path.join(tmpdir(), "measure-core-home-")));
mkdirSync(path.join(fakeHome, ".agetor"));
mkdirSync(path.join(fakeHome, ".agetor-dev"));
afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));

function run(args: string[]): { code: number | null; err: string } {
  const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: fakeHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, err: r.stderr.toString() };
}

function snapshot(dir: string): string {
  return JSON.stringify(readdirSync(dir, { recursive: true }).sort());
}

describe("measure-core-responsiveness refusals", () => {
  const cases: [string, () => string, RegExp][] = [
    ["inside the real data dir", () => path.join(fakeHome, ".agetor", "bench"), /inside the real data dir/],
    ["equal to the real data dir", () => path.join(fakeHome, ".agetor"), /inside the real data dir/],
    ["HOME, which contains the real data dir", () => fakeHome, /contains the real data dir/],
    ["an ancestor of HOME", () => path.dirname(fakeHome), /contains the real data dir/],
    ["the bench base dir itself", () => path.join(fakeHome, ".agetor-dev"), /bench base dir/],
  ];
  for (const [name, target, msg] of cases) {
    test(`refuses --data-dir ${name}`, () => {
      const before = snapshot(fakeHome);
      const { code, err } = run(["--data-dir", target(), "--cleanup", "--duration-s", "5"]);
      expect(code).toBe(2);
      expect(err).toMatch(msg);
      expect(snapshot(fakeHome)).toBe(before);
    });
  }

  test("refuses an existing non-empty --data-dir and leaves it untouched", () => {
    const dir = path.join(fakeHome, "precious");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "keep.txt"), "do not delete");
    const { code, err } = run(["--data-dir", dir, "--cleanup", "--duration-s", "5"]);
    expect(code).toBe(2);
    expect(err).toMatch(/not empty/);
    expect(existsSync(path.join(dir, "keep.txt"))).toBe(true);
    expect(readdirSync(dir)).toEqual(["keep.txt"]);
  });

  test("refuses a --data-dir that is a file", () => {
    const f = path.join(fakeHome, "afile");
    writeFileSync(f, "x");
    const { code, err } = run(["--data-dir", f, "--duration-s", "5"]);
    expect(code).toBe(2);
    expect(err).toMatch(/not a directory/);
    expect(existsSync(f)).toBe(true);
  });

  test("refuses a symlink that resolves into the real data dir", () => {
    const link = path.join(fakeHome, "sneaky");
    Bun.spawnSync(["ln", "-s", path.join(fakeHome, ".agetor"), link]);
    const { code, err } = run(["--data-dir", path.join(link, "bench"), "--cleanup", "--duration-s", "5"]);
    expect(code).toBe(2);
    expect(err).toMatch(/inside the real data dir/);
    expect(readdirSync(path.join(fakeHome, ".agetor"))).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  defaultDevPaths,
  getLastRehydration,
  parseExtraPathDirs,
  rehydratePath,
} from "./login-path.ts";

// rehydratePath() and defaultDevPaths() both read process.env at call time and
// rehydratePath mutates process.env.PATH. Snapshot the relevant vars and
// restore them after each test so cases don't leak into siblings.
function snapshotEnv(): () => void {
  const keys = ["PATH", "HOME", "SHELL"] as const;
  const saved: Partial<Record<(typeof keys)[number], string | undefined>> = {};
  for (const k of keys) saved[k] = process.env[k];
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

describe("defaultDevPaths", () => {
  let restore: () => void;
  let tmp: string;

  beforeEach(() => {
    restore = snapshotEnv();
    tmp = mkdtempSync(path.join(os.tmpdir(), "agetor-login-path-"));
    process.env.HOME = tmp;
  });

  afterEach(() => {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns empty when HOME is unset", () => {
    delete process.env.HOME;
    expect(defaultDevPaths()).toEqual([]);
  });

  test("includes standard candidates and home-relative paths", () => {
    const paths = defaultDevPaths();
    expect(paths).toContain("/opt/homebrew/bin");
    expect(paths).toContain("/usr/local/bin");
    expect(paths).toContain(path.join(tmp, ".npm-global/bin"));
    expect(paths).toContain(path.join(tmp, ".local/bin"));
    expect(paths).toContain(path.join(tmp, ".asdf/shims"));
    expect(paths).toContain(path.join(tmp, ".local/share/mise/shims"));
  });

  test("does NOT include ~/.fnm — fnm's bin lives elsewhere", () => {
    // Regression guard: an earlier version incorrectly added ~/.fnm to PATH,
    // which is fnm's config dir, not a binaries directory.
    expect(defaultDevPaths()).not.toContain(path.join(tmp, ".fnm"));
  });

  test("enumerates NVM-installed node versions", () => {
    mkdirSync(path.join(tmp, ".nvm/versions/node/v20.11.0/bin"), { recursive: true });
    mkdirSync(path.join(tmp, ".nvm/versions/node/v22.5.1/bin"), { recursive: true });
    const paths = defaultDevPaths();
    expect(paths).toContain(path.join(tmp, ".nvm/versions/node/v20.11.0/bin"));
    expect(paths).toContain(path.join(tmp, ".nvm/versions/node/v22.5.1/bin"));
  });

  test("enumerates fnm-installed node versions (macOS layout)", () => {
    const root = path.join(tmp, "Library/Application Support/fnm/node-versions");
    mkdirSync(path.join(root, "v20.11.0/installation/bin"), { recursive: true });
    expect(defaultDevPaths()).toContain(
      path.join(root, "v20.11.0/installation/bin"),
    );
  });

  test("enumerates fnm-installed node versions (Linux/XDG layout)", () => {
    const root = path.join(tmp, ".local/share/fnm/node-versions");
    mkdirSync(path.join(root, "v22.5.1/installation/bin"), { recursive: true });
    expect(defaultDevPaths()).toContain(
      path.join(root, "v22.5.1/installation/bin"),
    );
  });

  test("survives missing version-manager directories", () => {
    // No nvm, no fnm — should still return standard candidates without throwing.
    expect(() => defaultDevPaths()).not.toThrow();
  });
});

describe("rehydratePath", () => {
  let restore: () => void;
  let tmp: string;

  beforeEach(() => {
    restore = snapshotEnv();
    tmp = mkdtempSync(path.join(os.tmpdir(), "agetor-login-path-"));
    process.env.HOME = tmp;
    // Disable the login-shell probe by clearing SHELL — these tests focus on
    // the merge/dedupe logic, not subprocess behavior.
    delete process.env.SHELL;
  });

  afterEach(() => {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns the merged PATH and writes it to process.env.PATH", () => {
    process.env.PATH = "/usr/bin:/bin";
    const result = rehydratePath();
    expect(process.env.PATH).toBe(result);
    const segments = result.split(":");
    expect(segments).toContain("/usr/bin");
    expect(segments).toContain("/bin");
    expect(segments).toContain("/opt/homebrew/bin");
  });

  test("is idempotent — calling twice produces the same PATH", () => {
    process.env.PATH = "/usr/bin:/bin";
    const first = rehydratePath();
    const second = rehydratePath();
    expect(second).toBe(first);
  });

  test("dedupes paths already present in the original PATH", () => {
    process.env.PATH = `/opt/homebrew/bin:/usr/bin`;
    const result = rehydratePath();
    const segments = result.split(":");
    const count = segments.filter((s) => s === "/opt/homebrew/bin").length;
    expect(count).toBe(1);
  });

  test("preserves entries from the original PATH (never drops)", () => {
    process.env.PATH = `/my/custom/bin:/usr/bin`;
    const result = rehydratePath();
    expect(result.split(":")).toContain("/my/custom/bin");
  });

  test("prepends extraDirs ahead of defaults and the existing PATH", () => {
    process.env.PATH = "/usr/bin";
    const result = rehydratePath({ extraDirs: ["/zzz/first", "/zzz/second"] });
    const segs = result.split(":");
    // Both extras land before any default-dev path. Using /opt/homebrew/bin
    // as the marker since defaultDevPaths() always emits it.
    const homebrewIdx = segs.indexOf("/opt/homebrew/bin");
    expect(segs.indexOf("/zzz/first")).toBeLessThan(homebrewIdx);
    expect(segs.indexOf("/zzz/second")).toBeLessThan(homebrewIdx);
    // And extraDirs preserve the order they were given.
    expect(segs.indexOf("/zzz/first")).toBeLessThan(segs.indexOf("/zzz/second"));
  });

  test("snapshot captures extras + login-probe outcome", () => {
    process.env.PATH = "/usr/bin";
    rehydratePath({ extraDirs: ["/zzz/mine"] });
    const snap = getLastRehydration();
    expect(snap).not.toBeNull();
    expect(snap!.extraDirs).toEqual(["/zzz/mine"]);
    // SHELL was deleted in beforeEach — the login-shell probe should miss.
    expect(snap!.loginProbeOk).toBe(false);
    expect(snap!.path).toBe(process.env.PATH);
  });
});

describe("parseExtraPathDirs", () => {
  test("returns [] for null / empty / whitespace-only inputs", () => {
    expect(parseExtraPathDirs(null)).toEqual([]);
    expect(parseExtraPathDirs(undefined)).toEqual([]);
    expect(parseExtraPathDirs("")).toEqual([]);
    expect(parseExtraPathDirs("\n\n  \n")).toEqual([]);
  });

  test("splits on newlines, trims, drops blanks", () => {
    expect(parseExtraPathDirs("/a/b\n  /c/d  \n\n/e/f")).toEqual([
      "/a/b",
      "/c/d",
      "/e/f",
    ]);
  });
});

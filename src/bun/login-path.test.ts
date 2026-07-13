import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  defaultDevPaths,
  rehydratePath,
  parseLoginShellProbe,
  MARKER_START,
  MARKER_END,
  FNM_START,
  FNM_END,
} from "./login-path.ts";

// rehydratePath() and defaultDevPaths() both read process.env at call time and
// rehydratePath mutates process.env.PATH. Snapshot the relevant vars and
// restore them after each test so cases don't leak into siblings.
function snapshotEnv(): () => void {
  const keys = ["PATH", "HOME", "SHELL", "FNM_DIR"] as const;
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
    // The host running these tests may have fnm configured; clear FNM_DIR so
    // cases opt into it explicitly and the macOS-store scan is never driven by
    // the ambient env.
    delete process.env.FNM_DIR;
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

  test("enumerates fnm node versions from FNM_DIR when set (macOS store)", () => {
    const fnmDir = path.join(tmp, "Library/Application Support/fnm");
    const root = path.join(fnmDir, "node-versions");
    mkdirSync(path.join(root, "v20.11.0/installation/bin"), { recursive: true });
    process.env.FNM_DIR = fnmDir;
    expect(defaultDevPaths()).toContain(
      path.join(root, "v20.11.0/installation/bin"),
    );
  });

  test("does NOT touch fnm's macOS store when FNM_DIR is unset", () => {
    // Regression guard for the macOS TCC "access data from other apps"
    // (kTCCServiceSystemPolicyAppData) prompt: reading
    // ~/Library/Application Support/fnm pops that dialog. We must not scan it
    // unless fnm is actually configured (FNM_DIR present), even if the dir
    // happens to exist on disk.
    const root = path.join(tmp, "Library/Application Support/fnm/node-versions");
    mkdirSync(path.join(root, "v20.11.0/installation/bin"), { recursive: true });
    // FNM_DIR deliberately left unset (cleared in beforeEach).
    expect(defaultDevPaths()).not.toContain(
      path.join(root, "v20.11.0/installation/bin"),
    );
  });

  test("honors a non-default FNM_DIR location", () => {
    const fnmDir = path.join(tmp, ".config/fnm");
    const root = path.join(fnmDir, "node-versions");
    mkdirSync(path.join(root, "v18.20.0/installation/bin"), { recursive: true });
    process.env.FNM_DIR = fnmDir;
    expect(defaultDevPaths()).toContain(
      path.join(root, "v18.20.0/installation/bin"),
    );
  });

  test("does not duplicate a bin dir when FNM_DIR points at the XDG store", () => {
    // FNM_DIR = the same ~/.local/share/fnm root that's scanned unconditionally.
    // The derived root must be de-duped so the bin dir appears exactly once.
    const fnmDir = path.join(tmp, ".local/share/fnm");
    const bin = path.join(fnmDir, "node-versions/v22.5.1/installation/bin");
    mkdirSync(bin, { recursive: true });
    process.env.FNM_DIR = fnmDir;
    const count = defaultDevPaths().filter((p) => p === bin).length;
    expect(count).toBe(1);
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

describe("parseLoginShellProbe", () => {
  test("extracts both PATH and FNM_DIR when present", () => {
    const stdout =
      `banner noise${MARKER_START}/opt/homebrew/bin:/usr/bin${MARKER_END}` +
      `${FNM_START}/Users/x/Library/Application Support/fnm${FNM_END}trailing`;
    expect(parseLoginShellProbe(stdout)).toEqual({
      path: "/opt/homebrew/bin:/usr/bin",
      fnmDir: "/Users/x/Library/Application Support/fnm",
    });
  });

  test("returns null fnmDir when FNM_DIR is empty (non-fnm shell)", () => {
    const stdout =
      `${MARKER_START}/usr/bin${MARKER_END}${FNM_START}${FNM_END}`;
    expect(parseLoginShellProbe(stdout)).toEqual({ path: "/usr/bin", fnmDir: null });
  });

  test("returns nulls when markers are missing", () => {
    expect(parseLoginShellProbe("garbage with no markers")).toEqual({
      path: null,
      fnmDir: null,
    });
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
    // Keep the fnm macOS-store scan (and its real-FS access) out of these tests.
    delete process.env.FNM_DIR;
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

  test("adopts FNM_DIR from the login shell and enumerates its versions", () => {
    // Simulate a Finder launch: FNM_DIR absent from our env, but the user's
    // login shell exports it. A fake $SHELL prints the probe markers with a
    // FNM_DIR that has a node version installed; rehydratePath should adopt it
    // and defaultDevPaths() should then surface that version's bin on PATH.
    const fnmDir = path.join(tmp, "Library/Application Support/fnm");
    const bin = path.join(fnmDir, "node-versions/v20.11.0/installation/bin");
    mkdirSync(bin, { recursive: true });

    const fakeShell = path.join(tmp, "fake-login-shell.sh");
    writeFileSync(
      fakeShell,
      `#!/bin/sh
printf '%s' '${MARKER_START}'; printf '%s' "/opt/homebrew/bin"; printf '%s' '${MARKER_END}'
printf '%s' '${FNM_START}'; printf '%s' '${fnmDir}'; printf '%s' '${FNM_END}'
`,
    );
    chmodSync(fakeShell, 0o755);
    process.env.SHELL = fakeShell;
    delete process.env.FNM_DIR; // must be adopted from the probe, not the env
    process.env.PATH = "/usr/bin";

    const result = rehydratePath();
    expect(process.env.FNM_DIR ?? "").toBe(fnmDir);
    expect(result.split(":")).toContain(bin);
  });
});

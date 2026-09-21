import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { cloneRepo, defaultCloneDest, parseGitHubRepo } from "./clone.ts";

// clone.ts has no db.ts dependency, so no AGETOR_DATA_DIR dance is needed.

describe("parseGitHubRepo", () => {
  test("https URL", () => {
    expect(parseGitHubRepo("https://github.com/anthropics/claude-code")).toEqual({
      owner: "anthropics",
      repo: "claude-code",
      cloneUrl: "https://github.com/anthropics/claude-code.git",
    });
  });

  test("https URL with .git, trailing slash, http, www — all normalize", () => {
    for (const input of [
      "https://github.com/foo/bar.git",
      "https://github.com/foo/bar/",
      "http://github.com/foo/bar",
      "https://www.github.com/foo/bar",
    ]) {
      expect(parseGitHubRepo(input)?.cloneUrl).toBe("https://github.com/foo/bar.git");
    }
  });

  test("deep link keeps only owner/repo", () => {
    expect(parseGitHubRepo("https://github.com/foo/bar/tree/main/src/x.ts")?.cloneUrl).toBe(
      "https://github.com/foo/bar.git",
    );
  });

  test("scp-style ssh remote", () => {
    expect(parseGitHubRepo("git@github.com:foo/bar.git")?.cloneUrl).toBe(
      "https://github.com/foo/bar.git",
    );
  });

  test("ssh:// remote", () => {
    expect(parseGitHubRepo("ssh://git@github.com/foo/bar.git")?.cloneUrl).toBe(
      "https://github.com/foo/bar.git",
    );
  });

  test("owner/repo shorthand", () => {
    expect(parseGitHubRepo("foo/bar")).toEqual({
      owner: "foo",
      repo: "bar",
      cloneUrl: "https://github.com/foo/bar.git",
    });
  });

  test("repo names with dots and underscores survive", () => {
    expect(parseGitHubRepo("foo/my.repo_name")?.repo).toBe("my.repo_name");
  });

  test("rejects non-GitHub hosts", () => {
    expect(parseGitHubRepo("https://gitlab.com/foo/bar")).toBeNull();
    expect(parseGitHubRepo("git@bitbucket.org:foo/bar.git")).toBeNull();
    // A full URL is never mistaken for owner/repo shorthand.
    expect(parseGitHubRepo("https://evil.example/github.com/foo")).toBeNull();
  });

  test("rejects garbage, empties, and traversal-shaped names", () => {
    expect(parseGitHubRepo("")).toBeNull();
    expect(parseGitHubRepo("   ")).toBeNull();
    expect(parseGitHubRepo("just-words")).toBeNull();
    expect(parseGitHubRepo("foo/..")).toBeNull();
    expect(parseGitHubRepo("foo/.")).toBeNull();
    expect(parseGitHubRepo("https://github.com/foo")).toBeNull();
  });

  test("rejects a leading dash that could smuggle a git flag", () => {
    expect(parseGitHubRepo("-flag/repo")).toBeNull();
    expect(parseGitHubRepo("foo/-flag")).toBeNull();
  });
});

describe("defaultCloneDest", () => {
  test("lands directly under $HOME", () => {
    expect(defaultCloneDest("bar")).toBe(path.join(homedir(), "bar"));
  });
});

describe("cloneRepo", () => {
  let dir: string;
  let sourceRepo: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "agetor-clone-test-"));
    // A local source repo stands in for GitHub — git clone accepts a path the
    // same way it accepts a URL, so the executor is exercised end to end
    // without the network.
    sourceRepo = path.join(dir, "source");
    mkdirSync(sourceRepo);
    const git = (...args: string[]) => {
      const r = spawnSync("git", args, { cwd: sourceRepo, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
    };
    git("init", "-q");
    git("config", "user.email", "test@test");
    git("config", "user.name", "test");
    writeFileSync(path.join(sourceRepo, "README.md"), "# hello\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("clones into a fresh destination", async () => {
    const dest = path.join(dir, "fresh");
    const result = await cloneRepo(sourceRepo, dest);
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(dest, "README.md"))).toBe(true);
    expect(existsSync(path.join(dest, ".git"))).toBe(true);
  });

  test("creates missing parent directories", async () => {
    const dest = path.join(dir, "deep", "nested", "clone");
    const result = await cloneRepo(sourceRepo, dest);
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(dest, "README.md"))).toBe(true);
  });

  test("refuses an existing non-empty destination", async () => {
    const dest = path.join(dir, "occupied");
    mkdirSync(dest);
    writeFileSync(path.join(dest, "keep.txt"), "x");
    const result = await cloneRepo(sourceRepo, dest);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not empty");
    // The occupant is untouched.
    expect(existsSync(path.join(dest, "keep.txt"))).toBe(true);
  });

  test("an existing but empty destination is fine", async () => {
    const dest = path.join(dir, "empty-ok");
    mkdirSync(dest);
    const result = await cloneRepo(sourceRepo, dest);
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(dest, "README.md"))).toBe(true);
  });

  test("surfaces git's error on a bad source", async () => {
    const dest = path.join(dir, "never-created");
    const result = await cloneRepo(path.join(dir, "no-such-repo"), dest);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("clone failed");
  });
});

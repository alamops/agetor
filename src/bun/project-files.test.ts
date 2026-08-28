import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Set AGETOR_DATA_DIR BEFORE importing project-files.ts, which imports
// worktree.ts, which imports db.ts (opens the sqlite db at module load).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pf-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

// Standalone helper: run git in a directory, fire-and-forget.
async function git(args: string[], cwd: string) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-pf-repo-"));
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), "hi\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  return repo;
}

// ---------------------------------------------------------------------------
// listProjectFiles — live mode
// ---------------------------------------------------------------------------

test("listProjectFiles (live mode) lists tracked + untracked, excludes ignored + deleted, keeps spaced filenames intact", async () => {
  const { listProjectFiles } = await import("./project-files.ts");
  const repo = await makeRepo();

  // Tracked file, then deleted from disk without committing the deletion —
  // must not be offered.
  writeFileSync(path.join(repo, "to-delete.txt"), "bye\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "add to-delete"], repo);
  rmSync(path.join(repo, "to-delete.txt"));

  // Untracked file — must be included.
  writeFileSync(path.join(repo, "untracked.txt"), "new\n");

  // Ignored file — must be excluded.
  writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
  await git(["add", ".gitignore"], repo);
  await git(["commit", "-m", "add gitignore"], repo);
  writeFileSync(path.join(repo, "ignored.txt"), "skip me\n");

  // Untracked filename with a space — must round-trip intact.
  writeFileSync(path.join(repo, "space file.txt"), "spaces\n");

  const res = await listProjectFiles({ dir: repo });
  if ("error" in res) throw new Error(res.error);

  expect(res.files).toContain("README");
  expect(res.files).toContain(".gitignore");
  expect(res.files).toContain("untracked.txt");
  expect(res.files).toContain("space file.txt");
  expect(res.files).not.toContain("to-delete.txt");
  expect(res.files).not.toContain("ignored.txt");
  expect(res.truncated).toBe(false);
  // Sorted by plain code-unit comparison.
  expect(res.files).toEqual([...res.files].sort((a, b) => (a < b ? -1 : 1)));
});

// ---------------------------------------------------------------------------
// listProjectFiles — ref mode
// ---------------------------------------------------------------------------

test("listProjectFiles (ref mode) lists only the files present at HEAD~1 vs main", async () => {
  const { listProjectFiles } = await import("./project-files.ts");
  const repo = await makeRepo();
  writeFileSync(path.join(repo, "second.txt"), "second\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "second commit"], repo);

  const first = await listProjectFiles({ dir: repo, ref: "HEAD~1" });
  if ("error" in first) throw new Error(first.error);
  expect(first.files).toEqual(["README"]);

  const second = await listProjectFiles({ dir: repo, ref: "main" });
  if ("error" in second) throw new Error(second.error);
  expect(second.files.sort()).toEqual(["README", "second.txt"]);
});

test("listProjectFiles (ref mode) resolves a local-only branch name", async () => {
  const { listProjectFiles } = await import("./project-files.ts");
  const repo = await makeRepo();
  await git(["checkout", "-b", "feature"], repo);
  writeFileSync(path.join(repo, "feature.txt"), "f\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "feature commit"], repo);

  const res = await listProjectFiles({ dir: repo, ref: "feature" });
  if ("error" in res) throw new Error(res.error);
  expect(res.files.sort()).toEqual(["README", "feature.txt"]);
});

test("listProjectFiles (ref mode) returns an error for an unknown ref", async () => {
  const { listProjectFiles } = await import("./project-files.ts");
  const repo = await makeRepo();
  const res = await listProjectFiles({ dir: repo, ref: "definitely-not-a-real-ref" });
  expect(res).toEqual({ error: "unknown ref: definitely-not-a-real-ref" });
});

test("listProjectFiles (ref mode) falls back to refs/remotes/origin/<ref> when the branch exists only on origin", async () => {
  const { listProjectFiles } = await import("./project-files.ts");
  const bare = mkdtempSync(path.join(tmpdir(), "agetor-pf-bare-"));
  await git(["init", "--bare", "-b", "main"], bare);
  const repo = await makeRepo();
  await git(["remote", "add", "origin", bare], repo);
  await git(["push", "-u", "origin", "main"], repo);

  await git(["checkout", "-b", "pr-head"], repo);
  writeFileSync(path.join(repo, "prhead.txt"), "pr work\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "pr head commit"], repo);
  await git(["push", "origin", "pr-head"], repo);
  await git(["checkout", "main"], repo);
  await git(["fetch", "origin"], repo);
  // Local branch is gone; only refs/remotes/origin/pr-head remains.
  await git(["branch", "-D", "pr-head"], repo);

  const res = await listProjectFiles({ dir: repo, ref: "pr-head" });
  if ("error" in res) throw new Error(res.error);
  expect(res.files.sort()).toEqual(["README", "prhead.txt"]);
});

// ---------------------------------------------------------------------------
// listProjectFiles — dir validation
// ---------------------------------------------------------------------------

test("listProjectFiles returns an error when dir is not a git repository", async () => {
  const { listProjectFiles } = await import("./project-files.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-pf-nongit-"));
  const res = await listProjectFiles({ dir });
  expect(res).toEqual({ error: "not a git repository" });
});

test("listProjectFiles returns an error for a relative dir path", async () => {
  const { listProjectFiles } = await import("./project-files.ts");
  const res = await listProjectFiles({ dir: "relative/path" });
  expect("error" in res).toBe(true);
});

test("listProjectFiles returns an error for a missing directory", async () => {
  const { listProjectFiles } = await import("./project-files.ts");
  const missing = path.join(tmpdir(), `agetor-pf-missing-${Date.now()}`);
  const res = await listProjectFiles({ dir: missing });
  expect("error" in res).toBe(true);
});

// ---------------------------------------------------------------------------
// listProjectFiles — truncation (structural — MAX_PROJECT_FILES is 20000, too
// large to exercise directly in a unit test)
// ---------------------------------------------------------------------------

test("MAX_PROJECT_FILES is 20000 and a small repo is not reported truncated", async () => {
  const { listProjectFiles, MAX_PROJECT_FILES } = await import("./project-files.ts");
  expect(MAX_PROJECT_FILES).toBe(20_000);

  const repo = await makeRepo();
  for (let i = 0; i < 12; i++) {
    writeFileSync(path.join(repo, `file-${i}.txt`), `${i}\n`);
  }
  const res = await listProjectFiles({ dir: repo });
  if ("error" in res) throw new Error(res.error);
  expect(res.truncated).toBe(false);
  expect(res.files.length).toBeGreaterThanOrEqual(13); // README + 12 new files
});

// ---------------------------------------------------------------------------
// resolveAtPath
// ---------------------------------------------------------------------------

describe("resolveAtPath", () => {
  test("resolves a happy-path file", async () => {
    const { resolveAtPath } = await import("./project-files.ts");
    const repo = await makeRepo();
    expect(resolveAtPath(repo, "README", false)).toBe(path.join(repo, "README"));
  });

  test("resolves a happy-path directory, with and without a trailing slash on input", async () => {
    const { resolveAtPath } = await import("./project-files.ts");
    const repo = await makeRepo();
    mkdirSync(path.join(repo, "sub"));
    const expected = `${path.join(repo, "sub")}/`;
    expect(resolveAtPath(repo, "sub", true)).toBe(expected);
    expect(resolveAtPath(repo, "sub/", true)).toBe(expected);
  });

  test("rejects a '..'-escaping path", async () => {
    const { resolveAtPath } = await import("./project-files.ts");
    const repo = await makeRepo();
    expect(resolveAtPath(repo, "../etc/passwd", false)).toBeNull();
  });

  test("rejects an absolute path", async () => {
    const { resolveAtPath } = await import("./project-files.ts");
    const repo = await makeRepo();
    expect(resolveAtPath(repo, "/etc/passwd", false)).toBeNull();
  });

  test("returns null for a missing path", async () => {
    const { resolveAtPath } = await import("./project-files.ts");
    const repo = await makeRepo();
    expect(resolveAtPath(repo, "does-not-exist.txt", false)).toBeNull();
  });

  test("returns null when a file is requested as a directory", async () => {
    const { resolveAtPath } = await import("./project-files.ts");
    const repo = await makeRepo();
    expect(resolveAtPath(repo, "README", true)).toBeNull();
  });

  test("returns null for a symlink that resolves outside cwd", async () => {
    const { resolveAtPath } = await import("./project-files.ts");
    const repo = await makeRepo();
    const outside = mkdtempSync(path.join(tmpdir(), "agetor-pf-outside-"));
    writeFileSync(path.join(outside, "secret.txt"), "shh\n");
    symlinkSync(path.join(outside, "secret.txt"), path.join(repo, "escape-link.txt"));
    expect(resolveAtPath(repo, "escape-link.txt", false)).toBeNull();
  });

  test("resolves a filename containing spaces", async () => {
    const { resolveAtPath } = await import("./project-files.ts");
    const repo = await makeRepo();
    writeFileSync(path.join(repo, "space file.txt"), "hi\n");
    expect(resolveAtPath(repo, "space file.txt", false)).toBe(path.join(repo, "space file.txt"));
  });
});

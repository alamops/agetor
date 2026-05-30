import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Task } from "../shared/types.ts";

// Set AGETOR_DATA_DIR BEFORE importing db.ts (which imports dataDir at top level).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-wt-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

// Standalone helper: run git in a directory.
async function git(args: string[], cwd: string) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-wt-repo-"));
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), "hi\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  return repo;
}

function fakeTask(overrides: Partial<Task> & { workdir: string }): Task {
  return {
    id: randomUUID(),
    title: "Fix the thing",
    prompt: "p",
    column: "ready",
    agent: "claude-code",
    isolation: "worktree",
    branch: null,
    worktreePath: null,
    baseRef: null,
    mode: null,
    model: null,
    effort: null,
    references: [],
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

beforeAll(async () => {
  // Touch db.ts so its top-level dataDir setup runs once with AGETOR_DATA_DIR set above.
  await import("./db.ts");
});

test("prepareWorkdir returns workdir unchanged when isolation is off", async () => {
  const { prepareWorkdir } = await import("./worktree.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-wt-plain-"));
  const task = fakeTask({ workdir: dir, isolation: "none" });
  const r = await prepareWorkdir(task);
  if ("error" in r) throw new Error(r.error);
  expect(r.cwd).toBe(dir);
  expect(r.branch).toBeNull();
  expect(r.worktreePath).toBeNull();
});

test("prepareWorkdir returns an error when workdir is not a git repo and isolation is worktree", async () => {
  const { prepareWorkdir } = await import("./worktree.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-wt-nongit-"));
  const task = fakeTask({ workdir: dir });
  const r = await prepareWorkdir(task);
  expect("error" in r).toBe(true);
  if ("error" in r) expect(r.error).toContain("not inside a git repo");
});

test("prepareWorkdir creates a worktree + branch inside a git repo", async () => {
  const { prepareWorkdir } = await import("./worktree.ts");
  const repo = await makeRepo();
  const task = fakeTask({ workdir: repo });

  const r = await prepareWorkdir(task);
  expect("error" in r).toBe(false);
  if ("error" in r) throw new Error(r.error);
  expect(r.cwd).not.toBe(repo);
  expect(existsSync(r.cwd)).toBe(true);
  expect(r.branch).toMatch(/^agetor\/[a-f0-9]{12}-fix-the-thing$/);
  expect(r.worktreePath).toBe(r.cwd);
  // The README from the base commit should be present in the new worktree.
  expect(existsSync(path.join(r.cwd, "README"))).toBe(true);
});

test("prepareWorkdir is idempotent: second call reuses the recorded worktree", async () => {
  const { prepareWorkdir } = await import("./worktree.ts");
  const repo = await makeRepo();
  const task = fakeTask({ workdir: repo });

  const first = await prepareWorkdir(task);
  if ("error" in first) throw new Error(first.error);
  const reused = await prepareWorkdir({
    ...task,
    worktreePath: first.worktreePath,
    branch: first.branch,
  });
  if ("error" in reused) throw new Error((reused as { error: string }).error);
  expect(reused.cwd).toBe(first.cwd);
  expect(reused.branch).toBe(first.branch);
  expect(reused.note).toContain("reusing");
});

test("worktree is pinned to baseRef even when source-repo HEAD has moved", async () => {
  const { prepareWorkdir, resolveRef } = await import("./worktree.ts");
  const repo = await makeRepo();

  // Capture the sha we want to pin to.
  const pinned = await resolveRef(repo, "HEAD");
  expect(pinned).toMatch(/^[0-9a-f]{40}$/);

  // Move the source repo's HEAD forward with a new file.
  writeFileSync(path.join(repo, "drift"), "x\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "drift"], repo);

  const task = fakeTask({ workdir: repo, baseRef: pinned });
  const r = await prepareWorkdir(task);
  if ("error" in r) throw new Error(r.error);
  expect(r.cwd).not.toBe(repo);

  // The drift file should NOT be in the worktree because the worktree was
  // checked out at the pinned base sha, not at the current HEAD.
  expect(existsSync(path.join(r.cwd, "drift"))).toBe(false);
  // The base note should reference the short sha.
  expect(r.note).toContain(pinned!.slice(0, 7));
});

test("resolveRef returns null for unknown refs and a sha for HEAD", async () => {
  const { resolveRef } = await import("./worktree.ts");
  const repo = await makeRepo();
  expect(await resolveRef(repo, "HEAD")).toMatch(/^[0-9a-f]{40}$/);
  expect(await resolveRef(repo, "definitely-not-a-real-branch-xyz")).toBeNull();
});

test("prepareWorkdir re-attaches existing branch when worktree dir was manually deleted", async () => {
  const { prepareWorkdir } = await import("./worktree.ts");
  const repo = await makeRepo();
  const task = fakeTask({ workdir: repo });

  // First run: create the worktree and make a commit inside it.
  const first = await prepareWorkdir(task);
  if ("error" in first) throw new Error(first.error);
  writeFileSync(path.join(first.cwd, "agent-work"), "done\n");
  await git(["add", "."], first.cwd);
  await git(["commit", "-m", "agent work"], first.cwd);

  // Manually delete the on-disk directory (simulating a disk event / rm -rf).
  rmSync(first.cwd, { recursive: true, force: true });
  expect(existsSync(first.cwd)).toBe(false);

  // Second prepare: worktreePath is cleared (as orchestrator would record after
  // the dir is missing), but branch name is still known.
  const second = await prepareWorkdir({ ...task, branch: first.branch, worktreePath: null });
  if ("error" in second) throw new Error(second.error);

  expect(existsSync(second.cwd)).toBe(true);
  expect(second.branch).toBe(first.branch);

  // The "agent work" commit must survive — the branch was not reset to base.
  const logProc = Bun.spawn(["git", "log", "--oneline", first.branch!], { cwd: repo, stdout: "pipe" });
  const log = (await new Response(logProc.stdout).text()).trim();
  await logProc.exited;
  expect(log).toContain("agent work");
});

test("getTaskDiff returns a friendly note when the task has no worktree", async () => {
  const { getTaskDiff } = await import("./worktree.ts");
  const repo = await makeRepo();
  // isolation=none against a clean repo reports no changes vs HEAD.
  const off = await getTaskDiff(fakeTask({ workdir: repo, isolation: "none" }));
  expect(off.files).toEqual([]);
  expect(off.note).toContain("matches HEAD");

  const notYet = await getTaskDiff(fakeTask({ workdir: repo, worktreePath: null }));
  expect(notYet.files).toEqual([]);
  expect(notYet.note).toContain("hasn't created a worktree");
});

test("getTaskDiff surfaces workdir changes for isolation=none tasks", async () => {
  const { getTaskDiff } = await import("./worktree.ts");
  const repo = await makeRepo();
  writeFileSync(path.join(repo, "README"), "hi\nthere\n");
  writeFileSync(path.join(repo, "fresh.txt"), "brand new\n");

  const diff = await getTaskDiff(fakeTask({ workdir: repo, isolation: "none" }));
  const readme = diff.files.find((f) => f.path === "README");
  expect(readme).toBeDefined();
  expect(readme!.status).toBe("modified");
  expect(readme!.hunks).toContain("there");

  const fresh = diff.files.find((f) => f.path === "fresh.txt");
  expect(fresh).toBeDefined();
  expect(fresh!.status).toBe("added");
  expect(fresh!.hunks).toContain("brand new");
});

test("getTaskDiff reports a friendly note when isolation=none workdir isn't a git repo", async () => {
  const { getTaskDiff } = await import("./worktree.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-wt-nongit-diff-"));
  const diff = await getTaskDiff(fakeTask({ workdir: dir, isolation: "none" }));
  expect(diff.files).toEqual([]);
  expect(diff.note).toContain("isn't a git repo");
});

test("getTaskDiff reports a friendly note when isolation=none workdir has no commits", async () => {
  const { getTaskDiff } = await import("./worktree.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-wt-empty-repo-"));
  await git(["init", "-b", "main"], dir);
  const diff = await getTaskDiff(fakeTask({ workdir: dir, isolation: "none" }));
  expect(diff.files).toEqual([]);
  expect(diff.note).toContain("no commits");
});

test("getTaskDiff reports a clean worktree", async () => {
  const { prepareWorkdir, getTaskDiff, resolveRef } = await import("./worktree.ts");
  const repo = await makeRepo();
  const base = await resolveRef(repo, "HEAD");
  const task = fakeTask({ workdir: repo, baseRef: base });
  const prepared = await prepareWorkdir(task);
  if ("error" in prepared) throw new Error(prepared.error);

  const diff = await getTaskDiff({ ...task, worktreePath: prepared.worktreePath, branch: prepared.branch });
  expect(diff.files).toEqual([]);
  expect(diff.note).toContain("No changes");
  if (base) expect(diff.base).toBe(base.slice(0, 7));
});

test("getTaskDiff surfaces modified, committed, and newly-created files", async () => {
  const { prepareWorkdir, getTaskDiff, resolveRef } = await import("./worktree.ts");
  const repo = await makeRepo();
  const base = await resolveRef(repo, "HEAD");
  const task = fakeTask({ workdir: repo, baseRef: base });
  const prepared = await prepareWorkdir(task);
  if ("error" in prepared) throw new Error(prepared.error);
  const cwd = prepared.cwd;

  // Committed change to the tracked README.
  writeFileSync(path.join(cwd, "README"), "hi\nthere\n");
  await git(["commit", "-am", "edit readme"], cwd);
  // Uncommitted new file (untracked).
  writeFileSync(path.join(cwd, "fresh.txt"), "brand new\n");

  const live = { ...task, worktreePath: prepared.worktreePath, branch: prepared.branch };
  const diff = await getTaskDiff(live);

  const readme = diff.files.find((f) => f.path === "README");
  expect(readme).toBeDefined();
  expect(readme!.status).toBe("modified");
  expect(readme!.additions).toBeGreaterThan(0);
  expect(readme!.hunks).toContain("there");

  const fresh = diff.files.find((f) => f.path === "fresh.txt");
  expect(fresh).toBeDefined();
  expect(fresh!.status).toBe("added");
  expect(fresh!.hunks).toContain("brand new");
});

test("getTaskDiff truncates a huge file's body but keeps honest line counts", async () => {
  const { prepareWorkdir, getTaskDiff, resolveRef } = await import("./worktree.ts");
  const repo = await makeRepo();
  const base = await resolveRef(repo, "HEAD");
  const task = fakeTask({ workdir: repo, baseRef: base });
  const prepared = await prepareWorkdir(task);
  if ("error" in prepared) throw new Error(prepared.error);

  // ~30k lines easily clears the 200 KB per-file cap.
  const lineCount = 30_000;
  writeFileSync(path.join(prepared.cwd, "huge.txt"), Array.from({ length: lineCount }, (_, i) => `line ${i}`).join("\n") + "\n");

  const diff = await getTaskDiff({ ...task, worktreePath: prepared.worktreePath, branch: prepared.branch });
  const huge = diff.files.find((f) => f.path === "huge.txt");
  expect(huge).toBeDefined();
  expect(huge!.truncated).toBe(true);
  // Body is capped, but the additions count reflects the full file, not 0.
  expect(huge!.hunks.length).toBeLessThanOrEqual(200_000);
  expect(huge!.additions).toBe(lineCount);
});

test("removeWorktree tears down both the worktree and the branch", async () => {
  const { prepareWorkdir, removeWorktree } = await import("./worktree.ts");
  const repo = await makeRepo();
  const task = fakeTask({ workdir: repo });
  const created = await prepareWorkdir(task);
  if ("error" in created) throw new Error(created.error);
  expect(existsSync(created.cwd)).toBe(true);

  await removeWorktree({ ...task, worktreePath: created.worktreePath, branch: created.branch });

  expect(existsSync(created.cwd)).toBe(false);

  // The branch should be gone from the source repo.
  const proc = Bun.spawn(["git", "branch", "--list", created.branch!], {
    cwd: repo,
    stdout: "pipe",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  expect(out).toBe("");
});

test("hasUncommittedChanges returns null when the dir doesn't exist", async () => {
  const { hasUncommittedChanges } = await import("./worktree.ts");
  const missing = path.join(tmpdir(), `agetor-wt-missing-${randomUUID()}`);
  expect(await hasUncommittedChanges(missing)).toBeNull();
});

test("hasUncommittedChanges returns null for a non-git directory", async () => {
  const { hasUncommittedChanges } = await import("./worktree.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-wt-nongit-status-"));
  expect(await hasUncommittedChanges(dir)).toBeNull();
});

test("hasUncommittedChanges returns false for a clean repo", async () => {
  const { hasUncommittedChanges } = await import("./worktree.ts");
  const repo = await makeRepo();
  expect(await hasUncommittedChanges(repo)).toBe(false);
});

test("hasUncommittedChanges returns true for an untracked file", async () => {
  const { hasUncommittedChanges } = await import("./worktree.ts");
  const repo = await makeRepo();
  writeFileSync(path.join(repo, "new.txt"), "hello\n");
  expect(await hasUncommittedChanges(repo)).toBe(true);
});

test("hasUncommittedChanges returns true for a modified tracked file", async () => {
  const { hasUncommittedChanges } = await import("./worktree.ts");
  const repo = await makeRepo();
  writeFileSync(path.join(repo, "README"), "changed\n");
  expect(await hasUncommittedChanges(repo)).toBe(true);
});

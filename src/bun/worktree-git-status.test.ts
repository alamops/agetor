import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import — `beforeAll`
// would race with any sibling test file that already imported db.ts.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-test-"));
// Drive claude through an in-process fake instead of tmux + the real CLI.
// AGETOR_CLAUDE_BIN is also overridden so the agent-status preflight inside
// startTask passes without claude installed.
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo"; // tmux probe in agent-status passes
process.env.AGETOR_CLAUDE_ARGS = "";

// Standalone helper: run git in a directory (mirrors orchestrator.test.ts's
// `git` helper — kept local here since this file owns no shared test util).
async function git(args: string[], cwd: string) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

// Standalone helper: a real temp git repo (default branch `main`) for
// worktree-isolation tests. Never point a task at a real repo in these tests
// — always mkdtemp (see worktree isolation warning in CLAUDE.md).
async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-worktree-git-status-repo-"));
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), "hi\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  return repo;
}

// Local variant with a `master`-named default branch — proves the
// main→master fallback in isMergedIntoDefaultBranch works. The sibling
// makeRepo() helpers in worktrees-list.test.ts / orchestrator-archive-
// teardown.test.ts always use `-b main`.
async function makeMasterRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-worktree-git-status-master-repo-"));
  await git(["init", "-b", "master"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), "hi\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  return repo;
}

// Materialize a real worktree-isolated task and return its prepared paths.
async function makeWorktreeTask(repo: string, title: string) {
  const { createTask } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { tasks } = await import("./db.ts");

  const created = await createTask({
    title,
    prompt: "p",
    agent: "claude-code",
    workdir: repo,
    isolation: "worktree",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const prepared = await prepareWorkdir(created.task);
  if ("error" in prepared) throw new Error(prepared.error);
  tasks.update(taskId, { branch: prepared.branch, worktreePath: prepared.worktreePath });

  return { taskId, worktreePath: prepared.worktreePath!, branch: prepared.branch! };
}

test("isMergedIntoDefaultBranch: fresh worktree at main's tip is merged", async () => {
  const { isMergedIntoDefaultBranch } = await import("./worktree.ts");
  const { db } = await import("./db.ts");

  const repo = await makeRepo();
  const { taskId, worktreePath } = await makeWorktreeTask(repo, "merged fresh worktree");

  try {
    expect(await isMergedIntoDefaultBranch(worktreePath)).toBe(true);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("isMergedIntoDefaultBranch: worktree branch with a new commit is not merged", async () => {
  const { isMergedIntoDefaultBranch } = await import("./worktree.ts");
  const { db } = await import("./db.ts");

  const repo = await makeRepo();
  const { taskId, worktreePath } = await makeWorktreeTask(repo, "diverged worktree");

  try {
    writeFileSync(path.join(worktreePath, "new-file.txt"), "hello\n");
    await git(["add", "."], worktreePath);
    await git(["commit", "-m", "worktree-only commit"], worktreePath);

    expect(await isMergedIntoDefaultBranch(worktreePath)).toBe(false);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("isMergedIntoDefaultBranch: master-named default branch (no main) still resolves", async () => {
  const { isMergedIntoDefaultBranch } = await import("./worktree.ts");
  const { db } = await import("./db.ts");

  const repo = await makeMasterRepo();
  const { taskId, worktreePath } = await makeWorktreeTask(repo, "master default worktree");

  try {
    const result = await isMergedIntoDefaultBranch(worktreePath);
    // Proves the main→master fallback works — a fresh worktree off master's
    // tip must resolve to a real boolean, never null (which would mean the
    // default-branch resolution failed to find `master`).
    expect(result).not.toBeNull();
    expect(typeof result).toBe("boolean");
    expect(result).toBe(true);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("isMergedIntoDefaultBranch: non-repo dir returns null", async () => {
  const { isMergedIntoDefaultBranch } = await import("./worktree.ts");

  const plainDir = mkdtempSync(path.join(tmpdir(), "agetor-worktree-git-status-nonrepo-"));
  try {
    expect(await isMergedIntoDefaultBranch(plainDir)).toBeNull();

    const missingDir = path.join(plainDir, "does-not-exist");
    expect(await isMergedIntoDefaultBranch(missingDir)).toBeNull();
  } finally {
    rmSync(plainDir, { recursive: true, force: true });
  }
});

test("worktreeGitStatus: clean task-backed worktree reports dirty=false, merged=true, not an error", async () => {
  const { worktreeGitStatus } = await import("./orchestrator.ts");
  const { db } = await import("./db.ts");

  const repo = await makeRepo();
  const { taskId } = await makeWorktreeTask(repo, "clean status worktree");

  try {
    const status = await worktreeGitStatus(taskId);
    expect("error" in status).toBe(false);
    if ("error" in status) throw new Error(status.error);

    expect(status.ignored).toBe(false);
    expect(status.dirty).toBe(false);
    expect(status.merged).toBe(true);
    expect(typeof status.ahead).toBe("number");
    expect(status.ahead).toBeGreaterThanOrEqual(0);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("worktreeGitStatus: dirty worktree (untracked file) reports dirty=true", async () => {
  const { worktreeGitStatus } = await import("./orchestrator.ts");
  const { db } = await import("./db.ts");

  const repo = await makeRepo();
  const { taskId, worktreePath } = await makeWorktreeTask(repo, "dirty status worktree");

  try {
    writeFileSync(path.join(worktreePath, "untracked.txt"), "scratch\n");

    const status = await worktreeGitStatus(taskId);
    expect("error" in status).toBe(false);
    if ("error" in status) throw new Error(status.error);

    expect(status.dirty).toBe(true);
    expect(status.ignored).toBe(false);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("worktreeGitStatus: orphan dir (task row deleted, dir left behind) still resolves via WORKTREES_DIR/id", async () => {
  const { worktreeGitStatus } = await import("./orchestrator.ts");
  const { db } = await import("./db.ts");

  const repo = await makeRepo();
  const { taskId, worktreePath } = await makeWorktreeTask(repo, "orphaned status worktree");

  // Remove only the task row — leave the on-disk worktree (with its intact
  // `.git` pointer) behind, simulating an orphan whose owning task vanished
  // without teardown ever running.
  db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);

  try {
    expect(existsSync(worktreePath)).toBe(true);

    const status = await worktreeGitStatus(taskId);
    expect("error" in status).toBe(false);
    if ("error" in status) throw new Error(status.error);

    expect(status.ignored).toBe(false);
    expect(status.merged === null || typeof status.merged === "boolean").toBe(true);
    expect(status.merged).not.toBeUndefined();
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
  }
});

test("worktreeGitStatus + deleteOrphanWorktree: \".\" and \"..\" are refused, WORKTREES_DIR confinement holds", async () => {
  const { worktreeGitStatus, deleteOrphanWorktree } = await import("./orchestrator.ts");
  const { WORKTREES_DIR } = await import("./worktree.ts");

  // Sentinel dir under WORKTREES_DIR — the regression guard: if "." ever
  // resolved to WORKTREES_DIR itself, an rm -rf there would take every
  // task's worktree (including this sentinel) with it.
  const sentinelId = `sentinel-${randomUUID()}`;
  const sentinelDir = path.join(WORKTREES_DIR, sentinelId);
  mkdirSync(sentinelDir, { recursive: true });

  try {
    const statusDot = await worktreeGitStatus(".");
    expect("error" in statusDot).toBe(true);

    const deleteDot = await deleteOrphanWorktree(".");
    expect("error" in deleteDot).toBe(true);

    const statusDotDot = await worktreeGitStatus("..");
    expect("error" in statusDotDot).toBe(true);

    expect(existsSync(sentinelDir)).toBe(true);
    expect(existsSync(WORKTREES_DIR)).toBe(true);
  } finally {
    rmSync(sentinelDir, { recursive: true, force: true });
  }
});

test("deleteOrphanWorktree still works with the queued prune", async () => {
  const { deleteOrphanWorktree } = await import("./orchestrator.ts");
  const { WORKTREES_DIR } = await import("./worktree.ts");

  const orphanId = `orphan-${randomUUID()}`;
  const orphanDir = path.join(WORKTREES_DIR, orphanId);
  mkdirSync(orphanDir, { recursive: true });
  expect(existsSync(orphanDir)).toBe(true);

  const result = await deleteOrphanWorktree(orphanId);
  expect(result).toEqual({ ok: true });
  expect(existsSync(orphanDir)).toBe(false);
});

test("deleteOrphanWorktree: two back-to-back orphan deletes in the same source repo both settle", async () => {
  const { deleteOrphanWorktree } = await import("./orchestrator.ts");
  const { WORKTREES_DIR } = await import("./worktree.ts");

  const repo = await makeRepo();

  // Two throwaway `git worktree add`s off the same source repo, each with no
  // owning task row — genuine orphans sharing one source-repo FIFO chain.
  const idA = `orphan-${randomUUID()}`;
  const idB = `orphan-${randomUUID()}`;
  const dirA = path.join(WORKTREES_DIR, idA);
  const dirB = path.join(WORKTREES_DIR, idB);

  await git(["worktree", "add", "-b", `orphan-branch-${idA}`, dirA, "HEAD"], repo);
  await git(["worktree", "add", "-b", `orphan-branch-${idB}`, dirB, "HEAD"], repo);
  expect(existsSync(dirA)).toBe(true);
  expect(existsSync(dirB)).toBe(true);

  const [resultA, resultB] = await Promise.all([deleteOrphanWorktree(idA), deleteOrphanWorktree(idB)]);

  expect(resultA).toEqual({ ok: true });
  expect(resultB).toEqual({ ok: true });
  expect(existsSync(dirA)).toBe(false);
  expect(existsSync(dirB)).toBe(false);
});

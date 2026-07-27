import { test, expect, beforeAll, describe } from "bun:test";
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

// Standalone helper: run `git rev-parse` and capture the resolved sha/ref.
async function revParse(cwd: string, ref: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", ref], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out;
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

// Run git and capture stdout — used where we need the actual output (branch
// name, upstream), unlike the fire-and-forget `git()` helper above.
async function runCapture(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out;
}

// A repo with a real (bare) "origin" remote — the fixture existing-branch
// tests need, since `branchSource: "existing"` fetches from `origin` before
// checking a branch out.
async function makeRepoWithOrigin(): Promise<{ repo: string; bare: string }> {
  const bare = mkdtempSync(path.join(tmpdir(), "agetor-wt-bare-"));
  await git(["init", "--bare", "-b", "main"], bare);
  const repo = await makeRepo();
  await git(["remote", "add", "origin", bare], repo);
  await git(["push", "-u", "origin", "main"], repo);
  return { repo, bare };
}

// Creates `pr-head` on `repo`, pushes it to origin, then deletes the local
// branch ref (and, when `pruneRemoteTracking`, the remote-tracking ref too) so
// the branch lives ONLY on origin — simulating a PR head branch nobody has
// checked out locally yet.
async function pushPrHeadOnly(repo: string, opts?: { pruneRemoteTracking?: boolean }): Promise<void> {
  await git(["checkout", "-b", "pr-head"], repo);
  writeFileSync(path.join(repo, "prhead.txt"), "pr work\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "pr head commit"], repo);
  await git(["push", "origin", "pr-head"], repo);
  await git(["checkout", "main"], repo);
  await git(["branch", "-D", "pr-head"], repo);
  if (opts?.pruneRemoteTracking) {
    await git(["update-ref", "-d", "refs/remotes/origin/pr-head"], repo);
  }
}

function fakeTask(overrides: Partial<Task> & { workdir: string }): Task {
  return {
    id: randomUUID(),
    title: "Fix the thing",
    prompt: "p",
    column: "ready",
    agent: "claude-code",
    isolation: "worktree",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    mode: null,
    model: null,
    effort: null,
    references: [],    backlog: [], draft: null,
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

test("isBranchNameTakenError matches both git collision wordings, not a stale worktree dir", async () => {
  const { isBranchNameTakenError } = await import("./worktree.ts");
  // Both strings captured verbatim from real `git worktree add` failures.
  // Re-attach form: `git worktree add <path> <branch>` when it's checked out elsewhere.
  expect(isBranchNameTakenError("fatal: 'feature/x' is already used by worktree at '/tmp/wt-b'")).toBe(true);
  // New-branch form: `git worktree add -b <branch> <path>` when a twin created it first.
  expect(isBranchNameTakenError("fatal: a branch named 'feature/x' already exists")).toBe(true);
  // Older git phrasing for the re-attach form.
  expect(isBranchNameTakenError("fatal: 'feature/x' is already checked out at '/tmp/wt-b'")).toBe(true);
  // A stale worktree *directory* is not a name collision — re-pinning wouldn't help.
  expect(isBranchNameTakenError("fatal: '/tmp/wt-a' already exists")).toBe(false);
  expect(isBranchNameTakenError("fatal: invalid reference: nope")).toBe(false);
});

test("prepareWorkdir re-pins a unique branch when the pinned name is already checked out (create-time race)", async () => {
  const { prepareWorkdir } = await import("./worktree.ts");
  const repo = await makeRepo();
  // Task A pins and materializes feature/x.
  const a = fakeTask({ workdir: repo, branch: "feature/x" });
  const ra = await prepareWorkdir(a);
  if ("error" in ra) throw new Error(ra.error);
  expect(ra.branch).toBe("feature/x");
  // Task B raced A at create time and pinned the SAME branch. Materializing it
  // must not fail trying to check the already-checked-out branch into a second
  // worktree — it should recover onto a unique variant.
  const b = fakeTask({ workdir: repo, branch: "feature/x" });
  const rb = await prepareWorkdir(b);
  if ("error" in rb) throw new Error(rb.error);
  expect(rb.branch).not.toBe("feature/x");
  expect(rb.branch!.startsWith("feature/x")).toBe(true);
  expect(existsSync(rb.worktreePath!)).toBe(true);
});

test("prepareWorkdir re-pin never steals a branch another task has pinned but not started", async () => {
  const { prepareWorkdir } = await import("./worktree.ts");
  const repo = await makeRepo();
  const a = fakeTask({ workdir: repo, branch: "feature/y" });
  const ra = await prepareWorkdir(a);
  if ("error" in ra) throw new Error(ra.error);
  // Task B raced onto feature/y; task C has already pinned feature/y-2 but has
  // no ref yet, so a ref-only search would hand B that name. Pass it as taken.
  const b = fakeTask({ workdir: repo, branch: "feature/y" });
  const rb = await prepareWorkdir(b, { takenBranches: new Set(["feature/y-2"]) });
  if ("error" in rb) throw new Error(rb.error);
  expect(rb.branch).not.toBe("feature/y");
  expect(rb.branch).not.toBe("feature/y-2");
  expect(rb.branch).toBe("feature/y-3");
});

test("prepareWorkdir re-attaches (keeps branch + prior commits) when the worktree dir was deleted", async () => {
  const { prepareWorkdir } = await import("./worktree.ts");
  const repo = await makeRepo();
  const task = fakeTask({ workdir: repo });

  const r1 = await prepareWorkdir(task);
  if ("error" in r1) throw new Error(r1.error);
  // The previous run makes a commit on the task's branch.
  writeFileSync(path.join(r1.cwd, "work.txt"), "agent output\n");
  await git(["add", "."], r1.cwd);
  await git(["commit", "-m", "prior run"], r1.cwd);
  rmSync(r1.cwd, { recursive: true, force: true });

  // The persisted row: worktreePath set (it HAS materialized), branch pinned.
  const rerun = { ...task, branch: r1.branch, worktreePath: r1.worktreePath };
  const r2 = await prepareWorkdir(rerun);
  if ("error" in r2) throw new Error(r2.error);
  // Must re-attach to the SAME branch, not re-pin off base — the commit survives.
  expect(r2.branch).toBe(r1.branch);
  expect(existsSync(path.join(r2.cwd, "work.txt"))).toBe(true);
});

test("prepareWorkdir errors (does NOT re-pin) when a materialized task's branch is checked out elsewhere", async () => {
  const { prepareWorkdir } = await import("./worktree.ts");
  const repo = await makeRepo();
  const task = fakeTask({ workdir: repo });

  const r1 = await prepareWorkdir(task);
  if ("error" in r1) throw new Error(r1.error);
  writeFileSync(path.join(r1.cwd, "work.txt"), "agent output\n");
  await git(["add", "."], r1.cwd);
  await git(["commit", "-m", "prior run"], r1.cwd);

  // User deletes the worktree dir, then checks the branch out somewhere else
  // (e.g. in their main repo) to inspect the agent's work.
  rmSync(r1.cwd, { recursive: true, force: true });
  await git(["worktree", "prune"], repo);
  // `git worktree add` requires a path that doesn't exist yet.
  const elsewhere = path.join(mkdtempSync(path.join(tmpdir(), "agetor-wt-elsewhere-")), "wt");
  await git(["worktree", "add", elsewhere, r1.branch!], repo);

  // Re-running must surface a hard error, NOT silently re-pin to a fresh branch
  // off base — that would orphan the "prior run" commit.
  const rerun = { ...task, branch: r1.branch, worktreePath: r1.worktreePath };
  const r2 = await prepareWorkdir(rerun);
  expect("error" in r2).toBe(true);
});

test("prepareWorkdir on branchSource=existing checks out a branch that lives only on origin, tracking it", async () => {
  const { prepareWorkdir } = await import("./worktree.ts");
  const { repo } = await makeRepoWithOrigin();
  // Neither the local branch ref NOR the remote-tracking ref exist yet — the
  // materialization must discover the branch via its own targeted fetch.
  await pushPrHeadOnly(repo, { pruneRemoteTracking: true });

  const task = fakeTask({ workdir: repo, branch: "pr-head", branchSource: "existing" });
  const r = await prepareWorkdir(task);
  if ("error" in r) throw new Error(r.error);
  expect(r.branch).toBe("pr-head");
  expect(existsSync(r.cwd)).toBe(true);
  expect(existsSync(path.join(r.cwd, "prhead.txt"))).toBe(true);

  const headBranch = await runCapture(["symbolic-ref", "--short", "HEAD"], r.cwd);
  expect(headBranch).toBe("pr-head");
  const upstream = await runCapture(["rev-parse", "--abbrev-ref", "pr-head@{upstream}"], r.cwd);
  expect(upstream).toBe("origin/pr-head");
});

test("prepareWorkdir on branchSource=existing uses the local branch when it already exists (no error)", async () => {
  const { prepareWorkdir } = await import("./worktree.ts");
  const { repo } = await makeRepoWithOrigin();
  // Local branch is left in place this time (only the checked-out state moves
  // back to main), so prepareWorkdir hits the branchExists/re-attach arm.
  await pushPrHeadOnly(repo);
  await git(["branch", "pr-head", "origin/pr-head"], repo);

  const task = fakeTask({ workdir: repo, branch: "pr-head", branchSource: "existing" });
  const r = await prepareWorkdir(task);
  if ("error" in r) throw new Error(r.error);
  expect(r.branch).toBe("pr-head");
  expect(existsSync(r.cwd)).toBe(true);
  expect(existsSync(path.join(r.cwd, "prhead.txt"))).toBe(true);

  const headBranch = await runCapture(["symbolic-ref", "--short", "HEAD"], r.cwd);
  expect(headBranch).toBe("pr-head");
});

test("gitWritableRootsSync returns the source repo's .git for a linked worktree", async () => {
  const { prepareWorkdir, gitWritableRootsSync } = await import("./worktree.ts");
  const repo = await makeRepo();
  const task = fakeTask({ workdir: repo });
  const r = await prepareWorkdir(task);
  if ("error" in r) throw new Error(r.error);

  const roots = gitWritableRootsSync(r.cwd);
  expect(roots).toHaveLength(1);
  const common = roots[0]!;
  // It's the shared common dir (objects/refs + worktree registrations live here)…
  expect(path.basename(common)).toBe(".git");
  expect(existsSync(path.join(common, "HEAD"))).toBe(true);
  expect(existsSync(path.join(common, "worktrees"))).toBe(true);
  // …and it lives OUTSIDE the worktree cwd — the whole reason codex's sandbox
  // needs it added as a writable root.
  expect(common.startsWith(r.cwd + path.sep)).toBe(false);
});

test("gitWritableRootsSync returns [] for an ordinary in-repo checkout", async () => {
  const { gitWritableRootsSync } = await import("./worktree.ts");
  const repo = await makeRepo();
  // `.git` sits inside the cwd, already covered by codex's writable workspace.
  expect(gitWritableRootsSync(repo)).toEqual([]);
});

test("gitWritableRootsSync returns [] for a non-git directory", async () => {
  const { gitWritableRootsSync } = await import("./worktree.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-wt-nongit2-"));
  expect(gitWritableRootsSync(dir)).toEqual([]);
});

// End-to-end wiring of the codex spawn path: buildCodexCommand resolves the
// cwd's external git dirs and feeds them to buildCommand's sandbox decision.
// This is the seam spawnAgent uses; covering it here (where real worktrees
// exist) locks the cwd→sandbox contract without standing up tmux.
const codexHarness = {
  id: "codex", kind: "codex" as const, label: "codex",
  isBuiltin: true, home: null, bin: null, env: {}, enabled: true,
};
const codexOpts = { mode: "auto", model: "gpt-5-codex", effort: "high" } as const;

test("buildCodexCommand escalates to danger-full-access in a linked worktree", async () => {
  const { prepareWorkdir } = await import("./worktree.ts");
  const { buildCodexCommand } = await import("./agents.ts");
  const repo = await makeRepo();
  const r = await prepareWorkdir(fakeTask({ workdir: repo }));
  if ("error" in r) throw new Error(r.error);

  const { cmd } = buildCodexCommand(codexHarness, "hi", { ...codexOpts }, r.cwd);
  expect(cmd).toContain("danger-full-access");
  expect(cmd).not.toContain("workspace-write");
  expect(cmd).toContain("approval_policy=never");
});

test("buildCodexCommand keeps workspace-write for an ordinary in-repo checkout", async () => {
  const { buildCodexCommand } = await import("./agents.ts");
  const repo = await makeRepo();

  const { cmd } = buildCodexCommand(codexHarness, "hi", { ...codexOpts }, repo);
  expect(cmd).toContain("workspace-write");
  expect(cmd).not.toContain("danger-full-access");
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

test("parseGitDiff keeps the path for binary-only file sections", async () => {
  const { parseGitDiff } = await import("./git-diff.ts");
  const files = parseGitDiff([
    "diff --git a/assets/logo.png b/assets/logo.png",
    "index 1234567..89abcde 100644",
    "Binary files a/assets/logo.png and b/assets/logo.png differ",
    "",
  ].join("\n"));

  expect(files).toHaveLength(1);
  expect(files[0]?.path).toBe("assets/logo.png");
  expect(files[0]?.binary).toBe(true);
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

test("removeWorktree removes the worktree but keeps the branch when branchSource is existing", async () => {
  const { prepareWorkdir, removeWorktree } = await import("./worktree.ts");
  const { repo } = await makeRepoWithOrigin();
  await pushPrHeadOnly(repo);
  await git(["branch", "pr-head", "origin/pr-head"], repo);

  const task = fakeTask({ workdir: repo, branch: "pr-head", branchSource: "existing" });
  const created = await prepareWorkdir(task);
  if ("error" in created) throw new Error(created.error);
  expect(existsSync(created.cwd)).toBe(true);

  await removeWorktree({ ...task, worktreePath: created.worktreePath, branch: created.branch });
  expect(existsSync(created.cwd)).toBe(false);

  // Unlike a "created" branch, an "existing" one (e.g. a PR's head branch) is
  // the user's own — removeWorktree must not delete it.
  const out = await runCapture(["branch", "--list", "pr-head"], repo);
  expect(out).toContain("pr-head");
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

test("gitFetch returns an error when the dir isn't a git repo", async () => {
  const { gitFetch } = await import("./worktree.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-wt-fetch-nongit-"));
  const r = await gitFetch(dir);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("not a git repository");
});

test("gitFetch succeeds (no-op) for a repo with no remotes", async () => {
  const { gitFetch } = await import("./worktree.ts");
  // `git fetch --all` with nothing to fetch exits 0 — the picker just sees the
  // existing local branches, so the button shouldn't surface a spurious error.
  const repo = await makeRepo();
  const r = await gitFetch(repo);
  expect(r.ok).toBe(true);
  expect(r.error).toBeUndefined();
});

test("gitFetch pulls a newly pushed branch so listBranches surfaces it", async () => {
  const { gitFetch, listBranches } = await import("./worktree.ts");
  // `origin` is a normal repo we point the clone at; a new branch pushed here
  // after the clone is invisible to the clone until a fetch runs.
  const origin = await makeRepo();
  const clone = mkdtempSync(path.join(tmpdir(), "agetor-wt-fetch-clone-"));
  await git(["clone", origin, clone], path.dirname(clone));

  // The clone starts unaware of a branch created on origin post-clone.
  await git(["checkout", "-b", "feature/new-remote-branch"], origin);
  writeFileSync(path.join(origin, "feature.txt"), "remote work\n");
  await git(["add", "."], origin);
  await git(["commit", "-m", "feature commit"], origin);

  const before = await listBranches(clone);
  expect(before.some((b) => b.name.endsWith("feature/new-remote-branch"))).toBe(false);

  const r = await gitFetch(clone);
  expect(r.ok).toBe(true);

  const after = await listBranches(clone);
  expect(after.some((b) => b.name.endsWith("feature/new-remote-branch"))).toBe(true);
});

test("gitFetch --prune drops a remote-tracking branch deleted on origin", async () => {
  const { gitFetch, listBranches } = await import("./worktree.ts");
  // Prove the `--prune` flag really mirrors the remote: a branch that exists at
  // clone time but is later deleted on origin must disappear from the picker.
  const origin = await makeRepo();
  await git(["checkout", "-b", "feature/short-lived"], origin);
  writeFileSync(path.join(origin, "tmp.txt"), "x\n");
  await git(["add", "."], origin);
  await git(["commit", "-m", "short lived"], origin);
  // Leave origin checked out on main so the branch can be deleted later.
  await git(["checkout", "main"], origin);

  const clone = mkdtempSync(path.join(tmpdir(), "agetor-wt-fetch-prune-"));
  await git(["clone", origin, clone], path.dirname(clone));
  const cloned = await listBranches(clone);
  expect(cloned.some((b) => b.name.endsWith("feature/short-lived"))).toBe(true);

  // Delete the branch on origin, then fetch+prune from the clone.
  await git(["branch", "-D", "feature/short-lived"], origin);
  const r = await gitFetch(clone);
  expect(r.ok).toBe(true);

  const pruned = await listBranches(clone);
  expect(pruned.some((b) => b.name.endsWith("feature/short-lived"))).toBe(false);
});

test("listBranches reports behind/ahead/upstream once origin moves ahead + fetch", async () => {
  const { gitFetch, listBranches } = await import("./worktree.ts");
  const origin = await makeRepo();
  const clone = mkdtempSync(path.join(tmpdir(), "agetor-wt-behind-"));
  await git(["clone", origin, clone], path.dirname(clone));

  // A fresh clone is in sync with its upstream.
  const fresh = (await listBranches(clone)).find((b) => b.name === "main");
  expect(fresh?.upstream).toBe("origin/main");
  expect(fresh?.behind).toBe(0);
  expect(fresh?.ahead).toBe(0);

  // Advance origin/main, then fetch so the clone's tracking ref sees it.
  writeFileSync(path.join(origin, "more.txt"), "x\n");
  await git(["add", "."], origin);
  await git(["commit", "-m", "second"], origin);
  await gitFetch(clone);

  const list = await listBranches(clone);
  const after = list.find((b) => b.name === "main");
  expect(after?.behind).toBe(1);
  expect(after?.ahead).toBe(0);
  // Regression guard: with the local `main` behind, `origin/main` has a newer
  // commit date and sorts ahead of it. The dedup must still keep the LOCAL row
  // (not collapse to the remote-tracking ref), or the picker would lose the
  // current/behind/upstream signal for the branch the user actually pulls.
  expect(after?.remote).toBe(false);
  expect(list.some((b) => b.name === "origin/main")).toBe(false);
});

test("gitPull fast-forwards the checked-out branch and clears the behind count", async () => {
  const { gitPull, listBranches } = await import("./worktree.ts");
  const origin = await makeRepo();
  const clone = mkdtempSync(path.join(tmpdir(), "agetor-wt-pull-current-"));
  await git(["clone", origin, clone], path.dirname(clone));

  writeFileSync(path.join(origin, "more.txt"), "x\n");
  await git(["add", "."], origin);
  await git(["commit", "-m", "second"], origin);

  const r = await gitPull(clone, "main");
  expect(r.ok).toBe(true);
  // The fast-forwarded file is now present in the clone's working tree.
  expect(existsSync(path.join(clone, "more.txt"))).toBe(true);
  const after = (await listBranches(clone)).find((b) => b.name === "main");
  expect(after?.behind).toBe(0);
});

test("gitPull fast-forwards a non-checked-out local branch without a checkout", async () => {
  const { gitFetch, gitPull, listBranches } = await import("./worktree.ts");
  const origin = await makeRepo();
  // Create a feature branch on origin so the clone can track it.
  await git(["checkout", "-b", "feature"], origin);
  writeFileSync(path.join(origin, "feat.txt"), "f1\n");
  await git(["add", "."], origin);
  await git(["commit", "-m", "feat1"], origin);
  await git(["checkout", "main"], origin);

  const clone = mkdtempSync(path.join(tmpdir(), "agetor-wt-pull-other-"));
  await git(["clone", origin, clone], path.dirname(clone));
  // Materialize a local `feature` tracking origin/feature, then switch back to
  // main so `feature` is NOT the checked-out branch.
  await git(["checkout", "feature"], clone);
  await git(["checkout", "main"], clone);

  // Advance origin/feature.
  await git(["checkout", "feature"], origin);
  writeFileSync(path.join(origin, "feat.txt"), "f2\n");
  await git(["add", "."], origin);
  await git(["commit", "-m", "feat2"], origin);
  await git(["checkout", "main"], origin);

  await gitFetch(clone);
  expect((await listBranches(clone)).find((b) => b.name === "feature")?.behind).toBe(1);

  const r = await gitPull(clone, "feature");
  expect(r.ok).toBe(true);
  expect((await listBranches(clone)).find((b) => b.name === "feature")?.behind).toBe(0);
  // main is still the checked-out branch — the pull didn't switch worktrees.
  expect((await listBranches(clone)).find((b) => b.current)?.name).toBe("main");
});

test("gitPull refuses to fast-forward a diverged branch", async () => {
  const { gitFetch, gitPull } = await import("./worktree.ts");
  const origin = await makeRepo();
  const clone = mkdtempSync(path.join(tmpdir(), "agetor-wt-pull-diverged-"));
  await git(["clone", origin, clone], path.dirname(clone));

  // A local commit on the clone…
  writeFileSync(path.join(clone, "local.txt"), "L\n");
  await git(["add", "."], clone);
  await git(["commit", "-m", "local"], clone);
  // …and a different commit on origin → divergence.
  writeFileSync(path.join(origin, "remote.txt"), "R\n");
  await git(["add", "."], origin);
  await git(["commit", "-m", "remote"], origin);
  await gitFetch(clone);

  const r = await gitPull(clone, "main");
  expect(r.ok).toBe(false);
  expect(r.error).toBeTruthy();
});

test("gitPull refuses a non-checked-out branch that has diverged from its upstream", async () => {
  const { gitFetch, gitPull } = await import("./worktree.ts");
  // Exercises the `git fetch . <tracking>:<branch>` path's fast-forward-only
  // guard (distinct from the checked-out `git pull --ff-only` path above).
  const origin = await makeRepo();
  await git(["checkout", "-b", "feature"], origin);
  writeFileSync(path.join(origin, "feat.txt"), "f1\n");
  await git(["add", "."], origin);
  await git(["commit", "-m", "feat1"], origin);
  await git(["checkout", "main"], origin);

  const clone = mkdtempSync(path.join(tmpdir(), "agetor-wt-pull-other-diverged-"));
  await git(["clone", origin, clone], path.dirname(clone));
  // Materialize a local `feature`, give it a local-only commit, then switch back
  // to main so `feature` is the non-checked-out branch we pull.
  await git(["checkout", "feature"], clone);
  writeFileSync(path.join(clone, "local.txt"), "L\n");
  await git(["add", "."], clone);
  await git(["commit", "-m", "local feat"], clone);
  await git(["checkout", "main"], clone);

  // A different commit on origin/feature → divergence.
  await git(["checkout", "feature"], origin);
  writeFileSync(path.join(origin, "feat.txt"), "f2\n");
  await git(["add", "."], origin);
  await git(["commit", "-m", "feat2"], origin);
  await git(["checkout", "main"], origin);

  await gitFetch(clone);
  const r = await gitPull(clone, "feature");
  expect(r.ok).toBe(false);
  expect(r.error).toBeTruthy();
});

test("gitPull returns an error when the dir isn't a git repo", async () => {
  const { gitPull } = await import("./worktree.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-wt-pull-nongit-"));
  const r = await gitPull(dir, "main");
  expect(r.ok).toBe(false);
  expect(r.error).toContain("not a git repository");
});

test("gitPull errors when the selected branch has no upstream", async () => {
  const { gitPull } = await import("./worktree.ts");
  const repo = await makeRepo();
  // A second local branch with no upstream, while `main` stays checked out so
  // we exercise the non-checked-out path's upstream lookup.
  await git(["branch", "other"], repo);
  const r = await gitPull(repo, "other");
  expect(r.ok).toBe(false);
  expect(r.error).toContain("no upstream");
});

test("gitPull rejects a branch name that could be read as a git flag", async () => {
  const { gitPull } = await import("./worktree.ts");
  const repo = await makeRepo();
  const r = await gitPull(repo, "--upload-pack=evil");
  expect(r.ok).toBe(false);
  expect(r.error).toContain("invalid branch name");
});

test("gitPush pushes a local-only branch to origin and sets its upstream", async () => {
  const { gitPush } = await import("./worktree.ts");
  // origin stays checked out on main; pushing a *different* new branch to a
  // non-bare repo is allowed (only a push to the checked-out branch is denied).
  const origin = await makeRepo();
  const clone = mkdtempSync(path.join(tmpdir(), "agetor-wt-push-clone-"));
  await git(["clone", origin, clone], path.dirname(clone));

  await git(["checkout", "-b", "feature/pushme"], clone);
  writeFileSync(path.join(clone, "work.txt"), "local work\n");
  await git(["add", "."], clone);
  await git(["commit", "-m", "local work"], clone);

  const r = await gitPush(clone, "feature/pushme");
  expect(r.ok).toBe(true);
  expect(r.remote).toBe("origin");

  // origin now has the branch, and the clone tracks it.
  const onOrigin = Bun.spawnSync(["git", "rev-parse", "--verify", "feature/pushme"], { cwd: origin });
  expect(onOrigin.exitCode).toBe(0);
  const upstream = Bun.spawnSync(
    ["git", "rev-parse", "--abbrev-ref", "feature/pushme@{upstream}"],
    { cwd: clone },
  );
  expect(new TextDecoder().decode(upstream.stdout).trim()).toBe("origin/feature/pushme");
});

test("gitPush errors when the repo has no remote configured", async () => {
  const { gitPush } = await import("./worktree.ts");
  const repo = await makeRepo();
  await git(["checkout", "-b", "feature/local"], repo);
  const r = await gitPush(repo, "feature/local");
  expect(r.ok).toBe(false);
  expect(r.error).toContain("no git remote");
});

test("gitPush rejects a branch name that could be read as a git flag", async () => {
  const { gitPush } = await import("./worktree.ts");
  const repo = await makeRepo();
  const r = await gitPush(repo, "--upload-pack=evil");
  expect(r.ok).toBe(false);
  expect(r.error).toContain("invalid branch name");
});

test("gitPush returns an error when the dir isn't a git repo", async () => {
  const { gitPush } = await import("./worktree.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-wt-push-nongit-"));
  const r = await gitPush(dir, "main");
  expect(r.ok).toBe(false);
  expect(r.error).toContain("not a git repository");
});

describe("getAheadCount", () => {
  test("returns null when the dir doesn't exist", async () => {
    const { getAheadCount } = await import("./worktree.ts");
    const missing = path.join(tmpdir(), `agetor-wt-missing-${randomUUID()}`);
    expect(await getAheadCount(missing, null)).toBeNull();
  });

  test("returns null for a non-git directory", async () => {
    const { getAheadCount } = await import("./worktree.ts");
    const dir = mkdtempSync(path.join(tmpdir(), "agetor-wt-nongit-ahead-"));
    expect(await getAheadCount(dir, null)).toBeNull();
  });

  test("counts commits ahead of a given baseRef when there's no upstream", async () => {
    const { getAheadCount } = await import("./worktree.ts");
    const repo = await makeRepo();
    const baseSha = await revParse(repo, "HEAD");

    writeFileSync(path.join(repo, "a.txt"), "a\n");
    await git(["add", "."], repo);
    await git(["commit", "-m", "second"], repo);

    writeFileSync(path.join(repo, "b.txt"), "b\n");
    await git(["add", "."], repo);
    await git(["commit", "-m", "third"], repo);

    expect(await getAheadCount(repo, baseSha)).toBe(2);

    const headSha = await revParse(repo, "HEAD");
    expect(await getAheadCount(repo, headSha)).toBe(0);
  });

  test("returns 0 (unknown-but-not-blocking) when there's no upstream and no baseRef", async () => {
    const { getAheadCount } = await import("./worktree.ts");
    const repo = await makeRepo();
    expect(await getAheadCount(repo, null)).toBe(0);
  });

  test("prefers the upstream count over baseRef, including a stale/misleading baseRef", async () => {
    const { getAheadCount } = await import("./worktree.ts");
    // A bare repo stands in for the remote: `push -u` gives `repo` a real
    // `@{u}` so getAheadCount should use tier 1 (upstream), not baseRef.
    const bare = mkdtempSync(path.join(tmpdir(), "agetor-wt-ahead-bare-"));
    await git(["init", "--bare", "-b", "main"], bare);

    const repo = await makeRepo();
    await git(["remote", "add", "origin", bare], repo);
    await git(["push", "-u", "origin", "main"], repo);

    expect(await getAheadCount(repo, null)).toBe(0);

    writeFileSync(path.join(repo, "c.txt"), "c\n");
    await git(["add", "."], repo);
    await git(["commit", "-m", "after-push"], repo);

    expect(await getAheadCount(repo, null)).toBe(1);

    // A stale baseRef pointing at the current HEAD would give a
    // baseRef..HEAD count of 0 if the baseRef tier were (incorrectly) used —
    // but the upstream tier must win, so the answer stays 1.
    const headSha = await revParse(repo, "HEAD");
    expect(await getAheadCount(repo, headSha)).toBe(1);
  });

  test("returns null for an invalid baseRef when there's no upstream", async () => {
    const { getAheadCount } = await import("./worktree.ts");
    const repo = await makeRepo();
    expect(await getAheadCount(repo, "no-such-ref")).toBeNull();
  });
});

describe("detachWorktree", () => {
  test("removes the checkout but keeps the branch and its commits", async () => {
    const { prepareWorkdir, detachWorktree } = await import("./worktree.ts");
    const repo = await makeRepo();
    const task = fakeTask({ workdir: repo });
    const created = await prepareWorkdir(task);
    if ("error" in created) throw new Error(created.error);

    writeFileSync(path.join(created.cwd, "work.txt"), "agent output\n");
    await git(["add", "."], created.cwd);
    await git(["commit", "-m", "agent work"], created.cwd);

    const live = { ...task, worktreePath: created.worktreePath, branch: created.branch };
    const result = await detachWorktree(live);
    expect(result).toEqual({ removed: true });
    expect(existsSync(created.cwd)).toBe(false);

    // The branch must survive in the source repo — that's the whole point of
    // detach vs removeWorktree.
    const branchProc = Bun.spawn(["git", "branch", "--list", created.branch!], {
      cwd: repo,
      stdout: "pipe",
    });
    const branchOut = (await new Response(branchProc.stdout).text()).trim();
    await branchProc.exited;
    expect(branchOut).toContain(created.branch!);

    // The commit made inside the (now-removed) worktree is still reachable on
    // the branch in the source repo.
    const logProc = Bun.spawn(["git", "log", "--oneline", created.branch!], {
      cwd: repo,
      stdout: "pipe",
    });
    const log = (await new Response(logProc.stdout).text()).trim();
    await logProc.exited;
    expect(log).toContain("agent work");
  });

  test("round-trip: prepareWorkdir re-materializes the checkout at the same path with the prior commit intact", async () => {
    const { prepareWorkdir, detachWorktree } = await import("./worktree.ts");
    const repo = await makeRepo();
    const task = fakeTask({ workdir: repo });
    const created = await prepareWorkdir(task);
    if ("error" in created) throw new Error(created.error);

    writeFileSync(path.join(created.cwd, "work.txt"), "agent output\n");
    await git(["add", "."], created.cwd);
    await git(["commit", "-m", "agent work"], created.cwd);

    // The orchestrator keeps worktreePath + branch on the task row across
    // detach (that's what makes the later re-attach deterministic).
    const live = { ...task, worktreePath: created.worktreePath, branch: created.branch };
    const detached = await detachWorktree(live);
    expect(detached).toEqual({ removed: true });
    expect(existsSync(created.cwd)).toBe(false);

    const restored = await prepareWorkdir(live);
    if ("error" in restored) throw new Error(restored.error);
    expect(restored.cwd).toBe(created.cwd);
    expect(restored.worktreePath).toBe(created.worktreePath);
    expect(restored.branch).toBe(created.branch);
    expect(existsSync(path.join(restored.cwd, "work.txt"))).toBe(true);
  });

  test("skips removal when the worktree has uncommitted changes", async () => {
    const { prepareWorkdir, detachWorktree } = await import("./worktree.ts");
    const repo = await makeRepo();
    const task = fakeTask({ workdir: repo });
    const created = await prepareWorkdir(task);
    if ("error" in created) throw new Error(created.error);

    writeFileSync(path.join(created.cwd, "dirty.txt"), "uncommitted\n");

    const live = { ...task, worktreePath: created.worktreePath, branch: created.branch };
    const result = await detachWorktree(live);
    expect(result).toEqual({ removed: false, reason: "dirty" });
    expect(existsSync(created.cwd)).toBe(true);
    expect(existsSync(path.join(created.cwd, "dirty.txt"))).toBe(true);
  });

  test("no-op when the task never materialized a worktree", async () => {
    const { detachWorktree } = await import("./worktree.ts");
    const repo = await makeRepo();
    const task = fakeTask({ workdir: repo, worktreePath: null, branch: null });
    const result = await detachWorktree(task);
    expect(result).toEqual({ removed: false, reason: "no-worktree" });
  });

  test("no-op when the worktree dir is already gone", async () => {
    const { prepareWorkdir, detachWorktree } = await import("./worktree.ts");
    const repo = await makeRepo();
    const task = fakeTask({ workdir: repo });
    const created = await prepareWorkdir(task);
    if ("error" in created) throw new Error(created.error);
    rmSync(created.cwd, { recursive: true, force: true });

    const live = { ...task, worktreePath: created.worktreePath, branch: created.branch };
    const result = await detachWorktree(live);
    expect(result).toEqual({ removed: false, reason: "already-absent" });
  });

  test("detaching twice is idempotent — second call reports already-absent without throwing", async () => {
    const { prepareWorkdir, detachWorktree } = await import("./worktree.ts");
    const repo = await makeRepo();
    const task = fakeTask({ workdir: repo });
    const created = await prepareWorkdir(task);
    if ("error" in created) throw new Error(created.error);

    const live = { ...task, worktreePath: created.worktreePath, branch: created.branch };
    const first = await detachWorktree(live);
    expect(first).toEqual({ removed: true });

    const second = await detachWorktree(live);
    expect(second).toEqual({ removed: false, reason: "already-absent" });

    // Branch still exists throughout — detach never deletes it.
    const branchProc = Bun.spawn(["git", "branch", "--list", created.branch!], {
      cwd: repo,
      stdout: "pipe",
    });
    const branchOut = (await new Response(branchProc.stdout).text()).trim();
    await branchProc.exited;
    expect(branchOut).toContain(created.branch!);
  });
});

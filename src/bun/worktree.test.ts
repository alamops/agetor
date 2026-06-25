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
    taskType: "task",
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

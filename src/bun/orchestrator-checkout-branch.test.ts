import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-checkout-branch-test-"));
// Drive claude through the in-process fake instead of tmux + the real CLI.
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo"; // tmux probe in agent-status passes
process.env.AGETOR_CLAUDE_ARGS = "";

// Worktree branch drift is tolerated, never corrected, and recorded as
// `task.checkoutBranch` (docs/plans/codex-terminal-worktree-error.md, U4).

async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out;
}

async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-checkout-branch-repo-"));
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), "hi\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  return repo;
}

async function waitFor(check: () => boolean, timeoutMs = 8000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error("waitFor: timed out waiting for condition");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

async function branchExists(repo: string, name: string): Promise<boolean> {
  return (await git(["branch", "--list", name], repo)).length > 0;
}

/** Create a worktree task, run it once under the fake driver (materializing
 *  the worktree), wait for the settle, and return its ids/paths. */
async function startedWorktreeTask(opts: { title: string; prompt?: string }) {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");
  harnesses.setEnabled("claude-code", true);
  const repo = await makeRepo();
  const created = await createTask({ title: opts.title, prompt: opts.prompt ?? "p", agent: "claude-code", workdir: repo, isolation: "worktree" });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  await waitFor(() => tasks.get(taskId)?.column === "review");
  const t = tasks.get(taskId)!;
  return { repo, taskId, wt: t.worktreePath!, taskBranch: t.branch! };
}

async function drift(wt: string, branch = "implement/x"): Promise<void> {
  await git(["checkout", "-b", branch], wt);
  writeFileSync(path.join(wt, "README"), `drift onto ${branch}\n`);
  await git(["commit", "-am", "drift"], wt);
}

function statusLines(taskId: string, runs: typeof import("./db.ts").runs): string[] {
  return runs.eventsForTask(taskId).filter((e) => e.stream === "status").map((e) => e.data);
}

test("run start records the checkout; a re-run on a drifted worktree runs there and logs the drift line", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");
  const { taskId, wt, taskBranch } = await startedWorktreeTask({ title: "drift rerun" });
  expect(tasks.get(taskId)?.checkoutBranch).toBe(taskBranch);

  await drift(wt);
  // A conflicting uncommitted edit used to fail the reuse checkout.
  writeFileSync(path.join(wt, "README"), "uncommitted\n");
  const again = await startTask(taskId);
  if ("error" in again) throw new Error(`re-run refused: ${again.error}`);
  await waitFor(() => tasks.get(taskId)?.column === "review");

  expect(await git(["symbolic-ref", "--short", "HEAD"], wt)).toBe("implement/x");
  const after = tasks.get(taskId)!;
  expect(after.branch).toBe(taskBranch);
  expect(after.checkoutBranch).toBe("implement/x");
  const lines = statusLines(taskId, runs);
  expect(lines).toContain(`worktree is on implement/x (task branch ${taskBranch}) — running there`);
  tasks.delete(taskId);
});

test("a PR-head task gets the stronger drift warning", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");
  const { taskId, wt, taskBranch } = await startedWorktreeTask({ title: "pr head drift" });
  // Flip to a PR-head task (the branch is the user's own) — the run-log rule
  // only reads `branchSource`.
  const { db } = await import("./db.ts");
  db.run(`UPDATE tasks SET branch_source = 'existing' WHERE id = ?`, [taskId]);
  await drift(wt);
  const again = await startTask(taskId);
  if ("error" in again) throw new Error(again.error);
  await waitFor(() => tasks.get(taskId)?.column === "review");
  expect(statusLines(taskId, runs)).toContain(
    `⚠ worktree is on implement/x, not the PR head branch ${taskBranch} — commits here will not land on the pull request`,
  );
  tasks.delete(taskId);
});

test("run settle refreshes the checkout when the branch moved during the turn", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  // The fake driver's handoff scenario honours AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS
  // (the plain scenario resolves in a few ms), which is what holds the turn
  // open while the test drifts the worktree.
  const { taskId, wt, taskBranch } = await startedWorktreeTask({
    title: "settle refresh",
    prompt: "__agetor_fake_claude_handoff__",
  });
  expect(tasks.get(taskId)?.checkoutBranch).toBe(taskBranch);
  // The agent switches branches mid-turn: hold the fake turn open long
  // enough to drift the worktree while the run is in flight. Run start
  // records the task branch; only the settle can observe the new one.
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "1500";
  try {
    const again = await startTask(taskId);
    if ("error" in again) throw new Error(again.error);
    expect(tasks.get(taskId)?.column).toBe("running");
    expect(tasks.get(taskId)?.checkoutBranch).toBe(taskBranch);
    await drift(wt, "implement/mid-turn");
    await waitFor(() => tasks.get(taskId)?.column === "review");
    await waitFor(() => tasks.get(taskId)?.checkoutBranch === "implement/mid-turn");
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
  tasks.delete(taskId);
});

test("archive records the live branch; unarchive re-attaches onto it", async () => {
  const { archiveTask, unarchiveTask, pendingTeardown } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const { taskId, wt, taskBranch } = await startedWorktreeTask({ title: "archive record" });
  await drift(wt);
  // checkoutBranch is still the run-start value: only archive observes the drift.
  expect(tasks.get(taskId)?.checkoutBranch).toBe(taskBranch);
  tasks.update(taskId, { column: "done" });
  const archived = await archiveTask(taskId);
  if (!("task" in archived)) throw new Error(archived.error);
  await pendingTeardown(taskId);
  expect(existsSync(wt)).toBe(false);
  expect(tasks.get(taskId)?.checkoutBranch).toBe("implement/x");

  const restored = await unarchiveTask(taskId);
  if (!("task" in restored)) throw new Error(restored.error);
  expect(existsSync(wt)).toBe(true);
  expect(await git(["symbolic-ref", "--short", "HEAD"], wt)).toBe("implement/x");
  expect(await git(["log", "-1", "--format=%s"], wt)).toBe("drift");
  expect(tasks.get(taskId)?.branch).toBe(taskBranch);
  tasks.delete(taskId);
});

test("unarchive after the recorded branch was deleted falls back to the task branch with a status line", async () => {
  const { archiveTask, unarchiveTask, pendingTeardown } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");
  const { repo, taskId, wt, taskBranch } = await startedWorktreeTask({ title: "archive fallback" });
  await drift(wt);
  tasks.update(taskId, { column: "done" });
  const archived = await archiveTask(taskId);
  if (!("task" in archived)) throw new Error(archived.error);
  await pendingTeardown(taskId);
  await git(["branch", "-D", "implement/x"], repo);

  const restored = await unarchiveTask(taskId);
  if (!("task" in restored)) throw new Error(restored.error);
  expect(await git(["symbolic-ref", "--short", "HEAD"], wt)).toBe(taskBranch);
  expect(tasks.get(taskId)?.checkoutBranch).toBe(taskBranch);
  expect(statusLines(taskId, runs)).toContain(`recorded checkout implement/x no longer exists — restored on ${taskBranch}`);
  tasks.delete(taskId);
});

test("teardownBranchesForTask: live, last-seen (archived) and no drift", async () => {
  const { teardownBranchesForTask, archiveTask, pendingTeardown } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const { taskId, wt, taskBranch } = await startedWorktreeTask({ title: "preview" });

  expect(await teardownBranchesForTask(tasks.get(taskId)!)).toEqual({
    branches: [taskBranch], liveBranch: taskBranch, taskBranch, source: "task-branch", excluded: [],
  });

  await drift(wt);
  expect(await teardownBranchesForTask(tasks.get(taskId)!)).toEqual({
    branches: [taskBranch, "implement/x"], liveBranch: "implement/x", taskBranch, source: "live", excluded: [],
  });

  tasks.update(taskId, { column: "done" });
  const archived = await archiveTask(taskId);
  if (!("task" in archived)) throw new Error(archived.error);
  await pendingTeardown(taskId);
  expect(await teardownBranchesForTask(tasks.get(taskId)!)).toEqual({
    branches: [taskBranch, "implement/x"], liveBranch: null, taskBranch, source: "last-seen", excluded: [],
  });
  tasks.delete(taskId);
});

test("teardownBranchesForTask never names the default branch and is empty for isolation none", async () => {
  const { teardownBranchesForTask, createTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const { taskId, wt, taskBranch } = await startedWorktreeTask({ title: "default excluded" });
  // `main` is checked out in the source repo, so detach it there first;
  // then put the worktree on main.
  const repoMain = (await git(["rev-parse", "--show-toplevel"], wt)) && tasks.get(taskId)!.workdir;
  await git(["checkout", "--detach"], repoMain);
  await git(["checkout", "main"], wt);
  expect(await teardownBranchesForTask(tasks.get(taskId)!)).toEqual({
    branches: [taskBranch], liveBranch: "main", taskBranch, source: "live",
    excluded: [{ branch: "main", reason: "default-branch" }],
  });
  tasks.delete(taskId);

  const plain = await createTask({ title: "plain", prompt: "p", agent: "claude-code", workdir: repoMain, isolation: "none" });
  if ("error" in plain) throw new Error(plain.error);
  expect((await teardownBranchesForTask(plain.task)).branches).toEqual([]);
  tasks.delete(plain.task.id);
});

test("deleteTask removes both branches but skips one another task holds", async () => {
  const { deleteTask, createTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const { repo, taskId, wt, taskBranch } = await startedWorktreeTask({ title: "delete both" });
  await drift(wt);
  expect(await branchExists(repo, "implement/x")).toBe(true);

  await deleteTask(taskId);
  expect(existsSync(wt)).toBe(false);
  expect(await branchExists(repo, taskBranch)).toBe(false);
  expect(await branchExists(repo, "implement/x")).toBe(false);

  // Second scenario: another task in the same repo holds the drifted branch.
  const { taskId: aId, wt: aWt, taskBranch: aBranch } = await startedWorktreeTask({ title: "delete held" });
  const aRepo = tasks.get(aId)!.workdir;
  await drift(aWt, "shared/branch");
  const other = await createTask({ title: "holder", prompt: "p", agent: "claude-code", workdir: aRepo, isolation: "worktree" });
  if ("error" in other) throw new Error(other.error);
  tasks.update(other.task.id, { branch: "shared/branch" });

  await deleteTask(aId);
  expect(await branchExists(aRepo, aBranch)).toBe(false);
  expect(await branchExists(aRepo, "shared/branch")).toBe(true);
  tasks.delete(other.task.id);
});

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
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

// Standalone helper: a real temp git repo for worktree-isolation tests. Never
// point a task at a real repo in these tests — always mkdtemp (see worktree
// isolation warning in CLAUDE.md).
async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-worktrees-list-repo-"));
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), "hi\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  return repo;
}

test("listWorktrees classifies a linked worktree as fresh", async () => {
  const { createTask, listWorktrees } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { db, tasks } = await import("./db.ts");

  const repo = await makeRepo();
  const created = await createTask({
    title: "fresh worktree",
    prompt: "p",
    agent: "claude-code",
    workdir: repo,
    isolation: "worktree",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  try {
    const prepared = await prepareWorkdir(created.task);
    if ("error" in prepared) throw new Error(prepared.error);
    tasks.update(taskId, { branch: prepared.branch, worktreePath: prepared.worktreePath });

    const entries = listWorktrees();
    const entry = entries.find((e) => e.id === taskId);
    expect(entry).toBeDefined();
    expect(entry?.taskId).toBe(taskId);
    expect(entry?.taskTitle).toBe("fresh worktree");
    expect(entry?.column).toBe(created.task.column);
    expect(entry?.branch).toBe(prepared.branch);
    expect(entry?.workdir).toBe(repo);
    expect(entry?.stale).toBe(false);
    expect(entry?.staleReasons).toEqual([]);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("listWorktrees flags an archived worktree as stale \"archived\"", async () => {
  const { createTask, listWorktrees } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { db, tasks } = await import("./db.ts");

  const repo = await makeRepo();
  const created = await createTask({
    title: "archived worktree",
    prompt: "p",
    agent: "claude-code",
    workdir: repo,
    isolation: "worktree",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  try {
    const prepared = await prepareWorkdir(created.task);
    if ("error" in prepared) throw new Error(prepared.error);
    tasks.update(taskId, { branch: prepared.branch, worktreePath: prepared.worktreePath });
    tasks.update(taskId, { column: "done" });

    // Stamp archivedAt directly (bypassing archiveTask, and therefore its
    // deferred teardown) so the dir is guaranteed still present when
    // listWorktrees runs — avoids racing the real teardown job.
    tasks.update(taskId, { archivedAt: Date.now() });
    expect(existsSync(prepared.worktreePath!)).toBe(true);

    const entries = listWorktrees();
    const entry = entries.find((e) => e.id === taskId);
    expect(entry).toBeDefined();
    expect(entry?.stale).toBe(true);
    expect(entry?.staleReasons).toContain("archived");
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("listWorktrees flags an idle worktree as \"inactive\"", async () => {
  const { createTask, listWorktrees } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { db, tasks } = await import("./db.ts");
  const { WORKTREE_STALE_AFTER_MS } = await import("../shared/types.ts");

  const repo = await makeRepo();
  const created = await createTask({
    title: "inactive worktree",
    prompt: "p",
    agent: "claude-code",
    workdir: repo,
    isolation: "worktree",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  try {
    const prepared = await prepareWorkdir(created.task);
    if ("error" in prepared) throw new Error(prepared.error);
    tasks.update(taskId, { branch: prepared.branch, worktreePath: prepared.worktreePath });

    // Confirm the not-archived, no-run precondition holds before pushing
    // updatedAt back in time.
    const before = tasks.get(taskId);
    expect(before?.archivedAt).toBeNull();
    expect(before?.runId).toBeNull();

    // tasks.update() force-overwrites updatedAt to Date.now() on every call
    // (see db.ts), so we can't set an old updatedAt through it — write the
    // row directly instead.
    const oldTs = Date.now() - WORKTREE_STALE_AFTER_MS - 1000;
    db.run(`UPDATE tasks SET updated_at = ? WHERE id = ?`, [oldTs, taskId]);

    const entries = listWorktrees();
    const entry = entries.find((e) => e.id === taskId);
    expect(entry).toBeDefined();
    expect(entry?.stale).toBe(true);
    expect(entry?.staleReasons).toContain("inactive");
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("does not flag a worktree inactive while a background agent is still running", async () => {
  const { createTask, listWorktrees } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { db, tasks, subagents } = await import("./db.ts");
  const { WORKTREE_STALE_AFTER_MS } = await import("../shared/types.ts");

  const repo = await makeRepo();
  const created = await createTask({
    title: "held by background agent",
    prompt: "p",
    agent: "claude-code",
    workdir: repo,
    isolation: "worktree",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  try {
    const prepared = await prepareWorkdir(created.task);
    if ("error" in prepared) throw new Error(prepared.error);
    tasks.update(taskId, { branch: prepared.branch, worktreePath: prepared.worktreePath });

    // Same back-dating trick as the "inactive" test above — push updatedAt
    // past the staleness threshold via raw SQL (tasks.update() would
    // force-overwrite it back to now).
    const oldTs = Date.now() - WORKTREE_STALE_AFTER_MS - 1000;
    db.run(`UPDATE tasks SET updated_at = ? WHERE id = ?`, [oldTs, taskId]);

    const agentId = `held-${randomUUID()}`;
    subagents.insertIfAbsent({
      id: agentId,
      taskId,
      runId: null, // the gate keys off task_id, not run_id
      parentKind: "subagent",
      agentType: "Explore",
      description: "still working",
      spawnDepth: 1,
      sourcePath: `/tmp/agent-${agentId}.jsonl`,
      status: "running",
      startedAt: Date.now(),
      endedAt: null,
    });

    const held = listWorktrees().find((e) => e.id === taskId);
    expect(held).toBeDefined();
    expect(held?.staleReasons).not.toContain("inactive");
    expect(held?.heldByBackgroundAgents).toBe(true);

    // Settle the row — the age condition is already satisfied, so the very
    // next listWorktrees() call should now report "inactive".
    subagents.setStatus(agentId, "completed", Date.now());

    const settled = listWorktrees().find((e) => e.id === taskId);
    expect(settled).toBeDefined();
    expect(settled?.staleReasons).toContain("inactive");
    expect(settled?.heldByBackgroundAgents).toBe(false);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("does not flag a worktree inactive while a workflow container row is running", async () => {
  // Proves the guard is kind-agnostic: a 'workflow' container row (holds a
  // task in `running` for the lifetime of a Claude Code Workflow run) must
  // suppress "inactive" exactly like an ordinary 'subagent' row does.
  const { createTask, listWorktrees } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { db, tasks, subagents } = await import("./db.ts");
  const { WORKTREE_STALE_AFTER_MS } = await import("../shared/types.ts");

  const repo = await makeRepo();
  const created = await createTask({
    title: "held by workflow container",
    prompt: "p",
    agent: "claude-code",
    workdir: repo,
    isolation: "worktree",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  try {
    const prepared = await prepareWorkdir(created.task);
    if ("error" in prepared) throw new Error(prepared.error);
    tasks.update(taskId, { branch: prepared.branch, worktreePath: prepared.worktreePath });

    const oldTs = Date.now() - WORKTREE_STALE_AFTER_MS - 1000;
    db.run(`UPDATE tasks SET updated_at = ? WHERE id = ?`, [oldTs, taskId]);

    const agentId = `workflow-${randomUUID()}`;
    subagents.insertIfAbsent({
      id: agentId,
      taskId,
      runId: null,
      parentKind: "workflow",
      agentType: null,
      description: "workflow container",
      spawnDepth: 1,
      sourcePath: `/tmp/workflow-${agentId}`,
      status: "running",
      startedAt: Date.now(),
      endedAt: null,
    });

    const held = listWorktrees().find((e) => e.id === taskId);
    expect(held).toBeDefined();
    expect(held?.staleReasons).not.toContain("inactive");
    expect(held?.heldByBackgroundAgents).toBe(true);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("listWorktrees flags an orphan dir (no task row) as \"orphaned\"", async () => {
  const { listWorktrees } = await import("./orchestrator.ts");
  const { WORKTREES_DIR } = await import("./worktree.ts");
  const { rmSync } = await import("node:fs");

  const orphanId = `orphan-${randomUUID()}`;
  const orphanDir = path.join(WORKTREES_DIR, orphanId);
  mkdirSync(orphanDir, { recursive: true });

  try {
    const entries = listWorktrees();
    const entry = entries.find((e) => e.id === orphanId);
    expect(entry).toBeDefined();
    expect(entry?.taskId).toBeNull();
    expect(entry?.stale).toBe(true);
    expect(entry?.staleReasons).toContain("orphaned");
    expect(entry?.heldByBackgroundAgents).toBe(false);
  } finally {
    rmSync(orphanDir, { recursive: true, force: true });
  }
});

test("archiveTask force bypasses the done-only column gate", async () => {
  const { createTask, archiveTask, pendingTeardown } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { db, tasks } = await import("./db.ts");

  const repo = await makeRepo();
  const created = await createTask({
    title: "force archive from non-done",
    prompt: "p",
    agent: "claude-code",
    workdir: repo,
    isolation: "worktree",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  try {
    const prepared = await prepareWorkdir(created.task);
    if ("error" in prepared) throw new Error(prepared.error);
    tasks.update(taskId, { branch: prepared.branch, worktreePath: prepared.worktreePath });
    tasks.update(taskId, { column: "ready" });

    const withoutForce = await archiveTask(taskId);
    expect("error" in withoutForce).toBe(true);
    if ("error" in withoutForce) {
      expect(withoutForce.error).toMatch(/done/i);
    }

    const withForce = await archiveTask(taskId, { force: true });
    expect("task" in withForce).toBe(true);
    if (!("task" in withForce)) throw new Error(withForce.error);
    expect(withForce.task.archivedAt).not.toBeNull();
  } finally {
    await pendingTeardown(taskId);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("archiveTask force still rejects an active run", async () => {
  // The active-run guard in archiveTask runs unconditionally, before the
  // `opts?.force` column-gate bypass is even consulted — force only waives
  // the done-only column check, never the "don't kill tmux out from under a
  // live run" defence. Verified here against a REAL in-flight run (via the
  // fake claude driver), following the same timing-sensitive pattern
  // orchestrator.test.ts uses ("sendInput folds a follow-up into the
  // in-flight run..."): startTask must be immediately followed (no awaited
  // work in between) by the assertion, before the fake driver's ~20ms `done`
  // timer resolves the turn and removes the run from `active`.
  const { createTask, startTask, archiveTask, pendingTeardown } = await import("./orchestrator.ts");
  const { db, tasks } = await import("./db.ts");

  const repo = await makeRepo();
  const created = await createTask({
    title: "force vs active run",
    prompt: "p",
    agent: "claude-code",
    workdir: repo,
    isolation: "worktree",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  try {
    const started = await startTask(taskId);
    expect("runId" in started).toBe(true);
    if (!("runId" in started)) throw new Error("expected the run to start");

    // No await between startTask resolving and this call — the run must
    // still be in `active` right now.
    const rejected = await archiveTask(taskId, { force: true });
    expect("error" in rejected).toBe(true);
    if ("error" in rejected) {
      expect(rejected.error).toMatch(/running/i);
    }

    // Let the fake turn resolve so the task settles before cleanup.
    await new Promise((r) => setTimeout(r, 250));
    expect(tasks.get(taskId)?.runId).toBeTruthy();
  } finally {
    await pendingTeardown(taskId);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("deleteOrphanWorktree happy path removes the directory", async () => {
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

test("deleteOrphanWorktree refuses a live task id", async () => {
  const { createTask, deleteTask, deleteOrphanWorktree } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { tasks } = await import("./db.ts");

  const repo = await makeRepo();
  const created = await createTask({
    title: "owned worktree",
    prompt: "p",
    agent: "claude-code",
    workdir: repo,
    isolation: "worktree",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  try {
    const prepared = await prepareWorkdir(created.task);
    if ("error" in prepared) throw new Error(prepared.error);
    tasks.update(taskId, { branch: prepared.branch, worktreePath: prepared.worktreePath });

    const worktreePath = prepared.worktreePath!;
    expect(existsSync(worktreePath)).toBe(true);

    const result = await deleteOrphanWorktree(taskId);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/archiv/i);
    }
    expect(existsSync(worktreePath)).toBe(true);
  } finally {
    // Normal task deletion path (not deleteOrphanWorktree) for cleanup.
    await deleteTask(taskId);
  }
});

test("deleteOrphanWorktree confines deletions to a direct child of WORKTREES_DIR", async () => {
  const { deleteOrphanWorktree } = await import("./orchestrator.ts");
  const { WORKTREES_DIR } = await import("./worktree.ts");
  const { rmSync } = await import("node:fs");

  // Sentinel dir under WORKTREES_DIR — this is what makes the "." case a
  // meaningful regression guard: if deleteOrphanWorktree(".") ever resolved
  // to WORKTREES_DIR itself and rm -rf'd it, this sentinel (and every other
  // task's worktree) would vanish too.
  const sentinelId = `sentinel-${randomUUID()}`;
  const sentinelDir = path.join(WORKTREES_DIR, sentinelId);
  mkdirSync(sentinelDir, { recursive: true });

  try {
    for (const badId of ["..", "a/b", ".", ""]) {
      const result = await deleteOrphanWorktree(badId);
      expect("error" in result).toBe(true);
    }
    expect(existsSync(sentinelDir)).toBe(true);
    expect(existsSync(WORKTREES_DIR)).toBe(true);
  } finally {
    rmSync(sentinelDir, { recursive: true, force: true });
  }
});

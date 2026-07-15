import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
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
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-archive-teardown-repo-"));
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), "hi\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  return repo;
}

test("archiveTask defers teardown: dir survives until pendingTeardown resolves, then the worktree is gone and branch + DB pointers remain", async () => {
  const { createTask, archiveTask, pendingTeardown } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { db, tasks } = await import("./db.ts");

  const repo = await makeRepo();
  const created = await createTask({
    title: "deferred detach",
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

    const worktreePath = prepared.worktreePath!;
    const branch = prepared.branch!;
    expect(existsSync(worktreePath)).toBe(true);

    const archived = await archiveTask(taskId);
    expect("task" in archived).toBe(true);
    if (!("task" in archived)) throw new Error(archived.error);
    expect(archived.task.archivedAt).not.toBeNull();

    await pendingTeardown(taskId);

    // Checkout gone from disk…
    expect(existsSync(worktreePath)).toBe(false);

    // …but the branch survives in the source repo.
    const proc = Bun.spawn(["git", "branch", "--list", branch], { cwd: repo, stdout: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    expect(out).toContain(branch);

    // The DB row keeps worktreePath/branch non-null.
    const after = tasks.get(taskId);
    expect(after?.worktreePath).toBe(worktreePath);
    expect(after?.branch).toBe(branch);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("archiveTask responds before teardown runs — the worktree is (usually) still on disk immediately after archiveTask resolves", async () => {
  const { createTask, archiveTask, pendingTeardown } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { db, tasks } = await import("./db.ts");

  const repo = await makeRepo();
  const created = await createTask({
    title: "immediate response",
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

    const worktreePath = prepared.worktreePath!;
    expect(existsSync(worktreePath)).toBe(true);

    const archived = await archiveTask(taskId);
    expect("task" in archived).toBe(true);

    // detachWorktree's first step (`git status`) yields the event loop before
    // it gets to removing the checkout, so — most of the time — the dir is
    // still present the instant archiveTask resolves. This is inherently a
    // timing assertion; if it ever flakes, the fallback signal is that
    // `pendingTeardown(taskId)` has not yet settled (there IS a teardown in
    // flight for this task right now).
    const stillHasDirImmediately = existsSync(worktreePath);
    let settledImmediately = false;
    pendingTeardown(taskId).then(() => {
      settledImmediately = true;
    });
    // Give queued microtasks (but not the deferred job's own awaits) a chance
    // to run without letting the teardown's internal awaits resolve.
    await Promise.resolve();
    expect(stillHasDirImmediately || !settledImmediately).toBe(true);

    await pendingTeardown(taskId);
    expect(existsSync(worktreePath)).toBe(false);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("unarchiveTask right after archiveTask waits out the deferred teardown then restores the worktree", async () => {
  const { createTask, archiveTask, unarchiveTask } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { db, tasks } = await import("./db.ts");

  const repo = await makeRepo();
  const created = await createTask({
    title: "archive-unarchive race",
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

    const worktreePath = prepared.worktreePath!;

    const archived = await archiveTask(taskId);
    if (!("task" in archived)) throw new Error(archived.error);

    // No manual pendingTeardown await here — unarchiveTask must serialize
    // against the still-in-flight (or about-to-run) archive teardown itself.
    const restored = await unarchiveTask(taskId);
    expect("task" in restored).toBe(true);
    if (!("task" in restored)) throw new Error(restored.error);
    expect(restored.task.archivedAt).toBeNull();
    expect(existsSync(worktreePath)).toBe(true);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("back-to-back archives against the same source repo both respond fast and both fully tear down", async () => {
  const { createTask, archiveTask, pendingTeardown } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { db, tasks } = await import("./db.ts");

  const repo = await makeRepo();

  const createdA = await createTask({
    title: "back-to-back A",
    prompt: "p",
    agent: "claude-code",
    workdir: repo,
    isolation: "worktree",
  });
  if ("error" in createdA) throw new Error(createdA.error);
  const idA = createdA.task.id;

  const createdB = await createTask({
    title: "back-to-back B",
    prompt: "p",
    agent: "claude-code",
    workdir: repo,
    isolation: "worktree",
  });
  if ("error" in createdB) throw new Error(createdB.error);
  const idB = createdB.task.id;

  try {
    const preparedA = await prepareWorkdir(createdA.task);
    if ("error" in preparedA) throw new Error(preparedA.error);
    tasks.update(idA, { branch: preparedA.branch, worktreePath: preparedA.worktreePath });
    tasks.update(idA, { column: "done" });

    const preparedB = await prepareWorkdir(createdB.task);
    if ("error" in preparedB) throw new Error(preparedB.error);
    tasks.update(idB, { branch: preparedB.branch, worktreePath: preparedB.worktreePath });
    tasks.update(idB, { column: "done" });

    const worktreePathA = preparedA.worktreePath!;
    const worktreePathB = preparedB.worktreePath!;
    const branchA = preparedA.branch!;
    const branchB = preparedB.branch!;

    // No teardown awaits in between — both archives must return fast without
    // blocking on each other's `git worktree remove`/`prune`.
    const archivedA = await archiveTask(idA);
    const archivedB = await archiveTask(idB);
    expect("task" in archivedA).toBe(true);
    expect("task" in archivedB).toBe(true);

    await pendingTeardown(idA);
    await pendingTeardown(idB);

    expect(existsSync(worktreePathA)).toBe(false);
    expect(existsSync(worktreePathB)).toBe(false);

    const proc = Bun.spawn(["git", "branch", "--list"], { cwd: repo, stdout: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    expect(out).toContain(branchA);
    expect(out).toContain(branchB);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [idA]);
    db.run(`DELETE FROM tasks WHERE id = ?`, [idB]);
  }
});

test("sweepArchivedTeardowns enqueues teardown for a task stranded archived-with-worktree-on-disk (simulated crash-before-teardown)", async () => {
  const { createTask, pendingTeardown, sweepArchivedTeardowns } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { db, tasks } = await import("./db.ts");

  const repo = await makeRepo();
  const created = await createTask({
    title: "boot sweep",
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

    const worktreePath = prepared.worktreePath!;
    expect(existsSync(worktreePath)).toBe(true);

    // Simulate "quit before teardown ran": stamp archivedAt directly,
    // bypassing archiveTask (and therefore bypassing enqueueTeardown too) —
    // this is what a crash between the DB flip and the deferred job actually
    // running would leave behind on the next boot.
    tasks.update(taskId, { archivedAt: Date.now() });
    expect(existsSync(worktreePath)).toBe(true);

    const enqueued = sweepArchivedTeardowns();
    expect(enqueued).toBeGreaterThanOrEqual(1);

    await pendingTeardown(taskId);
    expect(existsSync(worktreePath)).toBe(false);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("FIFO ordering: pendingTeardown(b) resolving implies a's teardown (enqueued first) has already completed", async () => {
  // Documents (and relies on) the teardown queue being a per-workdir FIFO
  // chain, per enqueueTeardown's contract in orchestrator.ts. Both tasks here
  // are created against the SAME source repo (`repo`, one `makeRepo()` call),
  // so they share one chain keyed on that workdir — b's job cannot run
  // before a's has settled. Two tasks in different source repos would get
  // independent chains with no ordering guarantee between them (see the
  // "independent workdirs" test below).
  const { createTask, archiveTask, pendingTeardown } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { db, tasks } = await import("./db.ts");

  const repo = await makeRepo();

  const createdA = await createTask({
    title: "fifo A",
    prompt: "p",
    agent: "claude-code",
    workdir: repo,
    isolation: "worktree",
  });
  if ("error" in createdA) throw new Error(createdA.error);
  const idA = createdA.task.id;

  const createdB = await createTask({
    title: "fifo B",
    prompt: "p",
    agent: "claude-code",
    workdir: repo,
    isolation: "worktree",
  });
  if ("error" in createdB) throw new Error(createdB.error);
  const idB = createdB.task.id;

  try {
    const preparedA = await prepareWorkdir(createdA.task);
    if ("error" in preparedA) throw new Error(preparedA.error);
    tasks.update(idA, { branch: preparedA.branch, worktreePath: preparedA.worktreePath });
    tasks.update(idA, { column: "done" });

    const preparedB = await prepareWorkdir(createdB.task);
    if ("error" in preparedB) throw new Error(preparedB.error);
    tasks.update(idB, { branch: preparedB.branch, worktreePath: preparedB.worktreePath });
    tasks.update(idB, { column: "done" });

    const worktreePathA = preparedA.worktreePath!;

    await archiveTask(idA);
    await archiveTask(idB);

    // Await only b's teardown — a's must already be done, since both jobs
    // share the same FIFO chain and a was enqueued first.
    await pendingTeardown(idB);
    expect(existsSync(worktreePathA)).toBe(false);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [idA]);
    db.run(`DELETE FROM tasks WHERE id = ?`, [idB]);
  }
});

test("independent workdirs: teardowns for two tasks in different source repos don't share a chain and both complete", async () => {
  // Unlike the FIFO test above (same repo → same chain), these two tasks are
  // each created against their OWN temp source repo, so they key into
  // separate `teardownTails` entries and their teardowns run on independent
  // chains. This is the fix for the global-FIFO regression: a big teardown
  // backlog in one repo must never stall a delete/archive in an unrelated
  // repo. Awaiting both `pendingTeardown`s and asserting both dirs are gone
  // proves the two chains don't interfere with (or depend on) each other.
  const { createTask, archiveTask, pendingTeardown } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { db, tasks } = await import("./db.ts");

  const repoA = await makeRepo();
  const repoB = await makeRepo();

  const createdA = await createTask({
    title: "independent workdir A",
    prompt: "p",
    agent: "claude-code",
    workdir: repoA,
    isolation: "worktree",
  });
  if ("error" in createdA) throw new Error(createdA.error);
  const idA = createdA.task.id;

  const createdB = await createTask({
    title: "independent workdir B",
    prompt: "p",
    agent: "claude-code",
    workdir: repoB,
    isolation: "worktree",
  });
  if ("error" in createdB) throw new Error(createdB.error);
  const idB = createdB.task.id;

  try {
    const preparedA = await prepareWorkdir(createdA.task);
    if ("error" in preparedA) throw new Error(preparedA.error);
    tasks.update(idA, { branch: preparedA.branch, worktreePath: preparedA.worktreePath });
    tasks.update(idA, { column: "done" });

    const preparedB = await prepareWorkdir(createdB.task);
    if ("error" in preparedB) throw new Error(preparedB.error);
    tasks.update(idB, { branch: preparedB.branch, worktreePath: preparedB.worktreePath });
    tasks.update(idB, { column: "done" });

    const worktreePathA = preparedA.worktreePath!;
    const worktreePathB = preparedB.worktreePath!;

    const archivedA = await archiveTask(idA);
    const archivedB = await archiveTask(idB);
    expect("task" in archivedA).toBe(true);
    expect("task" in archivedB).toBe(true);

    await pendingTeardown(idA);
    await pendingTeardown(idB);

    expect(existsSync(worktreePathA)).toBe(false);
    expect(existsSync(worktreePathB)).toBe(false);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [idA]);
    db.run(`DELETE FROM tasks WHERE id = ?`, [idB]);
  }
});

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import — `beforeAll`
// would race with any sibling test file that already imported db.ts.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-test-"));
// Drive claude through an in-process fake instead of tmux + the real CLI.
// The fake emits a canned response and resolves end_turn so the orchestrator's
// post-run handler fires. AGETOR_CLAUDE_BIN is also overridden so the
// agent-status preflight inside startTask passes without claude installed.
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo"; // tmux probe in agent-status passes
process.env.AGETOR_CLAUDE_ARGS = "";

// Standalone helper: run git in a directory (mirrors worktree.test.ts's
// `git` helper — kept local here since this file owns no shared test util).
async function git(args: string[], cwd: string) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

// Standalone helper: a real temp git repo for worktree-isolation tests. Never
// point a task at a real repo in these tests — always mkdtemp (see worktree
// isolation warning in CLAUDE.md).
async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-orch-repo-"));
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), "hi\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  return repo;
}

test("startTask refuses to run when the harness is disabled", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { db, harnesses } = await import("./db.ts");

  const created = await createTask({
    title: "should not run",
    prompt: "noop",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);

  harnesses.setEnabled("claude-code", false);
  try {
    const res = await startTask(created.task.id);
    expect("error" in res).toBe(true);
    if ("error" in res) {
      expect(res.error).toMatch(/disabled/i);
    }
  } finally {
    // Re-enable the harness and drop the orphan task so the surviving tests
    // in this file (which share the process-level DB) keep working without
    // leftover rows in their way.
    harnesses.setEnabled("claude-code", true);
    db.run(`DELETE FROM tasks WHERE id = ?`, [created.task.id]);
  }
});

test("createTask + startTask runs to completion and emits stdout", async () => {
  const { createTask, startTask, subscribe } = await import("./orchestrator.ts");

  const created = await createTask({
    title: "echo hello",
    prompt: "hello world",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none", // don't materialize a worktree off the live repo during tests
  });
  if ("error" in created) throw new Error(created.error);
  const task = created.task;

  const out: string[] = [];
  const statuses: string[] = [];
  const unsub = subscribe((e) => {
    if (e.stream === "stdout") out.push(e.data);
    if (e.stream === "status") statuses.push(e.data);
  });

  const res = await startTask(task.id);
  expect("runId" in res).toBe(true);

  // Wait briefly for the fake driver to emit + the post-run hook to run.
  await new Promise((r) => setTimeout(r, 250));
  unsub();

  // Fake driver echoes the prompt back via stdout, then emits a status.
  expect(out.join("")).toContain("hello world");
  expect(statuses.some((s) => s.startsWith("exit:"))).toBe(true);
});

test("task.runId survives the resolve-to-review transition (so a question raised in review can still register)", async () => {
  // Regression guard for the post-review AskUserQuestion fix: the scraper's
  // collectAndRegisterAskCard (claude-tmux.ts) bails with `if (!runId) return`,
  // so if the review transition cleared task.runId, a question raised after the
  // turn resolved would never register — the exact symptom we just fixed. The
  // updateColumn path must leave run_id intact (only reconcileOrphans / delete
  // clear it).
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { db, tasks } = await import("./db.ts");

  const created = await createTask({
    title: "runId survives review",
    prompt: "hello",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  const task = created.task;

  const res = await startTask(task.id);
  if (!("runId" in res)) throw new Error("expected the run to start");
  const runId = res.runId;

  // Let the fake driver resolve the turn (exit 0 → succeeded → review).
  await new Promise((r) => setTimeout(r, 250));

  const after = tasks.get(task.id);
  expect(after?.column).toBe("review");
  expect(after?.runId).toBe(runId);

  db.run(`DELETE FROM tasks WHERE id = ?`, [task.id]);
});

test("sendInput folds a follow-up into the in-flight run instead of stranding a new one", async () => {
  // Regression for the "queue status never recovers" bug: a message sent
  // while a claude turn is in flight must fold into the active run (same
  // runId, no new row), not spawn a second run row + turn slot that could
  // strand in "running" when claude coalesces queued messages.
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { db, runs } = await import("./db.ts");
  const claudeTmux = await import("./claude-tmux.ts");

  const created = await createTask({
    title: "fold-while-busy",
    prompt: "first message",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  const task = created.task;

  const res = await startTask(task.id);
  expect("runId" in res).toBe(true);
  if (!("runId" in res)) return;
  const r1 = res.runId;

  // The fake claude driver doesn't create a tmux session, so stand one up so
  // `sendClaudeTurn` takes the existing-session (fold-capable) path. The fake
  // run R1 stays in flight (`active`) for ~20ms — long enough to send into it.
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-fold-"));
  const jsonlPath = path.join(dir, `${randomUUID()}.jsonl`);
  writeFileSync(jsonlPath, "");
  claudeTmux.__forTest.installSession(task.id, jsonlPath);
  try {
    // TIMING INVARIANT: `sendInput` must run synchronously here, before the
    // fake driver's ~20ms `done` timer resolves R1 (after which `active` no
    // longer has it and the call would take the idle path → a NEW run row).
    // There must be no `await` between `await startTask(...)` above and this
    // call. If a future edit introduces one and the window is missed, the
    // `rows.length === 1` assertion below fails loudly rather than silently
    // passing for the wrong reason.
    // R1 is still in flight → this must fold into it.
    const sent = await sendInput(r1, "second message while busy");
    expect(sent.delivered).toBe(true);
    if (sent.delivered) expect(sent.runId).toBe(r1);

    // No second run row was created — the task still has exactly one run.
    const rows = runs.listForTask(task.id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(r1);

    // The folded user message was recorded on the active run so it shows in
    // the conversation stream.
    const events = runs.eventsForTask(task.id);
    expect(events.some((e) => e.stream === "user" && e.data.includes("second message while busy"))).toBe(true);

    // Let R1's fake turn resolve, then confirm the task recovered out of
    // "running" (no stranding) and still has just the one run row.
    await new Promise((r) => setTimeout(r, 120));
    const { tasks } = await import("./db.ts");
    expect(tasks.get(task.id)?.column).not.toBe("running");
    expect(runs.listForTask(task.id).length).toBe(1);
  } finally {
    claudeTmux.__forTest.uninstallSession(task.id);
    db.run(`DELETE FROM tasks WHERE id = ?`, [task.id]);
  }
});

test("archiveTask refuses tasks that aren't in the Done column", async () => {
  const { createTask, archiveTask } = await import("./orchestrator.ts");
  const { db } = await import("./db.ts");

  const created = await createTask({
    title: "not done yet",
    prompt: "p",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  try {
    const res = await archiveTask(created.task.id);
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/done/i);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [created.task.id]);
  }
});

test("archiveTask stamps archivedAt and unarchiveTask clears it", async () => {
  const { createTask, archiveTask, unarchiveTask } = await import("./orchestrator.ts");
  const { db, tasks } = await import("./db.ts");

  const created = await createTask({
    title: "wind-down",
    prompt: "p",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  // Move to Done so archive is allowed. updateColumn is internal, but the
  // PATCH allow-list lets `column` through — use tasks.update directly here
  // to keep the test focused on archive semantics.
  tasks.update(created.task.id, { column: "done" });
  try {
    const before = tasks.get(created.task.id);
    expect(before?.archivedAt).toBeNull();

    const archived = await archiveTask(created.task.id);
    expect("task" in archived).toBe(true);
    if ("task" in archived) {
      expect(archived.task.archivedAt).not.toBeNull();
      expect(typeof archived.task.archivedAt).toBe("number");
    }

    // Idempotent: archiving twice is a no-op success.
    const archivedAgain = await archiveTask(created.task.id);
    expect("task" in archivedAgain).toBe(true);

    const restored = await unarchiveTask(created.task.id);
    expect("task" in restored).toBe(true);
    if ("task" in restored) {
      expect(restored.task.archivedAt).toBeNull();
    }
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [created.task.id]);
  }
});

test("archiveTask detaches the worktree from disk but keeps branch + DB pointers", async () => {
  const { createTask, archiveTask, pendingTeardown } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { db, tasks } = await import("./db.ts");

  const repo = await makeRepo();
  const created = await createTask({
    title: "archive detaches worktree",
    prompt: "p",
    agent: "claude-code",
    workdir: repo,
    isolation: "worktree",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  try {
    // Materialize the worktree directly (mirrors what startTask does) without
    // spawning an agent — this test is about archive's disk bookkeeping, not
    // the run lifecycle.
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

    // Teardown (session drop, terminal kill, worktree detach) is deferred onto
    // the global FIFO queue rather than run synchronously — wait it out before
    // asserting on-disk state.
    await pendingTeardown(taskId);

    // Checkout gone from disk…
    expect(existsSync(worktreePath)).toBe(false);

    // …but the branch (and its commits) survive in the source repo.
    const proc = Bun.spawn(["git", "branch", "--list", branch], { cwd: repo, stdout: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    expect(out).toContain(branch);

    // The DB row keeps worktreePath/branch non-null — required for the JSONL
    // path encoding and the re-attach key `prepareWorkdir` uses on restore.
    const after = tasks.get(taskId);
    expect(after?.worktreePath).toBe(worktreePath);
    expect(after?.branch).toBe(branch);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("archiveTask keeps a dirty worktree on disk instead of discarding uncommitted work", async () => {
  const { createTask, archiveTask } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { db, tasks } = await import("./db.ts");

  const repo = await makeRepo();
  const created = await createTask({
    title: "archive skips dirty worktree",
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
    // Uncommitted change — `git worktree remove --force` would otherwise
    // silently destroy it, so detach must skip removal.
    writeFileSync(path.join(worktreePath, "uncommitted.txt"), "work in progress\n");

    const archived = await archiveTask(taskId);
    expect("task" in archived).toBe(true);
    if (!("task" in archived)) throw new Error(archived.error);
    expect(archived.task.archivedAt).not.toBeNull();

    // Dirty-skip: the checkout stays on disk.
    expect(existsSync(worktreePath)).toBe(true);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("unarchiveTask rematerializes a worktree that archive detached", async () => {
  const { createTask, archiveTask, unarchiveTask, pendingTeardown } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { db, tasks } = await import("./db.ts");

  const repo = await makeRepo();
  const created = await createTask({
    title: "unarchive restores worktree",
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
    // Teardown is deferred onto the global FIFO queue — wait it out before
    // asserting the checkout is gone.
    await pendingTeardown(taskId);
    expect(existsSync(worktreePath)).toBe(false);

    const restored = await unarchiveTask(taskId);
    expect("task" in restored).toBe(true);
    if (!("task" in restored)) throw new Error(restored.error);
    expect(restored.task.archivedAt).toBeNull();
    // Eager best-effort restore rematerializes at the same deterministic path.
    expect(existsSync(worktreePath)).toBe(true);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("sendInput to an archived task auto-unarchives it and restores the worktree", async () => {
  const { createTask, archiveTask, sendInput, pendingTeardown } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { db, tasks, runs } = await import("./db.ts");

  const repo = await makeRepo();
  const created = await createTask({
    title: "sendInput restores archived worktree",
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

    // Seed a run row directly (mirrors how the orchestrator's own resume
    // paths insert one) so sendInput has a runId to resolve back to this
    // task, without needing a live worktree to go through startTask first —
    // that worktree is exactly what we're about to detach via archiveTask.
    const runId = randomUUID();
    runs.insert({
      id: runId,
      taskId,
      agent: "claude-code",
      status: "succeeded",
      startedAt: Date.now(),
      endedAt: Date.now(),
      exitCode: 0,
      tmuxSession: null,
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null, geminiSessionId: null,
    });

    const archived = await archiveTask(taskId);
    if (!("task" in archived)) throw new Error(archived.error);
    // Teardown is deferred onto the global FIFO queue — wait it out before
    // asserting the checkout is gone.
    await pendingTeardown(taskId);
    expect(existsSync(worktreePath)).toBe(false);

    // sendInput must (1) auto-unarchive, (2) restore the worktree via
    // prepareWorkdir's re-attach path, THEN (3) dispatch to the fake claude
    // driver — which doesn't touch cwd at all, so this exercises steps 1-2
    // regardless of the driver's own behavior.
    const sent = await sendInput(runId, "hello");
    expect(sent.delivered).toBe(true);

    const after = tasks.get(taskId);
    expect(after?.archivedAt).toBeNull();
    expect(existsSync(worktreePath)).toBe(true);

    // Let the fake driver's turn resolve so its ~20ms timer doesn't fire
    // after this test's cleanup deletes the task row.
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("startTask auto-unarchives an archived task before running it", async () => {
  const { createTask, archiveTask, startTask } = await import("./orchestrator.ts");
  const { db, tasks } = await import("./db.ts");

  const created = await createTask({
    title: "startTask auto-unarchives",
    prompt: "hello",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  tasks.update(taskId, { column: "done" });

  try {
    const archived = await archiveTask(taskId);
    expect("task" in archived).toBe(true);
    if (!("task" in archived)) throw new Error(archived.error);
    expect(archived.task.archivedAt).not.toBeNull();

    const res = await startTask(taskId);
    expect("runId" in res).toBe(true);

    const after = tasks.get(taskId);
    expect(after?.archivedAt).toBeNull();

    // Let the fake driver resolve the turn before cleanup deletes the row.
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

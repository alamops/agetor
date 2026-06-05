import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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
    const sent = sendInput(r1, "second message while busy");
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
    const res = archiveTask(created.task.id);
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

    const archived = archiveTask(created.task.id);
    expect("task" in archived).toBe(true);
    if ("task" in archived) {
      expect(archived.task.archivedAt).not.toBeNull();
      expect(typeof archived.task.archivedAt).toBe("number");
    }

    // Idempotent: archiving twice is a no-op success.
    const archivedAgain = archiveTask(created.task.id);
    expect("task" in archivedAgain).toBe(true);

    const restored = unarchiveTask(created.task.id);
    expect("task" in restored).toBe(true);
    if ("task" in restored) {
      expect(restored.task.archivedAt).toBeNull();
    }
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [created.task.id]);
  }
});

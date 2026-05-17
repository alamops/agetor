import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

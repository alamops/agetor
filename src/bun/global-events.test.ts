import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-global-events-"));
// Same fake-claude harness orchestrator.test.ts uses — keeps the test
// hermetic (no real tmux, no real CLI).
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";

import type { GlobalEvent } from "../shared/types.ts";

test("startTask emits column → running and run-status → succeeded", async () => {
  const { createTask, startTask, subscribeGlobal } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  const created = await createTask({
    title: "global-events: success",
    prompt: "hello",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);

  const events: GlobalEvent[] = [];
  const unsub = subscribeGlobal((e) => {
    if (e.kind !== "update" && e.taskId === created.task.id) events.push(e);
  });

  const res = await startTask(created.task.id);
  expect("runId" in res).toBe(true);

  await new Promise((r) => setTimeout(r, 250));
  unsub();

  // Expect at least: column → running (prev backlog) AND run-status terminal.
  const colRunning = events.find(
    (e) => e.kind === "column" && e.column === "running",
  );
  expect(colRunning).toBeDefined();
  if (colRunning?.kind === "column") {
    expect(colRunning.prev).toBe("backlog");
  }

  const terminal = events.find((e) => e.kind === "run-status");
  expect(terminal).toBeDefined();
  if (terminal?.kind === "run-status") {
    // Fake driver exits cleanly → succeeded.
    expect(terminal.status).toBe("succeeded");
    expect(terminal.taskId).toBe(created.task.id);
  }

  // A column → review transition should also have been emitted with prev=running.
  const colReview = events.find(
    (e) => e.kind === "column" && e.column === "review",
  );
  expect(colReview).toBeDefined();
  if (colReview?.kind === "column") {
    expect(colReview.prev).toBe("running");
  }

  // Cleanup — per the project's test-cleanup convention. Avoids leaking
  // rows into reconcile / list tests that run later in the same process.
  tasks.delete(created.task.id);
});

test("reconcileOrphans emits run-status → orphaned + column → ready", async () => {
  const { createTask, subscribeGlobal, reconcileOrphans } = await import("./orchestrator.ts");
  const { tasks, runs, db } = await import("./db.ts");

  const created = await createTask({
    title: "global-events: orphan",
    prompt: "fake",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  // Simulate the "agetor crashed mid-run" state: a stale running run + the
  // task pinned in column=running. reconcileOrphans is what fixes this on
  // next boot.
  const runId = "orphan-" + taskId.slice(0, 6);
  runs.insert({
    id: runId,
    taskId,
    agent: "claude-code",
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    tmuxSession: null,
    claudeSessionId: null,
  });
  db.run(`UPDATE tasks SET "column" = 'running', run_id = ? WHERE id = ?`, [runId, taskId]);

  const events: GlobalEvent[] = [];
  const unsub = subscribeGlobal((e) => {
    if (e.kind !== "update" && e.taskId === taskId) events.push(e);
  });

  reconcileOrphans();
  unsub();

  const orphan = events.find(
    (e) => e.kind === "run-status" && e.status === "orphaned",
  );
  expect(orphan).toBeDefined();
  const ready = events.find(
    (e) => e.kind === "column" && e.column === "ready",
  );
  expect(ready).toBeDefined();
  if (ready?.kind === "column") expect(ready.prev).toBe("running");

  tasks.delete(taskId);
});

import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.ts captures AGETOR_DATA_DIR at first import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-cursor-orch-"));
// Drive cursor through the in-process fake (no tmux, no real CLI). The fake
// emits canned chunks and calls onSessionId with a synthetic session id, so we
// can exercise the orchestrator's cursor session bookkeeping + multi-turn
// routing deterministically.
process.env.AGETOR_CURSOR_DRIVER = "fake";
// Availability probe (`checkHarness`) still runs in startTask; point the
// cursor bin at /bin/echo so `--version` succeeds on CI hosts without cursor.
process.env.AGETOR_CURSOR_BIN = "/bin/echo";

beforeAll(async () => {
  await import("./db.ts");
});

async function settle(ms = 80) {
  await new Promise((r) => setTimeout(r, ms));
}

test("createTask (cursor) defaults model to Grok 4.6 at high effort and lands in backlog", async () => {
  const { createTask } = await import("./orchestrator.ts");

  const created = await createTask({
    title: "cursor defaults",
    prompt: "do a thing",
    agent: "cursor",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);

  expect(created.task.agent).toBe("cursor");
  expect(created.task.model).toBe("cursor-grok-4.6");
  expect(created.task.effort).toBe("high");
  expect(created.task.column).toBe("backlog");
});

test("startTask (cursor) sets tmux_session + persists the session id as cursor_session_id", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  const { sessionNameFor } = await import("./claude-tmux.ts");
  harnesses.setEnabled("cursor", true);

  const created = await createTask({
    title: "cursor run",
    prompt: "do a thing",
    agent: "cursor",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);

  await settle();
  const list = runs.listForTask(taskId);
  expect(list.length).toBe(1);
  // All three agent kinds host their run in a per-task tmux session.
  expect(list[0]?.tmuxSession).toBe(sessionNameFor(taskId));
  // The fake delivers a synthetic session id via onSessionId → cursor_session_id.
  expect(list[0]?.cursorSessionId).toBe(`fake-cursor-session-${taskId}`);
  expect(list[0]?.claudeSessionId).toBeNull();
  expect(list[0]?.codexSessionId).toBeNull();
  // The fake resolves done(0) → succeeded → review column.
  expect(list[0]?.status).toBe("succeeded");
});

test("sendInput (cursor, idle) spawns a NEW run row that resumes the same session", async () => {
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("cursor", true);

  const created = await createTask({
    title: "cursor multiturn",
    prompt: "turn one",
    agent: "cursor",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  await settle(); // let the first turn resolve (fake done at ~20ms)

  const firstRunId = "runId" in started ? started.runId : "";
  const res = await sendInput(firstRunId, "turn two");
  expect(res.delivered).toBe(true);
  await settle();

  const list = runs.listForTask(taskId);
  // One row per turn — the follow-up is its own run, not folded into the first.
  expect(list.length).toBe(2);
  const newRunId = res.delivered ? res.runId : "";
  expect(newRunId).not.toBe(firstRunId);
  // The resumed turn carries the same session id forward.
  const newRun = list.find((r) => r.id === newRunId);
  expect(newRun?.cursorSessionId).toBe(`fake-cursor-session-${taskId}`);
});

test("sendInput (cursor, busy) queues the follow-up; it spawns after the active turn resolves", async () => {
  // Exploit the fake's ~20ms resolve window: a follow-up sent in the same
  // tick as start lands while the first turn is still active, so it must
  // queue (no new row yet) and then drain into a second run once the first
  // resolves.
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("cursor", true);

  const created = await createTask({
    title: "cursor queue",
    prompt: "turn one",
    agent: "cursor",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  const firstRunId = "runId" in started ? started.runId : "";

  // Send immediately — the first turn's fake hasn't resolved yet, so this
  // folds into the queue and reports the still-active run id.
  const res = await sendInput(firstRunId, "queued turn");
  expect(res.delivered).toBe(true);
  if (res.delivered) expect(res.runId).toBe(firstRunId); // attached to active run

  // Right away there should still be just one run row (the queued turn hasn't
  // spawned yet).
  expect(runs.listForTask(taskId).length).toBe(1);

  // After both turns drain, there are exactly two run rows, neither stranded
  // in `running`.
  await settle(200);
  const list = runs.listForTask(taskId);
  expect(list.length).toBe(2);
  expect(list.every((r) => r.status !== "running")).toBe(true);
});

test("deleteTask (cursor) tears down without throwing and removes the task", async () => {
  const { createTask, startTask, deleteTask } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");
  harnesses.setEnabled("cursor", true);

  const created = await createTask({
    title: "cursor delete",
    prompt: "turn one",
    agent: "cursor",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  // Let the fake turn resolve fully, then delete — the common path.
  await settle();

  await expect(deleteTask(taskId)).resolves.toBeUndefined();

  expect(tasks.get(taskId)).toBeNull();
});

test("deleteTask (cursor) mid-turn does not crash on late chunks", async () => {
  const { createTask, startTask, deleteTask } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");
  harnesses.setEnabled("cursor", true);

  const created = await createTask({
    title: "cursor delete mid-turn",
    prompt: "will be deleted immediately",
    agent: "cursor",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);

  // Delete while the fake turn is still in flight. `makeFakeAgent.kill()`
  // clears its pending timers, so no chunk can land on the cascade-deleted
  // run row (the old behavior threw SQLITE_CONSTRAINT_FOREIGNKEY from
  // runs.appendEvent). Note the equivalent guard for the REAL tmux drivers
  // (a buffered chunk racing dropSession + cascade-delete) is still an open
  // follow-up in makeChunkHandler/appendEvent.
  await expect(deleteTask(taskId)).resolves.toBeUndefined();
  await settle();

  expect(tasks.get(taskId)).toBeNull();
});

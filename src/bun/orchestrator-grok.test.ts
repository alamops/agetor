import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.ts captures AGETOR_DATA_DIR at first import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-grok-orch-"));
// Drive grok through the in-process fake (no tmux, no real CLI). The fake
// emits canned chunks and calls onSessionId with a synthetic session id, so we
// can exercise the orchestrator's grok session bookkeeping + multi-turn
// routing deterministically. Mirrors orchestrator-codex.test.ts.
process.env.AGETOR_GROK_DRIVER = "fake";
// Availability probe (`checkHarness`) still runs in startTask; point the grok
// bin at /bin/echo so `--version` succeeds on CI hosts without grok.
process.env.AGETOR_GROK_BIN = "/bin/echo";

beforeAll(async () => {
  const { db } = await import("./db.ts");
  // bun test runs every file in one process, so db.ts's first import wins and
  // the DB is SHARED across files — the mkdtemp above only isolates us when
  // this file happens to load first. An earlier file may have deleted the
  // seeded grok builtin (harnesses.test.ts exercises exactly that), and
  // setEnabled below needs the real row — re-seed idempotently.
  db.run(
    `INSERT OR IGNORE INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled)
     VALUES ('grok', 'grok', 'Grok Build', 1, NULL, NULL, '{}', ?, ?, 0)`,
    [Date.now(), Date.now()],
  );
});

async function settle(ms = 80) {
  await new Promise((r) => setTimeout(r, ms));
}

test("startTask (grok) sets tmux_session + persists the session id as grokSessionId", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  const { sessionNameFor } = await import("./claude-tmux.ts");
  harnesses.setEnabled("grok", true);

  const created = await createTask({
    title: "grok run",
    prompt: "do a thing",
    agent: "grok",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
    model: "grok-build",
    effort: null,
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);

  await settle();
  const list = runs.listForTask(taskId);
  expect(list.length).toBe(1);
  // All three kinds host their run in a per-task tmux session.
  expect(list[0]?.tmuxSession).toBe(sessionNameFor(taskId));
  // The fake delivers a synthetic session id via onSessionId → grokSessionId.
  expect(list[0]?.grokSessionId).toBe(`fake-grok-session-${taskId}`);
  expect(list[0]?.claudeSessionId).toBeNull();
  expect(list[0]?.codexSessionId).toBeNull();
  // The fake resolves done(0) → succeeded → review column.
  expect(list[0]?.status).toBe("succeeded");
  const { tasks } = await import("./db.ts");
  expect(tasks.get(taskId)?.column).toBe("review");
});

test("sendInput (grok, idle) spawns a NEW run row that resumes the same session", async () => {
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("grok", true);

  const created = await createTask({
    title: "grok multiturn",
    prompt: "turn one",
    agent: "grok",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
    model: "grok-build",
    effort: null,
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
  expect(newRun?.grokSessionId).toBe(`fake-grok-session-${taskId}`);
});

test("sendInput (grok, busy) queues the follow-up; it spawns after the active turn resolves", async () => {
  // Exploit the fake's ~20ms resolve window: a follow-up sent in the same tick
  // as start lands while the first turn is still active, so it must queue (no
  // new row yet) and then drain into a second run once the first resolves.
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("grok", true);

  const created = await createTask({
    title: "grok queue",
    prompt: "turn one",
    agent: "grok",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
    model: "grok-build",
    effort: null,
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

  // After both turns drain, there are exactly two run rows, both resolved —
  // no `running` rows left behind for reconcile.test.ts to trip over.
  await settle(200);
  const list = runs.listForTask(taskId);
  expect(list.length).toBe(2);
  for (const r of list) expect(r.status).toBe("succeeded");
});

test("deleteTask (grok) tears down mid-flight without throwing and leaves no running rows", async () => {
  const { createTask, startTask, deleteTask } = await import("./orchestrator.ts");
  const { runs, tasks, harnesses } = await import("./db.ts");
  harnesses.setEnabled("grok", true);

  const created = await createTask({
    title: "grok delete",
    prompt: "turn one",
    agent: "grok",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
    model: "grok-build",
    effort: null,
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  // Let the fake's turn resolve first: its `.kill()` only records a log line
  // and doesn't cancel the in-flight `setTimeout`s (mirrors the codex/claude
  // fakes), so deleting while still in flight would let a late `onChunk` fire
  // after the row is cascade-deleted and throw an FK error on a sibling
  // test's tick. Settling first isolates the teardown path we actually want
  // to exercise (dropGrokSession + grokTurnQueue.delete) from that fake-only
  // timing artifact.
  await settle();

  await deleteTask(taskId);

  expect(tasks.get(taskId)).toBeNull();
  expect(runs.listForTask(taskId).length).toBe(0);
});

test("archiveTask (grok) tears down the session + queue without throwing", async () => {
  const { createTask, startTask, archiveTask } = await import("./orchestrator.ts");
  const { runs, tasks, harnesses } = await import("./db.ts");
  harnesses.setEnabled("grok", true);

  const created = await createTask({
    title: "grok archive",
    prompt: "do a thing",
    agent: "grok",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
    model: "grok-build",
    effort: null,
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  await settle(); // let the turn resolve → column 'review'

  // archiveTask requires column 'done'.
  tasks.update(taskId, { column: "done" });

  const archived = await archiveTask(taskId);
  if ("error" in archived) throw new Error(archived.error);
  expect(archived.task.archivedAt).not.toBeNull();

  // No running rows left behind.
  expect(runs.listForTask(taskId).every((r) => r.status !== "running")).toBe(true);
});

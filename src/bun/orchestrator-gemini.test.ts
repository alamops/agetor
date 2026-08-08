import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.ts captures AGETOR_DATA_DIR at first import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-gemini-orch-"));
// Drive gemini through the in-process fake (no tmux, no real CLI). Unlike
// codex's fake (which discovers a synthetic thread id later, from a
// simulated `thread.started`), gemini's real spawn calls onSessionId
// synchronously — the fake preserves that contract with a predictable value
// so we can exercise the orchestrator's gemini session bookkeeping +
// multi-turn routing deterministically. See agents.ts's spawnAgent.
process.env.AGETOR_GEMINI_DRIVER = "fake";
// Availability probe (`checkHarness`) still runs in startTask; point the
// gemini bin at /bin/echo so `--version` succeeds on CI hosts without gemini.
process.env.AGETOR_GEMINI_BIN = "/bin/echo";

beforeAll(async () => {
  await import("./db.ts");
});

async function settle(ms = 80) {
  await new Promise((r) => setTimeout(r, ms));
}

test("startTask (gemini) sets tmux_session + persists the self-issued uuid as gemini_session_id", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  const { sessionNameFor } = await import("./claude-tmux.ts");
  harnesses.setEnabled("gemini", true);

  const created = await createTask({
    title: "gemini run",
    prompt: "do a thing",
    agent: "gemini",
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
  // All three kinds host their run in a per-task tmux session.
  expect(list[0]?.tmuxSession).toBe(sessionNameFor(taskId));
  // The fake delivers a synthetic session id via onSessionId → geminiSessionId.
  expect(list[0]?.geminiSessionId).toBe(`fake-gemini-session-${taskId}`);
  expect(list[0]?.claudeSessionId).toBeNull();
  expect(list[0]?.codexSessionId).toBeNull();
  // The fake resolves done(0) → succeeded → review column.
  expect(list[0]?.status).toBe("succeeded");
});

test("sendInput (gemini, idle) spawns a NEW run row that resumes the same session", async () => {
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("gemini", true);

  const created = await createTask({
    title: "gemini multiturn",
    prompt: "turn one",
    agent: "gemini",
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
  // One row per turn — the follow-up is its own run, not folded into the first
  // (gemini is one-shot per turn, same as codex).
  expect(list.length).toBe(2);
  const newRunId = res.delivered ? res.runId : "";
  expect(newRunId).not.toBe(firstRunId);
  // The resumed turn carries the same self-issued session id forward.
  const newRun = list.find((r) => r.id === newRunId);
  expect(newRun?.geminiSessionId).toBe(`fake-gemini-session-${taskId}`);
});

test("sendInput (gemini, busy) queues the follow-up; it spawns after the active turn resolves", async () => {
  // Exploit the fake's ~20ms resolve window: a follow-up sent in the same
  // tick as start lands while the first turn is still active, so it must
  // queue (no new row yet) and then drain into a second run once the first
  // resolves.
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("gemini", true);

  const created = await createTask({
    title: "gemini queue",
    prompt: "turn one",
    agent: "gemini",
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

  // After both turns drain, there are exactly two run rows.
  await settle(200);
  expect(runs.listForTask(taskId).length).toBe(2);
});

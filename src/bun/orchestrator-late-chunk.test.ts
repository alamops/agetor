import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

// A chunk that arrives after deleteTask cascade-deleted its run (claude's
// boot-timeout stderr lines land 30 s after the spawn) must be dropped, not
// thrown as an unhandled run_events foreign-key error.

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-late-chunk-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

let orch: typeof import("./orchestrator.ts");
let db: typeof import("./db.ts");

beforeAll(async () => {
  db = await import("./db.ts");
  orch = await import("./orchestrator.ts");
});

afterAll(() => {
  rmTestDataDir(DATA_DIR);
});

async function startedClaudeTask(): Promise<{ taskId: string; runId: string }> {
  const created = await orch.createTask({
    title: "late chunk",
    prompt: "p",
    agent: "claude-code",
    workdir: mkdtempSync(path.join(tmpdir(), "agetor-late-chunk-wd-")),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const started = await orch.startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);
  return { taskId: created.task.id, runId: started.runId };
}

async function waitSettled(taskId: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && db.runs.listForTask(taskId).some((r) => r.status === "running")) {
    await new Promise((r) => setTimeout(r, 15));
  }
}

test("a chunk for a run whose task was deleted is dropped without throwing", async () => {
  const { taskId, runId } = await startedClaudeTask();
  await waitSettled(taskId);
  await orch.deleteTask(taskId);
  expect(db.runs.get(runId)).toBeNull();
  expect(() =>
    orch.__dispatchChunkForTest(runId, taskId, "claude-code", "stderr", "claude session JSONL never appeared"),
  ).not.toThrow();
});

test("a chunk for a live run is still recorded", async () => {
  const { taskId, runId } = await startedClaudeTask();
  await waitSettled(taskId);
  orch.__dispatchChunkForTest(runId, taskId, "claude-code", "stderr", "late stderr line");
  expect(db.runs.events(runId).some((e) => e.stream === "stderr" && e.data === "late stderr line")).toBe(true);
  await orch.deleteTask(taskId);
});

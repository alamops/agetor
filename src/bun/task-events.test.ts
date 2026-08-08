import { test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import — beforeAll
// would race with sibling test files that already imported db.ts. The
// AGETOR_CLAUDE_* vars steer the sendInput test below through the fake
// driver; setting them inside the test body would leak permanently to
// any sibling file that runs after this one in the same bun-test
// process, so they live up here too.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-task-events-"));
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";

// The SQLite db is process-wide; sibling test files that count rows
// (notably reconcile.test.ts, which expects exactly one `running` run)
// rely on a clean table between suites. Wipe everything we inserted so
// nothing leaks across files.
afterEach(async () => {
  const { db } = await import("./db.ts");
  db.run(`DELETE FROM run_events`);
  db.run(`DELETE FROM runs`);
  db.run(`DELETE FROM tasks`);
});

// These tests pin the unified task-level event stream that the run panel
// consumes (one merged scrollback per task, spanning every run). The
// regressions they guard against:
//
//   • cross-run event merge — `eventsForTask` must walk every run for a
//     task, ordered by event-id, so the merged view is chronological;
//   • SSE `/tasks/:id/events` — replays history first, then forwards
//     live events for the task only (no cross-task leak);
//   • per-turn run rows — sendInput on a finished claude-code task must
//     insert a fresh row (the runs list grows turn-by-turn even though
//     the on-screen scrollback is now task-level).

function makeTaskRow(taskId: string, agent: Task["agent"] = "claude-code"): Task {
  return {
    id: taskId,
    title: "t",
    prompt: "p",
    agent,
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    fast: false, maxMode: false,
    references: [],    backlog: [], draft: null,
    column: "ready",
    runId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
  };
}

test("runs.eventsForTask merges events across runs in event-id (chronological) order", async () => {
  const { tasks, runs } = await import("./db.ts");
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));

  const runA = randomUUID();
  const runB = randomUUID();
  const now = Date.now();
  runs.insert({
    id: runA, taskId, agent: "claude-code", status: "succeeded",
    startedAt: now, endedAt: now + 10, exitCode: 0,
    tmuxSession: "agetor-test-a", claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null,
  });
  runs.appendEvent(runA, "user", "first prompt");
  runs.appendEvent(runA, "assistant", "A reply 1");
  runs.insert({
    id: runB, taskId, agent: "claude-code", status: "running",
    startedAt: now + 20, endedAt: null, exitCode: null,
    tmuxSession: "agetor-test-b", claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null,
  });
  // Interleave so id-order ≠ grouped-by-run.
  runs.appendEvent(runB, "user", "second prompt");
  runs.appendEvent(runA, "status", "trailing summary on A");
  runs.appendEvent(runB, "assistant", "B reply 1");

  const merged = runs.eventsForTask(taskId);
  expect(merged.map((e) => ({ runId: e.runId, stream: e.stream, data: e.data }))).toEqual([
    { runId: runA, stream: "user", data: "first prompt" },
    { runId: runA, stream: "assistant", data: "A reply 1" },
    { runId: runB, stream: "user", data: "second prompt" },
    { runId: runA, stream: "status", data: "trailing summary on A" },
    { runId: runB, stream: "assistant", data: "B reply 1" },
  ]);
});

test("runs.eventsForTask is empty for a task with no runs", async () => {
  const { tasks, runs } = await import("./db.ts");
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  expect(runs.eventsForTask(taskId)).toEqual([]);
});

test("runs.eventsForTask does not leak events from other tasks", async () => {
  const { tasks, runs } = await import("./db.ts");
  const taskA = randomUUID();
  const taskB = randomUUID();
  tasks.insert(makeTaskRow(taskA));
  tasks.insert(makeTaskRow(taskB));
  const runA = randomUUID();
  const runB = randomUUID();
  const now = Date.now();
  runs.insert({
    id: runA, taskId: taskA, agent: "claude-code", status: "succeeded",
    startedAt: now, endedAt: now + 5, exitCode: 0,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null,
  });
  runs.insert({
    id: runB, taskId: taskB, agent: "claude-code", status: "succeeded",
    startedAt: now, endedAt: now + 5, exitCode: 0,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null,
  });
  runs.appendEvent(runA, "user", "A's message");
  runs.appendEvent(runB, "user", "B's message");

  expect(runs.eventsForTask(taskA).map((e) => e.data)).toEqual(["A's message"]);
  expect(runs.eventsForTask(taskB).map((e) => e.data)).toEqual(["B's message"]);
});

test("subscribe() + manual taskId filter behaves correctly (mirrors the SSE handler's predicate)", async () => {
  // This test does NOT exercise the `/tasks/:id/events` HTTP handler —
  // booting a server here would freeze server.ts's module-level PORT
  // and collide with server-auth.test's bind expectation. Instead we
  // pin the same predicate the handler uses inline:
  //   src/bun/server.ts: `if (e.taskId !== taskId) return;`
  // If you change that filter, update this test (or extract the
  // predicate into a named helper and import it from both sites).
  const { __emitForTest, subscribe } = await import("./orchestrator.ts");
  const targetTask = randomUUID();
  const otherTask = randomUUID();
  const seen: string[] = [];
  const unsub = subscribe((e) => {
    if (e.taskId !== targetTask) return;
    seen.push(e.data);
  });
  __emitForTest({ runId: "r1", taskId: targetTask, stream: "user", data: "mine-1", ts: Date.now() });
  __emitForTest({ runId: "r2", taskId: otherTask, stream: "user", data: "not-mine", ts: Date.now() });
  __emitForTest({ runId: "r3", taskId: targetTask, stream: "assistant", data: "mine-2", ts: Date.now() });
  unsub();
  __emitForTest({ runId: "r4", taskId: targetTask, stream: "user", data: "after-unsub", ts: Date.now() });
  expect(seen).toEqual(["mine-1", "mine-2"]);
});

test("sendInput on a finished claude-code task inserts a NEW run row with status='running'", async () => {
  // Pins the per-turn-row behaviour: each user message creates its own
  // row so the runs list shows turn granularity. The earlier short-lived
  // "reuse the same row" implementation made the new row invisible (the
  // runs list polled every 2s and saw no new id). AGETOR_CLAUDE_DRIVER
  // is set at module top so the spawnResumedSession path resolves to
  // the in-process fake driver instead of touching tmux or a real CLI.
  const { tasks, runs, db } = await import("./db.ts");
  const { sendInput } = await import("./orchestrator.ts");
  const taskId = randomUUID();
  // model/effort must be set: a finished task has no in-memory SessionState, so
  // sendClaudeTurn routes through spawnResumedSession → spawnAgent, and
  // buildCommand (called even on the fake-driver path) requires them.
  tasks.insert({ ...makeTaskRow(taskId), model: "claude-opus-4-7", effort: "medium" });
  const firstRunId = randomUUID();
  const now = Date.now();
  runs.insert({
    id: firstRunId, taskId, agent: "claude-code", status: "succeeded",
    startedAt: now, endedAt: now + 100, exitCode: 0,
    tmuxSession: null, claudeSessionId: "fake-session-id", codexSessionId: null, cursorSessionId: null, geminiSessionId: null,
  });

  const countRows = () => db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) as n FROM runs WHERE task_id = ?`,
  ).get(taskId)?.n ?? 0;
  expect(countRows()).toBe(1);

  // A finished task has no in-memory SessionState, so sendClaudeTurn routes
  // through spawnResumedSession deterministically (regardless of whether a
  // stray tmux session with this name exists), which uses the fake driver
  // (AGETOR_CLAUDE_DRIVER=fake) and inserts a fresh run row.
  const result = await sendInput(firstRunId, "follow-up");
  if (!result.delivered) throw new Error(`sendInput failed: ${result.reason}`);
  expect(result.runId).not.toBe(firstRunId);

  expect(countRows()).toBe(2);
  const newRow = db.query<
    { id: string; status: string },
    [string, string]
  >(`SELECT id, status FROM runs WHERE task_id = ? AND id != ?`).get(taskId, firstRunId);
  expect(newRow?.id).toBe(result.runId);
  expect(newRow?.status).toBe("running");

  // Give the fake driver's deferred end_turn microtasks a chance to settle
  // so they don't bleed into a sibling test running in the same process.
  await new Promise((r) => setTimeout(r, 50));
});

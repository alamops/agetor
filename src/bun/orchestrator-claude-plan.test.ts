import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.ts";

// db.ts captures AGETOR_DATA_DIR at first import — set before any import of
// ./db.ts or ./orchestrator.ts (same convention as orchestrator-cursor-plan.test.ts).
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-claude-plan-"));
// Drive claude through the in-process fake (no tmux, no real CLI).
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo"; // tmux probe in agent-status passes
process.env.AGETOR_CLAUDE_ARGS = "";
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT.
process.env.AGETOR_API_PORT = "4518";

const BASE = "http://127.0.0.1:4518";

let server: { stop: () => void };
let token: string;
let createTask: typeof import("./orchestrator.ts").createTask;
let startTask: typeof import("./orchestrator.ts").startTask;
let __dispatchChunkForTest: typeof import("./orchestrator.ts").__dispatchChunkForTest;
let tasks: typeof import("./db.ts").tasks;
let db: typeof import("./db.ts").db;
let runs: typeof import("./db.ts").runs;

beforeAll(async () => {
  ({ createTask, startTask, __dispatchChunkForTest } = await import("./orchestrator.ts"));
  ({ tasks, db, runs } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

async function settle(ms = 60) {
  await new Promise((r) => setTimeout(r, ms));
}

const call = (p: string, init: RequestInit = {}) =>
  fetch(`${BASE}${p}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

/** A fresh scratch dir per task — never a real repo (isolation: "none" runs
 *  directly in workdir). */
function scratchWorkdir(): string {
  return mkdtempSync(path.join(tmpdir(), "agetor-claude-plan-wd-"));
}

async function newClaudeTask(): Promise<{ id: string; workdir: string }> {
  const workdir = scratchWorkdir();
  const created = await createTask({
    title: "claude plan task",
    prompt: "do some work",
    agent: "claude-code",
    workdir,
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  return { id: created.task.id, workdir };
}

/** Starts the task and returns its fresh runId — the fake claude driver
 *  (AGETOR_CLAUDE_DRIVER=fake) resolves its own canned turn on a short timer
 *  regardless, but every test here dispatches its OWN synthetic chunks
 *  synchronously via `__dispatchChunkForTest`, so it doesn't need to wait on
 *  (or interact with) the fake driver's default response. */
async function startAndGetRunId(id: string): Promise<string> {
  const started = await startTask(id);
  if ("error" in started) throw new Error(started.error);
  if (!("runId" in started)) throw new Error("startTask did not return a runId");
  return started.runId;
}

function toolUse(id: string, name: string, input: unknown): string {
  return JSON.stringify({ id, name, input });
}

function toolResult(toolUseId: string, content: string): string {
  return JSON.stringify({ toolUseId, content, isError: false });
}

// --- Claude plan history: ExitPlanMode lifecycle ----------------------------

test("ExitPlanMode tool_use lands a pending plan on the task", async () => {
  const { id } = await newClaudeTask();
  const runId = await startAndGetRunId(id);

  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_use",
    toolUse("toolu_01", "ExitPlanMode", { plan: "# My Plan\n\n- step one", allowedPrompts: [] }),
  );

  const task = tasks.get(id)!;
  expect(task.plans.length).toBe(1);
  const plan = task.plans[0]!;
  expect(plan.status).toBe("pending");
  expect(plan.content).toBe("# My Plan\n\n- step one");
  expect(plan.toolCallId).toBe("toolu_01");
  expect(plan.runId).toBe(runId);
  expect(plan.name).toBeNull();

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

test("plain approval tool_result resolves the plan to approved, no edited content", async () => {
  const { id } = await newClaudeTask();
  const runId = await startAndGetRunId(id);

  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_use",
    toolUse("toolu_01", "ExitPlanMode", { plan: "# Plan", allowedPrompts: [] }),
  );
  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_result",
    toolResult("toolu_01", "User has approved your plan. You can now start coding."),
  );

  const task = tasks.get(id)!;
  const plan = task.plans[0]!;
  expect(plan.status).toBe("approved");
  expect(plan.editedContent).toBeNull();
  expect(plan.approvedEdited).toBe(false);
  expect(plan.approvedAt).not.toBeNull();
  expect(plan.filePath).toBeNull(); // claude plans never get a filePath

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

test("approval tool_result with the edited-plan marker stores the edited content and approvedEdited=true", async () => {
  const { id } = await newClaudeTask();
  const runId = await startAndGetRunId(id);

  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_use",
    toolUse("toolu_01", "ExitPlanMode", { plan: "# Original Plan\n\n- step one", allowedPrompts: [] }),
  );
  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_result",
    toolResult(
      "toolu_01",
      "User has approved your plan. You can now start coding. Start with what you were told will be step #1.\n\n"
        + "## Approved Plan (edited by user):\n# Edited Plan\n\n- step one (edited)",
    ),
  );

  const task = tasks.get(id)!;
  const plan = task.plans[0]!;
  expect(plan.status).toBe("approved");
  expect(plan.approvedEdited).toBe(true);
  expect(plan.editedContent).toBe("# Edited Plan\n\n- step one (edited)");
  // Original content preserved verbatim.
  expect(plan.content).toBe("# Original Plan\n\n- step one");

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

test("a non-approval tool_result (rejection/interrupt) resolves the plan to rejected", async () => {
  const { id } = await newClaudeTask();
  const runId = await startAndGetRunId(id);

  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_use",
    toolUse("toolu_01", "ExitPlanMode", { plan: "# Plan", allowedPrompts: [] }),
  );
  __dispatchChunkForTest(runId, id, "claude-code", "tool_result", toolResult("toolu_01", "The user rejected your plan."));

  const task = tasks.get(id)!;
  const plan = task.plans[0]!;
  expect(plan.status).toBe("rejected");
  expect(plan.approvedAt).toBeNull();

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

test("a second ExitPlanMode supersedes a still-pending first plan", async () => {
  const { id } = await newClaudeTask();
  const runId = await startAndGetRunId(id);

  __dispatchChunkForTest(runId, id, "claude-code", "tool_use", toolUse("toolu_01", "ExitPlanMode", { plan: "plan one" }));
  __dispatchChunkForTest(runId, id, "claude-code", "tool_use", toolUse("toolu_02", "ExitPlanMode", { plan: "plan two" }));

  const task = tasks.get(id)!;
  expect(task.plans.length).toBe(2);
  expect(task.plans[0]!.status).toBe("superseded");
  expect(task.plans[1]!.status).toBe("pending");
  expect(task.plans[1]!.content).toBe("plan two");

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

test("plan detection is scoped to claude-code — a cursor-kind chunk with the same shape is ignored", async () => {
  const { id } = await newClaudeTask();
  const runId = await startAndGetRunId(id);

  __dispatchChunkForTest(runId, id, "cursor", "tool_use", toolUse("toolu_01", "ExitPlanMode", { plan: "should be ignored" }));

  const task = tasks.get(id)!;
  expect(task.plans.length).toBe(0);

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

// --- Board todo-progress summary --------------------------------------------

test("TaskCreate + TaskUpdate chunk sequence lands the right todo_progress summary", async () => {
  const { id } = await newClaudeTask();
  const runId = await startAndGetRunId(id);

  expect(tasks.get(id)!.todoProgress).toBeNull();

  // 2x TaskCreate, with tool_results carrying the task numbers.
  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_use",
    toolUse("toolu_c1", "TaskCreate", { subject: "Write the plan", description: "…", activeForm: "Writing the plan" }),
  );
  __dispatchChunkForTest(runId, id, "claude-code", "tool_result", toolResult("toolu_c1", "Task #1 created successfully: Write the plan"));
  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_use",
    toolUse("toolu_c2", "TaskCreate", { subject: "Implement it", description: "…", activeForm: "Implementing" }),
  );
  __dispatchChunkForTest(runId, id, "claude-code", "tool_result", toolResult("toolu_c2", "Task #2 created successfully: Implement it"));

  let summary = tasks.get(id)!.todoProgress;
  expect(summary).toEqual({ completed: 0, total: 2 });

  // TaskUpdate → in_progress on task 1 — total/completed unchanged.
  __dispatchChunkForTest(runId, id, "claude-code", "tool_use", toolUse("toolu_u1", "TaskUpdate", { taskId: "1", status: "in_progress" }));
  summary = tasks.get(id)!.todoProgress;
  expect(summary).toEqual({ completed: 0, total: 2 });

  // TaskUpdate → completed on task 1 — completed increments.
  __dispatchChunkForTest(runId, id, "claude-code", "tool_use", toolUse("toolu_u2", "TaskUpdate", { taskId: "1", status: "completed" }));
  summary = tasks.get(id)!.todoProgress;
  expect(summary).toEqual({ completed: 1, total: 2 });

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

test("todo_progress derivation works for a non-claude agent kind too (chunks are generic)", async () => {
  // Board summary derivation is not gated on agent kind — only claude plan
  // history is. Use a claude-kind task purely as a convenient way to get a
  // real run row (the fake driver requires it), but dispatch the chunk
  // tagged as a different kind to prove the todo-progress path itself
  // doesn't branch on `kind`.
  const { id } = await newClaudeTask();
  const runId = await startAndGetRunId(id);

  __dispatchChunkForTest(
    runId,
    id,
    "codex",
    "tool_use",
    toolUse("toolu_1", "TodoWrite", { todos: [{ content: "one", status: "completed" }, { content: "two", status: "pending" }] }),
  );

  const summary = tasks.get(id)!.todoProgress;
  expect(summary).toEqual({ completed: 1, total: 2 });

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

test("an unrelated chunk (no todo-family marker) does not touch todo_progress", async () => {
  const { id } = await newClaudeTask();
  const runId = await startAndGetRunId(id);

  __dispatchChunkForTest(runId, id, "claude-code", "tool_use", toolUse("toolu_1", "Read", { file_path: "/tmp/x" }));
  expect(tasks.get(id)!.todoProgress).toBeNull();

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

test("TaskUpdate by a claude-assigned (out-of-sequence) task number resolves correctly through the server path", async () => {
  // Regression for: tool_result rows never survived the `todoRelevantEventsForTask`
  // LIKE filter, so the server-side derivation only ever saw the tool_use
  // side and silently fell back to sequential numbering — diverging from the
  // webview (which sees the full event stream including tool_results). Here
  // the FIRST created task is assigned #2 by its tool_result (an
  // out-of-sequence number a naive sequential fallback would never produce),
  // and a subsequent TaskUpdate addresses it by that claude-assigned number.
  // This only resolves correctly if the tool_result reached the derivation.
  const { id } = await newClaudeTask();
  const runId = await startAndGetRunId(id);

  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_use",
    toolUse("toolu_c1", "TaskCreate", { subject: "Out-of-sequence task", activeForm: "Working" }),
  );
  __dispatchChunkForTest(runId, id, "claude-code", "tool_result", toolResult("toolu_c1", "Task #2 created successfully: Out-of-sequence task"));

  // TaskUpdate addresses task "2" — the claude-assigned number, not the
  // sequential-fallback number (which would have been "1").
  __dispatchChunkForTest(runId, id, "claude-code", "tool_use", toolUse("toolu_u1", "TaskUpdate", { taskId: "2", status: "completed" }));

  const summary = tasks.get(id)!.todoProgress;
  expect(summary).toEqual({ completed: 1, total: 1 });

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

test("a second run whose TaskCreate numbering restarts at 1 resets the board summary — no stale tail from the prior run", async () => {
  const { id } = await newClaudeTask();
  const runId1 = await startAndGetRunId(id);

  __dispatchChunkForTest(runId1, id, "claude-code", "tool_use", toolUse("toolu_c1", "TaskCreate", { subject: "Run1 A", activeForm: "A" }));
  __dispatchChunkForTest(runId1, id, "claude-code", "tool_result", toolResult("toolu_c1", "Task #1 created successfully: Run1 A"));
  __dispatchChunkForTest(runId1, id, "claude-code", "tool_use", toolUse("toolu_c2", "TaskCreate", { subject: "Run1 B", activeForm: "B" }));
  __dispatchChunkForTest(runId1, id, "claude-code", "tool_result", toolResult("toolu_c2", "Task #2 created successfully: Run1 B"));

  expect(tasks.get(id)!.todoProgress).toEqual({ completed: 0, total: 2 });

  // A distinct, real run row (run_events.run_id has a FK to runs(id), so a
  // synthetic id would fail the insert) — as a fresh turn/session would
  // produce. Numbering restarts at 1 with only a single task this time.
  const runId2 = randomUUID();
  runs.insert({
    id: runId2,
    taskId: id,
    agent: "claude-code",
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
  });
  __dispatchChunkForTest(runId2, id, "claude-code", "tool_use", toolUse("toolu_c3", "TaskCreate", { subject: "Run2 A", activeForm: "A" }));
  __dispatchChunkForTest(runId2, id, "claude-code", "tool_result", toolResult("toolu_c3", "Task #1 created successfully: Run2 A"));

  // Without the run-scoped reset, run 1's task #2 survives untouched and
  // total would incorrectly read 3 instead of 1.
  expect(tasks.get(id)!.todoProgress).toEqual({ completed: 0, total: 1 });

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

test("an assistant chunk quoting ExitPlanMode/TaskCreate/TaskUpdate in prose does not trip todo/plan detection", async () => {
  // Pre-filter behavior: the hot-path markers must match the serialized
  // envelope form ("name":"ExitPlanMode" / "name":"TaskCreate" / …), not a
  // bare tool-name substring — agetor dogfoods itself, so a chunk that
  // merely quotes these identifiers in prose (describing this very code,
  // for instance) is a real false positive with a bare-substring check.
  const { id } = await newClaudeTask();
  const runId = await startAndGetRunId(id);

  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "assistant",
    "I'll add ExitPlanMode handling alongside TaskCreate and TaskUpdate support.",
  );

  expect(tasks.get(id)!.plans.length).toBe(0);
  expect(tasks.get(id)!.todoProgress).toBeNull();

  // Same for a tool_use whose data merely CONTAINS "ExitPlanMode" as a
  // substring without the envelope form (defensive — real claude output
  // always uses the envelope form, but the pre-filter must not be fooled by
  // a loose substring match either).
  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_use",
    JSON.stringify({ id: "toolu_99", name: "Write", input: { content: "mentions ExitPlanMode in a comment" } }),
  );
  expect(tasks.get(id)!.plans.length).toBe(0);

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

test("a tool_result quoting 'created successfully' does not affect claude plan tracking when no plan is pending", async () => {
  // Finding-5 pre-filter: maybeTrackClaudePlan's tool_result short-circuit
  // (task has no pending plan) must not be broken by this chunk also being
  // eligible for the todo-progress pre-filter — the two detectors are
  // independent and this chunk carries no ExitPlanMode-related content.
  const { id } = await newClaudeTask();
  const runId = await startAndGetRunId(id);

  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_result",
    toolResult("toolu_unrelated", "Task #1 created successfully: some task"),
  );

  expect(tasks.get(id)!.plans.length).toBe(0);

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

// --- parseTodoProgress bounds (db.ts) ---------------------------------------

test("parseTodoProgress rejects out-of-bounds/malformed todo_progress JSON, falls back to null", async () => {
  const { id } = await newClaudeTask();

  const invalidCases = [
    { completed: 9, total: 0 }, // completed > total
    { completed: -1, total: 5 }, // negative
    { completed: 1.5, total: 5 }, // non-integer
    { completed: 1, total: -5 }, // negative total
    { completed: "1", total: 5 }, // wrong type
  ];
  for (const invalid of invalidCases) {
    db.run(`UPDATE tasks SET todo_progress = ? WHERE id = ?`, [JSON.stringify(invalid), id]);
    expect(tasks.get(id)!.todoProgress).toBeNull();
  }

  // A valid, in-bounds value still round-trips correctly.
  db.run(`UPDATE tasks SET todo_progress = ? WHERE id = ?`, [JSON.stringify({ completed: 2, total: 5 }), id]);
  expect(tasks.get(id)!.todoProgress).toEqual({ completed: 2, total: 5 });

  // completed === total (fully done) is valid, not an edge-case rejection.
  db.run(`UPDATE tasks SET todo_progress = ? WHERE id = ?`, [JSON.stringify({ completed: 5, total: 5 }), id]);
  expect(tasks.get(id)!.todoProgress).toEqual({ completed: 5, total: 5 });

  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

// --- PATCH allow-list excludes both server-managed columns ------------------

test("PATCH /tasks/:id cannot set plans or todoProgress — both stay server-managed", async () => {
  const { id } = await newClaudeTask();
  const runId = await startAndGetRunId(id);

  __dispatchChunkForTest(runId, id, "claude-code", "tool_use", toolUse("toolu_01", "ExitPlanMode", { plan: "# Plan" }));
  __dispatchChunkForTest(
    runId,
    id,
    "claude-code",
    "tool_use",
    toolUse("toolu_c1", "TaskCreate", { subject: "A task", activeForm: "Doing a task" }),
  );
  __dispatchChunkForTest(runId, id, "claude-code", "tool_result", toolResult("toolu_c1", "Task #1 created successfully: A task"));

  const before = tasks.get(id)!;
  expect(before.plans.length).toBe(1);
  expect(before.todoProgress).toEqual({ completed: 0, total: 1 });

  const res = await call(`/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify({
      plans: [],
      todoProgress: { completed: 99, total: 99 },
      title: "renamed via PATCH", // sanity: an allow-listed field DOES go through
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Task;
  expect(body.title).toBe("renamed via PATCH");
  expect(body.plans.length).toBe(1); // untouched by the PATCH payload
  expect(body.todoProgress).toEqual({ completed: 0, total: 1 }); // untouched

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

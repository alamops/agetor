import { test, expect } from "bun:test";
import type { RunEvent } from "../../shared/types.ts";
import { deriveTodoProgress } from "./todo-progress.ts";

function baseEvent(overrides: Partial<RunEvent> = {}): RunEvent {
  return { runId: "r1", taskId: "t1", stream: "tool_use", data: "{}", ts: 0, ...overrides };
}

/** A `tool_use` event carrying a TodoWrite snapshot — `data` is the JSON
 *  string shape Claude actually emits: `{ id, name, input: { todos }, serverSide }`. */
function todoWriteEvent(todos: unknown, overrides: Partial<RunEvent> = {}): RunEvent {
  return baseEvent({
    data: JSON.stringify({ id: "tu1", name: "TodoWrite", input: { todos }, serverSide: true }),
    ...overrides,
  });
}

/** A `tool_use` event for some other tool (not TodoWrite). */
function toolUseEvent(name: string, input: unknown, overrides: Partial<RunEvent> = {}): RunEvent {
  return baseEvent({ data: JSON.stringify({ id: "tu2", name, input }), ...overrides });
}

/** A `TaskCreate` tool_use event — real wire shape: `input = { subject,
 *  description, activeForm }`, joined to its tool_result by `id`. */
function taskCreateEvent(
  id: string,
  subject: string,
  activeForm?: string,
  overrides: Partial<RunEvent> = {},
): RunEvent {
  return baseEvent({
    data: JSON.stringify({
      id,
      name: "TaskCreate",
      input: { subject, description: `${subject} — description`, ...(activeForm ? { activeForm } : {}) },
    }),
    ...overrides,
  });
}

/** The `tool_result` matching a `TaskCreate` tool_use — real wire shape:
 *  `data = { toolUseId, content, isError }`, `content` a string whose text
 *  is `"Task #N created successfully: <subject>"`. */
function taskCreateResultEvent(toolUseId: string, taskNumber: number, subject: string, overrides: Partial<RunEvent> = {}): RunEvent {
  return baseEvent({
    stream: "tool_result",
    data: JSON.stringify({
      toolUseId,
      content: `Task #${taskNumber} created successfully: ${subject}`,
      isError: false,
    }),
    ...overrides,
  });
}

/** A `TaskUpdate` tool_use event — real wire shape: `input = { taskId,
 *  status?, subject?, description? }`. */
function taskUpdateEvent(
  taskId: string,
  patch: { status?: string; subject?: string; description?: string },
  overrides: Partial<RunEvent> = {},
): RunEvent {
  return baseEvent({
    data: JSON.stringify({ id: `tu-update-${taskId}`, name: "TaskUpdate", input: { taskId, ...patch } }),
    ...overrides,
  });
}

test("empty events array yields null", () => {
  expect(deriveTodoProgress([])).toBeNull();
});

test("events present but none are TodoWrite yields null", () => {
  const events: RunEvent[] = [
    baseEvent({ stream: "assistant", data: "Here's what I'll do next." }),
    baseEvent({ stream: "thinking", data: "Let me think about this..." }),
    toolUseEvent("Read", { file_path: "/a.ts" }),
  ];
  expect(deriveTodoProgress(events)).toBeNull();
});

test("single TodoWrite snapshot parses todos in order with correct completed/total", () => {
  const events = [
    todoWriteEvent([
      { content: "Task A", status: "completed" },
      { content: "Task B", status: "in_progress", activeForm: "Doing B" },
      { content: "Task C", status: "pending" },
    ]),
  ];
  const result = deriveTodoProgress(events);
  expect(result).not.toBeNull();
  expect(result?.total).toBe(3);
  expect(result?.completed).toBe(1);
  expect(result?.activeForm).toBe("Doing B");
  expect(result?.todos.map((t) => t.content)).toEqual(["Task A", "Task B", "Task C"]);
  expect(result?.todos.map((t) => t.status)).toEqual(["completed", "in_progress", "pending"]);
});

test("latest wins: three successive snapshots reflect only the last one", () => {
  const events = [
    todoWriteEvent(
      [
        { content: "A", status: "completed" },
        { content: "B", status: "pending" },
        { content: "C", status: "pending" },
      ],
      { ts: 1 },
    ),
    todoWriteEvent(
      [
        { content: "A", status: "completed" },
        { content: "B", status: "completed" },
        { content: "C", status: "pending" },
      ],
      { ts: 2 },
    ),
    todoWriteEvent(
      [
        { content: "A", status: "completed" },
        { content: "B", status: "completed" },
        { content: "C", status: "completed" },
      ],
      { ts: 3 },
    ),
  ];
  const result = deriveTodoProgress(events);
  expect(result?.completed).toBe(3);
  expect(result?.total).toBe(3);
});

test("empty snapshot clears an earlier non-empty one (Claude's clear-list signal)", () => {
  // A later empty TodoWrite must win over an earlier non-empty snapshot —
  // this is how Claude clears the list, not a "no-op" to be ignored.
  const events = [
    todoWriteEvent([{ content: "A", status: "pending" }]),
    todoWriteEvent([]),
  ];
  expect(deriveTodoProgress(events)).toBeNull();
});

test("malformed JSON on a tool_use event is skipped silently, never throws", () => {
  const events = [
    baseEvent({ data: "{not valid json" }),
    todoWriteEvent([{ content: "A", status: "completed" }]),
  ];
  let result: ReturnType<typeof deriveTodoProgress>;
  expect(() => {
    result = deriveTodoProgress(events);
  }).not.toThrow();
  expect(result!).not.toBeNull();
  expect(result!.total).toBe(1);
  expect(result!.completed).toBe(1);
});

test("activeForm is taken from the first in_progress todo", () => {
  const result = deriveTodoProgress([
    todoWriteEvent([
      { content: "A", status: "pending" },
      { content: "B", status: "in_progress", activeForm: "Doing B" },
      { content: "C", status: "in_progress", activeForm: "Doing C" },
    ]),
  ]);
  expect(result?.activeForm).toBe("Doing B");
});

test("activeForm is null when no todo is in_progress", () => {
  const result = deriveTodoProgress([
    todoWriteEvent([
      { content: "A", status: "completed" },
      { content: "B", status: "pending" },
    ]),
  ]);
  expect(result?.activeForm).toBeNull();
});

test("activeForm is null when the in-progress todo has no activeForm", () => {
  const result = deriveTodoProgress([
    todoWriteEvent([{ content: "A", status: "in_progress" }]),
  ]);
  expect(result?.activeForm).toBeNull();
});

test("unknown or missing status coerces to pending", () => {
  const result = deriveTodoProgress([
    todoWriteEvent([
      { content: "A", status: "some-unknown-status" },
      { content: "B" },
    ]),
  ]);
  expect(result?.todos[0]?.status).toBe("pending");
  expect(result?.todos[1]?.status).toBe("pending");
});

test("individual malformed todo entries are dropped while valid siblings survive", () => {
  const result = deriveTodoProgress([
    todoWriteEvent([
      null,
      "just a bare string",
      { no: "content field" },
      { content: "Valid", status: "completed" },
    ]),
  ]);
  expect(result).not.toBeNull();
  expect(result?.total).toBe(1);
  expect(result?.completed).toBe(1);
  expect(result?.todos[0]?.content).toBe("Valid");
});

test("a snapshot whose entries are all malformed yields null, not a vacuous 0/0", () => {
  const result = deriveTodoProgress([
    todoWriteEvent([null, "bare string", {}, { status: "pending" }]),
  ]);
  expect(result).toBeNull();
});

test("empty and whitespace-only content entries are dropped, not rendered as blank rows", () => {
  const result = deriveTodoProgress([
    todoWriteEvent([
      { content: "", status: "pending" },
      { content: "   ", status: "in_progress" },
      { content: "Real work", status: "completed" },
    ]),
  ]);
  expect(result).not.toBeNull();
  expect(result?.total).toBe(1);
  expect(result?.todos[0]?.content).toBe("Real work");
});

test("a snapshot of only blank-content entries yields null", () => {
  expect(deriveTodoProgress([todoWriteEvent([{ content: "" }, { content: "\t\n" }])])).toBeNull();
});

test("TodoWrite-looking JSON on a non-tool_use stream is ignored", () => {
  const events: RunEvent[] = [
    baseEvent({
      stream: "assistant",
      data: JSON.stringify({
        id: "tu1",
        name: "TodoWrite",
        input: { todos: [{ content: "A", status: "completed" }] },
      }),
    }),
  ];
  expect(deriveTodoProgress(events)).toBeNull();
});

test("input.todos present but not an array causes that event to be skipped", () => {
  const events = [todoWriteEvent("not-an-array" as unknown)];
  expect(deriveTodoProgress(events)).toBeNull();
});

test("input.todos not an array only skips that one event — a later valid snapshot still resolves", () => {
  const events = [
    todoWriteEvent("not-an-array" as unknown),
    todoWriteEvent([{ content: "A", status: "completed" }]),
  ];
  const result = deriveTodoProgress(events);
  expect(result).not.toBeNull();
  expect(result?.total).toBe(1);
});

// ---------------------------------------------------------------------------
// Task-tools (TaskCreate / TaskUpdate) — current Claude Code sessions
// ---------------------------------------------------------------------------

test("TaskCreate with a matching tool_result is numbered from the result text", () => {
  const events = [
    taskCreateEvent("call_1", "Set up scaffolding", "Setting up scaffolding"),
    taskCreateResultEvent("call_1", 1, "Set up scaffolding"),
    taskCreateEvent("call_2", "Write tests", "Writing tests"),
    taskCreateResultEvent("call_2", 2, "Write tests"),
  ];
  const result = deriveTodoProgress(events);
  expect(result).not.toBeNull();
  expect(result?.total).toBe(2);
  expect(result?.completed).toBe(0);
  expect(result?.todos.map((t) => t.content)).toEqual(["Set up scaffolding", "Write tests"]);
  expect(result?.todos.every((t) => t.status === "pending")).toBe(true);
});

test("TaskCreate numbering follows the tool_result even when results resolve out of creation order", () => {
  // Result for call_2 lands before call_1's in the event stream — the task
  // number must still come from the parsed "Task #N" text, not array order.
  const events = [
    taskCreateEvent("call_1", "First created, numbered last", undefined),
    taskCreateEvent("call_2", "Second created, numbered first", undefined),
    taskCreateResultEvent("call_2", 1, "Second created, numbered first"),
    taskCreateResultEvent("call_1", 2, "First created, numbered last"),
  ];
  const result = deriveTodoProgress(events);
  expect(result?.todos.map((t) => t.content)).toEqual([
    "Second created, numbered first",
    "First created, numbered last",
  ]);
});

test("TaskCreate without a tool_result falls back to sequential numbering in creation order", () => {
  const events = [
    taskCreateEvent("call_1", "Task A"),
    taskCreateEvent("call_2", "Task B"),
    taskCreateEvent("call_3", "Task C"),
  ];
  const result = deriveTodoProgress(events);
  expect(result).not.toBeNull();
  expect(result?.total).toBe(3);
  expect(result?.todos.map((t) => t.content)).toEqual(["Task A", "Task B", "Task C"]);
});

test("TaskCreate whose tool_result content is unparseable falls back to sequential numbering", () => {
  const events = [
    taskCreateEvent("call_1", "Task A"),
    baseEvent({
      stream: "tool_result",
      data: JSON.stringify({ toolUseId: "call_1", content: "some unrelated result text", isError: false }),
    }),
  ];
  const result = deriveTodoProgress(events);
  expect(result?.total).toBe(1);
  expect(result?.todos[0]?.content).toBe("Task A");
  expect(result?.todos[0]?.status).toBe("pending");
});

test("TaskUpdate moves a task to in_progress and carries the created activeForm through", () => {
  const events = [
    taskCreateEvent("call_1", "Task A", "Doing task A"),
    taskCreateResultEvent("call_1", 1, "Task A"),
    taskUpdateEvent("1", { status: "in_progress" }),
  ];
  const result = deriveTodoProgress(events);
  expect(result?.todos[0]?.status).toBe("in_progress");
  expect(result?.activeForm).toBe("Doing task A");
});

test("TaskUpdate moves a task to completed", () => {
  const events = [
    taskCreateEvent("call_1", "Task A"),
    taskCreateResultEvent("call_1", 1, "Task A"),
    taskUpdateEvent("1", { status: "in_progress" }),
    taskUpdateEvent("1", { status: "completed" }),
  ];
  const result = deriveTodoProgress(events);
  expect(result?.todos[0]?.status).toBe("completed");
  expect(result?.completed).toBe(1);
});

test("TaskUpdate with an unknown taskId is tolerated and ignored", () => {
  const events = [
    taskCreateEvent("call_1", "Task A"),
    taskCreateResultEvent("call_1", 1, "Task A"),
    taskUpdateEvent("999", { status: "completed" }),
  ];
  const result = deriveTodoProgress(events);
  expect(result?.total).toBe(1);
  expect(result?.todos[0]?.status).toBe("pending");
});

test("TaskUpdate with an unknown status value is tolerated — item is left as-is", () => {
  const events = [
    taskCreateEvent("call_1", "Task A"),
    taskCreateResultEvent("call_1", 1, "Task A"),
    taskUpdateEvent("1", { status: "in_progress" }),
    taskUpdateEvent("1", { status: "some-future-status" }),
  ];
  const result = deriveTodoProgress(events);
  expect(result?.todos[0]?.status).toBe("in_progress");
});

test("TaskUpdate can edit the subject/content of an existing task", () => {
  const events = [
    taskCreateEvent("call_1", "Original subject"),
    taskCreateResultEvent("call_1", 1, "Original subject"),
    taskUpdateEvent("1", { subject: "Revised subject" }),
  ];
  const result = deriveTodoProgress(events);
  expect(result?.todos[0]?.content).toBe("Revised subject");
});

test("TaskUpdate can edit subject and status together", () => {
  const events = [
    taskCreateEvent("call_1", "Original subject"),
    taskCreateResultEvent("call_1", 1, "Original subject"),
    taskUpdateEvent("1", { subject: "Revised subject", status: "completed" }),
  ];
  const result = deriveTodoProgress(events);
  expect(result?.todos[0]?.content).toBe("Revised subject");
  expect(result?.todos[0]?.status).toBe("completed");
});

test("no Task-tools or TodoWrite events at all yields null", () => {
  const events = [toolUseEvent("Read", { file_path: "/a.ts" })];
  expect(deriveTodoProgress(events)).toBeNull();
});

// ---------------------------------------------------------------------------
// Mixed sessions — recency of the last event in each family decides the winner
// ---------------------------------------------------------------------------

test("mixed session: TaskCreate/TaskUpdate activity after a TodoWrite snapshot wins", () => {
  const events = [
    todoWriteEvent([
      { content: "Legacy A", status: "completed" },
      { content: "Legacy B", status: "pending" },
    ]),
    taskCreateEvent("call_1", "New task A"),
    taskCreateResultEvent("call_1", 1, "New task A"),
    taskCreateEvent("call_2", "New task B"),
    taskCreateResultEvent("call_2", 2, "New task B"),
  ];
  const result = deriveTodoProgress(events);
  expect(result?.todos.map((t) => t.content)).toEqual(["New task A", "New task B"]);
});

test("mixed session: a TodoWrite snapshot after Task-tools activity replaces the accumulated list", () => {
  const events = [
    taskCreateEvent("call_1", "Old task A"),
    taskCreateResultEvent("call_1", 1, "Old task A"),
    taskCreateEvent("call_2", "Old task B"),
    taskCreateResultEvent("call_2", 2, "Old task B"),
    todoWriteEvent([
      { content: "Resumed A", status: "in_progress", activeForm: "Resuming A" },
      { content: "Resumed B", status: "pending" },
    ]),
  ];
  const result = deriveTodoProgress(events);
  expect(result?.todos.map((t) => t.content)).toEqual(["Resumed A", "Resumed B"]);
  expect(result?.activeForm).toBe("Resuming A");
});

// ---------------------------------------------------------------------------
// Run-scoped accumulation — a re-run must not leave a stale tail from a
// prior run's Task-tools numbering (finding: task accumulation spans runs
// and never resets).
// ---------------------------------------------------------------------------

test("a second run whose TaskCreate numbering restarts at 1 resets the accumulation — no stale tail", () => {
  const events = [
    // Run 1: three tasks created and result-numbered 1, 2, 3.
    taskCreateEvent("call_1", "Run1 task A", undefined, { runId: "run-1" }),
    taskCreateResultEvent("call_1", 1, "Run1 task A", { runId: "run-1" }),
    taskCreateEvent("call_2", "Run1 task B", undefined, { runId: "run-1" }),
    taskCreateResultEvent("call_2", 2, "Run1 task B", { runId: "run-1" }),
    taskCreateEvent("call_3", "Run1 task C", undefined, { runId: "run-1" }),
    taskCreateResultEvent("call_3", 3, "Run1 task C", { runId: "run-1" }),
    // Run 2 (a fresh turn/session): numbering restarts at 1 — only one task
    // this time. Without the run-scoped reset, run 1's tasks #2 and #3 would
    // survive untouched and inflate the total to 4.
    taskCreateEvent("call_4", "Run2 task A", undefined, { runId: "run-2" }),
    taskCreateResultEvent("call_4", 1, "Run2 task A", { runId: "run-2" }),
  ];
  const result = deriveTodoProgress(events);
  expect(result).not.toBeNull();
  expect(result?.total).toBe(1);
  expect(result?.todos.map((t) => t.content)).toEqual(["Run2 task A"]);
});

test("TaskUpdate within the same run after the reset still resolves against the new run's items", () => {
  const events = [
    taskCreateEvent("call_1", "Run1 task A", undefined, { runId: "run-1" }),
    taskCreateResultEvent("call_1", 1, "Run1 task A", { runId: "run-1" }),
    taskCreateEvent("call_2", "Run2 task A", undefined, { runId: "run-2" }),
    taskCreateResultEvent("call_2", 1, "Run2 task A", { runId: "run-2" }),
    taskUpdateEvent("1", { status: "completed" }, { runId: "run-2" }),
  ];
  const result = deriveTodoProgress(events);
  expect(result?.total).toBe(1);
  expect(result?.todos[0]?.content).toBe("Run2 task A");
  expect(result?.todos[0]?.status).toBe("completed");
});

test("events with no runId at all behave exactly as before (no spurious reset)", () => {
  // Every prior test in this file omits runId on some events / relies on the
  // shared "r1" default from baseEvent — the reset logic must never fire
  // when runId is absent/constant, preserving backward compatibility.
  const events = [
    taskCreateEvent("call_1", "Task A"),
    taskCreateResultEvent("call_1", 1, "Task A"),
    taskCreateEvent("call_2", "Task B"),
    taskCreateResultEvent("call_2", 2, "Task B"),
  ];
  const result = deriveTodoProgress(events);
  expect(result?.total).toBe(2);
});

// ---------------------------------------------------------------------------
// TaskCreate number collisions must never silently drop a task (finding:
// sequential-fallback numbers can collide with a result-derived number).
// ---------------------------------------------------------------------------

test("a sequential-fallback number colliding with an existing result-derived entry does not overwrite it", () => {
  const events = [
    // call_1 is result-numbered #3 (an out-of-order/high number, as Claude
    // can assign).
    taskCreateEvent("call_1", "Result-numbered as #3"),
    taskCreateResultEvent("call_1", 3, "Result-numbered as #3"),
    // call_2 has no result — falls back to sequential count 2 (no collision).
    taskCreateEvent("call_2", "Fallback-numbered #2"),
    // call_3 has no result — falls back to sequential count 3, which COLLIDES
    // with call_1's result-derived slot #3. Before the fix this silently
    // overwrote call_1's entry, dropping it.
    taskCreateEvent("call_3", "Fallback-numbered, collides at #3"),
  ];
  const result = deriveTodoProgress(events);
  expect(result).not.toBeNull();
  // All three tasks must survive — none is silently dropped by the collision.
  expect(result?.total).toBe(3);
  const contents = result?.todos.map((t) => t.content) ?? [];
  expect(contents).toContain("Result-numbered as #3");
  expect(contents).toContain("Fallback-numbered #2");
  expect(contents).toContain("Fallback-numbered, collides at #3");
});

test("mixed session: Task-tools resumes again after the TodoWrite snapshot", () => {
  const events = [
    todoWriteEvent([{ content: "Legacy A", status: "completed" }]),
    taskCreateEvent("call_1", "Fresh task A"),
    taskCreateResultEvent("call_1", 1, "Fresh task A"),
    todoWriteEvent([{ content: "Stale snapshot", status: "pending" }]),
    taskUpdateEvent("1", { status: "in_progress" }),
  ];
  const result = deriveTodoProgress(events);
  expect(result?.todos.map((t) => t.content)).toEqual(["Fresh task A"]);
  expect(result?.todos[0]?.status).toBe("in_progress");
});

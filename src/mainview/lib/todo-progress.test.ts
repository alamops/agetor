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

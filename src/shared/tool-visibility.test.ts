import { test, expect } from "bun:test";
import { isHiddenToolEvent } from "./tool-visibility.ts";

test("an internal tool_use and its internal tool_result are hidden", () => {
  expect(
    isHiddenToolEvent("tool_use", JSON.stringify({ id: "call_1", name: "capability_search", input: {}, internal: true })),
  ).toBe(true);
  expect(
    isHiddenToolEvent("tool_result", JSON.stringify({ toolUseId: "call_1", content: "ok", isError: false, internal: true })),
  ).toBe(true);
});

test("a tool event without the internal flag stays visible", () => {
  expect(isHiddenToolEvent("tool_use", JSON.stringify({ id: "call_2", name: "shell", input: { cmd: "ls" } }))).toBe(false);
  expect(isHiddenToolEvent("tool_result", JSON.stringify({ toolUseId: "call_2", content: "a\nb" }))).toBe(false);
  expect(isHiddenToolEvent("tool_use", JSON.stringify({ id: "call_3", name: "shell", internal: false }))).toBe(false);
  // Only the boolean `true` hides — a truthy string doesn't.
  expect(isHiddenToolEvent("tool_use", JSON.stringify({ id: "call_4", name: "shell", internal: "true" }))).toBe(false);
});

test("non-tool streams are never hidden, even with a top-level internal flag", () => {
  const body = JSON.stringify({ internal: true });
  for (const stream of ["status", "assistant", "thinking", "user", "stdout", "stderr", "interaction"]) {
    expect(isHiddenToolEvent(stream, body)).toBe(false);
  }
});

test("the marker nested in an object or quoted in a string doesn't hide the event", () => {
  expect(
    isHiddenToolEvent("tool_use", JSON.stringify({ id: "call_5", name: "write_file", input: { internal: true } })),
  ).toBe(false);
  expect(
    isHiddenToolEvent(
      "tool_result",
      JSON.stringify({ toolUseId: "call_5", content: [{ type: "text", text: '{"internal":true}' }] }),
    ),
  ).toBe(false);
  expect(isHiddenToolEvent("tool_result", JSON.stringify({ toolUseId: "call_6", content: 'saw "internal":true in a log' }))).toBe(false);
});

test("malformed or non-object JSON is not hidden and never throws", () => {
  expect(isHiddenToolEvent("tool_use", '{"internal":true')).toBe(false);
  expect(isHiddenToolEvent("tool_use", 'not json "internal":true')).toBe(false);
  expect(isHiddenToolEvent("tool_use", '["internal":true]')).toBe(false);
  expect(isHiddenToolEvent("tool_use", JSON.stringify(['"internal":true']))).toBe(false);
  expect(isHiddenToolEvent("tool_use", "")).toBe(false);
});

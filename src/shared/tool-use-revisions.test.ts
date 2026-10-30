import { test, expect } from "bun:test";
import { foldToolUseRevisions, supersededToolUseIndexes } from "./tool-use-revisions.ts";

test("keeps the latest tool_use for an id and leaves other streams alone", () => {
  const events = [
    { stream: "tool_use", data: JSON.stringify({ id: "a", name: "shell", input: { command: "l" } }) },
    { stream: "assistant", data: "working" },
    { stream: "tool_use", data: JSON.stringify({ id: "a", name: "shell", input: { command: "ls" } }) },
    { stream: "tool_use", data: JSON.stringify({ id: "b", name: "read" }) },
    { stream: "tool_result", data: JSON.stringify({ toolUseId: "a", content: "ok" }) },
  ];
  expect([...supersededToolUseIndexes(events)]).toEqual([0]);
});

test("a tool_use without an id is never superseded", () => {
  const events = [
    { stream: "tool_use", data: "{" },
    { stream: "tool_use", data: JSON.stringify({ name: "shell" }) },
  ];
  expect(supersededToolUseIndexes(events).size).toBe(0);
});

test("foldToolUseRevisions drops the partial and returns the same array when nothing is revised", () => {
  const revised = [
    { stream: "tool_use", data: JSON.stringify({ id: "a", name: "shell", input: { command: "l" } }) },
    { stream: "tool_use", data: JSON.stringify({ id: "a", name: "shell", input: { command: "ls" } }) },
  ];
  expect(foldToolUseRevisions(revised)).toEqual([revised[1]!]);
  const single = [{ stream: "assistant", data: "ok" }];
  expect(foldToolUseRevisions(single)).toBe(single);
});

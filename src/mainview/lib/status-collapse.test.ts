import { expect, test } from "bun:test";
import type { RunEvent } from "../../shared/types.ts";
import { collapseRepeatedModeStatus } from "./status-collapse.ts";

const ev = (e: Partial<RunEvent>): RunEvent => ({
  runId: "run-1",
  taskId: "task-1",
  stream: "status",
  data: "",
  ts: 0,
  ...e,
});

test("collapseRepeatedModeStatus: consecutive identical permission-mode status events collapse to one", () => {
  const events = [
    ev({ data: "permission-mode: auto", ts: 1 }),
    ev({ data: "permission-mode: auto", ts: 2 }),
    ev({ data: "permission-mode: auto", ts: 3 }),
  ];
  const result = collapseRepeatedModeStatus(events);
  expect(result).toHaveLength(1);
  expect(result[0]).toBe(events[0]);
});

test("collapseRepeatedModeStatus: duplicates are collapsed even with non-status content interleaved", () => {
  const events = [
    ev({ data: "permission-mode: auto", ts: 1 }),
    ev({ stream: "assistant", data: "hello there", ts: 2 }),
    ev({ stream: "tool_use", data: JSON.stringify({ id: "1", name: "Bash", input: "ls" }), ts: 3 }),
    ev({ data: "permission-mode: auto", ts: 4 }),
  ];
  const result = collapseRepeatedModeStatus(events);
  expect(result).toEqual(events.slice(0, 3));
});

test("collapseRepeatedModeStatus: a mode change is kept — auto, auto, plan, plan, auto collapses to auto, plan, auto", () => {
  const events = [
    ev({ data: "permission-mode: auto", ts: 1 }),
    ev({ data: "permission-mode: auto", ts: 2 }),
    ev({ data: "permission-mode: plan", ts: 3 }),
    ev({ data: "permission-mode: plan", ts: 4 }),
    ev({ data: "permission-mode: auto", ts: 5 }),
  ];
  const result = collapseRepeatedModeStatus(events);
  expect(result.map((e) => e.data)).toEqual([
    "permission-mode: auto",
    "permission-mode: plan",
    "permission-mode: auto",
  ]);
});

test("collapseRepeatedModeStatus: other status texts are never dropped, even repeated, and don't reset the tracker", () => {
  const events = [
    ev({ data: "permission-mode: auto", ts: 1 }),
    ev({ data: "turn complete", ts: 2 }),
    ev({ data: "turn complete", ts: 3 }),
    ev({ data: "turn duration: 2m", ts: 4 }),
    ev({ data: "turn duration: 2m", ts: 5 }),
    // Same permission-mode value as before, with unrelated status text in
    // between — those don't reset the tracked mode, so this is still dropped.
    ev({ data: "permission-mode: auto", ts: 6 }),
  ];
  const result = collapseRepeatedModeStatus(events);
  expect(result.map((e) => e.data)).toEqual([
    "permission-mode: auto",
    "turn complete",
    "turn complete",
    "turn duration: 2m",
    "turn duration: 2m",
  ]);
});

test("collapseRepeatedModeStatus: non-status streams with data coincidentally matching a permission-mode string are untouched and don't affect the tracker", () => {
  const events = [
    ev({ stream: "assistant", data: "permission-mode: auto", ts: 1 }),
    ev({ data: "permission-mode: auto", ts: 2 }),
    ev({ data: "permission-mode: auto", ts: 3 }),
  ];
  const result = collapseRepeatedModeStatus(events);
  // The assistant event passes through untouched; of the two genuine status
  // events, only the first is kept.
  expect(result).toEqual(events.slice(0, 2));
});

test("collapseRepeatedModeStatus: empty list returns an empty list", () => {
  expect(collapseRepeatedModeStatus([])).toEqual([]);
});

test("collapseRepeatedModeStatus: does not mutate the input array", () => {
  const events = [
    ev({ data: "permission-mode: auto", ts: 1 }),
    ev({ data: "permission-mode: auto", ts: 2 }),
    ev({ data: "permission-mode: plan", ts: 3 }),
  ];
  const snapshot = [...events];
  const result = collapseRepeatedModeStatus(events);
  expect(events).toHaveLength(snapshot.length);
  expect(events).toEqual(snapshot);
  // The returned array is a distinct, shorter collapsed list.
  expect(result).not.toBe(events);
  expect(result.length).toBeLessThan(events.length);
});

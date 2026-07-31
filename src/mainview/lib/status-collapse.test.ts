import { expect, test } from "bun:test";
import type { RunEvent } from "../../shared/types.ts";
import { collapseRepeatedStatusChips } from "./status-collapse.ts";

const ev = (e: Partial<RunEvent>): RunEvent => ({
  runId: "run-1",
  taskId: "task-1",
  stream: "status",
  data: "",
  ts: 0,
  ...e,
});

test("collapseRepeatedStatusChips: consecutive identical permission-mode status events collapse to one", () => {
  const events = [
    ev({ data: "permission-mode: auto", ts: 1 }),
    ev({ data: "permission-mode: auto", ts: 2 }),
    ev({ data: "permission-mode: auto", ts: 3 }),
  ];
  const result = collapseRepeatedStatusChips(events);
  expect(result).toHaveLength(1);
  expect(result[0]).toBe(events[0]);
});

test("collapseRepeatedStatusChips: duplicates are collapsed even with non-status content interleaved", () => {
  const events = [
    ev({ data: "permission-mode: auto", ts: 1 }),
    ev({ stream: "assistant", data: "hello there", ts: 2 }),
    ev({ stream: "tool_use", data: JSON.stringify({ id: "1", name: "Bash", input: "ls" }), ts: 3 }),
    ev({ data: "permission-mode: auto", ts: 4 }),
  ];
  const result = collapseRepeatedStatusChips(events);
  expect(result).toEqual(events.slice(0, 3));
});

test("collapseRepeatedStatusChips: a mode change is kept — auto, auto, plan, plan, auto collapses to auto, plan, auto", () => {
  const events = [
    ev({ data: "permission-mode: auto", ts: 1 }),
    ev({ data: "permission-mode: auto", ts: 2 }),
    ev({ data: "permission-mode: plan", ts: 3 }),
    ev({ data: "permission-mode: plan", ts: 4 }),
    ev({ data: "permission-mode: auto", ts: 5 }),
  ];
  const result = collapseRepeatedStatusChips(events);
  expect(result.map((e) => e.data)).toEqual([
    "permission-mode: auto",
    "permission-mode: plan",
    "permission-mode: auto",
  ]);
});

test("collapseRepeatedStatusChips: other status texts are never dropped, even repeated, and don't reset the tracker", () => {
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
  const result = collapseRepeatedStatusChips(events);
  expect(result.map((e) => e.data)).toEqual([
    "permission-mode: auto",
    "turn complete",
    "turn complete",
    "turn duration: 2m",
    "turn duration: 2m",
  ]);
});

test("collapseRepeatedStatusChips: non-status streams with data coincidentally matching a permission-mode string are untouched and don't affect the tracker", () => {
  const events = [
    ev({ stream: "assistant", data: "permission-mode: auto", ts: 1 }),
    ev({ data: "permission-mode: auto", ts: 2 }),
    ev({ data: "permission-mode: auto", ts: 3 }),
  ];
  const result = collapseRepeatedStatusChips(events);
  // The assistant event passes through untouched; of the two genuine status
  // events, only the first is kept.
  expect(result).toEqual(events.slice(0, 2));
});

test("collapseRepeatedStatusChips: empty list returns an empty list", () => {
  expect(collapseRepeatedStatusChips([])).toEqual([]);
});

test("collapseRepeatedStatusChips: N consecutive identical hibernate chips collapse to one", () => {
  const hibernate = "session hibernated after 30m idle — next message will resume it";
  const events = [
    ev({ data: hibernate, ts: 1 }),
    ev({ data: hibernate, ts: 2 }),
    ev({ data: hibernate, ts: 3 }),
    ev({ data: hibernate, ts: 4 }),
    ev({ data: hibernate, ts: 5 }),
  ];
  const result = collapseRepeatedStatusChips(events);
  expect(result).toHaveLength(1);
  expect(result[0]).toBe(events[0]);
});

test("collapseRepeatedStatusChips: identical hibernate chips from DIFFERENT runs are both kept even when adjacent", () => {
  // The main tab's JSONL-rebuild path re-stamps a rebuilt run's events with
  // synthetic clustered timestamps and keeps only live-history `status`
  // events, which can sort two runs' genuine hibernate breadcrumbs right
  // next to each other. Same-run adjacency is the reaper-spam signature;
  // cross-run adjacency is two real hibernates and must survive.
  const hibernate = "session hibernated after 30m idle — next message will resume it";
  const events = [
    ev({ data: hibernate, runId: "run-1", ts: 1 }),
    ev({ data: hibernate, runId: "run-2", ts: 2 }),
  ];
  const result = collapseRepeatedStatusChips(events);
  expect(result).toEqual(events);
});

test("collapseRepeatedStatusChips: hibernate chips separated by a user or assistant event are both kept", () => {
  const hibernate = "session hibernated after 30m idle — next message will resume it";
  const events = [
    ev({ data: hibernate, ts: 1 }),
    ev({ stream: "user", data: "resume please", ts: 2 }),
    ev({ data: hibernate, ts: 3 }),
    ev({ stream: "assistant", data: "on it", ts: 4 }),
    ev({ data: hibernate, ts: 5 }),
  ];
  const result = collapseRepeatedStatusChips(events);
  expect(result).toEqual(events);
});

test("collapseRepeatedStatusChips: the two different hibernate texts adjacent are both kept", () => {
  const events = [
    ev({ data: "session hibernated after 30m idle — next message will resume it", ts: 1 }),
    ev({
      data: "session hibernated after 30m idle — no saved session id, next message starts a fresh context",
      ts: 2,
    }),
  ];
  const result = collapseRepeatedStatusChips(events);
  expect(result).toEqual(events);
});

test("collapseRepeatedStatusChips: hibernate collapse and permission-mode tracker don't disturb each other (mixed sequence)", () => {
  const hibernate = "session hibernated after 30m idle — next message will resume it";
  const events = [
    ev({ data: "permission-mode: auto", ts: 1 }),
    ev({ data: "permission-mode: auto", ts: 2 }), // dropped (mode-tracker dup)
    ev({ data: hibernate, ts: 3 }),
    ev({ data: hibernate, ts: 4 }), // dropped (adjacent hibernate dup)
    ev({ data: hibernate, ts: 5 }), // dropped (adjacent hibernate dup, prev kept was also hibernate)
    ev({ data: "permission-mode: plan", ts: 6 }), // kept — mode change, also breaks hibernate adjacency
    ev({ data: hibernate, ts: 7 }), // kept — immediately-preceding kept event is not this same status
    ev({ data: "permission-mode: plan", ts: 8 }), // dropped (mode-tracker dup, unaffected by hibernate in between)
  ];
  const result = collapseRepeatedStatusChips(events);
  expect(result.map((e) => e.data)).toEqual([
    "permission-mode: auto",
    hibernate,
    "permission-mode: plan",
    hibernate,
  ]);
});

test("collapseRepeatedStatusChips: a non-status event with identical hibernate text doesn't trigger the drop", () => {
  const hibernate = "session hibernated after 30m idle — next message will resume it";
  const events = [
    ev({ stream: "assistant", data: hibernate, ts: 1 }),
    ev({ data: hibernate, ts: 2 }),
  ];
  const result = collapseRepeatedStatusChips(events);
  expect(result).toEqual(events);
});

test("collapseRepeatedStatusChips: does not mutate the input array", () => {
  const events = [
    ev({ data: "permission-mode: auto", ts: 1 }),
    ev({ data: "permission-mode: auto", ts: 2 }),
    ev({ data: "permission-mode: plan", ts: 3 }),
  ];
  const snapshot = [...events];
  const result = collapseRepeatedStatusChips(events);
  expect(events).toHaveLength(snapshot.length);
  expect(events).toEqual(snapshot);
  // The returned array is a distinct, shorter collapsed list.
  expect(result).not.toBe(events);
  expect(result.length).toBeLessThan(events.length);
});

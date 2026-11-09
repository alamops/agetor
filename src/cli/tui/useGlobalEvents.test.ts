import { test, expect } from "bun:test";
import { toastFor } from "./useGlobalEvents.ts";
import type { GlobalEvent } from "../../shared/types.ts";

const ID = "abcd1234efgh";

test("toastFor maps run-status to colored toasts", () => {
  expect(toastFor({ kind: "run-status", taskId: ID, runId: "r", status: "succeeded", ts: 1 })?.color).toBe("green");
  expect(toastFor({ kind: "run-status", taskId: ID, runId: "r", status: "failed", ts: 1 })?.color).toBe("red");
  expect(toastFor({ kind: "run-status", taskId: ID, runId: "r", status: "orphaned", ts: 1 })?.color).toBe("yellow");
  // cancelled is user-initiated → no toast
  expect(toastFor({ kind: "run-status", taskId: ID, runId: "r", status: "cancelled", ts: 1 })).toBeNull();
});

test("toastFor flags only the blocked column transition", () => {
  const blocked = toastFor({ kind: "column", taskId: ID, runId: "r", column: "blocked", prev: "running", ts: 1, reason: "api-error" });
  expect(blocked?.color).toBe("yellow");
  expect(blocked?.text).toContain("API error");
  expect(toastFor({ kind: "column", taskId: ID, runId: "r", column: "review", prev: "running", ts: 1 })).toBeNull();
});

test("toastFor ignores update events", () => {
  expect(
    toastFor({ kind: "update", status: "available", version: "1.2.3", message: null, ts: 1 } as unknown as GlobalEvent),
  ).toBeNull();
});

// m3 review fix (docs/plans/pipelines.md D11): a hidden pipeline step task's
// run-status/blocked events must never surface a board-wide toast naming a
// task id the TUI hides from its board — the parent's own column/pipeline
// events cover the same information.
test("toastFor: hiddenTaskIds suppresses run-status and blocked-column toasts for that task", () => {
  const hidden = new Set([ID]);
  expect(toastFor({ kind: "run-status", taskId: ID, runId: "r", status: "succeeded", ts: 1 }, hidden)).toBeNull();
  expect(
    toastFor({ kind: "column", taskId: ID, runId: "r", column: "blocked", prev: "running", ts: 1 }, hidden),
  ).toBeNull();
});

// Cross-agent contract (a): the event's own `pipelineParentId` stamp hides
// it even when the dashboard's `hiddenTaskIds` set hasn't caught up (a step
// that settled before its row was ever polled).
test("toastFor: an event stamped with pipelineParentId is suppressed even when hiddenTaskIds doesn't know the task", () => {
  const stamped = { kind: "run-status", taskId: ID, runId: "r", status: "failed", ts: 1, pipelineParentId: "parent-1" } as unknown as GlobalEvent;
  expect(toastFor(stamped, new Set())).toBeNull();
  expect(toastFor(stamped)).toBeNull();
  const blocked = { kind: "column", taskId: ID, runId: "r", column: "blocked", prev: "running", ts: 1, pipelineParentId: "parent-1" } as unknown as GlobalEvent;
  expect(toastFor(blocked)).toBeNull();
});

test("toastFor: hiddenTaskIds doesn't affect other tasks' toasts", () => {
  const hidden = new Set(["some-other-task"]);
  expect(toastFor({ kind: "run-status", taskId: ID, runId: "r", status: "succeeded", ts: 1 }, hidden)?.color).toBe(
    "green",
  );
});

test("toastFor: a harness swap is a quiet informational line and respects pipeline hiding", () => {
  const ev = {
    kind: "harness-swap", taskId: ID, from: "a", to: "b", fromLabel: "Work", toLabel: "Backup",
    reason: "quota", position: 2, count: 3, ts: 1,
  } as unknown as GlobalEvent;
  expect(toastFor(ev)?.color).toBe("cyan");
  expect(toastFor(ev)?.text).toContain("Backup");
  expect(toastFor(ev)?.text).toContain("(2/3)");
  const lone = { ...(ev as object), position: 1, count: 1 } as unknown as GlobalEvent;
  expect(toastFor(lone)?.text).not.toContain("1/1");
  expect(toastFor(ev, new Set([ID]))).toBeNull();
  // A stored label with ESC / a line break cannot repaint the dashboard.
  const hostile = { ...(ev as object), toLabel: "Bad\u001b[2Jlabel\nnext" } as unknown as GlobalEvent;
  const text = toastFor(hostile)?.text ?? "";
  expect(text).not.toContain("\u001b");
  expect(text).not.toContain("\n");
});

test("toastFor: stack blocked reasons get a specific hint", () => {
  const ev = {
    kind: "column", taskId: ID, runId: "r", column: "blocked", prev: "running", ts: 1,
    reason: "harness-exhausted",
  } as unknown as GlobalEvent;
  expect(toastFor(ev)?.text).toContain("stack out of quota");
  const failed = { ...(ev as object), reason: "harness-swap-failed" } as unknown as GlobalEvent;
  expect(toastFor(failed)?.text).toContain("no usable backup account");
});

test("toastFor: the old run's failover/exhausted failure never paints a failed toast", () => {
  for (const reason of ["harness-swap", "harness-exhausted"] as const) {
    const ev = {
      kind: "run-status", taskId: ID, runId: "r", status: "failed", reason, ts: 1,
    } as unknown as GlobalEvent;
    expect(toastFor(ev), reason).toBeNull();
  }
  // A genuine failure still does.
  expect(toastFor({
    kind: "run-status", taskId: ID, runId: "r", status: "failed", ts: 1,
  } as unknown as GlobalEvent)?.color).toBe("red");
});

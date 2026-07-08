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

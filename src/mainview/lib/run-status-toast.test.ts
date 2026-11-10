import { expect, test } from "bun:test";
import { runStatusToastKind } from "./run-status-toast.ts";

test("success and plain failures toast as before", () => {
  expect(runStatusToastKind({ status: "succeeded" })).toBe("success");
  expect(runStatusToastKind({ status: "failed" })).toBe("error");
  expect(runStatusToastKind({ status: "orphaned" })).toBe("error");
});

test("a harness-stack failover settle never reads as 'Task failed' (S27)", () => {
  expect(runStatusToastKind({ status: "failed", reason: "harness-swap" })).toBeNull();
  expect(runStatusToastKind({ status: "failed", reason: "harness-exhausted" })).toBeNull();
  expect(runStatusToastKind({ status: "orphaned", reason: "harness-swap" })).toBeNull();
  expect(runStatusToastKind({ status: "orphaned", reason: "harness-exhausted" })).toBeNull();
});

test("a success carrying a reason still toasts success; a cancel is silent", () => {
  expect(runStatusToastKind({ status: "succeeded", reason: "harness-swap" })).toBe("success");
  expect(runStatusToastKind({ status: "cancelled" })).toBeNull();
});

/* Gate tests for the in-memory turn-stall registry — the orchestrator-side
 * half of the stall watchdog (claude-tmux emits the sentinel, the chunk
 * handler marks here, server.ts decorates `Task.stalledSince` from here). */

import { test, expect, beforeEach } from "bun:test";
import { markStalled, clearStalled, stalledSince, __clearAllStalled } from "./stall-registry.ts";

beforeEach(() => __clearAllStalled());

test("mark → read → clear round-trip; unknown tasks read null", () => {
  expect(stalledSince("a")).toBeNull();
  markStalled("a", 1_000);
  expect(stalledSince("a")).toBe(1_000);
  clearStalled("a");
  expect(stalledSince("a")).toBeNull();
  // Clearing an unmarked task is a no-op, not an error.
  clearStalled("never-marked");
});

test("first mark wins — a repeated sentinel for the same stall keeps the original timestamp", () => {
  markStalled("a", 1_000);
  markStalled("a", 2_000);
  expect(stalledSince("a")).toBe(1_000);
  // A clear resets the slate: the NEXT stall gets its own timestamp.
  clearStalled("a");
  markStalled("a", 3_000);
  expect(stalledSince("a")).toBe(3_000);
});

test("tasks are independent", () => {
  markStalled("a", 1_000);
  expect(stalledSince("b")).toBeNull();
  clearStalled("b");
  expect(stalledSince("a")).toBe(1_000);
});

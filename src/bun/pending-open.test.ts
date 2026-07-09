import { test, expect, beforeEach } from "bun:test";
import { PENDING_OPEN_TTL_MS, setPendingOpenTask, consumePendingOpenTask } from "./pending-open.ts";

// Module-level singleton state — clear any residue before each test so tests
// don't bleed into each other (mirrors the note in the module's own doc
// comment about testability via injectable `now`).
beforeEach(() => {
  consumePendingOpenTask();
});

test("set then consume returns the taskId", () => {
  setPendingOpenTask("t1");
  expect(consumePendingOpenTask()).toBe("t1");
});

test("consume clears — an immediate second consume returns null", () => {
  setPendingOpenTask("t1");
  expect(consumePendingOpenTask()).toBe("t1");
  expect(consumePendingOpenTask()).toBeNull();
});

test("consume with nothing set returns null", () => {
  expect(consumePendingOpenTask()).toBeNull();
});

test("TTL boundary: exactly at TTL is not stale", () => {
  setPendingOpenTask("t", 1000);
  expect(consumePendingOpenTask(1000 + PENDING_OPEN_TTL_MS)).toBe("t");
});

test("TTL boundary: one ms past TTL is stale and dropped", () => {
  setPendingOpenTask("t", 1000);
  expect(consumePendingOpenTask(1000 + PENDING_OPEN_TTL_MS + 1)).toBeNull();
});

test("coalesce: a second set before consume overwrites the first", () => {
  setPendingOpenTask("a");
  setPendingOpenTask("b");
  expect(consumePendingOpenTask()).toBe("b");
});

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

// The native-menu slot shares the 10 s TTL and the consume-clears rule.
import { consumePendingMenuAction, setPendingMenuAction } from "./pending-open.ts";

test("menu action: set then consume returns it, and consume clears", () => {
  consumePendingMenuAction();
  setPendingMenuAction("git");
  expect(consumePendingMenuAction()).toBe("git");
  expect(consumePendingMenuAction()).toBeNull();
});

test("menu action: exactly at the TTL is deliverable, one ms past is dropped", () => {
  setPendingMenuAction("settings", 1000);
  expect(consumePendingMenuAction(1000 + PENDING_OPEN_TTL_MS)).toBe("settings");
  setPendingMenuAction("settings", 1000);
  expect(consumePendingMenuAction(1000 + PENDING_OPEN_TTL_MS + 1)).toBeNull();
});

test("menu action: a second set before consume replaces the first, and the open-task slot is separate", () => {
  consumePendingMenuAction();
  setPendingMenuAction("git");
  setPendingMenuAction("worktrees");
  setPendingOpenTask("t9");
  expect(consumePendingMenuAction()).toBe("worktrees");
  expect(consumePendingOpenTask()).toBe("t9");
});

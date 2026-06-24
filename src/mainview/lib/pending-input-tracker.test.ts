import { test, expect } from "bun:test";
import { PendingInputTracker } from "./pending-input-tracker.ts";

test("add signals only on the first prompt per task", () => {
  const t = new PendingInputTracker();
  expect(t.add("task-1", "a")).toBe(true);   // first → alert
  expect(t.add("task-1", "b")).toBe(false);  // stacked → no re-alert
  expect(t.add("task-2", "c")).toBe(true);   // different task → alert
});

test("add is idempotent for a repeated id", () => {
  const t = new PendingInputTracker();
  expect(t.add("task-1", "a")).toBe(true);
  // Re-delivery of the same pending id must not re-signal (set already non-empty).
  expect(t.add("task-1", "a")).toBe(false);
});

test("remove signals only when the last prompt resolves", () => {
  const t = new PendingInputTracker();
  t.add("task-1", "a");
  t.add("task-1", "b");
  expect(t.remove("task-1", "a")).toBe(false); // one still pending
  expect(t.remove("task-1", "b")).toBe(true);  // last gone → clear alert
});

test("remove of an unknown task or id is a no-op", () => {
  const t = new PendingInputTracker();
  expect(t.remove("nope", "x")).toBe(false);
  t.add("task-1", "a");
  expect(t.remove("task-1", "ghost")).toBe(false); // id never tracked
});

test("clearTask drops all tracking so the next prompt re-signals", () => {
  const t = new PendingInputTracker();
  t.add("task-1", "a");
  t.add("task-1", "b");
  t.clearTask("task-1");
  // After a terminal run cleared the task, a fresh prompt must alert again.
  expect(t.add("task-1", "c")).toBe(true);
});

test("clearTask is scoped to one task", () => {
  const t = new PendingInputTracker();
  t.add("task-1", "a");
  t.add("task-2", "b");
  t.clearTask("task-1");
  expect(t.add("task-1", "c")).toBe(true);   // cleared → re-signals
  expect(t.add("task-2", "d")).toBe(false);  // untouched → still tracked
});

import { test, expect } from "bun:test";
import { notifyFor, eventPipelineParentId } from "./notify.ts";
import type { GlobalEvent } from "../shared/types.ts";

const T = "task-abc-12345";

test("notifyFor fires for this task's terminal + blocked states only", () => {
  expect(notifyFor({ kind: "run-status", taskId: T, runId: "r", status: "succeeded", ts: 1 }, T)?.title).toContain("succeeded");
  expect(notifyFor({ kind: "run-status", taskId: T, runId: "r", status: "failed", ts: 1 }, T)?.title).toContain("failed");
  const blocked = notifyFor({ kind: "column", taskId: T, runId: "r", column: "blocked", prev: "running", ts: 1, reason: "api-error" }, T);
  expect(blocked?.title).toContain("needs you");
  expect(blocked?.body).toContain("API error");
  // cancelled is user-initiated → no notify
  expect(notifyFor({ kind: "run-status", taskId: T, runId: "r", status: "cancelled", ts: 1 }, T)).toBeNull();
  // a non-blocked column transition → no notify
  expect(notifyFor({ kind: "column", taskId: T, runId: "r", column: "review", prev: "running", ts: 1 }, T)).toBeNull();
});

test("notifyFor ignores events for other tasks", () => {
  expect(notifyFor({ kind: "run-status", taskId: "other-task", runId: "r", status: "succeeded", ts: 1 }, T)).toBeNull();
  expect(notifyFor({ kind: "column", taskId: "other-task", runId: "r", column: "blocked", prev: "running", ts: 1 }, T)).toBeNull();
});

// m3 review fix (docs/plans/pipelines.md D11): a hidden pipeline step task's
// own terminal/blocked events are suppressed even for a caller watching that
// exact task id (e.g. `agetor logs <stepTaskId> --notify`) — the parent's
// own column/pipeline-run transitions cover the same information at the
// level a step id, an implementation detail, isn't meaningful outside.
test("notifyFor: opts.hidden suppresses every notification for this task, even a terminal/blocked one", () => {
  expect(
    notifyFor({ kind: "run-status", taskId: T, runId: "r", status: "succeeded", ts: 1 }, T, { hidden: true }),
  ).toBeNull();
  expect(
    notifyFor(
      { kind: "column", taskId: T, runId: "r", column: "blocked", prev: "running", ts: 1, reason: "api-error" },
      T,
      { hidden: true },
    ),
  ).toBeNull();
});

// Cross-agent contract (a): the orchestrator stamps `pipelineParentId` on a
// step task's own events — read straight off the event, so a step that
// settles before the caller ever learned it was a step is still suppressed.
test("notifyFor: an event carrying pipelineParentId is suppressed even without opts.hidden", () => {
  const stamped = { kind: "run-status", taskId: T, runId: "r", status: "succeeded", ts: 1, pipelineParentId: "parent-1" } as unknown as GlobalEvent;
  expect(notifyFor(stamped, T)).toBeNull();
  const blocked = { kind: "column", taskId: T, runId: "r", column: "blocked", prev: "running", ts: 1, pipelineParentId: "parent-1" } as unknown as GlobalEvent;
  expect(notifyFor(blocked, T)).toBeNull();
});

test("eventPipelineParentId: reads a non-empty string stamp, null otherwise (older core / null / empty)", () => {
  expect(eventPipelineParentId({ kind: "run-status", taskId: T, runId: "r", status: "succeeded", ts: 1 })).toBeNull();
  expect(eventPipelineParentId({ kind: "run-status", taskId: T, runId: "r", status: "succeeded", ts: 1, pipelineParentId: null } as unknown as GlobalEvent)).toBeNull();
  expect(eventPipelineParentId({ kind: "run-status", taskId: T, runId: "r", status: "succeeded", ts: 1, pipelineParentId: "" } as unknown as GlobalEvent)).toBeNull();
  expect(eventPipelineParentId({ kind: "run-status", taskId: T, runId: "r", status: "succeeded", ts: 1, pipelineParentId: "p1" } as unknown as GlobalEvent)).toBe("p1");
});

test("notifyFor: opts.hidden: false (or omitted) behaves exactly as before", () => {
  expect(
    notifyFor({ kind: "run-status", taskId: T, runId: "r", status: "succeeded", ts: 1 }, T, { hidden: false })?.title,
  ).toContain("succeeded");
});

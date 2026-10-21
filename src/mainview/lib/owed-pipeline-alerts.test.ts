import { describe, expect, test } from "bun:test";
import type { PipelineBlock, PipelineRunState, Task } from "../../shared/types.ts";
import { OwedPipelineAlerts } from "./owed-pipeline-alerts";

type Parent = Pick<Task, "archivedAt" | "pipelineRun">;

function parent(status: PipelineRunState["status"], blocked: PipelineBlock[], archivedAt: number | null = null): Parent {
  return { archivedAt, pipelineRun: { status, blocked } as PipelineRunState };
}

const question = (taskId: string): PipelineBlock => ({
  taskId,
  stepId: `step-${taskId}`,
  kind: "step-blocked",
  message: `step "${taskId}" is waiting for you`,
});
/** No step row is running. */
const idle = () => false;
const running = (...ids: string[]) => (taskId: string) => ids.includes(taskId);

const failed = (taskId: string): PipelineBlock => ({
  taskId,
  stepId: `step-${taskId}`,
  kind: "handoff-missing",
  message: "no handoff",
});

describe("OwedPipelineAlerts", () => {
  test("nothing owed → wait, whatever the run says", () => {
    const o = new OwedPipelineAlerts();
    expect(o.decide("p", parent("blocked", [failed("b")]), idle)).toBe("wait");
  });

  test("another step still blocks the run → raise", () => {
    const o = new OwedPipelineAlerts();
    o.owe("p");
    o.noteAnswered("p", "a");
    expect(o.decide("p", parent("blocked", [question("a"), failed("b")]), idle)).toBe("raise");
  });

  test("only the answered step's question block remains → wait", () => {
    const o = new OwedPipelineAlerts();
    o.owe("p");
    o.noteAnswered("p", "a");
    expect(o.decide("p", parent("blocked", [question("a")]), idle)).toBe("wait");
  });

  test("the answered step's stale block is ignored while it runs again", () => {
    // The runner clears that block under the parent's lock, after the step's
    // own `running` column event: the parent's row lags behind for a while.
    const o = new OwedPipelineAlerts();
    o.owe("p");
    o.noteAnswered("p", "a");
    o.noteStepRunning("p", "a");
    expect(o.decide("p", parent("blocked", [question("a")]), running("a"))).toBe("wait");
  });

  test("a new block after the answered step settles again counts", () => {
    const o = new OwedPipelineAlerts();
    o.owe("p");
    o.noteAnswered("p", "a");
    o.noteStepRunning("p", "a");
    expect(o.decide("p", parent("blocked", [question("a")]), idle)).toBe("raise");
    expect(o.decide("p", parent("blocked", [failed("a")]), idle)).toBe("raise");
  });

  test("any block naming a running step is stale, whatever its kind", () => {
    const o = new OwedPipelineAlerts();
    o.owe("p");
    expect(o.decide("p", parent("blocked", [failed("b")]), running("b"))).toBe("wait");
    expect(o.decide("p", parent("blocked", [failed("b"), failed("c")]), running("b"))).toBe("raise");
  });

  test("a run-level block (no task) always counts", () => {
    const o = new OwedPipelineAlerts();
    o.owe("p");
    o.noteAnswered("p", "a");
    const capBlock: PipelineBlock = { taskId: null, stepId: "s", kind: "step-cap", message: "cap" };
    expect(o.decide("p", parent("blocked", [question("a"), capBlock]), idle)).toBe("raise");
  });

  test("the run left blocked, the parent is archived or gone → drop", () => {
    const o = new OwedPipelineAlerts();
    o.owe("p");
    expect(o.decide("p", parent("running", []), idle)).toBe("drop");
    expect(o.decide("p", parent("blocked", [failed("b")], 123), idle)).toBe("drop");
    expect(o.decide("p", undefined, idle)).toBe("drop");
  });

  test("forget clears the debt; owe is idempotent and keeps answered steps", () => {
    const o = new OwedPipelineAlerts();
    o.owe("p");
    o.noteAnswered("p", "a");
    o.owe("p");
    expect(o.decide("p", parent("blocked", [question("a")]), idle)).toBe("wait");
    expect(o.parentIds()).toEqual(["p"]);
    o.forget("p");
    expect(o.isOwed("p")).toBe(false);
    expect(o.parentIds()).toEqual([]);
  });

  test("notes for a parent that owes nothing are ignored", () => {
    const o = new OwedPipelineAlerts();
    o.noteAnswered("p", "a");
    expect(o.isOwed("p")).toBe(false);
  });

  test("an answered step is exempt only for its question block, not for any other block it carries", () => {
    // The step that asked later failed in a way that needs the user anyway
    // (no handoff): that block is a real reason to alert.
    const o = new OwedPipelineAlerts();
    o.owe("p");
    o.noteAnswered("p", "a");
    expect(o.decide("p", parent("blocked", [failed("a")]), idle)).toBe("raise");
  });

  test("a question block on a step whose question was NOT answered counts", () => {
    const o = new OwedPipelineAlerts();
    o.owe("p");
    o.noteAnswered("p", "a");
    expect(o.decide("p", parent("blocked", [question("a"), question("b")]), idle)).toBe("raise");
  });

  test("blocked with no blocks left (only the stale exemptions) → wait, so a later snapshot decides", () => {
    const o = new OwedPipelineAlerts();
    o.owe("p");
    expect(o.decide("p", parent("blocked", []), idle)).toBe("wait");
    expect(o.isOwed("p")).toBe(true);
  });

  test("a finished, cancelled or idle run, or a parent with no run state → drop", () => {
    const o = new OwedPipelineAlerts();
    o.owe("p");
    expect(o.decide("p", parent("done", []), idle)).toBe("drop");
    expect(o.decide("p", parent("cancelled", [failed("b")]), idle)).toBe("drop");
    expect(o.decide("p", parent("idle", []), idle)).toBe("drop");
    expect(o.decide("p", { archivedAt: null, pipelineRun: null }, idle)).toBe("drop");
  });

  test("decide never changes the debt itself; the caller forgets it after acting", () => {
    const o = new OwedPipelineAlerts();
    o.owe("p");
    expect(o.decide("p", parent("blocked", [failed("b")]), idle)).toBe("raise");
    expect(o.decide("p", parent("running", []), idle)).toBe("drop");
    expect(o.isOwed("p")).toBe(true);
  });

  test("debts are per parent", () => {
    const o = new OwedPipelineAlerts();
    o.owe("p1");
    o.owe("p2");
    o.noteAnswered("p1", "a");
    // p2 never had "a" answered, so its question block still counts there.
    expect(o.decide("p1", parent("blocked", [question("a")]), idle)).toBe("wait");
    expect(o.decide("p2", parent("blocked", [question("a")]), idle)).toBe("raise");
    o.forget("p1");
    expect(o.parentIds()).toEqual(["p2"]);
  });

  test("noteStepRunning for a parent that owes nothing is ignored", () => {
    const o = new OwedPipelineAlerts();
    o.noteStepRunning("p", "a");
    expect(o.isOwed("p")).toBe(false);
    expect(o.parentIds()).toEqual([]);
  });
});

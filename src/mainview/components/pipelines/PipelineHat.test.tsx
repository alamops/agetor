import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PipelineHat } from "./PipelineHat.tsx";
import { newStep } from "../../../shared/pipeline.ts";
import type { PipelineRunState, PipelineStepRecord } from "../../../shared/types.ts";

const steps = Array.from({ length: 10 }, (_, i) => newStep({ id: `s${i + 1}`, name: i === 2 ? "Implementing" : `Step ${i + 1}` }));
const rec = (seq: number, stepId: string, outcome: PipelineStepRecord["outcome"] = "succeeded", taskId: string | null = `t${seq}`): PipelineStepRecord => ({
  seq, stepId, taskId, startedAt: seq, endedAt: outcome ? seq + 1 : null, outcome, handoff: null, nextStepIds: [],
});

function run(over: Partial<PipelineRunState> = {}): PipelineRunState {
  return {
    pipelineId: "p1",
    pipelineName: "My Implementation Pipeline",
    snapshot: { graph: { steps, edges: [], startStepId: "s1" }, maxSteps: 25, profiles: {}, capturedAt: 0 },
    status: "running",
    active: [],
    joins: {},
    blocked: [],
    history: [],
    stepCount: 0,
    startedAt: 0,
    endedAt: null,
    ...over,
  };
}
const html = (r: PipelineRunState) => renderToStaticMarkup(<PipelineHat run={r} />);
const running = (extra: Partial<PipelineRunState> = {}) =>
  run({ history: [rec(1, "s1"), rec(2, "s2"), rec(3, "s3", null)], active: [{ stepId: "s3", taskId: "t3", seq: 3 }], ...extra });

describe("PipelineHat", () => {
  test("shows the full name without truncation, and a progress count that is never cut", () => {
    const m = html(running());
    expect(m).toContain("My Implementation Pipeline");
    expect(m).toContain("[overflow-wrap:anywhere]");
    expect(m).not.toMatch(/class="[^"]*\btruncate\b/);
    expect(m).toContain("2/10");
  });

  test("an idle run (no snapshot yet) shows no 0/0 count", () => {
    const m = html(run({ status: "idle", snapshot: null }));
    expect(m).toContain("My Implementation Pipeline");
    expect(m).not.toContain("0/0");
  });

  test("running: info tone and the active step line", () => {
    const m = html(running());
    expect(m).toContain("bg-info/10");
    expect(m).toContain(">Implementing<");
  });

  test("a fan-out names the first step and how many more", () => {
    const m = html(run({
      history: [rec(1, "s3", null), rec(2, "s4", null), rec(3, "s5", null)],
      active: [{ stepId: "s3", taskId: "t1", seq: 1 }, { stepId: "s4", taskId: "t2", seq: 2 }, { stepId: "s5", taskId: "t3", seq: 3 }],
    }));
    expect(m).toContain("Implementing +2");
  });

  test("a pending gate", () => {
    const m = html(run({
      status: "review",
      humanSteps: [{ stepId: "s2", seq: 4, startedAt: 4, arrivals: [] }],
      history: [rec(1, "s1"), rec(4, "s2", null, null)],
    }));
    expect(m).toContain("Waiting for your review: Step 2");
    expect(m).toContain("bg-info/10");
  });

  test("blocked: warning tone and the blocked step", () => {
    const m = html(run({
      status: "blocked",
      blocked: [{ taskId: "t", stepId: "s4", kind: "handoff-missing", message: "x" }],
    }));
    expect(m).toContain("bg-warning/10");
    expect(m).toContain("Blocked: Step 4");
  });

  test("blocked with no step reads just Blocked", () => {
    const m = html(run({ status: "blocked", blocked: [{ taskId: null, stepId: null, kind: "step-cap", message: "x" } as never] }));
    expect(m).toContain(">Blocked<");
  });

  test("done: ✓ Done, success tone, no step line", () => {
    const m = html(run({ status: "done", history: [rec(1, "s1"), rec(2, "s2")] }));
    expect(m).toContain("✓ Done");
    expect(m).toContain("bg-success/10");
    expect(m).not.toContain("text-[11px]");
  });

  test("cancelled: muted tone, no step line", () => {
    const m = html(run({ status: "cancelled", history: [rec(1, "s1")] }));
    expect(m).toContain("bg-muted");
    expect(m).not.toContain("text-[11px]");
  });

  test("test id, status and a tooltip that carries the run counts", () => {
    const m = html(run({ status: "done", history: [rec(1, "s1"), rec(2, "s1"), rec(3, "s2")] }));
    expect(m).toContain('data-testid="task-card-pipeline"');
    expect(m).toContain('data-status="done"');
    expect(m).toContain('title="My Implementation Pipeline — ✓ Done · 3 step runs · 1 re-run"');
  });

  test("no trailing separator in the tooltip before the first execution", () => {
    const m = html(run({ status: "idle" }));
    expect(m).toContain('title="My Implementation Pipeline — 0/10"');
  });
});

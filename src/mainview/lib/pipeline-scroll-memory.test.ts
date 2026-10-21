import { beforeEach, describe, expect, test } from "bun:test";
import {
  historyExpansionKey,
  isHistoryRowExpanded,
  notePipelineRunPanelSignature,
  PIPELINE_RUN_PANEL_MEMORY_MAX,
  pipelineRunGoalOpen,
  pipelineRunPanelSignature,
  pipelinesListScrollTop,
  resetPipelineScrollMemoryForTest,
  resolvePipelineRunPanelScroll,
  savePipelineRunPanelScroll,
  savePipelinesListScrollTop,
  setHistoryRowExpanded,
  setPipelineRunGoalOpen,
} from "./pipeline-scroll-memory.ts";
import type { ColumnId, PipelineRunState, PipelineStepRecord } from "../../shared/types.ts";

beforeEach(() => resetPipelineScrollMemoryForTest());

function record(seq: number, stepId = "a"): PipelineStepRecord {
  return {
    seq,
    stepId,
    taskId: `step-task-${seq}`,
    startedAt: 1000 + seq,
    endedAt: 2000 + seq,
    outcome: "succeeded",
    handoff: null,
    nextStepIds: [],
  };
}

/** A blocked two-step run with one active execution — built fresh on every
 *  call so equality is structural, never by reference. */
function makeRun(overrides: Partial<PipelineRunState> = {}): PipelineRunState {
  return {
    pipelineId: "pipe-1",
    pipelineName: "Pipe",
    snapshot: null,
    status: "blocked",
    active: [{ stepId: "b", taskId: "step-task-3", seq: 3 }],
    joins: {},
    blocked: [{ taskId: "step-task-3", stepId: "b", kind: "handoff-missing", message: "no handoff" }],
    history: [record(1), record(2, "b")],
    stepCount: 3,
    startedAt: 123,
    endedAt: null,
    ...overrides,
  };
}

function makeSteps(column: ColumnId = "blocked"): { id: string; column: ColumnId }[] {
  return [
    { id: "step-task-1", column: "review" },
    { id: "step-task-2", column: "review" },
    { id: "step-task-3", column },
  ];
}

const sig = (run: PipelineRunState, steps = makeSteps()) => pipelineRunPanelSignature(run, steps);

describe("pipelineRunPanelSignature", () => {
  test("is equal for structurally equal runs built as separate objects", () => {
    expect(sig(makeRun())).toBe(sig(makeRun()));
  });

  test("changes with startedAt (a Restart)", () => {
    expect(sig(makeRun({ startedAt: 456 }))).not.toBe(sig(makeRun()));
    expect(sig(makeRun({ startedAt: null }))).not.toBe(sig(makeRun()));
  });

  test("changes with status", () => {
    expect(sig(makeRun({ status: "running" }))).not.toBe(sig(makeRun()));
  });

  test("changes with the history length", () => {
    expect(sig(makeRun({ history: [record(1), record(2, "b"), record(3)] }))).not.toBe(sig(makeRun()));
  });

  test("changes with a blocked entry's kind, stepId or taskId", () => {
    const base = sig(makeRun());
    const block = makeRun().blocked[0]!;
    expect(sig(makeRun({ blocked: [{ ...block, kind: "handoff-invalid" }] }))).not.toBe(base);
    expect(sig(makeRun({ blocked: [{ ...block, stepId: "a" }] }))).not.toBe(base);
    expect(sig(makeRun({ blocked: [{ ...block, taskId: "step-task-9" }] }))).not.toBe(base);
  });

  test("changes when a blocked entry is added", () => {
    const run = makeRun();
    const extra = { taskId: null, stepId: "a", kind: "step-cap" as const, message: "cap" };
    expect(sig(makeRun({ blocked: [...run.blocked, extra] }))).not.toBe(sig(run));
  });

  test("ignores a blocked entry's message", () => {
    const block = makeRun().blocked[0]!;
    expect(sig(makeRun({ blocked: [{ ...block, message: "something else" }] }))).toBe(sig(makeRun()));
  });

  test("changes with an active entry's stepId or taskId", () => {
    const base = sig(makeRun());
    expect(sig(makeRun({ active: [{ stepId: "a", taskId: "step-task-3", seq: 3 }] }))).not.toBe(base);
    expect(sig(makeRun({ active: [{ stepId: "b", taskId: "step-task-4", seq: 3 }] }))).not.toBe(base);
  });

  test("is order-sensitive", () => {
    const one = { stepId: "a", taskId: "t1", seq: 1 };
    const two = { stepId: "b", taskId: "t2", seq: 2 };
    expect(sig(makeRun({ active: [one, two] }))).not.toBe(sig(makeRun({ active: [two, one] })));
  });

  test("changes when an active step task turns review (the Awaiting review card)", () => {
    expect(sig(makeRun(), makeSteps("review"))).not.toBe(sig(makeRun(), makeSteps("blocked")));
  });

  test("ignores an active step's column change that isn't review", () => {
    expect(sig(makeRun(), makeSteps("running"))).toBe(sig(makeRun(), makeSteps("blocked")));
  });

  test("ignores a column change on a step that isn't active", () => {
    const steps = makeSteps();
    const changed = steps.map((s) => (s.id === "step-task-1" ? { ...s, column: "done" as const } : s));
    expect(sig(makeRun(), changed)).toBe(sig(makeRun(), steps));
  });
});

describe("historyExpansionKey", () => {
  test("joins the run generation and seq", () => {
    expect(historyExpansionKey(123, 4)).toBe("123:4");
  });

  test("names a run that never started", () => {
    expect(historyExpansionKey(null, 1)).toBe("none:1");
  });

  test("differs across run generations for the same seq", () => {
    expect(historyExpansionKey(123, 4)).not.toBe(historyExpansionKey(456, 4));
  });
});

describe("resolvePipelineRunPanelScroll", () => {
  test("the first visit starts at the top", () => {
    expect(resolvePipelineRunPanelScroll("t1", "sig-a")).toBeNull();
  });

  test("an unchanged run gets its saved offset back", () => {
    resolvePipelineRunPanelScroll("t1", "sig-a");
    savePipelineRunPanelScroll("t1", 240);
    expect(resolvePipelineRunPanelScroll("t1", "sig-a")).toBe(240);
  });

  test("a changed run starts at the top and the stored offset resets", () => {
    resolvePipelineRunPanelScroll("t1", "sig-a");
    savePipelineRunPanelScroll("t1", 240);
    expect(resolvePipelineRunPanelScroll("t1", "sig-b")).toBeNull();
    expect(resolvePipelineRunPanelScroll("t1", "sig-b")).toBe(0);
  });

  test("a noted signature makes a later resolve match", () => {
    resolvePipelineRunPanelScroll("t1", "sig-a");
    savePipelineRunPanelScroll("t1", 240);
    notePipelineRunPanelSignature("t1", "sig-b");
    expect(resolvePipelineRunPanelScroll("t1", "sig-b")).toBe(240);
  });

  test("an offset saved before the first resolve is not trusted", () => {
    savePipelineRunPanelScroll("t1", 240);
    expect(resolvePipelineRunPanelScroll("t1", "sig-a")).toBeNull();
  });

  test("task ids are independent", () => {
    resolvePipelineRunPanelScroll("t1", "sig-a");
    savePipelineRunPanelScroll("t1", 240);
    expect(resolvePipelineRunPanelScroll("t2", "sig-a")).toBeNull();
    savePipelineRunPanelScroll("t2", 90);
    expect(resolvePipelineRunPanelScroll("t1", "sig-a")).toBe(240);
    expect(resolvePipelineRunPanelScroll("t2", "sig-a")).toBe(90);
  });
});

describe("Goal toggle and history-row expansion", () => {
  test("both default to closed", () => {
    expect(pipelineRunGoalOpen("t1")).toBe(false);
    expect(isHistoryRowExpanded("t1", "123:1")).toBe(false);
  });

  test("the Goal toggle persists per task", () => {
    setPipelineRunGoalOpen("t1", true);
    expect(pipelineRunGoalOpen("t1")).toBe(true);
    expect(pipelineRunGoalOpen("t2")).toBe(false);
    setPipelineRunGoalOpen("t1", false);
    expect(pipelineRunGoalOpen("t1")).toBe(false);
  });

  test("row expansion persists per task and per key", () => {
    setHistoryRowExpanded("t1", "123:3", true);
    expect(isHistoryRowExpanded("t1", "123:3")).toBe(true);
    expect(isHistoryRowExpanded("t1", "456:3")).toBe(false);
    expect(isHistoryRowExpanded("t2", "123:3")).toBe(false);
  });

  test("collapsing a row removes its key", () => {
    setHistoryRowExpanded("t1", "123:3", true);
    setHistoryRowExpanded("t1", "123:3", false);
    expect(isHistoryRowExpanded("t1", "123:3")).toBe(false);
  });

  test("the Goal toggle and expansion survive a resolve with a changed signature", () => {
    setPipelineRunGoalOpen("t1", true);
    setHistoryRowExpanded("t1", "123:3", true);
    resolvePipelineRunPanelScroll("t1", "sig-b");
    expect(pipelineRunGoalOpen("t1")).toBe(true);
    expect(isHistoryRowExpanded("t1", "123:3")).toBe(true);
  });
});

describe("LRU bound", () => {
  test("writing to MAX + 1 task ids forgets the oldest", () => {
    for (let i = 0; i <= PIPELINE_RUN_PANEL_MEMORY_MAX; i++) setPipelineRunGoalOpen(`t${i}`, true);
    expect(pipelineRunGoalOpen("t0")).toBe(false);
    expect(pipelineRunGoalOpen("t1")).toBe(true);
    expect(pipelineRunGoalOpen(`t${PIPELINE_RUN_PANEL_MEMORY_MAX}`)).toBe(true);
  });

  test("a read never creates an entry, so it never evicts one", () => {
    for (let i = 0; i < PIPELINE_RUN_PANEL_MEMORY_MAX; i++) setPipelineRunGoalOpen(`t${i}`, true);
    for (let i = 0; i < 50; i++) {
      pipelineRunGoalOpen(`unseen-${i}`);
      isHistoryRowExpanded(`unseen-${i}`, "1:1");
    }
    expect(pipelineRunGoalOpen("t0")).toBe(true);
  });

  test("touching an old id with a write keeps it", () => {
    for (let i = 0; i < PIPELINE_RUN_PANEL_MEMORY_MAX; i++) setPipelineRunGoalOpen(`t${i}`, true);
    savePipelineRunPanelScroll("t0", 10);
    setPipelineRunGoalOpen("newcomer", true);
    expect(pipelineRunGoalOpen("t0")).toBe(true);
    expect(pipelineRunGoalOpen("t1")).toBe(false);
  });
});

describe("Pipelines list offset", () => {
  test("starts at 0 and round-trips", () => {
    expect(pipelinesListScrollTop()).toBe(0);
    savePipelinesListScrollTop(512);
    expect(pipelinesListScrollTop()).toBe(512);
  });
});

import { describe, expect, test } from "bun:test";
import type { PipelineRunState, Task } from "../../shared/types.ts";
import { cardActions, taskActionFlags, type CardAction } from "./task-card-actions.ts";
import { buildTaskContextMenu, type TaskMenuAction } from "./task-context-menu.ts";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "t",
    prompt: "p",
    column: "backlog",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    speed: "off",
    opencodeServer: "shared",
    maxMode: false,
    references: [],
    backlog: [],
    draft: null,
    plans: [],
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    ...overrides,
  };
}

function run(over: Partial<PipelineRunState> = {}): PipelineRunState {
  return {
    pipelineId: "p1",
    pipelineName: "Flow",
    snapshot: null,
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

const gate = { stepId: "g", seq: 2, startedAt: 1, arrivals: [] };
const record = { seq: 1, stepId: "a", taskId: "x", startedAt: 0, endedAt: 1, outcome: "succeeded" as const, handoff: null, nextStepIds: [] };

/** One task per row of the card's state table (plan §2.3). */
const MATRIX: { name: string; task: Task; expected: CardAction[] }[] = [
  { name: "backlog", task: makeTask(), expected: ["run"] },
  { name: "ready with an openable run", task: makeTask({ column: "ready", hasOpenableRun: true }), expected: ["open"] },
  { name: "running", task: makeTask({ column: "running" }), expected: ["stop"] },
  { name: "blocked", task: makeTask({ column: "blocked" }), expected: ["answer"] },
  { name: "awaiting (1 interaction)", task: makeTask({ column: "review", pendingInteractionCount: 1 }), expected: ["answer", "mark-done"] },
  { name: "awaiting (12 interactions)", task: makeTask({ column: "ready", pendingInteractionCount: 12 }), expected: ["answer"] },
  { name: "awaiting + running", task: makeTask({ column: "running", pendingInteractionCount: 2 }), expected: ["answer"] },
  { name: "review", task: makeTask({ column: "review", hasOpenableRun: true }), expected: ["open", "mark-done"] },
  {
    name: "review pipeline, not done",
    task: makeTask({ column: "review", pipelineId: "p1", pipelineRun: run({ status: "blocked", history: [record] }) }),
    expected: ["open"],
  },
  {
    name: "review pipeline, done",
    task: makeTask({ column: "review", pipelineId: "p1", pipelineRun: run({ status: "done", history: [record] }) }),
    expected: ["open", "mark-done"],
  },
  {
    name: "gate pending",
    task: makeTask({ column: "review", pipelineId: "p1", pipelineRun: run({ status: "review", humanSteps: [gate], history: [record] }) }),
    expected: ["review-gate", "open"],
  },
  { name: "done", task: makeTask({ column: "done", hasOpenableRun: true }), expected: ["open"] },
  { name: "archived", task: makeTask({ column: "done", archivedAt: 5, hasOpenableRun: true }), expected: ["open"] },
  {
    name: "imported session",
    task: makeTask({ column: "ready", importedClaude: { sessionId: "s", status: "ready", error: null } as Task["importedClaude"] }),
    expected: ["open"],
  },
  {
    name: "pipeline running",
    task: makeTask({ column: "running", pipelineId: "p1", pipelineRun: run({ status: "running", history: [record] }) }),
    expected: ["stop"],
  },
  {
    name: "pipeline blocked (nothing live to stop)",
    task: makeTask({ column: "ready", pipelineId: "p1", pipelineRun: run({ status: "blocked", history: [record] }) }),
    expected: ["open"],
  },
];

describe("cardActions", () => {
  for (const { name, task, expected } of MATRIX) {
    test(name, () => {
      expect(cardActions(task)).toEqual(expected);
    });
  }
});

describe("taskActionFlags", () => {
  test("a pipeline parent's openable run comes from its history, not hasOpenableRun", () => {
    const f = taskActionFlags(makeTask({ pipelineId: "p1", pipelineRun: run({ history: [record] }) }));
    expect(f.openable).toBe(true);
    expect(f.isPipelineParent).toBe(true);
  });

  test("a step task is flagged", () => {
    expect(taskActionFlags(makeTask({ pipelineParentId: "p" })).isStepTask).toBe(true);
  });

  test("blocked counts as awaiting and active", () => {
    const f = taskActionFlags(makeTask({ column: "blocked" }));
    expect(f.awaiting).toBe(true);
    expect(f.active).toBe(true);
    expect(f.stoppable).toBe(true);
  });
});

/**
 * Superset invariant: the card used to show Diff, Archive, Unarchive, Delete
 * and a second Stop as buttons. They live in `⋯` now, so the menu must offer
 * each of them wherever the old card showed it. The "old card" predicates
 * below are copied from the pre-change `TaskCard.tsx`, on purpose, so a
 * future change to the flags can't quietly redefine both sides.
 */
describe("the ⋯ menu carries every action the card used to show", () => {
  function oldCardExtras(task: Task): TaskMenuAction[] {
    const archived = task.archivedAt != null;
    const active = task.column === "running" || task.column === "blocked";
    const awaiting = task.pendingInteractionCount > 0 || task.column === "blocked";
    const gatePending = !!task.pipelineId && (task.pipelineRun?.humanSteps ?? []).length > 0;
    const stoppable = task.pipelineId ? task.pipelineRun?.status === "running" || gatePending : active;
    const out: TaskMenuAction[] = ["diff"];
    if (!task.pipelineParentId) out.push("delete");
    if (!archived && awaiting && !gatePending && stoppable) out.push("stop");
    if (gatePending && !archived) out.push("stop");
    if (!archived && (task.column === "done" || active) && !task.pipelineParentId) out.push("archive");
    if (archived && !task.pipelineParentId) out.push("unarchive");
    return out;
  }

  for (const { name, task } of MATRIX) {
    test(name, () => {
      const menu = buildTaskContextMenu(task, { isOpen: false }).map((e) => e.action);
      for (const action of oldCardExtras(task)) expect(menu).toContain(action);
    });
  }

  test("an archived task offers Unarchive and Delete in the menu, nothing destructive on the card", () => {
    const t = makeTask({ column: "done", archivedAt: 5 });
    expect(cardActions(t)).toEqual(["open"]);
    const menu = buildTaskContextMenu(t, { isOpen: false }).map((e) => e.action);
    expect(menu).toContain("unarchive");
    expect(menu).toContain("delete");
  });
});

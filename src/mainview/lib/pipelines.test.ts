import { describe, expect, test } from "bun:test";
import {
  autoLayout,
  blockedSummary,
  edgeVisualState,
  graphFromFlow,
  latestTransition,
  matchSubagentToProfile,
  pipelineAttentionStepTask,
  reconcileFlowItems,
  responseKindLabel,
  sameStepAttention,
  satellitesSignature,
  stepAttention,
  stepLayoutFootprint,
  stepReminded,
  stepNodeTaskFor,
  stepTaskFor,
  stepVisualState,
  subagentEdgeKey,
  subagentNodeKey,
  subagentSatellitePosition,
  subagentSatellites,
  toFlowEdges,
  toFlowNodes,
  toSubagentFlowEdges,
  toSubagentFlowNodes,
  LAYOUT_NODE_HEIGHT,
  LAYOUT_NODE_WIDTH,
  SUBAGENT_NODE_GAP,
  SUBAGENT_NODE_HEIGHT,
  SUBAGENT_NODE_WIDTH,
  SUBAGENT_NODES_PER_ROW,
  SUBAGENT_ROW_TOP,
} from "./pipelines.ts";
import type {
  PipelineEdge,
  PipelineGraph,
  PipelineRunState,
  PipelineStep,
  PipelineStepRecord,
  Subagent,
  Task,
} from "../../shared/types.ts";

function makeStep(overrides: Partial<PipelineStep> = {}): PipelineStep {
  return {
    id: overrides.id ?? "step-1",
    name: overrides.name ?? "Step 1",
    instructions: "",
    agentProfileId: null,
    position: { x: 0, y: 0 },
    subagents: { profileIds: [], cap: null },
    transition: "choose",
    join: "any",
    ...overrides,
  };
}

function makeEdge(overrides: Partial<PipelineEdge> = {}): PipelineEdge {
  return {
    id: overrides.id ?? "edge-1",
    from: overrides.from ?? "step-1",
    to: overrides.to ?? "step-2",
    label: "",
    ...overrides,
  };
}

function makeGraph(steps: PipelineStep[], edges: PipelineEdge[] = [], startStepId: string | null = null): PipelineGraph {
  return { steps, edges, startStepId };
}

function makeRecord(overrides: Partial<PipelineStepRecord> = {}): PipelineStepRecord {
  return {
    seq: overrides.seq ?? 1,
    stepId: overrides.stepId ?? "step-1",
    taskId: overrides.taskId ?? "task-1",
    startedAt: 0,
    endedAt: 1,
    outcome: "succeeded",
    handoff: null,
    nextStepIds: [],
    ...overrides,
  };
}

function makeRun(overrides: Partial<PipelineRunState> = {}): PipelineRunState {
  return {
    pipelineId: "pipeline-1",
    pipelineName: "My Pipeline",
    snapshot: null,
    status: "running",
    active: [],
    joins: {},
    blocked: [],
    history: [],
    stepCount: 0,
    startedAt: 0,
    endedAt: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? "task-1",
    title: "Step task",
    prompt: "",
    column: "running",
    agent: "claude-code",
    workdir: "/tmp/x",
    isolation: "none",
    ...overrides,
  } as Task;
}

// ---------------------------------------------------------------------------
// stepVisualState

describe("stepVisualState", () => {
  test("no run → idle", () => {
    expect(stepVisualState(null, "step-1", [])).toBe("idle");
    expect(stepVisualState(undefined, "step-1", [])).toBe("idle");
  });

  test("active in run.active, no block, task column not blocked → active", () => {
    const run = makeRun({ active: [{ stepId: "step-1", taskId: "task-1", seq: 1 }] });
    const steps = [makeTask({ id: "task-1", column: "running" })];
    expect(stepVisualState(run, "step-1", steps)).toBe("active");
  });

  test("active + a blocked entry naming the stepId → blocked", () => {
    const run = makeRun({
      active: [{ stepId: "step-1", taskId: "task-1", seq: 1 }],
      blocked: [{ taskId: null, stepId: "step-1", kind: "step-failed", message: "oops" }],
    });
    expect(stepVisualState(run, "step-1", [])).toBe("blocked");
  });

  test("active + a blocked entry naming the active execution's taskId → blocked", () => {
    const run = makeRun({
      active: [{ stepId: "step-1", taskId: "task-1", seq: 1 }],
      blocked: [{ taskId: "task-1", stepId: null, kind: "step-blocked", message: "oops" }],
    });
    expect(stepVisualState(run, "step-1", [])).toBe("blocked");
  });

  test("active + the step task's own column is blocked → blocked", () => {
    const run = makeRun({ active: [{ stepId: "step-1", taskId: "task-1", seq: 1 }] });
    const steps = [makeTask({ id: "task-1", column: "blocked" })];
    expect(stepVisualState(run, "step-1", steps)).toBe("blocked");
  });

  test("not active, latest history outcome succeeded → done", () => {
    const run = makeRun({ history: [makeRecord({ stepId: "step-1", outcome: "succeeded" })] });
    expect(stepVisualState(run, "step-1", [])).toBe("done");
  });

  test("not active, latest history outcome advanced-manually → done", () => {
    const run = makeRun({ history: [makeRecord({ stepId: "step-1", outcome: "advanced-manually" })] });
    expect(stepVisualState(run, "step-1", [])).toBe("done");
  });

  test("not active, latest history outcome failed → failed", () => {
    const run = makeRun({ history: [makeRecord({ stepId: "step-1", outcome: "failed" })] });
    expect(stepVisualState(run, "step-1", [])).toBe("failed");
  });

  test("not active, latest history outcome cancelled → cancelled", () => {
    const run = makeRun({ history: [makeRecord({ stepId: "step-1", outcome: "cancelled" })] });
    expect(stepVisualState(run, "step-1", [])).toBe("cancelled");
  });

  test("uses the LATEST history record for a step that ran more than once (a cycle)", () => {
    const run = makeRun({
      history: [
        makeRecord({ seq: 1, stepId: "step-1", outcome: "failed" }),
        makeRecord({ seq: 2, stepId: "step-1", outcome: "succeeded" }),
      ],
    });
    expect(stepVisualState(run, "step-1", [])).toBe("done");
  });

  test("no history at all for the step → idle", () => {
    const run = makeRun({ history: [makeRecord({ stepId: "other-step" })] });
    expect(stepVisualState(run, "step-1", [])).toBe("idle");
  });

  test("latest outcome null (unresolved) → idle", () => {
    const run = makeRun({ history: [makeRecord({ stepId: "step-1", outcome: null })] });
    expect(stepVisualState(run, "step-1", [])).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// edgeVisualState

describe("edgeVisualState", () => {
  const edge = makeEdge({ from: "step-1", to: "step-2" });

  test("no run → idle", () => {
    expect(edgeVisualState(null, edge)).toBe("idle");
  });

  test("no history from edge.from → idle", () => {
    const run = makeRun({ history: [makeRecord({ stepId: "other", nextStepIds: ["step-2"] })] });
    expect(edgeVisualState(run, edge)).toBe("idle");
  });

  test("history from edge.from but nextStepIds doesn't include edge.to → idle", () => {
    const run = makeRun({ history: [makeRecord({ stepId: "step-1", nextStepIds: ["step-3"] })] });
    expect(edgeVisualState(run, edge)).toBe("idle");
  });

  test("traversed (history took this edge) but edge.to not currently active → traversed", () => {
    const run = makeRun({ history: [makeRecord({ stepId: "step-1", nextStepIds: ["step-2"] })] });
    expect(edgeVisualState(run, edge)).toBe("traversed");
  });

  test("traversed by the LATEST record and edge.to is active → flowing", () => {
    const run = makeRun({
      history: [makeRecord({ seq: 1, stepId: "step-1", nextStepIds: ["step-2"] })],
      active: [{ stepId: "step-2", taskId: "task-2", seq: 2 }],
    });
    expect(edgeVisualState(run, edge)).toBe("flowing");
  });

  test("traversed by an EARLIER record (not the latest) and edge.to active → traversed, not flowing", () => {
    const run = makeRun({
      history: [
        makeRecord({ seq: 1, stepId: "step-1", nextStepIds: ["step-2"] }),
        makeRecord({ seq: 2, stepId: "step-1", nextStepIds: ["step-3"] }),
      ],
      active: [{ stepId: "step-2", taskId: "task-2", seq: 3 }],
    });
    expect(edgeVisualState(run, edge)).toBe("traversed");
  });

  test("fan-out: latest record names edge.to among several nextStepIds and it's active → flowing", () => {
    const run = makeRun({
      history: [makeRecord({ seq: 1, stepId: "step-1", nextStepIds: ["step-2", "step-3"] })],
      active: [{ stepId: "step-2", taskId: "task-2", seq: 2 }],
    });
    expect(edgeVisualState(run, edge)).toBe("flowing");
  });
});

// ---------------------------------------------------------------------------
// latestTransition

describe("latestTransition", () => {
  test("no run → null", () => {
    expect(latestTransition(null)).toBeNull();
  });

  test("empty history → null", () => {
    expect(latestTransition(makeRun())).toBeNull();
  });

  test("every record terminal (no nextStepIds) → null", () => {
    const run = makeRun({ history: [makeRecord({ nextStepIds: [] }), makeRecord({ seq: 2, nextStepIds: [] })] });
    expect(latestTransition(run)).toBeNull();
  });

  test("returns the most recent record with a non-empty nextStepIds, EVERY target (a fan-out animates every edge)", () => {
    const run = makeRun({
      history: [
        makeRecord({ seq: 1, stepId: "a", nextStepIds: ["b"] }),
        makeRecord({ seq: 2, stepId: "b", nextStepIds: [] }),
        makeRecord({ seq: 3, stepId: "c", nextStepIds: ["d", "e"] }),
      ],
    });
    expect(latestTransition(run)).toEqual({ fromStepId: "c", toStepIds: ["d", "e"], seq: 3 });
  });

  test("deduplicates repeated targets", () => {
    const run = makeRun({ history: [makeRecord({ seq: 1, stepId: "a", nextStepIds: ["b", "b"] })] });
    expect(latestTransition(run)).toEqual({ fromStepId: "a", toStepIds: ["b"], seq: 1 });
  });

  test("skips trailing terminal records to find the latest real transition", () => {
    const run = makeRun({
      history: [
        makeRecord({ seq: 1, stepId: "a", nextStepIds: ["b"] }),
        makeRecord({ seq: 2, stepId: "b", nextStepIds: [] }),
      ],
    });
    expect(latestTransition(run)).toEqual({ fromStepId: "a", toStepIds: ["b"], seq: 1 });
  });
});

// ---------------------------------------------------------------------------
// toFlowNodes / toFlowEdges / graphFromFlow

describe("toFlowNodes / toFlowEdges", () => {
  test("toFlowNodes: id/type/position from the step, data.step is the step itself", () => {
    const step = makeStep({ id: "s1", position: { x: 10, y: 20 } });
    const [node] = toFlowNodes(makeGraph([step]));
    expect(node).toMatchObject({ id: "s1", type: "step", position: { x: 10, y: 20 } });
    expect(node!.data.step).toBe(step);
  });

  test("toFlowNodes: extra() merges additional data fields", () => {
    const step = makeStep({ id: "s1" });
    const [node] = toFlowNodes(makeGraph([step]), (s) => ({ isStart: s.id === "s1" }));
    expect(node!.data).toEqual({ step, isStart: true });
  });

  test("toFlowEdges: id/type/source/target/handles/data.label from the edge", () => {
    const edge = makeEdge({ id: "e1", from: "a", to: "b", label: "yes" });
    const [flowEdge] = toFlowEdges(makeGraph([], [edge]));
    expect(flowEdge).toMatchObject({
      id: "e1",
      type: "step",
      source: "a",
      target: "b",
      sourceHandle: "out",
      targetHandle: "in",
      data: { label: "yes" },
    });
  });

  test("graphFromFlow is the inverse of toFlowNodes/toFlowEdges (round-trips positions and labels)", () => {
    const step1 = makeStep({ id: "s1", position: { x: 1, y: 2 } });
    const step2 = makeStep({ id: "s2", position: { x: 3, y: 4 } });
    const edge = makeEdge({ id: "e1", from: "s1", to: "s2", label: "next" });
    const graph = makeGraph([step1, step2], [edge], "s1");

    const nodes = toFlowNodes(graph);
    const edges = toFlowEdges(graph);
    // Simulate a drag: move s1.
    nodes[0]!.position = { x: 99, y: 100 };

    const rebuilt = graphFromFlow(nodes, edges, graph.startStepId);
    expect(rebuilt.startStepId).toBe("s1");
    expect(rebuilt.steps.find((s) => s.id === "s1")?.position).toEqual({ x: 99, y: 100 });
    expect(rebuilt.steps.find((s) => s.id === "s2")?.position).toEqual({ x: 3, y: 4 });
    expect(rebuilt.edges).toEqual([{ id: "e1", from: "s1", to: "s2", label: "next" }]);
  });

  test("graphFromFlow defaults a missing/non-string data.label to empty string", () => {
    const nodes = toFlowNodes(makeGraph([makeStep({ id: "s1" })]));
    const edges = [
      { id: "e1", type: "step" as const, source: "s1", target: "s1", sourceHandle: "out", targetHandle: "in", data: {} },
    ];
    const rebuilt = graphFromFlow(nodes, edges, null);
    expect(rebuilt.edges[0]!.label).toBe("");
  });
});

// ---------------------------------------------------------------------------
// autoLayout

describe("autoLayout", () => {
  test("positions every step and preserves steps/edges/startStepId identity of content", () => {
    const a = makeStep({ id: "a" });
    const b = makeStep({ id: "b" });
    const c = makeStep({ id: "c" });
    const graph = makeGraph([a, b, c], [makeEdge({ id: "e1", from: "a", to: "b" }), makeEdge({ id: "e2", from: "b", to: "c" })], "a");

    const laid = autoLayout(graph);
    expect(laid.startStepId).toBe("a");
    expect(laid.edges).toEqual(graph.edges);
    expect(laid.steps.map((s) => s.id)).toEqual(["a", "b", "c"]);

    // Left-to-right layered layout: a strictly left of b strictly left of c.
    const posA = laid.steps.find((s) => s.id === "a")!.position;
    const posB = laid.steps.find((s) => s.id === "b")!.position;
    const posC = laid.steps.find((s) => s.id === "c")!.position;
    expect(posA.x).toBeLessThan(posB.x);
    expect(posB.x).toBeLessThan(posC.x);
  });

  test("ignores edges referencing a step not present in the graph", () => {
    const a = makeStep({ id: "a" });
    const graph = makeGraph([a], [makeEdge({ id: "e1", from: "a", to: "ghost" })], "a");
    expect(() => autoLayout(graph)).not.toThrow();
    expect(autoLayout(graph).steps).toHaveLength(1);
  });

  test("does not mutate the input graph", () => {
    const a = makeStep({ id: "a", position: { x: 0, y: 0 } });
    const graph = makeGraph([a]);
    autoLayout(graph);
    expect(graph.steps[0]!.position).toEqual({ x: 0, y: 0 });
  });
});

// ---------------------------------------------------------------------------
// stepTaskFor

describe("stepTaskFor", () => {
  test("no run → null", () => {
    expect(stepTaskFor([], null, "step-1")).toBeNull();
  });

  test("prefers the currently active execution over history", () => {
    const run = makeRun({
      active: [{ stepId: "step-1", taskId: "task-active", seq: 2 }],
      history: [makeRecord({ seq: 1, stepId: "step-1", taskId: "task-old" })],
    });
    const steps = [makeTask({ id: "task-active" }), makeTask({ id: "task-old" })];
    expect(stepTaskFor(steps, run, "step-1")?.id).toBe("task-active");
  });

  test("falls back to the latest history record's task when not active", () => {
    const run = makeRun({
      history: [
        makeRecord({ seq: 1, stepId: "step-1", taskId: "task-old" }),
        makeRecord({ seq: 2, stepId: "step-1", taskId: "task-new" }),
      ],
    });
    const steps = [makeTask({ id: "task-old" }), makeTask({ id: "task-new" })];
    expect(stepTaskFor(steps, run, "step-1")?.id).toBe("task-new");
  });

  test("step never executed → null", () => {
    const run = makeRun({ history: [makeRecord({ stepId: "other" })] });
    expect(stepTaskFor([], run, "step-1")).toBeNull();
  });

  test("resolved task id not present in `steps` → null", () => {
    const run = makeRun({ history: [makeRecord({ stepId: "step-1", taskId: "missing" })] });
    expect(stepTaskFor([], run, "step-1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// blockedSummary

describe("blockedSummary", () => {
  test("no run → null", () => {
    expect(blockedSummary(null)).toBeNull();
  });

  test("no blocked entries → null", () => {
    expect(blockedSummary(makeRun({ blocked: [] }))).toBeNull();
  });

  test("one blocked entry → its message, no suffix", () => {
    const run = makeRun({ blocked: [{ taskId: "t1", stepId: "s1", kind: "step-failed", message: "step failed" }] });
    expect(blockedSummary(run)).toBe("step failed");
  });

  test("several blocked entries → first message + (+N more)", () => {
    const run = makeRun({
      blocked: [
        { taskId: "t1", stepId: "s1", kind: "step-failed", message: "first" },
        { taskId: "t2", stepId: "s2", kind: "step-blocked", message: "second" },
        { taskId: "t3", stepId: "s3", kind: "handoff-missing", message: "third" },
      ],
    });
    expect(blockedSummary(run)).toBe("first (+2 more)");
  });
});

// ---------------------------------------------------------------------------
// responseKindLabel

describe("responseKindLabel", () => {
  test("null/undefined → null", () => {
    expect(responseKindLabel(null)).toBeNull();
    expect(responseKindLabel(undefined)).toBeNull();
  });

  test("maps every known kind to its display text + tone", () => {
    expect(responseKindLabel("handoff")).toEqual({ text: "Handed off", tone: "success" });
    expect(responseKindLabel("handoff-blocked")).toEqual({ text: "Reported blocked", tone: "warning" });
    expect(responseKindLabel("handoff-missing")).toEqual({ text: "No handoff", tone: "warning" });
    expect(responseKindLabel("handoff-invalid")).toEqual({ text: "Invalid handoff", tone: "warning" });
    expect(responseKindLabel("user-ask")).toEqual({ text: "Asked you", tone: "warning" });
    expect(responseKindLabel("error")).toEqual({ text: "Error", tone: "danger" });
    expect(responseKindLabel("cancelled")).toEqual({ text: "Cancelled", tone: "muted" });
  });
});

// ---------------------------------------------------------------------------
// stepReminded

describe("stepReminded", () => {
  test("no run → false", () => {
    expect(stepReminded(null, "step-1")).toBe(false);
  });

  test("step not currently active → false, even if an old record was reminded", () => {
    const run = makeRun({
      history: [makeRecord({ stepId: "step-1", taskId: "task-1", reminder: { at: 1, reason: "handoff-missing", runId: null, detail: "d", delivered: true } })],
    });
    expect(stepReminded(run, "step-1")).toBe(false);
  });

  test("active, and its own history record carries a reminder → true", () => {
    const run = makeRun({
      active: [{ stepId: "step-1", taskId: "task-1", seq: 1 }],
      history: [
        makeRecord({
          stepId: "step-1",
          taskId: "task-1",
          outcome: null,
          reminder: { at: 5, reason: "handoff-invalid", runId: "run-1", detail: "still no handoff", delivered: true },
        }),
      ],
    });
    expect(stepReminded(run, "step-1")).toBe(true);
  });

  test("active, but its own record has no reminder → false", () => {
    const run = makeRun({
      active: [{ stepId: "step-1", taskId: "task-1", seq: 1 }],
      history: [makeRecord({ stepId: "step-1", taskId: "task-1", outcome: null })],
    });
    expect(stepReminded(run, "step-1")).toBe(false);
  });

  test("a cycle: matches the ACTIVE execution's own record, not an earlier generation's", () => {
    const run = makeRun({
      active: [{ stepId: "step-1", taskId: "task-2", seq: 2 }],
      history: [
        makeRecord({
          seq: 1,
          stepId: "step-1",
          taskId: "task-1",
          outcome: "failed",
          reminder: { at: 1, reason: "handoff-missing", runId: null, detail: "old", delivered: true },
        }),
        makeRecord({ seq: 2, stepId: "step-1", taskId: "task-2", outcome: null }),
      ],
    });
    expect(stepReminded(run, "step-1")).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// Subagent satellites
// ---------------------------------------------------------------------------

function makeSubagent(overrides: Partial<Subagent> = {}): Subagent {
  return {
    id: overrides.id ?? "sub-1",
    taskId: overrides.taskId ?? "task-1",
    runId: overrides.runId ?? "run-1",
    parentKind: overrides.parentKind ?? "subagent",
    agentType: overrides.agentType ?? "general-purpose",
    description: overrides.description ?? null,
    spawnDepth: 1,
    sourcePath: "",
    toolUseId: null,
    status: overrides.status ?? "running",
    startedAt: 1,
    endedAt: overrides.endedAt ?? null,
  };
}

const NAMES: Record<string, string> = { p1: "Helper One", p2: "Helper Two", p3: "Reviewer", p4: "Reviewer Pro" };
const nameOf = (id: string) => NAMES[id] ?? null;

describe("subagentSatellitePosition", () => {
  test("a single satellite is centred under the 240px step card, one row below it", () => {
    const pos = subagentSatellitePosition(0, 1);
    expect(pos.x).toBe((LAYOUT_NODE_WIDTH - SUBAGENT_NODE_WIDTH) / 2);
    expect(pos.y).toBe(LAYOUT_NODE_HEIGHT + SUBAGENT_ROW_TOP);
  });

  test("wraps into rows of SUBAGENT_NODES_PER_ROW; a partial last row is centred on its own", () => {
    const count = SUBAGENT_NODES_PER_ROW + 1;
    const first = subagentSatellitePosition(0, count);
    const last = subagentSatellitePosition(SUBAGENT_NODES_PER_ROW, count);
    expect(last.y).toBe(first.y + SUBAGENT_NODE_HEIGHT + SUBAGENT_NODE_GAP);
    // The lone item on row 2 sits centred, like the single-satellite case.
    expect(last.x).toBe((LAYOUT_NODE_WIDTH - SUBAGENT_NODE_WIDTH) / 2);
    // Full row 1 is centred as a block, so its first column starts left of centre.
    expect(first.x).toBeLessThan(last.x);
  });
});

describe("stepLayoutFootprint / autoLayout with satellites", () => {
  test("a step without subagents keeps the bare card footprint", () => {
    expect(stepLayoutFootprint(makeStep())).toEqual({ width: LAYOUT_NODE_WIDTH, height: LAYOUT_NODE_HEIGHT });
  });

  test("the estimate covers the tallest card variant; a measured card size wins over it", () => {
    // Tallest StepNode variant (title + profile chip + transition:"all"
    // warning line) — see LAYOUT_NODE_HEIGHT's doc comment for the sum.
    expect(LAYOUT_NODE_HEIGHT).toBeGreaterThanOrEqual(93);
    const a = makeStep({ id: "a" });
    const b = makeStep({ id: "b" });
    const laidOut = autoLayout(
      { steps: [a, b], edges: [], startStepId: "a" },
      { measured: (id) => (id === "a" ? { width: 240, height: 180 } : null) },
    );
    const la = laidOut.steps.find((s) => s.id === "a")!;
    const lb = laidOut.steps.find((s) => s.id === "b")!;
    const [top, bottom] = la.position.y < lb.position.y ? [la, lb] : [lb, la];
    const topHeight = top.id === "a" ? 180 : LAYOUT_NODE_HEIGHT;
    expect(bottom.position.y).toBeGreaterThanOrEqual(top.position.y + topHeight);
  });

  test("satellite rows grow the footprint, and dagre spacing honours it", () => {
    const withSubs = makeStep({ id: "a", subagents: { profileIds: ["p1", "p2", "p3", "p4"], cap: null } });
    const fp = stepLayoutFootprint(withSubs);
    expect(fp.width).toBe(3 * SUBAGENT_NODE_WIDTH + 2 * SUBAGENT_NODE_GAP);
    expect(fp.height).toBe(LAYOUT_NODE_HEIGHT + SUBAGENT_ROW_TOP + 2 * (SUBAGENT_NODE_HEIGHT + SUBAGENT_NODE_GAP));

    // Two steps stacked in the same rank (no edge between them): the second
    // must start below the first one's satellites, not below its card.
    const plain = makeStep({ id: "b" });
    const laidOut = autoLayout({ steps: [withSubs, plain], edges: [], startStepId: "a" });
    const a = laidOut.steps.find((s) => s.id === "a")!;
    const b = laidOut.steps.find((s) => s.id === "b")!;
    const [top, bottom] = a.position.y < b.position.y ? [a, b] : [b, a];
    const topFootprint = stepLayoutFootprint(top);
    expect(bottom.position.y).toBeGreaterThanOrEqual(top.position.y + topFootprint.height);
  });
});

describe("matchSubagentToProfile", () => {
  const profiles = [
    { id: "p1", name: "Helper One" },
    { id: "p3", name: "Reviewer" },
    { id: "p4", name: "Reviewer Pro" },
  ];

  test("matches by description, case-insensitively", () => {
    expect(matchSubagentToProfile(makeSubagent({ description: "helper one: review the tests" }), profiles)).toBe("p1");
  });

  test("matches by agentType when the description says nothing", () => {
    expect(matchSubagentToProfile(makeSubagent({ description: null, agentType: "Helper One" }), profiles)).toBe("p1");
  });

  test("the longest matching name wins", () => {
    expect(matchSubagentToProfile(makeSubagent({ description: "Reviewer Pro: check style" }), profiles)).toBe("p4");
    expect(matchSubagentToProfile(makeSubagent({ description: "Reviewer: check style" }), profiles)).toBe("p3");
  });

  test("no match → null; empty inputs → null", () => {
    expect(matchSubagentToProfile(makeSubagent({ description: "Explore the repo" }), profiles)).toBeNull();
    expect(matchSubagentToProfile(makeSubagent({ description: null, agentType: null }), profiles)).toBeNull();
    expect(matchSubagentToProfile(makeSubagent({ description: "Helper One" }), [])).toBeNull();
  });

  test("the description must START with the name — a mere mention elsewhere never attributes", () => {
    expect(matchSubagentToProfile(makeSubagent({ description: "Ask Helper One to review the tests" }), profiles)).toBeNull();
    expect(matchSubagentToProfile(makeSubagent({ description: "Please review (Reviewer)" }), profiles)).toBeNull();
  });

  test("the name must end on a word boundary: 'QA' matches 'QA: …' and 'QA — …', not 'QAnon …'", () => {
    const qa = [{ id: "qa", name: "QA" }];
    expect(matchSubagentToProfile(makeSubagent({ description: "QA: run the suite" }), qa)).toBe("qa");
    expect(matchSubagentToProfile(makeSubagent({ description: "qa — run the suite" }), qa)).toBe("qa");
    expect(matchSubagentToProfile(makeSubagent({ description: "QA" }), qa)).toBe("qa");
    expect(matchSubagentToProfile(makeSubagent({ description: "QAnon investigation" }), qa)).toBeNull();
    expect(matchSubagentToProfile(makeSubagent({ description: "Reviewer2: style" }), profiles)).toBeNull();
  });

  test("a one-character persona name never matches, even at the start", () => {
    const a = [{ id: "a", name: "A" }];
    expect(matchSubagentToProfile(makeSubagent({ description: "A: analyze the logs" }), a)).toBeNull();
    expect(matchSubagentToProfile(makeSubagent({ description: null, agentType: "A" }), a)).toBeNull();
  });

  test("agentType attributes only by EQUALITY, never by containment", () => {
    expect(matchSubagentToProfile(makeSubagent({ description: null, agentType: "helper one" }), profiles)).toBe("p1");
    expect(matchSubagentToProfile(makeSubagent({ description: null, agentType: "Helper One Plus" }), profiles)).toBeNull();
    expect(matchSubagentToProfile(makeSubagent({ description: null, agentType: "my-reviewer" }), profiles)).toBeNull();
  });

  test("a persona named after a built-in agent type is never attributed by agentType, only by description", () => {
    const explore = [{ id: "ex", name: "Explore" }, { id: "gp", name: "general-purpose" }];
    expect(matchSubagentToProfile(makeSubagent({ description: "Look around the repo", agentType: "Explore" }), explore)).toBeNull();
    expect(matchSubagentToProfile(makeSubagent({ description: "scan tests", agentType: "general-purpose" }), explore)).toBeNull();
    expect(matchSubagentToProfile(makeSubagent({ description: "Explore: map the repo", agentType: "Explore" }), explore)).toBe("ex");
  });

  test("the longest name still wins when both description and agentType match different personas", () => {
    expect(
      matchSubagentToProfile(makeSubagent({ description: "Reviewer Pro: check style", agentType: "Reviewer" }), profiles),
    ).toBe("p4");
  });
});

describe("subagentSatellites", () => {
  const step = makeStep({ id: "a", subagents: { profileIds: ["p1", "p2"], cap: 2 } });

  test("editor case: every configured persona, idle, in configured order", () => {
    const sats = subagentSatellites(step, [], nameOf);
    expect(sats.map((s) => [s.kind, s.profileId, s.visual])).toEqual([
      ["profile", "p1", "idle"],
      ["profile", "p2", "idle"],
    ]);
    expect(sats[0]!.nodeId).toBe("sub:a:p1");
  });

  test("a running subagent attributed to a persona makes it working; a finished one makes it done", () => {
    const sats = subagentSatellites(
      step,
      [
        makeSubagent({ id: "s1", description: "Helper One: tests", status: "running" }),
        makeSubagent({ id: "s2", description: "Helper Two: docs", status: "completed", endedAt: 2 }),
      ],
      nameOf,
    );
    expect(sats.map((s) => s.visual)).toEqual(["working", "done"]);
    expect(sats.map((s) => s.instances.map((i) => i.id))).toEqual([["s1"], ["s2"]]);
  });

  test("every helper attributed to a persona is carried as an instance, running first, and counted on the node", () => {
    const sats = subagentSatellites(
      step,
      [
        makeSubagent({ id: "a", description: "Helper One: first", status: "completed", endedAt: 2 }),
        makeSubagent({ id: "b", description: "Helper One: second", status: "running" }),
        makeSubagent({ id: "c", description: "helper one again", status: "completed", endedAt: 3 }),
      ],
      nameOf,
    );
    expect(sats[0]!.instances.map((i) => i.id)).toEqual(["b", "a", "c"]);
    expect(sats[1]!.instances).toEqual([]);
    const [node] = toSubagentFlowNodes(sats);
    expect(node!.data.instanceCount).toBe(3);
    // Instance status is part of the identity signature, so a helper
    // finishing re-renders its satellite even when the visual stays put.
    const before = satellitesSignature(sats);
    const after = satellitesSignature(
      subagentSatellites(
        step,
        [
          makeSubagent({ id: "a", description: "Helper One: first", status: "completed", endedAt: 2 }),
          makeSubagent({ id: "b", description: "Helper One: second", status: "running" }),
          makeSubagent({ id: "c", description: "helper one again", status: "running" }),
        ],
        nameOf,
      ),
    );
    expect(after).not.toBe(before);
  });

  test("running beats done for the same persona, regardless of order", () => {
    const sats = subagentSatellites(
      step,
      [
        makeSubagent({ id: "s1", description: "Helper One: first pass", status: "completed", endedAt: 2 }),
        makeSubagent({ id: "s2", description: "Helper One: second pass", status: "running" }),
      ],
      nameOf,
    );
    expect(sats[0]!.visual).toBe("working");
  });

  test("an unmatched RUNNING subagent becomes a transient live satellite; an unmatched finished one is dropped", () => {
    const sats = subagentSatellites(
      step,
      [
        makeSubagent({ id: "s9", description: "Explore the repo", status: "running" }),
        makeSubagent({ id: "s8", description: "old scout", status: "completed", endedAt: 2 }),
      ],
      nameOf,
    );
    expect(sats).toHaveLength(3);
    const live = sats[2]!;
    expect(live.kind).toBe("live");
    expect(live.nodeId).toBe("live:a:s9");
    expect(live.label).toBe("Explore the repo");
    expect(live.visual).toBe("working");
    expect(live.subagentId).toBe("s9");
    expect(live.instances.map((i) => i.id)).toEqual(["s9"]);
  });

  test("a deleted persona (no name) still renders as an idle satellite and never matches", () => {
    const withGhost = makeStep({ id: "a", subagents: { profileIds: ["ghost"], cap: null } });
    const sats = subagentSatellites(withGhost, [makeSubagent({ description: "ghost: hi", status: "running" })], nameOf);
    expect(sats.map((s) => [s.kind, s.profileId, s.visual])).toEqual([
      ["profile", "ghost", "idle"],
      ["live", null, "working"],
    ]);
  });
});

describe("toSubagentFlowNodes / toSubagentFlowEdges", () => {
  test("nodes are non-interactive children of their step, positioned per step", () => {
    const a = makeStep({ id: "a", subagents: { profileIds: ["p1", "p2"], cap: null } });
    const b = makeStep({ id: "b", subagents: { profileIds: ["p3"], cap: null } });
    const sats = [...subagentSatellites(a, [], nameOf), ...subagentSatellites(b, [], nameOf)];
    const nodes = toSubagentFlowNodes(sats, () => ({ readOnly: true }));
    expect(nodes.map((n) => n.parentId)).toEqual(["a", "a", "b"]);
    expect(nodes.every((n) => n.type === "subagent" && n.draggable === false && n.selectable === false)).toBe(true);
    // b's lone satellite is centred like a single one, not placed as the
    // third of a three-wide row.
    expect(nodes[2]!.position).toEqual(subagentSatellitePosition(0, 1));
    expect(nodes[0]!.position).toEqual(subagentSatellitePosition(0, 2));
    expect(nodes[1]!.position).toEqual(subagentSatellitePosition(1, 2));
    expect(nodes[0]!.data).toMatchObject({ stepId: "a", kind: "profile", profileId: "p1", visual: "idle", readOnly: true });

    const edges = toSubagentFlowEdges(sats);
    expect(edges.map((e) => [e.source, e.target, e.sourceHandle, e.targetHandle])).toEqual([
      ["a", "sub:a:p1", "delegate", "in"],
      ["a", "sub:a:p2", "delegate", "in"],
      ["b", "sub:b:p3", "delegate", "in"],
    ]);
    expect(edges[0]!.id).toBe("edge:sub:a:p1");
    expect(edges[0]!.data?.visual).toBe("idle");
  });

  test("satellitesSignature changes with visual state and label, not otherwise", () => {
    const step = makeStep({ id: "a", subagents: { profileIds: ["p1"], cap: null } });
    const idle = satellitesSignature(subagentSatellites(step, [], nameOf));
    const idleAgain = satellitesSignature(subagentSatellites(step, [], nameOf));
    const working = satellitesSignature(
      subagentSatellites(step, [makeSubagent({ description: "Helper One", status: "running" })], nameOf),
    );
    expect(idle).toBe(idleAgain);
    expect(working).not.toBe(idle);
  });
});

describe("reconcileFlowItems", () => {
  test("keeps the previous object for an unchanged key and takes the fresh one otherwise", () => {
    const memory = new Map<string, { key: string; item: { id: string; v: number } }>();
    const first = reconcileFlowItems(memory, [{ id: "x", v: 1 }, { id: "y", v: 1 }], (i) => `${i.id}:${i.v}`);
    const second = reconcileFlowItems(memory, [{ id: "x", v: 1 }, { id: "y", v: 2 }], (i) => `${i.id}:${i.v}`);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]!.v).toBe(2);
    // Items that vanished are forgotten.
    reconcileFlowItems(memory, [], (i) => `${i.id}:${i.v}`);
    expect(memory.size).toBe(0);
  });

  test("subagentNodeKey / subagentEdgeKey cover position, parent, data and visual", () => {
    const step = makeStep({ id: "a", subagents: { profileIds: ["p1"], cap: null } });
    const [n1] = toSubagentFlowNodes(subagentSatellites(step, [], nameOf));
    const [n2] = toSubagentFlowNodes(
      subagentSatellites(step, [makeSubagent({ description: "Helper One", status: "running" })], nameOf),
    );
    expect(subagentNodeKey(n1!)).not.toBe(subagentNodeKey(n2!));
    const [e1] = toSubagentFlowEdges(subagentSatellites(step, [], nameOf));
    const [e2] = toSubagentFlowEdges(
      subagentSatellites(step, [makeSubagent({ description: "Helper One", status: "running" })], nameOf),
    );
    expect(subagentEdgeKey(e1!)).not.toBe(subagentEdgeKey(e2!));
  });
});

// ---------------------------------------------------------------------------
// stepAttention / sameStepAttention

describe("stepAttention", () => {
  const asking = (overrides: Partial<Task> = {}) =>
    makeTask({ id: "task-1", column: "running", pendingInteractionCount: 1, ...overrides });

  test("no run → null", () => {
    expect(stepAttention(null, "step-1", [])).toBeNull();
    expect(stepAttention(undefined, "step-1", [])).toBeNull();
  });

  test("row 1 — asking mid-turn: answer, while the lifecycle visual still reads active", () => {
    const run = makeRun({ active: [{ stepId: "step-1", taskId: "task-1", seq: 1 }] });
    const steps = [asking()];
    expect(stepAttention(run, "step-1", steps)).toEqual({ kind: "answer", label: "Answer", message: null });
    expect(stepVisualState(run, "step-1", steps)).toBe("active");
  });

  test("row 2 — a question still pending after the turn carries the block's message", () => {
    const run = makeRun({
      status: "blocked",
      active: [{ stepId: "step-1", taskId: "task-1", seq: 1 }],
      blocked: [{ taskId: "task-1", stepId: "step-1", kind: "step-blocked", message: 'step "One" is waiting for you' }],
    });
    expect(stepAttention(run, "step-1", [asking({ column: "review" })])).toEqual({
      kind: "answer",
      label: "Answer",
      message: 'step "One" is waiting for you',
    });
  });

  test("row 2 — once the pending count dropped, the remaining block reads Review", () => {
    const run = makeRun({
      active: [{ stepId: "step-1", taskId: "task-1", seq: 1 }],
      blocked: [{ taskId: "task-1", stepId: "step-1", kind: "step-blocked", message: "waiting" }],
    });
    expect(stepAttention(run, "step-1", [asking({ pendingInteractionCount: 0, column: "review" })])).toEqual({
      kind: "review",
      label: "Review",
      message: "waiting",
    });
  });

  test("row 3 — error: a step-failed block on a blocked step task → review with the message", () => {
    const run = makeRun({
      status: "blocked",
      active: [{ stepId: "step-1", taskId: "task-1", seq: 1 }],
      blocked: [{ taskId: "task-1", stepId: "step-1", kind: "step-failed", message: "API error" }],
    });
    expect(stepAttention(run, "step-1", [makeTask({ id: "task-1", column: "blocked" })])).toEqual({
      kind: "review",
      label: "Review",
      message: "API error",
    });
  });

  test("row 3 — the step task's own column reads blocked before any block lands → review, no message", () => {
    const run = makeRun({ active: [{ stepId: "step-1", taskId: "task-1", seq: 1 }] });
    expect(stepAttention(run, "step-1", [makeTask({ id: "task-1", column: "blocked" })])).toEqual({
      kind: "review",
      label: "Review",
      message: null,
    });
  });

  test("row 4 — missing handoff and a step-blocked handoff both read Review", () => {
    for (const kind of ["handoff-missing", "handoff-invalid", "step-blocked"] as const) {
      const run = makeRun({
        active: [{ stepId: "step-1", taskId: "task-1", seq: 1 }],
        blocked: [{ taskId: "task-1", stepId: "step-1", kind, message: `blocked: ${kind}` }],
      });
      expect(stepAttention(run, "step-1", [makeTask({ id: "task-1", column: "review" })])).toEqual({
        kind: "review",
        label: "Review",
        message: `blocked: ${kind}`,
      });
    }
  });

  test("a block naming the active execution by taskId only still matches", () => {
    const run = makeRun({
      active: [{ stepId: "step-1", taskId: "task-1", seq: 1 }],
      blocked: [{ taskId: "task-1", stepId: null, kind: "step-failed", message: "boom" }],
    });
    expect(stepAttention(run, "step-1", [makeTask({ id: "task-1", column: "review" })])?.message).toBe("boom");
  });

  test("row 5 — a run-level block highlights the named step even though it isn't active", () => {
    const run = makeRun({
      status: "blocked",
      history: [makeRecord({ seq: 1, stepId: "step-1", taskId: "task-1", nextStepIds: [] })],
      blocked: [{ taskId: null, stepId: "step-2", kind: "step-cap", message: "step cap reached" }],
    });
    const steps = [makeTask({ id: "task-1", column: "review" })];
    expect(stepAttention(run, "step-2", steps)).toEqual({ kind: "review", label: "Review", message: "step cap reached" });
    expect(stepVisualState(run, "step-2", steps)).toBe("idle");
  });

  test("a block naming another step never leaks onto this one", () => {
    const run = makeRun({
      active: [{ stepId: "step-1", taskId: "task-1", seq: 1 }],
      blocked: [{ taskId: null, stepId: "step-2", kind: "step-cap", message: "cap" }],
    });
    expect(stepAttention(run, "step-1", [makeTask({ id: "task-1", column: "running" })])).toBeNull();
  });

  test("an active execution sitting in review for a manual Advance, with no block → null (D18)", () => {
    const run = makeRun({ active: [{ stepId: "step-1", taskId: "task-1", seq: 1 }] });
    expect(stepAttention(run, "step-1", [makeTask({ id: "task-1", column: "review", pendingInteractionCount: 0 })])).toBeNull();
  });

  test("two pending questions → Answer (2), summed across every active execution of the step", () => {
    const single = makeRun({ active: [{ stepId: "step-1", taskId: "task-1", seq: 1 }] });
    expect(stepAttention(single, "step-1", [asking({ pendingInteractionCount: 2 })])?.label).toBe("Answer (2)");

    const fanIn = makeRun({
      active: [
        { stepId: "step-1", taskId: "task-1", seq: 1 },
        { stepId: "step-1", taskId: "task-2", seq: 2 },
      ],
    });
    expect(stepAttention(fanIn, "step-1", [asking(), asking({ id: "task-2" })])?.label).toBe("Answer (2)");
  });

  test("a leftover pending card on a settled step (latest history execution) → answer", () => {
    const run = makeRun({
      status: "done",
      history: [
        makeRecord({ seq: 1, stepId: "step-1", taskId: "task-old" }),
        makeRecord({ seq: 2, stepId: "step-1", taskId: "task-new" }),
      ],
    });
    expect(stepAttention(run, "step-1", [makeTask({ id: "task-new", column: "review", pendingInteractionCount: 1 })])).toEqual({
      kind: "answer",
      label: "Answer",
      message: null,
    });
    // An older generation's leftover counts too — the same set the attention
    // resolver scans, so a card reading Answer always has a node glowing.
    expect(
      stepAttention(run, "step-1", [
        makeTask({ id: "task-old", column: "review", pendingInteractionCount: 1 }),
        makeTask({ id: "task-new", column: "review", pendingInteractionCount: 0 }),
      ]),
    ).toEqual({ kind: "answer", label: "Answer", message: null });
  });

  test("a cycle: an earlier execution's leftover question still glows while the step re-runs", () => {
    const run = makeRun({
      active: [{ stepId: "step-1", taskId: "task-2", seq: 3 }],
      history: [
        makeRecord({ seq: 1, stepId: "step-1", taskId: "task-1" }),
        makeRecord({ seq: 2, stepId: "step-2", taskId: "task-other" }),
        makeRecord({ seq: 3, stepId: "step-1", taskId: "task-2" }),
      ],
    });
    const steps = [
      makeTask({ id: "task-1", column: "review", pendingInteractionCount: 1 }),
      makeTask({ id: "task-2", column: "running", pendingInteractionCount: 0 }),
    ];
    expect(stepAttention(run, "step-1", steps)).toEqual({ kind: "answer", label: "Answer", message: null });
    // Agrees with the resolver: the card's Answer lands on that leftover.
    const parent = makeTask({ id: "parent", pipelineId: "pipeline-1", pipelineRun: run });
    const rows = steps.map((t) => ({ ...t, pipelineParentId: "parent" }));
    expect(pipelineAttentionStepTask(parent, rows)?.id).toBe("task-1");
    // The other step of the cycle needs nothing.
    expect(stepAttention(run, "step-2", steps)).toBeNull();
  });

  test("an active execution also present in history is counted once", () => {
    const run = makeRun({
      active: [{ stepId: "step-1", taskId: "task-1", seq: 1 }],
      history: [makeRecord({ seq: 1, stepId: "step-1", taskId: "task-1" })],
    });
    expect(stepAttention(run, "step-1", [asking()])?.label).toBe("Answer");
  });

  test("a settled execution's blocked column doesn't read Review while the step re-runs", () => {
    const run = makeRun({
      active: [{ stepId: "step-1", taskId: "task-2", seq: 2 }],
      history: [
        makeRecord({ seq: 1, stepId: "step-1", taskId: "task-1", outcome: "failed" }),
        makeRecord({ seq: 2, stepId: "step-1", taskId: "task-2" }),
      ],
    });
    const steps = [makeTask({ id: "task-1", column: "blocked" }), makeTask({ id: "task-2", column: "running" })];
    expect(stepAttention(run, "step-1", steps)).toBeNull();
  });

  test("a settled step whose own column reads blocked is not an attention (only active ones are)", () => {
    const run = makeRun({ history: [makeRecord({ seq: 1, stepId: "step-1", taskId: "task-1", outcome: "failed" })] });
    expect(stepAttention(run, "step-1", [makeTask({ id: "task-1", column: "blocked" })])).toBeNull();
  });

  test("a step that never ran, or whose row isn't polled yet → null", () => {
    expect(stepAttention(makeRun(), "step-1", [])).toBeNull();
    const run = makeRun({ active: [{ stepId: "step-1", taskId: "task-1", seq: 1 }] });
    expect(stepAttention(run, "step-1", [])).toBeNull();
  });
});

describe("sameStepAttention", () => {
  test("null and undefined both mean no attention and compare equal", () => {
    expect(sameStepAttention(null, null)).toBe(true);
    expect(sameStepAttention(undefined, null)).toBe(true);
    expect(sameStepAttention(null, undefined)).toBe(true);
  });

  test("no attention vs some attention → not equal", () => {
    const a = { kind: "answer" as const, label: "Answer", message: null };
    expect(sameStepAttention(a, null)).toBe(false);
    expect(sameStepAttention(undefined, a)).toBe(false);
  });

  test("structurally equal objects compare equal even when they're different references", () => {
    expect(
      sameStepAttention(
        { kind: "review", label: "Review", message: "m" },
        { kind: "review", label: "Review", message: "m" },
      ),
    ).toBe(true);
  });

  test("a difference in kind, label or message is detected", () => {
    const base = { kind: "answer" as const, label: "Answer", message: null as string | null };
    expect(sameStepAttention(base, { ...base, kind: "review" })).toBe(false);
    expect(sameStepAttention(base, { ...base, label: "Answer (2)" })).toBe(false);
    expect(sameStepAttention(base, { ...base, message: "now blocked" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pipelineAttentionStepTask

describe("pipelineAttentionStepTask", () => {
  const parentWith = (run: Partial<PipelineRunState> | null) =>
    makeTask({
      id: "parent",
      pipelineId: "pipeline-1",
      column: "running",
      pipelineRun: run ? makeRun(run) : null,
    });
  const step = (id: string, overrides: Partial<Task> = {}) =>
    makeTask({ id, pipelineParentId: "parent", column: "running", pendingInteractionCount: 0, ...overrides });

  test("a parent without a run → null", () => {
    expect(pipelineAttentionStepTask(parentWith(null), [step("a", { pendingInteractionCount: 1 })])).toBeNull();
  });

  test("a pending question beats a task-level block", () => {
    const parent = parentWith({
      active: [
        { stepId: "s1", taskId: "a", seq: 1 },
        { stepId: "s2", taskId: "b", seq: 2 },
      ],
      blocked: [{ taskId: "a", stepId: "s1", kind: "step-failed", message: "boom" }],
    });
    const tasks = [step("a", { column: "blocked" }), step("b", { pendingInteractionCount: 1 })];
    expect(pipelineAttentionStepTask(parent, tasks)?.id).toBe("b");
  });

  test("several asking at once → the earliest-launched (run.active array order)", () => {
    const parent = parentWith({
      active: [
        { stepId: "s2", taskId: "b", seq: 2 },
        { stepId: "s1", taskId: "a", seq: 3 },
      ],
    });
    const tasks = [step("a", { pendingInteractionCount: 1 }), step("b", { pendingInteractionCount: 2 })];
    expect(pipelineAttentionStepTask(parent, tasks)?.id).toBe("b");
  });

  test("the block tier skips a block whose step row isn't polled yet", () => {
    const parent = parentWith({
      active: [
        { stepId: "s1", taskId: "missing", seq: 1 },
        { stepId: "s2", taskId: "a", seq: 2 },
      ],
      blocked: [
        { taskId: "missing", stepId: "s1", kind: "handoff-missing", message: "x" },
        { taskId: "a", stepId: "s2", kind: "handoff-invalid", message: "y" },
      ],
    });
    expect(pipelineAttentionStepTask(parent, [step("a", { column: "review" })])?.id).toBe("a");
  });

  test("only run-level blocks (no step task) → null, the run view alone", () => {
    const parent = parentWith({
      status: "blocked",
      history: [makeRecord({ seq: 1, stepId: "s1", taskId: "a" })],
      blocked: [{ taskId: null, stepId: "s2", kind: "step-cap", message: "cap" }],
    });
    expect(pipelineAttentionStepTask(parent, [step("a", { column: "review" })])).toBeNull();
  });

  test("an active execution whose own column reads blocked, before run.blocked catches up", () => {
    const parent = parentWith({
      active: [
        { stepId: "s1", taskId: "a", seq: 1 },
        { stepId: "s2", taskId: "b", seq: 2 },
      ],
    });
    expect(pipelineAttentionStepTask(parent, [step("a"), step("b", { column: "blocked" })])?.id).toBe("b");
  });

  test("a leftover pending card on a settled step → the latest such history execution", () => {
    const parent = parentWith({
      status: "done",
      history: [
        makeRecord({ seq: 1, stepId: "s1", taskId: "a" }),
        makeRecord({ seq: 2, stepId: "s2", taskId: "b" }),
        makeRecord({ seq: 3, stepId: "s3", taskId: "c" }),
      ],
    });
    const tasks = [
      step("a", { column: "review", pendingInteractionCount: 1 }),
      step("b", { column: "review", pendingInteractionCount: 1 }),
      step("c", { column: "review" }),
    ];
    expect(pipelineAttentionStepTask(parent, tasks)?.id).toBe("b");
  });

  test("a leftover question on a finished execution beats a blocked re-run of the same step", () => {
    // A cycle re-ran s1: the first execution still holds an unanswered
    // question, the re-run is blocked. Answer must open the row that asks —
    // the same execution the s1 node click opens (stepNodeTaskFor).
    const parent = parentWith({
      status: "blocked",
      history: [
        makeRecord({ seq: 1, stepId: "s1", taskId: "a" }),
        makeRecord({ seq: 2, stepId: "s1", taskId: "b" }),
      ],
      active: [{ stepId: "s1", taskId: "b", seq: 2 }],
      blocked: [{ taskId: "b", stepId: "s1", kind: "step-failed", message: "boom" }],
    });
    const tasks = [
      step("a", { column: "review", pendingInteractionCount: 1 }),
      step("b", { column: "blocked" }),
    ];
    expect(pipelineAttentionStepTask(parent, tasks)?.id).toBe("a");
    expect(stepNodeTaskFor(tasks, parent.pipelineRun, "s1")?.id).toBe("a");
  });

  test("a leftover question on another settled step beats a task-level block and a blocked column", () => {
    const parent = parentWith({
      status: "blocked",
      history: [
        makeRecord({ seq: 1, stepId: "s1", taskId: "a" }),
        makeRecord({ seq: 2, stepId: "s2", taskId: "b" }),
        makeRecord({ seq: 3, stepId: "s3", taskId: "c" }),
      ],
      active: [
        { stepId: "s2", taskId: "b", seq: 2 },
        { stepId: "s3", taskId: "c", seq: 3 },
      ],
      blocked: [{ taskId: "b", stepId: "s2", kind: "handoff-missing", message: "x" }],
    });
    const tasks = [
      step("a", { column: "review", pendingInteractionCount: 1 }),
      step("b", { column: "review" }),
      step("c", { column: "blocked" }),
    ];
    expect(pipelineAttentionStepTask(parent, tasks)?.id).toBe("a");
  });

  test("nothing needs the user → null", () => {
    const parent = parentWith({ active: [{ stepId: "s1", taskId: "a", seq: 1 }] });
    expect(pipelineAttentionStepTask(parent, [step("a")])).toBeNull();
  });

  test("a row belonging to another pipeline parent is never returned", () => {
    const parent = parentWith({ active: [{ stepId: "s1", taskId: "a", seq: 1 }] });
    const foreign = makeTask({ id: "a", pipelineParentId: "other-parent", pendingInteractionCount: 1 });
    expect(pipelineAttentionStepTask(parent, [foreign])).toBeNull();
  });

  test("a preferred step id that still has a pending question wins over the tiers", () => {
    const parent = parentWith({
      active: [
        { stepId: "s1", taskId: "a", seq: 1 },
        { stepId: "s2", taskId: "b", seq: 2 },
      ],
    });
    const tasks = [step("a", { pendingInteractionCount: 1 }), step("b", { pendingInteractionCount: 1 })];
    expect(pipelineAttentionStepTask(parent, tasks, "b")?.id).toBe("b");
  });

  test("a preferred step whose column reads blocked, or that a run.blocked entry names, still wins", () => {
    const parent = parentWith({
      active: [
        { stepId: "s1", taskId: "a", seq: 1 },
        { stepId: "s2", taskId: "b", seq: 2 },
        { stepId: "s3", taskId: "c", seq: 3 },
      ],
      blocked: [{ taskId: "c", stepId: "s3", kind: "step-blocked", message: "waiting" }],
    });
    const tasks = [step("a", { pendingInteractionCount: 1 }), step("b", { column: "blocked" }), step("c", { column: "review" })];
    expect(pipelineAttentionStepTask(parent, tasks, "b")?.id).toBe("b");
    expect(pipelineAttentionStepTask(parent, tasks, "c")?.id).toBe("c");
  });

  test("a preferred step answered since falls through to the step that still needs the user", () => {
    // Two steps asked at once; the parent-keyed toast still names the first
    // asker after it was answered, while the second's question is open.
    const parent = parentWith({
      active: [
        { stepId: "s1", taskId: "a", seq: 1 },
        { stepId: "s2", taskId: "b", seq: 2 },
      ],
    });
    const tasks = [step("a"), step("b", { pendingInteractionCount: 1 })];
    expect(pipelineAttentionStepTask(parent, tasks, "a")?.id).toBe("b");
  });

  test("a preferred step answered since, with nothing else needing the user → null (run view alone)", () => {
    const parent = parentWith({ active: [{ stepId: "s1", taskId: "a", seq: 1 }] });
    expect(pipelineAttentionStepTask(parent, [step("a"), step("b")], "a")).toBeNull();
  });

  test("a preferred step id that isn't polled falls through to the tiers", () => {
    const parent = parentWith({ active: [{ stepId: "s1", taskId: "a", seq: 1 }] });
    expect(pipelineAttentionStepTask(parent, [step("a", { pendingInteractionCount: 1 })], "gone")?.id).toBe("a");
    expect(pipelineAttentionStepTask(parent, [step("a")], "gone")).toBeNull();
  });

  test("a preferred step id belonging to another parent is never returned", () => {
    const parent = parentWith({ active: [{ stepId: "s1", taskId: "a", seq: 1 }] });
    const foreign = makeTask({ id: "x", pipelineParentId: "other-parent", pendingInteractionCount: 1 });
    expect(pipelineAttentionStepTask(parent, [step("a"), foreign], "x")).toBeNull();
    expect(pipelineAttentionStepTask(parent, [step("a", { pendingInteractionCount: 1 }), foreign], "x")?.id).toBe("a");
  });

  test("an explicit null preferred id behaves like none (the tiers run)", () => {
    const parent = parentWith({ active: [{ stepId: "s1", taskId: "a", seq: 1 }] });
    expect(pipelineAttentionStepTask(parent, [step("a", { pendingInteractionCount: 1 })], null)?.id).toBe("a");
  });

  test("a preferred step whose blocked column belongs to a settled execution doesn't win", () => {
    // The toast named `a`; it settled (its row still reads blocked) and a
    // cycle re-ran the step as `b`, which now asks — tier 3 and
    // stepAttention ignore a settled row's column, so the preference must too.
    const parent = parentWith({
      active: [{ stepId: "s1", taskId: "b", seq: 2 }],
      history: [makeRecord({ seq: 1, stepId: "s1", taskId: "a" }), makeRecord({ seq: 2, stepId: "s1", taskId: "b" })],
    });
    const tasks = [step("a", { column: "blocked" }), step("b", { pendingInteractionCount: 1 })];
    expect(pipelineAttentionStepTask(parent, tasks, "a")?.id).toBe("b");
    expect(pipelineAttentionStepTask(parent, [step("a", { column: "blocked" }), step("b")], "a")).toBeNull();
  });
});

describe("stepNodeTaskFor", () => {
  const step = (id: string, overrides: Partial<Task> = {}) =>
    makeTask({ id, pipelineParentId: "parent", column: "running", pendingInteractionCount: 0, ...overrides });

  test("no run → null", () => {
    expect(stepNodeTaskFor([], null, "s1")).toBeNull();
  });

  test("nothing needs the user → the latest execution (stepTaskFor)", () => {
    const run = makeRun({
      active: [{ stepId: "s1", taskId: "b", seq: 2 }],
      history: [makeRecord({ seq: 1, stepId: "s1", taskId: "a" })],
    });
    expect(stepNodeTaskFor([step("a"), step("b")], run, "s1")?.id).toBe("b");
  });

  test("a cycle: the node glows Answer from a settled execution's leftover question → opens that execution", () => {
    const run = makeRun({
      active: [{ stepId: "s1", taskId: "b", seq: 2 }],
      history: [makeRecord({ seq: 1, stepId: "s1", taskId: "a" }), makeRecord({ seq: 2, stepId: "s1", taskId: "b" })],
    });
    const steps = [step("a", { column: "review", pendingInteractionCount: 1 }), step("b")];
    expect(stepAttention(run, "s1", steps)?.kind).toBe("answer");
    expect(stepNodeTaskFor(steps, run, "s1")?.id).toBe("a");
  });

  test("a fan-in with two active executions: opens the one asking, not the latest", () => {
    const run = makeRun({
      active: [
        { stepId: "s1", taskId: "a", seq: 1 },
        { stepId: "s1", taskId: "b", seq: 2 },
      ],
    });
    expect(stepNodeTaskFor([step("a", { pendingInteractionCount: 1 }), step("b")], run, "s1")?.id).toBe("a");
  });

  test("an active question beats a leftover one in history", () => {
    const run = makeRun({
      active: [{ stepId: "s1", taskId: "b", seq: 2 }],
      history: [makeRecord({ seq: 1, stepId: "s1", taskId: "a" })],
    });
    const steps = [step("a", { pendingInteractionCount: 1 }), step("b", { pendingInteractionCount: 1 })];
    expect(stepNodeTaskFor(steps, run, "s1")?.id).toBe("b");
  });

  test("history leftovers resolve newest-first", () => {
    const run = makeRun({
      history: [makeRecord({ seq: 1, stepId: "s1", taskId: "a" }), makeRecord({ seq: 2, stepId: "s1", taskId: "b" })],
    });
    const steps = [step("a", { pendingInteractionCount: 1 }), step("b", { pendingInteractionCount: 1 })];
    expect(stepNodeTaskFor(steps, run, "s1")?.id).toBe("b");
  });

  test("a blocked active execution on a fan-in → that execution (block entry, then blocked column)", () => {
    const run = makeRun({
      active: [
        { stepId: "s1", taskId: "a", seq: 1 },
        { stepId: "s1", taskId: "b", seq: 2 },
      ],
      blocked: [{ taskId: "a", stepId: "s1", kind: "handoff-missing", message: "x" }],
    });
    expect(stepNodeTaskFor([step("a", { column: "review" }), step("b")], run, "s1")?.id).toBe("a");
    const byColumn = makeRun({ active: run.active });
    expect(stepNodeTaskFor([step("a", { column: "blocked" }), step("b")], byColumn, "s1")?.id).toBe("a");
  });

  test("other steps' questions never redirect this node", () => {
    const run = makeRun({
      active: [
        { stepId: "s2", taskId: "x", seq: 1 },
        { stepId: "s1", taskId: "a", seq: 2 },
      ],
    });
    expect(stepNodeTaskFor([step("x", { pendingInteractionCount: 1 }), step("a")], run, "s1")?.id).toBe("a");
  });

  test("the asking row isn't polled yet → falls back to the latest polled execution", () => {
    const run = makeRun({
      active: [
        { stepId: "s1", taskId: "a", seq: 1 },
        { stepId: "s1", taskId: "b", seq: 2 },
      ],
    });
    expect(stepNodeTaskFor([step("b")], run, "s1")?.id).toBe("b");
  });
});

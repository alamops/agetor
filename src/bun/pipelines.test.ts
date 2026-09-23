// DB-level tests for pipelines (docs/plans/pipelines.md §3/T2): the
// `pipelines` CRUD module, the task-side pipeline columns
// (`pipeline_id`/`pipeline_run`/`pipeline_parent_id`/`pipeline_step_id`,
// migration 057) round-tripping through `tasks.insert`/`tasks.update`/
// `tasks.setPipelineRun`, `tasks.stepsForParent`, `tasks.list()`'s
// parent/step pending-interaction aggregation (D11), and the defensive
// `parsePipelineRunState` parser. Mirrors agent-profiles.test.ts's
// structure: `AGETOR_DATA_DIR` is set at module scope BEFORE `./db.ts` is
// dynamically imported in `beforeAll` (the db opens — and migrates — on
// module load), a `beforeEach` clears the `tasks`/`pipelines` tables so
// every test starts from a clean slate (name-key uniqueness in particular
// would otherwise leak across tests), and `rmTestDataDir` (never a bare
// `rmSync`) tears the dir down afterward.
import { test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Pipeline, PipelineGraph, PipelineRunSnapshot, PipelineRunState, PipelineStep, PipelineStepRecord, Task } from "../shared/types.ts";

type PipelineRunSnapshotProfiles = PipelineRunSnapshot["profiles"];
import { PIPELINE_LIMITS } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-pipelines-"));
process.env.AGETOR_DATA_DIR = dataDir;

let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;
let pipelines: typeof import("./db.ts").pipelines;
let PipelineNameError: typeof import("./db.ts").PipelineNameError;
let parsePipelineRunState: typeof import("./db.ts").parsePipelineRunState;
let registerTmuxPrompt: typeof import("./interactions.ts").registerTmuxPrompt;
let interactionsTesting: typeof import("./interactions.ts").__testing;

beforeAll(async () => {
  ({ db, tasks, pipelines, PipelineNameError, parsePipelineRunState } = await import("./db.ts"));
  ({ registerTmuxPrompt, __testing: interactionsTesting } = await import("./interactions.ts"));
});

afterAll(() => {
  rmTestDataDir(dataDir);
});

beforeEach(() => {
  db.run(`DELETE FROM tasks`);
  db.run(`DELETE FROM pipelines`);
  interactionsTesting.reset();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<PipelineStep> = {}): PipelineStep {
  return {
    id: randomUUID(),
    name: "Step",
    instructions: "",
    agentProfileId: null,
    position: { x: 0, y: 0 },
    subagents: { profileIds: [], cap: null },
    transition: "choose",
    join: "any",
    ...overrides,
  };
}

/** A minimal valid two-step linear graph. */
function makeGraph(): PipelineGraph {
  const s1 = makeStep({ id: "step-1", name: "Step One" });
  const s2 = makeStep({ id: "step-2", name: "Step Two" });
  return {
    steps: [s1, s2],
    edges: [{ id: "edge-1", from: "step-1", to: "step-2", label: "" }],
    startStepId: "step-1",
  };
}

function makeTaskRow(taskId: string, overrides: Partial<Task> = {}): Task {
  return {
    id: taskId,
    title: "t",
    prompt: "p",
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
    fast: false,
    maxMode: false,
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    column: "ready",
    runId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    ...overrides,
  };
}

function makeRunState(pipeline: Pipeline, overrides: Partial<PipelineRunState> = {}): PipelineRunState {
  return {
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    snapshot: {
      graph: pipeline.graph,
      maxSteps: pipeline.maxSteps,
      profiles: {},
      capturedAt: Date.now(),
    },
    status: "running",
    active: [{ stepId: "step-1", taskId: randomUUID(), seq: 1 }],
    joins: { "step-2": { arrivals: [{ fromStepId: "step-1", seq: 1, handoff: null }] } },
    blocked: [],
    history: [],
    stepCount: 1,
    startedAt: Date.now(),
    endedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// pipelines CRUD
// ---------------------------------------------------------------------------

test("insert/list/get/findByName round-trip, case-insensitive name lookup", () => {
  const p = pipelines.insert({ name: "  My Pipeline  ", description: "desc", graph: makeGraph() });
  expect(p.name).toBe("My Pipeline"); // trimmed
  expect(p.description).toBe("desc");
  expect(p.maxSteps).toBe(PIPELINE_LIMITS.maxStepsDefault);
  expect(p.graph.steps.length).toBe(2);

  expect(pipelines.get(p.id)).toEqual(p);
  expect(pipelines.list().map((x) => x.id)).toEqual([p.id]);

  expect(pipelines.findByName("my pipeline")?.id).toBe(p.id);
  expect(pipelines.findByName("  MY PIPELINE  ")?.id).toBe(p.id);
  expect(pipelines.findByName("nonexistent")).toBeNull();

  expect(pipelines.get("nonexistent")).toBeNull();
});

test("insert throws PipelineNameError on a case-insensitive/trimmed name clash", () => {
  pipelines.insert({ name: "Dup Name", graph: makeGraph() });
  expect(() => pipelines.insert({ name: "  dup name  ", graph: makeGraph() })).toThrow(PipelineNameError);
});

test("update throws PipelineNameError when renaming into a clash, but a same-value resend is fine", () => {
  const a = pipelines.insert({ name: "Pipeline A", graph: makeGraph() });
  const b = pipelines.insert({ name: "Pipeline B", graph: makeGraph() });

  expect(() => pipelines.update(b.id, { name: "pipeline a" })).toThrow(PipelineNameError);
  // Renaming a pipeline to its own (differently-cased) current name is not a clash.
  const same = pipelines.update(a.id, { name: "PIPELINE A" });
  expect(same?.name).toBe("PIPELINE A");
});

test("insert/update throw a plain Error on an invalid graph", () => {
  const badGraph = {
    steps: [
      { id: "s1", name: "Dup" },
      { id: "s2", name: "dup " },
    ],
    edges: [],
    startStepId: null,
  } as unknown as PipelineGraph;

  expect(() => pipelines.insert({ name: "Bad Graph", graph: badGraph })).toThrow(/duplicate step name/i);

  const ok = pipelines.insert({ name: "Good Graph", graph: makeGraph() });
  expect(() => pipelines.update(ok.id, { graph: badGraph })).toThrow(/duplicate step name/i);
  // The bad update must not have partially applied.
  expect(pipelines.get(ok.id)?.graph.steps.length).toBe(2);
});

test("pipelines.get(): a stored graph that parses but fails validatePipelineGraph is returned unmodified, not silently emptied (m21)", () => {
  // insert()/update() still validate and reject a bad graph outright (the
  // test above) — this covers the OTHER way a bad graph can reach the
  // column: on-disk corruption, or a shape a newer/older validator no
  // longer accepts. Written directly via SQL, bypassing pipelines.update's
  // own validation, to simulate exactly that.
  const p = pipelines.insert({ name: "Drifted Graph", graph: makeGraph() });
  const dupNameGraph = { steps: [{ id: "s1", name: "Dup" }, { id: "s2", name: "dup" }], edges: [], startStepId: null } as unknown as PipelineGraph;
  db.run(`UPDATE pipelines SET graph = ? WHERE id = ?`, [JSON.stringify(dupNameGraph), p.id]);

  // Returned AS-IS rather than collapsed to the empty graph: the editor
  // reads this value straight through, and an editor session that opens,
  // makes an unrelated change, and saves would otherwise silently overwrite
  // the user's real graph with nothing.
  expect(pipelines.get(p.id)?.graph).toEqual(dupNameGraph);
});

test("pipelines.get(): unparseable JSON in the graph column collapses to the empty graph (m21)", () => {
  const p = pipelines.insert({ name: "Broken JSON Graph", graph: makeGraph() });
  db.run(`UPDATE pipelines SET graph = ? WHERE id = ?`, ["{not json", p.id]);

  expect(pipelines.get(p.id)?.graph).toEqual({ steps: [], edges: [], startStepId: null });
});

test("insert normalizes the graph, filling defaults for omitted step fields", () => {
  const rawGraph = {
    steps: [
      { id: "s1", name: "Step One" },
      { id: "s2", name: "Step Two" },
    ],
    edges: [],
    startStepId: null,
  } as unknown as PipelineGraph;

  const p = pipelines.insert({ name: "Defaults", graph: rawGraph });
  expect(p.graph.steps).toHaveLength(2);
  for (const step of p.graph.steps) {
    expect(step.position).toEqual({ x: 0, y: 0 });
    expect(step.subagents).toEqual({ profileIds: [], cap: null });
    expect(step.transition).toBe("choose");
    expect(step.join).toBe("any");
    expect(step.instructions).toBe("");
    expect(step.agentProfileId).toBeNull();
  }

  // Stored (not just returned) normalized — re-fetching sees the same shape.
  expect(pipelines.get(p.id)?.graph).toEqual(p.graph);
});

test("maxSteps is clamped to 1..maxStepsMax and defaults when omitted", () => {
  const noVal = pipelines.insert({ name: "No MaxSteps", graph: makeGraph() });
  expect(noVal.maxSteps).toBe(PIPELINE_LIMITS.maxStepsDefault);

  const low = pipelines.insert({ name: "Low MaxSteps", graph: makeGraph(), maxSteps: 0 });
  expect(low.maxSteps).toBe(1);

  const negative = pipelines.insert({ name: "Negative MaxSteps", graph: makeGraph(), maxSteps: -5 });
  expect(negative.maxSteps).toBe(1);

  const high = pipelines.insert({ name: "High MaxSteps", graph: makeGraph(), maxSteps: 999 });
  expect(high.maxSteps).toBe(PIPELINE_LIMITS.maxStepsMax);

  const exact = pipelines.insert({ name: "Exact MaxSteps", graph: makeGraph(), maxSteps: 50 });
  expect(exact.maxSteps).toBe(50);

  const updated = pipelines.update(exact.id, { maxSteps: 1000 });
  expect(updated?.maxSteps).toBe(PIPELINE_LIMITS.maxStepsMax);
});

test("delete returns true once, then false", () => {
  const p = pipelines.insert({ name: "To Delete", graph: makeGraph() });
  expect(pipelines.delete(p.id)).toBe(true);
  expect(pipelines.get(p.id)).toBeNull();
  expect(pipelines.delete(p.id)).toBe(false);
});

test("delete is never blocked by tasks still bound to the pipeline", () => {
  const p = pipelines.insert({ name: "Referenced", graph: makeGraph() });
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId, { pipelineId: p.id, pipelineRun: makeRunState(p) }));

  expect(pipelines.delete(p.id)).toBe(true);
  // The task keeps its own frozen pipelineId/pipelineRun — untouched by the delete.
  const task = tasks.get(taskId);
  expect(task?.pipelineId).toBe(p.id);
  expect(task?.pipelineRun?.pipelineId).toBe(p.id);
});

test("taskCounts/taskCount reflect tasks bound via pipeline_id", () => {
  const a = pipelines.insert({ name: "Pipeline A2", graph: makeGraph() });
  const b = pipelines.insert({ name: "Pipeline B2", graph: makeGraph() });

  expect(pipelines.taskCount(a.id)).toBe(0);
  expect(pipelines.taskCounts().get(a.id)).toBeUndefined();

  tasks.insert(makeTaskRow(randomUUID(), { pipelineId: a.id }));
  tasks.insert(makeTaskRow(randomUUID(), { pipelineId: a.id }));
  tasks.insert(makeTaskRow(randomUUID(), { pipelineId: b.id }));
  tasks.insert(makeTaskRow(randomUUID())); // unrelated task, no pipeline

  expect(pipelines.taskCount(a.id)).toBe(2);
  expect(pipelines.taskCount(b.id)).toBe(1);
  const counts = pipelines.taskCounts();
  expect(counts.get(a.id)).toBe(2);
  expect(counts.get(b.id)).toBe(1);
});

// ---------------------------------------------------------------------------
// tasks: pipeline columns
// ---------------------------------------------------------------------------

test("tasks.insert writes the four pipeline columns; toTask round-trips them", () => {
  const p = pipelines.insert({ name: "Insert Cols", graph: makeGraph() });
  const run = makeRunState(p);

  const parentId = randomUUID();
  const parent = tasks.insert(makeTaskRow(parentId, { pipelineId: p.id, pipelineRun: run }));
  expect(parent.pipelineId).toBe(p.id);
  expect(parent.pipelineRun).toEqual(run);
  expect(parent.pipelineParentId).toBeNull();
  expect(parent.pipelineStepId).toBeNull();

  const stepId = randomUUID();
  const step = tasks.insert(makeTaskRow(stepId, { pipelineParentId: parentId, pipelineStepId: "step-1" }));
  expect(step.pipelineId).toBeNull();
  expect(step.pipelineRun).toBeNull();
  expect(step.pipelineParentId).toBe(parentId);
  expect(step.pipelineStepId).toBe("step-1");

  // An ordinary task never touched by pipelines reads all four as null.
  const plain = tasks.insert(makeTaskRow(randomUUID()));
  expect(plain.pipelineId).toBeNull();
  expect(plain.pipelineRun).toBeNull();
  expect(plain.pipelineParentId).toBeNull();
  expect(plain.pipelineStepId).toBeNull();
});

test("tasks.setPipelineRun round-trips the run state and never bumps updated_at", () => {
  const p = pipelines.insert({ name: "Set Run", graph: makeGraph() });
  const taskId = randomUUID();
  const created = tasks.insert(makeTaskRow(taskId, { pipelineId: p.id, updatedAt: 1000 }));
  expect(created.pipelineRun).toBeNull();

  const beforeUpdatedAt = tasks.get(taskId)?.updatedAt;
  expect(beforeUpdatedAt).toBe(1000);

  const run = makeRunState(p, { status: "blocked", stepCount: 3 });
  const updated = tasks.setPipelineRun(taskId, run);
  expect(updated?.pipelineRun).toEqual(run);
  expect(updated?.updatedAt).toBe(beforeUpdatedAt); // unchanged

  // Re-fetch confirms persistence, not just the returned shape.
  const refetched = tasks.get(taskId);
  expect(refetched?.pipelineRun).toEqual(run);
  expect(refetched?.updatedAt).toBe(beforeUpdatedAt);

  // Clearing back to null.
  const cleared = tasks.setPipelineRun(taskId, null);
  expect(cleared?.pipelineRun).toBeNull();
  expect(cleared?.updatedAt).toBe(beforeUpdatedAt);

  // Nonexistent id is a harmless no-op matching zero rows.
  expect(tasks.setPipelineRun("nonexistent", run)).toBeNull();
});

test("the generic tasks.update SET clause leaves all four pipeline columns intact", () => {
  const p = pipelines.insert({ name: "Update Skip", graph: makeGraph() });
  const run = makeRunState(p);

  const parentId = randomUUID();
  tasks.insert(makeTaskRow(parentId, { pipelineId: p.id, pipelineRun: run }));
  const patchedParent = tasks.update(parentId, { title: "renamed parent" });
  expect(patchedParent?.title).toBe("renamed parent");
  expect(patchedParent?.pipelineId).toBe(p.id);
  expect(patchedParent?.pipelineRun).toEqual(run);

  const stepId = randomUUID();
  tasks.insert(makeTaskRow(stepId, { pipelineParentId: parentId, pipelineStepId: "step-2" }));
  const patchedStep = tasks.update(stepId, { column: "review" });
  expect(patchedStep?.column).toBe("review");
  expect(patchedStep?.pipelineParentId).toBe(parentId);
  expect(patchedStep?.pipelineStepId).toBe("step-2");

  // A patch that tries to smuggle pipeline fields through the generic patch
  // object is still ignored — `update`'s SET clause never references them.
  const smuggled = tasks.update(parentId, { pipelineId: "smuggled-id" } as Partial<Task>);
  expect(smuggled?.pipelineId).toBe(p.id);
});

test("tasks.stepsForParent returns a parent's steps oldest-created first", () => {
  const parentId = randomUUID();
  tasks.insert(makeTaskRow(parentId));

  const stepBId = randomUUID();
  const stepAId = randomUUID();
  const stepCId = randomUUID();
  // Inserted out of chronological order; createdAt (not insertion order)
  // must drive the returned ordering.
  tasks.insert(makeTaskRow(stepBId, { pipelineParentId: parentId, pipelineStepId: "b", createdAt: 200 }));
  tasks.insert(makeTaskRow(stepAId, { pipelineParentId: parentId, pipelineStepId: "a", createdAt: 100 }));
  tasks.insert(makeTaskRow(stepCId, { pipelineParentId: parentId, pipelineStepId: "c", createdAt: 300 }));
  // An unrelated task must not leak in.
  tasks.insert(makeTaskRow(randomUUID(), { createdAt: 150 }));

  const steps = tasks.stepsForParent(parentId);
  expect(steps.map((s) => s.id)).toEqual([stepAId, stepBId, stepCId]);

  expect(tasks.stepsForParent("nonexistent-parent")).toEqual([]);
});

test("tasks.list() folds each step task's pending-interaction count onto its parent (D11)", () => {
  const parentId = randomUUID();
  tasks.insert(makeTaskRow(parentId));

  const step1Id = randomUUID();
  const step2Id = randomUUID();
  tasks.insert(makeTaskRow(step1Id, { pipelineParentId: parentId, pipelineStepId: "step-1" }));
  tasks.insert(makeTaskRow(step2Id, { pipelineParentId: parentId, pipelineStepId: "step-2" }));

  const plainId = randomUUID();
  tasks.insert(makeTaskRow(plainId));

  // No interactions yet: everyone reads zero.
  let byId = new Map(tasks.list().map((t) => [t.id, t]));
  expect(byId.get(parentId)?.pendingInteractionCount).toBe(0);
  expect(byId.get(step1Id)?.pendingInteractionCount).toBe(0);

  registerTmuxPrompt({
    taskId: step1Id,
    runId: "run-1",
    paneText: "pane",
    choices: [{ key: "1", label: "Yes" }],
    fingerprint: "fp-1",
  });
  registerTmuxPrompt({
    taskId: step2Id,
    runId: "run-2",
    paneText: "pane",
    choices: [{ key: "1", label: "Yes" }],
    fingerprint: "fp-2",
  });
  registerTmuxPrompt({
    taskId: step2Id,
    runId: "run-2",
    paneText: "pane 2",
    choices: [{ key: "1", label: "Yes" }],
    fingerprint: "fp-3",
  });
  registerTmuxPrompt({
    taskId: plainId,
    runId: "run-3",
    paneText: "pane",
    choices: [{ key: "1", label: "Yes" }],
    fingerprint: "fp-4",
  });

  byId = new Map(tasks.list().map((t) => [t.id, t]));
  // Parent aggregates both steps' counts (1 + 2 = 3), even though it has no
  // interactions registered against its own id.
  expect(byId.get(parentId)?.pendingInteractionCount).toBe(3);
  // Each step task still reports its own count unchanged — aggregation is
  // additive onto the parent, not a transfer off the step.
  expect(byId.get(step1Id)?.pendingInteractionCount).toBe(1);
  expect(byId.get(step2Id)?.pendingInteractionCount).toBe(2);
  // An unrelated task (no pipeline_parent_id) is unaffected.
  expect(byId.get(plainId)?.pendingInteractionCount).toBe(1);
});

test("tasks.get() aggregates a pipeline parent's step pending-interaction counts, same as tasks.list() (M17)", () => {
  const pipeline = pipelines.insert({ name: "M17 Get Aggregation", graph: makeGraph() });
  const parentId = randomUUID();
  tasks.insert(makeTaskRow(parentId, { pipelineId: pipeline.id }));

  const step1Id = randomUUID();
  const step2Id = randomUUID();
  tasks.insert(makeTaskRow(step1Id, { pipelineParentId: parentId, pipelineStepId: "step-1" }));
  tasks.insert(makeTaskRow(step2Id, { pipelineParentId: parentId, pipelineStepId: "step-2" }));

  // No interactions yet: a single-task read agrees with the batched one.
  expect(tasks.get(parentId)?.pendingInteractionCount).toBe(0);

  registerTmuxPrompt({
    taskId: step1Id,
    runId: "get-run-1",
    paneText: "pane",
    choices: [{ key: "1", label: "Yes" }],
    fingerprint: "get-fp-1",
  });
  registerTmuxPrompt({
    taskId: step2Id,
    runId: "get-run-2",
    paneText: "pane",
    choices: [{ key: "1", label: "Yes" }],
    fingerprint: "get-fp-2",
  });
  registerTmuxPrompt({
    taskId: step2Id,
    runId: "get-run-2",
    paneText: "pane 2",
    choices: [{ key: "1", label: "Yes" }],
    fingerprint: "get-fp-3",
  });

  // `tasks.get` aggregates the same way `tasks.list()`'s batched pass does
  // (1 + 2 = 3), even though the parent has no interactions of its own.
  expect(tasks.get(parentId)?.pendingInteractionCount).toBe(3);
  // Each step's own single-task read is unaffected — aggregation is additive
  // onto the parent, not a transfer off the step.
  expect(tasks.get(step1Id)?.pendingInteractionCount).toBe(1);
  expect(tasks.get(step2Id)?.pendingInteractionCount).toBe(2);
  // And the aggregated list() view agrees with the single-task get() view.
  const listed = new Map(tasks.list().map((t) => [t.id, t]));
  expect(tasks.get(parentId)?.pendingInteractionCount).toBe(listed.get(parentId)?.pendingInteractionCount);
});

test("tasks.get() does NOT aggregate step counts onto a row with no pipeline_id set (M17 perf gate)", () => {
  // A row with children pointing at it via `pipelineParentId` but no
  // `pipelineId` of its own shouldn't happen for a real pipeline parent in
  // practice, but `tasks.get`'s aggregation is deliberately gated on
  // `pipeline_id` (cheap to check, always set on a real parent) rather than
  // "does anything point at me" (which would cost every ordinary task's
  // `get` an extra query) — this pins that gate.
  const parentId = randomUUID();
  tasks.insert(makeTaskRow(parentId));
  const stepId = randomUUID();
  tasks.insert(makeTaskRow(stepId, { pipelineParentId: parentId, pipelineStepId: "step-1" }));

  registerTmuxPrompt({
    taskId: stepId,
    runId: "get-run-3",
    paneText: "pane",
    choices: [{ key: "1", label: "Yes" }],
    fingerprint: "get-fp-4",
  });

  expect(tasks.get(parentId)?.pendingInteractionCount).toBe(0);
  expect(tasks.get(stepId)?.pendingInteractionCount).toBe(1);
});

// ---------------------------------------------------------------------------
// parsePipelineRunState
// ---------------------------------------------------------------------------

test("parsePipelineRunState: null/malformed JSON/missing pipelineId all collapse to null", () => {
  expect(parsePipelineRunState(null)).toBeNull();
  expect(parsePipelineRunState("not json")).toBeNull();
  expect(parsePipelineRunState("{")).toBeNull();
  expect(parsePipelineRunState("[]")).toBeNull(); // array, not a plain object
  expect(parsePipelineRunState("null")).toBeNull();
  expect(parsePipelineRunState(JSON.stringify({ status: "running" }))).toBeNull(); // no pipelineId
  expect(parsePipelineRunState(JSON.stringify({ pipelineId: "" }))).toBeNull(); // empty string
});

test("parsePipelineRunState: minimal valid input fills every default", () => {
  const parsed = parsePipelineRunState(JSON.stringify({ pipelineId: "pipe-1" }));
  expect(parsed).toEqual({
    pipelineId: "pipe-1",
    pipelineName: "",
    snapshot: null,
    status: "idle",
    active: [],
    joins: {},
    blocked: [],
    history: [],
    stepCount: 0,
    startedAt: null,
    endedAt: null,
  });
});

test("parsePipelineRunState: an unknown status value falls back to idle", () => {
  const parsed = parsePipelineRunState(JSON.stringify({ pipelineId: "pipe-1", status: "not-a-real-status" }));
  expect(parsed?.status).toBe("idle");

  const statuses: PipelineRunState["status"][] = ["idle", "running", "blocked", "done", "cancelled"];
  for (const status of statuses) {
    const p = parsePipelineRunState(JSON.stringify({ pipelineId: "pipe-1", status }));
    expect(p?.status).toBe(status);
  }
});

test("parsePipelineRunState: junk entries are dropped from active/blocked/history/joins, valid ones kept", () => {
  const raw = {
    pipelineId: "pipe-1",
    active: [
      { stepId: "s1", taskId: "t1", seq: 1 }, // valid
      { stepId: "s2", taskId: "t2" }, // missing seq -> dropped
      { stepId: "s3", seq: 2 }, // missing taskId -> dropped
      "junk", // not even an object -> dropped
      null,
    ],
    blocked: [
      { taskId: "t1", stepId: "s1", kind: "step-failed", message: "boom" }, // valid
      { taskId: "t2", stepId: "s2", kind: "not-a-real-kind", message: "x" }, // invalid kind -> dropped
      { taskId: null, stepId: null, kind: "handoff-missing", message: "" }, // valid, nullable ids
    ],
    history: [
      {
        seq: 1, stepId: "s1", taskId: "t1", startedAt: 100, endedAt: 200,
        outcome: "succeeded", handoff: { schemaVersion: 1, purpose: "p" }, nextStepIds: ["s2", 5, "s3"],
      }, // valid, junk entry in nextStepIds filtered
      { seq: 2, stepId: "s2" }, // missing taskId/startedAt -> dropped
      { seq: 3, stepId: "s3", taskId: "t3", startedAt: 300, outcome: "not-a-real-outcome" }, // invalid outcome -> null, record kept
    ],
    joins: {
      "s2": { arrivals: [{ fromStepId: "s1", seq: 1, handoff: null }, { fromStepId: "s1" }, "junk"] },
      "s3": "not-an-object", // dropped entirely
    },
  };

  const parsed = parsePipelineRunState(JSON.stringify(raw));
  expect(parsed).not.toBeNull();

  expect(parsed?.active).toEqual([{ stepId: "s1", taskId: "t1", seq: 1 }]);

  expect(parsed?.blocked).toEqual([
    { taskId: "t1", stepId: "s1", kind: "step-failed", message: "boom" },
    { taskId: null, stepId: null, kind: "handoff-missing", message: "" },
  ]);

  expect(parsed?.history).toHaveLength(2);
  // `handoff` is kept as-is (not deep-validated) — the fixture is
  // deliberately a partial object, so the expected value needs a type
  // escape hatch the same way the raw fixture above does at runtime.
  expect(parsed?.history[0]).toEqual({
    seq: 1, stepId: "s1", taskId: "t1", startedAt: 100, endedAt: 200,
    outcome: "succeeded", handoff: { schemaVersion: 1, purpose: "p" }, nextStepIds: ["s2", "s3"],
  } as unknown as PipelineStepRecord);
  expect(parsed?.history[1]).toEqual({
    seq: 3, stepId: "s3", taskId: "t3", startedAt: 300, endedAt: null,
    outcome: null, handoff: null, nextStepIds: [],
  });

  expect(Object.keys(parsed?.joins ?? {})).toEqual(["s2"]);
  expect(parsed?.joins.s2?.arrivals).toEqual([{ fromStepId: "s1", seq: 1, handoff: null }]);
});

test("parsePipelineRunState: a blocked entry's `pending` and the run's `capExtensions` round-trip, junk is dropped", () => {
  const raw = {
    pipelineId: "pipe-1",
    capExtensions: 2,
    blocked: [
      {
        // valid `pending` — its `arrivals` reuse the same junk-filtering as
        // `joins` above (a malformed arrival is dropped, a valid one kept).
        taskId: null, stepId: "s1", kind: "step-cap", message: "capped",
        pending: {
          stepId: "s1",
          arrivals: [{ fromStepId: "s0", seq: 1, handoff: null }, { fromStepId: "s0" }, "junk"],
        },
      },
      {
        // `pending` missing its own `stepId` -> the whole `pending` sub-shape
        // is dropped (never persisted half-valid), the block itself is kept.
        taskId: null, stepId: "s2", kind: "join-incomplete", message: "waiting",
        pending: { arrivals: [] },
      },
      {
        // `pending` isn't even an object -> dropped, block kept.
        taskId: null, stepId: "s3", kind: "join-incomplete", message: "waiting too",
        pending: "not-an-object",
      },
    ],
  };

  const parsed = parsePipelineRunState(JSON.stringify(raw));
  expect(parsed?.capExtensions).toBe(2);
  expect(parsed?.blocked).toEqual([
    {
      taskId: null, stepId: "s1", kind: "step-cap", message: "capped",
      pending: { stepId: "s1", arrivals: [{ fromStepId: "s0", seq: 1, handoff: null }] },
    },
    { taskId: null, stepId: "s2", kind: "join-incomplete", message: "waiting" },
    { taskId: null, stepId: "s3", kind: "join-incomplete", message: "waiting too" },
  ]);

  // capExtensions omits the key (not just nulls it) when absent or invalid,
  // so a pre-existing equality check against a run with no `capExtensions`
  // field never sees a stray new key.
  expect(parsePipelineRunState(JSON.stringify({ pipelineId: "pipe-1" }))?.capExtensions).toBeUndefined();
  expect(
    parsePipelineRunState(JSON.stringify({ pipelineId: "pipe-1", capExtensions: -1 }))?.capExtensions,
  ).toBeUndefined();
  expect(
    parsePipelineRunState(JSON.stringify({ pipelineId: "pipe-1", capExtensions: "nope" }))?.capExtensions,
  ).toBeUndefined();
});

test("parsePipelineRunState: a snapshot.graph that's shape-valid but semantically invalid is trusted as-is (m18 — no deep re-validation on read)", () => {
  // A run snapshot is captured exactly once, at run-start, by `buildSnapshot`'s
  // own `validatePipelineGraph` call — nothing ever mutates it afterward, so
  // `sanitizeRunSnapshot` no longer re-runs full validation on every read.
  // Duplicate step names would fail `validatePipelineGraph`, but the shape
  // itself (`steps`/`edges` arrays) is fine, so it's trusted through
  // unchanged rather than collapsed to `null`.
  const dupNameGraph = { steps: [{ id: "s1", name: "Dup" }, { id: "s2", name: "dup" }], edges: [], startStepId: null } as unknown as PipelineGraph;
  const raw = {
    pipelineId: "pipe-1",
    pipelineName: "My Pipe",
    status: "running",
    snapshot: {
      graph: dupNameGraph,
      maxSteps: 10,
      profiles: { "profile-1": { id: "profile-1", name: "Agent" } },
      capturedAt: 123,
    },
  };
  const parsed = parsePipelineRunState(JSON.stringify(raw));
  expect(parsed?.pipelineName).toBe("My Pipe");
  expect(parsed?.status).toBe("running");
  expect(parsed?.snapshot?.graph).toEqual(dupNameGraph);
  expect(parsed?.snapshot?.maxSteps).toBe(10);
  expect(parsed?.snapshot?.capturedAt).toBe(123);

  const validGraph = makeGraph();
  const validRaw = {
    pipelineId: "pipe-1",
    snapshot: { graph: validGraph, maxSteps: 10, profiles: { "profile-1": { id: "profile-1" } }, capturedAt: 123 },
  };
  const validParsed = parsePipelineRunState(JSON.stringify(validRaw));
  expect(validParsed?.snapshot?.graph).toEqual(validGraph);
  expect(validParsed?.snapshot?.maxSteps).toBe(10);
  expect(validParsed?.snapshot?.capturedAt).toBe(123);
  // `profiles` is kept as "a record of objects" (not deep-validated against
  // `AgentProfileSnapshot`) — same type escape hatch as the handoff fixture.
  expect(validParsed?.snapshot?.profiles).toEqual(
    { "profile-1": { id: "profile-1" } } as unknown as PipelineRunSnapshotProfiles,
  );
});

test("parsePipelineRunState: a snapshot.graph that isn't even shape-valid (non-array steps/edges, or not an object) nulls the whole snapshot but keeps the rest of the run", () => {
  const rawNonArraySteps = {
    pipelineId: "pipe-1",
    status: "running",
    snapshot: { graph: { steps: "nope", edges: [], startStepId: null }, maxSteps: 10, profiles: {}, capturedAt: 1 },
  };
  const parsedNonArraySteps = parsePipelineRunState(JSON.stringify(rawNonArraySteps));
  expect(parsedNonArraySteps?.snapshot).toBeNull();
  expect(parsedNonArraySteps?.pipelineId).toBe("pipe-1");
  expect(parsedNonArraySteps?.status).toBe("running");

  const rawNonArrayEdges = {
    pipelineId: "pipe-1",
    snapshot: { graph: { steps: [], edges: "nope", startStepId: null }, maxSteps: 10, profiles: {}, capturedAt: 1 },
  };
  expect(parsePipelineRunState(JSON.stringify(rawNonArrayEdges))?.snapshot).toBeNull();

  const rawNonObjectGraph = {
    pipelineId: "pipe-1",
    snapshot: { graph: "not-an-object", maxSteps: 10, profiles: {}, capturedAt: 1 },
  };
  expect(parsePipelineRunState(JSON.stringify(rawNonObjectGraph))?.snapshot).toBeNull();
});

import { test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";

// The pipeline run state (`tasks.pipeline_run`) is read, decided on and written
// back as one JSON blob. With the database behind an async API each of those is
// a separate hop, so correctness rests on every mutation holding the parent's
// `withPipelineLock` for the whole read-decide-write (`persist` is the only
// writer). These tests fire the racing entry points at the same instant and
// assert the final state: no lost update, no double launch.

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-concurrency-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

beforeAll(async () => {
  const { initPipelineRunner } = await import("./pipeline-runner.ts");
  initPipelineRunner();
});

let liveParentIds: string[] = [];

afterEach(async () => {
  const ids = liveParentIds;
  liveParentIds = [];
  const { tasks } = await import("./db.ts");
  const { deleteTask } = await import("./orchestrator.ts");
  const { __forTest } = await import("./pipeline-runner.ts");
  __forTest.setListenerEnabled(true);
  delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  for (const id of ids) {
    if (!tasks.get(id)) continue;
    await deleteTask(id).catch(() => {});
  }
});

afterAll(async () => {
  const { tasks, pipelines, agentProfiles } = await import("./db.ts");
  const { deleteTask } = await import("./orchestrator.ts");
  for (const t of tasks.list()) {
    if (t.pipelineId && !t.pipelineParentId) await deleteTask(t.id).catch(() => {});
  }
  for (const p of pipelines.list()) pipelines.delete(p.id);
  for (const p of agentProfiles.list()) agentProfiles.delete(p.id);
  await new Promise((r) => setTimeout(r, 150));
  rmTestDataDir(DATA_DIR);
});

function uniqueName(label: string): string {
  return `pipeline-concurrency-${label}-${randomUUID()}`;
}

function freshWorkdir(): string {
  return mkdtempSync(path.join(tmpdir(), "agetor-pipeline-concurrency-wd-"));
}

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 8000, intervalMs = 15): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function makeProfile(label: string) {
  const { agentProfiles } = await import("./db.ts");
  return agentProfiles.insert({
    name: uniqueName(label),
    harness: "claude-code",
    model: "fake-model",
    effort: null,
    mode: null,
    speed: "off",
    maxMode: false,
    instructions: "",
    skills: [],
  });
}

/** The newest run row of a step task once it has stopped running. */
async function settledRun(stepTaskId: string) {
  const { runs } = await import("./db.ts");
  return waitFor(() => {
    const r = runs.listForTask(stepTaskId)[0];
    return r && r.status !== "running" ? r : undefined;
  });
}

test("fan-out siblings settling at the same instant (duplicates included) land both outcomes and launch the join exactly once", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { __forTest } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("join-race");
  const done = `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done`;
  const A = newStep({ name: "A", agentProfileId: profile.id, transition: "all", instructions: done });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: done });
  const C = newStep({ name: "C", agentProfileId: profile.id, instructions: done });
  const D = newStep({ name: "D", agentProfileId: profile.id, join: "all", instructions: done });
  const pipeline = pipelines.insert({
    name: uniqueName("join-race"),
    graph: {
      steps: [A, B, C, D],
      edges: [
        { id: "e1", from: A.id, to: B.id, label: "" },
        { id: "e2", from: A.id, to: C.id, label: "" },
        { id: "e3", from: B.id, to: D.id, label: "" },
        { id: "e4", from: C.id, to: D.id, label: "" },
      ],
      startStepId: A.id,
    },
    maxSteps: 25,
  });
  const created = await createTask({ title: "join race", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  // No listener: every settle below is delivered by hand, so the test controls
  // exactly which ones race.
  __forTest.setListenerEnabled(false);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);
  const stepA = await waitFor(() => tasks.stepsForParent(parentId).find((s) => s.pipelineStepId === A.id));
  const runA = await settledRun(stepA.id);
  await __forTest.handleRunStatus(stepA.id, runA.id, "succeeded");

  const stepB = await waitFor(() => tasks.stepsForParent(parentId).find((s) => s.pipelineStepId === B.id));
  const stepC = await waitFor(() => tasks.stepsForParent(parentId).find((s) => s.pipelineStepId === C.id));
  const runB = await settledRun(stepB.id);
  const runC = await settledRun(stepC.id);

  // Four settles in one tick: both siblings, each delivered twice (the
  // run-status and column events of one turn both reach the settle body).
  await Promise.all([
    __forTest.handleRunStatus(stepB.id, runB.id, "succeeded"),
    __forTest.handleRunStatus(stepC.id, runC.id, "succeeded"),
    __forTest.handleRunStatus(stepB.id, runB.id, "succeeded"),
    __forTest.handleRunStatus(stepC.id, runC.id, "succeeded"),
  ]);

  const dSteps = await waitFor(() => {
    const d = tasks.stepsForParent(parentId).filter((s) => s.pipelineStepId === D.id);
    return d.length > 0 ? d : undefined;
  });
  // The join fired once, with both arrivals: no lost sibling, no double launch.
  expect(dSteps.length).toBe(1);
  expect(dSteps[0]!.prompt).toContain('From "B"');
  expect(dSteps[0]!.prompt).toContain('From "C"');

  const afterJoin = tasks.get(parentId)!.pipelineRun!;
  expect(Object.keys(afterJoin.joins).length).toBe(0);
  expect(afterJoin.stepCount).toBe(4);
  // Every launched execution has exactly one history record (A, B, C, D).
  expect(afterJoin.history.map((h) => h.stepId).sort()).toEqual([A.id, B.id, C.id, D.id].sort());
  for (const stepId of [A.id, B.id, C.id]) {
    expect(afterJoin.history.find((h) => h.stepId === stepId)?.outcome).toBe("succeeded");
  }

  // Let D finish through the same hand-delivered path, then the run is done.
  const runD = await settledRun(dSteps[0]!.id);
  await __forTest.handleRunStatus(dSteps[0]!.id, runD.id, "succeeded");
  const finished = tasks.get(parentId)!.pipelineRun!;
  expect(finished.status).toBe("done");
  expect(finished.history.filter((h) => h.outcome === "succeeded").length).toBe(4);
});

test("concurrent manual advances of one blocked step resolve it once: one wins, the rest are refused, one successor launches", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { registerTmuxPrompt } = await import("./interactions.ts");
  const { __forTest, advancePipeline } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("advance-race");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const pipeline = pipelines.insert({
    name: uniqueName("advance-race"),
    graph: { steps: [A, B], edges: [{ id: "e1", from: A.id, to: B.id, label: "" }], startStepId: A.id },
    maxSteps: 25,
  });
  const created = await createTask({ title: "advance race", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  __forTest.setListenerEnabled(false);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);
  const stepA = await waitFor(() => tasks.stepsForParent(parentId).find((s) => s.pipelineStepId === A.id));
  const runA = await settledRun(stepA.id);
  // A pending card parks the step as blocked "waiting for you".
  registerTmuxPrompt({
    taskId: stepA.id,
    runId: runA.id,
    paneText: "pane",
    choices: [{ key: "1", label: "Yes" }],
    fingerprint: `fp-advance-race-${stepA.id}`,
  });
  await __forTest.handleRunStatus(stepA.id, runA.id, "succeeded");
  expect(tasks.get(parentId)!.pipelineRun!.status).toBe("blocked");
  __forTest.setListenerEnabled(true);

  const results = await Promise.all(
    [0, 1, 2, 3].map(() => advancePipeline(parentId, { nextStepIds: [B.id], fromTaskId: stepA.id })),
  );
  const ok = results.filter((r) => "task" in r);
  const refused = results.filter((r) => "error" in r);
  expect(ok.length).toBe(1);
  expect(refused.length).toBe(3);
  for (const r of refused) {
    expect((r as { status: number }).status).toBe(400);
    expect((r as { error: string }).error).toBe("no active execution for that task");
  }

  // Exactly one B was launched, and A's record was resolved exactly once.
  const bSteps = tasks.stepsForParent(parentId).filter((s) => s.pipelineStepId === B.id);
  expect(bSteps.length).toBe(1);
  const run = tasks.get(parentId)!.pipelineRun!;
  expect(run.stepCount).toBe(2);
  expect(run.history.filter((h) => h.stepId === A.id).length).toBe(1);
  expect(run.history.find((h) => h.stepId === A.id)?.outcome).toBe("advanced-manually");
  expect(run.active.some((a) => a.taskId === stepA.id)).toBe(false);

  // B's own (listener-driven) settle finishes the run.
  await waitFor(() => tasks.get(parentId)?.pipelineRun?.status === "done");
});

test("a Stop racing the siblings' completions wins: no successor launches, every outcome is kept, the stop marker survives", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { __forTest, cancelPipelineRun } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("stop-race");
  const done = `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done`;
  const A = newStep({ name: "A", agentProfileId: profile.id, transition: "all", instructions: done });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: done });
  const C = newStep({ name: "C", agentProfileId: profile.id, instructions: done });
  const D = newStep({ name: "D", agentProfileId: profile.id, join: "all", instructions: done });
  const pipeline = pipelines.insert({
    name: uniqueName("stop-race"),
    graph: {
      steps: [A, B, C, D],
      edges: [
        { id: "e1", from: A.id, to: B.id, label: "" },
        { id: "e2", from: A.id, to: C.id, label: "" },
        { id: "e3", from: B.id, to: D.id, label: "" },
        { id: "e4", from: C.id, to: D.id, label: "" },
      ],
      startStepId: A.id,
    },
    maxSteps: 25,
  });
  const created = await createTask({ title: "stop race", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  // Hold B and C open so both are live when the Stop lands.
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "600";
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);
  await waitFor(() => {
    const t = tasks.get(parentId);
    const bc = tasks.stepsForParent(parentId).filter((s) => s.pipelineStepId === B.id || s.pipelineStepId === C.id);
    return bc.length === 2 && bc.every((s) => s.column === "running") && t?.pipelineRun?.active.length === 2;
  }, 15000);
  delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  const stepB = tasks.stepsForParent(parentId).find((s) => s.pipelineStepId === B.id)!;
  const stepC = tasks.stepsForParent(parentId).find((s) => s.pipelineStepId === C.id)!;
  const { runs } = await import("./db.ts");
  const runB = runs.listForTask(stepB.id)[0]!;
  const runC = runs.listForTask(stepC.id)[0]!;

  // The Stop and both siblings' (late) success settles in the same tick.
  const [stopped] = await Promise.all([
    cancelPipelineRun(parentId),
    __forTest.handleRunStatus(stepB.id, runB.id, "succeeded"),
    __forTest.handleRunStatus(stepC.id, runC.id, "succeeded"),
  ]);
  expect("task" in stopped).toBe(true);

  // Wait for the state to be fully settled: cancelled, every sibling record
  // closed and no step run still live (the cancelled runs' own settles landed).
  const { runs: runRows } = await import("./db.ts");
  await waitFor(() => {
    const r = tasks.get(parentId)?.pipelineRun;
    if (r?.status !== "cancelled") return false;
    if (![B.id, C.id].every((id) => r.history.find((h) => h.stepId === id)?.endedAt != null)) return false;
    return [stepB.id, stepC.id].every((id) => runRows.listForTask(id).every((x) => x.status !== "running"));
  });

  const run = tasks.get(parentId)!.pipelineRun!;
  expect(run.status).toBe("cancelled");
  expect(run.stopRequestedAt).not.toBeNull();
  // Nothing launched behind the Stop, and the join stayed un-fired.
  expect(tasks.stepsForParent(parentId).filter((s) => s.pipelineStepId === D.id).length).toBe(0);
  expect(run.stepCount).toBe(3);
  // Every sibling's record is closed, none lost to a last-writer-wins
  // overwrite, and it is consistent with where the execution now sits: a
  // cancelled one stays `active` (Retry re-runs it); one whose turn finished
  // with its handoff before the kill landed is recorded `succeeded` and left
  // `active` no more, its successor held as a retryable stop hold (M-R2) rather
  // than launched.
  for (const stepId of [B.id, C.id]) {
    const h = run.history.find((r) => r.stepId === stepId)!;
    expect(h.outcome === "cancelled" || h.outcome === "succeeded").toBe(true);
    expect(h.endedAt).not.toBeNull();
    const stillActive = run.active.some((a) => a.stepId === stepId);
    expect(stillActive).toBe(h.outcome === "cancelled");
  }
  if (run.history.some((h) => h.stepId === B.id && h.outcome === "succeeded") ||
      run.history.some((h) => h.stepId === C.id && h.outcome === "succeeded")) {
    // The join (D) is waiting on arrivals, held, never launched.
    expect(run.blocked.some((b) => b.stepId === D.id) || Object.keys(run.joins).length > 0).toBe(true);
  }
});

/**
 * T0 — the resume spike (docs/plans/pipeline-human-step-resume-spike.md).
 *
 * Proves the production seam a human gate's `return` uses in `resume` mode:
 * a SETTLED step execution can be re-armed as a new execution on its
 * existing task (no new task row), resumed through `sendInput`, settled into
 * a new history record, and forced back to the gate deterministically — even
 * when the step's own handoff names a different next step.
 *
 * It runs the real runner path (`reviewHumanStep` with `mode: "resume"`) over
 * the fake claude driver, so it is the same code the route/CLI call.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-human-resume-spike-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

beforeAll(async () => {
  const { initPipelineRunner } = await import("./pipeline-runner.ts");
  initPipelineRunner();
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

async function waitFor<T>(fn: () => T | null | undefined, timeoutMs = 5000, intervalMs = 15): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test("resume: a settled execution is re-armed on the same task, settles into a new record, and is forced back to its gate", async () => {
  const { agentProfiles, pipelines, tasks } = await import("./db.ts");
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { reviewHumanStep } = await import("./pipeline-runner.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = agentProfiles.insert({
    name: `spike-${randomUUID()}`,
    harness: "claude-code",
    model: "fake-model",
    effort: null,
    mode: null,
    speed: "off",
    maxMode: false,
    instructions: "",
    skills: [],
  });
  const A = newStep({
    name: "A",
    agentProfileId: profile.id,
    // The handoff names B, so only the forced return edge can send A back
    // to the gate.
    instructions: `Do A. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:B`,
  });
  const H = newStep({ name: "H", type: "human" });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `Do B. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const pipeline = pipelines.insert({
    name: `spike-${randomUUID()}`,
    graph: {
      steps: [A, H, B],
      edges: [
        { id: "e1", from: A.id, to: H.id, label: "" },
        { id: "e2", from: H.id, to: B.id, label: "" },
      ],
      startStepId: A.id,
    },
    maxSteps: 25,
  });

  const created = await createTask({
    title: "resume spike",
    prompt: "goal",
    workdir: mkdtempSync(path.join(tmpdir(), "agetor-human-resume-wd-")),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;

  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    // A settles and the gate opens.
    const firstGate = await waitFor(() => tasks.get(parentId)?.pipelineRun?.humanSteps?.[0]);
    const runBefore = tasks.get(parentId)!.pipelineRun!;
    const aRecord = runBefore.history.find((h) => h.stepId === A.id && h.taskId !== null)!;
    const aTaskId = aRecord.taskId!;
    const taskRowsBefore = tasks.stepsForParent(parentId).length;
    const stepCountBefore = runBefore.stepCount;
    const runIdsBefore = (await import("./db.ts")).runs.listForTask(aTaskId).map((r) => r.id);

    // The production resume seam.
    const res = await reviewHumanStep(parentId, {
      stepId: H.id,
      seq: firstGate.seq,
      decision: "return",
      comment: "please redo the header",
      mode: "resume",
    });
    if ("error" in res) throw new Error(res.error);

    // A second execution appears on the SAME task and the gate re-opens.
    const secondGate = await waitFor(() => {
      const g = tasks.get(parentId)?.pipelineRun?.humanSteps?.[0];
      return g && g.seq !== firstGate.seq ? g : undefined;
    }, 10_000);

    const run = tasks.get(parentId)!.pipelineRun!;
    // No second task row: the resume reused A's task.
    expect(tasks.stepsForParent(parentId).length).toBe(taskRowsBefore);
    expect(tasks.stepsForParent(parentId).filter((s) => s.pipelineStepId === A.id)).toHaveLength(1);
    // A new run row on the same task.
    const runIdsAfter = (await import("./db.ts")).runs.listForTask(aTaskId).map((r) => r.id);
    expect(runIdsAfter.length).toBe(runIdsBefore.length + 1);
    // A new history record, settled, forced back to the gate.
    const returned = run.history.filter((h) => h.stepId === A.id && h.taskId === aTaskId);
    expect(returned.length).toBe(2);
    const latest = returned[returned.length - 1]!;
    expect(latest.returnToStepId).toBe(H.id);
    expect(latest.outcome).toBe("succeeded");
    expect(latest.nextStepIds).toEqual([H.id]);
    // stepCount counts AGENT executions only; a resume does not add one.
    expect(run.stepCount).toBe(stepCountBefore);
    expect(secondGate.stepId).toBe(H.id);
    // The gate's arrival carries the resumed A handoff (which named B).
    expect(secondGate.arrivals[0]!.fromStepId).toBe(A.id);
  } finally {
    const { deleteTask } = await import("./orchestrator.ts");
    await deleteTask(parentId).catch(() => {});
  }
});

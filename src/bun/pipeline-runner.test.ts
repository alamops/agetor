import { test, expect, beforeAll } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import — set it (and
// the fake-driver env) before any dynamic import touches db.ts/orchestrator.ts,
// mirroring orchestrator-agent-profiles.test.ts's own bootstrap.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-runner-"));

process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo"; // tmux -V probe in agent-status passes

// The runner only processes settle/column events once subscribed — in the
// real app `index.ts`/`headless.ts` call this at boot; tests must call it
// themselves exactly once before the first `startTask` on a pipeline task,
// or every run silently wedges in `running` forever (nothing is listening).
beforeAll(async () => {
  const { initPipelineRunner } = await import("./pipeline-runner.ts");
  initPipelineRunner();
});

function uniqueName(label: string): string {
  return `pipeline-runner-${label}-${randomUUID()}`;
}

function freshWorkdir(): string {
  return mkdtempSync(path.join(tmpdir(), "agetor-pipeline-runner-wd-"));
}

/** Poll `fn` until it returns a truthy value or `timeoutMs` elapses. */
async function waitFor<T>(fn: () => T | null | undefined, timeoutMs = 5000, intervalMs = 15): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Keep polling until `pipelineRun.active.length >= count` is observed at
 *  least once, or the run reaches `done`/`timeoutMs` elapses — used to catch
 *  a transient fan-out window (two step tasks briefly both `active`) that a
 *  single snapshot read could easily miss. Returns whether it was observed. */
async function observedActiveCountAtLeast(parentId: string, count: number, timeoutMs = 4000): Promise<boolean> {
  const { tasks } = await import("./db.ts");
  const start = Date.now();
  for (;;) {
    const t = tasks.get(parentId);
    if ((t?.pipelineRun?.active.length ?? 0) >= count) return true;
    if (t?.pipelineRun?.status === "done" || t?.pipelineRun?.status === "blocked") return false;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 3));
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
    fast: false,
    maxMode: false,
    instructions: "",
    skills: [],
  });
}

test("linear A→B→C reaches review with 3 succeeded history records, handoff files, and B's prompt carrying A's handoff + the goal", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { pipelineRunsDir } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("linear");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `Do A. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `Do B. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const C = newStep({ name: "C", agentProfileId: profile.id, instructions: `Do C. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = {
    steps: [A, B, C],
    edges: [
      { id: "e1", from: A.id, to: B.id, label: "" },
      { id: "e2", from: B.id, to: C.id, label: "" },
    ],
    startStepId: A.id,
  };
  const pipeline = pipelines.insert({ name: uniqueName("linear-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({
    title: "linear run",
    prompt: "the overall goal text",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;

  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });

  expect(finished.column).toBe("review");
  const run = finished.pipelineRun!;
  expect(run.history.length).toBe(3);
  expect(run.history.every((h) => h.outcome === "succeeded")).toBe(true);
  expect(run.blocked.length).toBe(0);

  const steps = tasks.stepsForParent(parentId);
  expect(steps.length).toBe(3);
  for (const s of steps) expect(s.column).toBe("done");

  const stepB = steps.find((s) => s.pipelineStepId === B.id)!;
  expect(stepB.prompt).toContain("the overall goal text");
  expect(stepB.prompt).toContain("fake purpose");
  expect(stepB.prompt).toContain('From "A"');

  const dir = pipelineRunsDir(parentId);
  expect(existsSync(dir)).toBe(true);
  expect(readdirSync(dir).length).toBeGreaterThan(0);
});

test("branching by name: A picks C over B via handoff.next", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("branch");
  const A = newStep({ name: "A", agentProfileId: profile.id, transition: "choose", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:C` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const C = newStep({ name: "C", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = {
    steps: [A, B, C],
    edges: [
      { id: "e1", from: A.id, to: B.id, label: "" },
      { id: "e2", from: A.id, to: C.id, label: "" },
    ],
    startStepId: A.id,
  };
  const pipeline = pipelines.insert({ name: uniqueName("branch-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "branch run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });

  expect(finished.pipelineRun!.history.length).toBe(2);
  const steps = tasks.stepsForParent(parentId);
  expect(steps.length).toBe(2);
  expect(steps.some((s) => s.pipelineStepId === C.id)).toBe(true);
  expect(steps.some((s) => s.pipelineStepId === B.id)).toBe(false);
});

test(":missing → blocked handoff-missing; advancePipeline(nextStepIds:[B]) continues to done", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { advancePipeline } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("missing");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A, B], edges: [{ id: "e1", from: A.id, to: B.id, label: "" }], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("missing-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "missing run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  });
  expect(blocked.column).toBe("blocked");
  expect(blocked.pipelineRun!.blocked.some((b) => b.kind === "handoff-missing")).toBe(true);
  expect(blocked.pipelineRun!.active.length).toBe(1);

  const advanced = await advancePipeline(parentId, { nextStepIds: [B.id] });
  if ("error" in advanced) throw new Error(advanced.error);

  const done = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });
  expect(done.column).toBe("review");
  const advancedRecord = done.pipelineRun!.history.find((h) => h.stepId === A.id);
  expect(advancedRecord?.outcome).toBe("advanced-manually");
});

test(":invalid → blocked handoff-invalid", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("invalid");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:invalid` });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("invalid-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "invalid run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  });
  expect(blocked.pipelineRun!.blocked.some((b) => b.kind === "handoff-invalid")).toBe(true);
});

test("fan-out transition:\"all\" (A→B,C) then join:\"all\" (D) — both branches run in parallel, D starts once with two previous handoffs", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("fanout-all");
  const A = newStep({ name: "A", agentProfileId: profile.id, transition: "all", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const C = newStep({ name: "C", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const D = newStep({ name: "D", agentProfileId: profile.id, join: "all", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = {
    steps: [A, B, C, D],
    edges: [
      { id: "e1", from: A.id, to: B.id, label: "" },
      { id: "e2", from: A.id, to: C.id, label: "" },
      { id: "e3", from: B.id, to: D.id, label: "" },
      { id: "e4", from: C.id, to: D.id, label: "" },
    ],
    startStepId: A.id,
  };
  const pipeline = pipelines.insert({ name: uniqueName("join-all-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "join-all run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const sawTwoActive = await observedActiveCountAtLeast(parentId, 2);
  expect(sawTwoActive).toBe(true);

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  }, 8000);

  const steps = tasks.stepsForParent(parentId);
  const dSteps = steps.filter((s) => s.pipelineStepId === D.id);
  expect(dSteps.length).toBe(1);
  expect(dSteps[0]!.prompt).toContain('From "B"');
  expect(dSteps[0]!.prompt).toContain('From "C"');
  expect(finished.pipelineRun!.history.length).toBe(4);
  expect(Object.keys(finished.pipelineRun!.joins).length).toBe(0);
});

test("join:\"any\" (D, default) starts twice — once per arrival", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("fanout-any");
  const A = newStep({ name: "A", agentProfileId: profile.id, transition: "all", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const C = newStep({ name: "C", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const D = newStep({ name: "D", agentProfileId: profile.id, join: "any", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = {
    steps: [A, B, C, D],
    edges: [
      { id: "e1", from: A.id, to: B.id, label: "" },
      { id: "e2", from: A.id, to: C.id, label: "" },
      { id: "e3", from: B.id, to: D.id, label: "" },
      { id: "e4", from: C.id, to: D.id, label: "" },
    ],
    startStepId: A.id,
  };
  const pipeline = pipelines.insert({ name: uniqueName("join-any-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "join-any run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  }, 8000);

  const steps = tasks.stepsForParent(parentId);
  const dSteps = steps.filter((s) => s.pipelineStepId === D.id);
  expect(dSteps.length).toBe(2);
  expect(finished.pipelineRun!.history.length).toBe(5); // A, B, C, D, D
});

test("join-incomplete when the other incoming path never arrives; manual advance launches the join with the partial arrival", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { advancePipeline } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("join-incomplete");
  const A = newStep({ name: "A", agentProfileId: profile.id, transition: "all", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  // C never actually hands off to D — it picks E instead (marker :E).
  const C = newStep({ name: "C", agentProfileId: profile.id, transition: "choose", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:E` });
  const D = newStep({ name: "D", agentProfileId: profile.id, join: "all", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const E = newStep({ name: "E", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = {
    steps: [A, B, C, D, E],
    edges: [
      { id: "e1", from: A.id, to: B.id, label: "" },
      { id: "e2", from: A.id, to: C.id, label: "" },
      { id: "e3", from: B.id, to: D.id, label: "" },
      { id: "e4", from: C.id, to: D.id, label: "" },
      { id: "e5", from: C.id, to: E.id, label: "" },
    ],
    startStepId: A.id,
  };
  const pipeline = pipelines.insert({ name: uniqueName("join-incomplete-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "join-incomplete run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  }, 8000);
  const block = blocked.pipelineRun!.blocked.find((b) => b.kind === "join-incomplete");
  expect(block).toBeTruthy();
  expect(block!.stepId).toBe(D.id);
  expect(blocked.pipelineRun!.active.length).toBe(0);
  expect(blocked.pipelineRun!.joins[D.id]?.arrivals.length).toBe(1);

  const advanced = await advancePipeline(parentId, { nextStepIds: [D.id] });
  if ("error" in advanced) throw new Error(advanced.error);

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  }, 8000);
  const steps = tasks.stepsForParent(parentId);
  const dStep = steps.find((s) => s.pipelineStepId === D.id)!;
  expect(dStep.prompt).toContain('From "B"');
  expect(dStep.prompt).not.toContain('From "C"');
  expect(Object.keys(finished.pipelineRun!.joins).length).toBe(0);
});

test("step cap: A↔B cycle with maxSteps 3 blocks with step-cap after 3 executions", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("cap");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = {
    steps: [A, B],
    edges: [
      { id: "e1", from: A.id, to: B.id, label: "" },
      { id: "e2", from: B.id, to: A.id, label: "" },
    ],
    startStepId: A.id,
  };
  const pipeline = pipelines.insert({ name: uniqueName("cap-pipeline"), graph, maxSteps: 3 });

  const created = await createTask({ title: "cap run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  }, 8000);
  expect(blocked.pipelineRun!.blocked.some((b) => b.kind === "step-cap")).toBe(true);
  expect(blocked.pipelineRun!.stepCount).toBe(3);
  expect(blocked.pipelineRun!.history.length).toBe(3);
});

test("cancel mid-step then retry restarts the same step task", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { cancelPipelineRun, retryPipelineStep } = await import("./pipeline-runner.ts");

  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "700";
  try {
    const profile = await makeProfile("cancel");
    const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
    const graph = { steps: [A], edges: [], startStepId: A.id };
    const pipeline = pipelines.insert({ name: uniqueName("cancel-pipeline"), graph, maxSteps: 25 });

    const created = await createTask({ title: "cancel run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
    if ("error" in created) throw new Error(created.error);
    const parentId = created.task.id;
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    await waitFor(() => {
      const steps = tasks.stepsForParent(parentId);
      return steps[0]?.column === "running" ? steps[0] : undefined;
    });

    const cancelled = await cancelPipelineRun(parentId);
    if ("error" in cancelled) throw new Error(cancelled.error);

    const afterCancel = await waitFor(() => {
      const t = tasks.get(parentId);
      return t?.pipelineRun?.status === "cancelled" ? t : undefined;
    });
    expect(afterCancel.column).toBe("ready");
    expect(afterCancel.pipelineRun!.active.length).toBe(1);
    const stepsBeforeRetry = tasks.stepsForParent(parentId);
    expect(stepsBeforeRetry.length).toBe(1);

    const retried = await retryPipelineStep(parentId);
    if ("error" in retried) throw new Error(retried.error);

    const runningAgain = await waitFor(() => {
      const t = tasks.get(parentId);
      return t?.pipelineRun?.status === "running" ? t : undefined;
    });
    expect(runningAgain.pipelineRun!.active.length).toBe(1);
    // Retry re-runs the SAME step task, never inserts a second one.
    expect(tasks.stepsForParent(parentId).length).toBe(1);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
});

test("delete cascade removes step tasks + run dir; archive cascade archives steps; a direct step delete/archive is refused", async () => {
  const { createTask, startTask, deleteTask, archiveTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { pipelineRunsDir } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("cascade");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A, B], edges: [{ id: "e1", from: A.id, to: B.id, label: "" }], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("cascade-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "cascade run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });
  expect(finished.column).toBe("review");

  const stepsBefore = tasks.stepsForParent(parentId);
  expect(stepsBefore.length).toBe(2);

  // Direct step archive/delete is refused (no `fromPipeline`) — both the
  // step and the parent survive untouched.
  const stepArchiveResult = await archiveTask(stepsBefore[0]!.id, { force: true });
  expect("error" in stepArchiveResult).toBe(true);
  expect(tasks.get(stepsBefore[0]!.id)?.archivedAt ?? null).toBeNull();

  await deleteTask(stepsBefore[0]!.id);
  expect(tasks.get(stepsBefore[0]!.id)).not.toBeNull();
  expect(tasks.get(parentId)).not.toBeNull();

  // Archive cascade: force past the "must be in Done" gate (the parent is
  // in `review`, matching a real pipeline task that hasn't been dragged to
  // Done yet) — every step archives along with it.
  const archived = await archiveTask(parentId, { force: true });
  if ("error" in archived) throw new Error(archived.error);
  for (const s of tasks.stepsForParent(parentId)) {
    expect(s.archivedAt).not.toBeNull();
  }

  const dir = pipelineRunsDir(parentId);
  expect(existsSync(dir)).toBe(true);

  // Delete cascade: parent + every step + the run dir are all gone.
  await deleteTask(parentId);
  expect(tasks.get(parentId)).toBeNull();
  for (const s of stepsBefore) {
    expect(tasks.get(s.id)).toBeNull();
  }
  expect(existsSync(dir)).toBe(false);
});

test("createTask rejects pipelineId+agentProfileId together, an unknown pipeline, and a pipeline with a step that has no agent", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const { pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");

  const profile = await makeProfile("createtask-reject");

  const noAgentGraph = { steps: [newStep({ name: "A", agentProfileId: null })], edges: [], startStepId: null };
  const noAgentPipeline = pipelines.insert({ name: uniqueName("no-agent-pipeline"), graph: noAgentGraph, maxSteps: 5 });
  const rejectedNoAgent = await createTask({
    title: "x", prompt: "y", workdir: freshWorkdir(), isolation: "none", pipelineId: noAgentPipeline.id,
  });
  expect("error" in rejectedNoAgent).toBe(true);

  const goodGraph = { steps: [newStep({ name: "A", agentProfileId: profile.id })], edges: [], startStepId: null };
  const goodPipeline = pipelines.insert({ name: uniqueName("good-pipeline"), graph: goodGraph, maxSteps: 5 });

  const both = await createTask({
    title: "x", prompt: "y", workdir: freshWorkdir(), isolation: "none", pipelineId: goodPipeline.id, agentProfileId: profile.id,
  });
  expect("error" in both).toBe(true);

  const unknown = await createTask({
    title: "x", prompt: "y", workdir: freshWorkdir(), isolation: "none", pipelineId: "not-a-real-pipeline-id",
  });
  expect("error" in unknown).toBe(true);

  const ok = await createTask({
    title: "x", prompt: "y", workdir: freshWorkdir(), isolation: "none", pipelineId: goodPipeline.id,
  });
  expect("error" in ok).toBe(false);
  if (!("error" in ok)) {
    expect(ok.task.pipelineId).toBe(goodPipeline.id);
    expect(ok.task.agentProfileId).toBeNull();
    expect(ok.task.pipelineRun?.status).toBe("idle");
    expect(ok.task.agent).toBe("claude-code");
  }
});

test("effectiveAgentProfile returns the frozen snapshot (never \"live\") for a step task", async () => {
  const { createTask, startTask, effectiveAgentProfile } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("effective-profile");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("effective-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "effective run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const stepTask = await waitFor(() => tasks.stepsForParent(parentId)[0]);
  const resolved = effectiveAgentProfile(stepTask);
  expect(resolved).not.toBeNull();
  expect(resolved!.source).toBe("snapshot");
  expect(resolved!.profile.id).toBe(profile.id);
});

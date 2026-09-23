import { test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import — set it (and
// the fake-driver env) before any dynamic import touches db.ts/orchestrator.ts,
// mirroring orchestrator-agent-profiles.test.ts's own bootstrap.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-runner-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

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

// `bun test` runs every file listed on the command line in ONE process with
// a shared module cache: `db.ts` opens `agetor.sqlite` exactly once, in
// whichever *.test.ts file's AGETOR_DATA_DIR happened to be captured first —
// see `test-data-dir.ts`'s doc comment. That means this file's fake-driver
// timers (`makeFakeAgent`'s `after(ms, …)` closures in agents.ts) and this
// runner's own async step-launch/settle continuations are NOT necessarily
// scoped to this file's own process lifetime the way they'd be if each file
// got its own DB: a timer left running past the end of a test here can fire
// while a LATER *.test.ts file in the same invocation is mid-`beforeEach`
// truncating shared tables, producing an unhandled `FOREIGN KEY constraint
// failed` in `runs.appendEvent` that derails bun's test runner for every
// file after it. `liveParentIds` + `waitUntilIdle` below exist to make sure
// nothing is left running when a test returns.
let liveParentIds: string[] = [];

/** Wait until pipeline task `parentId` is fully idle: its own
 *  `pipelineRun.status` isn't `"running"` AND no step task's `column` is
 *  `"running"` either — the same test `cancelPipelineRun` itself uses
 *  (`run.active.filter((a) => tasks.get(a.taskId)?.column === "running")`)
 *  to decide what's still live. A task that no longer exists (already
 *  deleted by the test itself) counts as idle. Every test that starts a run
 *  must await this before returning — see the file-level comment above for
 *  why a still-pending fake-driver timer is dangerous, not just untidy. */
async function waitUntilIdle(parentId: string, timeoutMs = 5000): Promise<void> {
  const { tasks } = await import("./db.ts");
  await waitFor(() => {
    const t = tasks.get(parentId);
    if (!t) return true;
    if (t.pipelineRun?.status === "running") return undefined;
    if (tasks.stepsForParent(parentId).some((s) => s.column === "running")) return undefined;
    return true;
  }, timeoutMs);
}

// Safety net: even with every test awaiting `waitUntilIdle` on its own
// happy path, an assertion that throws mid-test would skip that final wait
// and leave a run mid-flight. `deleteTask` kills any active handle
// (including a fake driver's pending timers) synchronously as part of its
// own cascade, so it doubles as a forceful "make sure nothing is still
// ticking" — safe to call on a task that's already idle or already deleted.
afterEach(async () => {
  const ids = liveParentIds;
  liveParentIds = [];
  const { tasks } = await import("./db.ts");
  const { deleteTask } = await import("./orchestrator.ts");
  for (const id of ids) {
    if (!tasks.get(id)) continue;
    await deleteTask(id).catch(() => {});
  }
});

// Final sweep: delete anything `afterEach` didn't already remove (a test
// that intentionally leaves its parent task around for its own assertions),
// then every pipeline/profile row this file created, then give any
// still-in-flight fake-driver timer/continuation one more beat to drain
// before attempting to remove the data dir (a no-op when `agetor.sqlite` is
// still open under another file's AGETOR_DATA_DIR — see `rmTestDataDir`).
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
  liveParentIds.push(parentId);

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
  await waitUntilIdle(parentId);
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
  liveParentIds.push(parentId);
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
  await waitUntilIdle(parentId);
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
  liveParentIds.push(parentId);
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
  await waitUntilIdle(parentId);
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
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  });
  expect(blocked.pipelineRun!.blocked.some((b) => b.kind === "handoff-invalid")).toBe(true);
  await waitUntilIdle(parentId);
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
  liveParentIds.push(parentId);
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
  await waitUntilIdle(parentId);
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
  liveParentIds.push(parentId);
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
  await waitUntilIdle(parentId);
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
  liveParentIds.push(parentId);
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
  await waitUntilIdle(parentId);
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
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  }, 8000);
  expect(blocked.pipelineRun!.blocked.some((b) => b.kind === "step-cap")).toBe(true);
  expect(blocked.pipelineRun!.stepCount).toBe(3);
  expect(blocked.pipelineRun!.history.length).toBe(3);
  await waitUntilIdle(parentId);
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
    liveParentIds.push(parentId);
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

    // Let the retried run's fake-driver resolve (bounded by the 700ms delay
    // above) actually fire before this test returns — the closure captured
    // `resolveDelayMs` at spawn time, so deleting the env var in `finally`
    // below does NOT stop it. Without this wait the retried run's turn
    // resolves ~700ms after this test has already ended, well after this
    // whole file's own tests may be done — see the file-level comment above
    // `waitUntilIdle` for why a fake-driver timer that outlives its test is
    // dangerous under a shared-process `bun test` invocation, not just untidy.
    await waitUntilIdle(parentId);
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
  liveParentIds.push(parentId);
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
  await waitUntilIdle(parentId); // no-op here (parent already gone) — kept for consistency
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
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const stepTask = await waitFor(() => tasks.stepsForParent(parentId)[0]);
  const resolved = effectiveAgentProfile(stepTask);
  expect(resolved).not.toBeNull();
  expect(resolved!.source).toBe("snapshot");
  expect(resolved!.profile.id).toBe(profile.id);

  // The step's fake handoff turn is still in flight at this point (only its
  // task ROW has appeared, not its resolve) — let it finish before this
  // test returns, same reasoning as every other test in this file.
  await waitUntilIdle(parentId);
});

// ---------------------------------------------------------------------------
// Review-fix regression coverage (M1-M16, m8-m13)
// ---------------------------------------------------------------------------

test("M1: handoff status:\"blocked\" records a step-blocked entry without advancing; advancePipeline resolves it", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep, HANDOFF_TAG } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { advancePipeline, __forTest } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("blocked-status");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A, B], edges: [{ id: "e1", from: A.id, to: B.id, label: "" }], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("blocked-status-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "blocked-status run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  let stepA: ReturnType<typeof tasks.get> = null;
  __forTest.setListenerEnabled(false);
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);
    const runRow = await waitFor(() => {
      const r = runs.listForTask(stepA!.id)[0];
      return r && r.status !== "running" ? r : undefined;
    });

    // Simulate A's OWN turn ending with a well-formed handoff whose
    // `status` is `"blocked"` (a real handoff, just one reporting it
    // couldn't finish) — appended after the fake driver's own `:done`
    // handoff so `parseHandoff`'s "last block wins" picks this one up.
    const blockedHandoff = {
      schemaVersion: 1,
      purpose: "p",
      summary: "s",
      reason: "waiting on a decision",
      next: null,
      artifacts: [] as string[],
      openQuestions: ["which approach?"],
      status: "blocked" as const,
    };
    runs.appendEvent(runRow.id, "assistant", `Done.\n<${HANDOFF_TAG}>\n${JSON.stringify(blockedHandoff)}\n</${HANDOFF_TAG}>`);
    await __forTest.handleRunStatus(stepA.id, runRow.id, "succeeded");
  } finally {
    __forTest.setListenerEnabled(true);
  }

  const afterBlock = tasks.get(parentId)!;
  const run = afterBlock.pipelineRun!;
  const block = run.blocked.find((b) => b.taskId === stepA!.id);
  expect(block?.kind).toBe("step-blocked");
  expect(block?.message).toContain("reported it is blocked");
  expect(block?.message).toContain("which approach?");
  // Not advanced — the execution is still sitting in `active`, not resolved.
  expect(run.active.length).toBe(1);
  expect(run.active[0]!.taskId).toBe(stepA!.id);
  const historyA = run.history.find((h) => h.taskId === stepA!.id);
  expect(historyA?.outcome).toBeNull();
  expect(historyA?.endedAt).toBeNull();
  expect(historyA?.handoff?.status).toBe("blocked");

  const advanced = await advancePipeline(parentId, { nextStepIds: [B.id] });
  if ("error" in advanced) throw new Error(advanced.error);

  const done = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });
  expect(done.column).toBe("review");
  const advancedRecord = done.pipelineRun!.history.find((h) => h.taskId === stepA!.id);
  expect(advancedRecord?.outcome).toBe("advanced-manually");
  await waitUntilIdle(parentId);
});

test("M2: a step-cap block carries a pending launch; retryPipelineStep extends the cap and continues", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { retryPipelineStep } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("cap-retry");
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
  const pipeline = pipelines.insert({ name: uniqueName("cap-retry-pipeline"), graph, maxSteps: 3 });

  const created = await createTask({ title: "cap-retry run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  });
  const capBlock = blocked.pipelineRun!.blocked.find((b) => b.kind === "step-cap");
  expect(capBlock).toBeTruthy();
  expect(capBlock?.pending).toBeTruthy();
  expect(blocked.pipelineRun!.stepCount).toBe(3);

  const retried = await retryPipelineStep(parentId);
  if ("error" in retried) throw new Error(retried.error);

  // capExtensions doubles the allowance (3 -> 6), so the run keeps going
  // (steps 4, 5, 6) before blocking on step-cap again at 6.
  const blockedAgain = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" && t.pipelineRun.stepCount > 3 ? t : undefined;
  }, 8000);
  expect(blockedAgain.pipelineRun!.stepCount).toBe(6);
  expect(blockedAgain.pipelineRun!.capExtensions).toBe(1);
  expect(blockedAgain.pipelineRun!.blocked.some((b) => b.kind === "step-cap")).toBe(true);
  await waitUntilIdle(parentId);
});

test("M2: a finished pipeline refuses a plain Run (\"restart it explicitly\"); startPipelineRun({restart:true}) starts fresh", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { startPipelineRun } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("restart");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("restart-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "restart run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });
  expect(finished.column).toBe("review");
  expect(finished.pipelineRun!.history.length).toBe(1);

  const plainRun = await startTask(parentId);
  expect("error" in plainRun).toBe(true);
  if ("error" in plainRun) expect(plainRun.error).toContain("restart it explicitly");
  // Refusing must not have mutated anything.
  expect(tasks.get(parentId)!.pipelineRun!.status).toBe("done");

  const restarted = await startPipelineRun(tasks.get(parentId)!, { restart: true });
  if ("error" in restarted) throw new Error(restarted.error);

  const finishedAgain = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" && t.pipelineRun.startedAt !== finished.pipelineRun!.startedAt ? t : undefined;
  });
  // A fresh run — history reset to exactly this run's one execution, not
  // accumulated on top of the prior run's.
  expect(finishedAgain.pipelineRun!.history.length).toBe(1);
  await waitUntilIdle(parentId);
});

test("M4: advancePipeline refuses (409) while the target step is still genuinely live", async () => {
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "700";
  try {
    const { createTask, startTask } = await import("./orchestrator.ts");
    const { tasks, pipelines } = await import("./db.ts");
    const { newStep } = await import("../shared/pipeline.ts");
    const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
    const { advancePipeline } = await import("./pipeline-runner.ts");

    const profile = await makeProfile("advance-live-guard");
    const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
    const graph = { steps: [A], edges: [], startStepId: A.id };
    const pipeline = pipelines.insert({ name: uniqueName("advance-live-pipeline"), graph, maxSteps: 25 });

    const created = await createTask({ title: "advance-live run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
    if ("error" in created) throw new Error(created.error);
    const parentId = created.task.id;
    liveParentIds.push(parentId);
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    const stepA = await waitFor(() => {
      const s = tasks.stepsForParent(parentId)[0];
      return s?.column === "running" ? s : undefined;
    });

    const result = await advancePipeline(parentId, { fromTaskId: stepA.id, nextStepIds: null });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.status).toBe(409);
      expect(result.error).toContain("still running");
    }
    await waitUntilIdle(parentId);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
});

test("M5: stopping one step directly (not the whole pipeline) doesn't cancel a still-live sibling", async () => {
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "700";
  try {
    const { createTask, startTask, cancelRun } = await import("./orchestrator.ts");
    const { tasks, pipelines } = await import("./db.ts");
    const { newStep } = await import("../shared/pipeline.ts");
    const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
    const { advancePipeline } = await import("./pipeline-runner.ts");

    const profile = await makeProfile("stop-one-of-two");
    const A = newStep({ name: "A", agentProfileId: profile.id, transition: "all", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
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
    const pipeline = pipelines.insert({ name: uniqueName("stop-one-pipeline"), graph, maxSteps: 25 });

    const created = await createTask({ title: "stop-one run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
    if ("error" in created) throw new Error(created.error);
    const parentId = created.task.id;
    liveParentIds.push(parentId);
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    await waitFor(() => {
      const steps = tasks.stepsForParent(parentId).filter((s) => s.pipelineStepId !== A.id);
      return steps.length === 2 && steps.every((s) => s.column === "running") ? steps : undefined;
    }, 8000);
    const stepB = tasks.stepsForParent(parentId).find((s) => s.pipelineStepId === B.id)!;

    await cancelRun(stepB.runId!);

    // Wait on the PIPELINE RUN's own reflection of the stop, not just B's
    // task column — `updateColumn` (sync) and this runner's own
    // `handleRunStatus` (dispatched via `void handleRunStatus(...)`, so
    // genuinely async relative to the column flip) are two separate
    // observers of the same settle event, and the column can flip to
    // `ready` a beat before the pipeline history entry is updated.
    const afterStop = await waitFor(() => {
      const t = tasks.get(parentId);
      const h = t?.pipelineRun?.history.find((x) => x.taskId === stepB.id);
      return h?.outcome === "cancelled" ? t : undefined;
    });
    // The whole run must NOT have been cancelled — C is still live.
    expect(afterStop!.pipelineRun!.status).not.toBe("cancelled");
    expect(afterStop!.column).not.toBe("ready");
    const runAfterStop = afterStop!.pipelineRun!;
    expect(runAfterStop.active.some((a) => a.taskId === stepB.id)).toBe(true);
    const bHistory = runAfterStop.history.find((h) => h.taskId === stepB.id);
    expect(bHistory?.outcome).toBe("cancelled");

    // Clean up the dangling stopped-but-not-resolved step so the run can
    // reach a terminal state (mirrors what a user would do from the UI:
    // Advance it to a dead end since it wasn't going to be retried).
    const resolvedB = await advancePipeline(parentId, { fromTaskId: stepB.id, nextStepIds: null });
    if ("error" in resolvedB) throw new Error(resolvedB.error);

    const finished = await waitFor(() => {
      const t = tasks.get(parentId);
      return t?.pipelineRun?.status === "done" ? t : undefined;
    }, 8000);
    expect(finished.column).toBe("review");
    await waitUntilIdle(parentId);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
});

test("M3: join-incomplete advance with nextStepIds:null drops the partial join and finishes without launching it", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { advancePipeline } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("join-incomplete-null");
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
  const pipeline = pipelines.insert({ name: uniqueName("join-null-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "join-incomplete-null run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  }, 8000);
  expect(blocked.pipelineRun!.blocked.some((b) => b.kind === "join-incomplete")).toBe(true);

  const advanced = await advancePipeline(parentId, { nextStepIds: null });
  if ("error" in advanced) throw new Error(advanced.error);

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  }, 8000);
  const steps = tasks.stepsForParent(parentId);
  expect(steps.some((s) => s.pipelineStepId === D.id)).toBe(false);
  expect(Object.keys(finished.pipelineRun!.joins).length).toBe(0);
  await waitUntilIdle(parentId);
});

test("M10: step tasks carry the parent's own references plus the handoff file reference", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("refs-propagation");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A, B], edges: [{ id: "e1", from: A.id, to: B.id, label: "" }], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("refs-pipeline"), graph, maxSteps: 25 });

  const parentRefPath = path.join(freshWorkdir(), "notes.md");
  const created = await createTask({
    title: "refs run",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
    references: [{ path: parentRefPath, isDirectory: false }],
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  expect(created.task.references).toEqual([{ path: parentRefPath, isDirectory: false }]);

  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });
  expect(finished.column).toBe("review");

  const steps = tasks.stepsForParent(parentId);
  const stepA = steps.find((s) => s.pipelineStepId === A.id)!;
  const stepB = steps.find((s) => s.pipelineStepId === B.id)!;

  // A is the first step — no prior handoff, so its references are just the
  // parent's own.
  expect(stepA.references).toEqual([{ path: parentRefPath, isDirectory: false }]);

  // B's references carry the parent's own reference PLUS a handoff file
  // reference written from A's handoff.
  expect(stepB.references.some((r) => r.path === parentRefPath)).toBe(true);
  expect(stepB.references.length).toBeGreaterThan(1);
  expect(stepB.references.some((r) => r.path.includes("handoff-") && r.path.endsWith(".json"))).toBe(true);

  await waitUntilIdle(parentId);
});

test("M16: reconcilePipelineRuns catches a step settle the listener never saw", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { reconcilePipelineRuns, __forTest } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("reconcile-missed");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A, B], edges: [{ id: "e1", from: A.id, to: B.id, label: "" }], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("reconcile-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "reconcile run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  let stepA: ReturnType<typeof tasks.get> = null;
  __forTest.setListenerEnabled(false);
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);
    await waitFor(() => {
      const r = runs.listForTask(stepA!.id)[0];
      return r && r.status === "succeeded" ? r : undefined;
    });

    // The listener never processed this settle — the parent is still
    // "running" with A sitting in `active` even though its real run has
    // already succeeded.
    expect(tasks.get(parentId)!.pipelineRun!.active.length).toBe(1);
    expect(tasks.get(parentId)!.pipelineRun!.status).toBe("running");
  } finally {
    __forTest.setListenerEnabled(true);
  }

  const reconciledCount = await reconcilePipelineRuns();
  expect(reconciledCount).toBeGreaterThanOrEqual(1);

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });
  expect(finished.column).toBe("review");
  await waitUntilIdle(parentId);
});

test("archived pipeline parent refuses start/advance/retry with archived-guard errors", async () => {
  const { createTask, startTask, archiveTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { advancePipeline, retryPipelineStep, startPipelineRun } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("archived-guard");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("archived-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "archived run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  });
  expect(blocked.pipelineRun!.blocked.some((b) => b.kind === "handoff-missing")).toBe(true);

  const archived = await archiveTask(parentId, { force: true });
  if ("error" in archived) throw new Error(archived.error);
  expect(tasks.get(parentId)!.archivedAt).not.toBeNull();

  const advanceResult = await advancePipeline(parentId, { nextStepIds: null });
  expect("error" in advanceResult).toBe(true);
  if ("error" in advanceResult) {
    expect(advanceResult.status).toBe(409);
    expect(advanceResult.error).toContain("archived");
  }

  const retryResult = await retryPipelineStep(parentId);
  expect("error" in retryResult).toBe(true);
  if ("error" in retryResult) {
    expect(retryResult.status).toBe(409);
    expect(retryResult.error).toContain("archived");
  }

  // `startTask` itself auto-unarchives ANY task (including a pipeline
  // parent) before dispatching, by design — so the archived guard here is
  // only reachable via a caller that bypasses that, exactly like the real
  // `POST /tasks/:id/pipeline/restart` route does (it calls
  // `startPipelineRun` directly, never through `startTaskInner`).
  const startResult = await startPipelineRun(tasks.get(parentId)!, { restart: true });
  expect("error" in startResult).toBe(true);
  if ("error" in startResult) expect(startResult.error).toContain("archived");
});

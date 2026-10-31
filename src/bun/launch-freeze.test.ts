import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";

// What a process does with work that is already moving once it stops taking
// new work (`freezeLaunches`, orchestrator.ts — a headless core handing the
// port to the app, or the app letting a quit through):
//
// - the pipeline runner leaves a step that settles during the freeze in
//   `run.active` over its settled run row, so the NEXT owner's
//   `reconcilePipelineRuns` settles it and launches what comes next (deciding
//   now would launch a step only for the exit to cut it off);
// - start / restart / advance / retry of a pipeline refuse, inside the
//   per-parent lock, without touching its run state;
// - an fx steer the live turn drops after the freeze goes to the backlog tray
//   instead of running as the next turn, and the user is not told "sending it
//   as the next turn".

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-launch-freeze-"));
// fx: the availability probe needs `--help` to say "coding agent" (see
// orchestrator-fx.test.ts); everything else exits 0 (auth probe fails open).
const fxDir = mkdtempSync(path.join(tmpdir(), "agetor-launch-freeze-fx-"));
const fxBin = path.join(fxDir, "fx");
writeFileSync(
  fxBin,
  '#!/bin/sh\nif [ "$1" = "--help" ]; then echo "Fast, native coding agent"; fi\nif [ "$1" = "--version" ]; then echo "0.0.14-fake"; fi\nexit 0\n',
  { mode: 0o755 },
);
// Set at load (db.ts reads AGETOR_DATA_DIR at first import), restored in
// afterAll so later files in the same process don't inherit a fake fx.
const ENV_OVERRIDES: Record<string, string> = {
  AGETOR_DATA_DIR: DATA_DIR,
  AGETOR_CLAUDE_DRIVER: "fake",
  AGETOR_CLAUDE_BIN: "/bin/echo",
  AGETOR_CLAUDE_ARGS: "",
  AGETOR_TMUX_BIN: "/bin/echo",
  AGETOR_FX_DRIVER: "fake",
  AGETOR_FX_BIN: fxBin,
};
const savedEnv: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(ENV_OVERRIDES)) {
  savedEnv[k] = process.env[k];
  process.env[k] = v;
}
const workdirs: string[] = [];

const liveParentIds: string[] = [];
const liveTaskIds: string[] = [];
let restoreHarnesses: (() => void) | null = null;

beforeAll(async () => {
  const { harnesses } = await import("./db.ts");
  const { snapshotHarnessState } = await import("./test-harness-state.ts");
  restoreHarnesses = snapshotHarnessState();
  harnesses.setEnabled("fx", true);
  // The runner only sees settles once subscribed (index.ts/headless.ts call
  // this at boot).
  const { initPipelineRunner } = await import("./pipeline-runner.ts");
  initPipelineRunner();
});

afterEach(async () => {
  const { __resetLaunchFreezeForTest, deleteTask } = await import("./orchestrator.ts");
  __resetLaunchFreezeForTest();
  delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  delete process.env.AGETOR_FAKE_FX_STEER_HOLD_MS;
  const { tasks } = await import("./db.ts");
  for (const id of liveParentIds.splice(0)) if (tasks.get(id)) await deleteTask(id).catch(() => {});
  for (const id of liveTaskIds.splice(0)) if (tasks.get(id)) await deleteTask(id).catch(() => {});
});

afterAll(async () => {
  const { __resetLaunchFreezeForTest } = await import("./orchestrator.ts");
  __resetLaunchFreezeForTest();
  const { pipelines, agentProfiles } = await import("./db.ts");
  for (const p of pipelines.list()) if (p.name.startsWith("launch-freeze-")) pipelines.delete(p.id);
  for (const p of agentProfiles.list()) if (p.name.startsWith("launch-freeze-")) agentProfiles.delete(p.id);
  restoreHarnesses?.();
  await new Promise((r) => setTimeout(r, 150));
  for (const k of Object.keys(ENV_OVERRIDES)) {
    const prev = savedEnv[k];
    if (prev === undefined) delete process.env[k];
    else process.env[k] = prev;
  }
  rmTestDataDir(DATA_DIR);
  rmTestDataDir(fxDir);
  for (const dir of workdirs) rmTestDataDir(dir);
});

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 5000, intervalMs = 15): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freshWorkdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-launch-freeze-wd-"));
  workdirs.push(dir);
  return dir;
}

async function makeClaudeProfile() {
  const { agentProfiles } = await import("./db.ts");
  return agentProfiles.insert({
    name: `launch-freeze-${randomUUID()}`,
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

/** A pipeline task over `steps` (linear, in order). */
async function makePipelineTask(stepInstructions: string[]) {
  const { createTask } = await import("./orchestrator.ts");
  const { pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const profile = await makeClaudeProfile();
  const steps = stepInstructions.map((instructions, i) =>
    newStep({ name: String.fromCharCode(65 + i), agentProfileId: profile.id, instructions }),
  );
  const edges = steps.slice(1).map((s, i) => ({ id: `e${i}`, from: steps[i]!.id, to: s.id, label: "" }));
  const pipeline = pipelines.insert({
    name: `launch-freeze-${randomUUID()}`,
    graph: { steps, edges, startStepId: steps[0]!.id },
    maxSteps: 25,
  });
  const created = await createTask({
    title: "launch freeze pipeline",
    prompt: "the goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  liveParentIds.push(created.task.id);
  return { parentId: created.task.id, steps };
}

test("a step that settles during the freeze stays active; the next owner's reconcilePipelineRuns settles it and launches the next step", async () => {
  const { startTask, freezeLaunches, __resetLaunchFreezeForTest } = await import("./orchestrator.ts");
  const { reconcilePipelineRuns } = await import("./pipeline-runner.ts");
  const { tasks, runs } = await import("./db.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  // Hold A's turn open long enough to freeze while it runs.
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "600";
  const { parentId, steps } = await makePipelineTask([
    `Do A. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done`,
    `Do B. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done`,
  ]);
  const [A, B] = steps as [(typeof steps)[number], (typeof steps)[number]];

  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);
  const stepA = await waitFor(() => {
    const t = tasks.stepsForParent(parentId)[0];
    return t?.runId && runs.get(t.runId)?.status === "running" ? t : undefined;
  });
  const runA = stepA.runId!;

  freezeLaunches();
  await waitFor(() => runs.get(runA)?.status === "succeeded");
  // Every settle path the runner listens on (run-status, the review column)
  // has had time to run.
  await tick(400);

  const frozen = tasks.get(parentId)!.pipelineRun!;
  expect(frozen.status).toBe("running");
  expect(frozen.active.map((a) => a.taskId)).toEqual([stepA.id]);
  expect(frozen.history).toHaveLength(1);
  expect(frozen.history[0]!.outcome).toBeNull();
  expect(frozen.history[0]!.nextStepIds).toEqual([]);
  expect(frozen.blocked).toEqual([]);
  // B was never launched, not even as a row a frozen startTask then refused.
  expect(tasks.stepsForParent(parentId).map((t) => t.pipelineStepId)).toEqual([A.id]);

  // The next owner boots: no freeze, and its boot sweep finds A settled.
  __resetLaunchFreezeForTest();
  expect(await reconcilePipelineRuns()).toBeGreaterThanOrEqual(1);
  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });
  const run = finished.pipelineRun!;
  expect(run.history.map((h) => [h.stepId, h.outcome])).toEqual([
    [A.id, "succeeded"],
    [B.id, "succeeded"],
  ]);
  expect(run.history[0]!.nextStepIds).toEqual([B.id]);
  expect(run.blocked).toEqual([]);
  expect(finished.column).toBe("review");
});

test("a frozen runner refuses restart, advance and retry of a blocked pipeline and leaves its run untouched", async () => {
  const { startTask, freezeLaunches, __resetLaunchFreezeForTest, LAUNCHES_FROZEN_REASON } = await import(
    "./orchestrator.ts"
  );
  const { startPipelineRun, advancePipeline, retryPipelineStep } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  // No handoff, even after the one automatic reminder → blocked.
  const { parentId } = await makePipelineTask([`Do A. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing`]);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);
  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" && t.pipelineRun.blocked.length > 0 ? t : undefined;
  }, 10_000);
  // Let the reminder round-trip's last bookkeeping land.
  await tick(200);
  const before = JSON.stringify(tasks.get(parentId)!.pipelineRun);
  const stepRows = tasks.stepsForParent(parentId).length;
  expect(blocked.pipelineRun!.blocked.some((b) => b.kind === "handoff-missing")).toBe(true);

  freezeLaunches();
  expect(await startPipelineRun(tasks.get(parentId)!)).toEqual({ error: LAUNCHES_FROZEN_REASON });
  expect(await startPipelineRun(tasks.get(parentId)!, { restart: true })).toEqual({ error: LAUNCHES_FROZEN_REASON });
  expect(await advancePipeline(parentId, { nextStepIds: null })).toEqual({ error: LAUNCHES_FROZEN_REASON, status: 409 });
  expect(await retryPipelineStep(parentId)).toEqual({ error: LAUNCHES_FROZEN_REASON, status: 409 });
  await tick(100);
  expect(JSON.stringify(tasks.get(parentId)!.pipelineRun)).toBe(before);
  expect(tasks.stepsForParent(parentId)).toHaveLength(stepRows);

  // The refusal was the freeze: the next owner can advance past the block.
  __resetLaunchFreezeForTest();
  const advanced = await advancePipeline(parentId, { nextStepIds: null });
  if ("error" in advanced) throw new Error(advanced.error);
  const done = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });
  expect(done.pipelineRun!.history[0]!.outcome).toBe("advanced-manually");
});

test("an fx steer dropped after the freeze goes to the backlog instead of running as the next turn", async () => {
  const { createTask, startTask, sendInput, freezeLaunches } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");
  const { FAKE_FX_STEER_PROMPT_MARKER } = await import("./agents.ts");
  const { FX_STEER_DROPPED_STATUS } = await import("./fx-acp.ts");

  process.env.AGETOR_FAKE_FX_STEER_HOLD_MS = "1200";
  const created = await createTask({
    title: "launch freeze fx steer",
    prompt: `work ${FAKE_FX_STEER_PROMPT_MARKER}:dropped`,
    agent: "fx",
    model: "deepseek/deepseek-v4-flash",
    workdir: freshWorkdir(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  liveTaskIds.push(taskId);
  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  await waitFor(() => tasks.get(taskId)?.column === "running" && runs.get(started.runId)?.status === "running");
  await tick(30);

  const steered = await sendInput(started.runId, "steer typed before the freeze");
  expect(steered.delivered).toBe(true);
  if (steered.delivered) expect(steered.runId).toBe(started.runId);

  // The steer is still with fx (not queued yet), so the freeze itself has
  // nothing to stash; fx drops it when the turn ends.
  freezeLaunches();
  expect(tasks.get(taskId)!.backlog).toEqual([]);

  await waitFor(() => runs.get(started.runId)?.status !== "running", 5000);
  await waitFor(() => tasks.get(taskId)?.backlog.length === 1);
  await tick(300); // a drained turn would have spawned by now

  expect(tasks.get(taskId)!.backlog.map((b) => b.text)).toEqual(["steer typed before the freeze"]);
  expect(runs.listForTask(taskId).map((r) => r.id)).toEqual([started.runId]);
  const statusLines = runs.events(started.runId).filter((e) => e.stream === "status").map((e) => e.data);
  expect(statusLines).not.toContain(FX_STEER_DROPPED_STATUS);
  expect(statusLines.some((d) => d.startsWith("queued message not sent — Agetor stopped before it could run"))).toBe(
    true,
  );
});

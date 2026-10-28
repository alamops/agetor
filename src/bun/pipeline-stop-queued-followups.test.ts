import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";

// A follow-up queued on a one-shot step (codex here; cursor/gemini/
// antigravity/fx share the queue-then-drain shape) must not resume a step the
// user stopped AFTER typing it: the drained turn would read as the user
// resuming the step and undo the Stop. It goes to the step's backlog tray.

// db.ts captures AGETOR_DATA_DIR at first import — set it (and the fake-driver
// env) before any dynamic import touches db.ts/orchestrator.ts.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-stop-queue-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CODEX_DRIVER = "fake";
// `/bin/echo --version` doesn't parse as a version, so the per-model CLI
// floor fails open.
process.env.AGETOR_CODEX_BIN = "/bin/echo";
// fx: the availability probe needs `--help` to say "coding agent" (see
// orchestrator-fx.test.ts); everything else exits 0 (auth probe fails open).
process.env.AGETOR_FX_DRIVER = "fake";
const fxBin = path.join(mkdtempSync(path.join(tmpdir(), "agetor-pipeline-stop-queue-fx-")), "fx");
writeFileSync(
  fxBin,
  '#!/bin/sh\nif [ "$1" = "--help" ]; then echo "Fast, native coding agent"; fi\nif [ "$1" = "--version" ]; then echo "0.0.14-fake"; fi\nexit 0\n',
  { mode: 0o755 },
);
process.env.AGETOR_FX_BIN = fxBin;

const TURN_MS = 1500;

beforeAll(async () => {
  const { harnesses } = await import("./db.ts");
  // codex ships disabled by default (migration 016).
  harnesses.setEnabled("codex", true);
  harnesses.setEnabled("fx", true);
  const { initPipelineRunner } = await import("./pipeline-runner.ts");
  initPipelineRunner();
});

afterAll(async () => {
  const { tasks, pipelines, agentProfiles } = await import("./db.ts");
  const { deleteTask } = await import("./orchestrator.ts");
  for (const t of tasks.list()) {
    if (!t.pipelineParentId) await deleteTask(t.id).catch(() => {});
  }
  for (const p of pipelines.list()) pipelines.delete(p.id);
  for (const p of agentProfiles.list()) agentProfiles.delete(p.id);
  delete process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS;
  delete process.env.AGETOR_FAKE_FX_STEER_HOLD_MS;
  await new Promise((r) => setTimeout(r, 150));
  rmTestDataDir(DATA_DIR);
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

/** A one-step codex pipeline whose step is mid-turn (held for TURN_MS), with
 *  one follow-up queued behind that turn. */
async function startCodexStepWithQueuedFollowUp(label: string, followUp: string) {
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { tasks, runs, pipelines, agentProfiles } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");

  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = String(TURN_MS);
  const profile = agentProfiles.insert({
    name: `stop-queue-${label}-${randomUUID()}`,
    harness: "codex",
    model: "gpt-5.6-sol",
    effort: null,
    mode: null,
    speed: "off",
    maxMode: false,
    instructions: "",
    skills: [],
  });
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: "do A" });
  const pipeline = pipelines.insert({
    name: `stop-queue-${label}-${randomUUID()}`,
    graph: { steps: [A], edges: [], startStepId: A.id },
    maxSteps: 25,
  });
  const created = await createTask({
    title: `stop queue ${label}`,
    prompt: "goal",
    workdir: mkdtempSync(path.join(tmpdir(), "agetor-pipeline-stop-queue-wd-")),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;

  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);
  const step = await waitFor(() => {
    const t = tasks.stepsForParent(parentId)[0];
    return t?.column === "running" && t.runId ? t : undefined;
  });
  const firstRunId = step.runId!;
  const sent = await sendInput(firstRunId, followUp);
  expect(sent.delivered).toBe(true);
  if (sent.delivered) expect(sent.runId).toBe(firstRunId); // queued behind the live turn
  // The fake codex turn is really held (AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS),
  // so the Stop below lands mid-turn rather than racing a ~20ms turn.
  await tick(100);
  expect(runs.get(firstRunId)?.status).toBe("running");
  return { parentId, stepTaskId: step.id, firstRunId };
}

test("a follow-up queued before the pipeline's Stop goes to the backlog; the run stays stopped", async () => {
  const { cancelPipelineRun } = await import("./pipeline-runner.ts");
  const { tasks, runs } = await import("./db.ts");

  const followUp = "follow-up typed before the stop";
  const s = await startCodexStepWithQueuedFollowUp("whole", followUp);

  const stopped = await cancelPipelineRun(s.parentId);
  if ("error" in stopped) throw new Error(stopped.error);
  await waitFor(() => runs.get(s.firstRunId)?.status === "cancelled");
  await waitFor(() => tasks.get(s.parentId)?.pipelineRun?.history[0]?.outcome === "cancelled");
  await tick(300); // a drained turn would have spawned by now

  expect(runs.listForTask(s.stepTaskId).map((r) => r.id)).toEqual([s.firstRunId]);
  const run = tasks.get(s.parentId)!.pipelineRun!;
  expect(run.status).toBe("cancelled");
  expect(run.stopRequestedAt).toBeNumber();
  expect(run.history[0]!.stoppedAt).toBeNumber();
  expect(run.history[0]!.stoppedRunId).toBe(s.firstRunId);
  expect(tasks.get(s.parentId)!.column).toBe("ready");

  const step = tasks.get(s.stepTaskId)!;
  expect(step.column).toBe("ready");
  expect(step.backlog.map((b) => b.text)).toEqual([followUp]);
  const statusLines = runs.events(s.firstRunId).filter((e) => e.stream === "status").map((e) => e.data);
  expect(statusLines.some((d) => d.startsWith("queued message not sent — this pipeline step was stopped"))).toBe(true);
});

test("a follow-up queued before a Stop on the step's own panel goes to the backlog too", async () => {
  const { cancelRun } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const followUp = "follow-up typed before the step stop";
  const s = await startCodexStepWithQueuedFollowUp("step", followUp);

  expect(await cancelRun(s.firstRunId)).toBe(true);
  await waitFor(() => runs.get(s.firstRunId)?.status === "cancelled");
  await waitFor(() => tasks.get(s.parentId)?.pipelineRun?.history[0]?.outcome === "cancelled");
  await tick(300);

  expect(runs.listForTask(s.stepTaskId).map((r) => r.id)).toEqual([s.firstRunId]);
  const record = tasks.get(s.parentId)!.pipelineRun!.history[0]!;
  expect(record.stoppedAt).toBeNumber();
  expect(record.stoppedRunId).toBe(s.firstRunId);
  expect(tasks.get(s.stepTaskId)!.backlog.map((b) => b.text)).toEqual([followUp]);
});

test("several queued follow-ups land in the backlog in send order (oldest on top)", async () => {
  const { cancelPipelineRun } = await import("./pipeline-runner.ts");
  const { sendInput } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const s = await startCodexStepWithQueuedFollowUp("order", "first");
  const second = await sendInput(s.firstRunId, "second");
  expect(second.delivered).toBe(true);

  const stopped = await cancelPipelineRun(s.parentId);
  if ("error" in stopped) throw new Error(stopped.error);
  await waitFor(() => tasks.get(s.stepTaskId)?.backlog.length === 2);
  await tick(300);

  expect(tasks.get(s.stepTaskId)!.backlog.map((b) => b.text)).toEqual(["first", "second"]);
  expect(runs.listForTask(s.stepTaskId).length).toBe(1);
  const statusLines = runs.events(s.firstRunId).filter((e) => e.stream === "status").map((e) => e.data);
  expect(statusLines.some((d) => d.startsWith("2 queued messages not sent"))).toBe(true);
  expect(tasks.get(s.parentId)!.pipelineRun!.status).toBe("cancelled");
});

test("an ordinary codex task still drains its queued follow-up after a Stop", async () => {
  const { createTask, startTask, sendInput, cancelRun } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = String(TURN_MS);
  const created = await createTask({
    title: "plain codex stop",
    prompt: "turn one",
    agent: "codex",
    model: "gpt-5.6-sol",
    workdir: mkdtempSync(path.join(tmpdir(), "agetor-pipeline-stop-queue-wd-")),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  await waitFor(() => tasks.get(taskId)?.column === "running");
  const sent = await sendInput(started.runId, "queued on a plain task");
  expect(sent.delivered).toBe(true);

  // Short turns from here on so the drained turn settles quickly.
  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "20";
  expect(await cancelRun(started.runId)).toBe(true);
  await waitFor(() => runs.listForTask(taskId).length === 2);
  await waitFor(() => runs.listForTask(taskId).every((r) => r.status !== "running"));
  expect(tasks.get(taskId)!.backlog).toEqual([]);
});

test("an fx steer the stopped turn dropped goes to the backlog, without a 'sending it as the next turn' line", async () => {
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { cancelPipelineRun } = await import("./pipeline-runner.ts");
  const { tasks, runs, pipelines, agentProfiles } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_FX_STEER_PROMPT_MARKER } = await import("./agents.ts");
  const { FX_STEER_DROPPED_STATUS } = await import("./fx-acp.ts");

  process.env.AGETOR_FAKE_FX_STEER_HOLD_MS = String(TURN_MS);
  const profile = agentProfiles.insert({
    name: `stop-queue-fx-${randomUUID()}`,
    harness: "fx",
    model: "deepseek/deepseek-v4-flash",
    effort: null,
    mode: null,
    speed: "off",
    maxMode: false,
    instructions: "",
    skills: [],
  });
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `do A ${FAKE_FX_STEER_PROMPT_MARKER}:dropped` });
  const pipeline = pipelines.insert({
    name: `stop-queue-fx-${randomUUID()}`,
    graph: { steps: [A], edges: [], startStepId: A.id },
    maxSteps: 25,
  });
  const created = await createTask({
    title: "stop queue fx",
    prompt: "goal",
    workdir: mkdtempSync(path.join(tmpdir(), "agetor-pipeline-stop-queue-wd-")),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);
  const step = await waitFor(() => {
    const t = tasks.stepsForParent(parentId)[0];
    return t?.column === "running" && t.runId ? t : undefined;
  });
  const firstRunId = step.runId!;
  await tick(30);
  const steered = await sendInput(firstRunId, "steer typed before the stop");
  expect(steered.delivered).toBe(true);
  if (steered.delivered) expect(steered.runId).toBe(firstRunId);

  const stopped = await cancelPipelineRun(parentId);
  if ("error" in stopped) throw new Error(stopped.error);
  await waitFor(() => runs.get(firstRunId)?.status === "cancelled");
  await waitFor(() => tasks.get(step.id)?.backlog.length === 1);
  await tick(300);

  expect(tasks.get(step.id)!.backlog.map((b) => b.text)).toEqual(["steer typed before the stop"]);
  expect(runs.listForTask(step.id).map((r) => r.id)).toEqual([firstRunId]);
  const statusLines = runs.events(firstRunId).filter((e) => e.stream === "status").map((e) => e.data);
  expect(statusLines).not.toContain(FX_STEER_DROPPED_STATUS);
  expect(statusLines.some((d) => d.startsWith("queued message not sent — this pipeline step was stopped"))).toBe(true);
  expect(tasks.get(parentId)!.pipelineRun!.status).toBe("cancelled");
});

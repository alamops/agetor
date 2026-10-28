import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";

// A Stop that lands while a one-shot turn's spawn still holds the task's
// `startingTaskIds` claim but hasn't minted its run row (codex awaits the
// per-model CLI floor probe there) has no run to cancel. It must still stop
// the turn the claim goes on to mint — a user's send and a queued follow-up's
// drain alike — and must not outlive a claim that ends without a run.

// db.ts captures AGETOR_DATA_DIR at first import — set it (and the fake-driver
// env) before any dynamic import touches db.ts/orchestrator.ts.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-stop-claim-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CODEX_DRIVER = "fake";

// `codex --version` prints the version in VERSION_FILE, and sleeps first
// while SLOW_FLAG exists — that sleep is the claim window under test.
const BIN_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-stop-claim-bin-"));
const SLOW_FLAG = path.join(BIN_DIR, "slow");
const VERSION_FILE = path.join(BIN_DIR, "version");
const PROBE_SLEEP_S = 0.6;
writeFileSync(
  path.join(BIN_DIR, "codex"),
  `#!/bin/sh\nif [ "$1" = "--version" ]; then [ -f "${SLOW_FLAG}" ] && sleep ${PROBE_SLEEP_S}; echo "codex-cli $(cat "${VERSION_FILE}")"; fi\nexit 0\n`,
  { mode: 0o755 },
);
process.env.AGETOR_CODEX_BIN = path.join(BIN_DIR, "codex");

const MODEL = "gpt-5.6-sol";
const FLOOR = "0.150.0";
const PASSING_VERSION = "0.200.0";
const FAILING_VERSION = "0.100.0";
let previousFloor: string | undefined;

function setSlowProbe(on: boolean): void {
  if (on) writeFileSync(SLOW_FLAG, "1");
  else rmSync(SLOW_FLAG, { force: true });
}

beforeAll(async () => {
  const { harnesses } = await import("./db.ts");
  // codex ships disabled by default (migration 016).
  harnesses.setEnabled("codex", true);
  const { MODEL_MIN_CLI_VERSION } = await import("../shared/types.ts");
  const codexFloors = MODEL_MIN_CLI_VERSION.codex as Record<string, string>;
  previousFloor = codexFloors[MODEL];
  codexFloors[MODEL] = FLOOR;
  const { initPipelineRunner } = await import("./pipeline-runner.ts");
  initPipelineRunner();
});

afterEach(() => {
  setSlowProbe(false);
  writeFileSync(VERSION_FILE, PASSING_VERSION);
  delete process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS;
});

afterAll(async () => {
  const { MODEL_MIN_CLI_VERSION } = await import("../shared/types.ts");
  const codexFloors = MODEL_MIN_CLI_VERSION.codex as Record<string, string>;
  if (previousFloor === undefined) delete codexFloors[MODEL];
  else codexFloors[MODEL] = previousFloor;
  const { tasks, pipelines, agentProfiles } = await import("./db.ts");
  const { deleteTask } = await import("./orchestrator.ts");
  for (const t of tasks.list()) {
    if (!t.pipelineParentId) await deleteTask(t.id).catch(() => {});
  }
  for (const p of pipelines.list()) pipelines.delete(p.id);
  for (const p of agentProfiles.list()) agentProfiles.delete(p.id);
  await new Promise((r) => setTimeout(r, 150));
  rmSync(BIN_DIR, { recursive: true, force: true });
  rmTestDataDir(DATA_DIR);
});

writeFileSync(VERSION_FILE, PASSING_VERSION);

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 6000, intervalMs = 10): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `taskId` is inside a spawn claim with no new run row yet: it
 *  reads live while its run count is still `runCount`. */
async function waitForClaimWithoutRun(taskId: string, runCount: number): Promise<void> {
  const { isAnyRunOfTaskLive } = await import("./orchestrator.ts");
  const { runs } = await import("./db.ts");
  await waitFor(() => {
    const listed = runs.listForTask(taskId);
    return listed.length === runCount && listed.every((r) => r.status !== "running") && isAnyRunOfTaskLive(taskId);
  });
}

/** A one-step codex pipeline. Returns once its step task exists. */
async function startCodexPipeline(label: string) {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, agentProfiles } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");

  const profile = agentProfiles.insert({
    name: `stop-claim-${label}-${randomUUID()}`,
    harness: "codex",
    model: MODEL,
    effort: null,
    mode: null,
    speed: "off",
    maxMode: false,
    instructions: "",
    skills: [],
  });
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: "do A" });
  const pipeline = pipelines.insert({
    name: `stop-claim-${label}-${randomUUID()}`,
    graph: { steps: [A], edges: [], startStepId: A.id },
    maxSteps: 25,
  });
  const created = await createTask({
    title: `stop claim ${label}`,
    prompt: "goal",
    workdir: mkdtempSync(path.join(tmpdir(), "agetor-pipeline-stop-claim-wd-")),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);
  const step = await waitFor(() => {
    const t = tasks.stepsForParent(parentId)[0];
    return t?.runId ? t : undefined;
  });
  return { parentId, stepTaskId: step.id, firstRunId: step.runId! };
}

/** The new run the claim minted after the Stop is cancelled before it
 *  registered, and the pipeline stays stopped. */
async function expectStoppedAfterClaim(parentId: string, stepTaskId: string, runsBefore: string[]): Promise<string> {
  const { tasks, runs } = await import("./db.ts");
  const minted = await waitFor(() => runs.listForTask(stepTaskId).find((r) => !runsBefore.includes(r.id)));
  await waitFor(() => runs.get(minted.id)?.status === "cancelled");
  await tick(300); // a reminder, resume or drained turn would have spawned by now

  expect(runs.listForTask(stepTaskId).filter((r) => !runsBefore.includes(r.id)).map((r) => r.id)).toEqual([minted.id]);
  const statusLines = runs.events(minted.id).filter((e) => e.stream === "status").map((e) => e.data);
  expect(statusLines).toContain("cancelled by user before the agent launched");
  const run = tasks.get(parentId)!.pipelineRun!;
  expect(run.stopRequestedAt).toBeNumber();
  expect(run.status).toBe("cancelled");
  expect(tasks.get(stepTaskId)!.column).toBe("ready");
  return minted.id;
}

test("a pipeline Stop during a step's send still in its spawn claim cancels the turn it mints and stays stopped", async () => {
  const { sendInput } = await import("./orchestrator.ts");
  const { cancelPipelineRun } = await import("./pipeline-runner.ts");
  const { tasks, runs } = await import("./db.ts");

  const s = await startCodexPipeline("send");
  // The first turn (and its one reminder) end without a handoff: the run
  // blocks with nothing live.
  await waitFor(() => tasks.get(s.parentId)?.pipelineRun?.status === "blocked");
  const runsBefore = runs.listForTask(s.stepTaskId).map((r) => r.id);

  setSlowProbe(true);
  const sendP = sendInput(tasks.get(s.stepTaskId)!.runId!, "a message sent just before pressing Stop");
  await waitForClaimWithoutRun(s.stepTaskId, runsBefore.length);
  const stopped = await cancelPipelineRun(s.parentId);
  if ("error" in stopped) throw new Error(stopped.error);
  const sent = await sendP;
  expect(sent.delivered).toBe(true);

  const minted = await expectStoppedAfterClaim(s.parentId, s.stepTaskId, runsBefore);
  if (sent.delivered) expect(sent.runId).toBe(minted);
});

test("a pipeline Stop while a queued follow-up's drain is in its spawn claim cancels the drained turn and keeps it and the rest in the backlog, in send order", async () => {
  const { sendInput } = await import("./orchestrator.ts");
  const { cancelPipelineRun } = await import("./pipeline-runner.ts");
  const { tasks, runs } = await import("./db.ts");

  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "1200";
  const s = await startCodexPipeline("drain");
  await waitFor(() => tasks.get(s.stepTaskId)?.column === "running");
  const first = "first follow-up, drained just before the Stop";
  const second = "second follow-up, still queued at the Stop";
  for (const line of [first, second]) {
    const sent = await sendInput(s.firstRunId, line);
    expect(sent.delivered).toBe(true);
    if (sent.delivered) expect(sent.runId).toBe(s.firstRunId); // queued behind the live turn
  }
  expect(runs.get(s.firstRunId)?.status).toBe("running");

  // The first turn ends; draining `first` now probes the CLI floor slowly.
  setSlowProbe(true);
  await waitFor(() => runs.get(s.firstRunId)?.status === "succeeded");
  await waitForClaimWithoutRun(s.stepTaskId, 1);
  const stopped = await cancelPipelineRun(s.parentId);
  if ("error" in stopped) throw new Error(stopped.error);

  const minted = await expectStoppedAfterClaim(s.parentId, s.stepTaskId, [s.firstRunId]);
  // The drained message never reached the agent: it goes back to the tray
  // ahead of the one still queued behind it.
  expect(tasks.get(s.stepTaskId)!.backlog.map((b) => b.text)).toEqual([first, second]);
  const statusLines = runs.events(minted).filter((e) => e.stream === "status").map((e) => e.data);
  expect(statusLines.some((l) => l.startsWith("2 queued messages not sent — this pipeline step was stopped"))).toBe(true);
});

test("a Stop recorded against a claim that ends without a run (a CLI floor decline) does not cancel a later turn", async () => {
  const { createTask, startTask, sendInput, cancelLiveRunOfTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "800";
  const created = await createTask({
    title: "claim decline",
    prompt: "first turn",
    workdir: mkdtempSync(path.join(tmpdir(), "agetor-pipeline-stop-claim-wd-")),
    isolation: "none",
    agent: "codex",
    model: MODEL,
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  const firstRunId = started.runId;
  const queued = await sendInput(firstRunId, "queued follow-up");
  expect(queued.delivered).toBe(true);

  // The CLI is downgraded below the model's floor before the queue drains:
  // the drain's slow probe declines and mints no run.
  writeFileSync(VERSION_FILE, FAILING_VERSION);
  setSlowProbe(true);
  await waitFor(() => runs.get(firstRunId)?.status === "succeeded");
  await waitForClaimWithoutRun(taskId, 1);
  expect(await cancelLiveRunOfTask(taskId)).toBe(true);
  await waitFor(() => tasks.get(taskId)?.backlog.some((b) => b.text === "queued follow-up"));
  await tick(100);
  expect(runs.listForTask(taskId).map((r) => r.id)).toEqual([firstRunId]);

  // A later turn, with the CLI upgraded again, runs normally.
  setSlowProbe(false);
  writeFileSync(VERSION_FILE, PASSING_VERSION);
  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "20";
  const later = await sendInput(firstRunId, "a later message");
  expect(later.delivered).toBe(true);
  if (!later.delivered) return;
  expect(later.runId).not.toBe(firstRunId);
  await waitFor(() => runs.get(later.runId)?.status === "succeeded");
  await deleteAfter(taskId);
});

async function deleteAfter(taskId: string): Promise<void> {
  const { deleteTask } = await import("./orchestrator.ts");
  await deleteTask(taskId).catch(() => {});
}

/** An ordinary (non-pipeline) codex task, started. Returns once its first run
 *  is minted. */
async function startOrdinaryCodexTask(label: string) {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const created = await createTask({
    title: `stop claim ${label}`,
    prompt: "first turn",
    workdir: mkdtempSync(path.join(tmpdir(), "agetor-pipeline-stop-claim-wd-")),
    isolation: "none",
    agent: "codex",
    model: MODEL,
  });
  if ("error" in created) throw new Error(created.error);
  const started = await startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);
  return { taskId: created.task.id, firstRunId: started.runId };
}

test("a Stop on the step alone during a queued follow-up's drain claim cancels the drained turn, keeps the queue in the backlog in send order, and stops only that execution", async () => {
  const { sendInput, cancelLiveRunOfTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "1200";
  const s = await startCodexPipeline("step-drain");
  await waitFor(() => tasks.get(s.stepTaskId)?.column === "running");
  const first = "first follow-up, drained just before the step's Stop";
  const second = "second follow-up, still queued at the step's Stop";
  for (const line of [first, second]) {
    const sent = await sendInput(s.firstRunId, line);
    expect(sent.delivered).toBe(true);
    if (sent.delivered) expect(sent.runId).toBe(s.firstRunId); // queued behind the live turn
  }

  setSlowProbe(true);
  await waitFor(() => runs.get(s.firstRunId)?.status === "succeeded");
  await waitForClaimWithoutRun(s.stepTaskId, 1);
  // The step's own Stop, not the pipeline's: no run-level marker is set.
  expect(await cancelLiveRunOfTask(s.stepTaskId)).toBe(true);

  const minted = await waitFor(() => runs.listForTask(s.stepTaskId).find((r) => r.id !== s.firstRunId));
  await waitFor(() => runs.get(minted.id)?.status === "cancelled");
  await waitFor(() => tasks.get(s.parentId)?.pipelineRun?.history[0]?.stoppedRunId === minted.id);
  await tick(300); // a reminder or a drained turn would have spawned by now

  expect(runs.listForTask(s.stepTaskId).map((r) => r.id).sort()).toEqual([s.firstRunId, minted.id].sort());
  const statusLines = runs.events(minted.id).filter((e) => e.stream === "status").map((e) => e.data);
  expect(statusLines).toContain("cancelled by user before the agent launched");
  expect(statusLines.some((l) => l.startsWith("2 queued messages not sent — this pipeline step was stopped"))).toBe(true);
  // The drained message never reached the agent: back on top of the tray.
  expect(tasks.get(s.stepTaskId)!.backlog.map((b) => b.text)).toEqual([first, second]);

  const run = tasks.get(s.parentId)!.pipelineRun!;
  expect(run.stopRequestedAt ?? null).toBeNull();
  const record = run.history[0]!;
  expect(record.stoppedAt).toBeNumber();
  expect(record.stoppedRunId).toBe(minted.id);
  expect(record.outcome).toBe("cancelled");
  expect(record.reminder ?? null).toBeNull();
  expect(run.blocked).toEqual([]);
  // The only execution is stopped, so the run reads stopped.
  expect(run.status).toBe("cancelled");
  expect(tasks.get(s.stepTaskId)!.column).toBe("ready");
});

test("on an ordinary task a Stop during a queued follow-up's drain claim cancels the drained turn and drops the queue: nothing in the backlog, nothing drained", async () => {
  const { sendInput, cancelLiveRunOfTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "1200";
  const t = await startOrdinaryCodexTask("plain-drain");
  await waitFor(() => tasks.get(t.taskId)?.column === "running");
  for (const line of ["drained on a plain task", "still queued on a plain task"]) {
    const sent = await sendInput(t.firstRunId, line);
    expect(sent.delivered).toBe(true);
    if (sent.delivered) expect(sent.runId).toBe(t.firstRunId);
  }

  setSlowProbe(true);
  await waitFor(() => runs.get(t.firstRunId)?.status === "succeeded");
  await waitForClaimWithoutRun(t.taskId, 1);
  expect(await cancelLiveRunOfTask(t.taskId)).toBe(true);

  const minted = await waitFor(() => runs.listForTask(t.taskId).find((r) => r.id !== t.firstRunId));
  await waitFor(() => runs.get(minted.id)?.status === "cancelled");
  // Shorten any turn the queue might (wrongly) still start, so it would show.
  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "20";
  setSlowProbe(false);
  await tick(400);

  expect(runs.listForTask(t.taskId).map((r) => r.id).sort()).toEqual([t.firstRunId, minted.id].sort());
  const statusLines = runs.events(minted.id).filter((e) => e.stream === "status").map((e) => e.data);
  expect(statusLines).toContain("cancelled by user before the agent launched");
  expect(statusLines.some((l) => l.includes("queued message"))).toBe(false);
  const task = tasks.get(t.taskId)!;
  expect(task.backlog).toEqual([]);
  expect(task.column).toBe("ready");
  expect(task.runId).toBe(minted.id);
  await deleteAfter(t.taskId);
});

test("a Stop while startTask still holds its claim (the pre-flight CLI probe) cancels the run it mints, and a later Run starts normally", async () => {
  const { createTask, startTask, cancelLiveRunOfTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const created = await createTask({
    title: "stop claim preflight",
    prompt: "first turn",
    workdir: mkdtempSync(path.join(tmpdir(), "agetor-pipeline-stop-claim-wd-")),
    isolation: "none",
    agent: "codex",
    model: MODEL,
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  setSlowProbe(true);
  const startP = startTask(taskId);
  await waitForClaimWithoutRun(taskId, 0);
  expect(await cancelLiveRunOfTask(taskId)).toBe(true);
  const started = await startP;
  if ("error" in started) throw new Error(started.error);

  await waitFor(() => runs.get(started.runId)?.status === "cancelled");
  expect(runs.listForTask(taskId).map((r) => r.id)).toEqual([started.runId]);
  const statusLines = runs.events(started.runId).filter((e) => e.stream === "status").map((e) => e.data);
  expect(statusLines).toContain("cancelled by user before the agent launched");
  expect(statusLines.some((l) => l.startsWith("started —"))).toBe(false);
  expect(tasks.get(taskId)!.column).toBe("ready");

  // The Stop belonged to that claim only.
  setSlowProbe(false);
  const again = await startTask(taskId);
  if ("error" in again) throw new Error(again.error);
  expect(again.runId).not.toBe(started.runId);
  await waitFor(() => runs.get(again.runId)?.status === "succeeded");
  await deleteAfter(taskId);
});

test("a turn minted under a claim-adopted Stop whose spawn then fails is recorded failed (not cancelled), and a later turn runs normally", async () => {
  const { sendInput, cancelLiveRunOfTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "800";
  const t = await startOrdinaryCodexTask("failed-spawn");
  const effort = tasks.get(t.taskId)!.effort;
  expect(effort).not.toBeNull();
  for (const line of ["spawn of this one fails", "queued behind it"]) {
    const sent = await sendInput(t.firstRunId, line);
    expect(sent.delivered).toBe(true);
  }
  // The model needs an effort flag: with none, building the drained turn's
  // command throws, so its spawn fails after the run row exists.
  tasks.update(t.taskId, { effort: null });

  setSlowProbe(true);
  await waitFor(() => runs.get(t.firstRunId)?.status === "succeeded");
  await waitForClaimWithoutRun(t.taskId, 1);
  expect(await cancelLiveRunOfTask(t.taskId)).toBe(true);

  const minted = await waitFor(() => runs.listForTask(t.taskId).find((r) => r.id !== t.firstRunId));
  await waitFor(() => runs.get(minted.id)?.status === "failed");
  setSlowProbe(false);
  await tick(300);

  const events = runs.events(minted.id);
  expect(events.some((e) => e.stream === "stderr" && e.data.startsWith("failed to start agent:"))).toBe(true);
  expect(events.some((e) => e.stream === "status" && e.data === "cancelled by user before the agent launched")).toBe(false);
  expect(runs.get(minted.id)!.status).toBe("failed");
  expect(runs.listForTask(t.taskId).length).toBe(2); // the rest of the queue was dropped, not drained
  const task = tasks.get(t.taskId)!;
  expect(task.column).toBe("ready");
  expect(task.runId).toBeNull();
  expect(task.backlog).toEqual([]);

  // Nothing of that Stop is left for the next turn.
  tasks.update(t.taskId, { effort });
  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "20";
  const later = await sendInput(t.firstRunId, "a later message");
  expect(later.delivered).toBe(true);
  if (!later.delivered) return;
  expect([t.firstRunId, minted.id]).not.toContain(later.runId);
  await waitFor(() => runs.get(later.runId)?.status === "succeeded");
  await deleteAfter(t.taskId);
});

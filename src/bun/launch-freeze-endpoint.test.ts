import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";

// The HTTP answers of a core that stopped taking new work (`freezeLaunches`,
// orchestrator.ts): a headless core handing the port to the app, or the app
// letting a quit through. `POST /tasks/:id/start` answers 503 — retry against
// the next owner, not a bad request — and every other launch route refuses
// with the same reason before doing anything.

// db.ts captures AGETOR_DATA_DIR at first import — set it, the fake driver and
// an isolated port before the dynamic imports below.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-launch-freeze-endpoint-"));
const PORT = 4623;
const ENV_OVERRIDES: Record<string, string> = {
  AGETOR_DATA_DIR: DATA_DIR,
  AGETOR_API_PORT: String(PORT),
  AGETOR_CLAUDE_DRIVER: "fake",
  AGETOR_CLAUDE_BIN: "/bin/echo",
  AGETOR_CLAUDE_ARGS: "",
  AGETOR_TMUX_BIN: "/bin/echo",
};
const savedEnv: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(ENV_OVERRIDES)) {
  savedEnv[k] = process.env[k];
  process.env[k] = v;
}

const BASE = `http://127.0.0.1:${PORT}`;
const workdirs: string[] = [];
let server: { stop: () => void } | null = null;
let token = "";

beforeAll(async () => {
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterEach(async () => {
  const { __resetLaunchFreezeForTest } = await import("./orchestrator.ts");
  __resetLaunchFreezeForTest();
});

afterAll(async () => {
  const { __resetLaunchFreezeForTest, deleteTask } = await import("./orchestrator.ts");
  __resetLaunchFreezeForTest();
  server?.stop();
  const { tasks, pipelines, agentProfiles } = await import("./db.ts");
  for (const t of tasks.list()) {
    if (t.title.startsWith("freeze-endpoint")) await deleteTask(t.id).catch(() => {});
  }
  for (const p of pipelines.list()) if (p.name.startsWith("freeze-endpoint")) pipelines.delete(p.id);
  for (const p of agentProfiles.list()) if (p.name.startsWith("freeze-endpoint")) agentProfiles.delete(p.id);
  for (const [k, prev] of Object.entries(savedEnv)) {
    if (prev === undefined) delete process.env[k];
    else process.env[k] = prev;
  }
  await Bun.sleep(100);
  rmTestDataDir(DATA_DIR);
  for (const dir of workdirs) rmTestDataDir(dir);
});

function makeWorkdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-launch-freeze-endpoint-wd-"));
  workdirs.push(dir);
  return dir;
}

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() >= deadline) throw new Error(`waitFor: not met within ${timeoutMs}ms`);
    await Bun.sleep(20);
  }
}

async function post(pathname: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function makeClaudeTask(): Promise<string> {
  const { createTask } = await import("./orchestrator.ts");
  const created = await createTask({
    title: `freeze-endpoint ${randomUUID()}`,
    prompt: "hello",
    agent: "claude-code",
    workdir: makeWorkdir(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}

test("POST /tasks/:id/start answers 503 launches-frozen while frozen, and starts again once the freeze is lifted", async () => {
  const { freezeLaunches, LAUNCHES_FROZEN_REASON } = await import("./orchestrator.ts");
  const { runs } = await import("./db.ts");
  const taskId = await makeClaudeTask();

  freezeLaunches();
  const refused = await post(`/tasks/${taskId}/start`);
  expect(refused.status).toBe(503);
  expect(refused.json).toEqual({ error: LAUNCHES_FROZEN_REASON, code: "launches-frozen" });
  // Refused before any state changed: no run row.
  expect(runs.listForTask(taskId)).toHaveLength(0);

  // Not a property of the task: the same request succeeds without the freeze.
  const { __resetLaunchFreezeForTest } = await import("./orchestrator.ts");
  __resetLaunchFreezeForTest();
  const ok = await post(`/tasks/${taskId}/start`);
  expect(ok.status).toBe(200);
  expect(typeof ok.json.runId).toBe("string");
  await waitFor(() => runs.listForTask(taskId).every((r) => r.status !== "running"));
});

test("a frozen core refuses a follow-up message without creating a run, and an fx resume before any other check", async () => {
  const { freezeLaunches, startTask, LAUNCHES_FROZEN_REASON } = await import("./orchestrator.ts");
  const { runs, tasks } = await import("./db.ts");
  const taskId = await makeClaudeTask();
  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  await waitFor(() => runs.get(started.runId)?.status !== "running" && tasks.get(taskId)?.column !== "running");
  const before = runs.listForTask(taskId).length;
  const eventsBefore = runs.eventsForTask(taskId).length;

  freezeLaunches();
  const sent = await post(`/runs/${started.runId}/input`, { line: "one more thing" });
  expect(sent.status).toBe(200);
  expect(sent.json).toEqual({ delivered: false, reason: LAUNCHES_FROZEN_REASON });
  expect(runs.listForTask(taskId)).toHaveLength(before);
  // No user bubble for a message that was never sent.
  expect(runs.eventsForTask(taskId).length).toBe(eventsBefore);

  // A claude task would otherwise get a 400 ("not an fx task"): the freeze
  // answers first.
  const resumed = await post(`/tasks/${taskId}/fx-resume`);
  expect(resumed.status).toBe(409);
  expect(resumed.json).toEqual({ error: LAUNCHES_FROZEN_REASON });
});

test("a frozen core refuses pipeline start, restart, advance and retry with the freeze reason", async () => {
  const { freezeLaunches, createTask, LAUNCHES_FROZEN_REASON } = await import("./orchestrator.ts");
  const { tasks, pipelines, agentProfiles } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const profile = agentProfiles.insert({
    name: `freeze-endpoint-${randomUUID()}`,
    harness: "claude-code",
    model: "fake-model",
    effort: null,
    mode: null,
    speed: "off",
    maxMode: false,
    instructions: "",
    skills: [],
  });
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: "do A" });
  const pipeline = pipelines.insert({
    name: `freeze-endpoint-${randomUUID()}`,
    graph: { steps: [A], edges: [], startStepId: A.id },
    maxSteps: 25,
  });
  const created = await createTask({
    title: `freeze-endpoint pipeline ${randomUUID()}`,
    prompt: "goal",
    workdir: makeWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  const runBefore = JSON.stringify(tasks.get(parentId)?.pipelineRun ?? null);

  freezeLaunches();
  const start = await post(`/tasks/${parentId}/start`);
  expect(start.status).toBe(503);
  expect(start.json.code).toBe("launches-frozen");

  // A never-run pipeline would otherwise answer these with its own 409s
  // ("pipeline has never run", "nothing to advance"): the freeze answers first.
  for (const [route, body] of [
    [`/tasks/${parentId}/pipeline/restart`, undefined],
    [`/tasks/${parentId}/pipeline/advance`, { nextStepIds: null }],
    [`/tasks/${parentId}/pipeline/retry`, {}],
  ] as const) {
    const res = await post(route, body);
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: LAUNCHES_FROZEN_REASON });
  }

  // Nothing ran: no step rows, run state untouched.
  expect(tasks.stepsForParent(parentId)).toHaveLength(0);
  expect(JSON.stringify(tasks.get(parentId)?.pipelineRun ?? null)).toBe(runBefore);
});

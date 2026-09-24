// Route-level tests for pipelines (docs/plans/pipelines.md §3/T4): the
// `/pipelines*` CRUD routes, `POST /tasks`'s `pipelineId` binding, `GET
// /tasks/:id/pipeline`, the three run-control routes
// (advance/retry/cancel), and the step-task guards (delete/archive/column
// PATCH). Mirrors agent-profiles-endpoint.test.ts's structure: AGETOR_DATA_DIR
// and a unique AGETOR_API_PORT are set at module scope BEFORE `./db.ts`/
// `./server.ts` are dynamically imported in `beforeAll`, every request
// carries the bearer API_TOKEN, and the claude harness is driven through the
// in-process fake driver (no tmux, no real CLI) so the step-guard tests can
// actually start a pipeline run.
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentProfile, Pipeline, Task } from "../shared/types.ts";
import { PIPELINE_LIMITS } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pipelines-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Drive claude through the in-process fake (no tmux, no real CLI) — needed
// for the step-guard tests, which actually start a pipeline run.
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo"; // tmux probe in agent-status passes
process.env.AGETOR_CLAUDE_ARGS = "";
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT
// (checked via `grep -rhn "AGETOR_API_PORT = " src/bun/*.test.ts`); 4601 was
// unused as of this writing.
process.env.AGETOR_API_PORT = "4601";

const BASE = "http://127.0.0.1:4601";
const WORKDIR = mkdtempSync(path.join(tmpdir(), "agetor-pipelines-endpoint-workdir-"));

let server: { stop: () => void };
let token: string;
let db: typeof import("./db.ts").db;

beforeAll(async () => {
  ({ db } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  // The runner only reacts to step-task settle/column events once this is
  // called (normally done once at app boot, in index.ts/headless.ts, before
  // reconcileOrphans() — see initPipelineRunner's doc comment). Without it,
  // a started pipeline's step task runs but its parent's `pipelineRun`
  // never observes the settle, so it never leaves `"running"`.
  const { initPipelineRunner } = await import("./pipeline-runner.ts");
  initPipelineRunner();
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
  rmTestDataDir(DATA_DIR);
});

beforeEach(() => {
  // Tasks first — no reliance on FK cascade ordering between the two.
  db.run(`DELETE FROM tasks`);
  db.run(`DELETE FROM pipelines`);
  db.run(`DELETE FROM agent_profiles`);
  db.run(`DELETE FROM harnesses WHERE is_builtin = 0`);
});

const call = (p: string, init: RequestInit = {}) =>
  fetch(`${BASE}${p}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

async function createProfile(overrides: Record<string, unknown> = {}): Promise<AgentProfile> {
  const res = await call("/agent-profiles", {
    method: "POST",
    body: JSON.stringify({
      name: "Pipeline Step Agent",
      harness: "claude-code",
      model: "claude-opus-4-7",
      effort: "high",
      mode: "auto",
      fast: false,
      maxMode: false,
      instructions: "Be terse.",
      skills: [],
      ...overrides,
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as AgentProfile;
}

/** A minimal valid one-step graph (no edges): `validatePipelineGraph`
 *  requires only `id`/`name` per step, everything else defaults. */
function oneStepGraph(agentProfileId: string | null = null, stepOverrides: Record<string, unknown> = {}) {
  const stepId = randomUUID();
  return {
    steps: [
      {
        id: stepId,
        name: "Step 1",
        instructions: "Do the work, then emit the handoff.",
        agentProfileId,
        ...stepOverrides,
      },
    ],
    edges: [],
    startStepId: stepId,
  };
}

function danglingEdgeGraph() {
  const stepId = randomUUID();
  return {
    steps: [{ id: stepId, name: "Step 1" }],
    edges: [{ id: randomUUID(), from: stepId, to: "does-not-exist", label: "" }],
    startStepId: stepId,
  };
}

function duplicateNameGraph() {
  const a = randomUUID();
  const b = randomUUID();
  return {
    steps: [
      { id: a, name: "Same Name" },
      { id: b, name: "same name" }, // case-insensitive duplicate
    ],
    edges: [],
    startStepId: a,
  };
}

async function createPipeline(
  agentProfileId: string | null = null,
  overrides: Record<string, unknown> = {},
): Promise<Pipeline> {
  const res = await call("/pipelines", {
    method: "POST",
    body: JSON.stringify({
      name: "Test Pipeline",
      description: "A test pipeline.",
      graph: oneStepGraph(agentProfileId),
      ...overrides,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Pipeline;
}

async function createTaskRaw(overrides: Record<string, unknown> = {}): Promise<Response> {
  return call("/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: "T",
      prompt: "P",
      workdir: WORKDIR,
      isolation: "none",
      ...overrides,
    }),
  });
}

async function createTask(overrides: Record<string, unknown> = {}): Promise<Task> {
  const res = await createTaskRaw(overrides);
  expect(res.status).toBe(200);
  return (await res.json()) as Task;
}

/** Poll `GET /tasks/:id/pipeline` until at least `minCount` step tasks
 *  exist. The runner inserts the step row before spawning its agent, so
 *  this settles quickly against the fake claude driver. */
async function waitForSteps(
  taskId: string,
  minCount = 1,
  attempts = 100,
  intervalMs = 50,
): Promise<{ task: Task; steps: Task[] }> {
  for (let i = 0; i < attempts; i++) {
    const res = await call(`/tasks/${taskId}/pipeline`);
    if (res.status === 200) {
      const data = (await res.json()) as { task: Task; steps: Task[] };
      if (data.steps.length >= minCount) return data;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for >= ${minCount} step task(s) on pipeline ${taskId}`);
}

/**
 * Wait until the pipeline parent's run is no longer `"running"` (the fake
 * claude driver resolves a turn almost instantly — `AGETOR_FAKE_CLAUDE_
 * RESOLVE_DELAY_MS` defaults to 5ms — so this settles quickly in practice).
 * Load-bearing for any test that starts a real run: `beforeEach` truncates
 * `tasks` between tests, which cascades to `runs`/`run_events`; a still
 * in-flight async event append racing that truncation throws an unhandled
 * foreign-key error that corrupts the NEXT test. Every test that calls
 * `waitForSteps` must await this before returning.
 */
async function waitForPipelineSettled(taskId: string, attempts = 100, intervalMs = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const res = await call(`/tasks/${taskId}/pipeline`);
    if (res.status === 200) {
      const data = (await res.json()) as { task: Task };
      if (data.task.pipelineRun?.status !== "running") {
        // One extra beat for any trailing event-append work that fires
        // just after the status flip.
        await new Promise((r) => setTimeout(r, 50));
        return;
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for pipeline ${taskId} to settle out of "running"`);
}

// ---------------------------------------------------------------------------
// GET /pipelines — empty + list
// ---------------------------------------------------------------------------

test("GET /pipelines on an empty table returns []", async () => {
  const res = await call("/pipelines");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);
});

// ---------------------------------------------------------------------------
// POST /pipelines — happy path + exact shape
// ---------------------------------------------------------------------------

test("POST /pipelines happy path creates and returns the pipeline with the exact shape", async () => {
  const graph = oneStepGraph(null);
  const res = await call("/pipelines", {
    method: "POST",
    body: JSON.stringify({ name: "My Pipeline", description: "desc", graph, maxSteps: 10 }),
  });
  expect(res.status).toBe(201);
  const created = (await res.json()) as Pipeline;
  expect(created.name).toBe("My Pipeline");
  expect(created.description).toBe("desc");
  expect(created.maxSteps).toBe(10);
  expect(created.graph.steps).toHaveLength(1);
  expect(created.graph.steps[0]!.name).toBe("Step 1");
  expect(typeof created.id).toBe("string");
  expect(typeof created.createdAt).toBe("number");
  expect(typeof created.updatedAt).toBe("number");
  expect(created.taskCount).toBe(0);

  const list = (await (await call("/pipelines")).json()) as Pipeline[];
  expect(list).toEqual([created]);
});

test("POST /pipelines defaults description to '' and maxSteps to the default when omitted", async () => {
  const res = await call("/pipelines", {
    method: "POST",
    body: JSON.stringify({ name: "Minimal", graph: oneStepGraph(null) }),
  });
  expect(res.status).toBe(201);
  const created = (await res.json()) as Pipeline;
  expect(created.description).toBe("");
  expect(created.maxSteps).toBe(PIPELINE_LIMITS.maxStepsDefault);
});

// ---------------------------------------------------------------------------
// POST /pipelines — 400 matrix
// ---------------------------------------------------------------------------

test.each([
  ["null", "null"],
  ["array", "[]"],
  ["string", '"x"'],
])("POST /pipelines with a non-object JSON body (%s) → 400, not 500", async (_label, raw) => {
  const res = await call("/pipelines", { method: "POST", body: raw });
  expect(res.status).toBe(400);
  const parsed = (await res.json()) as { error: string };
  expect(parsed.error).toBeTruthy();
});

test("POST /pipelines with a missing name → 400", async () => {
  const res = await call("/pipelines", {
    method: "POST",
    body: JSON.stringify({ graph: oneStepGraph(null) }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBeTruthy();
});

test("POST /pipelines with a name over the limit → 400", async () => {
  const res = await call("/pipelines", {
    method: "POST",
    body: JSON.stringify({ name: "x".repeat(PIPELINE_LIMITS.name + 1), graph: oneStepGraph(null) }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain(String(PIPELINE_LIMITS.name));
});

test("POST /pipelines with a description over the limit → 400", async () => {
  const res = await call("/pipelines", {
    method: "POST",
    body: JSON.stringify({
      name: "Long Desc",
      description: "d".repeat(PIPELINE_LIMITS.description + 1),
      graph: oneStepGraph(null),
    }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("description");
});

test("POST /pipelines with a missing graph → 400", async () => {
  const res = await call("/pipelines", { method: "POST", body: JSON.stringify({ name: "No Graph" }) });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBeTruthy();
});

test("POST /pipelines with a graph containing a dangling edge → 400 (parser's own message)", async () => {
  const res = await call("/pipelines", {
    method: "POST",
    body: JSON.stringify({ name: "Dangling", graph: danglingEdgeGraph() }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("unknown step");
});

test("POST /pipelines with a graph containing duplicate (case-insensitive) step names → 400", async () => {
  const res = await call("/pipelines", {
    method: "POST",
    body: JSON.stringify({ name: "Dup Names", graph: duplicateNameGraph() }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("duplicate step name");
});

test.each([
  ["zero", 0],
  ["negative", -1],
  ["non-integer", 1.5],
  ["over the max", PIPELINE_LIMITS.maxStepsMax + 1],
  ["a string", "10"],
])("POST /pipelines with an invalid maxSteps (%s) → 400", async (_label, value) => {
  const res = await call("/pipelines", {
    method: "POST",
    body: JSON.stringify({ name: "Bad Max Steps", graph: oneStepGraph(null), maxSteps: value }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("maxSteps");
});

// ---------------------------------------------------------------------------
// 409 duplicate name — POST and PATCH
// ---------------------------------------------------------------------------

test("POST /pipelines with a duplicate name → 409", async () => {
  await createPipeline(null, { name: "Dup" });
  const res = await call("/pipelines", {
    method: "POST",
    body: JSON.stringify({ name: "Dup", graph: oneStepGraph(null) }),
  });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBeTruthy();
});

test("PATCH /pipelines/:id with a name colliding with another pipeline → 409", async () => {
  await createPipeline(null, { name: "Taken" });
  const other = await createPipeline(null, { name: "Other" });
  const res = await call(`/pipelines/${other.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "Taken" }),
  });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBeTruthy();
  // untouched
  expect((await (await call(`/pipelines/${other.id}`)).json()).name).toBe("Other");
});

// ---------------------------------------------------------------------------
// GET/PATCH/DELETE /pipelines/:id — 404s
// ---------------------------------------------------------------------------

test("GET /pipelines/:id on an unknown id → 404", async () => {
  const res = await call("/pipelines/does-not-exist");
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBeTruthy();
});

test("PATCH /pipelines/:id on an unknown id → 404", async () => {
  const res = await call("/pipelines/does-not-exist", {
    method: "PATCH",
    body: JSON.stringify({ name: "x" }),
  });
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBeTruthy();
});

test("DELETE /pipelines/:id on an unknown id → 404", async () => {
  const res = await call("/pipelines/does-not-exist", { method: "DELETE" });
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBeTruthy();
});

// ---------------------------------------------------------------------------
// PATCH /pipelines/:id — partial update + 400 matrix
// ---------------------------------------------------------------------------

test("PATCH /pipelines/:id updates only the provided fields", async () => {
  const created = await createPipeline(null, { name: "Before", description: "d1" });
  const res = await call(`/pipelines/${created.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "After" }),
  });
  expect(res.status).toBe(200);
  const updated = (await res.json()) as Pipeline;
  expect(updated.name).toBe("After");
  expect(updated.description).toBe("d1"); // untouched
  expect(updated.graph).toEqual(created.graph); // untouched
});

test("PATCH /pipelines/:id with a graph containing a dangling edge → 400", async () => {
  const created = await createPipeline(null);
  const res = await call(`/pipelines/${created.id}`, {
    method: "PATCH",
    body: JSON.stringify({ graph: danglingEdgeGraph() }),
  });
  expect(res.status).toBe(400);
});

test("PATCH /pipelines/:id with an invalid maxSteps → 400", async () => {
  const created = await createPipeline(null);
  const res = await call(`/pipelines/${created.id}`, {
    method: "PATCH",
    body: JSON.stringify({ maxSteps: 0 }),
  });
  expect(res.status).toBe(400);
});

// ---------------------------------------------------------------------------
// DELETE /pipelines/:id — never blocked, even with a bound task
// ---------------------------------------------------------------------------

test("DELETE /pipelines/:id succeeds even when a task is bound to it", async () => {
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const task = await createTask({ pipelineId: pipeline.id });
  expect(task.pipelineId).toBe(pipeline.id);

  const res = await call(`/pipelines/${pipeline.id}`, { method: "DELETE" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });

  const list = (await (await call("/pipelines")).json()) as Pipeline[];
  expect(list.find((p) => p.id === pipeline.id)).toBeUndefined();
});

// ---------------------------------------------------------------------------
// taskCount
// ---------------------------------------------------------------------------

test("GET /pipelines list and GET /pipelines/:id carry taskCount: 0 for a fresh pipeline", async () => {
  await createPipeline(null, { name: "Fresh" });
  const list = (await (await call("/pipelines")).json()) as Pipeline[];
  expect(list).toHaveLength(1);
  expect(list[0]!.taskCount).toBe(0);

  const fetched = (await (await call(`/pipelines/${list[0]!.id}`)).json()) as Pipeline;
  expect(fetched.taskCount).toBe(0);
});

test("taskCount goes to 1 after POST /tasks with pipelineId, and back to 0 after the task is deleted", async () => {
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);

  const task = await createTask({ pipelineId: pipeline.id });
  expect(task.pipelineId).toBe(pipeline.id);

  const afterBind = (await (await call(`/pipelines/${pipeline.id}`)).json()) as Pipeline;
  expect(afterBind.taskCount).toBe(1);

  const listAfterBind = (await (await call("/pipelines")).json()) as Pipeline[];
  expect(listAfterBind.find((p) => p.id === pipeline.id)?.taskCount).toBe(1);

  const deleteRes = await call(`/tasks/${task.id}`, { method: "DELETE" });
  expect(deleteRes.status).toBe(204);

  const afterDelete = (await (await call(`/pipelines/${pipeline.id}`)).json()) as Pipeline;
  expect(afterDelete.taskCount).toBe(0);
});

// ---------------------------------------------------------------------------
// POST /tasks with pipelineId — create the parent + wire shape validation
// ---------------------------------------------------------------------------

test("POST /tasks with pipelineId creates a parent task bound to the pipeline with an idle run", async () => {
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);

  const task = await createTask({ pipelineId: pipeline.id });
  expect(task.pipelineId).toBe(pipeline.id);
  expect(task.pipelineParentId ?? null).toBeNull();
  expect(task.pipelineStepId ?? null).toBeNull();
  expect(task.pipelineRun).not.toBeNull();
  expect(task.pipelineRun?.status).toBe("idle");
  expect(task.pipelineRun?.pipelineId).toBe(pipeline.id);
});

test("POST /tasks with an unknown pipelineId → 400", async () => {
  const res = await createTaskRaw({ pipelineId: "does-not-exist" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBeTruthy();
});

test("POST /tasks with a non-string pipelineId → 400", async () => {
  const res = await createTaskRaw({ pipelineId: 123 });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("pipelineId");
});

test("POST /tasks with pipelineId: null → 200 with pipelineId null (same as omitting it)", async () => {
  const task = await createTask({ pipelineId: null });
  expect(task.pipelineId ?? null).toBeNull();
});

test("POST /tasks with both pipelineId and agentProfileId → 400", async () => {
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const res = await createTaskRaw({ pipelineId: pipeline.id, agentProfileId: profile.id });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBeTruthy();
});

// ---------------------------------------------------------------------------
// GET /tasks/:id/pipeline
// ---------------------------------------------------------------------------

test("GET /tasks/:id/pipeline returns { task, steps } for a pipeline parent", async () => {
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const task = await createTask({ pipelineId: pipeline.id });

  const res = await call(`/tasks/${task.id}/pipeline`);
  expect(res.status).toBe(200);
  const data = (await res.json()) as { task: Task; steps: Task[] };
  expect(data.task.id).toBe(task.id);
  expect(data.steps).toEqual([]);
});

test("GET /tasks/:id/pipeline on a plain (non-pipeline) task → 400", async () => {
  const task = await createTask();
  const res = await call(`/tasks/${task.id}/pipeline`);
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("not a pipeline task");
});

test("GET /tasks/:id/pipeline on an unknown task → 404", async () => {
  const res = await call("/tasks/does-not-exist/pipeline");
  expect(res.status).toBe(404);
});

// ---------------------------------------------------------------------------
// Step-task guards: create+start a real pipeline run, then assert the
// delete/archive/column-PATCH guards on its step task(s).
// ---------------------------------------------------------------------------

test("step tasks: DELETE and archive are 409, column PATCH is 409, other-field PATCH is 200", async () => {
  // The fake claude driver resolves near-instantly, but this test also
  // waits for the run to fully settle (waitForPipelineSettled) so the
  // NEXT test's beforeEach truncation can't race an in-flight event
  // append — give it more room than bun's 5s default.
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const parent = await createTask({ pipelineId: pipeline.id, workdir: WORKDIR, isolation: "none" });

  const startRes = await call(`/tasks/${parent.id}/start`, { method: "POST" });
  expect(startRes.status).toBe(200);

  const { steps } = await waitForSteps(parent.id);
  const step = steps[0]!;
  expect(step.pipelineParentId).toBe(parent.id);
  expect(typeof step.pipelineStepId).toBe("string");

  const deleteRes = await call(`/tasks/${step.id}`, { method: "DELETE" });
  expect(deleteRes.status).toBe(409);
  expect((await deleteRes.json()).error).toContain("belongs to a pipeline");

  const archiveRes = await call(`/tasks/${step.id}/archive`, { method: "POST" });
  expect(archiveRes.status).toBe(409);
  expect((await archiveRes.json()).error).toContain("belongs to a pipeline");

  const columnRes = await call(`/tasks/${step.id}`, {
    method: "PATCH",
    body: JSON.stringify({ column: "done" }),
  });
  expect(columnRes.status).toBe(409);
  expect((await columnRes.json()).error).toContain("column is managed");

  const titleRes = await call(`/tasks/${step.id}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "Renamed step task" }),
  });
  expect(titleRes.status).toBe(200);
  const titled = (await titleRes.json()) as Task;
  expect(titled.title).toBe("Renamed step task");

  // Let the run fully settle before the test ends — see
  // `waitForPipelineSettled`'s doc comment.
  await waitForPipelineSettled(parent.id);
}, 20_000);

// ---------------------------------------------------------------------------
// Pipeline fields are server-managed: not in ALLOWED_PATCH_FIELDS
// ---------------------------------------------------------------------------

test("PATCH /tasks/:id silently ignores pipelineId/pipelineRun/pipelineParentId/pipelineStepId", async () => {
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const task = await createTask({ pipelineId: pipeline.id });

  const res = await call(`/tasks/${task.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      pipelineId: "some-other-id",
      pipelineParentId: "x",
      pipelineStepId: "y",
      pipelineRun: null,
    }),
  });
  expect(res.status).toBe(200);
  const updated = (await res.json()) as Task;
  expect(updated.pipelineId).toBe(pipeline.id);
  expect(updated.pipelineRun).not.toBeNull();
  expect(updated.pipelineParentId ?? null).toBeNull();
  expect(updated.pipelineStepId ?? null).toBeNull();
});

// ---------------------------------------------------------------------------
// Advance / retry / cancel — status codes
// ---------------------------------------------------------------------------

test("POST /tasks/:id/pipeline/advance on an idle (never-started) pipeline → 409", async () => {
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const task = await createTask({ pipelineId: pipeline.id });

  const res = await call(`/tasks/${task.id}/pipeline/advance`, {
    method: "POST",
    body: JSON.stringify({ nextStepIds: null }),
  });
  expect(res.status).toBe(409);
});

test("POST /tasks/:id/pipeline/retry on an idle (never-started) pipeline → 409", async () => {
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const task = await createTask({ pipelineId: pipeline.id });

  const res = await call(`/tasks/${task.id}/pipeline/retry`, { method: "POST", body: JSON.stringify({}) });
  expect(res.status).toBe(409);
});

test("POST /tasks/:id/pipeline/cancel on an idle (never-started) pipeline → 409", async () => {
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const task = await createTask({ pipelineId: pipeline.id });

  const res = await call(`/tasks/${task.id}/pipeline/cancel`, { method: "POST" });
  expect(res.status).toBe(409);
});

test("POST /tasks/:id/pipeline/advance on an unknown task → 404", async () => {
  const res = await call("/tasks/does-not-exist/pipeline/advance", {
    method: "POST",
    body: JSON.stringify({ nextStepIds: null }),
  });
  expect(res.status).toBe(404);
});

test("POST /tasks/:id/pipeline/retry on an unknown task → 404", async () => {
  const res = await call("/tasks/does-not-exist/pipeline/retry", { method: "POST", body: JSON.stringify({}) });
  expect(res.status).toBe(404);
});

test("POST /tasks/:id/pipeline/cancel on an unknown task → 404", async () => {
  const res = await call("/tasks/does-not-exist/pipeline/cancel", { method: "POST" });
  expect(res.status).toBe(404);
});

test("POST /tasks/:id/pipeline/advance with a missing nextStepIds → 400", async () => {
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const task = await createTask({ pipelineId: pipeline.id });

  const res = await call(`/tasks/${task.id}/pipeline/advance`, { method: "POST", body: JSON.stringify({}) });
  expect(res.status).toBe(400);
});

test("POST /tasks/:id/pipeline/advance with a non-array, non-null nextStepIds → 400", async () => {
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const task = await createTask({ pipelineId: pipeline.id });

  const res = await call(`/tasks/${task.id}/pipeline/advance`, {
    method: "POST",
    body: JSON.stringify({ nextStepIds: "not-an-array" }),
  });
  expect(res.status).toBe(400);
});

test("POST /tasks/:id/pipeline/advance with a non-string entry in nextStepIds → 400", async () => {
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const task = await createTask({ pipelineId: pipeline.id });

  const res = await call(`/tasks/${task.id}/pipeline/advance`, {
    method: "POST",
    body: JSON.stringify({ nextStepIds: [42] }),
  });
  expect(res.status).toBe(400);
});

test("POST /tasks/:id/pipeline/advance with a non-object handoff → 400", async () => {
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const task = await createTask({ pipelineId: pipeline.id });

  const res = await call(`/tasks/${task.id}/pipeline/advance`, {
    method: "POST",
    body: JSON.stringify({ nextStepIds: null, handoff: "nope" }),
  });
  expect(res.status).toBe(400);
});

test("POST /tasks/:id/pipeline/advance with a non-string fromTaskId → 400", async () => {
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const task = await createTask({ pipelineId: pipeline.id });

  const res = await call(`/tasks/${task.id}/pipeline/advance`, {
    method: "POST",
    body: JSON.stringify({ nextStepIds: null, fromTaskId: 42 }),
  });
  expect(res.status).toBe(400);
});

test("POST /tasks/:id/pipeline/advance with a non-object JSON body → 400", async () => {
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const task = await createTask({ pipelineId: pipeline.id });

  const res = await call(`/tasks/${task.id}/pipeline/advance`, { method: "POST", body: "[]" });
  expect(res.status).toBe(400);
});

test("POST /tasks/:id/pipeline/retry with a non-string taskId → 400", async () => {
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const task = await createTask({ pipelineId: pipeline.id });

  const res = await call(`/tasks/${task.id}/pipeline/retry`, {
    method: "POST",
    body: JSON.stringify({ taskId: 42 }),
  });
  expect(res.status).toBe(400);
});

test("POST /tasks/:id/pipeline/retry with no body at all → treated as {} (not a 400)", async () => {
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const task = await createTask({ pipelineId: pipeline.id });

  const res = await call(`/tasks/${task.id}/pipeline/retry`, { method: "POST" });
  // No body means "no taskId" — an idle parent still can't be retried, but
  // the request shape itself must not 400.
  expect(res.status).toBe(409);
});

// ---------------------------------------------------------------------------
// M15: POST /tasks/:id/pipeline/restart — status-code matrix + a real
// restart-after-done round trip.
// ---------------------------------------------------------------------------

test("POST /tasks/:id/pipeline/restart on an unknown task → 404", async () => {
  const res = await call("/tasks/does-not-exist/pipeline/restart", { method: "POST" });
  expect(res.status).toBe(404);
});

test("POST /tasks/:id/pipeline/restart on a plain (non-pipeline) task → 400", async () => {
  const task = await createTask();
  const res = await call(`/tasks/${task.id}/pipeline/restart`, { method: "POST" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("not a pipeline task");
});

test("POST /tasks/:id/pipeline/restart on an already-running pipeline → 409", async () => {
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  // Widen the window between "turn started" and "turn resolved" so the
  // restart call below reliably lands while the run is still genuinely
  // `"running"` — same technique pipeline-runner.test.ts's cancel/retry
  // tests use.
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "700";
  try {
    const profile = await createProfile();
    const graph = oneStepGraph(profile.id, { instructions: `Do it. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
    const pipeline = await createPipeline(profile.id, { graph });
    const task = await createTask({ pipelineId: pipeline.id, workdir: WORKDIR, isolation: "none" });

    const startRes = await call(`/tasks/${task.id}/start`, { method: "POST" });
    expect(startRes.status).toBe(200);

    const restartRes = await call(`/tasks/${task.id}/pipeline/restart`, { method: "POST" });
    expect(restartRes.status).toBe(409);

    await waitForPipelineSettled(task.id);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
}, 20_000);

test("POST /tasks/:id/pipeline/restart runs a finished (done) pipeline again from the top; plain start on it 400s", async () => {
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const profile = await createProfile();
  const graph = oneStepGraph(profile.id, { instructions: `Do it. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const pipeline = await createPipeline(profile.id, { graph });
  const task = await createTask({ pipelineId: pipeline.id, workdir: WORKDIR, isolation: "none" });

  const startRes = await call(`/tasks/${task.id}/start`, { method: "POST" });
  expect(startRes.status).toBe(200);
  await waitForPipelineSettled(task.id);

  const settled = (await (await call(`/tasks/${task.id}/pipeline`)).json()) as { task: Task };
  expect(settled.task.pipelineRun?.status).toBe("done");
  const firstStartedAt = settled.task.pipelineRun?.startedAt;

  // Once a pipeline run is done, `POST /tasks/:id/start` (plain startTask →
  // startPipelineRun with no restart flag) errors out — only the explicit
  // restart route may run it again from the top.
  const plainStartRes = await call(`/tasks/${task.id}/start`, { method: "POST" });
  expect(plainStartRes.status).toBe(400);

  const restartRes = await call(`/tasks/${task.id}/pipeline/restart`, { method: "POST" });
  expect(restartRes.status).toBe(200);
  const restarted = (await restartRes.json()) as { runId?: string; pending?: true };
  expect(typeof restarted.runId === "string" || restarted.pending === true).toBe(true);

  await waitForPipelineSettled(task.id);
  const resettled = (await (await call(`/tasks/${task.id}/pipeline`)).json()) as { task: Task };
  expect(resettled.task.pipelineRun?.status).toBe("done");
  // A genuine restart, not a no-op: the run started over, so its
  // `startedAt` moved forward.
  expect(resettled.task.pipelineRun?.startedAt).not.toBe(firstStartedAt);
}, 20_000);

test("POST /tasks/:id/pipeline/restart on a blocked run also runs it again from the top (Major 3) — a plain start retries in place instead", async () => {
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const profile = await createProfile();
  // `:missing` emits prose with no `<handoff>` block at all, which the
  // runner records as a `handoff-missing` block and settles the run
  // `blocked` — see `agents.ts`'s `lastFakeHandoffSuffix` doc comment.
  const graph = oneStepGraph(profile.id, { instructions: `Do it. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
  const pipeline = await createPipeline(profile.id, { graph });
  const task = await createTask({ pipelineId: pipeline.id, workdir: WORKDIR, isolation: "none" });

  const startRes = await call(`/tasks/${task.id}/start`, { method: "POST" });
  expect(startRes.status).toBe(200);
  await waitForPipelineSettled(task.id);

  const settled = (await (await call(`/tasks/${task.id}/pipeline`)).json()) as { task: Task };
  expect(settled.task.pipelineRun?.status).toBe("blocked");
  const firstStartedAt = settled.task.pipelineRun?.startedAt;
  const firstHistoryLength = settled.task.pipelineRun?.history.length ?? 0;

  // A plain start on a blocked run retries in place (M2) — same run,
  // `startedAt` untouched, history preserved (it'll just re-block the same
  // way, since the step still emits no handoff).
  const plainStartRes = await call(`/tasks/${task.id}/start`, { method: "POST" });
  expect(plainStartRes.status).toBe(200);
  await waitForPipelineSettled(task.id);
  const retried = (await (await call(`/tasks/${task.id}/pipeline`)).json()) as { task: Task };
  expect(retried.task.pipelineRun?.status).toBe("blocked");
  expect(retried.task.pipelineRun?.startedAt).toBe(firstStartedAt);

  // The explicit restart route, in contrast, discards history and starts
  // over from the top even though the run is `blocked`, not `done` — the
  // route's own semantics ("fresh run for any status except running").
  const restartRes = await call(`/tasks/${task.id}/pipeline/restart`, { method: "POST" });
  expect(restartRes.status).toBe(200);
  const restarted = (await restartRes.json()) as { runId?: string; pending?: true };
  expect(typeof restarted.runId === "string" || restarted.pending === true).toBe(true);

  await waitForPipelineSettled(task.id);
  const resettled = (await (await call(`/tasks/${task.id}/pipeline`)).json()) as { task: Task };
  expect(resettled.task.pipelineRun?.status).toBe("blocked");
  expect(resettled.task.pipelineRun?.startedAt).not.toBe(firstStartedAt);
  expect(resettled.task.pipelineRun?.history.length).toBe(firstHistoryLength);
}, 20_000);

// ---------------------------------------------------------------------------
// M7: an orphaned step (its pipeline parent row no longer exists) can be
// deleted/archived directly — there's no parent left to redirect the caller
// to, so the ordinary "act on the pipeline task instead" guard would
// otherwise leave the row stuck forever.
// ---------------------------------------------------------------------------

test("DELETE /tasks/:id on an orphaned pipeline step (parent row gone) is allowed", async () => {
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const parent = await createTask({ pipelineId: pipeline.id, workdir: WORKDIR, isolation: "none" });

  const startRes = await call(`/tasks/${parent.id}/start`, { method: "POST" });
  expect(startRes.status).toBe(200);
  const { steps } = await waitForSteps(parent.id);
  const step = steps[0]!;
  await waitForPipelineSettled(parent.id);

  // Simulate the parent row having vanished out from under the step (a
  // partial cascade failure, or on-disk state predating this fix) — raw SQL,
  // bypassing `deleteTask`'s own cascade, so the step is left a genuine
  // orphan with no parent left to route the caller to.
  db.run(`DELETE FROM tasks WHERE id = ?`, [parent.id]);

  const deleteRes = await call(`/tasks/${step.id}`, { method: "DELETE" });
  expect(deleteRes.status).toBe(204);

  const getRes = await call(`/tasks/${step.id}`);
  expect(getRes.status).toBe(404);
}, 20_000);

test("POST /tasks/:id/archive on an orphaned pipeline step (parent row gone) is allowed", async () => {
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const profile = await createProfile();
  const graph = oneStepGraph(profile.id, { instructions: `Do it. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const pipeline = await createPipeline(profile.id, { graph });
  const parent = await createTask({ pipelineId: pipeline.id, workdir: WORKDIR, isolation: "none" });

  const startRes = await call(`/tasks/${parent.id}/start`, { method: "POST" });
  expect(startRes.status).toBe(200);
  const { steps } = await waitForSteps(parent.id);
  const step = steps[0]!;
  await waitForPipelineSettled(parent.id);
  // The step's own handoff resolved terminal, so its column already settled
  // to "done" — `archiveTask` requires that (or `force`) before proceeding.
  expect((await (await call(`/tasks/${step.id}`)).json() as Task).column).toBe("done");

  db.run(`DELETE FROM tasks WHERE id = ?`, [parent.id]);

  const archiveRes = await call(`/tasks/${step.id}/archive`, { method: "POST" });
  expect(archiveRes.status).toBe(200);
  const archived = (await archiveRes.json()) as Task;
  expect(archived.archivedAt).not.toBeNull();
}, 20_000);

// ---------------------------------------------------------------------------
// M17: GET /tasks/:id aggregates a pipeline parent's step pending-interaction
// counts, the same way the batched `tasks.list()` pass already does (D11).
// ---------------------------------------------------------------------------

test("GET /tasks/:id aggregates pipeline step pending-interaction counts onto the parent", async () => {
  const { registerTmuxPrompt } = await import("./interactions.ts");
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const parent = await createTask({ pipelineId: pipeline.id, workdir: WORKDIR, isolation: "none" });

  const startRes = await call(`/tasks/${parent.id}/start`, { method: "POST" });
  expect(startRes.status).toBe(200);
  const { steps } = await waitForSteps(parent.id);
  const step = steps[0]!;

  registerTmuxPrompt({
    taskId: step.id,
    runId: "fake-run-1",
    paneText: "pane",
    choices: [{ key: "1", label: "Yes" }],
    fingerprint: `fp-${step.id}-1`,
  });
  registerTmuxPrompt({
    taskId: step.id,
    runId: "fake-run-1",
    paneText: "pane 2",
    choices: [{ key: "1", label: "Yes" }],
    fingerprint: `fp-${step.id}-2`,
  });

  const parentTask = (await (await call(`/tasks/${parent.id}`)).json()) as Task;
  expect(parentTask.pendingInteractionCount).toBe(2);

  const stepTask = (await (await call(`/tasks/${step.id}`)).json()) as Task;
  expect(stepTask.pendingInteractionCount).toBe(2);

  await waitForPipelineSettled(parent.id);
}, 20_000);

// ---------------------------------------------------------------------------
// Review-fix wave: H4 / M-S3 / M-S4 / M-R5 / L-S1 / L-S6 / L-S10 pins.
// ---------------------------------------------------------------------------

test("GET /tasks/:id/interactions/pending on a pipeline PARENT unions its step tasks' pending requests, and each request carries pipelineParentId (H4)", async () => {
  const { registerTmuxPrompt, listPendingForTask } = await import("./interactions.ts");
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const parent = await createTask({ pipelineId: pipeline.id, workdir: WORKDIR, isolation: "none" });

  const startRes = await call(`/tasks/${parent.id}/start`, { method: "POST" });
  expect(startRes.status).toBe(200);
  const { steps } = await waitForSteps(parent.id);
  const step = steps[0]!;
  await waitForPipelineSettled(parent.id);

  const { req } = registerTmuxPrompt({
    taskId: step.id,
    runId: "fake-run-h4",
    paneText: "pane",
    choices: [{ key: "1", label: "Yes" }],
    fingerprint: `fp-h4-${step.id}`,
  });
  // The registry stamps the step's parent onto the request itself, so the
  // orchestrator's GlobalEvent bridge (and every SSE consumer) can scope it
  // to the board card without a second lookup.
  expect(req.pipelineParentId).toBe(parent.id);
  // A plain task registers with no such key at all (shape unchanged).
  const plain = await createTask();
  const { req: plainReq } = registerTmuxPrompt({
    taskId: plain.id,
    runId: "fake-run-h4-plain",
    paneText: "pane",
    choices: [{ key: "1", label: "Yes" }],
    fingerprint: `fp-h4-plain`,
  });
  expect("pipelineParentId" in plainReq).toBe(false);

  // The parent's own registry list is empty (nothing registers against a
  // parent id) — but the ROUTE answers with the step's card, since the
  // parent is the id the board showed as "waiting on you".
  expect(listPendingForTask(parent.id)).toHaveLength(0);
  const viaParent = (await (await call(`/tasks/${parent.id}/interactions/pending`)).json()) as Array<{
    id: string;
    taskId: string;
    pipelineParentId?: string;
  }>;
  expect(viaParent).toHaveLength(1);
  expect(viaParent[0]!.id).toBe(req.id);
  expect(viaParent[0]!.taskId).toBe(step.id);
  expect(viaParent[0]!.pipelineParentId).toBe(parent.id);
  // The step's own list still works unchanged.
  const viaStep = (await (await call(`/tasks/${step.id}/interactions/pending`)).json()) as Array<{ id: string }>;
  expect(viaStep.map((r) => r.id)).toEqual([req.id]);
  // And a plain task's list is untouched by the union.
  const viaPlain = (await (await call(`/tasks/${plain.id}/interactions/pending`)).json()) as Array<{ id: string }>;
  expect(viaPlain.map((r) => r.id)).toEqual([plainReq.id]);
}, 20_000);

test("GET /tasks ships a trimmed pipelineRun (no handoffs, no profile snapshots); GET /tasks/:id and /tasks/:id/pipeline ship the full state (M-S3)", async () => {
  const { tasks } = await import("./db.ts");
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const parent = await createTask({ pipelineId: pipeline.id });
  const stepId = pipeline.graph.steps[0]!.id;

  const handoff = {
    schemaVersion: 1 as const,
    purpose: "p",
    summary: "big summary",
    reason: "r",
    next: null,
    artifacts: ["a.ts"],
    openQuestions: [],
  };
  // Shape-only fixture — `sanitizeRunSnapshot` keeps `profiles` as "a record
  // of objects" without deep-validating against `AgentProfileSnapshot`.
  const snapshotProfiles = { [profile.id]: { id: profile.id, name: profile.name } } as unknown as Record<
    string,
    import("../shared/types.ts").AgentProfileSnapshot
  >;
  // Seed a run state directly — what matters here is the wire shape, not
  // how the runner got there.
  tasks.setPipelineRun(parent.id, {
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    snapshot: {
      graph: pipeline.graph,
      maxSteps: 25,
      profiles: snapshotProfiles,
      capturedAt: 1,
    },
    status: "blocked",
    active: [{ stepId, taskId: "step-task-1", seq: 1 }],
    joins: { [stepId]: { arrivals: [{ fromStepId: stepId, seq: 1, handoff }] } },
    blocked: [{ taskId: "step-task-1", stepId, kind: "handoff-invalid", message: "bad" }],
    history: [
      { seq: 1, stepId, taskId: "step-task-1", startedAt: 1, endedAt: 2, outcome: "succeeded", handoff, nextStepIds: [] },
    ],
    stepCount: 1,
    startedAt: 1,
    endedAt: null,
  });

  const list = (await (await call("/tasks")).json()) as Task[];
  const listed = list.find((t) => t.id === parent.id)!;
  expect(listed.pipelineRun).not.toBeNull();
  const trimmed = listed.pipelineRun!;
  // Trimmed: every persisted handoff nulled, profiles emptied…
  expect(trimmed.history).toHaveLength(1);
  expect(trimmed.history[0]!.handoff).toBeNull();
  expect(trimmed.joins[stepId]!.arrivals[0]!.handoff).toBeNull();
  expect(trimmed.snapshot!.profiles).toEqual({});
  // …but everything the board/TUI/`agetor ls` read is intact.
  expect(trimmed.snapshot!.graph).toEqual(pipeline.graph);
  expect(trimmed.status).toBe("blocked");
  expect(trimmed.active).toEqual([{ stepId, taskId: "step-task-1", seq: 1 }]);
  expect(trimmed.blocked).toHaveLength(1);
  expect(trimmed.history[0]!.outcome).toBe("succeeded");
  expect(trimmed.stepCount).toBe(1);

  const single = (await (await call(`/tasks/${parent.id}`)).json()) as Task;
  expect(single.pipelineRun!.history[0]!.handoff).toEqual(handoff);
  expect(single.pipelineRun!.joins[stepId]!.arrivals[0]!.handoff).toEqual(handoff);
  expect(single.pipelineRun!.snapshot!.profiles).toEqual(snapshotProfiles);

  const viaPipeline = (await (await call(`/tasks/${parent.id}/pipeline`)).json()) as { task: Task };
  expect(viaPipeline.task.pipelineRun!.history[0]!.handoff).toEqual(handoff);
  expect(viaPipeline.task.pipelineRun!.snapshot!.profiles).toEqual(snapshotProfiles);

  // The server's own read is never trimmed either (the runner reads it).
  expect(tasks.get(parent.id)!.pipelineRun!.history[0]!.handoff).toEqual(handoff);
});

test("PATCH /tasks/:id column on a pipeline PARENT → 409 when it differs; a same-value resend is a no-op 200 (M-S4)", async () => {
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const parent = await createTask({ pipelineId: pipeline.id });
  expect(parent.column).toBe("backlog");

  const moved = await call(`/tasks/${parent.id}`, { method: "PATCH", body: JSON.stringify({ column: "done" }) });
  expect(moved.status).toBe(409);
  expect((await moved.json()).error).toBe("pipeline task's column is managed by its run");
  expect(((await (await call(`/tasks/${parent.id}`)).json()) as Task).column).toBe("backlog");

  const same = await call(`/tasks/${parent.id}`, { method: "PATCH", body: JSON.stringify({ column: "backlog", title: "Renamed" }) });
  expect(same.status).toBe(200);
  expect(((await same.json()) as Task).title).toBe("Renamed");

  // An ordinary task's column is still freely patchable.
  const plain = await createTask();
  const plainMoved = await call(`/tasks/${plain.id}`, { method: "PATCH", body: JSON.stringify({ column: "ready" }) });
  expect(plainMoved.status).toBe(200);
  expect(((await plainMoved.json()) as Task).column).toBe("ready");
});

test("POST /tasks/:id/start on a (non-orphaned) pipeline step task → 409 (M-R5)", async () => {
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const parent = await createTask({ pipelineId: pipeline.id, workdir: WORKDIR, isolation: "none" });

  const startRes = await call(`/tasks/${parent.id}/start`, { method: "POST" });
  expect(startRes.status).toBe(200);
  const { steps } = await waitForSteps(parent.id);
  const step = steps[0]!;
  await waitForPipelineSettled(parent.id);

  const before = (await (await call(`/tasks/${step.id}/runs`)).json()) as unknown[];
  const res = await call(`/tasks/${step.id}/start`, { method: "POST" });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe("step task is managed by its pipeline — retry the pipeline task instead");
  // Nothing was spawned: the step's run history is unchanged.
  const after = (await (await call(`/tasks/${step.id}/runs`)).json()) as unknown[];
  expect(after.length).toBe(before.length);
}, 20_000);

test("POST/PATCH /pipelines reject a name with control characters (L-S1)", async () => {
  for (const bad of ["Tab\tName", "New\nLine", "Bell\u0007", "Del\u007f"]) {
    const res = await call("/pipelines", {
      method: "POST",
      body: JSON.stringify({ name: bad, graph: oneStepGraph() }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("pipeline name must not contain control characters");
  }
  const created = await createPipeline(null, { name: "Fine" });
  const patched = await call(`/pipelines/${created.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "Not\u0000Fine" }),
  });
  expect(patched.status).toBe(400);
  expect((await patched.json()).error).toBe("pipeline name must not contain control characters");
  expect(((await (await call(`/pipelines/${created.id}`)).json()) as Pipeline).name).toBe("Fine");
  // A graph step name with a control char is rejected by the same rule.
  const badStep = await call("/pipelines", {
    method: "POST",
    body: JSON.stringify({ name: "Graph", graph: oneStepGraph(null, { name: "Step\u0001" }) }),
  });
  expect(badStep.status).toBe(400);
  expect((await badStep.json()).error).toContain("control characters");
});

test("POST/PATCH /pipelines with a non-string description → 400 'description must be a string' (L-S6)", async () => {
  const post = await call("/pipelines", {
    method: "POST",
    body: JSON.stringify({ name: "Desc", description: ["not", "a", "string"], graph: oneStepGraph() }),
  });
  expect(post.status).toBe(400);
  expect((await post.json()).error).toBe("description must be a string");

  const created = await createPipeline(null, { name: "Desc", description: "keep me" });
  const patched = await call(`/pipelines/${created.id}`, {
    method: "PATCH",
    body: JSON.stringify({ description: 42 }),
  });
  expect(patched.status).toBe(400);
  expect((await patched.json()).error).toBe("description must be a string");
  // A rejected PATCH never wiped the real description (the old code read a
  // non-string as "" and stored it).
  expect(((await (await call(`/pipelines/${created.id}`)).json()) as Pipeline).description).toBe("keep me");
  // `description: null` is treated like a non-string too — explicit, not silently "".
  const nulled = await call(`/pipelines/${created.id}`, { method: "PATCH", body: JSON.stringify({ description: null }) });
  expect(nulled.status).toBe(400);
});

test("POST /pipelines maxSteps 0 / maxStepsMax+1 / 1.5 → 400, boundary values 1 and maxStepsMax → 201 (L-S10)", async () => {
  for (const bad of [0, PIPELINE_LIMITS.maxStepsMax + 1, 1.5, -1, "10"]) {
    const res = await call("/pipelines", {
      method: "POST",
      body: JSON.stringify({ name: `Max ${String(bad)}`, graph: oneStepGraph(), maxSteps: bad }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(`maxSteps must be an integer between 1 and ${PIPELINE_LIMITS.maxStepsMax}`);
  }
  const min = await createPipeline(null, { name: "Min", maxSteps: 1 });
  expect(min.maxSteps).toBe(1);
  const max = await createPipeline(null, { name: "Max", maxSteps: PIPELINE_LIMITS.maxStepsMax });
  expect(max.maxSteps).toBe(PIPELINE_LIMITS.maxStepsMax);
});

test("every /pipelines* and /tasks/:id/pipeline* route is 401 without a bearer token (L-S10)", async () => {
  const profile = await createProfile();
  const pipeline = await createPipeline(profile.id);
  const task = await createTask({ pipelineId: pipeline.id });
  const routes: Array<[string, string]> = [
    ["GET", "/pipelines"],
    ["POST", "/pipelines"],
    ["GET", `/pipelines/${pipeline.id}`],
    ["PATCH", `/pipelines/${pipeline.id}`],
    ["DELETE", `/pipelines/${pipeline.id}`],
    ["GET", `/tasks/${task.id}/pipeline`],
    ["POST", `/tasks/${task.id}/pipeline/advance`],
    ["POST", `/tasks/${task.id}/pipeline/retry`],
    ["POST", `/tasks/${task.id}/pipeline/cancel`],
    ["POST", `/tasks/${task.id}/pipeline/restart`],
  ];
  for (const [method, path] of routes) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify({ nextStepIds: null }),
    });
    expect([method, path, res.status]).toEqual([method, path, 401]);
  }
  // Nothing was mutated by the unauthenticated calls.
  expect((await (await call(`/pipelines/${pipeline.id}`)).json()).id).toBe(pipeline.id);
});

test("POST /tasks/:id/pipeline/advance: an unknown nextStepIds entry → 400, an empty array is accepted by the route, fromTaskId '' → 400 (L-S10)", async () => {
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const profile = await createProfile();
  const graph = oneStepGraph(profile.id, { instructions: `Do it. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
  const pipeline = await createPipeline(profile.id, { graph });
  const task = await createTask({ pipelineId: pipeline.id, workdir: WORKDIR, isolation: "none" });

  // `fromTaskId: ""` is rejected at the route, before the runner could
  // silently treat it as "auto-detect" — even on a never-started run.
  const blank = await call(`/tasks/${task.id}/pipeline/advance`, {
    method: "POST",
    body: JSON.stringify({ nextStepIds: null, fromTaskId: "" }),
  });
  expect(blank.status).toBe(400);
  expect((await blank.json()).error).toBe("fromTaskId must be a non-empty string");

  // An empty array passes body validation (it's "advance to nothing", same
  // as null) — on a never-started run it reaches the runner's 409, not a 400.
  const emptyIdle = await call(`/tasks/${task.id}/pipeline/advance`, {
    method: "POST",
    body: JSON.stringify({ nextStepIds: [] }),
  });
  expect(emptyIdle.status).toBe(409);

  // Now block the run on a missing handoff so the sole active execution is
  // auto-detected as the advance target.
  const startRes = await call(`/tasks/${task.id}/start`, { method: "POST" });
  expect(startRes.status).toBe(200);
  await waitForPipelineSettled(task.id);
  const settled = (await (await call(`/tasks/${task.id}/pipeline`)).json()) as { task: Task };
  expect(settled.task.pipelineRun?.status).toBe("blocked");

  const unknown = await call(`/tasks/${task.id}/pipeline/advance`, {
    method: "POST",
    body: JSON.stringify({ nextStepIds: ["does-not-exist"] }),
  });
  expect(unknown.status).toBe(400);
  expect((await unknown.json()).error).toBe('unknown step id "does-not-exist"');
  // Still blocked — a rejected advance mutates nothing.
  const still = (await (await call(`/tasks/${task.id}/pipeline`)).json()) as { task: Task };
  expect(still.task.pipelineRun?.status).toBe("blocked");

  // An empty array on the blocked run ends the path exactly like null does.
  const emptyBlocked = await call(`/tasks/${task.id}/pipeline/advance`, {
    method: "POST",
    body: JSON.stringify({ nextStepIds: [] }),
  });
  expect(emptyBlocked.status).toBe(200);
  const ended = (await emptyBlocked.json()) as Task;
  expect(ended.pipelineRun?.status).toBe("done");
  expect(ended.pipelineRun?.history.at(-1)?.outcome).toBe("advanced-manually");
  expect(ended.pipelineRun?.history.at(-1)?.nextStepIds).toEqual([]);
  await waitForPipelineSettled(task.id);
}, 20_000);

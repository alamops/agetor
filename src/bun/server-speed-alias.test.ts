// Route tests for the speed API alias (docs/plans/fx-0.0.14-and-cursor-updates.md
// §3.1, D13): `POST /tasks`, `PATCH /tasks/:id` and `POST`/`PATCH
// /agent-profiles` accept `speed` (`off | fast | ultrafast`) and the legacy
// boolean `fast` (`true` → "fast", `false` → "off"; an explicit `speed` wins),
// 400 on a bad value of either, run the bound-profile 409 guard against the
// resolved tier, and every Task / AgentProfile response carries `speed` plus
// the derived `fast`. Same harness as agent-profiles-endpoint.test.ts:
// AGETOR_DATA_DIR and a unique AGETOR_API_PORT are set before `./db.ts` /
// `./server.ts` load.
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentProfile, Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-speed-alias-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT.
process.env.AGETOR_API_PORT = "4733";

const BASE = "http://127.0.0.1:4733";
const WORKDIR = mkdtempSync(path.join(tmpdir(), "agetor-speed-alias-workdir-"));

const SPEED_ERROR = "speed must be one of off, fast, ultrafast";
const FAST_ERROR = "fast must be a boolean";

let server: { stop: () => void };
let token: string;
let db: typeof import("./db.ts").db;

beforeAll(async () => {
  ({ db } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
  rmTestDataDir(DATA_DIR);
});

beforeEach(() => {
  db.run(`DELETE FROM tasks`);
  db.run(`DELETE FROM agent_profiles`);
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

const createTaskRaw = (overrides: Record<string, unknown> = {}) =>
  call("/tasks", {
    method: "POST",
    body: JSON.stringify({ title: "T", prompt: "P", workdir: WORKDIR, isolation: "none", ...overrides }),
  });

async function createTask(overrides: Record<string, unknown> = {}): Promise<Task> {
  const res = await createTaskRaw(overrides);
  expect(res.status).toBe(200);
  return (await res.json()) as Task;
}

const patchTask = (id: string, body: Record<string, unknown>) =>
  call(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) });

const getTask = async (id: string) => (await (await call(`/tasks/${id}`)).json()) as Task;

const createProfileRaw = (overrides: Record<string, unknown> = {}) =>
  call("/agent-profiles", {
    method: "POST",
    body: JSON.stringify({ name: "Speedy", harness: "cursor", model: "composer-2", ...overrides }),
  });

async function createProfile(overrides: Record<string, unknown> = {}): Promise<AgentProfile> {
  const res = await createProfileRaw(overrides);
  expect(res.status).toBe(200);
  return (await res.json()) as AgentProfile;
}

const patchProfile = (id: string, body: Record<string, unknown>) =>
  call(`/agent-profiles/${id}`, { method: "PATCH", body: JSON.stringify(body) });

// ---------------------------------------------------------------------------
// PATCH /tasks/:id
// ---------------------------------------------------------------------------

test("PATCH {fast: true} stores speed fast", async () => {
  const task = await createTask();
  expect(task.speed).toBe("off");
  const res = await patchTask(task.id, { fast: true });
  expect(res.status).toBe(200);
  const updated = (await res.json()) as Task;
  expect(updated.speed).toBe("fast");
  expect(updated.fast).toBe(true);
});

test("PATCH {fast: false} stores speed off", async () => {
  const task = await createTask({ speed: "fast" });
  const updated = (await (await patchTask(task.id, { fast: false })).json()) as Task;
  expect(updated.speed).toBe("off");
  expect(updated.fast).toBe(false);
});

test("PATCH {speed: \"ultrafast\", fast: false} stores ultrafast — speed wins", async () => {
  const task = await createTask();
  const res = await patchTask(task.id, { speed: "ultrafast", fast: false });
  expect(res.status).toBe(200);
  const updated = (await res.json()) as Task;
  expect(updated.speed).toBe("ultrafast");
  expect(updated.fast).toBe(true);
});

test("PATCH without speed or fast leaves the tier alone", async () => {
  const task = await createTask({ speed: "fast" });
  const updated = (await (await patchTask(task.id, { title: "Renamed" })).json()) as Task;
  expect(updated.title).toBe("Renamed");
  expect(updated.speed).toBe("fast");
});

test.each([
  [{ speed: "x" }, SPEED_ERROR],
  [{ speed: true }, SPEED_ERROR],
  [{ speed: null }, SPEED_ERROR],
  [{ fast: "yes" }, FAST_ERROR],
  [{ fast: 1 }, FAST_ERROR],
])("PATCH %j → 400 and nothing is written", async (body, message) => {
  const task = await createTask({ speed: "fast" });
  const res = await patchTask(task.id, { title: "Should not land", ...body });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe(message);
  const after = await getTask(task.id);
  expect(after.title).toBe("T");
  expect(after.speed).toBe("fast");
});

// ---------------------------------------------------------------------------
// POST /tasks
// ---------------------------------------------------------------------------

test("POST /tasks with speed stores it, and GET carries speed plus the derived fast", async () => {
  const task = await createTask({ speed: "ultrafast" });
  expect(task.speed).toBe("ultrafast");
  expect(task.fast).toBe(true);
  const fetched = await getTask(task.id);
  expect(fetched.speed).toBe("ultrafast");
  expect(fetched.fast).toBe(true);
  const listed = ((await (await call("/tasks")).json()) as Task[]).find((t) => t.id === task.id)!;
  expect(listed.speed).toBe("ultrafast");
  expect(listed.fast).toBe(true);
});

test("POST /tasks with the legacy fast: true stores speed fast", async () => {
  const task = await createTask({ fast: true });
  expect(task.speed).toBe("fast");
  expect(task.fast).toBe(true);
});

test("POST /tasks with neither field defaults to speed off", async () => {
  const task = await createTask();
  expect(task.speed).toBe("off");
  expect(task.fast).toBe(false);
});

test("POST /tasks with speed and fast together — speed wins", async () => {
  const task = await createTask({ speed: "off", fast: true });
  expect(task.speed).toBe("off");
});

test.each([
  [{ speed: "turbo" }, SPEED_ERROR],
  [{ fast: "yes" }, FAST_ERROR],
])("POST /tasks %j → 400 and no task is created", async (body, message) => {
  const res = await createTaskRaw(body);
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe(message);
  expect(((await (await call("/tasks")).json()) as Task[]).length).toBe(0);
});

// ---------------------------------------------------------------------------
// Bound-profile 409 guard
// ---------------------------------------------------------------------------

test("a bound task 409s on a speed change via speed", async () => {
  const profile = await createProfile({ name: "Bound Speed", speed: "fast" });
  const task = await createTask({ agentProfileId: profile.id });
  expect(task.speed).toBe("fast");
  const res = await patchTask(task.id, { speed: "off" });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toContain("Bound Speed");
  expect((await getTask(task.id)).speed).toBe("fast");
});

test("a bound task 409s on a speed change via the legacy fast alias", async () => {
  const profile = await createProfile({ name: "Bound Fast", speed: "fast" });
  const task = await createTask({ agentProfileId: profile.id });
  const res = await patchTask(task.id, { fast: false });
  expect(res.status).toBe(409);
  expect((await getTask(task.id)).speed).toBe("fast");
});

test("a bound task 409s when fast: true would move ultrafast down to fast", async () => {
  const profile = await createProfile({ name: "Bound Ultra", speed: "ultrafast" });
  const task = await createTask({ agentProfileId: profile.id });
  expect(task.speed).toBe("ultrafast");
  const res = await patchTask(task.id, { fast: true });
  expect(res.status).toBe(409);
});

test("a bound task passes a same-value resend via speed or fast", async () => {
  const profile = await createProfile({ name: "Bound Same", speed: "fast" });
  const task = await createTask({ agentProfileId: profile.id });
  const viaSpeed = await patchTask(task.id, { speed: "fast", title: "A" });
  expect(viaSpeed.status).toBe(200);
  const viaFast = await patchTask(task.id, { fast: true, title: "B" });
  expect(viaFast.status).toBe(200);
  const after = (await viaFast.json()) as Task;
  expect(after.title).toBe("B");
  expect(after.speed).toBe("fast");
  expect(after.agentProfileId).toBe(profile.id);
});

// ---------------------------------------------------------------------------
// POST / PATCH /agent-profiles
// ---------------------------------------------------------------------------

test("POST /agent-profiles with speed stores it; GET carries speed plus the derived fast", async () => {
  const created = await createProfile({ speed: "ultrafast" });
  expect(created.speed).toBe("ultrafast");
  expect(created.fast).toBe(true);
  const fetched = (await (await call(`/agent-profiles/${created.id}`)).json()) as AgentProfile;
  expect(fetched.speed).toBe("ultrafast");
  expect(fetched.fast).toBe(true);
  const listed = ((await (await call("/agent-profiles")).json()) as AgentProfile[])[0]!;
  expect(listed.speed).toBe("ultrafast");
  expect(listed.fast).toBe(true);
});

test("POST /agent-profiles with the legacy fast: true stores speed fast; neither field → off", async () => {
  const viaFast = await createProfile({ name: "Via Fast", fast: true });
  expect(viaFast.speed).toBe("fast");
  const neither = await createProfile({ name: "Neither" });
  expect(neither.speed).toBe("off");
  expect(neither.fast).toBe(false);
  const both = await createProfile({ name: "Both", speed: "off", fast: true });
  expect(both.speed).toBe("off");
});

test.each([
  [{ speed: "turbo" }, SPEED_ERROR],
  [{ fast: "yes" }, FAST_ERROR],
])("POST /agent-profiles %j → 400 and nothing is written", async (body, message) => {
  const res = await createProfileRaw(body);
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe(message);
  expect(((await (await call("/agent-profiles")).json()) as AgentProfile[]).length).toBe(0);
});

test("PATCH /agent-profiles/:id maps speed and the fast alias, speed winning", async () => {
  const profile = await createProfile();
  const viaFast = (await (await patchProfile(profile.id, { fast: true })).json()) as AgentProfile;
  expect(viaFast.speed).toBe("fast");
  const viaSpeed = (await (await patchProfile(profile.id, { speed: "ultrafast" })).json()) as AgentProfile;
  expect(viaSpeed.speed).toBe("ultrafast");
  expect(viaSpeed.fast).toBe(true);
  const both = (await (await patchProfile(profile.id, { speed: "off", fast: true })).json()) as AgentProfile;
  expect(both.speed).toBe("off");
  expect(both.fast).toBe(false);
  const untouched = (await (await patchProfile(profile.id, { instructions: "x" })).json()) as AgentProfile;
  expect(untouched.speed).toBe("off");
});

test.each([
  [{ speed: "turbo" }, SPEED_ERROR],
  [{ fast: "yes" }, FAST_ERROR],
])("PATCH /agent-profiles/:id %j → 400 and nothing is written", async (body, message) => {
  const profile = await createProfile({ speed: "fast" });
  const res = await patchProfile(profile.id, { instructions: "should not land", ...body });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe(message);
  const after = (await (await call(`/agent-profiles/${profile.id}`)).json()) as AgentProfile;
  expect(after.speed).toBe("fast");
  expect(after.instructions).toBe("");
});

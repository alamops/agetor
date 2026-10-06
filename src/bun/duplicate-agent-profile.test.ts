// Route tests for POST /agent-profiles/:id/duplicate.
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentProfile, Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-duplicate-profile-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4603";

const BASE = "http://127.0.0.1:4603";
const WORKDIR = mkdtempSync(path.join(tmpdir(), "agetor-duplicate-profile-workdir-"));

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
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });

async function createProfile(overrides: Record<string, unknown> = {}): Promise<AgentProfile> {
  const res = await call("/agent-profiles", {
    method: "POST",
    body: JSON.stringify({
      name: "Research Bot",
      harness: "claude-code",
      model: "claude-opus-4-7",
      effort: "high",
      mode: "auto",
      fast: false,
      maxMode: false,
      instructions: "Be terse.",
      skills: ["skill-a", "skill-b"],
      ...overrides,
    }),
  });
  expect(res.status).toBeLessThan(300);
  return (await res.json()) as AgentProfile;
}

async function createTask(profileId: string, title = "Ordinary task"): Promise<Task> {
  const res = await call("/tasks", {
    method: "POST",
    body: JSON.stringify({
      title,
      prompt: "do it",
      workdir: WORKDIR,
      isolation: "none",
      agentProfileId: profileId,
    }),
  });
  expect(res.status).toBeLessThan(300);
  return (await res.json()) as Task;
}

const dup = (id: string, body: unknown = {}) =>
  call(`/agent-profiles/${id}/duplicate`, { method: "POST", body: JSON.stringify(body) });

const getProfile = async (id: string) =>
  (await (await call(`/agent-profiles/${id}`)).json()) as AgentProfile & { taskCount: number };

const getTask = async (id: string) => (await (await call(`/tasks/${id}`)).json()) as Task;

const listCount = async () => ((await (await call("/agent-profiles")).json()) as unknown[]).length;

test("duplicate with {} copies fields and names it (copy)", async () => {
  const src = await createProfile();
  const before = await getProfile(src.id);
  const res = await dup(src.id);
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    profile: AgentProfile;
    copiedTasks: unknown[];
    taskCopyErrors: unknown[];
  };
  const p = body.profile;
  expect(p.name).toBe("Research Bot (copy)");
  expect(p.id).not.toBe(src.id);
  for (const k of ["harness", "model", "effort", "mode", "fast", "maxMode", "instructions", "skills"] as const) {
    expect(p[k]).toEqual(src[k]);
  }
  expect(body.copiedTasks).toEqual([]);
  expect(body.taskCopyErrors).toEqual([]);
  expect(await getProfile(src.id)).toEqual(before);
});

test("second duplicate is (copy 2)", async () => {
  const src = await createProfile();
  await dup(src.id);
  const res = await dup(src.id);
  expect(res.status).toBe(201);
  expect(((await res.json()) as { profile: AgentProfile }).profile.name).toBe("Research Bot (copy 2)");
});

test("explicit name clash is 409 and count does not grow", async () => {
  const src = await createProfile();
  await dup(src.id);
  const n = await listCount();
  const res = await dup(src.id, { name: "Research Bot (copy)" });
  expect(res.status).toBe(409);
  expect(await listCount()).toBe(n);
});

test("unknown id is 404", async () => {
  expect((await dup("nope")).status).toBe(404);
});

test("copyTasks copies one ordinary task onto the new profile", async () => {
  const src = await createProfile();
  const t = await createTask(src.id);
  const srcCount = (await getProfile(src.id)).taskCount;
  const res = await dup(src.id, { copyTasks: true });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { profile: AgentProfile; copiedTasks: Task[]; taskCopyErrors: unknown[] };
  expect(body.copiedTasks).toHaveLength(1);
  const c = body.copiedTasks[0]!;
  expect(c.title).toBe(t.title);
  expect(c.column).toBe("backlog");
  expect(c.agentProfileId).toBe(body.profile.id);
  expect((await getTask(t.id)).agentProfileId).toBe(src.id);
  expect((await getProfile(body.profile.id)).taskCount).toBe(1);
  expect((await getProfile(src.id)).taskCount).toBe(srcCount);
});

test("archived and pipeline step tasks are not copied", async () => {
  const src = await createProfile();
  const ordinary = await createTask(src.id, "Ordinary");
  const archived = await createTask(src.id, "Archived");
  const step = await createTask(src.id, "Step");
  db.run(`UPDATE tasks SET archived_at = ? WHERE id = ?`, [Date.now(), archived.id]);
  db.run(`UPDATE tasks SET pipeline_parent_id = ? WHERE id = ?`, [ordinary.id, step.id]);
  const res = await dup(src.id, { copyTasks: true });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { copiedTasks: Task[] };
  expect(body.copiedTasks.map((t) => t.title)).toEqual(["Ordinary"]);
});

test("copyTasks omitted copies zero tasks", async () => {
  const src = await createProfile();
  await createTask(src.id);
  const res = await dup(src.id);
  const body = (await res.json()) as { profile: AgentProfile; copiedTasks: unknown[] };
  expect(body.copiedTasks).toEqual([]);
  expect((await getProfile(body.profile.id)).taskCount).toBe(0);
});

test("explicit name and model override win", async () => {
  const src = await createProfile();
  const res = await dup(src.id, { name: "Renamed", model: "sonnet-5" });
  expect(res.status).toBe(201);
  const p = ((await res.json()) as { profile: AgentProfile }).profile;
  expect(p.name).toBe("Renamed");
  expect(p.model).toBe("sonnet-5");
});

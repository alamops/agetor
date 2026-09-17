// Route-level tests for reusable agent profiles (docs/plans/agent-profiles.md
// §3/§5 TT3): the `/agent-profiles*` CRUD routes, `POST /tasks`'s
// `agentProfileId` override, the PATCH `/tasks/:id` bound-agent 409 guard,
// the `DELETE /tasks/:id/agent-profile` detach route, and `DELETE
// /harnesses/:id`'s extended `profileIds` 409 payload. Mirrors
// saved-prompts-endpoint.test.ts's structure: AGETOR_DATA_DIR and a unique
// AGETOR_API_PORT are set at module scope BEFORE `./db.ts`/`./server.ts` are
// dynamically imported in `beforeAll`, and every request carries the bearer
// `API_TOKEN`.
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentProfile, Task } from "../shared/types.ts";
import { AGENT_PROFILE_LIMITS } from "../shared/agent-profile.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-agent-profiles-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT.
process.env.AGETOR_API_PORT = "4501";

const BASE = "http://127.0.0.1:4501";
const WORKDIR = mkdtempSync(path.join(tmpdir(), "agetor-agent-profiles-endpoint-workdir-"));

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
  expect(res.status).toBe(200);
  return (await res.json()) as AgentProfile;
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

// ---------------------------------------------------------------------------
// GET /agent-profiles — empty + list
// ---------------------------------------------------------------------------

test("GET /agent-profiles on an empty table returns []", async () => {
  const res = await call("/agent-profiles");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);
});

// ---------------------------------------------------------------------------
// POST /agent-profiles — happy path + exact shape
// ---------------------------------------------------------------------------

test("POST /agent-profiles happy path creates and returns the profile with the exact shape", async () => {
  const created = await createProfile();
  expect(created).toMatchObject({
    name: "Research Bot",
    harness: "claude-code",
    model: "claude-opus-4-7",
    effort: "high",
    mode: "auto",
    fast: false,
    maxMode: false,
    instructions: "Be terse.",
    skills: ["skill-a", "skill-b"],
  });
  expect(typeof created.id).toBe("string");
  expect(typeof created.createdAt).toBe("number");
  expect(typeof created.updatedAt).toBe("number");

  const list = (await (await call("/agent-profiles")).json()) as AgentProfile[];
  expect(list).toEqual([created]);
});

test("POST /agent-profiles defaults effort/mode to null, fast/maxMode to false, instructions to '', skills to [] when omitted", async () => {
  const res = await call("/agent-profiles", {
    method: "POST",
    body: JSON.stringify({ name: "Minimal", harness: "claude-code", model: "m" }),
  });
  expect(res.status).toBe(200);
  const created = (await res.json()) as AgentProfile;
  expect(created.effort).toBeNull();
  expect(created.mode).toBeNull();
  expect(created.fast).toBe(false);
  expect(created.maxMode).toBe(false);
  expect(created.instructions).toBe("");
  expect(created.skills).toEqual([]);
});

// ---------------------------------------------------------------------------
// POST /agent-profiles — 400s
// ---------------------------------------------------------------------------

test.each([
  ["null", "null"],
  ["array", "[]"],
  ["string", '"x"'],
])("POST /agent-profiles with a non-object JSON body (%s) → 400, not 500", async (_label, raw) => {
  const res = await call("/agent-profiles", { method: "POST", body: raw });
  expect(res.status).toBe(400);
  const parsed = (await res.json()) as { error: string };
  expect(parsed.error).toBeTruthy();
});

test("POST /agent-profiles with a missing name → 400", async () => {
  const res = await call("/agent-profiles", {
    method: "POST",
    body: JSON.stringify({ harness: "claude-code", model: "m" }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBeTruthy();
});

test("POST /agent-profiles with a name over the limit → 400", async () => {
  const res = await call("/agent-profiles", {
    method: "POST",
    body: JSON.stringify({ name: "x".repeat(AGENT_PROFILE_LIMITS.name + 1), harness: "claude-code", model: "m" }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("80");
});

test("POST /agent-profiles with an unknown harness → 400", async () => {
  const res = await call("/agent-profiles", {
    method: "POST",
    body: JSON.stringify({ name: "Bad Harness", harness: "not-a-real-harness", model: "m" }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("unknown harness");
});

test("POST /agent-profiles with a missing model → 400", async () => {
  const res = await call("/agent-profiles", {
    method: "POST",
    body: JSON.stringify({ name: "No Model", harness: "claude-code" }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBeTruthy();
});

test("POST /agent-profiles with non-array skills → 400", async () => {
  const res = await call("/agent-profiles", {
    method: "POST",
    body: JSON.stringify({ name: "Bad Skills", harness: "claude-code", model: "m", skills: "not-an-array" }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("skills");
});

// Review fix F1 finding 5: the route must reject a non-string entry rather
// than silently filtering it out — the "skills must be an array of strings"
// message has to be true, not just the error copy for a bad top-level shape.
test("POST /agent-profiles with a non-string skills entry → 400", async () => {
  const res = await call("/agent-profiles", {
    method: "POST",
    body: JSON.stringify({ name: "Bad Skill Entry", harness: "claude-code", model: "m", skills: ["ok", 42] }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("skills must be an array of strings");
});

// Review fix F1 finding 5: the route must 400 past the cap rather than
// silently truncating — checked AFTER normalize+dedupe, so an input that
// normalizes down to <= the cap (duplicates, `/`-prefixed, whitespace-only
// dupes) is accepted while one that's still over the cap post-normalization
// is rejected.
test("POST /agent-profiles with more than the skills cap (post-normalization) → 400", async () => {
  const skills = Array.from({ length: AGENT_PROFILE_LIMITS.skills + 1 }, (_, i) => `skill-${i}`);
  const res = await call("/agent-profiles", {
    method: "POST",
    body: JSON.stringify({ name: "Too Many Skills", harness: "claude-code", model: "m", skills }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe(`at most ${AGENT_PROFILE_LIMITS.skills} skills`);
});

test("POST /agent-profiles with duplicate skills normalizing under the cap → 200", async () => {
  // AGENT_PROFILE_LIMITS.skills + 5 raw entries, but only 3 unique names once
  // normalized (leading "/" stripped, whitespace collapsed) — must NOT 400.
  const skills = [
    ...Array.from({ length: AGENT_PROFILE_LIMITS.skills + 2 }, () => "/dup-a"),
    ...Array.from({ length: 3 }, () => "  dup-b  "),
    "dup-c",
  ];
  const res = await call("/agent-profiles", {
    method: "POST",
    body: JSON.stringify({ name: "Dedupe Under Cap", harness: "claude-code", model: "m", skills }),
  });
  expect(res.status).toBe(200);
  const created = (await res.json()) as AgentProfile;
  expect(created.skills).toEqual(["dup-a", "dup-b", "dup-c"]);
});

test("PATCH /agent-profiles/:id with a non-string skills entry → 400", async () => {
  const profile = await createProfile();
  const res = await call(`/agent-profiles/${profile.id}`, {
    method: "PATCH",
    body: JSON.stringify({ skills: ["ok", null] }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("skills must be an array of strings");
});

test("PATCH /agent-profiles/:id with more than the skills cap (post-normalization) → 400", async () => {
  const profile = await createProfile();
  const skills = Array.from({ length: AGENT_PROFILE_LIMITS.skills + 1 }, (_, i) => `skill-${i}`);
  const res = await call(`/agent-profiles/${profile.id}`, {
    method: "PATCH",
    body: JSON.stringify({ skills }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe(`at most ${AGENT_PROFILE_LIMITS.skills} skills`);
});

test("POST /agent-profiles with instructions over the limit → 400", async () => {
  const res = await call("/agent-profiles", {
    method: "POST",
    body: JSON.stringify({
      name: "Long Instructions",
      harness: "claude-code",
      model: "m",
      instructions: "a".repeat(AGENT_PROFILE_LIMITS.instructions + 1),
    }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("instructions");
});

// ---------------------------------------------------------------------------
// 409 duplicate name — POST and PATCH
// ---------------------------------------------------------------------------

test("POST /agent-profiles with a duplicate name → 409", async () => {
  await createProfile({ name: "Dup" });
  const res = await call("/agent-profiles", {
    method: "POST",
    body: JSON.stringify({ name: "Dup", harness: "claude-code", model: "m" }),
  });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBeTruthy();
});

test("PATCH /agent-profiles/:id with a name colliding with another profile → 409", async () => {
  await createProfile({ name: "Taken" });
  const other = await createProfile({ name: "Other" });
  const res = await call(`/agent-profiles/${other.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "Taken" }),
  });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBeTruthy();
  // untouched
  expect((await (await call(`/agent-profiles/${other.id}`)).json()).name).toBe("Other");
});

// ---------------------------------------------------------------------------
// GET/PATCH/DELETE /agent-profiles/:id — 404s
// ---------------------------------------------------------------------------

test("GET /agent-profiles/:id on an unknown id → 404", async () => {
  const res = await call("/agent-profiles/does-not-exist");
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBeTruthy();
});

test("PATCH /agent-profiles/:id on an unknown id → 404", async () => {
  const res = await call("/agent-profiles/does-not-exist", {
    method: "PATCH",
    body: JSON.stringify({ name: "x" }),
  });
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBeTruthy();
});

test("DELETE /agent-profiles/:id on an unknown id → 404", async () => {
  const res = await call("/agent-profiles/does-not-exist", { method: "DELETE" });
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBeTruthy();
});

// ---------------------------------------------------------------------------
// PATCH /agent-profiles/:id — happy path + explicit null clears
// ---------------------------------------------------------------------------

test("PATCH /agent-profiles/:id updates only the provided fields", async () => {
  const created = await createProfile({ name: "Before", model: "m1" });
  const res = await call(`/agent-profiles/${created.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "After" }),
  });
  expect(res.status).toBe(200);
  const updated = (await res.json()) as AgentProfile;
  expect(updated.name).toBe("After");
  expect(updated.model).toBe("m1"); // untouched
});

test("PATCH /agent-profiles/:id with explicit effort: null clears effort and leaves mode untouched", async () => {
  const created = await createProfile({ effort: "high", mode: "ask" });
  const res = await call(`/agent-profiles/${created.id}`, {
    method: "PATCH",
    body: JSON.stringify({ effort: null }),
  });
  expect(res.status).toBe(200);
  const updated = (await res.json()) as AgentProfile;
  expect(updated.effort).toBeNull();
  expect(updated.mode).toBe("ask");
});

test("PATCH /agent-profiles/:id with explicit mode: null clears mode and leaves effort untouched", async () => {
  const created = await createProfile({ effort: "high", mode: "ask" });
  const res = await call(`/agent-profiles/${created.id}`, {
    method: "PATCH",
    body: JSON.stringify({ mode: null }),
  });
  expect(res.status).toBe(200);
  const updated = (await res.json()) as AgentProfile;
  expect(updated.mode).toBeNull();
  expect(updated.effort).toBe("high");
});

// ---------------------------------------------------------------------------
// DELETE /agent-profiles/:id — happy path
// ---------------------------------------------------------------------------

test("DELETE /agent-profiles/:id happy path returns { ok: true } and the list omits it", async () => {
  const created = await createProfile();
  const res = await call(`/agent-profiles/${created.id}`, { method: "DELETE" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  const list = (await (await call("/agent-profiles")).json()) as AgentProfile[];
  expect(list.find((p) => p.id === created.id)).toBeUndefined();
});

// ---------------------------------------------------------------------------
// POST /tasks with agentProfileId — overrides + 400s
// ---------------------------------------------------------------------------

test("POST /tasks with agentProfileId overrides agent/model/effort/mode/fast/maxMode from the profile and stores the snapshot", async () => {
  const profile = await createProfile({
    name: "Overriding Agent",
    harness: "claude-code",
    model: "claude-opus-4-7",
    effort: "high",
    mode: "auto",
    fast: true,
    maxMode: true,
    instructions: "Be nice.",
    skills: ["a", "b"],
  });

  const task = await createTask({
    agentProfileId: profile.id,
    agent: "codex",
    model: "ignored-model",
    effort: "ignored-effort",
    mode: "ignored-mode",
    fast: false,
    maxMode: false,
  });

  expect(task.agentProfileId).toBe(profile.id);
  expect(task.agent).toBe("claude-code");
  expect(task.model).toBe("claude-opus-4-7");
  expect(task.effort).toBe("high");
  expect(task.mode).toBe("auto");
  expect(task.fast).toBe(true);
  expect(task.maxMode).toBe(true);

  expect(task.agentProfile).toMatchObject({
    id: profile.id,
    name: "Overriding Agent",
    harness: "claude-code",
    harnessKind: "claude-code",
    harnessLabel: "Claude Code",
    model: "claude-opus-4-7",
    effort: "high",
    mode: "auto",
    fast: true,
    maxMode: true,
    instructions: "Be nice.",
    skills: ["a", "b"],
  });
  expect(typeof task.agentProfile?.capturedAt).toBe("number");
});

test("POST /tasks with an unknown agentProfileId → 400", async () => {
  const res = await createTaskRaw({ agentProfileId: "does-not-exist" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("unknown agent profile");
});

test("POST /tasks with a non-string agentProfileId → 400", async () => {
  const res = await createTaskRaw({ agentProfileId: 123 });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("agentProfileId");
});

// Review fix F1 finding 1: `agentProfileId: null` means "no profile" — same
// as omitting the field entirely — and must not 400 the wire-shape guard.
test("POST /tasks with agentProfileId: null → 200 with both agent-profile fields null", async () => {
  const task = await createTask({ agentProfileId: null });
  expect(task.agentProfileId).toBeNull();
  expect(task.agentProfile).toBeNull();
});

// ---------------------------------------------------------------------------
// PATCH /tasks/:id — bound-agent 409 guard
// ---------------------------------------------------------------------------

test("PATCH /tasks/:id with a changed model on a task bound to an agent profile → 409", async () => {
  const profile = await createProfile({ name: "Locked Agent", model: "claude-opus-4-7" });
  const task = await createTask({ agentProfileId: profile.id });

  const res = await call(`/tasks/${task.id}`, {
    method: "PATCH",
    body: JSON.stringify({ model: "claude-fable-5" }),
  });
  expect(res.status).toBe(409);
  const parsed = (await res.json()) as { error: string };
  expect(parsed.error).toContain("bound to agent");
  expect(parsed.error).toContain("Locked Agent");
});

test("PATCH /tasks/:id with the SAME model value on a bound task → 200 (no-op resend allowed)", async () => {
  const profile = await createProfile({ name: "Same Value Agent", model: "claude-opus-4-7" });
  const task = await createTask({ agentProfileId: profile.id });

  const res = await call(`/tasks/${task.id}`, {
    method: "PATCH",
    body: JSON.stringify({ model: task.model }),
  });
  expect(res.status).toBe(200);
  const updated = (await res.json()) as Task;
  expect(updated.model).toBe(task.model);
  expect(updated.agentProfileId).toBe(profile.id);
});

test("PATCH /tasks/:id with an unrelated field (title) on a bound task → 200", async () => {
  const profile = await createProfile({ name: "Title Edit Agent" });
  const task = await createTask({ agentProfileId: profile.id });

  const res = await call(`/tasks/${task.id}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "Renamed" }),
  });
  expect(res.status).toBe(200);
  const updated = (await res.json()) as Task;
  expect(updated.title).toBe("Renamed");
  expect(updated.agentProfileId).toBe(profile.id);
});

// ---------------------------------------------------------------------------
// DELETE /tasks/:id/agent-profile — detach
// ---------------------------------------------------------------------------

test("DELETE /tasks/:id/agent-profile detaches: both fields go null, then a PATCH to model succeeds", async () => {
  const profile = await createProfile({ name: "Detach Me", model: "claude-opus-4-7" });
  const task = await createTask({ agentProfileId: profile.id });

  const detachRes = await call(`/tasks/${task.id}/agent-profile`, { method: "DELETE" });
  expect(detachRes.status).toBe(200);
  const detached = (await detachRes.json()) as Task;
  expect(detached.agentProfileId).toBeNull();
  expect(detached.agentProfile).toBeNull();
  // Detach keeps the copied-down values as-is (doesn't revert them).
  expect(detached.model).toBe("claude-opus-4-7");

  const patchRes = await call(`/tasks/${task.id}`, {
    method: "PATCH",
    body: JSON.stringify({ model: "claude-fable-5" }),
  });
  expect(patchRes.status).toBe(200);
  const patched = (await patchRes.json()) as Task;
  expect(patched.model).toBe("claude-fable-5");
});

test("DELETE /tasks/:id/agent-profile on an unknown task id → 404", async () => {
  const res = await call("/tasks/does-not-exist/agent-profile", { method: "DELETE" });
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBeTruthy();
});

test("DELETE /tasks/:id/agent-profile on an archived task → 409", async () => {
  const profile = await createProfile({ name: "Archived Agent" });
  const task = await createTask({ agentProfileId: profile.id });

  const archiveRes = await call(`/tasks/${task.id}/archive`, {
    method: "POST",
    body: JSON.stringify({ force: true }),
  });
  expect(archiveRes.status).toBe(200);

  const res = await call(`/tasks/${task.id}/agent-profile`, { method: "DELETE" });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBeTruthy();
});

// ---------------------------------------------------------------------------
// DELETE /harnesses/:id — 409 payload gains profileIds
// ---------------------------------------------------------------------------

test("DELETE /harnesses/:id → 409 with profileIds when a non-builtin harness is referenced by an agent profile", async () => {
  const harnessHome = mkdtempSync(path.join(tmpdir(), "agetor-agent-profiles-endpoint-harness-home-"));
  const harnessRes = await call("/harnesses", {
    method: "POST",
    body: JSON.stringify({
      id: "custom-endpoint-harness",
      kind: "claude-code",
      label: "Custom Endpoint Harness",
      home: harnessHome,
    }),
  });
  expect(harnessRes.status).toBe(200);
  const harness = (await harnessRes.json()) as { id: string };

  const profile = await createProfile({ name: "Uses Custom Harness", harness: harness.id });

  const deleteRes = await call(`/harnesses/${harness.id}`, { method: "DELETE" });
  expect(deleteRes.status).toBe(409);
  const parsed = (await deleteRes.json()) as { error: string; taskIds: string[]; profileIds: string[] };
  expect(parsed.profileIds).toEqual([profile.id]);
  expect(parsed.error).toBeTruthy();

  // Deleting the profile unblocks the harness delete.
  await call(`/agent-profiles/${profile.id}`, { method: "DELETE" });
  const secondDeleteRes = await call(`/harnesses/${harness.id}`, { method: "DELETE" });
  expect(secondDeleteRes.status).toBe(204);
});

// ---------------------------------------------------------------------------
// taskCount — "used by N tasks" follow-up (docs/plans/agent-profiles.md)
// ---------------------------------------------------------------------------

test("GET /agent-profiles list carries taskCount: 0 for a fresh profile", async () => {
  await createProfile({ name: "Fresh" });
  const res = await call("/agent-profiles");
  const list = (await res.json()) as AgentProfile[];
  expect(list).toHaveLength(1);
  expect(list[0]!.taskCount).toBe(0);
});

test("GET /agent-profiles/:id carries taskCount too", async () => {
  const profile = await createProfile({ name: "Solo" });
  const res = await call(`/agent-profiles/${profile.id}`);
  expect(res.status).toBe(200);
  const fetched = (await res.json()) as AgentProfile;
  expect(fetched.taskCount).toBe(0);
});

test("taskCount goes to 1 after POST /tasks with agentProfileId, back to 0 after DELETE /tasks/:id/agent-profile", async () => {
  const profile = await createProfile({ name: "Bound" });

  const task = await createTask({ agentProfileId: profile.id });
  expect(task.agentProfileId).toBe(profile.id);

  const afterBind = (await (await call(`/agent-profiles/${profile.id}`)).json()) as AgentProfile;
  expect(afterBind.taskCount).toBe(1);

  const listAfterBind = (await (await call("/agent-profiles")).json()) as AgentProfile[];
  expect(listAfterBind.find((p) => p.id === profile.id)?.taskCount).toBe(1);

  const detachRes = await call(`/tasks/${task.id}/agent-profile`, { method: "DELETE" });
  expect(detachRes.status).toBe(200);

  const afterDetach = (await (await call(`/agent-profiles/${profile.id}`)).json()) as AgentProfile;
  expect(afterDetach.taskCount).toBe(0);
});

test("taskCount goes back to 0 after the bound task is deleted", async () => {
  const profile = await createProfile({ name: "TaskDeleted" });
  const task = await createTask({ agentProfileId: profile.id });

  const afterBind = (await (await call(`/agent-profiles/${profile.id}`)).json()) as AgentProfile;
  expect(afterBind.taskCount).toBe(1);

  const deleteRes = await call(`/tasks/${task.id}`, { method: "DELETE" });
  expect(deleteRes.status).toBe(204);

  const afterDelete = (await (await call(`/agent-profiles/${profile.id}`)).json()) as AgentProfile;
  expect(afterDelete.taskCount).toBe(0);
});

test("POST /agent-profiles and PATCH /agent-profiles/:id responses also carry taskCount: 0 for a brand-new profile", async () => {
  const created = await createProfile({ name: "CreatedFresh" });
  expect(created.taskCount).toBe(0);

  const patchRes = await call(`/agent-profiles/${created.id}`, {
    method: "PATCH",
    body: JSON.stringify({ model: "claude-sonnet-5" }),
  });
  expect(patchRes.status).toBe(200);
  const patched = (await patchRes.json()) as AgentProfile;
  expect(patched.taskCount).toBe(0);
});

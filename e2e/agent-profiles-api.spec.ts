import { Database } from "bun:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend } from "./fixtures";

/**
 * REST-only coverage for docs/plans/agent-profiles.md, exercised against the
 * real headless backend (`AGETOR_CLAUDE_DRIVER=fake`, per `e2e/fixtures.ts`)
 * rather than the in-process bun-test harness `src/bun/agent-profiles-
 * endpoint.test.ts` already uses — that file covers most of the CRUD/PATCH-
 * guard/taskCount ground at the unit level; this file focuses on what needs
 * the assembled system: the orchestrator's freeze-at-first-run rule (D2)
 * actually firing across a real `startTask`, and a profile snapshot actually
 * surviving a harness relabel through a real run. Items 1-5 below duplicate
 * a slice of the endpoint-test ground on purpose — TT3's own brief calls for
 * it — but stay intentionally lean since the exhaustive shape assertions
 * already live there.
 *
 * No browser is driven anywhere in this file (the `page` fixture is never
 * requested), so no Chromium instance is spawned for it.
 */

const CONVERGE_TIMEOUT = 20_000;

// Every task/profile/harness this file creates is tracked here and cleaned
// up in `afterAll` — belt-and-suspenders on top of each test's own inline
// deletes (which only run on the happy path; a failed assertion mid-test
// would otherwise skip them and leak state into another spec file sharing
// this worker's backend — see `e2e/fixtures.ts`). Deleted in dependency
// order: tasks, then profiles, then harnesses (a profile still referencing
// a harness blocks that harness's delete).
const createdTaskIds: string[] = [];
const createdProfileIds: string[] = [];
const createdHarnessIds: string[] = [];

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

interface AgentProfileRow {
  id: string;
  name: string;
  harness: string;
  model: string;
  effort: string | null;
  mode: string | null;
  taskCount?: number;
}

interface TaskRow {
  id: string;
  title: string;
  column: string;
  archivedAt: number | null;
  agentProfileId: string | null;
  agentProfile: {
    id: string;
    name: string;
    harness: string;
    harnessLabel: string;
    instructions: string;
    model: string;
    effort: string | null;
    mode: string | null;
  } | null;
  agent: string;
  model: string | null;
  effort: string | null;
  mode: string | null;
  runId: string | null;
}

async function createProfile(
  request: APIRequestContext,
  backend: E2EBackend,
  overrides: Record<string, unknown> = {},
): Promise<AgentProfileRow> {
  const res = await request.post(`${backend.apiBase}/agent-profiles`, {
    headers: auth(backend),
    data: {
      name: `Profile ${Math.random().toString(36).slice(2)}`,
      harness: "claude-code",
      model: "opus-5",
      effort: "high",
      mode: "auto",
      instructions: "Be terse.",
      skills: ["a"],
      ...overrides,
    },
  });
  expect(res.ok(), `POST /agent-profiles -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  const created = (await res.json()) as AgentProfileRow;
  createdProfileIds.push(created.id);
  return created;
}

async function deleteProfile(request: APIRequestContext, backend: E2EBackend, id: string): Promise<void> {
  await request.delete(`${backend.apiBase}/agent-profiles/${id}`, { headers: auth(backend) }).catch(() => {});
}

async function createTaskRaw(
  request: APIRequestContext,
  backend: E2EBackend,
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: {
      title: `api-task ${Math.random().toString(36).slice(2)}`,
      prompt: "Do the thing",
      workdir: tmpdir(),
      isolation: "none",
      ...overrides,
    },
  });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

async function createTask(
  request: APIRequestContext,
  backend: E2EBackend,
  overrides: Record<string, unknown> = {},
): Promise<TaskRow> {
  const { status, body } = await createTaskRaw(request, backend, overrides);
  expect(status, `POST /tasks -> ${status}: ${JSON.stringify(body)}`).toBe(200);
  const task = body as TaskRow;
  createdTaskIds.push(task.id);
  return task;
}

async function getTask(request: APIRequestContext, backend: E2EBackend, id: string): Promise<TaskRow | null> {
  const res = await request.get(`${backend.apiBase}/tasks/${id}`, { headers: auth(backend) });
  if (!res.ok()) return null;
  return (await res.json()) as TaskRow;
}

async function deleteTask(request: APIRequestContext, backend: E2EBackend, id: string): Promise<void> {
  await request.delete(`${backend.apiBase}/tasks/${id}`, { headers: auth(backend) }).catch(() => {});
}

async function startTask(
  request: APIRequestContext,
  backend: E2EBackend,
  id: string,
): Promise<{ runId?: string; error?: string }> {
  const res = await request.post(`${backend.apiBase}/tasks/${id}/start`, { headers: auth(backend) });
  return (await res.json()) as { runId?: string; error?: string };
}

async function waitForNotRunning(
  request: APIRequestContext,
  backend: E2EBackend,
  taskId: string,
): Promise<TaskRow> {
  let task: TaskRow | null = null;
  await expect(async () => {
    task = await getTask(request, backend, taskId);
    expect(task).not.toBeNull();
    expect(task!.column).not.toBe("running");
  }).toPass({ timeout: CONVERGE_TIMEOUT });
  return task!;
}

/** Reads `run_events.data` for the FIRST `stream='user'` row of `runId`
 *  directly out of this worker's SQLite file — the same technique
 *  `e2e/helpers.ts`'s `seedHarnessUsage` uses to reach state no HTTP route
 *  exposes without an SSE stream (the `/tasks/:id/events` route this data
 *  would otherwise come from never completes a plain fetch). `startTask`
 *  echoes the composed prompt (preamble + "Your task:" + the user's own
 *  text) as a `user` event unconditionally, regardless of agent driver — see
 *  `orchestrator.ts`'s `startTaskInner`, CLAUDE.md orchestration-flow item
 *  15 — and the column stores the RAW text (no JSON envelope), so this reads
 *  back exactly the string a transcript bubble would render. Opens and
 *  closes its own read-only-in-spirit handle per call, mirroring
 *  `seedHarnessUsage`'s own short-lived-handle rationale. */
function firstUserEventText(backend: E2EBackend, runId: string): string | null {
  const db = new Database(path.join(backend.dataDir, "agetor.sqlite"));
  try {
    const row = db
      .query<{ data: string }, [string]>(
        `SELECT data FROM run_events WHERE run_id = ? AND stream = 'user' ORDER BY id ASC LIMIT 1`,
      )
      .get(runId);
    return row?.data ?? null;
  } finally {
    db.close();
  }
}

test.describe("agent profiles — REST-only coverage", () => {
  // ── 1. POST /tasks with agentProfileId ──────────────────────────────────

  test("POST /tasks: agentProfileId null/unknown/override", async ({ request, backend }) => {
    const nullTask = await createTask(request, backend, { agentProfileId: null });
    expect(nullTask.agentProfileId).toBeNull();
    expect(nullTask.agentProfile).toBeNull();
    await deleteTask(request, backend, nullTask.id);

    const { status: unknownStatus, body: unknownBody } = await createTaskRaw(request, backend, {
      agentProfileId: "does-not-exist",
    });
    expect(unknownStatus).toBe(400);
    expect((unknownBody as { error: string }).error).toContain("unknown agent profile");

    const profile = await createProfile(request, backend, {
      name: `Override ${Math.random().toString(36).slice(2)}`,
      model: "opus-5",
      effort: "high",
      mode: "auto",
    });
    const overridden = await createTask(request, backend, {
      agentProfileId: profile.id,
      agent: "codex",
      model: "ignored",
      effort: "ignored",
      mode: "ignored",
    });
    expect(overridden.agentProfileId).toBe(profile.id);
    expect(overridden.agent).toBe("claude-code");
    expect(overridden.model).toBe("opus-5");
    expect(overridden.effort).toBe("high");
    expect(overridden.mode).toBe("auto");
    await deleteTask(request, backend, overridden.id);
    await deleteProfile(request, backend, profile.id);
  });

  // ── 2. PATCH /tasks/:id bound-agent guard + detach ──────────────────────

  test("PATCH /tasks/:id: bound task refuses a changed field (409), allows a same-value resend and unrelated fields, unlocks after detach", async ({
    request,
    backend,
  }) => {
    const profile = await createProfile(request, backend, { name: `Locked ${Math.random().toString(36).slice(2)}` });
    const task = await createTask(request, backend, { agentProfileId: profile.id });

    const changed = await request.patch(`${backend.apiBase}/tasks/${task.id}`, {
      headers: auth(backend),
      data: { model: "some-other-model" },
    });
    expect(changed.status()).toBe(409);
    expect(((await changed.json()) as { error: string }).error).toContain("bound to agent");

    const sameValue = await request.patch(`${backend.apiBase}/tasks/${task.id}`, {
      headers: auth(backend),
      data: { model: task.model },
    });
    expect(sameValue.status()).toBe(200);

    const unrelated = await request.patch(`${backend.apiBase}/tasks/${task.id}`, {
      headers: auth(backend),
      data: { title: "Renamed via PATCH" },
    });
    expect(unrelated.status()).toBe(200);
    expect(((await unrelated.json()) as TaskRow).title).toBe("Renamed via PATCH");

    const detachRes = await request.delete(`${backend.apiBase}/tasks/${task.id}/agent-profile`, {
      headers: auth(backend),
    });
    expect(detachRes.status()).toBe(200);
    expect(((await detachRes.json()) as TaskRow).agentProfileId).toBeNull();

    const afterDetach = await request.patch(`${backend.apiBase}/tasks/${task.id}`, {
      headers: auth(backend),
      data: { model: "some-other-model" },
    });
    expect(afterDetach.status()).toBe(200);
    expect(((await afterDetach.json()) as TaskRow).model).toBe("some-other-model");

    await deleteTask(request, backend, task.id);
    await deleteProfile(request, backend, profile.id);
  });

  // ── 3. Archived task detach 409, unarchive → detach 200 ────────────────

  test("DELETE /tasks/:id/agent-profile: 409 while archived, 200 after unarchive", async ({ request, backend }) => {
    const profile = await createProfile(request, backend, { name: `Archive ${Math.random().toString(36).slice(2)}` });
    const task = await createTask(request, backend, { agentProfileId: profile.id });

    const archiveRes = await request.post(`${backend.apiBase}/tasks/${task.id}/archive`, {
      headers: auth(backend),
      data: { force: true },
    });
    expect(archiveRes.ok(), `POST archive -> ${archiveRes.status()}`).toBeTruthy();

    const detachWhileArchived = await request.delete(`${backend.apiBase}/tasks/${task.id}/agent-profile`, {
      headers: auth(backend),
    });
    expect(detachWhileArchived.status()).toBe(409);

    const unarchiveRes = await request.post(`${backend.apiBase}/tasks/${task.id}/unarchive`, {
      headers: auth(backend),
    });
    expect(unarchiveRes.ok(), `POST unarchive -> ${unarchiveRes.status()}`).toBeTruthy();

    const detachAfterUnarchive = await request.delete(`${backend.apiBase}/tasks/${task.id}/agent-profile`, {
      headers: auth(backend),
    });
    expect(detachAfterUnarchive.status()).toBe(200);
    expect(((await detachAfterUnarchive.json()) as TaskRow).agentProfileId).toBeNull();

    await deleteTask(request, backend, task.id);
    await deleteProfile(request, backend, profile.id);
  });

  // ── 4. POST /agent-profiles validation + duplicate name + taskCount ────

  test("POST /agent-profiles: validation 400s, duplicate name 409 (POST + PATCH), taskCount 0→1→0", async ({
    request,
    backend,
  }) => {
    const missingName = await request.post(`${backend.apiBase}/agent-profiles`, {
      headers: auth(backend),
      data: { harness: "claude-code", model: "opus-5" },
    });
    expect(missingName.status()).toBe(400);

    const missingModel = await request.post(`${backend.apiBase}/agent-profiles`, {
      headers: auth(backend),
      data: { name: `NoModel ${Math.random().toString(36).slice(2)}`, harness: "claude-code" },
    });
    expect(missingModel.status()).toBe(400);

    const unknownHarness = await request.post(`${backend.apiBase}/agent-profiles`, {
      headers: auth(backend),
      data: { name: `BadHarness ${Math.random().toString(36).slice(2)}`, harness: "not-a-harness", model: "m" },
    });
    expect(unknownHarness.status()).toBe(400);
    expect(((await unknownHarness.json()) as { error: string }).error).toContain("unknown harness");

    const badSkillEntry = await request.post(`${backend.apiBase}/agent-profiles`, {
      headers: auth(backend),
      data: {
        name: `BadSkill ${Math.random().toString(36).slice(2)}`,
        harness: "claude-code",
        model: "m",
        skills: ["ok", 42],
      },
    });
    expect(badSkillEntry.status()).toBe(400);
    expect(((await badSkillEntry.json()) as { error: string }).error).toBe("skills must be an array of strings");

    const tooManySkills = Array.from({ length: 51 }, (_, i) => `skill-${i}`);
    const overCap = await request.post(`${backend.apiBase}/agent-profiles`, {
      headers: auth(backend),
      data: {
        name: `TooManySkills ${Math.random().toString(36).slice(2)}`,
        harness: "claude-code",
        model: "m",
        skills: tooManySkills,
      },
    });
    expect(overCap.status()).toBe(400);
    expect(((await overCap.json()) as { error: string }).error).toBe("at most 50 skills");

    const dupName = `Dup ${Math.random().toString(36).slice(2)}`;
    const first = await createProfile(request, backend, { name: dupName });
    const secondPost = await request.post(`${backend.apiBase}/agent-profiles`, {
      headers: auth(backend),
      data: { name: dupName, harness: "claude-code", model: "m" },
    });
    expect(secondPost.status()).toBe(409);

    const other = await createProfile(request, backend, { name: `Other ${Math.random().toString(36).slice(2)}` });
    const patchToDup = await request.patch(`${backend.apiBase}/agent-profiles/${other.id}`, {
      headers: auth(backend),
      data: { name: dupName },
    });
    expect(patchToDup.status()).toBe(409);

    // taskCount 0 -> 1 -> 0
    expect(first.taskCount).toBe(0);
    const boundTask = await createTask(request, backend, { agentProfileId: first.id });
    const afterBind = await request.get(`${backend.apiBase}/agent-profiles/${first.id}`, { headers: auth(backend) });
    expect(((await afterBind.json()) as AgentProfileRow).taskCount).toBe(1);
    await request.delete(`${backend.apiBase}/tasks/${boundTask.id}/agent-profile`, { headers: auth(backend) });
    const afterDetach = await request.get(`${backend.apiBase}/agent-profiles/${first.id}`, { headers: auth(backend) });
    expect(((await afterDetach.json()) as AgentProfileRow).taskCount).toBe(0);

    await deleteTask(request, backend, boundTask.id);
    await deleteProfile(request, backend, first.id);
    await deleteProfile(request, backend, other.id);
  });

  // ── 5. DELETE /harnesses/:id blocked by a referencing profile ──────────

  test("DELETE /harnesses/:id: 409 with profileIds while a profile references a non-builtin harness, 2xx after the profile is deleted", async ({
    request,
    backend,
  }) => {
    const harnessHome = await mkdtemp(path.join(tmpdir(), "agetor-e2e-agent-profiles-api-harness-"));
    const harnessId = `api-spec-harness-${Math.random().toString(36).slice(2)}`;
    const harnessRes = await request.post(`${backend.apiBase}/harnesses`, {
      headers: auth(backend),
      data: { id: harnessId, kind: "claude-code", label: "API Spec Harness", home: harnessHome },
    });
    expect(harnessRes.ok(), `POST /harnesses -> ${harnessRes.status()}`).toBeTruthy();
    createdHarnessIds.push(harnessId);

    const profile = await createProfile(request, backend, {
      name: `UsesCustomHarness ${Math.random().toString(36).slice(2)}`,
      harness: harnessId,
    });

    const blockedDelete = await request.delete(`${backend.apiBase}/harnesses/${harnessId}`, { headers: auth(backend) });
    expect(blockedDelete.status()).toBe(409);
    const blockedBody = (await blockedDelete.json()) as { profileIds: string[] };
    expect(blockedBody.profileIds).toEqual([profile.id]);

    await deleteProfile(request, backend, profile.id);

    const unblockedDelete = await request.delete(`${backend.apiBase}/harnesses/${harnessId}`, { headers: auth(backend) });
    expect(unblockedDelete.ok(), `DELETE /harnesses -> ${unblockedDelete.status()}`).toBeTruthy();
  });

  // ── 6. Freeze-at-first-run through startTask + a real fake-driver run ──

  test("freeze rule: a re-run of an already-run task keeps the OLD instructions; a task created after the edit gets the NEW ones", async ({
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    const OLD = "Old profile instructions — pre-edit.";
    const NEW = "New profile instructions — post-edit.";
    const profile = await createProfile(request, backend, {
      name: `Freeze ${Math.random().toString(36).slice(2)}`,
      instructions: OLD,
    });

    // Task A: created and started BEFORE the edit.
    const taskA = await createTask(request, backend, { agentProfileId: profile.id });
    const startA1 = await startTask(request, backend, taskA.id);
    expect(startA1.runId, `start #1 -> ${JSON.stringify(startA1)}`).toBeTruthy();
    await waitForNotRunning(request, backend, taskA.id);
    const firstRunText = firstUserEventText(backend, startA1.runId!);
    expect(firstRunText).toContain(OLD);

    // Edit the LIVE profile's instructions.
    const patchRes = await request.patch(`${backend.apiBase}/agent-profiles/${profile.id}`, {
      headers: auth(backend),
      data: { instructions: NEW },
    });
    expect(patchRes.ok(), `PATCH /agent-profiles -> ${patchRes.status()}`).toBeTruthy();

    // Re-run task A — already has a run row, so `effectiveAgentProfile`
    // must use its FROZEN snapshot, not the just-edited live profile.
    const startA2 = await startTask(request, backend, taskA.id);
    expect(startA2.runId, `start #2 -> ${JSON.stringify(startA2)}`).toBeTruthy();
    await waitForNotRunning(request, backend, taskA.id);
    const secondRunText = firstUserEventText(backend, startA2.runId!);
    expect(secondRunText).toContain(OLD);
    expect(secondRunText).not.toContain(NEW);

    const taskAAfter = await getTask(request, backend, taskA.id);
    expect(taskAAfter?.agentProfile?.instructions).toBe(OLD);

    // Task B: created AFTER the edit — its first run must pick up the live
    // (edited) profile.
    const taskB = await createTask(request, backend, { agentProfileId: profile.id });
    const startB = await startTask(request, backend, taskB.id);
    expect(startB.runId, `start B -> ${JSON.stringify(startB)}`).toBeTruthy();
    await waitForNotRunning(request, backend, taskB.id);
    const bRunText = firstUserEventText(backend, startB.runId!);
    expect(bRunText).toContain(NEW);
    expect(bRunText).not.toContain(OLD);

    await deleteTask(request, backend, taskA.id);
    await deleteTask(request, backend, taskB.id);
    await deleteProfile(request, backend, profile.id);
  });

  // ── 7. Snapshot survives a harness relabel ──────────────────────────────

  test("a task's frozen snapshot keeps the harness label it captured at first run, even after the harness is later relabelled", async ({
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    const harnessHome = await mkdtemp(path.join(tmpdir(), "agetor-e2e-agent-profiles-api-relabel-"));
    const harnessId = `api-spec-relabel-harness-${Math.random().toString(36).slice(2)}`;
    const ORIGINAL_LABEL = "Original Harness Label";
    const harnessRes = await request.post(`${backend.apiBase}/harnesses`, {
      headers: auth(backend),
      data: { id: harnessId, kind: "claude-code", label: ORIGINAL_LABEL, home: harnessHome },
    });
    expect(harnessRes.ok(), `POST /harnesses -> ${harnessRes.status()}`).toBeTruthy();
    createdHarnessIds.push(harnessId);

    const profile = await createProfile(request, backend, {
      name: `Relabel ${Math.random().toString(36).slice(2)}`,
      harness: harnessId,
    });
    const task = await createTask(request, backend, { agentProfileId: profile.id });
    const start = await startTask(request, backend, task.id);
    expect(start.runId, `start -> ${JSON.stringify(start)}`).toBeTruthy();
    await waitForNotRunning(request, backend, task.id);

    const beforeRelabel = await getTask(request, backend, task.id);
    expect(beforeRelabel?.agentProfile?.harnessLabel).toBe(ORIGINAL_LABEL);

    const relabelRes = await request.patch(`${backend.apiBase}/harnesses/${harnessId}`, {
      headers: auth(backend),
      data: { label: "Renamed Harness Label" },
    });
    expect(relabelRes.ok(), `PATCH /harnesses -> ${relabelRes.status()}`).toBeTruthy();

    const afterRelabel = await getTask(request, backend, task.id);
    expect(afterRelabel?.agentProfile?.harnessLabel).toBe(ORIGINAL_LABEL);
    expect(afterRelabel?.agentProfile?.harnessLabel).not.toBe("Renamed Harness Label");

    await deleteTask(request, backend, task.id);
    await deleteProfile(request, backend, profile.id);
    await request.delete(`${backend.apiBase}/harnesses/${harnessId}`, { headers: auth(backend) }).catch(() => {});
  });
});

test.afterAll(async ({ backend }) => {
  // Belt-and-suspenders cleanup for anything a failed assertion left
  // dangling mid-test (every test above already deletes its own rows on
  // the happy path, but a thrown expect() skips those calls). Uses raw
  // `fetch` rather than the `request` fixture (test-scoped, not safely
  // available in `afterAll`), mirroring the other agent-profiles e2e
  // files' own afterAll hooks. Order matters: tasks before profiles (a
  // task can reference a profile) and profiles before harnesses (a
  // profile still pointing at a harness blocks that harness's delete).
  // Never blocks teardown.
  const headers = { ...auth(backend), "content-type": "application/json" };
  for (const id of createdTaskIds.splice(0)) {
    await fetch(`${backend.apiBase}/tasks/${id}`, { method: "DELETE", headers }).catch(() => {});
  }
  for (const id of createdProfileIds.splice(0)) {
    await fetch(`${backend.apiBase}/agent-profiles/${id}`, { method: "DELETE", headers }).catch(() => {});
  }
  for (const id of createdHarnessIds.splice(0)) {
    await fetch(`${backend.apiBase}/harnesses/${id}`, { method: "DELETE", headers }).catch(() => {});
  }
});

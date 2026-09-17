// DB-level tests for reusable agent profiles (docs/plans/agent-profiles.md
// §3/§5 TT2): the `agentProfiles` CRUD module, the task-side snapshot columns
// (`agent_profile_id`/`agent_profile`, migration 053) round-tripping through
// `tasks.insert`/`tasks.update`/`tasks.setAgentProfile`, `runs.countForTask`
// (the "has this task ever run" signal `effectiveAgentProfile` uses), and
// `harnesses.delete`'s extended `HarnessInUseError.profileIds` guard.
// Mirrors db-sent-files.test.ts's structure: AGETOR_DATA_DIR is set at
// module scope BEFORE `./db.ts` is dynamically imported in `beforeAll` (the
// db opens — and migrates — on module load), and `rmTestDataDir` (never a
// bare `rmSync`) tears the dir down afterward.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentProfileSnapshot, Task } from "../shared/types.ts";
import { AGENT_PROFILE_LIMITS } from "../shared/agent-profile.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-agent-profiles-"));
process.env.AGETOR_DATA_DIR = dataDir;

let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;
let harnesses: typeof import("./db.ts").harnesses;
let agentProfiles: typeof import("./db.ts").agentProfiles;
let AgentProfileNameError: typeof import("./db.ts").AgentProfileNameError;
let HarnessInUseError: typeof import("./db.ts").HarnessInUseError;

beforeAll(async () => {
  ({ db, tasks, runs, harnesses, agentProfiles, AgentProfileNameError, HarnessInUseError } = await import("./db.ts"));
});

afterAll(() => {
  rmTestDataDir(dataDir);
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTaskRow(taskId: string, overrides: Partial<Task> = {}): Task {
  return {
    id: taskId,
    title: "t",
    prompt: "p",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    fast: false,
    maxMode: false,
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    column: "ready",
    runId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    ...overrides,
  };
}

function makeRun(taskId: string, overrides: Partial<Parameters<typeof runs.insert>[0]> = {}): string {
  const runId = overrides.id ?? randomUUID();
  runs.insert({
    id: runId,
    taskId,
    agent: "claude-code",
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    tmuxSession: "agetor-test-agent-profiles",
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    ...overrides,
  });
  return runId;
}

function makeSnapshot(overrides: Partial<AgentProfileSnapshot> = {}): AgentProfileSnapshot {
  return {
    id: randomUUID(),
    name: "My Agent",
    harness: "claude-code",
    harnessKind: "claude-code",
    harnessLabel: "Claude Code",
    model: "claude-opus-4-7",
    effort: "high",
    mode: "auto",
    fast: false,
    maxMode: false,
    instructions: "Be terse.",
    skills: ["foo", "bar"],
    capturedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

test("migrations 052_agent_profiles and 053_task_agent_profile are recorded in _migrations", () => {
  const rows = db
    .query<{ id: string }, []>(`SELECT id FROM _migrations WHERE id IN ('052_agent_profiles', '053_task_agent_profile')`)
    .all();
  expect(rows.map((r) => r.id).sort()).toEqual(["052_agent_profiles", "053_task_agent_profile"]);
});

// ---------------------------------------------------------------------------
// agentProfiles.insert
// ---------------------------------------------------------------------------

test("insert returns the full object with a UUID id and equal created/updated timestamps", () => {
  const created = agentProfiles.insert({ name: "Greeter", harness: "claude-code", model: "claude-opus-4-7" });
  expect(created.id).toMatch(UUID_RE);
  expect(created.name).toBe("Greeter");
  expect(created.harness).toBe("claude-code");
  expect(created.model).toBe("claude-opus-4-7");
  expect(created.effort).toBeNull();
  expect(created.mode).toBeNull();
  expect(created.fast).toBe(false);
  expect(created.maxMode).toBe(false);
  expect(created.instructions).toBe("");
  expect(created.skills).toEqual([]);
  expect(created.createdAt).toBe(created.updatedAt);
  expect(typeof created.createdAt).toBe("number");
});

test("list orders by name_key ASC (case-insensitive)", () => {
  const zeta = agentProfiles.insert({ name: "Zeta", harness: "claude-code", model: "m" });
  const alpha = agentProfiles.insert({ name: "alpha", harness: "claude-code", model: "m" });
  const beta = agentProfiles.insert({ name: "Beta", harness: "claude-code", model: "m" });
  try {
    const names = agentProfiles.list().map((p) => p.id);
    const idxAlpha = names.indexOf(alpha.id);
    const idxBeta = names.indexOf(beta.id);
    const idxZeta = names.indexOf(zeta.id);
    expect(idxAlpha).toBeLessThan(idxBeta);
    expect(idxBeta).toBeLessThan(idxZeta);
  } finally {
    agentProfiles.delete(zeta.id);
    agentProfiles.delete(alpha.id);
    agentProfiles.delete(beta.id);
  }
});

test("get on a missing id returns null", () => {
  expect(agentProfiles.get("does-not-exist")).toBeNull();
});

test("findByName is case/whitespace-insensitive", () => {
  const created = agentProfiles.insert({ name: "  Research Bot  ", harness: "claude-code", model: "m" });
  try {
    expect(created.name).toBe("Research Bot"); // stored trimmed
    expect(agentProfiles.findByName("research bot")?.id).toBe(created.id);
    expect(agentProfiles.findByName("  RESEARCH BOT  ")?.id).toBe(created.id);
    expect(agentProfiles.findByName("Research  Bot")).toBeNull(); // internal spacing must match exactly
    expect(agentProfiles.findByName("nope")).toBeNull();
  } finally {
    agentProfiles.delete(created.id);
  }
});

test("insert with a duplicate name (exact) throws AgentProfileNameError", () => {
  const first = agentProfiles.insert({ name: "Dup", harness: "claude-code", model: "m" });
  try {
    expect(() => agentProfiles.insert({ name: "Dup", harness: "claude-code", model: "m" })).toThrow(AgentProfileNameError);
  } finally {
    agentProfiles.delete(first.id);
  }
});

test("insert with a duplicate name differing only in case/whitespace throws AgentProfileNameError (the UNIQUE(name_key) path)", () => {
  const first = agentProfiles.insert({ name: "Case Test", harness: "claude-code", model: "m" });
  try {
    expect(() => agentProfiles.insert({ name: "  CASE TEST  ", harness: "claude-code", model: "m" })).toThrow(AgentProfileNameError);
    // Confirm nothing was inserted — still exactly one row for this name_key.
    expect(agentProfiles.list().filter((p) => p.name === "Case Test").length).toBe(1);
  } finally {
    agentProfiles.delete(first.id);
  }
});

test("skills are normalized (leading '/' stripped, whitespace collapsed), deduped, and capped at AGENT_PROFILE_LIMITS.skills", () => {
  const created = agentProfiles.insert({
    name: "Skilled",
    harness: "claude-code",
    model: "m",
    skills: ["/foo", "foo", "  foo  ", "bar", "/bar", "", "   ", "/"],
  });
  try {
    expect(created.skills).toEqual(["foo", "bar"]);
  } finally {
    agentProfiles.delete(created.id);
  }

  const many = Array.from({ length: AGENT_PROFILE_LIMITS.skills + 10 }, (_, i) => `skill-${i}`);
  const capped = agentProfiles.insert({ name: "Capped", harness: "claude-code", model: "m", skills: many });
  try {
    expect(capped.skills.length).toBe(AGENT_PROFILE_LIMITS.skills);
    expect(capped.skills).toEqual(many.slice(0, AGENT_PROFILE_LIMITS.skills));
  } finally {
    agentProfiles.delete(capped.id);
  }
});

test("instructions over AGENT_PROFILE_LIMITS.instructions is rejected with a plain Error (not AgentProfileNameError)", () => {
  const tooLong = "a".repeat(AGENT_PROFILE_LIMITS.instructions + 1);
  let caught: unknown;
  try {
    agentProfiles.insert({ name: "TooLong", harness: "claude-code", model: "m", instructions: tooLong });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(AgentProfileNameError);
  expect((caught as Error).message).toContain("instructions");
  // Nothing was inserted.
  expect(agentProfiles.findByName("TooLong")).toBeNull();
});

// ---------------------------------------------------------------------------
// agentProfiles.update
// ---------------------------------------------------------------------------

test("update patches only the provided fields, maintains name_key, and bumps updated_at", async () => {
  const created = agentProfiles.insert({ name: "Original", harness: "claude-code", model: "m1" });
  await new Promise((r) => setTimeout(r, 5));

  const renamed = agentProfiles.update(created.id, { name: "Renamed" });
  expect(renamed).not.toBeNull();
  expect(renamed!.name).toBe("Renamed");
  expect(renamed!.model).toBe("m1"); // untouched
  expect(renamed!.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
  expect(renamed!.createdAt).toBe(created.createdAt);
  // name_key follows the rename: old name no longer resolves, new one does.
  expect(agentProfiles.findByName("Original")).toBeNull();
  expect(agentProfiles.findByName("renamed")?.id).toBe(created.id);

  await new Promise((r) => setTimeout(r, 5));
  const remodeled = agentProfiles.update(created.id, { model: "m2" });
  expect(remodeled!.name).toBe("Renamed"); // untouched from previous patch
  expect(remodeled!.model).toBe("m2");
  expect(remodeled!.updatedAt).toBeGreaterThanOrEqual(renamed!.updatedAt);

  agentProfiles.delete(created.id);
});

test("update on a missing id returns null", () => {
  expect(agentProfiles.update("does-not-exist", { name: "x" })).toBeNull();
});

test("update to a name colliding (case-insensitively) with another profile throws AgentProfileNameError and leaves the row untouched", () => {
  const a = agentProfiles.insert({ name: "Alpha", harness: "claude-code", model: "m" });
  const b = agentProfiles.insert({ name: "Beta", harness: "claude-code", model: "m" });
  try {
    expect(() => agentProfiles.update(b.id, { name: "  ALPHA  " })).toThrow(AgentProfileNameError);
    // b is untouched.
    expect(agentProfiles.get(b.id)?.name).toBe("Beta");
  } finally {
    agentProfiles.delete(a.id);
    agentProfiles.delete(b.id);
  }
});

test("update with instructions over the limit throws a plain Error and leaves the row untouched", () => {
  const created = agentProfiles.insert({ name: "InstrEdit", harness: "claude-code", model: "m", instructions: "ok" });
  try {
    const tooLong = "a".repeat(AGENT_PROFILE_LIMITS.instructions + 1);
    let caught: unknown;
    try {
      agentProfiles.update(created.id, { instructions: tooLong });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(AgentProfileNameError);
    expect(agentProfiles.get(created.id)?.instructions).toBe("ok");
  } finally {
    agentProfiles.delete(created.id);
  }
});

test("update normalizes/dedupes/caps skills the same way insert does", () => {
  const created = agentProfiles.insert({ name: "SkillEdit", harness: "claude-code", model: "m" });
  try {
    const updated = agentProfiles.update(created.id, { skills: ["/x", "x", "  x  ", "y"] });
    expect(updated!.skills).toEqual(["x", "y"]);
  } finally {
    agentProfiles.delete(created.id);
  }
});

// ---------------------------------------------------------------------------
// agentProfiles.delete
// ---------------------------------------------------------------------------

test("delete returns true then false, and get returns null afterward", () => {
  const created = agentProfiles.insert({ name: "Temp", harness: "claude-code", model: "m" });
  expect(agentProfiles.delete(created.id)).toBe(true);
  expect(agentProfiles.get(created.id)).toBeNull();
  expect(agentProfiles.delete(created.id)).toBe(false);
  expect(agentProfiles.delete("never-existed")).toBe(false);
});

// ---------------------------------------------------------------------------
// tasks.insert / tasks.get round-trip through the snapshot columns
// ---------------------------------------------------------------------------

test("tasks.insert with agentProfileId/agentProfile round-trips through toTask", () => {
  const taskId = randomUUID();
  const snapshot = makeSnapshot({ id: "profile-abc", name: "Bound Agent" });
  tasks.insert(makeTaskRow(taskId, { agentProfileId: "profile-abc", agentProfile: snapshot }));
  try {
    const fetched = tasks.get(taskId);
    expect(fetched?.agentProfileId).toBe("profile-abc");
    expect(fetched?.agentProfile).toEqual(snapshot);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("a fresh task (no profile) has agentProfileId/agentProfile === null", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    const fetched = tasks.get(taskId);
    expect(fetched?.agentProfileId).toBeNull();
    expect(fetched?.agentProfile).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("malformed agent_profile JSON on the row sanitizes to null (agentProfileId is untouched)", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId, { agentProfileId: "profile-xyz", agentProfile: makeSnapshot({ id: "profile-xyz" }) }));
  try {
    db.run(`UPDATE tasks SET agent_profile = ? WHERE id = ?`, ["not json at all {{{", taskId]);
    const fetched = tasks.get(taskId);
    expect(fetched?.agentProfile).toBeNull();
    expect(fetched?.agentProfileId).toBe("profile-xyz"); // raw column, unaffected by snapshot sanitization

    // Valid JSON, but missing a required field (harnessKind) — also collapses to null.
    db.run(`UPDATE tasks SET agent_profile = ? WHERE id = ?`, [JSON.stringify({ id: "x", name: "y" }), taskId]);
    expect(tasks.get(taskId)?.agentProfile).toBeNull();

    // A known-bad harnessKind also collapses to null (defends downstream AgentIcon/defaultModeFor lookups).
    db.run(
      `UPDATE tasks SET agent_profile = ? WHERE id = ?`,
      [JSON.stringify({ ...makeSnapshot({ id: "profile-xyz" }), harnessKind: "not-a-real-kind" }), taskId],
    );
    expect(tasks.get(taskId)?.agentProfile).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// Review fix F1 finding 4: a cosmetic field (`harnessLabel`) must not be
// load-bearing — a missing/empty/non-string value falls back to the
// (already-validated) `harness` id instead of nulling the whole snapshot.
test("agent_profile with a missing/empty harnessLabel falls back to the harness id instead of nulling the snapshot", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    const { harnessLabel: _omit, ...withoutLabel } = makeSnapshot({ id: "profile-no-label", harness: "claude-code" });
    db.run(
      `UPDATE tasks SET agent_profile = ?, agent_profile_id = ? WHERE id = ?`,
      [JSON.stringify(withoutLabel), "profile-no-label", taskId],
    );
    expect(tasks.get(taskId)?.agentProfile?.harnessLabel).toBe("claude-code");

    const emptyLabel = makeSnapshot({ id: "profile-empty-label", harness: "codex", harnessLabel: "" });
    db.run(
      `UPDATE tasks SET agent_profile = ?, agent_profile_id = ? WHERE id = ?`,
      [JSON.stringify(emptyLabel), "profile-empty-label", taskId],
    );
    expect(tasks.get(taskId)?.agentProfile?.harnessLabel).toBe("codex");

    const numericLabel = { ...makeSnapshot({ id: "profile-numeric-label", harness: "cursor" }), harnessLabel: 42 };
    db.run(
      `UPDATE tasks SET agent_profile = ?, agent_profile_id = ? WHERE id = ?`,
      [JSON.stringify(numericLabel), "profile-numeric-label", taskId],
    );
    expect(tasks.get(taskId)?.agentProfile?.harnessLabel).toBe("cursor");

    // A real label still wins — the fallback only kicks in when it's absent.
    const realLabel = makeSnapshot({ id: "profile-real-label", harness: "gemini", harnessLabel: "Gemini CLI" });
    db.run(
      `UPDATE tasks SET agent_profile = ?, agent_profile_id = ? WHERE id = ?`,
      [JSON.stringify(realLabel), "profile-real-label", taskId],
    );
    expect(tasks.get(taskId)?.agentProfile?.harnessLabel).toBe("Gemini CLI");
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// Review fix F1 finding 4: `AGENT_KINDS` (the set `harnessKind` is validated
// against) must be derived from `AGENT_OPTIONS`'s own keys rather than a
// separately hand-maintained list, so a sixth agent kind can't silently null
// every existing snapshot the next time one is added. This proves every
// current `AgentKind`/`AGENT_OPTIONS` key round-trips through the parser.
test("agent_profile harnessKind accepts every AGENT_OPTIONS key (AGENT_KINDS is derived, not hardcoded)", async () => {
  const { AGENT_OPTIONS } = await import("../shared/types.ts");
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    for (const kind of Object.keys(AGENT_OPTIONS) as AgentProfileSnapshot["harnessKind"][]) {
      const snapshot = makeSnapshot({ id: `profile-${kind}`, harness: kind, harnessKind: kind });
      db.run(
        `UPDATE tasks SET agent_profile = ?, agent_profile_id = ? WHERE id = ?`,
        [JSON.stringify(snapshot), snapshot.id, taskId],
      );
      expect(tasks.get(taskId)?.agentProfile?.harnessKind).toBe(kind);
    }
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// tasks.update SET clause skips the snapshot columns
// ---------------------------------------------------------------------------

test("tasks.update({title}) leaves agentProfileId/agentProfile untouched", () => {
  const taskId = randomUUID();
  const snapshot = makeSnapshot({ id: "profile-keep", name: "Keep Me" });
  tasks.insert(makeTaskRow(taskId, { agentProfileId: "profile-keep", agentProfile: snapshot }));
  try {
    const updated = tasks.update(taskId, { title: "renamed" });
    expect(updated?.title).toBe("renamed");
    expect(updated?.agentProfileId).toBe("profile-keep");
    expect(updated?.agentProfile).toEqual(snapshot);
    expect(tasks.get(taskId)?.agentProfileId).toBe("profile-keep");
    expect(tasks.get(taskId)?.agentProfile).toEqual(snapshot);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// tasks.setAgentProfile
// ---------------------------------------------------------------------------

test("tasks.setAgentProfile binds a profile via a targeted UPDATE without bumping updated_at", async () => {
  const taskId = randomUUID();
  const inserted = tasks.insert(makeTaskRow(taskId));
  const originalUpdatedAt = inserted.updatedAt;
  try {
    await new Promise((r) => setTimeout(r, 5));
    const snapshot = makeSnapshot({ id: "profile-set", name: "Freshly Bound" });
    const updated = tasks.setAgentProfile(taskId, "profile-set", snapshot);
    expect(updated?.agentProfileId).toBe("profile-set");
    expect(updated?.agentProfile).toEqual(snapshot);
    expect(updated?.updatedAt).toBe(originalUpdatedAt);
    expect(tasks.get(taskId)?.updatedAt).toBe(originalUpdatedAt);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("tasks.setAgentProfile(id, null, null) clears both columns and does NOT change updatedAt", async () => {
  const taskId = randomUUID();
  const snapshot = makeSnapshot({ id: "profile-clear", name: "Clear Me" });
  const inserted = tasks.insert(makeTaskRow(taskId, { agentProfileId: "profile-clear", agentProfile: snapshot }));
  const originalUpdatedAt = inserted.updatedAt;
  try {
    await new Promise((r) => setTimeout(r, 5));
    const cleared = tasks.setAgentProfile(taskId, null, null);
    expect(cleared?.agentProfileId).toBeNull();
    expect(cleared?.agentProfile).toBeNull();
    expect(cleared?.updatedAt).toBe(originalUpdatedAt);
    expect(tasks.get(taskId)?.agentProfileId).toBeNull();
    expect(tasks.get(taskId)?.agentProfile).toBeNull();
    expect(tasks.get(taskId)?.updatedAt).toBe(originalUpdatedAt);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("tasks.setAgentProfile on a missing task id is a no-op (matches zero rows) and returns null", () => {
  expect(tasks.setAgentProfile("does-not-exist", "profile-x", makeSnapshot())).toBeNull();
});

// ---------------------------------------------------------------------------
// runs.countForTask
// ---------------------------------------------------------------------------

test("runs.countForTask is 0 for a fresh task and counts runs across every status", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    expect(runs.countForTask(taskId)).toBe(0);

    makeRun(taskId, { status: "running" });
    expect(runs.countForTask(taskId)).toBe(1);

    makeRun(taskId, { status: "succeeded" });
    expect(runs.countForTask(taskId)).toBe(2);

    makeRun(taskId, { status: "failed" });
    makeRun(taskId, { status: "cancelled" });
    makeRun(taskId, { status: "orphaned" });
    expect(runs.countForTask(taskId)).toBe(5);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("runs.countForTask for an unknown task id is 0", () => {
  expect(runs.countForTask("does-not-exist")).toBe(0);
});

// ---------------------------------------------------------------------------
// harnesses.delete extended guard: blocked by an agent profile referencing it
// ---------------------------------------------------------------------------

test("harnesses.delete throws HarnessInUseError with profileIds when a non-builtin harness is referenced only by a profile, and message mentions 'agent(s)'", () => {
  const harnessId = `custom-harness-${randomUUID().slice(0, 8)}`;
  harnesses.insert({ id: harnessId, kind: "claude-code", label: "Custom Harness" });
  const profile = agentProfiles.insert({ name: `Uses ${harnessId}`, harness: harnessId, model: "m" });
  try {
    let caught: unknown;
    try {
      harnesses.delete(harnessId);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessInUseError);
    const err = caught as InstanceType<typeof HarnessInUseError>;
    expect(err.taskIds).toEqual([]);
    expect(err.profileIds).toEqual([profile.id]);
    expect(err.message).toContain("agent(s)");
    // The harness must still exist — the delete never happened.
    expect(harnesses.get(harnessId)).not.toBeNull();
  } finally {
    agentProfiles.delete(profile.id);
    // Harness should be deletable now that nothing references it — cleanup
    // doubles as the "succeeds after the profile is deleted" assertion.
    expect(() => harnesses.delete(harnessId)).not.toThrow();
    expect(harnesses.get(harnessId)).toBeNull();
  }
});

test("harnesses.delete succeeds once the referencing profile is deleted", () => {
  const harnessId = `custom-harness-${randomUUID().slice(0, 8)}`;
  harnesses.insert({ id: harnessId, kind: "codex", label: "Another Custom Harness" });
  const profile = agentProfiles.insert({ name: `Also uses ${harnessId}`, harness: harnessId, model: "m" });

  expect(() => harnesses.delete(harnessId)).toThrow(HarnessInUseError);

  agentProfiles.delete(profile.id);
  expect(() => harnesses.delete(harnessId)).not.toThrow();
  expect(harnesses.get(harnessId)).toBeNull();
});

// ---------------------------------------------------------------------------
// agentProfiles.taskCounts / taskCount ("used by N tasks" follow-up,
// docs/plans/agent-profiles.md)
// ---------------------------------------------------------------------------

test("taskCount/taskCounts: 0 for a fresh profile with no bound tasks", () => {
  const profile = agentProfiles.insert({ name: `Fresh ${randomUUID().slice(0, 8)}`, harness: "claude-code", model: "m" });
  try {
    expect(agentProfiles.taskCount(profile.id)).toBe(0);
    expect(agentProfiles.taskCounts().get(profile.id)).toBeUndefined();
  } finally {
    agentProfiles.delete(profile.id);
  }
});

test("taskCount/taskCounts: counts across two profiles with 0/1/3 bound tasks", () => {
  const zero = agentProfiles.insert({ name: `Zero ${randomUUID().slice(0, 8)}`, harness: "claude-code", model: "m" });
  const one = agentProfiles.insert({ name: `One ${randomUUID().slice(0, 8)}`, harness: "claude-code", model: "m" });
  const three = agentProfiles.insert({ name: `Three ${randomUUID().slice(0, 8)}`, harness: "claude-code", model: "m" });
  const snapshot = makeSnapshot({ id: three.id });
  const taskIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  try {
    tasks.insert(makeTaskRow(taskIds[0]!, { agentProfileId: one.id, agentProfile: makeSnapshot({ id: one.id }) }));
    tasks.insert(makeTaskRow(taskIds[1]!, { agentProfileId: three.id, agentProfile: snapshot }));
    tasks.insert(makeTaskRow(taskIds[2]!, { agentProfileId: three.id, agentProfile: snapshot }));
    tasks.insert(makeTaskRow(taskIds[3]!, { agentProfileId: three.id, agentProfile: snapshot }));

    expect(agentProfiles.taskCount(zero.id)).toBe(0);
    expect(agentProfiles.taskCount(one.id)).toBe(1);
    expect(agentProfiles.taskCount(three.id)).toBe(3);

    const counts = agentProfiles.taskCounts();
    expect(counts.get(zero.id)).toBeUndefined();
    expect(counts.get(one.id)).toBe(1);
    expect(counts.get(three.id)).toBe(3);
  } finally {
    for (const id of taskIds) db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
    agentProfiles.delete(zero.id);
    agentProfiles.delete(one.id);
    agentProfiles.delete(three.id);
  }
});

test("taskCount: detaching via tasks.setAgentProfile(id, null, null) lowers the count", () => {
  const profile = agentProfiles.insert({ name: `Detach ${randomUUID().slice(0, 8)}`, harness: "claude-code", model: "m" });
  const taskId = randomUUID();
  try {
    tasks.insert(makeTaskRow(taskId, { agentProfileId: profile.id, agentProfile: makeSnapshot({ id: profile.id }) }));
    expect(agentProfiles.taskCount(profile.id)).toBe(1);

    tasks.setAgentProfile(taskId, null, null);
    expect(agentProfiles.taskCount(profile.id)).toBe(0);
    // The task keeps no frozen snapshot after detach — it is not counted.
    expect(tasks.get(taskId)?.agentProfile).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
    agentProfiles.delete(profile.id);
  }
});

test("taskCount: deleting the bound task lowers the count", () => {
  const profile = agentProfiles.insert({ name: `TaskDelete ${randomUUID().slice(0, 8)}`, harness: "claude-code", model: "m" });
  const taskId = randomUUID();
  try {
    tasks.insert(makeTaskRow(taskId, { agentProfileId: profile.id, agentProfile: makeSnapshot({ id: profile.id }) }));
    expect(agentProfiles.taskCount(profile.id)).toBe(1);

    tasks.delete(taskId);
    expect(agentProfiles.taskCount(profile.id)).toBe(0);
  } finally {
    agentProfiles.delete(profile.id);
  }
});

test("taskCount: an archived task is still counted (the definition is column-agnostic)", () => {
  const profile = agentProfiles.insert({ name: `Archived ${randomUUID().slice(0, 8)}`, harness: "claude-code", model: "m" });
  const taskId = randomUUID();
  try {
    tasks.insert(
      makeTaskRow(taskId, {
        agentProfileId: profile.id,
        agentProfile: makeSnapshot({ id: profile.id }),
        archivedAt: Date.now(),
      }),
    );
    expect(agentProfiles.taskCount(profile.id)).toBe(1);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
    agentProfiles.delete(profile.id);
  }
});

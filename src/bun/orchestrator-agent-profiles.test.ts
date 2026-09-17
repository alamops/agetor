import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Unique-enough profile names so parallel/rapid inserts within this file
// never collide on agent_profiles' unique name constraint.
function uniqueProfileName(label: string): string {
  return `profile-${label}-${randomUUID()}`;
}

// Top-level: db.ts captures AGETOR_DATA_DIR at first import — beforeAll would
// race with any sibling test file that already imported db.ts (CLAUDE.md
// "Persistence" test rules).
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-agent-profiles-orch-"));

// Drive claude/codex/gemini through in-process fakes instead of tmux + a real
// CLI, mirroring orchestrator.test.ts / orchestrator-codex.test.ts /
// orchestrator-fx.test.ts's own setup for these three kinds.
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo"; // tmux probe in agent-status passes

process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";

// gemini's fake spawn branch still calls the real buildCommand(...) before
// constructing the fake agent, so a genuinely oversized prompt hits a real,
// deterministic synchronous throw (GEMINI_PROMPT_ARGV_MAX_BYTES) without
// touching any real CLI — see orchestrator-fx.test.ts's "spawn-throw
// hardening (gemini)" test, which this file's TT6 mirrors.
process.env.AGETOR_GEMINI_DRIVER = "fake";
process.env.AGETOR_GEMINI_BIN = "/bin/echo";

beforeAll(async () => {
  await import("./db.ts");
});

async function settle(ms = 200) {
  await new Promise((r) => setTimeout(r, ms));
}

test("createTask({agentProfileId}) copies harness/model/effort/mode/fast/maxMode from the profile (body values ignored) and stores the snapshot; unknown id -> {error}", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const { db, agentProfiles, harnesses } = await import("./db.ts");
  const claudeHarness = harnesses.getByIdOrKind("claude-code");
  if (!claudeHarness) throw new Error("expected built-in claude-code harness to resolve");

  const profile = agentProfiles.insert({
    name: uniqueProfileName("create"),
    harness: "claude-code",
    model: "profile-model-x",
    effort: "high",
    mode: "auto",
    fast: true,
    maxMode: false,
    instructions: "Always write tests first.",
    skills: ["code-review", "simplify"],
  });

  try {
    const created = await createTask({
      title: "bound to a profile",
      prompt: "do the thing",
      // Every one of these six body fields conflicts with the profile and
      // must be ignored in favor of the profile's own values.
      agent: "codex",
      model: "body-model-should-be-ignored",
      effort: "low",
      mode: "manual",
      fast: false,
      maxMode: true,
      workdir: process.cwd(),
      isolation: "none",
      agentProfileId: profile.id,
    });
    if ("error" in created) throw new Error(created.error);
    const task = created.task;

    expect(task.agent).toBe("claude-code");
    expect(task.model).toBe("profile-model-x");
    expect(task.effort).toBe("high");
    expect(task.mode).toBe("auto");
    expect(task.fast).toBe(true);
    expect(task.maxMode).toBe(false);

    expect(task.agentProfileId).toBe(profile.id);
    expect(task.agentProfile).not.toBeNull();
    expect(task.agentProfile?.id).toBe(profile.id);
    expect(task.agentProfile?.harness).toBe("claude-code");
    expect(task.agentProfile?.harnessKind).toBe("claude-code");
    expect(task.agentProfile?.harnessLabel).toBe(claudeHarness.label);
    expect(task.agentProfile?.model).toBe("profile-model-x");
    expect(task.agentProfile?.instructions).toBe("Always write tests first.");
    expect(task.agentProfile?.skills).toEqual(["code-review", "simplify"]);

    db.run(`DELETE FROM tasks WHERE id = ?`, [task.id]);
  } finally {
    agentProfiles.delete(profile.id);
  }

  const badCreate = await createTask({
    title: "unknown profile id",
    prompt: "noop",
    workdir: process.cwd(),
    isolation: "none",
    agentProfileId: "not-a-real-profile-id",
  });
  expect("error" in badCreate).toBe(true);
  if ("error" in badCreate) {
    expect(badCreate.error).toMatch(/unknown agent profile/i);
  }
});

// Review fix F1 finding 2: a profile's own `effort: null` means "no opinion"
// (D3/A5 passthrough), but a model that requires an effort flag must still
// get a real default — both at `createTask` time AND at `startTaskInner`'s
// live-profile-refresh copy-down (the second one is the actual regression:
// before this fix it re-copied the profile's RAW null over the already-
// resolved task-row effort right before spawn, which is what made
// buildCommand's "effort is required for claude-code model …" throw). The
// stored snapshot keeps the raw null either way — only the task row's effort
// column gets the resolved default.
test("createTask + startTask: a profile with effort:null on claude-code's default model resolves to the kind-default effort at both copy points, and startTask succeeds", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { db, agentProfiles, runs, tasks } = await import("./db.ts");
  const { DEFAULT_MODEL, DEFAULT_EFFORT } = await import("../shared/types.ts");

  const profile = agentProfiles.insert({
    name: uniqueProfileName("null-effort"),
    harness: "claude-code",
    model: DEFAULT_MODEL["claude-code"],
    effort: null,
    instructions: "",
    skills: [],
  });

  const created = await createTask({
    title: "profile with null effort",
    prompt: "hello",
    workdir: process.cwd(),
    isolation: "none",
    agentProfileId: profile.id,
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  try {
    // createTask resolved the null profile effort to the kind default.
    expect(created.task.effort).toBe(DEFAULT_EFFORT["claude-code"]);
    // The captured snapshot keeps the profile's own raw null.
    expect(created.task.agentProfile?.effort).toBeNull();

    // The task has never run yet, so startTask's live-profile refresh runs
    // again (effectiveAgentProfile source === "live") right before spawn —
    // this is the second copy point the fix must also cover.
    const started = await startTask(taskId);
    if ("error" in started) throw new Error(started.error);
    await settle();

    const afterStart = tasks.get(taskId);
    expect(afterStart?.effort).toBe(DEFAULT_EFFORT["claude-code"]);

    const list = runs.listForTask(taskId);
    expect(list.length).toBe(1);
    expect(list[0]?.status).not.toBe("failed");

    const events = runs.eventsForTask(taskId).filter((e) => e.runId === started.runId);
    const firstUser = events.find((e) => e.stream === "user");
    expect(firstUser).toBeDefined();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
    agentProfiles.delete(profile.id);
  }
});

// Review fix F1 finding 3: `driftedFromRow`'s snapshot comparison must
// exclude `capturedAt` (stamped fresh on every `effectiveAgentProfile()`
// call) — otherwise it's always "true" and `startTaskInner`'s live-profile
// refresh hits `tasks.update` (bumping `updated_at`) on every single Run
// click even when the bound profile hasn't changed at all.
test("agentProfileSnapshotDrifted: true when prior is null or a real field differs; false when only capturedAt differs", async () => {
  const { agentProfileSnapshotDrifted } = await import("./orchestrator.ts");
  const base = {
    id: "p1",
    name: "Profile",
    harness: "claude-code",
    harnessKind: "claude-code" as const,
    harnessLabel: "Claude Code",
    model: "opus-5",
    effort: "high",
    mode: "auto",
    fast: false,
    maxMode: false,
    instructions: "be terse",
    skills: ["a", "b"],
    capturedAt: 1000,
  };

  expect(agentProfileSnapshotDrifted(null, base)).toBe(true);
  // Only capturedAt differs -> not drifted.
  expect(agentProfileSnapshotDrifted(base, { ...base, capturedAt: 999999 })).toBe(false);
  // A real field differs (alongside capturedAt) -> drifted.
  expect(agentProfileSnapshotDrifted(base, { ...base, capturedAt: 999999, model: "sonnet-5" })).toBe(true);
  expect(agentProfileSnapshotDrifted(base, { ...base, capturedAt: 999999, skills: ["a"] })).toBe(true);
});

// End-to-end proof: a bound-but-never-run task whose harness is disabled by
// default (cursor — migration 024/038) fails startTask's pre-flight BEFORE
// any run row is inserted, so the task stays "live" (effectiveAgentProfile's
// freeze-at-first-run gate) across repeated Run clicks. With nothing about
// the profile actually changing between attempts, neither `task.updatedAt`
// nor the stored snapshot's `capturedAt` should move on a second attempt —
// before the fix, the always-true comparison bumped both on every call.
test("startTaskInner's live-profile refresh is a no-op across repeated pre-flight failures when the bound profile hasn't changed", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { db, agentProfiles, tasks, harnesses } = await import("./db.ts");
  const cursorHarness = harnesses.getByIdOrKind("cursor");
  if (!cursorHarness) throw new Error("expected built-in cursor harness to resolve");
  // Cursor ships disabled by default (migration 024), which is the
  // deterministic pre-flight failure this test leans on — but `db.ts` is a
  // process-wide singleton across every file in one `bun test` run, and a
  // sibling file may have enabled cursor for its own scenario. Pin the
  // precondition explicitly and restore whatever we found afterwards.
  const cursorWasEnabled = cursorHarness.enabled;
  harnesses.setEnabled("cursor", false);

  const profile = agentProfiles.insert({
    name: uniqueProfileName("no-drift"),
    harness: "cursor",
    model: "composer-2.5",
    instructions: "",
    skills: [],
  });

  const created = await createTask({
    title: "disabled-harness pre-flight, unchanged profile",
    prompt: "p",
    workdir: process.cwd(),
    isolation: "none",
    agentProfileId: profile.id,
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  const updatedAtAtCreate = created.task.updatedAt;
  const capturedAtAtCreate = created.task.agentProfile?.capturedAt;
  expect(capturedAtAtCreate).toBeDefined();

  try {
    const first = await startTask(taskId);
    expect("error" in first).toBe(true);
    if ("error" in first) expect(first.error).toContain("disabled");

    const afterFirst = tasks.get(taskId);
    if (!afterFirst) throw new Error("task vanished");
    expect(afterFirst.runId).toBeNull();
    expect(afterFirst.updatedAt).toBe(updatedAtAtCreate);
    expect(afterFirst.agentProfile?.capturedAt).toBe(capturedAtAtCreate);

    // A second Run click with nothing about the profile changed must also be
    // a total no-op on the row.
    const second = await startTask(taskId);
    expect("error" in second).toBe(true);

    const afterSecond = tasks.get(taskId);
    if (!afterSecond) throw new Error("task vanished");
    expect(afterSecond.updatedAt).toBe(updatedAtAtCreate);
    expect(afterSecond.agentProfile?.capturedAt).toBe(capturedAtAtCreate);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
    agentProfiles.delete(profile.id);
    harnesses.setEnabled("cursor", cursorWasEnabled);
  }
});

test("effectiveAgentProfile: null for a plain task; live before any run; snapshot after a run row exists; snapshot once the profile is deleted; snapshot once the profile's harness is unresolvable", async () => {
  const { createTask, effectiveAgentProfile } = await import("./orchestrator.ts");
  const { db, agentProfiles, tasks, runs, harnesses } = await import("./db.ts");
  const claudeHarness = harnesses.getByIdOrKind("claude-code");
  if (!claudeHarness) throw new Error("expected built-in claude-code harness to resolve");

  // 1) Plain task, no profile at all -> null.
  const plain = await createTask({
    title: "no profile",
    prompt: "p",
    workdir: process.cwd(),
    isolation: "none",
  });
  if ("error" in plain) throw new Error(plain.error);
  try {
    expect(effectiveAgentProfile(plain.task)).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [plain.task.id]);
  }

  // 2) Bound profile, task never ran -> "live", and reflects an edit made
  // AFTER the task was created (proves it's not just replaying the create-
  // time snapshot).
  const liveProfile = agentProfiles.insert({
    name: uniqueProfileName("live"),
    harness: "claude-code",
    model: "model-v1",
    instructions: "v1",
    skills: [],
  });
  const liveTaskCreated = await createTask({
    title: "live profile",
    prompt: "p",
    workdir: process.cwd(),
    isolation: "none",
    agentProfileId: liveProfile.id,
  });
  if ("error" in liveTaskCreated) throw new Error(liveTaskCreated.error);
  const liveTaskId = liveTaskCreated.task.id;

  try {
    agentProfiles.update(liveProfile.id, { model: "model-v2", instructions: "v2" });
    const freshTask = tasks.get(liveTaskId);
    if (!freshTask) throw new Error("task vanished");
    const resolved = effectiveAgentProfile(freshTask);
    expect(resolved).not.toBeNull();
    if (resolved) {
      expect(resolved.source).toBe("live");
      expect(resolved.profile.model).toBe("model-v2");
      expect(resolved.profile.instructions).toBe("v2");
    }

    // 3) Insert a run row directly (mirrors orchestrator.test.ts's manual
    // run-row seeding) -> the task has now "run", so effectiveAgentProfile
    // must fall back to the frozen snapshot even though the live profile
    // still resolves and still differs from it.
    runs.insert({
      id: `${liveTaskId}-run-1`,
      taskId: liveTaskId,
      agent: "claude-code",
      status: "succeeded",
      startedAt: Date.now(),
      endedAt: Date.now(),
      exitCode: 0,
      tmuxSession: null,
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: null,
    });
    expect(runs.countForTask(liveTaskId)).toBe(1);

    const afterRunTask = tasks.get(liveTaskId);
    if (!afterRunTask) throw new Error("task vanished");
    const afterRun = effectiveAgentProfile(afterRunTask);
    expect(afterRun).not.toBeNull();
    if (afterRun) {
      expect(afterRun.source).toBe("snapshot");
      // The create-time snapshot (v1), not the since-edited live profile (v2).
      expect(afterRun.profile.instructions).toBe("v1");
    }
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [liveTaskId]);
    agentProfiles.delete(liveProfile.id);
  }

  // 4) Bound profile, task never ran, but the profile has since been
  // deleted -> falls back to the stored snapshot.
  const deletedProfile = agentProfiles.insert({
    name: uniqueProfileName("deleted"),
    harness: "claude-code",
    model: "model-del",
    instructions: "captured-before-delete",
    skills: [],
  });
  const deletedTaskCreated = await createTask({
    title: "profile deleted before first run",
    prompt: "p",
    workdir: process.cwd(),
    isolation: "none",
    agentProfileId: deletedProfile.id,
  });
  if ("error" in deletedTaskCreated) throw new Error(deletedTaskCreated.error);
  const deletedTaskId = deletedTaskCreated.task.id;
  try {
    agentProfiles.delete(deletedProfile.id);
    const freshTask = tasks.get(deletedTaskId);
    if (!freshTask) throw new Error("task vanished");
    const resolved = effectiveAgentProfile(freshTask);
    expect(resolved).not.toBeNull();
    if (resolved) {
      expect(resolved.source).toBe("snapshot");
      expect(resolved.profile.instructions).toBe("captured-before-delete");
    }
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [deletedTaskId]);
  }

  // 5) Bound profile, task never ran, but the profile's own harness id has
  // gone bogus (simulating a deleted harness) -> falls back to the stored
  // snapshot, since there's no live harness identity left to capture.
  const orphanHarnessProfile = agentProfiles.insert({
    name: uniqueProfileName("orphan-harness"),
    harness: "claude-code",
    model: "model-orphan",
    instructions: "captured-before-harness-orphaned",
    skills: [],
  });
  const orphanTaskCreated = await createTask({
    title: "profile harness goes bogus before first run",
    prompt: "p",
    workdir: process.cwd(),
    isolation: "none",
    agentProfileId: orphanHarnessProfile.id,
  });
  if ("error" in orphanTaskCreated) throw new Error(orphanTaskCreated.error);
  const orphanTaskId = orphanTaskCreated.task.id;
  try {
    // agentProfiles.update never validates the harness id exists (that check
    // lives in the server route) — this is exactly the "harness deleted out
    // from under an otherwise-live profile" scenario.
    agentProfiles.update(orphanHarnessProfile.id, { harness: "not-a-real-harness-id" });
    const freshTask = tasks.get(orphanTaskId);
    if (!freshTask) throw new Error("task vanished");
    const resolved = effectiveAgentProfile(freshTask);
    expect(resolved).not.toBeNull();
    if (resolved) {
      expect(resolved.source).toBe("snapshot");
      expect(resolved.profile.instructions).toBe("captured-before-harness-orphaned");
    }
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [orphanTaskId]);
    agentProfiles.delete(orphanHarnessProfile.id);
  }
});

test("fake-claude launch: the first user event equals appendReferences(composeLaunchPrompt(snapshot, prompt), refs); blank instructions + no skills -> plain prompt, no wrapper", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { db, agentProfiles, runs } = await import("./db.ts");
  const { composeLaunchPrompt } = await import("../shared/agent-profile.ts");
  const { appendReferences } = await import("../shared/refs.ts");

  // Case A: a profile with real instructions + skills, and a task carrying
  // one reference, to prove the ordering preamble -> prompt -> references.
  const profile = agentProfiles.insert({
    name: uniqueProfileName("launch"),
    harness: "claude-code",
    model: "model-launch",
    effort: "high",
    instructions: "Be extremely terse.",
    skills: ["code-review"],
  });

  const ref = { path: "/tmp/agent-profiles-test-ref.txt", isDirectory: false };
  const created = await createTask({
    title: "launch with profile + refs",
    prompt: "summarize the repo",
    workdir: process.cwd(),
    isolation: "none",
    agentProfileId: profile.id,
    references: [ref],
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  const snapshot = created.task.agentProfile;
  if (!snapshot) throw new Error("expected a captured snapshot on the task");

  try {
    const started = await startTask(taskId);
    if ("error" in started) throw new Error(started.error);
    await settle();

    const expected = appendReferences(
      composeLaunchPrompt(snapshot, "summarize the repo"),
      [ref],
    );
    const events = runs.eventsForTask(taskId);
    const firstUser = events.find((e) => e.stream === "user");
    expect(firstUser).toBeDefined();
    expect(firstUser?.data).toBe(expected);
    // Sanity: the wrapper tag really is present for this non-empty profile.
    expect(firstUser?.data).toContain("<agent_instructions_defined_by_the_user>");
    expect(firstUser?.data).toContain("Be extremely terse.");
    expect(firstUser?.data).toContain("/code-review");
    expect(firstUser?.data).toContain("Referenced files/folders:");
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
    agentProfiles.delete(profile.id);
  }

  // Case B: a profile whose instructions are blank and skills are empty ->
  // composeLaunchPrompt is a no-op passthrough, so the launch prompt is
  // exactly the plain prompt with no wrapper tag at all.
  const blankProfile = agentProfiles.insert({
    name: uniqueProfileName("blank"),
    harness: "claude-code",
    model: "model-blank",
    effort: "high",
    instructions: "   ",
    skills: [],
  });
  const blankCreated = await createTask({
    title: "launch with blank profile",
    prompt: "plain task, no wrapper expected",
    workdir: process.cwd(),
    isolation: "none",
    agentProfileId: blankProfile.id,
  });
  if ("error" in blankCreated) throw new Error(blankCreated.error);
  const blankTaskId = blankCreated.task.id;
  try {
    const started = await startTask(blankTaskId);
    if ("error" in started) throw new Error(started.error);
    await settle();

    const events = runs.eventsForTask(blankTaskId);
    const firstUser = events.find((e) => e.stream === "user");
    expect(firstUser).toBeDefined();
    expect(firstUser?.data).toBe("plain task, no wrapper expected");
    expect(firstUser?.data).not.toContain("agent_instructions_defined_by_the_user");
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [blankTaskId]);
    agentProfiles.delete(blankProfile.id);
  }
});

test("live-before-first-run: startTask copies down live profile edits + refreshes the snapshot; once a run exists, further profile edits (including a delete) no longer affect the task, and a re-run keeps injecting the frozen snapshot", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { db, agentProfiles, tasks, runs } = await import("./db.ts");

  const profile = agentProfiles.insert({
    name: uniqueProfileName("freeze"),
    harness: "claude-code",
    model: "model-v1",
    effort: "high",
    instructions: "v1",
    skills: [],
  });

  const created = await createTask({
    title: "freeze at first run",
    prompt: "hello",
    workdir: process.cwd(),
    isolation: "none",
    agentProfileId: profile.id,
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  try {
    // Edit the profile before the task's first run.
    agentProfiles.update(profile.id, { model: "model-v2", instructions: "v2" });

    const started = await startTask(taskId);
    if ("error" in started) throw new Error(started.error);
    const firstRunId = started.runId;

    // Copy-down happened right before the first run was minted.
    const afterStart = tasks.get(taskId);
    expect(afterStart?.model).toBe("model-v2");
    expect(afterStart?.agentProfile?.instructions).toBe("v2");

    await settle();

    const firstEvents = runs.eventsForTask(taskId).filter((e) => e.runId === firstRunId);
    const firstUser = firstEvents.find((e) => e.stream === "user");
    expect(firstUser?.data).toContain("v2");

    // The first run has now settled and been recorded — freeze-at-first-run
    // takes effect from here on.
    expect(runs.countForTask(taskId)).toBe(1);

    // Edit the profile again — this must NOT reach the already-run task.
    agentProfiles.update(profile.id, { instructions: "v3" });

    // startTask has no column gate (only `active.has(task.runId)`, and the
    // first run has already settled out of `active`), so re-starting the
    // same task directly mints a second run without any column bookkeeping.
    const second = await startTask(taskId);
    if ("error" in second) throw new Error(second.error);
    const secondRunId = second.runId;
    expect(secondRunId).not.toBe(firstRunId);
    await settle();

    const rowAfterSecondStart = tasks.get(taskId);
    // The row is still frozen at "v2" — never touched by the "v3" edit.
    expect(rowAfterSecondStart?.agentProfile?.instructions).toBe("v2");
    expect(rowAfterSecondStart?.model).toBe("model-v2");

    const secondEvents = runs.eventsForTask(taskId).filter((e) => e.runId === secondRunId);
    const secondUser = secondEvents.find((e) => e.stream === "user");
    expect(secondUser?.data).toContain("v2");
    expect(secondUser?.data).not.toContain("v3");

    // Now delete the profile outright and re-run a third time — the frozen
    // snapshot must still be what gets injected.
    agentProfiles.delete(profile.id);
    const third = await startTask(taskId);
    if ("error" in third) throw new Error(third.error);
    const thirdRunId = third.runId;
    await settle();

    const thirdEvents = runs.eventsForTask(taskId).filter((e) => e.runId === thirdRunId);
    const thirdUser = thirdEvents.find((e) => e.stream === "user");
    expect(thirdUser?.data).toContain("v2");

    const rowAfterDelete = tasks.get(taskId);
    expect(rowAfterDelete?.agentProfile?.instructions).toBe("v2");
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
    // Already deleted above in the happy path, but be defensive in case an
    // assertion threw before that point.
    agentProfiles.delete(profile.id);
  }
});

test("gemini budget: a profile whose instructions push the RAW prompt+preamble over GEMINI_PROMPT_ARGV_MAX_BYTES takes the pre-existing spawn-throw path, not the '@ file references' overage error", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, runs, harnesses, agentProfiles } = await import("./db.ts");
  const { GEMINI_PROMPT_ARGV_MAX_BYTES } = await import("./agents.ts");
  // gemini ships disabled by default (migration 037) — enable it for this test.
  harnesses.setEnabled("gemini", true);

  const oversizedInstructions = "x".repeat(GEMINI_PROMPT_ARGV_MAX_BYTES + 200);
  const profile = agentProfiles.insert({
    name: uniqueProfileName("gemini-oversized"),
    harness: "gemini",
    model: "model-gemini",
    instructions: oversizedInstructions,
    skills: [],
  });

  const created = await createTask({
    title: "gemini oversized profile instructions",
    // Deliberately small — no `@` tokens at all, so expansion is a no-op and
    // rawOverage === expandedOverage (the "expanding @ file references"
    // early-return path is unreachable here by construction).
    prompt: "hi",
    workdir: process.cwd(),
    isolation: "none",
    agentProfileId: profile.id,
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  try {
    const started = await startTask(taskId);
    expect("error" in started).toBe(true);
    if ("error" in started) {
      expect(started.error).toContain(`prompt exceeds ${GEMINI_PROMPT_ARGV_MAX_BYTES} bytes`);
      // This must NOT be the client-facing "@ file references" overage
      // error — that path requires expandedOverage && !rawOverage, which
      // can't happen here since there are no `@` tokens to expand.
      expect(started.error).not.toContain("after expanding @ file references");
    }

    const list = runs.listForTask(taskId);
    expect(list.length).toBe(1);
    expect(list[0]?.status).toBe("failed");

    const task = tasks.get(taskId);
    expect(task?.column).toBe("ready");
    expect(task?.runId).toBeNull();
  } finally {
    const { db } = await import("./db.ts");
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
    agentProfiles.delete(profile.id);
  }
});

test("sendInput on a task with a profile does not inject the preamble — the follow-up user event equals the raw line sent", async () => {
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { db, agentProfiles, runs, harnesses } = await import("./db.ts");
  // codex ships disabled by default (migration 016 rollout) — enable it.
  harnesses.setEnabled("codex", true);

  const profile = agentProfiles.insert({
    name: uniqueProfileName("followup"),
    harness: "codex",
    model: "model-codex",
    effort: "high",
    instructions: "This should never leak into a follow-up message.",
    skills: ["code-review"],
  });

  const created = await createTask({
    title: "codex follow-up, no preamble",
    prompt: "turn one",
    workdir: process.cwd(),
    isolation: "none",
    agentProfileId: profile.id,
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  try {
    const started = await startTask(taskId);
    if ("error" in started) throw new Error(started.error);
    const firstRunId = started.runId;
    // Let the fake codex turn resolve so the follow-up takes the idle
    // (new-run) path rather than folding/queueing behind an active turn —
    // mirrors orchestrator-codex.test.ts's "sendInput (codex, idle)" test.
    await settle(150);

    const followUpLine = "a plain follow-up message";
    const res = await sendInput(firstRunId, followUpLine);
    expect(res.delivered).toBe(true);
    await settle(150);

    if (!res.delivered) return;
    const followUpRunId = res.runId;
    expect(followUpRunId).not.toBe(firstRunId);

    const followUpEvents = runs.eventsForTask(taskId).filter((e) => e.runId === followUpRunId);
    const followUpUser = followUpEvents.find((e) => e.stream === "user");
    expect(followUpUser).toBeDefined();
    expect(followUpUser?.data).toBe(followUpLine);
    expect(followUpUser?.data).not.toContain("agent_instructions_defined_by_the_user");
    expect(followUpUser?.data).not.toContain("This should never leak");
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
    agentProfiles.delete(profile.id);
  }
});

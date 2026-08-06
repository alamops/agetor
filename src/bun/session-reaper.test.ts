import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import — a `beforeAll`
// hook would race with any sibling test file that already imported db.ts in
// this process (see orchestrator.test.ts's identical comment). Every test
// below reaches `./orchestrator.ts`/`./db.ts` only through a dynamic
// `await import(...)` inside the test body, so this top-level assignment is
// guaranteed to run first.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-reap-test-"));
// Drive claude through the in-process fake driver instead of tmux + the real
// CLI (orchestrator.test.ts's pattern). AGETOR_CLAUDE_BIN/AGETOR_TMUX_BIN are
// also overridden to `/bin/echo` so the agent-status/tmux preflights inside
// startTask pass without either binary installed, and so any tmux call the
// reaper's kill path makes (`killTaskSession` → `tmux kill-session`) is a
// harmless no-op against `/bin/echo` rather than touching the user's real
// tmux socket.
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";

/** Create a claude-code task with worktree isolation off, so no real git
 *  branch/worktree is materialized in the repo running the test suite (see
 *  the worktree-isolation warning in CLAUDE.md and orchestrator.test.ts's
 *  identical convention). */
async function createClaudeTask(title: string) {
  const { createTask } = await import("./orchestrator.ts");
  const created = await createTask({
    title,
    prompt: "hello",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  return created.task;
}

/** Install a synthetic in-memory `SessionState` for `taskId` (the same
 *  `__forTest.installSession` helper orchestrator.test.ts's fold-while-busy
 *  test uses) and back-date its activity clock so `sessionIdleInfo` reports
 *  it idle for at least `aheadOfNowMs` beyond "now". The fake claude driver
 *  never touches claude-tmux at all, so nothing does this automatically —
 *  tests that want the reaper's in-memory-session branch (rather than its
 *  no-in-memory-state `task.updatedAt` fallback) must install one by hand. */
async function installIdleSession(taskId: string, idleMs: number) {
  const claudeTmux = await import("./claude-tmux.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-reap-session-"));
  const jsonlPath = path.join(dir, `${randomUUID()}.jsonl`);
  writeFileSync(jsonlPath, "");
  const state = claudeTmux.__forTest.installSession(taskId, jsonlPath);
  state.lastActivityAt = Date.now() - idleMs;
  return state;
}

test("reaps a claude task whose in-memory session has been idle past the threshold, and appends a hibernation status event", async () => {
  const { startTask, reapIdleSessions } = await import("./orchestrator.ts");
  const { db, runs } = await import("./db.ts");
  const claudeTmux = await import("./claude-tmux.ts");
  const { IDLE_SESSION_REAP_MS } = await import("../shared/types.ts");

  const task = await createClaudeTask("idle reap candidate");
  const taskId = task.id;

  const started = await startTask(taskId);
  if (!("runId" in started)) throw new Error("expected the run to start");

  // Let the fake driver's ~20ms turn resolve so `active` no longer holds this
  // run — otherwise the in-flight guard would (correctly, but uninterestingly
  // for THIS test) block the reap regardless of idle time.
  await new Promise((r) => setTimeout(r, 80));

  await installIdleSession(taskId, IDLE_SESSION_REAP_MS + 5_000);

  try {
    expect(claudeTmux.hasSessionState(taskId)).toBe(true);

    const { reaped } = await reapIdleSessions();

    expect(reaped).toContain(taskId);
    expect(claudeTmux.hasSessionState(taskId)).toBe(false);

    const events = runs.eventsForTask(taskId);
    const hibernated = events.find(
      (e) => e.stream === "status" && e.data.includes("hibernated"),
    );
    expect(hibernated).toBeDefined();
    expect(hibernated?.data).toContain("30m idle");
  } finally {
    claudeTmux.__forTest.uninstallSession(taskId);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("does not reap a task whose run is still active (a turn in flight)", async () => {
  const { startTask, reapIdleSessions } = await import("./orchestrator.ts");
  const { db } = await import("./db.ts");

  const task = await createClaudeTask("in-flight guard");
  const taskId = task.id;

  const started = await startTask(taskId);
  if (!("runId" in started)) throw new Error("expected the run to start");

  try {
    // TIMING INVARIANT (mirrors orchestrator.test.ts's fold-while-busy test):
    // no `await` runs between `startTask` resolving and this call, so
    // `active` is guaranteed to still hold this run's handle — the fake
    // driver doesn't resolve the turn for ~20ms. `reapIdleSessions` itself
    // does no internal `await` before consulting `active`, so this captures
    // the in-flight state precisely.
    const { reaped } = await reapIdleSessions();
    expect(reaped).not.toContain(taskId);
  } finally {
    // Let the in-flight fake turn resolve before the row is deleted out from
    // under its timer.
    await new Promise((r) => setTimeout(r, 80));
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("does not reap a task with a pending interaction", async () => {
  const { startTask, reapIdleSessions } = await import("./orchestrator.ts");
  const { db } = await import("./db.ts");
  const claudeTmux = await import("./claude-tmux.ts");
  const { registerScrapedAskQuestions, cancelPendingForTask } = await import("./interactions.ts");
  const { IDLE_SESSION_REAP_MS } = await import("../shared/types.ts");

  const task = await createClaudeTask("pending interaction guard");
  const taskId = task.id;

  const started = await startTask(taskId);
  if (!("runId" in started)) throw new Error("expected the run to start");
  const runId = started.runId;
  await new Promise((r) => setTimeout(r, 80)); // let the turn resolve, clearing `active`

  await installIdleSession(taskId, IDLE_SESSION_REAP_MS + 5_000);

  registerScrapedAskQuestions({
    taskId,
    runId,
    questions: [{ question: "Pick one", options: [{ label: "A" }, { label: "B" }] }],
    fingerprint: "fp-reap-guard",
  });

  try {
    const { reaped } = await reapIdleSessions();
    expect(reaped).not.toContain(taskId);
    expect(claudeTmux.hasSessionState(taskId)).toBe(true);
  } finally {
    cancelPendingForTask(taskId, "test cleanup");
    claudeTmux.__forTest.uninstallSession(taskId);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("does not reap a session that has been idle for less than the threshold", async () => {
  const { startTask, reapIdleSessions } = await import("./orchestrator.ts");
  const { db } = await import("./db.ts");
  const claudeTmux = await import("./claude-tmux.ts");

  const task = await createClaudeTask("young session guard");
  const taskId = task.id;

  const started = await startTask(taskId);
  if (!("runId" in started)) throw new Error("expected the run to start");
  await new Promise((r) => setTimeout(r, 80)); // let the turn resolve, clearing `active`

  // Comfortably below IDLE_SESSION_REAP_MS (30min) — "just showed life".
  await installIdleSession(taskId, 1_000);

  try {
    const { reaped } = await reapIdleSessions();
    expect(reaped).not.toContain(taskId);
    expect(claudeTmux.hasSessionState(taskId)).toBe(true);
  } finally {
    claudeTmux.__forTest.uninstallSession(taskId);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("never considers a codex task, even when its updatedAt is old enough to otherwise qualify", async () => {
  const { createTask, reapIdleSessions } = await import("./orchestrator.ts");
  const { db } = await import("./db.ts");
  const { IDLE_SESSION_REAP_MS } = await import("../shared/types.ts");

  const created = await createTask({
    title: "codex is never a reap candidate",
    prompt: "hello",
    agent: "codex",
    workdir: process.cwd(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  // `tasks.update` always stamps `updatedAt` to "now", so the only way to
  // simulate an old row is a raw UPDATE — mirroring how these tests already
  // reach into `db` directly for cleanup. If the reaper didn't filter on
  // agent kind up front, this alone would make the task eligible via the
  // no-in-memory-state `task.updatedAt` fallback (there's no live tmux
  // session to make `sessionLiveness` say "gone", and `/bin/echo` standing in
  // for tmux always reports "alive").
  db.run(`UPDATE tasks SET updated_at = ? WHERE id = ?`, [
    Date.now() - IDLE_SESSION_REAP_MS - 60_000,
    taskId,
  ]);

  try {
    const { reaped } = await reapIdleSessions();
    expect(reaped).not.toContain(taskId);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("after a reap, a follow-up routes through the resume path (new run, not a live-session paste)", async () => {
  const { startTask, sendInput, reapIdleSessions } = await import("./orchestrator.ts");
  const { db, runs } = await import("./db.ts");
  const claudeTmux = await import("./claude-tmux.ts");
  const { IDLE_SESSION_REAP_MS } = await import("../shared/types.ts");

  const task = await createClaudeTask("reap then resume");
  const taskId = task.id;

  const started = await startTask(taskId);
  if (!("runId" in started)) throw new Error("expected the run to start");
  const originalRunId = started.runId;
  await new Promise((r) => setTimeout(r, 80)); // let the turn resolve, clearing `active`

  await installIdleSession(taskId, IDLE_SESSION_REAP_MS + 5_000);

  try {
    const { reaped } = await reapIdleSessions();
    expect(reaped).toContain(taskId);
    // This is the exact signal `sendClaudeTurn` branches on: with no
    // in-memory session state, it must take `spawnResumedSession` instead of
    // `sendTurnInExistingSession`'s live-session paste path.
    expect(claudeTmux.hasSessionState(taskId)).toBe(false);

    const sent = await sendInput(originalRunId, "are you still there?");
    expect(sent.delivered).toBe(true);
    if (!sent.delivered) return;

    // `spawnResumedSession` always creates a brand-new run row (unlike the
    // fold-while-busy path, which reuses the active run) — this is the
    // observable proof the resume branch, not the paste branch, ran.
    expect(sent.runId).not.toBe(originalRunId);

    const rows = runs.listForTask(taskId);
    expect(rows.map((r) => r.id).sort()).toEqual([originalRunId, sent.runId].sort());

    // `spawnResumedSession` emits one of these two status lines unconditionally
    // right after spawning — the fake driver never stamps a claudeSessionId,
    // so this run takes the "no prior session" branch, but either phrasing
    // proves the resume path (not the paste path, which never emits either).
    const resumeStatus = runs
      .eventsForTask(taskId)
      .find(
        (e) =>
          e.runId === sent.runId
          && e.stream === "status"
          && (e.data.includes("resuming claude session") || e.data.includes("no prior claude session")),
      );
    expect(resumeStatus).toBeDefined();

    // Let the resumed fake turn resolve before cleanup deletes the row out
    // from under its ~20ms timer.
    await new Promise((r) => setTimeout(r, 80));
  } finally {
    claudeTmux.__forTest.uninstallSession(taskId);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("back-to-back reap sweeps never reap the same task twice", async () => {
  const { startTask, reapIdleSessions } = await import("./orchestrator.ts");
  const { db, runs } = await import("./db.ts");
  const claudeTmux = await import("./claude-tmux.ts");
  const { IDLE_SESSION_REAP_MS } = await import("../shared/types.ts");

  const task = await createClaudeTask("no double reap");
  const taskId = task.id;

  const started = await startTask(taskId);
  if (!("runId" in started)) throw new Error("expected the run to start");
  await new Promise((r) => setTimeout(r, 80)); // let the turn resolve, clearing `active`

  await installIdleSession(taskId, IDLE_SESSION_REAP_MS + 5_000);

  try {
    // Honest caveat: `reapIdleSessions` has no internal `await` in its body
    // (confirmed by reading orchestrator.ts) — every await it might hit
    // (tasks.get, dropSession, runs.appendEvent) is actually synchronous
    // (sqlite + in-memory work), so calling it twice back-to-back can never
    // produce TRUE interleaving in this single-threaded runtime: the first
    // call runs to completion (including resetting the `reapInFlight` mutex)
    // before the second call's body even starts. Exercising a genuine race
    // would require monkeypatching an internal export mid-sweep, which no
    // existing test in this codebase does and which the task brief asked not
    // to invent. What IS testable — and still a real regression guard for the
    // documented invariant — is that neither call double-reaps: the second
    // sweep must see the session already gone and the task's `updatedAt`
    // freshly bumped (recent, not idle), so its `task.updatedAt` fallback
    // correctly declines a second time.
    const [first, second] = await Promise.all([reapIdleSessions(), reapIdleSessions()]);

    const hits = (first.reaped.includes(taskId) ? 1 : 0) + (second.reaped.includes(taskId) ? 1 : 0);
    expect(hits).toBe(1);

    const hibernatedEvents = runs
      .eventsForTask(taskId)
      .filter((e) => e.stream === "status" && e.data.includes("hibernated"));
    expect(hibernatedEvents.length).toBe(1);
  } finally {
    claudeTmux.__forTest.uninstallSession(taskId);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("runs.lastEventData returns the most recently appended MAIN-stream event's data, and null for an eventless run", async () => {
  const { db, runs } = await import("./db.ts");

  // run_events.run_id carries an FK to runs(id) (ON DELETE CASCADE), so this
  // needs a real task + run row, not a bare uuid.
  const task = await createClaudeTask("lastEventData accessor");
  const taskId = task.id;
  const runId = randomUUID();
  runs.insert({
    id: runId,
    taskId,
    agent: "claude-code",
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    geminiSessionId: null,
  });

  try {
    expect(runs.lastEventData(runId)).toBeNull();

    runs.appendEvent(runId, "status", "first");
    expect(runs.lastEventData(runId)).toBe("first");

    runs.appendEvent(runId, "status", "second");
    expect(runs.lastEventData(runId)).toBe("second");

    // Re-appending the same text is exactly what the reap guard checks for —
    // confirm the accessor reports it as unchanged (still "second", not a
    // stale read behind the new row).
    runs.appendEvent(runId, "status", "second");
    expect(runs.lastEventData(runId)).toBe("second");

    // A subagent row landing after the breadcrumb must NOT become "the last
    // event" — the guard compares main-stream text against main-stream text.
    runs.appendEvent(runId, "assistant", "subagent chatter", null, "subagent-1");
    expect(runs.lastEventData(runId)).toBe("second");
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("never appends the hibernate breadcrumb twice in a row to the same run, even across a re-reap regression", async () => {
  // Regression guard for the tmux 3.6a `probeSessionActivity` bug (see
  // docs/plans/fix-permission-mode-status-spam.md, "Follow-up" section): a
  // broken probe made every idle-fallback check look like "never attached,
  // idle since 1970", so `reapIdleSessions` re-reaped the same
  // already-hibernated task on every 5-minute sweep and appended a fresh
  // duplicate breadcrumb each time (528 rows across 12 tasks in prod). The
  // probe fix is covered by `parseSessionActivityLine`'s unit tests in
  // claude-tmux.test.ts; this test exercises the defense-in-depth backstop
  // instead — it doesn't rely on the probe being broken, it simulates a
  // re-reap directly (reinstalling an idle in-memory session on the very run
  // the first sweep already hibernated) and asserts the breadcrumb still
  // can't duplicate no matter what caused the second sweep to think the task
  // was idle again.
  const { startTask, reapIdleSessions } = await import("./orchestrator.ts");
  const { db, runs } = await import("./db.ts");
  const claudeTmux = await import("./claude-tmux.ts");
  const { IDLE_SESSION_REAP_MS } = await import("../shared/types.ts");

  const task = await createClaudeTask("no double hibernate breadcrumb");
  const taskId = task.id;

  const started = await startTask(taskId);
  if (!("runId" in started)) throw new Error("expected the run to start");
  const runId = started.runId;
  // Let the fake driver's turn resolve so `active` no longer holds this run
  // — otherwise the in-flight guard would (correctly) block every reap
  // attempt below regardless of idle time.
  await new Promise((r) => setTimeout(r, 100));

  try {
    // First sweep: genuinely idle in-memory session → reaps and appends the
    // hibernate breadcrumb once.
    await installIdleSession(taskId, IDLE_SESSION_REAP_MS + 5_000);
    const first = await reapIdleSessions();
    expect(first.reaped).toContain(taskId);

    const afterFirst = runs
      .eventsForTask(taskId)
      .filter((e) => e.runId === runId && e.stream === "status" && e.data.includes("hibernated"));
    expect(afterFirst.length).toBe(1);

    // Simulate the regression: something makes the reaper see this exact
    // task/run as idle again on the very next sweep (in prod this was the
    // broken tmux probe; here we reinstall an idle session directly so the
    // test doesn't depend on reproducing the tmux 3.6a bug itself). No
    // follow-up message was sent, so `recent` still resolves to the same
    // run — this is the scenario the guard exists for.
    await installIdleSession(taskId, IDLE_SESSION_REAP_MS + 5_000);
    const second = await reapIdleSessions();
    expect(second.reaped).toContain(taskId);

    const afterSecond = runs
      .eventsForTask(taskId)
      .filter((e) => e.runId === runId && e.stream === "status" && e.data.includes("hibernated"));
    // The guard must have skipped the duplicate append — still exactly one
    // hibernate breadcrumb on this run, not two.
    expect(afterSecond.length).toBe(1);
    expect(afterSecond[0]!.data).toBe(afterFirst[0]!.data);
  } finally {
    claudeTmux.__forTest.uninstallSession(taskId);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

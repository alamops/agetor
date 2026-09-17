import { test, expect, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";
import { SPAWN_RESPONSE_BUDGET_MS } from "../shared/types.ts";

// Tests for docs/plans/task-details-blank-while-session-restores.md §3.1 / §4
// T1 / §5 U1: the bounded spawn await on `startTask` and `sendInput`'s claude
// idle/dead-session mint path (`sendClaudeTurn` → `spawnResumedSession`).
//
// Top-level: db.ts captures AGETOR_DATA_DIR at first import — a `beforeAll`
// would race with whichever test file's import wins the module-cache race in
// `bun test`'s single process (same convention as orchestrator.test.ts /
// orchestrator-paste-withheld.test.ts). Drive claude through the in-process
// fake driver (agents.ts) so no real tmux server / claude binary is needed —
// the fake never installs claude-tmux `SessionState`, so any `sendInput`
// after a task's run settles unambiguously routes through the dead/no-session
// mint path (`spawnResumedSession`), which is exactly the surface under test.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-spawn-budget-"));
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo"; // has-session / send-keys / kill-session probes all exit 0
process.env.AGETOR_CLAUDE_ARGS = "";

afterAll(() => {
  rmTestDataDir(process.env.AGETOR_DATA_DIR!);
});

/** A spawn delay comfortably above `SPAWN_RESPONSE_BUDGET_MS` (1500ms) so the
 *  budget always wins the race under normal CI/dev-machine jitter, but small
 *  enough to keep the whole file's wall clock well under 30s across the
 *  handful of tests that need it. */
const SLOW_SPAWN_DELAY_MS = 2200;

/** Poll `check` until it returns true or `timeoutMs` elapses — used instead
 *  of a fixed sleep for every async settle below (mirrors the `waitFor`
 *  helper in orchestrator-paste-withheld.test.ts / claude-followup-restart
 *  suites). */
async function waitFor(check: () => boolean, timeoutMs = 6000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error("waitFor: timed out waiting for condition");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Create a fresh `isolation: "none"` task rooted at a throwaway temp dir
 *  (never a real git repo) — per CLAUDE.md's worktree-isolation warning, this
 *  is the only safe way to exercise `startTask`/`sendInput` in tests without
 *  creating real branches in whatever repo `process.cwd()` resolves to. */
async function makeTask(title: string) {
  const { createTask } = await import("./orchestrator.ts");
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-spawn-budget-wd-"));
  const created = await createTask({
    title,
    prompt: `prompt for ${title}`,
    agent: "claude-code",
    workdir,
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 1 — Fast path (no delay): byte-identical to today's shape, no `pending` key
 * ────────────────────────────────────────────────────────────────────────── */

test("fast path: startTask with no spawn delay returns runId and no pending key", async () => {
  delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  const { startTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  const taskId = await makeTask("fast-start");
  const res = await startTask(taskId);

  expect("error" in res).toBe(false);
  if ("error" in res) return;
  expect(typeof res.runId).toBe("string");
  expect("pending" in res).toBe(false);

  await waitFor(() => tasks.get(taskId)?.column === "review");
});

test("fast path: sendInput on a finished claude task (idle → resume) with no spawn delay returns delivered and no pending key", async () => {
  delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  const { startTask, sendInput } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  const taskId = await makeTask("fast-resume");
  const started = await startTask(taskId);
  expect("error" in started).toBe(false);
  if ("error" in started) return;
  const firstRunId = started.runId;
  await waitFor(() => tasks.get(taskId)?.column === "review");

  // The task's run has settled and the fake driver never installed any
  // claude-tmux SessionState, so this follow-up is the dead/no-session mint
  // path — `sendClaudeTurn` → `spawnResumedSession`.
  const sent = await sendInput(firstRunId, "a follow-up message");
  expect(sent.delivered).toBe(true);
  if (!sent.delivered) return;
  expect(typeof sent.runId).toBe("string");
  expect(sent.runId).not.toBe(firstRunId);
  expect("pending" in sent).toBe(false);

  await waitFor(() => tasks.get(taskId)?.column === "review");
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 2 — Slow spawn: startTask responds within the budget with `pending: true`,
 *     the run/task are already registered at return time, and the spawn
 *     settles normally afterward.
 * ────────────────────────────────────────────────────────────────────────── */

test("slow spawn: startTask responds within the budget with pending:true, and the run completes after settling", async () => {
  process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS = String(SLOW_SPAWN_DELAY_MS);
  try {
    const { startTask } = await import("./orchestrator.ts");
    const { tasks, runs } = await import("./db.ts");

    const taskId = await makeTask("slow-start");

    const before = Date.now();
    const res = await startTask(taskId);
    const elapsedMs = Date.now() - before;

    // Must not hold the HTTP response open for the full spawn delay — the
    // budget (1500ms) should win the race well before the 2200ms fake spawn
    // settles.
    expect(elapsedMs).toBeLessThan(SPAWN_RESPONSE_BUDGET_MS + 500);
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.pending).toBe(true);
    expect(typeof res.runId).toBe("string");
    const runId = res.runId;

    // The run row, the `running` column flip, and (indirectly) the initial
    // `user` event are already persisted at return time — that's the whole
    // point of responding early.
    expect(runs.get(runId)?.status).toBe("running");
    expect(tasks.get(taskId)?.column).toBe("running");
    expect(tasks.get(taskId)?.runId).toBe(runId);

    // After the detached spawn settles, the fake driver's generic scenario
    // resolves the turn "succeeded" and the task advances to review.
    await waitFor(() => tasks.get(taskId)?.column === "review", SLOW_SPAWN_DELAY_MS + 3000);
    expect(runs.get(runId)?.status).toBe("succeeded");
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  }
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 3 — Claim held across the early return: a second startTask for the same
 *     task is rejected while the first spawn is still in flight; a new start
 *     is accepted once it settles.
 * ────────────────────────────────────────────────────────────────────────── */

test("slow spawn: startTask claim is held across the early return, and released once the spawn settles", async () => {
  process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS = String(SLOW_SPAWN_DELAY_MS);
  try {
    const { startTask } = await import("./orchestrator.ts");
    const { tasks } = await import("./db.ts");

    const taskId = await makeTask("claim-held");

    const first = await startTask(taskId);
    expect("error" in first).toBe(false);
    if ("error" in first) return;
    expect(first.pending).toBe(true);
    const firstRunId = first.runId;

    // Second overlapping start, while the first spawn is still detached and
    // in flight, must be rejected with the existing "already starting" error
    // — NOT allowed to race in behind it and mint a second run.
    const second = await startTask(taskId);
    expect("error" in second).toBe(true);
    if (!("error" in second)) return;
    expect(second.error).toMatch(/already starting/i);

    // Wait for the first spawn to settle (run reaches its terminal column).
    await waitFor(() => tasks.get(taskId)?.column === "review", SLOW_SPAWN_DELAY_MS + 3000);

    // The claim is released now — a fresh start is accepted and mints a
    // genuinely new run.
    delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
    const third = await startTask(taskId);
    expect("error" in third).toBe(false);
    if ("error" in third) return;
    expect(third.runId).not.toBe(firstRunId);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  }
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 4 — sendInput's claude idle/dead-session mint path (spawnResumedSession):
 *     same two behaviors as startTask — pending under a slow spawn, claim
 *     held across the early return, released + registered after settle.
 * ────────────────────────────────────────────────────────────────────────── */

test("slow spawn: sendInput (resume path) responds within the budget with pending:true, and the run completes after settling", async () => {
  delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  const { startTask, sendInput } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const taskId = await makeTask("slow-resume");
  const started = await startTask(taskId);
  expect("error" in started).toBe(false);
  if ("error" in started) return;
  const firstRunId = started.runId;
  await waitFor(() => tasks.get(taskId)?.column === "review");

  process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS = String(SLOW_SPAWN_DELAY_MS);
  try {
    const before = Date.now();
    const sent = await sendInput(firstRunId, "resume with a slow spawn");
    const elapsedMs = Date.now() - before;

    expect(elapsedMs).toBeLessThan(SPAWN_RESPONSE_BUDGET_MS + 500);
    expect(sent.delivered).toBe(true);
    if (!sent.delivered) return;
    expect(sent.pending).toBe(true);
    const runId = sent.runId;
    expect(runId).not.toBe(firstRunId);

    // Run row + running column flip already persisted at return time.
    expect(runs.get(runId)?.status).toBe("running");
    expect(tasks.get(taskId)?.column).toBe("running");
    expect(tasks.get(taskId)?.runId).toBe(runId);

    await waitFor(() => tasks.get(taskId)?.column === "review", SLOW_SPAWN_DELAY_MS + 3000);
    expect(runs.get(runId)?.status).toBe("succeeded");
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  }
});

test("slow spawn: a second sendInput during the pending window is rejected, and a later send registers after settle", async () => {
  delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  const { startTask, sendInput, cancelRun } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const taskId = await makeTask("resume-claim-held");
  const started = await startTask(taskId);
  expect("error" in started).toBe(false);
  if ("error" in started) return;
  const firstRunId = started.runId;
  await waitFor(() => tasks.get(taskId)?.column === "review");

  process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS = String(SLOW_SPAWN_DELAY_MS);
  try {
    const first = await sendInput(firstRunId, "first follow-up");
    expect(first.delivered).toBe(true);
    if (!first.delivered) return;
    expect(first.pending).toBe(true);
    const pendingRunId = first.runId;

    // A second message sent (via the ORIGINAL run id, which still resolves
    // to the same task) while the first spawn is still in flight must be
    // rejected — the claim is held, not released early.
    const second = await sendInput(firstRunId, "second follow-up, while pending");
    expect(second.delivered).toBe(false);
    if (second.delivered) return;
    expect(second.reason).toMatch(/another message is already starting a new turn/i);

    // Once the pending spawn settles, the run registers and the task
    // resolves normally (fake driver's generic scenario succeeds).
    await waitFor(() => tasks.get(taskId)?.column === "review", SLOW_SPAWN_DELAY_MS + 3000);
    expect(runs.get(pendingRunId)?.status).toBe("succeeded");

    // And a fresh cancel against the now-finished run is a clean no-op
    // (nothing active to cancel), proving the run is genuinely registered
    // and settled, not stuck in limbo.
    delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
    expect(await cancelRun(pendingRunId)).toBe(false);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  }
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 5 — Delete mid-spawn: deleting the task while the detached spawn is still
 *     in flight must not leak a registered/running run and must not throw.
 * ────────────────────────────────────────────────────────────────────────── */

test("delete mid-spawn: deleting the task before a slow spawn settles leaves no running run and no exception", async () => {
  process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS = String(SLOW_SPAWN_DELAY_MS);
  try {
    const { startTask, deleteTask } = await import("./orchestrator.ts");
    const { tasks, runs } = await import("./db.ts");

    const taskId = await makeTask("delete-mid-spawn");
    const res = await startTask(taskId);
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.pending).toBe(true);
    const runId = res.runId;

    expect(runs.get(runId)?.status).toBe("running");

    // Delete before the detached spawn has had a chance to settle.
    await deleteTask(taskId);
    expect(tasks.get(taskId)).toBeNull();

    // Give the detached continuation time to observe the deleted task (its
    // ownership guard) and settle without throwing.
    await new Promise((r) => setTimeout(r, SLOW_SPAWN_DELAY_MS + 800));

    // Cascade-deleted with the task — no leaked/registered run row.
    expect(runs.get(runId)).toBeNull();
    expect(tasks.get(taskId)).toBeNull();
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  }
});

// NOTE on bullet 6 (`raceSpawnBudget` itself): it is a plain module-private
// `async function` in src/bun/orchestrator.ts with no `export` keyword (grep
// confirms it's referenced only from within orchestrator.ts itself —
// `startTaskInner`, `spawnResumedSessionInner`, and a doc comment), so it
// cannot be imported and exercised directly from this test file. No test for
// it is included here; its behavior (racing a detached continuation against
// `SPAWN_RESPONSE_BUDGET_MS`, asserted against directly above) is covered
// indirectly by tests 2-5, which all depend on it behaving correctly.

/* ────────────────────────────────────────────────────────────────────────── *
 * 8 — Stop during the pending window: `cancelRun` has no `active` handle yet,
 *     records the intent, and the continuation honors it on settle — the run
 *     ends `cancelled`, the task returns to `ready`, nothing registers.
 * ────────────────────────────────────────────────────────────────────────── */

test("cancel mid-spawn: Stop during the pending window is honored once the spawn settles", async () => {
  process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS = String(SLOW_SPAWN_DELAY_MS);
  try {
    const { startTask, cancelRun } = await import("./orchestrator.ts");
    const { tasks, runs } = await import("./db.ts");

    const taskId = await makeTask("cancel-mid-spawn");
    const res = await startTask(taskId);
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.pending).toBe(true);
    const runId = res.runId;

    // Before the fix this returned false ("nothing to stop") and the spawn
    // registered a live run the user had already stopped.
    expect(await cancelRun(runId)).toBe(true);

    await waitFor(() => runs.get(runId)?.status === "cancelled", SLOW_SPAWN_DELAY_MS + 3000);
    expect(tasks.get(taskId)?.column).toBe("ready");
    // Nothing registered: a second Stop finds no active handle and no
    // pending run to record (the run is no longer `running`).
    expect(await cancelRun(runId)).toBe(false);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  }
});

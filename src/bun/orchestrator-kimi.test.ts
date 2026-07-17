import { test, expect, beforeAll, describe } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.ts captures AGETOR_DATA_DIR at first import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-kimi-orch-"));
// Drive kimi through the in-process fake (no tmux, no real CLI). The fake
// emits canned chunks and calls onSessionId with a synthetic
// `fake-kimi-session-<taskId>` id (mirroring codex's `fake-codex-thread-`
// pattern), so we can exercise the orchestrator's kimi session bookkeeping +
// multi-turn queue routing deterministically.
process.env.AGETOR_KIMI_DRIVER = "fake";
// Availability probe (`checkHarness`) still runs in startTask; point the
// kimi bin at /bin/echo so `--version` succeeds on CI hosts without kimi
// installed.
process.env.AGETOR_KIMI_BIN = "/bin/echo";
// Fast backoff for the exit-75 auto-retry suite below — orchestrator.ts's
// `kimiRetryDelayMs` reads this fresh on every call, so individual tests can
// still override it locally (and MUST restore it in a finally block) when
// they need a wider window to mutate env vars between "failure settled" and
// "retry timer fires".
process.env.AGETOR_KIMI_RETRY_DELAY_MS = "10";

beforeAll(async () => {
  await import("./db.ts");
});

async function settle(ms = 80) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Poll `predicate` until it's true, instead of a fixed `settle()` sleep —
 *  the exit-75 retry suite below chains multiple timers (fake-driver resolve
 *  delay + backoff delay, repeated across up to 3 runs), so a fixed sleep
 *  budget is either too slow (wastes wall time) or flaky under load (the
 *  timers don't fire before the assertion runs). Throws with `label` on
 *  timeout so a failure points at which condition never became true. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Temporarily override `AGETOR_KIMI_RETRY_DELAY_MS`, restoring the module's
 *  fast default (see top of file) afterward. Used by tests that need a wider
 *  backoff window to deterministically mutate env vars (or call
 *  cancelRun/deleteTask) between "failure settled" and "retry timer fires".
 *  `fn` is awaited BEFORE the restore runs (a plain try/finally around a sync
 *  call would restore the env var immediately, before any of the test's
 *  awaited work — including the timers this override exists to widen — ever
 *  ran). */
async function withRetryDelayMs<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.AGETOR_KIMI_RETRY_DELAY_MS;
  process.env.AGETOR_KIMI_RETRY_DELAY_MS = String(ms);
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.AGETOR_KIMI_RETRY_DELAY_MS;
    else process.env.AGETOR_KIMI_RETRY_DELAY_MS = prev;
  }
}

/** Write an executable fake `tmux` that always exits `code`, then point
 *  AGETOR_TMUX_BIN at it. Mirrors reconcile.test.ts's `fakeTmux` helper
 *  exactly — used only around the `reconcileOrphans()` call below to avoid
 *  the documented hermeticity trap: `reconcileOrphans` reads
 *  `AGETOR_TMUX_BIN` at call time, and a sibling test file sharing this bun
 *  test process may have left it pointing at a report-ALIVE fake (or a real
 *  tmux), which would make the "dead session" case in this file flaky.
 *  Returns a restore fn; callers must call it (use try/finally).
 */
function fakeTmux(code: number, stderr = "") {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-kimi-orch-faketmux-"));
  const bin = path.join(dir, "tmux");
  writeFileSync(bin, `#!/bin/sh\n>&2 printf '%s' ${JSON.stringify(stderr)}\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  const prev = process.env.AGETOR_TMUX_BIN;
  process.env.AGETOR_TMUX_BIN = bin;
  return () => {
    if (prev === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = prev;
  };
}

test("startTask (kimi) sets tmux_session + persists the session id as kimi_session_id (not codex's or claude's)", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { runs, tasks, harnesses } = await import("./db.ts");
  const { sessionNameFor } = await import("./claude-tmux.ts");
  harnesses.setEnabled("kimi", true);

  const created = await createTask({
    title: "kimi run",
    prompt: "do a thing",
    agent: "kimi",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);

  await settle();
  const list = runs.listForTask(taskId);
  expect(list.length).toBe(1);
  // Both codex and kimi host their turn in a per-task tmux session.
  expect(list[0]?.tmuxSession).toBe(sessionNameFor(taskId));
  // The fake reports a synthetic session id via onSessionId → kimi_session_id.
  expect(list[0]?.kimiSessionId).toBe(`fake-kimi-session-${taskId}`);
  // Regression guard for the silent-misroute ternary: kimi's id must land on
  // its own column, never on codex's or claude's.
  expect(list[0]?.codexSessionId).toBeNull();
  expect(list[0]?.claudeSessionId).toBeNull();
  // The fake resolves done(0) → succeeded → review column.
  expect(list[0]?.status).toBe("succeeded");
  expect(tasks.get(taskId)?.column).toBe("review");
});

test("startTask (kimi) refuses to run while the harness is disabled, and mutates nothing", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { db, runs, tasks, harnesses } = await import("./db.ts");

  harnesses.setEnabled("kimi", false);
  try {
    const created = await createTask({
      title: "should not run",
      prompt: "noop",
      agent: "kimi",
      workdir: process.cwd(),
      isolation: "none",
      taskType: "task",
    });
    if ("error" in created) throw new Error(created.error);
    const taskId = created.task.id;
    const beforeColumn = tasks.get(taskId)?.column;

    const res = await startTask(taskId);
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/disabled/i);

    // Nothing mutated: no run row, task still sitting wherever createTask
    // put it, no run id attached.
    expect(runs.listForTask(taskId).length).toBe(0);
    const after = tasks.get(taskId);
    expect(after?.column).toBe(beforeColumn);
    expect(after?.runId).toBeNull();

    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  } finally {
    // Re-enable so later tests in this file (which share the process-level
    // DB) aren't blocked by a harness this test intentionally disabled.
    harnesses.setEnabled("kimi", true);
  }
});

test("sendInput (kimi, idle) spawns a NEW run row that resumes the same kimi session", async () => {
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("kimi", true);

  const created = await createTask({
    title: "kimi multiturn",
    prompt: "turn one",
    agent: "kimi",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  await settle(); // let the first turn resolve (fake done at ~20ms)

  const firstRunId = "runId" in started ? started.runId : "";
  const res = await sendInput(firstRunId, "turn two");
  expect(res.delivered).toBe(true);
  await settle();

  const list = runs.listForTask(taskId);
  // One row per turn — the follow-up is its own run, not folded into the first
  // (kimi is a one-shot-per-turn queue model, same as codex).
  expect(list.length).toBe(2);
  const newRunId = res.delivered ? res.runId : "";
  expect(newRunId).not.toBe(firstRunId);
  // The resumed turn carries the same session id forward.
  const newRun = list.find((r) => r.id === newRunId);
  expect(newRun?.kimiSessionId).toBe(`fake-kimi-session-${taskId}`);
  expect(newRun?.codexSessionId).toBeNull();
  expect(newRun?.claudeSessionId).toBeNull();
});

test("sendInput (kimi, busy) queues the follow-up; it spawns after the active turn resolves (no second concurrent run)", async () => {
  // Exploit the fake's ~20ms resolve window: a follow-up sent in the same
  // tick as start lands while the first turn is still active, so it must
  // queue (no new row yet) and then drain into a second run once the first
  // resolves. Mirrors the codex busy-queue test.
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("kimi", true);

  const created = await createTask({
    title: "kimi queue",
    prompt: "turn one",
    agent: "kimi",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  const firstRunId = "runId" in started ? started.runId : "";

  // Send immediately — the first turn's fake hasn't resolved yet, so this
  // folds into the queue and reports the still-active run id.
  const res = await sendInput(firstRunId, "queued turn");
  expect(res.delivered).toBe(true);
  if (res.delivered) expect(res.runId).toBe(firstRunId); // attached to active run

  // Right away there should still be just one run row (the queued turn
  // hasn't spawned yet) — no second concurrent run.
  expect(runs.listForTask(taskId).length).toBe(1);

  // After both turns drain, there are exactly two run rows.
  await settle(200);
  expect(runs.listForTask(taskId).length).toBe(2);
});

test("deleteTask on a kimi task doesn't throw and clears state", async () => {
  const { createTask, startTask, deleteTask } = await import("./orchestrator.ts");
  const { runs, tasks, harnesses } = await import("./db.ts");
  harnesses.setEnabled("kimi", true);

  const created = await createTask({
    title: "kimi to delete",
    prompt: "turn one",
    agent: "kimi",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  await settle();

  // Assertion is implicit: an unhandled rejection would fail this test.
  await deleteTask(taskId);

  expect(tasks.get(taskId)).toBeNull();
  // Run rows cascade-delete with the task (runs.task_id has ON DELETE CASCADE).
  expect(runs.listForTask(taskId).length).toBe(0);
});

test("agent-switch away from kimi (reconcileTaskSession) drops this task's kimi turn queue without touching a sibling kimi task's queue", async () => {
  // Simulates the PATCH /tasks/:id agent-switch arm: server.ts calls
  // reconcileTaskSession(taskId, before, after) after persisting the new
  // agent. On a cross-kind switch it must drop THIS task's queued kimi
  // follow-up (dropKimiSession + kimiTurnQueue.delete) — and, since both are
  // keyed by taskId, a sibling kimi task's own queue must be left untouched.
  const { createTask, startTask, sendInput, reconcileTaskSession } = await import("./orchestrator.ts");
  const { runs, tasks, harnesses } = await import("./db.ts");
  harnesses.setEnabled("kimi", true);

  async function startAndQueue(title: string) {
    const created = await createTask({
      title,
      prompt: "turn one",
      agent: "kimi",
      workdir: process.cwd(),
      isolation: "none",
      taskType: "task",
    });
    if ("error" in created) throw new Error(created.error);
    const taskId = created.task.id;
    const started = await startTask(taskId);
    if ("error" in started) throw new Error(started.error);
    const firstRunId = "runId" in started ? started.runId : "";
    // Queue a follow-up while the first turn is still active.
    const res = await sendInput(firstRunId, "queued turn");
    expect(res.delivered).toBe(true);
    expect(runs.listForTask(taskId).length).toBe(1);
    return taskId;
  }

  const switchedTaskId = await startAndQueue("kimi switch-away");
  const siblingTaskId = await startAndQueue("kimi sibling");

  // Switch `switchedTaskId` away from kimi while its queued follow-up is
  // still pending. This must drop its queue entry so the drain (which fires
  // once the active turn resolves) doesn't spawn the stale follow-up against
  // the new harness.
  const before = tasks.get(switchedTaskId);
  if (!before) throw new Error("switched task vanished");
  const after = { ...before, agent: "codex" };
  await reconcileTaskSession(switchedTaskId, before, after);

  // Let both tasks' active fake turns resolve and any drain fire.
  await settle(200);

  // Switched task: the teardown arm dropped its queued follow-up — still
  // just the one run row from startTask, no second run spawned.
  expect(runs.listForTask(switchedTaskId).length).toBe(1);

  // Sibling kimi task: untouched by the switch on the other task — its own
  // queued follow-up drains normally into a second run row.
  expect(runs.listForTask(siblingTaskId).length).toBe(2);
});

test("reconcileOrphans: a kimi run left status='running' with a dead tmux session flips to orphaned, task back to ready", async () => {
  const { createTask, reconcileOrphans } = await import("./orchestrator.ts");
  const { runs, tasks, harnesses } = await import("./db.ts");
  const { sessionNameFor } = await import("./claude-tmux.ts");
  harnesses.setEnabled("kimi", true);

  const created = await createTask({
    title: "kimi orphan",
    prompt: "turn one",
    agent: "kimi",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  const runId = randomUUID();
  const now = Date.now();

  // Simulate a run left `running` by a previous agetor process: task parked
  // in `running` with a run id, the run row itself `status='running'` with a
  // tmux session name + a persisted kimi session id (so `canTryReattach`'s
  // key checks pass) — but no live tmux session behind it.
  tasks.update(taskId, { column: "running", runId });
  runs.insert({
    id: runId,
    taskId,
    agent: "kimi",
    status: "running",
    startedAt: now,
    endedAt: null,
    exitCode: null,
    tmuxSession: sessionNameFor(taskId),
    claudeSessionId: null,
    codexSessionId: null,
    kimiSessionId: `fake-kimi-session-${taskId}`,
  });

  // HERMETICITY TRAP: reconcileOrphans reads AGETOR_TMUX_BIN at call time.
  // A sibling test file in the shared bun-test process may leave it pointing
  // at a report-ALIVE fake (or nothing, falling through to a real tmux) —
  // stub a report-gone fake around the call and restore immediately after,
  // exactly like reconcile.test.ts's fakeTmux usage.
  const restoreTmux = fakeTmux(1, "can't find session");
  let reconciled: number;
  try {
    reconciled = reconcileOrphans();
  } finally {
    restoreTmux();
  }

  expect(reconciled).toBeGreaterThanOrEqual(1);
  const run = runs.get(runId);
  expect(run?.status).toBe("orphaned");
  const task = tasks.get(taskId);
  expect(task?.column).toBe("ready");
  expect(task?.runId).toBeNull();
});

/** Create a kimi task via the real orchestrator path (createTask), enabling
 *  the kimi harness first. Shared by every test in the exit-75 retry suite
 *  below so each test starts from an identical, freshly-created task. */
async function createKimiTask(title: string, prompt = "turn one"): Promise<string> {
  const { createTask } = await import("./orchestrator.ts");
  const { harnesses } = await import("./db.ts");
  harnesses.setEnabled("kimi", true);
  const created = await createTask({
    title,
    prompt,
    agent: "kimi",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}

describe("kimi exit-75 auto-retry (orchestrator.ts: kimiRetryState / scheduleKimiRetry / fireKimiRetry)", () => {
  test("retryable exit (75) schedules a backoff retry: task stays running, retry succeeds, task lands review with the resumed session id", async () => {
    const { startTask } = await import("./orchestrator.ts");
    const { runs, tasks } = await import("./db.ts");
    const taskId = await createKimiTask("kimi retry then success");

    process.env.AGETOR_FAKE_KIMI_EXIT_CODE = "75";
    try {
      await withRetryDelayMs(150, async () => {
        const started = await startTask(taskId);
        if ("error" in started) throw new Error(started.error);
        const firstRunId = "runId" in started ? started.runId : "";

        // First turn resolves failed(75) at ~20ms (fake driver) — well
        // inside the 150ms backoff window this test needs.
        await waitFor(() => runs.get(firstRunId)?.status === "failed", "first run settles failed");
        expect(runs.get(firstRunId)?.exitCode).toBe(75);
        // The retry machinery deliberately skips the column flip — unlike an
        // ordinary failure, the task stays `running`, not bounced to `ready`.
        expect(tasks.get(taskId)?.column).toBe("running");
        const events = runs.events(firstRunId);
        expect(events.some((e) => e.stream === "status" && /retrying after exit 75/.test(e.data))).toBe(true);
        // The retry hasn't fired yet — still just the one run row.
        expect(runs.listForTask(taskId).length).toBe(1);

        // Unset the fake exit code now, well inside the 150ms backoff
        // window, so the re-spawned turn (once the timer fires) succeeds.
        delete process.env.AGETOR_FAKE_KIMI_EXIT_CODE;

        await waitFor(() => runs.listForTask(taskId).length === 2, "retry run spawns");
        const secondRun = runs.listForTask(taskId).find((r) => r.id !== firstRunId);
        if (!secondRun) throw new Error("retry run not found");
        await waitFor(() => runs.get(secondRun.id)?.status === "succeeded", "retry run succeeds");

        expect(tasks.get(taskId)?.column).toBe("review");
        expect(runs.get(secondRun.id)?.kimiSessionId).toBe(runs.get(firstRunId)?.kimiSessionId);
        expect(runs.get(secondRun.id)?.codexSessionId).toBeNull();
        expect(runs.get(secondRun.id)?.claudeSessionId).toBeNull();
      });
    } finally {
      delete process.env.AGETOR_FAKE_KIMI_EXIT_CODE;
    }
  });

  test("cap exhaustion: retry budget (2) exhausts after the initial failure — 3 total runs, all failed, task back to ready", async () => {
    const { startTask } = await import("./orchestrator.ts");
    const { runs, tasks } = await import("./db.ts");
    const taskId = await createKimiTask("kimi cap exhaustion");

    process.env.AGETOR_FAKE_KIMI_EXIT_CODE = "75";
    try {
      await withRetryDelayMs(10, async () => {
        const started = await startTask(taskId);
        if ("error" in started) throw new Error(started.error);

        // Initial run + 2 retries = 3 runs total, then the task lands back
        // on `ready` once the budget (KIMI_RETRY_MAX = 2) is exhausted.
        await waitFor(
          () => tasks.get(taskId)?.column === "ready",
          "task exhausts retry budget and lands ready",
          8000,
        );

        const list = runs.listForTask(taskId);
        expect(list.length).toBe(3);
        for (const run of list) {
          expect(run.status).toBe("failed");
          expect(run.exitCode).toBe(75);
        }
        // Attempts are numbered 1/2 then 2/2 across the two retry-scheduling
        // events (recorded on the initial run and the first retry's run,
        // respectively — the third failure exhausts the budget and records
        // no further "retrying" event).
        const allEvents = list.flatMap((r) => runs.events(r.id));
        expect(allEvents.some((e) => e.stream === "status" && /attempt 1\/2/.test(e.data))).toBe(true);
        expect(allEvents.some((e) => e.stream === "status" && /attempt 2\/2/.test(e.data))).toBe(true);

        // No further retry fires after the cap — wait comfortably past
        // another backoff window and confirm the run count is stable.
        await settle(300);
        expect(runs.listForTask(taskId).length).toBe(3);
      });
    } finally {
      delete process.env.AGETOR_FAKE_KIMI_EXIT_CODE;
    }
  });

  test("non-retryable exit code (1) fails normally — no retry status event, no second run after waiting past the backoff window", async () => {
    const { startTask } = await import("./orchestrator.ts");
    const { runs, tasks } = await import("./db.ts");
    const taskId = await createKimiTask("kimi non-retryable exit");

    process.env.AGETOR_FAKE_KIMI_EXIT_CODE = "1";
    try {
      await withRetryDelayMs(10, async () => {
        const started = await startTask(taskId);
        if ("error" in started) throw new Error(started.error);
        const firstRunId = "runId" in started ? started.runId : "";

        await waitFor(() => tasks.get(taskId)?.column === "ready", "ordinary failure lands ready");

        const list = runs.listForTask(taskId);
        expect(list.length).toBe(1);
        expect(list[0]?.status).toBe("failed");
        expect(list[0]?.exitCode).toBe(1);
        const events = runs.events(firstRunId);
        expect(events.some((e) => e.stream === "status" && /retrying after exit 75/.test(e.data))).toBe(false);

        // Wait well past a retry backoff window — still no second run.
        await settle(200);
        expect(runs.listForTask(taskId).length).toBe(1);
      });
    } finally {
      delete process.env.AGETOR_FAKE_KIMI_EXIT_CODE;
    }
  });

  test("Stop during backoff cancels the pending retry timer, lands the task ready with runId cleared, no retry run spawns", async () => {
    const { startTask, cancelRun } = await import("./orchestrator.ts");
    const { runs, tasks } = await import("./db.ts");
    const taskId = await createKimiTask("kimi stop during backoff");

    process.env.AGETOR_FAKE_KIMI_EXIT_CODE = "75";
    try {
      await withRetryDelayMs(150, async () => {
        const started = await startTask(taskId);
        if ("error" in started) throw new Error(started.error);
        const firstRunId = "runId" in started ? started.runId : "";

        await waitFor(() => runs.get(firstRunId)?.status === "failed", "first run settles failed");
        expect(tasks.get(taskId)?.column).toBe("running"); // retry pending

        const cancelled = cancelRun(firstRunId);
        expect(cancelled).toBe(true);

        expect(tasks.get(taskId)?.column).toBe("ready");
        expect(tasks.get(taskId)?.runId).toBeNull();
        const events = runs.events(firstRunId);
        expect(events.some((e) => e.stream === "status" && e.data === "kimi retry cancelled by user")).toBe(true);

        // Wait well past the 150ms backoff window — the cancelled timer must
        // not fire, so no retry run ever spawns.
        await settle(300);
        expect(runs.listForTask(taskId).length).toBe(1);
      });
    } finally {
      delete process.env.AGETOR_FAKE_KIMI_EXIT_CODE;
    }
  });

  test("deleteTask during backoff clears the pending retry timer without throwing or spawning a stray run", async () => {
    const { startTask, deleteTask } = await import("./orchestrator.ts");
    const { runs, tasks } = await import("./db.ts");
    const taskId = await createKimiTask("kimi delete during backoff");

    process.env.AGETOR_FAKE_KIMI_EXIT_CODE = "75";
    try {
      await withRetryDelayMs(150, async () => {
        const started = await startTask(taskId);
        if ("error" in started) throw new Error(started.error);
        const firstRunId = "runId" in started ? started.runId : "";

        await waitFor(() => runs.get(firstRunId)?.status === "failed", "first run settles failed");
        expect(tasks.get(taskId)?.column).toBe("running"); // retry pending

        // Assertion is implicit: an unhandled rejection (the fleet-known
        // post-delete FK-error race on a spawn that outlives the task row)
        // would fail this test.
        await deleteTask(taskId);
        expect(tasks.get(taskId)).toBeNull();

        // Wait well past the 150ms backoff window — the retry timer was
        // cleared by deleteTask's clearKimiRetryState, so no run rows
        // resurrect for a task that no longer exists.
        await settle(300);
        expect(runs.listForTask(taskId).length).toBe(0);
      });
    } finally {
      delete process.env.AGETOR_FAKE_KIMI_EXIT_CODE;
    }
  });

  test("retry counter resets on an ordinary failure — a later retryable exit on a new turn starts a fresh attempt count", async () => {
    const { startTask, sendInput } = await import("./orchestrator.ts");
    const { runs, tasks } = await import("./db.ts");
    const taskId = await createKimiTask("kimi counter reset");

    process.env.AGETOR_FAKE_KIMI_EXIT_CODE = "75";
    let runAId = "";
    try {
      await withRetryDelayMs(150, async () => {
        const started = await startTask(taskId);
        if ("error" in started) throw new Error(started.error);
        runAId = "runId" in started ? started.runId : "";

        // Run A exits 75 → retry attempt 1/2 scheduled.
        await waitFor(() => runs.get(runAId)?.status === "failed", "run A settles failed");
        expect(runs.events(runAId).some((e) => e.stream === "status" && /attempt 1\/2/.test(e.data))).toBe(true);

        // Flip the fake to an ordinary non-retryable exit before the retry
        // fires, so run A's retry (run B) fails normally — an ordinary
        // failure, not a retryable one — clearing the retry state (count
        // reset) rather than scheduling attempt 2/2.
        process.env.AGETOR_FAKE_KIMI_EXIT_CODE = "1";
        await waitFor(() => runs.listForTask(taskId).length === 2, "run B (the retry) spawns");
        const runB = runs.listForTask(taskId).find((r) => r.id !== runAId);
        if (!runB) throw new Error("retry run B not found");
        await waitFor(() => runs.get(runB.id)?.status === "failed", "run B settles failed");
        expect(runs.get(runB.id)?.exitCode).toBe(1);
        expect(tasks.get(taskId)?.column).toBe("ready");
      });

      // New turn, exit 75 again — must get a FRESH attempt count (1/2), not
      // inherit run A's already-exhausted-looking streak.
      process.env.AGETOR_FAKE_KIMI_EXIT_CODE = "75";
      const res = await withRetryDelayMs(150, () => sendInput(runAId, "a fresh turn"));
      expect(res.delivered).toBe(true);
      const runCId = res.delivered ? res.runId : "";
      expect(runCId).not.toBe(runAId);

      await waitFor(() => runs.get(runCId)?.status === "failed", "run C settles failed");
      const runCEvents = runs.events(runCId);
      expect(runCEvents.some((e) => e.stream === "status" && /attempt 1\/2/.test(e.data))).toBe(true);
      expect(runCEvents.some((e) => e.stream === "status" && /attempt 2\/2/.test(e.data))).toBe(false);
    } finally {
      delete process.env.AGETOR_FAKE_KIMI_EXIT_CODE;
    }
  });

  test("reconcileOrphans: a kimi task stranded mid-retry-backoff across a restart flips to ready, without touching a claude-code task in the same held-running shape", async () => {
    const { createTask, reconcileOrphans } = await import("./orchestrator.ts");
    const { runs, tasks, harnesses } = await import("./db.ts");
    const { sessionNameFor } = await import("./claude-tmux.ts");
    harnesses.setEnabled("kimi", true);

    // Kimi task: simulate the crash-during-backoff state directly. The
    // pending retry timer is pure in-memory state (kimiRetryState) that does
    // not survive a restart — on a fresh process the task is stuck in
    // `column: 'running'` pointing at an already-`failed` run whose retry
    // never got to fire.
    const kimiCreated = await createTask({
      title: "kimi strand sweep",
      prompt: "turn one",
      agent: "kimi",
      workdir: process.cwd(),
      isolation: "none",
      taskType: "task",
    });
    if ("error" in kimiCreated) throw new Error(kimiCreated.error);
    const kimiTaskId = kimiCreated.task.id;
    const kimiRunId = randomUUID();
    const now = Date.now();
    tasks.update(kimiTaskId, { column: "running", runId: kimiRunId });
    runs.insert({
      id: kimiRunId,
      taskId: kimiTaskId,
      agent: "kimi",
      status: "failed",
      startedAt: now,
      endedAt: now,
      exitCode: 75,
      tmuxSession: sessionNameFor(kimiTaskId),
      claudeSessionId: null,
      codexSessionId: null,
      kimiSessionId: `fake-kimi-session-${kimiTaskId}`,
    });

    // claude-code task in the SAME held-running shape (column running,
    // runId pointing at an already-terminal run) — the sweep is kind-scoped
    // to kimi, so this control task must be left completely untouched.
    const claudeCreated = await createTask({
      title: "claude held-running shape (control)",
      prompt: "turn one",
      agent: "claude-code",
      workdir: process.cwd(),
      isolation: "none",
      taskType: "task",
    });
    if ("error" in claudeCreated) throw new Error(claudeCreated.error);
    const claudeTaskId = claudeCreated.task.id;
    const claudeRunId = randomUUID();
    tasks.update(claudeTaskId, { column: "running", runId: claudeRunId });
    runs.insert({
      id: claudeRunId,
      taskId: claudeTaskId,
      agent: "claude-code",
      status: "failed",
      startedAt: now,
      endedAt: now,
      exitCode: 1,
      tmuxSession: sessionNameFor(claudeTaskId),
      claudeSessionId: `fake-claude-session-${claudeTaskId}`,
      codexSessionId: null,
      kimiSessionId: null,
    });

    // HERMETICITY TRAP (same as the orphan test above): stub a report-gone
    // tmux fake around the call.
    const restoreTmux = fakeTmux(1, "can't find session");
    try {
      reconcileOrphans();
    } finally {
      restoreTmux();
    }

    // Kimi task: swept — flipped to ready, runId cleared, status event says so.
    const kimiTask = tasks.get(kimiTaskId);
    expect(kimiTask?.column).toBe("ready");
    expect(kimiTask?.runId).toBeNull();
    const kimiEvents = runs.events(kimiRunId);
    expect(kimiEvents.some((e) => e.stream === "status" && /retry window lost/.test(e.data))).toBe(true);

    // Claude-code control task: untouched — still parked in `running` with
    // its runId intact.
    const claudeTask = tasks.get(claudeTaskId);
    expect(claudeTask?.column).toBe("running");
    expect(claudeTask?.runId).toBe(claudeRunId);
  });
});

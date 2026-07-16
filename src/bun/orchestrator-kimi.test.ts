import { test, expect, beforeAll } from "bun:test";
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

beforeAll(async () => {
  await import("./db.ts");
});

async function settle(ms = 80) {
  await new Promise((r) => setTimeout(r, ms));
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

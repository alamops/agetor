import { test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import — `beforeAll`
// would race with any sibling test file that already imported db.ts.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-test-"));
// Drive claude through an in-process fake instead of tmux + the real CLI.
// AGETOR_CLAUDE_BIN is also overridden so the agent-status preflight inside
// startTask passes without claude installed. Mirrors
// orchestrator-archive-teardown.test.ts / worktrees-list.test.ts, both of
// which set these same four vars at top level without restoring them —
// established precedent that this doesn't disturb sibling files (only
// AGETOR_CODEX_DRIVER=fake is the one that's known to break reconcile.test.ts,
// per subagent-hold.test.ts's warning, and this file never touches codex).
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo"; // tmux probe in agent-status passes
process.env.AGETOR_CLAUDE_ARGS = "";

/*
 * Covers `archiveTask({ stopRun })` (docs/plans/archive-should-also-stop.md
 * §5, task T1) — archiving a task that has an in-flight or
 * held-by-background-agents run, via the same stop path the Stop button
 * uses (`stopActiveHandle` / `stopHeldTask`, shared with `cancelRun`).
 *
 * IMPORTANT — shared-DB hygiene (see subagent-hold.test.ts and
 * reconcile.test.ts): `bun test` runs every *.test.ts in one process against
 * one SQLite DB, and `reconcileOrphans`' boot pass scans `runs WHERE
 * status='running'` / `tasks WHERE column='running'` globally. Every task
 * created here is tracked and hard-deleted in `afterEach` so a task left in
 * `running` (or with a `running` run row) by an assertion failure can't leak
 * into a sibling file.
 */

const createdTaskIds: string[] = [];

afterEach(async () => {
  const { db } = await import("./db.ts");
  for (const id of createdTaskIds.splice(0)) {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// isolation: "none" — no worktree is materialized, so there's nothing for
// archiveTask's deferred teardown to detach and no need to await
// `pendingTeardown` in cleanup (worktree.ts's `detachWorktree` no-ops
// immediately when `task.worktreePath` is null). Keeps these tests focused
// on the stop-then-archive behavior rather than worktree plumbing already
// covered by orchestrator-archive-teardown.test.ts.
async function createClaudeTask(title: string): Promise<string> {
  const { createTask } = await import("./orchestrator.ts");
  const created = await createTask({
    title,
    prompt: "hello",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  createdTaskIds.push(created.task.id);
  return created.task.id;
}

// Mirrors subagent-hold.test.ts's helper — inserts a `running` subagent row
// so `isHeldByBackgroundAgents` reads true once the terminal run succeeds.
async function insertRunningSubagent(taskId: string): Promise<string> {
  const { subagents } = await import("./db.ts");
  const id = `agent-${randomUUID()}`;
  subagents.insertIfAbsent({
    id,
    taskId,
    runId: null, // the gate only keys off task_id — see subagents.hasRunning
    parentKind: "subagent",
    agentType: "Explore",
    description: "test subagent",
    spawnDepth: 1,
    sourcePath: `/tmp/${id}.jsonl`,
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
  });
  return id;
}

test("(a) archive without stopRun on a task with an active run returns the guard error, leaves the task unarchived, and the run active", async () => {
  const { createTask: _unused, startTask, archiveTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const taskId = await createClaudeTask("no-stopRun-active-run");
  const started = await startTask(taskId);
  if (!("runId" in started)) throw new Error("expected the run to start");
  const runId = started.runId;

  // `force: true` is needed to get past the done-only column gate (the task
  // is in `running`, not `done`) so the assertion actually exercises the
  // active-run guard rather than the column gate. No await between
  // `startTask` resolving and this call — the fake driver's ~20ms `done`
  // timer must not have fired yet, or the run would already be out of
  // `active` (see worktrees-list.test.ts's "force still rejects an active
  // run" for the same timing-sensitive pattern).
  const result = await archiveTask(taskId, { force: true });
  expect("error" in result).toBe(true);
  if ("error" in result) {
    expect(result.error).toBe("task is still running — cancel the run before archiving");
  }

  expect(tasks.get(taskId)?.archivedAt).toBeNull();
  expect(runs.get(runId)?.status).toBe("running");

  // Let the fake turn resolve normally so no `status='running'` row survives
  // this test for reconcileOrphans to trip over.
  await wait(250);
  expect(runs.get(runId)?.status).toBe("succeeded");
});

test("(b) archive with force+stopRun on a task with an active run kills the handle, cancels the run, and cancels pending interactions", async () => {
  const { startTask, archiveTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");
  const { __getFakeDriver } = await import("./agents.ts");
  const { registerTmuxPrompt, listPendingForTask } = await import("./interactions.ts");

  const taskId = await createClaudeTask("stopRun-active-run");
  const started = await startTask(taskId);
  if (!("runId" in started)) throw new Error("expected the run to start");
  const runId = started.runId;

  // A pending interaction for this run — mirrors what a claude tmux-pane
  // scraper prompt looks like. `cancelPendingForTask` (called inside
  // `stopActiveHandle`) must resolve it with the `__cancelled__` sentinel
  // before the session is killed, so the waiting curl/MCP client unblocks
  // immediately instead of hanging until its own timeout.
  const pending = registerTmuxPrompt({
    taskId,
    runId,
    paneText: "Do you want to proceed?",
    choices: [{ key: "1", label: "Yes" }],
    fingerprint: "archive-stop-fp",
  });

  // No await between `startTask` resolving and this call — the run must
  // still be in the in-memory `active` map so this exercises
  // `stopActiveHandle`, not the held-task branch.
  const result = await archiveTask(taskId, { force: true, stopRun: true });
  expect("task" in result).toBe(true);
  if (!("task" in result)) throw new Error(result.error);
  expect(result.task.archivedAt).not.toBeNull();

  // The active handle's `kill()` was invoked synchronously inside
  // `archiveTask` (via `stopActiveHandle`), well before the fake driver's
  // own ~20ms `done` timer would have fired on its own.
  const fake = __getFakeDriver(taskId);
  expect(fake?._record).toContain("kill");

  // The pending interaction was resolved with the cancellation sentinel and
  // dropped from the registry.
  await expect(pending.answer).resolves.toEqual({ key: "__cancelled__" });
  expect(listPendingForTask(taskId)).toEqual([]);

  // `stopActiveHandle` marks every handle for this task `cancelled = true`
  // before killing it, so once the fake driver's `done` promise resolves,
  // `attachDoneHandler` must record the run as "cancelled" — not
  // "succeeded", which is what a plain, unstopped fake turn would produce.
  await wait(250);
  expect(runs.get(runId)?.status).toBe("cancelled");
  expect(tasks.get(taskId)?.archivedAt).not.toBeNull();
});

test("(c) archive with force+stopRun on a held (background-agents) task interrupts the session, orphans the subagents, and archives", async () => {
  const { startTask, archiveTask } = await import("./orchestrator.ts");
  const { tasks, runs, subagents } = await import("./db.ts");

  const taskId = await createClaudeTask("stopRun-held-task");
  await insertRunningSubagent(taskId);

  const started = await startTask(taskId);
  if (!("runId" in started)) throw new Error("expected the run to start");
  const runId = started.runId;

  // Let the fake turn succeed and the hold gate engage: column stays
  // `running`, the run row is `succeeded`, and the subagent row is still
  // `running` — the exact state `isHeldByBackgroundAgents` reads. There is
  // no `active` handle for this run anymore (it was deleted the moment
  // `agent.done` resolved), so `archiveTask`'s `stopRun` path must take the
  // `stopHeldTask` branch, not `stopActiveHandle`.
  await wait(250);

  expect(tasks.get(taskId)?.column).toBe("running");
  expect(runs.get(runId)?.status).toBe("succeeded");
  expect(subagents.hasRunning(taskId)).toBe(true);

  const result = await archiveTask(taskId, { force: true, stopRun: true });
  expect("task" in result).toBe(true);
  if (!("task" in result)) throw new Error(result.error);
  expect(result.task.archivedAt).not.toBeNull();

  // `stopHeldTask` orphaned the running subagent row (which also fires the
  // settle hook) — the hold is released.
  expect(subagents.hasRunning(taskId)).toBe(false);
});

test("(d) archive with force+stopRun on an idle task (no run at all) is a plain archive — stopRun is a no-op", async () => {
  const { archiveTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  const taskId = await createClaudeTask("stopRun-idle-task");
  // No startTask — the task has never run: `runId` is null and it isn't
  // held by background agents either.

  expect(tasks.get(taskId)?.runId).toBeNull();

  const result = await archiveTask(taskId, { force: true, stopRun: true });
  expect("task" in result).toBe(true);
  if (!("task" in result)) throw new Error(result.error);
  expect(result.task.archivedAt).not.toBeNull();
});

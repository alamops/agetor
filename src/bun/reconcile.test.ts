import { test, expect, beforeAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-reconcile-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

beforeAll(async () => {
  await import("./db.ts");
});

test("reconcileOrphans marks running rows as orphaned and returns tasks to ready", async () => {
  const { db, tasks, runs } = await import("./db.ts");
  const { reconcileOrphans } = await import("./orchestrator.ts");

  // Randomised so we don't collide with leftover rows from sibling tests
  // that share this process's SQLite db (db.ts is loaded once, so whatever
  // test imported it first determines the actual file).
  const taskId = `task-orphan-${randomUUID()}`;
  const runId = `run-orphan-${randomUUID()}`;
  const now = Date.now();
  tasks.insert({
    id: taskId,
    title: "stuck",
    prompt: "p",
    column: "running",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    worktreePath: null,
    baseRef: null,
    mode: null,
    model: null,
    effort: null,
    references: [],
    runId,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  runs.insert({
    id: runId,
    taskId,
    agent: "claude-code",
    status: "running",
    startedAt: now,
    endedAt: null,
    exitCode: null,
    tmuxSession: null,
    claudeSessionId: null, codexSessionId: null,
  });

  const reconciled = reconcileOrphans();
  expect(reconciled).toBe(1);

  const row = db.query<{ status: string }, [string]>(`SELECT status FROM runs WHERE id = ?`).get(runId);
  expect(row?.status).toBe("orphaned");

  const task = tasks.get(taskId);
  expect(task?.column).toBe("ready");
  expect(task?.runId).toBeNull();

  // A second call is a no-op.
  expect(reconcileOrphans()).toBe(0);
});

test("reattach pre-seed SQL: detects a prior api-error status row scoped to the run", async () => {
  // Locks in the query shape used by `reconcileOrphans` to pre-seed
  // `handle.apiError` on reattach. A real reattach test would need a live
  // tmux session + JSONL — too heavy — so we exercise the SQL directly
  // against three rows: the target run with a sentinel status, a sibling
  // run on the same task with the same prefix (must NOT match — pre-seed is
  // scoped to the reattached run id), and a same-run row with the prefix
  // on the wrong stream (must NOT match — only `status` rows count).
  const { db, runs, tasks } = await import("./db.ts");
  const { CLAUDE_API_ERROR_STATUS_PREFIX } = await import("./claude-tmux.ts");

  const taskId = `task-preseed-${randomUUID()}`;
  const targetRunId = `run-preseed-target-${randomUUID()}`;
  const siblingRunId = `run-preseed-sibling-${randomUUID()}`;
  const now = Date.now();
  tasks.insert({
    id: taskId,
    title: "x",
    prompt: "p",
    column: "blocked",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    worktreePath: null,
    baseRef: null,
    mode: null,
    model: null,
    effort: null,
    references: [],
    runId: targetRunId,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  // status='failed' (not 'running') so this test's rows can't be
  // re-orphaned by a sibling test that calls `reconcileOrphans` later
  // — multiple test files in one bun process share the auto-allocated
  // db.ts when the first-loaded file didn't set AGETOR_DATA_DIR. The
  // SQL we're locking in only reads run_events, not runs.status, so
  // the run-row status is irrelevant to what's being tested.
  for (const id of [targetRunId, siblingRunId]) {
    runs.insert({
      id, taskId, agent: "claude-code", status: "failed",
      startedAt: now, endedAt: now, exitCode: 1,
      tmuxSession: null, claudeSessionId: null, codexSessionId: null,
    });
  }
  // The real api-error status on the target run — must match.
  runs.appendEvent(targetRunId, "status", `${CLAUDE_API_ERROR_STATUS_PREFIX}HTTP 529 — turn aborted`);
  // Same-task sibling run with the prefix — must NOT match (different run id).
  runs.appendEvent(siblingRunId, "status", `${CLAUDE_API_ERROR_STATUS_PREFIX}HTTP 500 — turn aborted`);
  // Same-run row with the prefix on the WRONG stream — must NOT match.
  runs.appendEvent(targetRunId, "assistant", `${CLAUDE_API_ERROR_STATUS_PREFIX}HTTP 400`);

  const ask = (runId: string) => db.query<{ found: 0 | 1 }, [string, string]>(
    `SELECT EXISTS(
       SELECT 1 FROM run_events
       WHERE run_id = ? AND stream = 'status' AND data LIKE ?
     ) AS found`,
  ).get(runId, `${CLAUDE_API_ERROR_STATUS_PREFIX}%`)?.found ?? 0;

  expect(ask(targetRunId)).toBe(1);
  // Sibling row carries the prefix but on a different run id — pre-seed
  // must NOT bleed across runs of the same task.
  expect(ask(siblingRunId)).toBe(1); // sibling itself does have one — sanity check
  // A completely unrelated run with no events should return 0.
  const cleanRunId = `run-preseed-clean-${randomUUID()}`;
  runs.insert({
    id: cleanRunId, taskId, agent: "claude-code", status: "failed",
    startedAt: now, endedAt: now, exitCode: 1,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null,
  });
  expect(ask(cleanRunId)).toBe(0);
});

test("startTask honors cancel — exit handler records status 'cancelled'", async () => {
  // Codex now hosts its turn in a real tmux session (codex-tmux.ts). Point the
  // codex bin at a `sleep 30` stub so the session stays alive until cancelled;
  // cancelRun → kill the session → the driver resolves `done` and the exit
  // handler records 'cancelled' (it defers to handle.cancelled over exit code).
  // Uses real tmux (don't stub AGETOR_TMUX_BIN) so there's an actual session to
  // kill.
  const binDir = mkdtempSync(path.join(tmpdir(), "agetor-cancel-bin-"));
  const fakeBin = path.join(binDir, "fake-codex");
  writeFileSync(fakeBin, "#!/bin/sh\nexec sleep 30\n");
  chmodSync(fakeBin, 0o755);
  process.env.AGETOR_CODEX_BIN = fakeBin;
  process.env.AGETOR_CODEX_ARGS = "";

  const { createTask, startTask, cancelRun } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  // Codex is shipped disabled-by-default (see migration 016); re-enable the
  // built-in for the test database so startTask doesn't reject it.
  harnesses.setEnabled("codex", true);

  const created = await createTask({
    title: "long-running",
    prompt: "30", // sleep 30 → session blocks until killed
    agent: "codex",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);

  const started = await startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);

  // Give the tmux session a moment to come up, then cancel.
  await new Promise((r) => setTimeout(r, 250));
  expect(cancelRun(started.runId)).toBe(true);

  // Wait past the driver's kill grace + the exit handler's status flip.
  await new Promise((r) => setTimeout(r, 700));

  const list = runs.listForTask(created.task.id);
  expect(list[0]?.status).toBe("cancelled");
});

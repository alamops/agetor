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
    branch: null,
    worktreePath: null,
    baseRef: null,
    mode: null,
    model: null,
    effort: null,
    references: [],
    runId,
    hasOpenableRun: false,
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
    claudeSessionId: null,
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

test("startTask honors cancel — exit handler records status 'cancelled'", async () => {
  // Use codex's branch for this test because it still goes through Bun.spawn
  // directly (claude now goes through tmux + JSONL, which isn't substitutable
  // with a sleep script). The cancellation path through proc.kill is identical
  // between agents, so codex is a fair stand-in.
  const binDir = mkdtempSync(path.join(tmpdir(), "agetor-cancel-bin-"));
  const fakeBin = path.join(binDir, "fake-codex");
  writeFileSync(fakeBin, "#!/bin/sh\nexec sleep 30\n");
  chmodSync(fakeBin, 0o755);
  process.env.AGETOR_CODEX_BIN = fakeBin;
  process.env.AGETOR_CODEX_ARGS = "";

  const { createTask, startTask, cancelRun } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  // Codex is shipped disabled-by-default (see migration 016); the cancel
  // path being tested only goes through codex's Bun.spawn branch, so flip
  // the built-in back on for the test database.
  harnesses.setEnabled("codex", true);

  const created = await createTask({
    title: "long-running",
    prompt: "30", // sleep 30 → process will block until killed
    agent: "codex",
    workdir: process.cwd(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);

  const started = await startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);

  // Give the spawn a moment to land, then cancel.
  await new Promise((r) => setTimeout(r, 100));
  expect(cancelRun(started.runId)).toBe(true);

  // Wait for the exit handler to flip the status row.
  await new Promise((r) => setTimeout(r, 250));

  const list = runs.listForTask(created.task.id);
  expect(list[0]?.status).toBe("cancelled");
});

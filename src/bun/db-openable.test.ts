import { test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Top-level: capture AGETOR_DATA_DIR before db.ts is imported below.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-openable-"));

const { db, tasks, runs } = await import("./db.ts");

// Track created tasks for cleanup. Other test files share the same SQLite
// db when imported earlier in the process (db.ts captures AGETOR_DATA_DIR
// once), and reconcile.test.ts in particular asserts an exact count of
// orphaned `running` runs — leftover rows from our `running`-status
// fixtures here would skew that count.
const createdTaskIds: string[] = [];
afterEach(() => {
  for (const id of createdTaskIds.splice(0)) {
    db.run(`DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE task_id = ?)`, [id]);
    db.run(`DELETE FROM runs WHERE task_id = ?`, [id]);
    tasks.delete(id);
  }
});

function makeTask() {
  const now = Date.now();
  const id = randomUUID();
  tasks.insert({
    id,
    title: "t",
    prompt: "p",
    column: "ready",
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
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  createdTaskIds.push(id);
  return id;
}

function makeRun(taskId: string, status: "succeeded" | "running" | "orphaned" | "failed" | "cancelled") {
  const id = randomUUID();
  runs.insert({
    id,
    taskId,
    agent: "claude-code",
    status,
    startedAt: Date.now(),
    endedAt: status === "running" ? null : Date.now(),
    exitCode: status === "succeeded" ? 0 : status === "failed" ? 1 : null,
    tmuxSession: null,
    claudeSessionId: null,
  });
  return id;
}

test("hasOpenableRun is false for a task with no runs", () => {
  const id = makeTask();
  expect(tasks.get(id)!.hasOpenableRun).toBe(false);
});

test("hasOpenableRun stays false for tasks with only failed/cancelled runs", () => {
  const id = makeTask();
  makeRun(id, "failed");
  makeRun(id, "cancelled");
  expect(tasks.get(id)!.hasOpenableRun).toBe(false);
});

test("hasOpenableRun flips true once a succeeded run exists", () => {
  const id = makeTask();
  makeRun(id, "failed");
  expect(tasks.get(id)!.hasOpenableRun).toBe(false);
  makeRun(id, "succeeded");
  expect(tasks.get(id)!.hasOpenableRun).toBe(true);
});

test("hasOpenableRun true for a running run", () => {
  const id = makeTask();
  makeRun(id, "running");
  expect(tasks.get(id)!.hasOpenableRun).toBe(true);
});

test("hasOpenableRun true for an orphaned run", () => {
  const id = makeTask();
  makeRun(id, "orphaned");
  expect(tasks.get(id)!.hasOpenableRun).toBe(true);
});

test("tasks.list returns hasOpenableRun per row without N+1 explosion", () => {
  const a = makeTask();
  const b = makeTask();
  const c = makeTask();
  makeRun(a, "succeeded");
  makeRun(b, "failed");
  // c has no runs.

  const all = tasks.list();
  const byId = Object.fromEntries(all.map((t) => [t.id, t]));
  expect(byId[a]?.hasOpenableRun).toBe(true);
  expect(byId[b]?.hasOpenableRun).toBe(false);
  expect(byId[c]?.hasOpenableRun).toBe(false);
});

test("tasks.list does not duplicate rows when a task has multiple runs", () => {
  const id = makeTask();
  makeRun(id, "succeeded");
  makeRun(id, "running");
  makeRun(id, "failed");

  const matches = tasks.list().filter((t) => t.id === id);
  expect(matches).toHaveLength(1);
  expect(matches[0]?.hasOpenableRun).toBe(true);
});

test("db connection is live", () => {
  // Sanity: the migration ran and the runs table exists.
  const row = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM runs`).get();
  expect(typeof row?.n).toBe("number");
});

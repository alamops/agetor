import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task, TaskFxRecovery } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import — see the same
// convention repeated across every sibling *.test.ts that imports db.ts
// (db-sent-files.test.ts, task-unread.test.ts, …). A beforeAll would race
// with whichever test file's import wins the module-cache race in
// `bun test`'s single process.
const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-db-fx-recovery-"));
process.env.AGETOR_DATA_DIR = dataDir;

let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;

beforeAll(async () => {
  ({ db, tasks } = await import("./db.ts"));
});

afterAll(() => {
  rmTestDataDir(dataDir);
});

// Minimal hand-built Task fixture — mirrors db-sent-files.test.ts's
// makeTaskRow. `fxRecovery`/`sentFiles`/`todoProgress`/`unread` are
// deliberately omitted: all are optional, server-managed fields that
// `db.ts` always populates on read (see their doc comments in
// shared/types.ts).
function makeTaskRow(taskId: string): Task {
  return {
    id: taskId,
    title: "t",
    prompt: "p",
    agent: "fx",
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
  };
}

function fxRecoveryRow(taskId: string) {
  return db
    .query<{ fx_recovery: string | null }, [string]>(`SELECT fx_recovery FROM tasks WHERE id = ?`)
    .get(taskId);
}

/** A fully-populated pending-auto-resume pause — every optional field set,
 *  no `autoResumeStopped` (omitted while a timer IS pending, per the field's
 *  own doc comment in shared/types.ts). */
function pendingFxRecovery(overrides: Partial<TaskFxRecovery> = {}): TaskFxRecovery {
  return {
    state: "paused",
    runId: "run-1",
    pausedAt: 1_000,
    cause: "rate_limited",
    attempt: 5,
    attemptLimit: 10,
    message: "Rate limited · retrying in 8s · attempt 5/10",
    autoResume: { at: 2_000, attempt: 1, max: 3, delaySec: 120 },
    autoResumeCount: 0,
    ...overrides,
  };
}

/** A stopped pause — no pending timer, `autoResumeStopped` set to `reason`. */
function stoppedFxRecovery(
  reason: NonNullable<TaskFxRecovery["autoResumeStopped"]>,
  overrides: Partial<TaskFxRecovery> = {},
): TaskFxRecovery {
  return {
    state: "paused",
    runId: "run-2",
    pausedAt: 3_000,
    autoResume: null,
    autoResumeCount: 3,
    autoResumeStopped: reason,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Migration 051 applied on a fresh DB.
// ---------------------------------------------------------------------------

test("migration 051_fx_recovery is recorded in _migrations and adds tasks.fx_recovery", () => {
  const row = db
    .query<{ id: string }, [string]>(`SELECT id FROM _migrations WHERE id = ?`)
    .get("051_fx_recovery");
  expect(row?.id).toBe("051_fx_recovery");

  const columns = db.query<{ name: string }, []>(`PRAGMA table_info(tasks)`).all();
  expect(columns.some((c) => c.name === "fx_recovery")).toBe(true);
});

// ---------------------------------------------------------------------------
// 2. A fresh task has fxRecovery === null, and insert never writes it.
// ---------------------------------------------------------------------------

test("a fresh task has fxRecovery === null and tasks.insert never writes the column", () => {
  const taskId = randomUUID();
  const inserted = tasks.insert(makeTaskRow(taskId));
  try {
    expect(inserted.fxRecovery).toBeNull();
    expect(tasks.get(taskId)?.fxRecovery).toBeNull();
    expect(fxRecoveryRow(taskId)?.fx_recovery).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// 3. setFxRecovery round-trips a full TaskFxRecovery, with and without
//    autoResume, across each autoResumeStopped value, and null clears it.
// ---------------------------------------------------------------------------

test("setFxRecovery round-trips a pending (autoResume-set) pause through tasks.get(...).fxRecovery", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    const value = pendingFxRecovery();
    tasks.setFxRecovery(taskId, value);
    expect(tasks.get(taskId)?.fxRecovery).toEqual(value);
    expect(JSON.parse(fxRecoveryRow(taskId)?.fx_recovery ?? "null")).toEqual(value);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

for (const reason of ["exhausted", "cancelled", "disabled"] as const) {
  test(`setFxRecovery round-trips a stopped pause (autoResume: null, autoResumeStopped: "${reason}")`, () => {
    const taskId = randomUUID();
    tasks.insert(makeTaskRow(taskId));
    try {
      const value = stoppedFxRecovery(reason);
      tasks.setFxRecovery(taskId, value);
      expect(tasks.get(taskId)?.fxRecovery).toEqual(value);
      expect(tasks.get(taskId)?.fxRecovery?.autoResume).toBeNull();
      expect(tasks.get(taskId)?.fxRecovery?.autoResumeStopped).toBe(reason);
    } finally {
      db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
    }
  });
}

test("setFxRecovery(id, null) clears a previously-set pause back to null", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    tasks.setFxRecovery(taskId, pendingFxRecovery());
    expect(tasks.get(taskId)?.fxRecovery).not.toBeNull();

    tasks.setFxRecovery(taskId, null);
    expect(tasks.get(taskId)?.fxRecovery).toBeNull();
    expect(fxRecoveryRow(taskId)?.fx_recovery).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// 4. setFxRecovery never bumps updated_at (server-managed state, not a task
//    mutation — same rationale as mergeSentFiles/markSeen/markUnread).
// ---------------------------------------------------------------------------

test("setFxRecovery does not change updated_at", async () => {
  const taskId = randomUUID();
  const inserted = tasks.insert(makeTaskRow(taskId));
  const originalUpdatedAt = inserted.updatedAt;
  try {
    await new Promise((r) => setTimeout(r, 5));
    tasks.setFxRecovery(taskId, pendingFxRecovery());
    expect(tasks.get(taskId)?.updatedAt).toBe(originalUpdatedAt);

    await new Promise((r) => setTimeout(r, 5));
    tasks.setFxRecovery(taskId, null);
    expect(tasks.get(taskId)?.updatedAt).toBe(originalUpdatedAt);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// 5. The generic tasks.update SET clause skips fx_recovery entirely.
// ---------------------------------------------------------------------------

test("a generic tasks.update (e.g. title change) does not clobber fxRecovery", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    const value = pendingFxRecovery();
    tasks.setFxRecovery(taskId, value);

    const updated = tasks.update(taskId, { title: "renamed" });
    expect(updated?.title).toBe("renamed");
    expect(updated?.fxRecovery).toEqual(value);
    expect(tasks.get(taskId)?.fxRecovery).toEqual(value);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// 6. Hand-corrupted fx_recovery reads as null without throwing.
// ---------------------------------------------------------------------------

test("a hand-corrupted fx_recovery value reads as null without throwing", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    // Malformed JSON entirely.
    db.run(`UPDATE tasks SET fx_recovery = ? WHERE id = ?`, ["{garbage", taskId]);
    expect(() => tasks.get(taskId)).not.toThrow();
    expect(tasks.get(taskId)?.fxRecovery).toBeNull();

    // Valid JSON, but not a plain object.
    db.run(`UPDATE tasks SET fx_recovery = ? WHERE id = ?`, [JSON.stringify(["not", "an", "object"]), taskId]);
    expect(tasks.get(taskId)?.fxRecovery).toBeNull();

    // Valid object, but the wrong (only ever stored) state.
    db.run(
      `UPDATE tasks SET fx_recovery = ? WHERE id = ?`,
      [JSON.stringify({ state: "recovered", runId: "r", pausedAt: 1 }), taskId],
    );
    expect(tasks.get(taskId)?.fxRecovery).toBeNull();

    // Missing required fields (no runId).
    db.run(
      `UPDATE tasks SET fx_recovery = ? WHERE id = ?`,
      [JSON.stringify({ state: "paused", pausedAt: 1 }), taskId],
    );
    expect(tasks.get(taskId)?.fxRecovery).toBeNull();

    // Empty string.
    db.run(`UPDATE tasks SET fx_recovery = ? WHERE id = ?`, ["", taskId]);
    expect(tasks.get(taskId)?.fxRecovery).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// 7. listFxAutoResumePending: only non-archived rows with a non-null
//    autoResume, and its fxRecovery is the parsed shape.
// ---------------------------------------------------------------------------

test("listFxAutoResumePending returns only non-archived rows with a pending autoResume, and parses fxRecovery", () => {
  const pendingId = randomUUID(); // paused, autoResume set → included
  const stoppedId = randomUUID(); // paused, autoResume null (exhausted) → excluded
  const archivedId = randomUUID(); // paused, autoResume set, but archived → excluded
  const clearedId = randomUUID(); // fx_recovery cleared to null → excluded
  const freshId = randomUUID(); // never paused → excluded
  const ids = [pendingId, stoppedId, archivedId, clearedId, freshId];

  for (const id of ids) tasks.insert(makeTaskRow(id));

  try {
    const pendingValue = pendingFxRecovery({ runId: "run-pending" });
    tasks.setFxRecovery(pendingId, pendingValue);

    tasks.setFxRecovery(stoppedId, stoppedFxRecovery("exhausted", { runId: "run-stopped" }));

    const archivedValue = pendingFxRecovery({ runId: "run-archived" });
    tasks.setFxRecovery(archivedId, archivedValue);
    tasks.update(archivedId, { archivedAt: Date.now() });

    tasks.setFxRecovery(clearedId, pendingFxRecovery({ runId: "run-cleared" }));
    tasks.setFxRecovery(clearedId, null);

    // freshId is left untouched (fxRecovery stays null).

    const result = tasks.listFxAutoResumePending();
    const byId = new Map(result.map((r) => [r.id, r.fxRecovery]));

    expect(byId.has(pendingId)).toBe(true);
    expect(byId.get(pendingId)).toEqual(pendingValue);

    expect(byId.has(stoppedId)).toBe(false);
    expect(byId.has(archivedId)).toBe(false);
    expect(byId.has(clearedId)).toBe(false);
    expect(byId.has(freshId)).toBe(false);
  } finally {
    for (const id of ids) db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

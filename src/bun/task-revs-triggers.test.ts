/**
 * The per-task revision log (migration 093): SQLite triggers bump
 * `task_rev_meta.rev` and upsert `task_revs` whenever a task, one of its runs'
 * status, or one of its subagents' status changes, so the board can fetch only
 * what changed. See docs/plans/non-blocking-core.md section 3.
 *
 * db.ts opens and migrates one sqlite file per process and `bun test` runs every
 * file in that process, so the data dir is set at the top level (first import
 * wins) and every assertion is relative to rows with a fresh uuid; nothing
 * assumes an empty database. Rows are removed in afterAll.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const dataDir = process.env.AGETOR_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), "agetor-task-revs-"));
process.env.AGETOR_DATA_DIR = dataDir;

type DbModule = typeof import("./db.ts");
let dbm: DbModule;
const createdTaskIds: string[] = [];

function makeTaskRow(taskId: string): Task {
  return {
    id: taskId,
    title: "task-revs",
    prompt: "p",
    agent: "claude-code",
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
    speed: "off",
    maxMode: false,
    opencodeServer: "shared",
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

interface RevRow { rev: number; deleted: number }

function meta(): { epoch: string; rev: number } {
  return dbm.db.query<{ epoch: string; rev: number }, []>(`SELECT epoch, rev FROM task_rev_meta WHERE id = 1`).get()!;
}
function revOf(taskId: string): RevRow | null {
  return dbm.db.query<RevRow, [string]>(`SELECT rev, deleted FROM task_revs WHERE task_id = ?`).get(taskId) ?? null;
}
function updatedAtOf(taskId: string): number {
  return dbm.db.query<{ updated_at: number }, [string]>(`SELECT updated_at FROM tasks WHERE id = ?`).get(taskId)!.updated_at;
}

function newTask(): string {
  const id = randomUUID();
  createdTaskIds.push(id);
  dbm.tasks.insert(makeTaskRow(id));
  return id;
}
function newRun(taskId: string): string {
  const id = randomUUID();
  const now = Date.now();
  dbm.runs.insert({
    id, taskId, agent: "claude-code", status: "running",
    startedAt: now, endedAt: null, exitCode: null,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null,
    geminiSessionId: null, fxSessionId: null,
  });
  return id;
}
function newSubagent(taskId: string, runId: string): string {
  const id = `agent-${randomUUID()}`;
  dbm.subagents.insertIfAbsent({
    id, taskId, runId, parentKind: "subagent", agentType: "general-purpose",
    description: "revs", spawnDepth: 1, sourcePath: `/tmp/${id}.jsonl`,
    status: "running", startedAt: Date.now(), endedAt: null,
  });
  return id;
}

beforeAll(async () => {
  dbm = await import("./db.ts");
});

afterAll(() => {
  for (const id of createdTaskIds) dbm.tasks.delete(id);
  // The sqlite file is the process-wide singleton, so this is a no-op unless we own the dir alone.
  rmTestDataDir(dataDir);
});

describe("task_rev_meta", () => {
  test("is a single seeded row with a 16-hex epoch", () => {
    const rows = dbm.db.query<{ id: number }, []>(`SELECT id FROM task_rev_meta`).all();
    expect(rows).toEqual([{ id: 1 }]);
    const m = meta();
    expect(m.epoch).toMatch(/^[0-9a-f]{16}$/);
    expect(m.rev).toBeGreaterThanOrEqual(0);
  });

  test("a fresh database starts at rev 0 with an empty task_revs", async () => {
    const { migrate } = await import("./migrate.ts");
    const { migrations } = await import("./migrations/index.ts");
    const mem = new Database(":memory:");
    migrate(mem, migrations);
    const m = mem.query<{ epoch: string; rev: number }, []>(`SELECT epoch, rev FROM task_rev_meta WHERE id = 1`).get()!;
    expect(m.rev).toBe(0);
    expect(m.epoch).toMatch(/^[0-9a-f]{16}$/);
    expect(mem.query(`SELECT 1 FROM task_revs`).all()).toEqual([]);
    mem.close();
  });

  test("two databases get different epochs", async () => {
    const { migrate } = await import("./migrate.ts");
    const { migrations } = await import("./migrations/index.ts");
    const epochs = [0, 1].map(() => {
      const mem = new Database(":memory:");
      migrate(mem, migrations);
      const e = mem.query<{ epoch: string }, []>(`SELECT epoch FROM task_rev_meta`).get()!.epoch;
      mem.close();
      return e;
    });
    expect(epochs[0]).not.toBe(epochs[1]);
  });

  test("only one row can exist", () => {
    expect(() => dbm.db.run(`INSERT INTO task_rev_meta (id, epoch, rev) VALUES (2, 'x', 0)`)).toThrow();
  });
});

describe("migration 093 through the runner", () => {
  test("applies on top of 092 and a rerun is a no-op", async () => {
    const { migrate } = await import("./migrate.ts");
    const { migrations } = await import("./migrations/index.ts");
    const idx = migrations.findIndex((m) => m.id === "093_task_revs");
    expect(idx).toBeGreaterThan(0);
    expect(migrations[idx - 1]!.id).toBe("092_task_base_branch_and_prs");
    const mem = new Database(":memory:");
    expect(migrate(mem, migrations.slice(0, idx))).not.toContain("093_task_revs");
    expect(migrate(mem, migrations)).toEqual(["093_task_revs"]);
    const epoch = mem.query<{ epoch: string }, []>(`SELECT epoch FROM task_rev_meta`).get()!.epoch;
    expect(migrate(mem, migrations)).toEqual([]);
    expect(mem.query<{ epoch: string }, []>(`SELECT epoch FROM task_rev_meta`).get()!.epoch).toBe(epoch);
    const triggers = mem.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_task_revs_%' ORDER BY name`,
    ).all().map((r) => r.name);
    expect(triggers).toEqual([
      "trg_task_revs_runs_insert",
      "trg_task_revs_runs_status",
      "trg_task_revs_subagents_insert",
      "trg_task_revs_subagents_status",
      "trg_task_revs_tasks_delete",
      "trg_task_revs_tasks_insert",
      "trg_task_revs_tasks_update",
    ]);
    mem.close();
  });
});

describe("task triggers", () => {
  test("insert bumps the rev and creates the task_revs row", () => {
    const before = meta().rev;
    const id = newTask();
    expect(meta().rev).toBe(before + 1);
    expect(revOf(id)).toEqual({ rev: before + 1, deleted: 0 });
  });

  test("a generic tasks.update bumps the rev", () => {
    const id = newTask();
    const before = meta().rev;
    dbm.tasks.update(id, { title: "renamed" });
    expect(meta().rev).toBeGreaterThan(before);
    expect(revOf(id)!.rev).toBe(meta().rev);
  });

  test("a raw update of a server-managed column bumps the rev without touching updated_at", () => {
    const id = newTask();
    const beforeRev = meta().rev;
    const beforeUpdated = updatedAtOf(id);
    dbm.db.run(`UPDATE tasks SET last_seen_event_id = 42 WHERE id = ?`, [id]);
    expect(meta().rev).toBe(beforeRev + 1);
    expect(revOf(id)).toEqual({ rev: beforeRev + 1, deleted: 0 });
    expect(updatedAtOf(id)).toBe(beforeUpdated);
  });

  test("an update of one task leaves another task's row alone", () => {
    const a = newTask();
    const b = newTask();
    const revA = revOf(a)!.rev;
    dbm.db.run(`UPDATE tasks SET last_seen_event_id = 7 WHERE id = ?`, [b]);
    expect(revOf(a)!.rev).toBe(revA);
    expect(revOf(b)!.rev).toBeGreaterThan(revA);
  });

  test("delete leaves a tombstone with a newer rev, and a re-insert revives it", () => {
    const id = newTask();
    const inserted = revOf(id)!.rev;
    dbm.tasks.delete(id);
    const gone = revOf(id)!;
    expect(gone.deleted).toBe(1);
    expect(gone.rev).toBeGreaterThan(inserted);
    expect(gone.rev).toBe(meta().rev);
    dbm.tasks.insert(makeTaskRow(id));
    expect(revOf(id)).toEqual({ rev: meta().rev, deleted: 0 });
  });
});

describe("run triggers", () => {
  test("insert and a status change bump the task; an ended_at-only update does not", () => {
    const taskId = newTask();
    const afterTask = meta().rev;
    const runId = newRun(taskId);
    expect(meta().rev).toBe(afterTask + 1);
    expect(revOf(taskId)!.rev).toBe(afterTask + 1);

    const beforeEnded = meta().rev;
    dbm.db.run(`UPDATE runs SET ended_at = ? WHERE id = ?`, [Date.now(), runId]);
    expect(meta().rev).toBe(beforeEnded);
    expect(revOf(taskId)!.rev).toBe(afterTask + 1);

    dbm.db.run(`UPDATE runs SET status = 'succeeded' WHERE id = ?`, [runId]);
    expect(meta().rev).toBe(beforeEnded + 1);
    expect(revOf(taskId)!.rev).toBe(beforeEnded + 1);
  });

  test("a run bumps only its own task", () => {
    const a = newTask();
    const b = newTask();
    const revB = revOf(b)!.rev;
    newRun(a);
    expect(revOf(b)!.rev).toBe(revB);
    expect(revOf(a)!.rev).toBeGreaterThan(revB);
  });
});

describe("subagent triggers", () => {
  test("insert and a status change bump the task; an ended_at-only update does not", () => {
    const taskId = newTask();
    const runId = newRun(taskId);
    const beforeInsert = meta().rev;
    const subId = newSubagent(taskId, runId);
    expect(meta().rev).toBe(beforeInsert + 1);
    expect(revOf(taskId)!.rev).toBe(beforeInsert + 1);

    const beforeEnded = meta().rev;
    dbm.db.run(`UPDATE subagents SET ended_at = ? WHERE id = ?`, [Date.now(), subId]);
    expect(meta().rev).toBe(beforeEnded);

    dbm.subagents.setStatus(subId, "completed", Date.now());
    expect(meta().rev).toBe(beforeEnded + 1);
    expect(revOf(taskId)!.rev).toBe(beforeEnded + 1);
  });
});

describe("rev ordering", () => {
  test("is strictly increasing across a mixed sequence of operations", () => {
    const seen: number[] = [meta().rev];
    const step = (fn: () => void) => { fn(); seen.push(meta().rev); };
    let taskId = "";
    let runId = "";
    step(() => { taskId = newTask(); });
    step(() => { runId = newRun(taskId); });
    step(() => { newSubagent(taskId, runId); });
    step(() => { dbm.tasks.update(taskId, { title: "again" }); });
    step(() => { dbm.db.run(`UPDATE runs SET status = 'failed' WHERE id = ?`, [runId]); });
    step(() => { dbm.tasks.delete(taskId); });
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
    expect(revOf(taskId)).toEqual({ rev: seen[seen.length - 1]!, deleted: 1 });
  });

  test("the rev index serves a since-cursor query without a scan", () => {
    const plan = dbm.db
      .query<{ detail: string }, [number]>(`EXPLAIN QUERY PLAN SELECT task_id, rev, deleted FROM task_revs WHERE rev > ? ORDER BY rev`)
      .all(0)
      .map((r) => r.detail)
      .join("\n");
    expect(plan).toContain("idx_task_revs_rev");
  });
});

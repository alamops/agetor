// Covers docs/plans/event-stream-forward-resume.md P1/P3 (TT2) at the db
// layer: `runs.eventsForTaskAfter` (resume / snapshot) and `runs.appendEvent`'s
// `{ id, ts }` return. db-only, no HTTP server.
//
// Top-level mkdtemp + env assignment before any dynamic import of db.ts, same
// convention as the sibling db-*.test.ts files (db.ts captures the data dir at
// first import).
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-db-events-forward-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;

beforeAll(async () => {
  ({ db, tasks, runs } = await import("./db.ts"));
});

afterAll(() => {
  rmTestDataDir(DATA_DIR);
});

function makeTaskRow(taskId: string): Task {
  return {
    id: taskId,
    title: "t",
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
    speed: "off", maxMode: false, opencodeServer: "shared",
    references: [],
    backlog: [], plans: [],
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

function makeTaskAndRun(): { taskId: string; runId: string } {
  const taskId = randomUUID();
  const runId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  const now = Date.now();
  runs.insert({
    id: runId, taskId, agent: "claude-code", status: "succeeded",
    startedAt: now, endedAt: now + 1, exitCode: 0,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  return { taskId, runId };
}

const BUDGET = { maxEvents: 800, maxBytes: 4 * 1024 * 1024 };

function highWater(): number {
  return db.query<{ seq: number }, []>(`SELECT seq FROM sqlite_sequence WHERE name = 'run_events'`).get()?.seq ?? 0;
}

describe("runs.eventsForTaskAfter", () => {
  test("returns exactly the task's rows after the cursor, ascending, subagent rows included", () => {
    const a = makeTaskAndRun();
    const b = makeTaskAndRun();
    // Interleave the two tasks in id space.
    const a1 = runs.appendEvent(a.runId, "user", "a1")!.id;
    runs.appendEvent(b.runId, "assistant", "b1");
    const a2 = runs.appendEvent(a.runId, "assistant", "a2")!.id;
    runs.appendEvent(b.runId, "assistant", "b2");
    const a3 = runs.appendEvent(a.runId, "assistant", "sub line", null, "sub-1")!.id;
    const a4 = runs.appendEvent(a.runId, "status", "a4")!.id;

    const res = runs.eventsForTaskAfter(a.taskId, a1, BUDGET);
    expect(res.kind).toBe("resume");
    if (res.kind !== "resume") return;
    expect(res.rows.map((r) => r.id)).toEqual([a2, a3, a4]);
    expect(res.rows.every((r) => r.runId === a.runId)).toBe(true);
    expect(res.rows.map((r) => r.subagentId)).toEqual([null, "sub-1", null]);
    expect(res.rows[0]).toEqual({
      id: a2, runId: a.runId, stream: "assistant", data: "a2", ts: res.rows[0]!.ts, subagentId: null,
    });

    // Same shape as eventsForTask's rows.
    const full = runs.eventsForTask(a.taskId);
    expect(res.rows).toEqual(full.filter((r) => r.id > a1));
  });

  test("afterId 0 returns every row of the task", () => {
    const a = makeTaskAndRun();
    runs.appendEvent(a.runId, "user", "x");
    runs.appendEvent(a.runId, "assistant", "y");
    const res = runs.eventsForTaskAfter(a.taskId, 0, BUDGET);
    expect(res.kind).toBe("resume");
    if (res.kind === "resume") expect(res.rows.map((r) => r.data)).toEqual(["x", "y"]);
  });

  test("a cursor at the task's newest row resumes with no rows", () => {
    const a = makeTaskAndRun();
    const last = runs.appendEvent(a.runId, "assistant", "x")!.id;
    expect(runs.eventsForTaskAfter(a.taskId, last, BUDGET)).toEqual({ kind: "resume", rows: [] });
  });

  test("a cursor equal to the high-water resumes with 0 rows", () => {
    const a = makeTaskAndRun();
    runs.appendEvent(a.runId, "assistant", "x");
    expect(runs.eventsForTaskAfter(a.taskId, highWater(), BUDGET)).toEqual({ kind: "resume", rows: [] });
  });

  test("a cursor above the high-water -> cursor-ahead", () => {
    const a = makeTaskAndRun();
    runs.appendEvent(a.runId, "assistant", "x");
    expect(runs.eventsForTaskAfter(a.taskId, highWater() + 1, BUDGET)).toEqual({
      kind: "snapshot",
      reason: "cursor-ahead",
    });
  });

  test("snapshot by count: exactly maxEvents resumes, one more is too-many (subagent rows count)", () => {
    const a = makeTaskAndRun();
    for (let i = 0; i < 4; i++) runs.appendEvent(a.runId, "assistant", `m${i}`, null, i % 2 ? "sub-1" : null);
    const ok = runs.eventsForTaskAfter(a.taskId, 0, { maxEvents: 4, maxBytes: BUDGET.maxBytes });
    expect(ok.kind).toBe("resume");
    if (ok.kind === "resume") expect(ok.rows).toHaveLength(4);
    runs.appendEvent(a.runId, "assistant", "m4");
    expect(runs.eventsForTaskAfter(a.taskId, 0, { maxEvents: 4, maxBytes: BUDGET.maxBytes })).toEqual({
      kind: "snapshot",
      reason: "too-many",
    });
  });

  test("snapshot by bytes: one big row exceeds maxBytes, exact fit resumes (bytes, not characters)", () => {
    const a = makeTaskAndRun();
    // 3 chars × 3 bytes each = 9 bytes; a character count would say 3.
    runs.appendEvent(a.runId, "assistant", "€€€");
    expect(runs.eventsForTaskAfter(a.taskId, 0, { maxEvents: 10, maxBytes: 9 }).kind).toBe("resume");
    expect(runs.eventsForTaskAfter(a.taskId, 0, { maxEvents: 10, maxBytes: 8 })).toEqual({
      kind: "snapshot",
      reason: "too-large",
    });
    const b = makeTaskAndRun();
    runs.appendEvent(b.runId, "tool_result", "x".repeat(2048));
    expect(runs.eventsForTaskAfter(b.taskId, 0, { maxEvents: 800, maxBytes: 1024 })).toEqual({
      kind: "snapshot",
      reason: "too-large",
    });
  });

  test("an unknown task resumes with no rows", () => {
    expect(runs.eventsForTaskAfter(randomUUID(), 0, BUDGET)).toEqual({ kind: "resume", rows: [] });
  });
});

describe("runs.appendEvent return value", () => {
  test("returns the stored { id, ts } (read back from the db)", () => {
    const a = makeTaskAndRun();
    const before = Date.now();
    const appended = runs.appendEvent(a.runId, "assistant", "hello", "line-1")!;
    expect(appended).not.toBeNull();
    expect(appended.ts).toBeGreaterThanOrEqual(before);
    const row = db.query<{ id: number; ts: number }, [number]>(`SELECT id, ts FROM run_events WHERE id = ?`).get(appended.id);
    expect(row).toEqual({ id: appended.id, ts: appended.ts });
  });

  test("returns null on a (run_id, line_uuid) dedup hit", () => {
    const a = makeTaskAndRun();
    expect(runs.appendEvent(a.runId, "assistant", "hello", "dup")).not.toBeNull();
    expect(runs.appendEvent(a.runId, "assistant", "hello", "dup")).toBeNull();
  });

  test("honours an explicit ts, with and without a dedup key", () => {
    const a = makeTaskAndRun();
    const withKey = runs.appendEvent(a.runId, "assistant", "k", "ts-key", null, 1_700_000_000_123)!;
    const noKey = runs.appendEvent(a.runId, "status", "n", null, null, 1_700_000_000_456)!;
    expect(withKey.ts).toBe(1_700_000_000_123);
    expect(noKey.ts).toBe(1_700_000_000_456);
    for (const e of [withKey, noKey]) {
      const row = db.query<{ ts: number }, [number]>(`SELECT ts FROM run_events WHERE id = ?`).get(e.id);
      expect(row!.ts).toBe(e.ts);
    }
  });
});

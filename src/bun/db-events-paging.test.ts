import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.ts";

// db.ts captures AGETOR_DATA_DIR at first import — `bun test` runs every
// *.test.ts file in one process, so whichever file imports db.ts first wins
// the race (see db.ts's own comment on this). Set it at the TOP LEVEL
// (mirrors task-events.test.ts / server-auth.test.ts), not inside beforeAll,
// so this file behaves whether it happens to import first or not.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-events-paging-"));
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT.
process.env.AGETOR_API_PORT = "4485";

let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;
let db: typeof import("./db.ts").db;
let server: { stop: () => void; port: number };
let token: string;
let EVENTS_REPLAY_LIMIT: number;
let TASK_EVENTS_REPLAY_META_EVENT: string;

beforeAll(async () => {
  ({ tasks, runs, db } = await import("./db.ts"));
  const shared = await import("../shared/types.ts");
  EVENTS_REPLAY_LIMIT = shared.EVENTS_REPLAY_LIMIT;
  TASK_EVENTS_REPLAY_META_EVENT = shared.TASK_EVENTS_REPLAY_META_EVENT;
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void; port: number };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

// The SQLite db is process-wide (see the comment above). Sibling test files
// that count rows across the shared `tasks`/`runs`/`run_events` tables rely
// on a clean slate between suites, so wipe everything we inserted after
// every test — same pattern as task-events.test.ts.
afterEach(async () => {
  db.run(`DELETE FROM run_events`);
  db.run(`DELETE FROM runs`);
  db.run(`DELETE FROM tasks`);
});

const BASE = () => `http://127.0.0.1:${server.port}`;
const authedFetch = (p: string, init: RequestInit = {}) =>
  fetch(`${BASE()}${p}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
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
    fast: false, maxMode: false,
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

/** Seeds a task + single terminal run, then appends `count` events to it
 *  (data payloads `"e0"`, `"e1"`, … in insertion order) wrapped in a single
 *  sqlite transaction so seeding hundreds/thousands of rows stays fast.
 *  Returns the task id and the full ascending list of persisted event ids. */
function seedTaskWithEvents(count: number): { taskId: string; runId: string; ids: number[] } {
  const taskId = randomUUID();
  const runId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  const now = Date.now();
  runs.insert({
    id: runId, taskId, agent: "claude-code", status: "succeeded",
    startedAt: now, endedAt: now + 1, exitCode: 0,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  const insertMany = db.transaction((n: number) => {
    for (let i = 0; i < n; i++) {
      runs.appendEvent(runId, "assistant", `e${i}`);
    }
  });
  insertMany(count);
  const ids = runs.eventsForTask(taskId).map((e) => e.id);
  return { taskId, runId, ids };
}

/** Reads an SSE endpoint until `minFrames` frames have been parsed (or
 *  `timeoutMs` elapses), returning each frame's named event (defaulting to
 *  "message" when no `event:` line is present, matching browser EventSource
 *  semantics) and parsed `data:` payload. Mirrors the frame-splitting used
 *  by claude-subagents.integration.test.ts's `readSse`, extended to also
 *  capture the event name so the `replay_meta` named frame is distinguishable
 *  from ordinary data frames. */
async function readSseFrames(
  url: string,
  minFrames: number,
  timeoutMs: number,
): Promise<Array<{ event: string; data: any }>> {
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const frames: Array<{ event: string; data: any }> = [];
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (frames.length < minFrames && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const r = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((res2) =>
          setTimeout(() => res2({ value: undefined, done: true }), Math.max(1, remaining))),
      ]);
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const eventLine = frame.split("\n").find((l) => l.startsWith("event:"));
        const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        try {
          frames.push({
            event: eventLine ? eventLine.slice(6).trim() : "message",
            data: JSON.parse(dataLine.slice(5).trim()),
          });
        } catch {
          // partial/ping frame — ignore.
        }
      }
    }
  } finally {
    ctrl.abort();
  }
  return frames;
}

// ---------------------------------------------------------------------------
// runs.eventsForTask
// ---------------------------------------------------------------------------

test("eventsForTask with no opts returns the full ascending history unchanged", () => {
  const { taskId, ids } = seedTaskWithEvents(10);
  const all = runs.eventsForTask(taskId);
  expect(all.map((e) => e.id)).toEqual(ids);
  expect(all.map((e) => e.data)).toEqual(Array.from({ length: 10 }, (_, i) => `e${i}`));
  // Ascending.
  for (let i = 1; i < all.length; i++) expect(all[i]!.id).toBeGreaterThan(all[i - 1]!.id);
});

test("eventsForTask is empty for a task with no events", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  expect(runs.eventsForTask(taskId)).toEqual([]);
  expect(runs.eventsForTask(taskId, { limit: 50 })).toEqual([]);
});

test("eventsForTask with only `limit` returns the MOST RECENT `limit` events, ascending", () => {
  const { taskId, ids } = seedTaskWithEvents(20);
  const page = runs.eventsForTask(taskId, { limit: 5 });
  expect(page.map((e) => e.id)).toEqual(ids.slice(-5));
  expect(page.map((e) => e.data)).toEqual(["e15", "e16", "e17", "e18", "e19"]);
  // Ascending, not descending.
  for (let i = 1; i < page.length; i++) expect(page[i]!.id).toBeGreaterThan(page[i - 1]!.id);
});

test("eventsForTask combined beforeId+limit returns only events with id < beforeId", () => {
  // NB: `beforeId` alone (no `limit`) is a no-op in the current implementation
  // — the filter only applies inside the `opts.limit` branch. This test pins
  // the combined-usage path, which is what both the SSE replay and the
  // paging route actually exercise.
  const { taskId, ids } = seedTaskWithEvents(30);
  const cutoff = ids[20]!; // id of the 21st event (index 20)
  const page = runs.eventsForTask(taskId, { beforeId: cutoff, limit: 1000 });
  expect(page.every((e) => e.id < cutoff)).toBe(true);
  expect(page.map((e) => e.id)).toEqual(ids.slice(0, 20));
});

test("eventsForTask combined beforeId+small-limit returns the newest slice strictly before the cutoff", () => {
  const { taskId, ids } = seedTaskWithEvents(30);
  const cutoff = ids[20]!;
  const page = runs.eventsForTask(taskId, { beforeId: cutoff, limit: 5 });
  // The 5 events immediately preceding the cutoff, ascending.
  expect(page.map((e) => e.id)).toEqual(ids.slice(15, 20));
});

test("eventsForTask limit larger than available events returns all of them", () => {
  const { taskId, ids } = seedTaskWithEvents(3);
  const page = runs.eventsForTask(taskId, { limit: 1000 });
  expect(page.map((e) => e.id)).toEqual(ids);
});

// ---------------------------------------------------------------------------
// runs.hasEventsBefore
// ---------------------------------------------------------------------------

test("hasEventsBefore is false at the exact earliest id and true just past it", () => {
  const { taskId, ids } = seedTaskWithEvents(5);
  const earliest = ids[0]!;
  expect(runs.hasEventsBefore(taskId, earliest)).toBe(false);
  expect(runs.hasEventsBefore(taskId, earliest + 1)).toBe(true);
  // Comfortably below anything ever inserted for this task.
  expect(runs.hasEventsBefore(taskId, -1)).toBe(false);
});

test("hasEventsBefore is false for a task with no events regardless of cursor", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  expect(runs.hasEventsBefore(taskId, 0)).toBe(false);
  expect(runs.hasEventsBefore(taskId, Number.MAX_SAFE_INTEGER)).toBe(false);
});

// ---------------------------------------------------------------------------
// GET /tasks/:id/events/page
// ---------------------------------------------------------------------------

test("paging route walks the full history via beforeId with no gaps or duplicates, hasMore flips false on the last page", async () => {
  const { taskId, ids } = seedTaskWithEvents(25); // more than one page at limit=10
  const collected: number[] = [];
  let cursor = Number.MAX_SAFE_INTEGER;
  let hasMoreFlags: boolean[] = [];
  for (let guard = 0; guard < 10; guard++) {
    const res = await authedFetch(`/tasks/${taskId}/events/page?beforeId=${cursor}&limit=10`);
    expect(res.status).toBe(200);
    const body = await res.json() as { events: Array<{ id: number }>; earliestId: number | null; hasMore: boolean };
    collected.unshift(...body.events.map((e) => e.id));
    hasMoreFlags.push(body.hasMore);
    if (!body.hasMore) break;
    expect(body.earliestId).not.toBeNull();
    cursor = body.earliestId!;
  }
  expect(collected).toEqual(ids); // no gaps, no duplicates, full coverage
  expect(new Set(collected).size).toBe(collected.length); // no duplicates, restated
  expect(hasMoreFlags[hasMoreFlags.length - 1]).toBe(false); // exhausted
  expect(hasMoreFlags.slice(0, -1).every(Boolean)).toBe(true); // true on every page but the last
  expect(hasMoreFlags.length).toBe(3); // 25 events / limit 10 -> pages of 10, 10, 5
});

test("paging route 400s on a missing beforeId", async () => {
  const { taskId } = seedTaskWithEvents(3);
  const res = await authedFetch(`/tasks/${taskId}/events/page`);
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBeTruthy();
});

test("paging route 400s on a non-numeric beforeId", async () => {
  const { taskId } = seedTaskWithEvents(3);
  const res = await authedFetch(`/tasks/${taskId}/events/page?beforeId=not-a-number`);
  expect(res.status).toBe(400);
});

test("paging route 404s for an unknown task", async () => {
  const res = await authedFetch(`/tasks/${randomUUID()}/events/page?beforeId=999999999`);
  expect(res.status).toBe(404);
});

test("paging route caps `limit` at 2000 and defaults to EVENTS_REPLAY_LIMIT when omitted", async () => {
  const { taskId, ids } = seedTaskWithEvents(2005);

  const capped = await authedFetch(`/tasks/${taskId}/events/page?beforeId=${Number.MAX_SAFE_INTEGER}&limit=999999`);
  expect(capped.status).toBe(200);
  const cappedBody = await capped.json() as { events: unknown[]; hasMore: boolean };
  expect(cappedBody.events.length).toBe(2000); // capped, not 2005 and not 999999
  expect(cappedBody.hasMore).toBe(true); // 5 older events remain

  const defaulted = await authedFetch(`/tasks/${taskId}/events/page?beforeId=${Number.MAX_SAFE_INTEGER}`);
  expect(defaulted.status).toBe(200);
  const defaultedBody = await defaulted.json() as { events: Array<{ id: number }> };
  expect(defaultedBody.events.length).toBe(EVENTS_REPLAY_LIMIT);
  expect(defaultedBody.events.map((e) => e.id)).toEqual(ids.slice(-EVENTS_REPLAY_LIMIT));
});

test("paging route requires auth", async () => {
  const { taskId } = seedTaskWithEvents(3);
  const res = await fetch(`${BASE()}/tasks/${taskId}/events/page?beforeId=999999999`);
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// SSE replay cap on GET /tasks/:id/events
// ---------------------------------------------------------------------------

test("SSE replay caps at EVENTS_REPLAY_LIMIT: a leading named replay_meta frame followed by exactly the newest window, ascending", async () => {
  const seedCount = EVENTS_REPLAY_LIMIT + 50; // comfortably over the cap, still fast to seed
  const { taskId, ids } = seedTaskWithEvents(seedCount);
  expect(ids.length).toBe(seedCount);

  const expectedWindow = ids.slice(-EVENTS_REPLAY_LIMIT);
  const expectedEarliestId = expectedWindow[0]!;
  expect(runs.hasEventsBefore(taskId, expectedEarliestId)).toBe(true);
  // The SSE `RunEvent` payload (unlike the paging route's) carries no `id` —
  // just runId/taskId/stream/data/ts/subagentId — so identify the window by
  // the seeded `data` payload ("e{i}") instead of a numeric id.
  const expectedPayloads = Array.from(
    { length: EVENTS_REPLAY_LIMIT },
    (_, i) => `e${seedCount - EVENTS_REPLAY_LIMIT + i}`,
  );

  const url = `${BASE()}/tasks/${taskId}/events?token=${encodeURIComponent(token)}`;
  const frames = await readSseFrames(url, EVENTS_REPLAY_LIMIT + 1, 10_000);

  expect(frames.length).toBe(EVENTS_REPLAY_LIMIT + 1);

  const [metaFrame, ...dataFrames] = frames;
  expect(metaFrame!.event).toBe(TASK_EVENTS_REPLAY_META_EVENT);
  expect(metaFrame!.data.earliestId).toBe(expectedEarliestId);
  expect(metaFrame!.data.hasMore).toBe(true);

  expect(dataFrames.length).toBe(EVENTS_REPLAY_LIMIT);
  expect(dataFrames.every((f) => f.event === "message")).toBe(true);
  const dataPayloads = dataFrames.map((f) => f.data.data);
  expect(dataPayloads).toEqual(expectedPayloads); // ascending, matches the newest-window slice exactly
  expect(dataPayloads[dataPayloads.length - 1]).toBe(`e${seedCount - 1}`); // ends at the newest event
  expect(dataFrames.every((f) => f.data.taskId === taskId)).toBe(true);
});

// ---------------------------------------------------------------------------
// Migration 030: idx_runs_task
// ---------------------------------------------------------------------------

test("migration 030 creates idx_runs_task and is idempotent across two runner passes", async () => {
  const { migrate } = await import("./migrate.ts");
  const { migrations } = await import("./migrations/index.ts");

  const fresh = new Database(":memory:");
  const firstPass = migrate(fresh, migrations);
  expect(firstPass).toEqual(migrations.map((m) => m.id)); // every migration applied, in order, on a blank db
  expect(firstPass).toContain("030_runs_task_id_index");

  const indexRow = fresh.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_runs_task'`,
  ).get();
  expect(indexRow?.name).toBe("idx_runs_task");

  // Re-running the full migration list against the same db is a no-op —
  // every id is already recorded in `_migrations`.
  const secondPass = migrate(fresh, migrations);
  expect(secondPass).toEqual([]);

  // The index still exists exactly once (no duplicate-index error, no drop).
  const indexRowsAfter = fresh.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_runs_task'`,
  ).all();
  expect(indexRowsAfter.length).toBe(1);
});

test("migration 030 (CREATE INDEX IF NOT EXISTS) tolerates a pre-existing index of the same name", () => {
  // Simulates re-applying just the 030 SQL directly (not through the
  // `_migrations` bookkeeping) against a db that already has the index —
  // this is what makes the migration itself idempotent, independent of the
  // runner's own already-applied tracking exercised above.
  const fresh = new Database(":memory:");
  fresh.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL);`);
  const sql = readFileSync(
    path.join(import.meta.dir, "migrations", "030_runs_task_id_index.sql"),
    "utf8",
  );
  expect(() => fresh.exec(sql)).not.toThrow();
  expect(() => fresh.exec(sql)).not.toThrow(); // second apply, same connection
  const rows = fresh.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_runs_task'`,
  ).all();
  expect(rows.length).toBe(1);
});

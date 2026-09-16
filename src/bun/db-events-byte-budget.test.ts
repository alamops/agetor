// Covers docs/plans/task-details-blank-while-session-restores.md §3.3 / §4 T3
// / §5 U2 at the db layer: the pure `clampWindowByBytes` walk and
// `runs.eventsForTask`'s `maxBytes`/`minEvents` options. The HTTP-route side
// of the same budget (SSE replay, `/tasks/:id/events/page`,
// `/runs/:id/rebuild-events`) is covered separately in
// `server-rebuild-byte-budget.test.ts` — this file is db-only, no HTTP
// server needed.
//
// Top-level: db.ts captures AGETOR_DATA_DIR at first import — same
// convention as every sibling *.test.ts that imports db.ts (see
// db-sent-files.test.ts, db-events-paging.test.ts). A beforeAll would race
// with whichever test file's import wins the module-cache race in `bun
// test`'s single process, so the mkdtemp + env assignment happens here, at
// module top level, before any dynamic import of db.ts.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-db-events-byte-budget-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;
let clampWindowByBytes: typeof import("./db.ts").clampWindowByBytes;

beforeAll(async () => {
  ({ db, tasks, runs, clampWindowByBytes } = await import("./db.ts"));
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

// ---------------------------------------------------------------------------
// clampWindowByBytes — pure, no db.
// ---------------------------------------------------------------------------

test("clampWindowByBytes returns null for an empty rows array", () => {
  expect(clampWindowByBytes([], 1000, 5)).toBeNull();
});

test("clampWindowByBytes keeps everything when the total fits under the budget", () => {
  // Desc (newest-first) rows, sum = 300, well under the 10,000 budget.
  const rowsDesc = [{ id: 30, len: 100 }, { id: 20, len: 100 }, { id: 10, len: 100 }];
  // Returns the OLDEST kept row's id — with nothing cut, that's the last
  // (smallest-id) row in the desc list.
  expect(clampWindowByBytes(rowsDesc, 10_000, 0)).toBe(10);
});

test("clampWindowByBytes cuts exactly at the byte budget boundary — an exact-fit row is kept, the next one over budget is not", () => {
  // minEvents 0 so the floor never masks the boundary behavior being tested.
  // Newest two rows (40 + 40 = 80) land EXACTLY on the 80-byte budget —
  // `accumulated + len > maxBytes` is false at ===, so both are kept. The
  // third row would push it to 120 > 80, so it's excluded.
  const rowsDesc = [{ id: 10, len: 40 }, { id: 9, len: 40 }, { id: 8, len: 40 }, { id: 7, len: 40 }];
  expect(clampWindowByBytes(rowsDesc, 80, 0)).toBe(9); // kept: id 10, id 9 — oldest kept is id 9
});

test("clampWindowByBytes: the minEvents floor keeps rows even once the budget is exceeded", () => {
  // Same 4 rows, tiny 10-byte budget, but minEvents=3 forces at least 3 rows
  // to be kept regardless — the loop only starts enforcing the budget once
  // count >= minEvents.
  const rowsDesc = [{ id: 10, len: 40 }, { id: 9, len: 40 }, { id: 8, len: 40 }, { id: 7, len: 40 }];
  expect(clampWindowByBytes(rowsDesc, 10, 3)).toBe(8); // kept: id 10, 9, 8 (3 rows) — oldest kept is id 8
});

test("clampWindowByBytes: a single row alone over budget is still kept when minEvents is 1", () => {
  const rowsDesc = [{ id: 1, len: 1000 }];
  expect(clampWindowByBytes(rowsDesc, 10, 1)).toBe(1);
});

test("clampWindowByBytes: minEvents larger than the row count keeps every row regardless of budget", () => {
  const rowsDesc = [{ id: 3, len: 100 }, { id: 2, len: 100 }, { id: 1, len: 100 }];
  expect(clampWindowByBytes(rowsDesc, 1, 10)).toBe(1); // budget of 1 byte would otherwise cut almost everything
});

// ---------------------------------------------------------------------------
// runs.eventsForTask({ maxBytes, minEvents }) — db-backed.
//
// Fixture: 60 events, ascending insertion order (so ids 0..59 in the
// comments below track insertion index 1:1). The first 50 (index 0..49) are
// 50 KB each ("big"); the last 10 (index 50..59, the NEWEST events) are 1 KB
// each ("small") — a deliberate mix of big/small per the task brief.
//
// Hand-computed window for {maxBytes: 120_000, minEvents: 5} (walking
// newest → oldest, i.e. index 59 down to 0):
//   - The 10 newest (small, 1 KB) events are all kept: even summed
//     (10,000 bytes) they're nowhere near the budget, and the first 5 are
//     unconditionally kept by the minEvents floor regardless.
//   - Continuing into the big (50 KB) events: index 49 (accumulated
//     10,000 -> 60,000) and index 48 (60,000 -> 110,000) both still fit
//     under 120,000.
//   - Index 47 would push it to 160,000 > 120,000 — excluded.
//   - Final window: indices 48..59 (12 events, ascending).
//
// For the second page (beforeId = the first page's earliest id, i.e.
// everything with index < 48): all 48 remaining events are big (50 KB).
// The minEvents floor (5) binds before the budget does — 4 events fit
// (200,000 bytes) but the 5th (accumulated 200,000 -> 250,000) is still
// added unconditionally since count(4) < minEvents(5); the 6th would push
// 250,000 -> 300,000 > 120,000 and is excluded. Final window: indices
// 43..47 (5 events, ascending).
// ---------------------------------------------------------------------------

const BIG_LEN = 50_000;
const SMALL_LEN = 1_000;
const BIG_COUNT = 50;
const TOTAL_EVENTS = 60;
const MAX_BYTES = 120_000;
const MIN_EVENTS = 5;

function seedByteMixedTask(): { taskId: string; runId: string; ids: number[] } {
  const taskId = randomUUID();
  const runId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  const now = Date.now();
  runs.insert({
    id: runId, taskId, agent: "claude-code", status: "succeeded",
    startedAt: now, endedAt: now + 1, exitCode: 0,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  const insertMany = db.transaction(() => {
    for (let i = 0; i < TOTAL_EVENTS; i++) {
      const len = i < BIG_COUNT ? BIG_LEN : SMALL_LEN;
      runs.appendEvent(runId, "assistant", "x".repeat(len));
    }
  });
  insertMany();
  const ids = runs.eventsForTask(taskId).map((e) => e.id);
  return { taskId, runId, ids };
}

test("eventsForTask with maxBytes keeps only the newest events whose summed lengths fit the budget plus the floor, ascending", () => {
  const { taskId, ids } = seedByteMixedTask();
  const window = runs.eventsForTask(taskId, { limit: 800, maxBytes: MAX_BYTES, minEvents: MIN_EVENTS });
  const expected = ids.slice(-12); // indices 48..59 — see hand-computation above
  expect(window.map((e) => e.id)).toEqual(expected);
  for (let i = 1; i < window.length; i++) expect(window[i]!.id).toBeGreaterThan(window[i - 1]!.id);
  expect(runs.hasEventsBefore(taskId, window[0]!.id)).toBe(true);
});

test("eventsForTask with limit only (no maxBytes) is unaffected by the byte budget — returns all 60 seeded events, byte-identical to before the budget existed", () => {
  const { taskId, ids } = seedByteMixedTask();
  const page = runs.eventsForTask(taskId, { limit: 800 });
  expect(page.map((e) => e.id)).toEqual(ids);
  expect(page.length).toBe(TOTAL_EVENTS);
});

test("eventsForTask with no opts at all returns the full ascending history, untouched by the byte budget path", () => {
  const { taskId, ids } = seedByteMixedTask();
  const all = runs.eventsForTask(taskId);
  expect(all.map((e) => e.id)).toEqual(ids);
  expect(all.length).toBe(TOTAL_EVENTS);
  for (let i = 1; i < all.length; i++) expect(all[i]!.id).toBeGreaterThan(all[i - 1]!.id);
});

test("eventsForTask beforeId+maxBytes pages correctly: second page starts strictly before the first page's earliest id, no overlap, no gap", () => {
  const { taskId, ids } = seedByteMixedTask();

  const page1 = runs.eventsForTask(taskId, { limit: 800, maxBytes: MAX_BYTES, minEvents: MIN_EVENTS });
  const expectedPage1 = ids.slice(-12);
  expect(page1.map((e) => e.id)).toEqual(expectedPage1);

  const page2 = runs.eventsForTask(taskId, {
    beforeId: page1[0]!.id, limit: 800, maxBytes: MAX_BYTES, minEvents: MIN_EVENTS,
  });
  const expectedPage2 = ids.slice(43, 48); // indices 43..47 — see hand-computation above
  expect(page2.map((e) => e.id)).toEqual(expectedPage2);
  expect(page2.every((e) => e.id < page1[0]!.id)).toBe(true); // strictly before page1's earliest id

  // No overlap.
  const page1Ids = new Set(page1.map((e) => e.id));
  expect(page2.every((e) => !page1Ids.has(e.id))).toBe(true);

  // No gap: page2's newest id is the immediate predecessor (in the full
  // oracle order) of page1's earliest id.
  const idx1 = ids.indexOf(page1[0]!.id);
  const idx2Last = ids.indexOf(page2[page2.length - 1]!.id);
  expect(idx2Last).toBe(idx1 - 1);

  // Ascending within each page.
  for (let i = 1; i < page2.length; i++) expect(page2[i]!.id).toBeGreaterThan(page2[i - 1]!.id);
});

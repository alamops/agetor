// Covers docs/plans/first-load-reaches-last-user-message.md §2/§3/§5 U1 at the
// db layer: the pure `resolveAnchoredMinId` helper, `runs.lastUserEventId`,
// and `runs.eventsForTask`'s new `anchor` option. The HTTP-route side of the
// same anchor (SSE replay, `/runs/:id/rebuild-events?limit=`,
// `/tasks/:id/events/page` staying unaffected) is covered separately in
// `server-events-anchor.test.ts` — this file is db-only, no HTTP server
// needed.
//
// Top-level: db.ts captures AGETOR_DATA_DIR at first import — same
// convention as every sibling *.test.ts that imports db.ts (see
// db-events-byte-budget.test.ts, db-events-paging.test.ts). A beforeAll
// would race with whichever test file's import wins the module-cache race in
// `bun test`'s single process, so the mkdtemp + env assignment happens here,
// at module top level, before any dynamic import of db.ts.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-db-events-anchor-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;
let resolveAnchoredMinId: typeof import("./db.ts").resolveAnchoredMinId;

beforeAll(async () => {
  ({ db, tasks, runs, resolveAnchoredMinId } = await import("./db.ts"));
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

// ---------------------------------------------------------------------------
// resolveAnchoredMinId — pure, no db.
// ---------------------------------------------------------------------------

test("resolveAnchoredMinId returns minId unchanged when anchorId is null", () => {
  expect(resolveAnchoredMinId({
    minId: 50, anchorId: null, spanRowsDesc: [{ id: 10, len: 5 }], maxEvents: 100, maxBytes: 1000,
  })).toBe(50);
});

test("resolveAnchoredMinId returns minId unchanged when anchorId === minId (already at the edge, nothing to extend)", () => {
  expect(resolveAnchoredMinId({
    minId: 50, anchorId: 50, spanRowsDesc: [], maxEvents: 100, maxBytes: 1000,
  })).toBe(50);
});

test("resolveAnchoredMinId returns minId unchanged when anchorId > minId (anchor already inside the window)", () => {
  expect(resolveAnchoredMinId({
    minId: 50, anchorId: 75, spanRowsDesc: [], maxEvents: 100, maxBytes: 1000,
  })).toBe(50);
});

test("resolveAnchoredMinId returns minId unchanged when spanRowsDesc.length exceeds maxEvents", () => {
  const spanRowsDesc = Array.from({ length: 6 }, (_, i) => ({ id: 100 - i, len: 1 }));
  expect(resolveAnchoredMinId({
    minId: 200, anchorId: 90, spanRowsDesc, maxEvents: 5, maxBytes: 1_000_000,
  })).toBe(200);
});

test("resolveAnchoredMinId returns minId unchanged when the summed len exceeds maxBytes", () => {
  const spanRowsDesc = [{ id: 30, len: 400 }, { id: 20, len: 400 }, { id: 10, len: 400 }];
  // Sum = 1200 > maxBytes 1000, count (3) is well under maxEvents (100).
  expect(resolveAnchoredMinId({
    minId: 200, anchorId: 10, spanRowsDesc, maxEvents: 100, maxBytes: 1000,
  })).toBe(200);
});

test("resolveAnchoredMinId returns anchorId when the span fits both ceilings", () => {
  const spanRowsDesc = [{ id: 30, len: 100 }, { id: 20, len: 100 }, { id: 10, len: 100 }];
  expect(resolveAnchoredMinId({
    minId: 200, anchorId: 10, spanRowsDesc, maxEvents: 100, maxBytes: 1000,
  })).toBe(10);
});

test("resolveAnchoredMinId exact-boundary: spanRowsDesc.length === maxEvents fits (only a STRICT excess falls back)", () => {
  const spanRowsDesc = Array.from({ length: 5 }, (_, i) => ({ id: 100 - i, len: 1 }));
  expect(resolveAnchoredMinId({
    minId: 200, anchorId: 96, spanRowsDesc, maxEvents: 5, maxBytes: 1_000_000,
  })).toBe(96);
});

test("resolveAnchoredMinId exact-boundary: summed len === maxBytes fits (only a STRICT excess falls back)", () => {
  const spanRowsDesc = [{ id: 30, len: 500 }, { id: 20, len: 500 }];
  // Sum = 1000, exactly maxBytes.
  expect(resolveAnchoredMinId({
    minId: 200, anchorId: 20, spanRowsDesc, maxEvents: 100, maxBytes: 1000,
  })).toBe(20);
});

// ---------------------------------------------------------------------------
// runs.lastUserEventId — db-backed.
// ---------------------------------------------------------------------------

test("lastUserEventId returns null for a task with no user events (only assistant/status rows)", () => {
  const { taskId, runId } = makeTaskAndRun();
  db.transaction(() => {
    runs.appendEvent(runId, "assistant", "hello");
    runs.appendEvent(runId, "status", "some status");
    runs.appendEvent(runId, "assistant", "world");
  })();
  expect(runs.lastUserEventId(taskId)).toBeNull();
});

test("lastUserEventId returns the NEWEST main-stream user id when several exist", () => {
  const { taskId, runId } = makeTaskAndRun();
  const ids: number[] = [];
  db.transaction(() => {
    ids.push(runs.appendEvent(runId, "assistant", "a1")!);
    ids.push(runs.appendEvent(runId, "user", "u1")!);
    ids.push(runs.appendEvent(runId, "assistant", "a2")!);
    ids.push(runs.appendEvent(runId, "user", "u2")!);
    ids.push(runs.appendEvent(runId, "assistant", "a3")!);
  })();
  const u2Id = ids[3]!;
  expect(runs.lastUserEventId(taskId)).toBe(u2Id);
});

test("lastUserEventId ignores a newer user row that carries a subagentId", () => {
  const { taskId, runId } = makeTaskAndRun();
  let mainUserId!: number;
  db.transaction(() => {
    runs.appendEvent(runId, "assistant", "a1");
    mainUserId = runs.appendEvent(runId, "user", "u-main")!;
    runs.appendEvent(runId, "assistant", "a2");
    // Newer (higher id) but tagged with a subagentId — must NOT be picked.
    runs.appendEvent(runId, "user", "u-subagent", null, "sub-1");
  })();
  expect(runs.lastUserEventId(taskId)).toBe(mainUserId);
});

test("lastUserEventId respects beforeId — returns the newest user id strictly below the cursor", () => {
  const { taskId, runId } = makeTaskAndRun();
  const ids: number[] = [];
  db.transaction(() => {
    ids.push(runs.appendEvent(runId, "user", "u1")!);
    ids.push(runs.appendEvent(runId, "assistant", "a1")!);
    ids.push(runs.appendEvent(runId, "user", "u2")!);
    ids.push(runs.appendEvent(runId, "assistant", "a2")!);
  })();
  const u1Id = ids[0]!;
  const u2Id = ids[2]!;
  // beforeId = u2's id excludes u2 itself -> falls back to u1.
  expect(runs.lastUserEventId(taskId, u2Id)).toBe(u1Id);
  // beforeId past everything still finds u2.
  expect(runs.lastUserEventId(taskId, u2Id + 1000)).toBe(u2Id);
});

test("lastUserEventId is scoped to the task — a foreign task's newer user row is ignored", () => {
  const { taskId: taskA, runId: runA } = makeTaskAndRun();
  let aUserId!: number;
  db.transaction(() => {
    runs.appendEvent(runA, "assistant", "a1");
    aUserId = runs.appendEvent(runA, "user", "u-a")!;
  })();

  // Task B's user event lands with a strictly HIGHER id than task A's own
  // user event — if lastUserEventId weren't scoped by task, task A's lookup
  // would wrongly pick it up.
  const { taskId: taskB, runId: runB } = makeTaskAndRun();
  db.transaction(() => {
    runs.appendEvent(runB, "user", "u-b");
  })();

  expect(runs.lastUserEventId(taskA)).toBe(aUserId);
});

// ---------------------------------------------------------------------------
// runs.eventsForTask({ anchor }) — db-backed.
// ---------------------------------------------------------------------------

/** Seeds a task whose FIRST event is a small `user` event, followed by
 *  `assistantCount` `assistant` events of `assistantLen` bytes each. Returns
 *  the ascending oracle `ids` (index 0 = the user event). */
function seedUserFirstTask(
  assistantCount: number,
  assistantLen: number,
  userLen = 10,
): { taskId: string; ids: number[] } {
  const { taskId, runId } = makeTaskAndRun();
  const insertMany = db.transaction(() => {
    runs.appendEvent(runId, "user", "u".repeat(userLen));
    for (let i = 0; i < assistantCount; i++) runs.appendEvent(runId, "assistant", "x".repeat(assistantLen));
  });
  insertMany();
  const ids = runs.eventsForTask(taskId).map((e) => e.id);
  return { taskId, ids };
}

const DEFAULT_LIMIT = 800;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024; // EVENTS_REPLAY_MAX_BYTES
const DEFAULT_MIN_EVENTS = 20; // MIN_REPLAY_EVENTS
const ANCHOR_MAX_EVENTS = 3000; // EVENTS_REPLAY_ANCHOR_MAX_EVENTS
const ANCHOR_MAX_BYTES = 16 * 1024 * 1024; // EVENTS_REPLAY_ANCHOR_MAX_BYTES

test("(a) eventsForTask anchor extends past the default 800-event window: 1 user + 900 small assistant events -> all 901 returned ascending, starting at the user event", () => {
  const { taskId, ids } = seedUserFirstTask(900, 5);
  expect(ids.length).toBe(901);
  const window = runs.eventsForTask(taskId, {
    limit: DEFAULT_LIMIT,
    maxBytes: DEFAULT_MAX_BYTES,
    minEvents: DEFAULT_MIN_EVENTS,
    anchor: { maxEvents: ANCHOR_MAX_EVENTS, maxBytes: ANCHOR_MAX_BYTES },
  });
  expect(window.map((e) => e.id)).toEqual(ids);
  expect(window[0]!.id).toBe(ids[0]!); // the user event
  expect(window[window.length - 1]!.id).toBe(ids[ids.length - 1]!); // newest seeded id too
});

test("(b) eventsForTask anchor.maxEvents too small (500 < 901-event span) falls back to the default window, identical to no-anchor", () => {
  const { taskId, ids } = seedUserFirstTask(900, 5);
  const noAnchor = runs.eventsForTask(taskId, {
    limit: DEFAULT_LIMIT, maxBytes: DEFAULT_MAX_BYTES, minEvents: DEFAULT_MIN_EVENTS,
  });
  expect(noAnchor.map((e) => e.id)).toEqual(ids.slice(-800));
  const withAnchor = runs.eventsForTask(taskId, {
    limit: DEFAULT_LIMIT,
    maxBytes: DEFAULT_MAX_BYTES,
    minEvents: DEFAULT_MIN_EVENTS,
    anchor: { maxEvents: 500, maxBytes: ANCHOR_MAX_BYTES },
  });
  expect(withAnchor).toEqual(noAnchor);
});

test("(b2) exact count boundary through the SQL glue: a 901-event span with anchor.maxEvents 900 falls back (the below-floor read returns exactly `room` rows), with 901 it extends to all 901", () => {
  // Pins the `room = maxEvents + 1 - windowRows` arithmetic in
  // `eventsForTask`, not just `resolveAnchoredMinId`'s pure boundary: with a
  // default window of 800 rows and maxEvents 900, `room` is 101 and the
  // below-floor read returns exactly 101 rows (the user event + 100
  // assistant rows), so the span is 901 > 900 -> fallback. With maxEvents
  // 901, `room` is 102, the read still returns 101 (that's all there is),
  // and the span is 901 <= 901 -> anchored.
  const { taskId, ids } = seedUserFirstTask(900, 5);
  const noAnchor = runs.eventsForTask(taskId, {
    limit: DEFAULT_LIMIT, maxBytes: DEFAULT_MAX_BYTES, minEvents: DEFAULT_MIN_EVENTS,
  });
  const oneShort = runs.eventsForTask(taskId, {
    limit: DEFAULT_LIMIT,
    maxBytes: DEFAULT_MAX_BYTES,
    minEvents: DEFAULT_MIN_EVENTS,
    anchor: { maxEvents: 900, maxBytes: ANCHOR_MAX_BYTES },
  });
  expect(oneShort).toEqual(noAnchor);
  const exactFit = runs.eventsForTask(taskId, {
    limit: DEFAULT_LIMIT,
    maxBytes: DEFAULT_MAX_BYTES,
    minEvents: DEFAULT_MIN_EVENTS,
    anchor: { maxEvents: 901, maxBytes: ANCHOR_MAX_BYTES },
  });
  expect(exactFit.map((e) => e.id)).toEqual(ids);
});

test("(c) eventsForTask anchor.maxBytes smaller than the span's total bytes falls back to the default window, identical to no-anchor", () => {
  const { taskId, ids } = seedUserFirstTask(900, 5);
  const noAnchor = runs.eventsForTask(taskId, {
    limit: DEFAULT_LIMIT, maxBytes: DEFAULT_MAX_BYTES, minEvents: DEFAULT_MIN_EVENTS,
  });
  expect(noAnchor.map((e) => e.id)).toEqual(ids.slice(-800));
  // Span total bytes = 900*5 + 10 = 4510, well over this tiny 100-byte cap.
  const withAnchor = runs.eventsForTask(taskId, {
    limit: DEFAULT_LIMIT,
    maxBytes: DEFAULT_MAX_BYTES,
    minEvents: DEFAULT_MIN_EVENTS,
    anchor: { maxEvents: ANCHOR_MAX_EVENTS, maxBytes: 100 },
  });
  expect(withAnchor).toEqual(noAnchor);
});

test("(d) the byte cap binds the default window first (newest 83 of 101), and the anchor extends past IT to all 101 once the ~5MB span fits the 16MiB ceiling", () => {
  const { taskId, ids } = seedUserFirstTask(100, 50_000);
  expect(ids.length).toBe(101);
  const noAnchor = runs.eventsForTask(taskId, {
    limit: DEFAULT_LIMIT, maxBytes: DEFAULT_MAX_BYTES, minEvents: DEFAULT_MIN_EVENTS,
  });
  // Same 50,000-byte-per-row arithmetic as db-events-byte-budget.test.ts /
  // server-rebuild-byte-budget.test.ts: newest 83 of the (fewer than 800,
  // so count cap never bound) 101 rows fit under the 4MiB default budget.
  expect(noAnchor.map((e) => e.id)).toEqual(ids.slice(-83));

  const withAnchor = runs.eventsForTask(taskId, {
    limit: DEFAULT_LIMIT,
    maxBytes: DEFAULT_MAX_BYTES,
    minEvents: DEFAULT_MIN_EVENTS,
    anchor: { maxEvents: ANCHOR_MAX_EVENTS, maxBytes: ANCHOR_MAX_BYTES },
  });
  expect(withAnchor.map((e) => e.id)).toEqual(ids); // all 101
  expect(withAnchor[0]!.id).toBe(ids[0]!); // the user event
});

test("(e) a user event already inside the default window -> byte-identical to the no-anchor call", () => {
  const { taskId, runId } = makeTaskAndRun();
  const insertMany = db.transaction(() => {
    for (let i = 0; i < 10; i++) runs.appendEvent(runId, "assistant", "x".repeat(5));
    runs.appendEvent(runId, "user", "u".repeat(5));
    for (let i = 0; i < 5; i++) runs.appendEvent(runId, "assistant", "x".repeat(5));
  });
  insertMany();
  // Only 16 events total, nowhere near the 800/4MiB defaults, so the
  // anchor (already inside that unconstrained window) must be a no-op.
  const noAnchor = runs.eventsForTask(taskId, {
    limit: DEFAULT_LIMIT, maxBytes: DEFAULT_MAX_BYTES, minEvents: DEFAULT_MIN_EVENTS,
  });
  const withAnchor = runs.eventsForTask(taskId, {
    limit: DEFAULT_LIMIT,
    maxBytes: DEFAULT_MAX_BYTES,
    minEvents: DEFAULT_MIN_EVENTS,
    anchor: { maxEvents: ANCHOR_MAX_EVENTS, maxBytes: ANCHOR_MAX_BYTES },
  });
  expect(withAnchor).toEqual(noAnchor);
  expect(noAnchor.length).toBe(16);
});

test("(f) beforeId + anchor: the anchor is resolved strictly below the cursor and the window never returns ids >= beforeId", () => {
  const { taskId, runId } = makeTaskAndRun();
  const ids: number[] = [];
  const insertMany = db.transaction(() => {
    ids.push(runs.appendEvent(runId, "user", "u1")!); // index 0 — the anchor we expect
    for (let i = 0; i < 900; i++) ids.push(runs.appendEvent(runId, "assistant", "x".repeat(5))!);
    ids.push(runs.appendEvent(runId, "user", "u2")!); // index 901 — excluded by beforeId
    for (let i = 0; i < 10; i++) ids.push(runs.appendEvent(runId, "assistant", "x".repeat(5))!);
  });
  insertMany();
  const u1Id = ids[0]!;
  const u2Id = ids[901]!;

  const window = runs.eventsForTask(taskId, {
    beforeId: u2Id,
    limit: DEFAULT_LIMIT,
    maxBytes: DEFAULT_MAX_BYTES,
    minEvents: DEFAULT_MIN_EVENTS,
    anchor: { maxEvents: ANCHOR_MAX_EVENTS, maxBytes: ANCHOR_MAX_BYTES },
  });

  expect(window.every((e) => e.id < u2Id)).toBe(true); // never >= beforeId
  expect(window[0]!.id).toBe(u1Id); // anchored to u1, NOT u2 (which sits at/after the cursor)
  expect(window.map((e) => e.id)).toEqual(ids.slice(0, 901)); // u1 through the event right before u2
});

test("(g) no `anchor` key at all with the same seed as (a) -> newest 800 only, unchanged behavior", () => {
  const { taskId, ids } = seedUserFirstTask(900, 5);
  const window = runs.eventsForTask(taskId, {
    limit: DEFAULT_LIMIT, maxBytes: DEFAULT_MAX_BYTES, minEvents: DEFAULT_MIN_EVENTS,
  });
  expect(window.map((e) => e.id)).toEqual(ids.slice(-800));
  expect(window.length).toBe(800);
});

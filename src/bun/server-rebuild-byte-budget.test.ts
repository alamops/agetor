// Covers docs/plans/task-details-blank-while-session-restores.md §3.3 / §4 T3
// / §5 U2 through the real HTTP routes: SSE replay (`GET /tasks/:id/events`),
// the "Load earlier" page (`GET /tasks/:id/events/page`), and
// `GET /runs/:id/rebuild-events`. `db-events-byte-budget.test.ts` covers the
// pure `clampWindowByBytes` walk and `runs.eventsForTask`'s options directly
// — this file is the route-level companion.
//
// Top-level: db.ts captures AGETOR_DATA_DIR at first import — same
// convention as every sibling *.test.ts that imports db.ts (see
// db-events-paging.test.ts, server-pull-blob-csp.test.ts). A beforeAll would
// race with whichever test file's import wins the module-cache race in
// `bun test`'s single process, so the mkdtemp + env assignment happens here,
// at module top level, before any dynamic import of db.ts/server.ts.
//
// AGETOR_API_PORT must be unique across the whole *.test.ts suite (checked
// via `grep -rhn "AGETOR_API_PORT = " src/bun/*.test.ts`); 4598 was unused.
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-server-rebuild-byte-budget-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4598";

let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;
let harnesses: typeof import("./db.ts").harnesses;
let server: { stop: () => void; port: number };
let token: string;
let EVENTS_REPLAY_MAX_BYTES: number;
let EVENTS_PAGE_MAX_BYTES: number;
let TASK_EVENTS_REPLAY_META_EVENT: string;
let encodeProjectPath: (cwd: string) => string;

beforeAll(async () => {
  ({ db, tasks, runs, harnesses } = await import("./db.ts"));
  const shared = await import("../shared/types.ts");
  EVENTS_REPLAY_MAX_BYTES = shared.EVENTS_REPLAY_MAX_BYTES;
  EVENTS_PAGE_MAX_BYTES = shared.EVENTS_PAGE_MAX_BYTES;
  TASK_EVENTS_REPLAY_META_EVENT = shared.TASK_EVENTS_REPLAY_META_EVENT;
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void; port: number };
  token = API_TOKEN;
  // Deferred until after db.ts/server.ts are loaded (and AGETOR_DATA_DIR is
  // already captured) — claude-tmux.ts statically imports `{ tasks }` from
  // db.ts, so a top-level static import here would risk winning the
  // module-load race against this file's own env-var assignment above.
  ({ encodeProjectPath } = await import("./claude-tmux.ts"));
});

afterAll(() => {
  server?.stop?.();
  rmTestDataDir(DATA_DIR);
});

// The SQLite db is process-wide (see the comment above). Wipe the
// events/runs/tasks this file inserts between tests — same pattern as
// db-events-paging.test.ts. Harness rows are deliberately left alone: each
// rebuild-fixture test mints its own uniquely-id'd harness alias, so there's
// no cross-test collision to clean up, and clearing them would just add
// noise.
afterEach(() => {
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

function makeTaskRow(taskId: string, agent: string, workdir: string): Task {
  return {
    id: taskId,
    title: "t",
    prompt: "p",
    agent,
    workdir,
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

/** Reads an SSE endpoint until `minFrames` frames have been parsed (or
 *  `timeoutMs` elapses), returning each frame's named event (defaulting to
 *  "message", matching browser EventSource semantics) and parsed `data:`
 *  payload. Copied from db-events-paging.test.ts's helper of the same name
 *  (not imported — that file owns its own fixture lifecycle at module
 *  scope). */
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

/** Seeds a task + single terminal run, then appends `count` persisted
 *  `run_events` rows of `size` bytes each ("x" repeated) — used by the SSE
 *  replay and `/events/page` byte-budget tests, which read from the
 *  `run_events` table (unlike the JSONL-rebuild fixture below). */
function seedUniformByteTask(count: number, size: number): { taskId: string; runId: string; ids: number[] } {
  const taskId = randomUUID();
  const runId = randomUUID();
  tasks.insert(makeTaskRow(taskId, "claude-code", "/tmp"));
  const now = Date.now();
  runs.insert({
    id: runId, taskId, agent: "claude-code", status: "succeeded",
    startedAt: now, endedAt: now + 1, exitCode: 0,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  const insertMany = db.transaction(() => {
    for (let i = 0; i < count; i++) runs.appendEvent(runId, "assistant", "x".repeat(size));
  });
  insertMany();
  const ids = runs.eventsForTask(taskId).map((e) => e.id);
  return { taskId, runId, ids };
}

// ---------------------------------------------------------------------------
// SSE replay byte budget — GET /tasks/:id/events
//
// 100 events x 50,000 bytes = 5,000,000 bytes, well over
// EVENTS_REPLAY_MAX_BYTES (4 * 1024 * 1024 = 4,194,304). Hand-computed
// (uniform size, floor 20): walking newest -> oldest, the running total
// after keeping `count` events is 50,000 * count; the loop starts enforcing
// the budget once count >= 20, and breaks the first time
// 50,000 * (count + 1) > 4,194,304 — i.e. count + 1 >= 84, so it stops
// after keeping 83 events (accumulated 4,150,000 <= 4,194,304). Window:
// the newest 83 of the 100 seeded events.
// ---------------------------------------------------------------------------

const SSE_EVENT_COUNT = 100;
const SSE_EVENT_SIZE = 50_000;
const SSE_EXPECTED_WINDOW = 83;

test("SSE replay of a task whose newest window exceeds EVENTS_REPLAY_MAX_BYTES is byte-budgeted: summed bytes fit the budget, hasMore true, earliestId matches the byte-clamped window", async () => {
  const { taskId, ids } = seedUniformByteTask(SSE_EVENT_COUNT, SSE_EVENT_SIZE);
  const expectedWindow = ids.slice(-SSE_EXPECTED_WINDOW);

  const url = `${BASE()}/tasks/${taskId}/events?token=${encodeURIComponent(token)}`;
  const frames = await readSseFrames(url, expectedWindow.length + 1, 15_000);

  expect(frames.length).toBe(expectedWindow.length + 1);
  const [metaFrame, ...dataFrames] = frames;
  expect(metaFrame!.event).toBe(TASK_EVENTS_REPLAY_META_EVENT);
  // SSE data frames carry no numeric `id` (unlike the paging route's JSON
  // rows), so the window is identified via the oracle `ids` list — the
  // meta frame's `earliestId` is checked directly against the hand-computed
  // byte-clamped window's own first id.
  expect(metaFrame!.data.earliestId).toBe(expectedWindow[0]);
  expect(metaFrame!.data.hasMore).toBe(true);

  expect(dataFrames.length).toBe(expectedWindow.length);
  const totalBytes = dataFrames.reduce((sum, f) => sum + (f.data.data as string).length, 0);
  expect(totalBytes).toBe(expectedWindow.length * SSE_EVENT_SIZE);
  expect(totalBytes).toBeLessThanOrEqual(EVENTS_REPLAY_MAX_BYTES);
});

// ---------------------------------------------------------------------------
// Byte-budgeted paging — GET /tasks/:id/events/page
//
// 150 events x 50,000 bytes, EVENTS_PAGE_MAX_BYTES = 2 * 1024 * 1024 =
// 2,097,152. Same reasoning as above but with the page budget: each page
// keeps up to 41 events (50,000 * 42 = 2,100,000 > 2,097,152, so the 42nd
// is excluded). Walking beforeId backwards over 150 events:
//   page1: newest 41 (150 remain -> 109 left), hasMore true
//   page2: next 41 (109 remain -> 68 left), hasMore true
//   page3: next 41 (68 remain -> 27 left), hasMore true
//   page4: last 27 (27 * 50,000 = 1,350,000 <= budget, so the floor/budget
//     never trims it — all 27 remaining events fit), hasMore false
// ---------------------------------------------------------------------------

const PAGE_EVENT_COUNT = 150;
const PAGE_EVENT_SIZE = 50_000;
const EXPECTED_PAGE_SIZES = [41, 41, 41, 27];

test("/tasks/:id/events/page byte-budgets each page: walks the full history via beforeId with no gaps/duplicates, each page's bytes fit EVENTS_PAGE_MAX_BYTES, hasMore flips false on the last page", async () => {
  const { taskId, ids } = seedUniformByteTask(PAGE_EVENT_COUNT, PAGE_EVENT_SIZE);

  const collected: number[] = [];
  const hasMoreFlags: boolean[] = [];
  const pageSizes: number[] = [];
  let cursor = Number.MAX_SAFE_INTEGER;
  for (let guard = 0; guard < 10; guard++) {
    const res = await authedFetch(`/tasks/${taskId}/events/page?beforeId=${cursor}&limit=800`);
    expect(res.status).toBe(200);
    const body = await res.json() as { events: Array<{ id: number; data: string }>; earliestId: number | null; hasMore: boolean };
    const bytes = body.events.reduce((sum, e) => sum + e.data.length, 0);
    expect(bytes).toBeLessThanOrEqual(EVENTS_PAGE_MAX_BYTES);
    pageSizes.push(body.events.length);
    collected.unshift(...body.events.map((e) => e.id));
    hasMoreFlags.push(body.hasMore);
    if (!body.hasMore) break;
    expect(body.earliestId).not.toBeNull();
    cursor = body.earliestId!;
  }

  expect(collected).toEqual(ids); // no gaps, no duplicates, full coverage
  expect(new Set(collected).size).toBe(collected.length);
  expect(hasMoreFlags[hasMoreFlags.length - 1]).toBe(false); // exhausted
  expect(hasMoreFlags.slice(0, -1).every(Boolean)).toBe(true); // true on every page but the last
  expect(pageSizes).toEqual(EXPECTED_PAGE_SIZES);
});

// ---------------------------------------------------------------------------
// /runs/:id/rebuild-events byte budget — mapped from a synthetic JSONL file.
//
// 100 assistant lines, 50,000 bytes of text each, uniquely prefixed
// ("L000-".."L099-") so the window can be identified by content. `?limit=90`
// first slices to the newest 90 (global indices 10..99, hasCountCut) — the
// byte budget (EVENTS_REPLAY_MAX_BYTES, floor 20) then clamps that further
// to the newest 83 of those 90 (same 50,000 * (count+1) > 4,194,304 ->
// count+1 >= 84 arithmetic as the SSE test above; 90 available rows is
// comfortably past that cutoff) — i.e. global indices 17..99.
// ---------------------------------------------------------------------------

const REBUILD_LINE_COUNT = 100;
const REBUILD_LINE_LEN = 50_000;
const REBUILD_LIMIT_PARAM = 90;
const REBUILD_EXPECTED_WINDOW = 83; // global indices 17..99

function makeLineText(i: number, len: number): string {
  const prefix = `L${String(i).padStart(3, "0")}-`;
  return prefix + "x".repeat(len - prefix.length);
}

/** Mints a fresh, uniquely-id'd claude-code harness alias whose `home` is a
 *  throwaway temp dir — this is what keeps `jsonlPathFor` (in the
 *  `/runs/:id/rebuild-events` route) from resolving against the REAL
 *  `~/.claude/projects/…` tree: the built-in `claude-code` harness row
 *  (seeded by migration 013) has `home: null`, which falls through to the
 *  real homedir(). A distinct alias id with `home` set routes the lookup to
 *  our fixture directory instead. */
function makeClaudeHarnessAlias(): { id: string; home: string } {
  const id = `alias-${randomUUID()}`;
  const home = mkdtempSync(path.join(tmpdir(), "agetor-rebuild-harness-home-"));
  harnesses.insert({ id, kind: "claude-code", label: "Test Alias", home });
  return { id, home };
}

/** Seeds a task + run whose `claudeSessionId` points at a synthetic JSONL
 *  file written under the alias harness's `home`, at the exact path
 *  `jsonlPathFor`/`encodeProjectPath` (claude-tmux.ts) would resolve for
 *  this (cwd, sessionId, configDir) triple. `lineCount` assistant-text
 *  lines of `lineLen` bytes each, prefixed `L###-` for content-based
 *  window assertions. */
function seedRebuildFixture(lineCount: number, lineLen: number): { runId: string; taskId: string } {
  const { id: harnessId, home } = makeClaudeHarnessAlias();
  const cwd = path.join(tmpdir(), `agetor-rebuild-cwd-${randomUUID()}`);
  const taskId = randomUUID();
  const runId = randomUUID();
  const sessionId = randomUUID();
  const now = Date.now();

  tasks.insert(makeTaskRow(taskId, harnessId, cwd));
  runs.insert({
    id: runId, taskId, agent: harnessId, status: "succeeded",
    startedAt: now, endedAt: now + 1, exitCode: 0,
    tmuxSession: null, claudeSessionId: sessionId, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });

  const jsonlDir = path.join(home, "projects", encodeProjectPath(cwd));
  mkdirSync(jsonlDir, { recursive: true });
  const lines = Array.from({ length: lineCount }, (_, i) =>
    JSON.stringify({
      type: "assistant",
      uuid: randomUUID(),
      message: { content: [{ type: "text", text: makeLineText(i, lineLen) }] },
    }),
  );
  writeFileSync(path.join(jsonlDir, `${sessionId}.jsonl`), lines.join("\n") + "\n");

  return { runId, taskId };
}

test("/runs/:id/rebuild-events?limit=N slices the byte-budgeted window from the END of the mapped JSONL, hasMore true", async () => {
  const { runId } = seedRebuildFixture(REBUILD_LINE_COUNT, REBUILD_LINE_LEN);

  const res = await authedFetch(`/runs/${runId}/rebuild-events?limit=${REBUILD_LIMIT_PARAM}`);
  expect(res.status).toBe(200);
  const body = await res.json() as { events: Array<{ data: string }>; hasMore: boolean };

  expect(body.events.length).toBe(REBUILD_EXPECTED_WINDOW);
  expect(body.events[0]!.data.startsWith("L017-")).toBe(true); // 100 - 90 (count cut) + 7 (byte cut) = index 17
  expect(body.events[body.events.length - 1]!.data.startsWith("L099-")).toBe(true); // newest line
  const totalBytes = body.events.reduce((sum, e) => sum + e.data.length, 0);
  expect(totalBytes).toBe(REBUILD_EXPECTED_WINDOW * REBUILD_LINE_LEN);
  expect(totalBytes).toBeLessThanOrEqual(EVENTS_REPLAY_MAX_BYTES);
  expect(body.hasMore).toBe(true);
});

test("/runs/:id/rebuild-events without `limit` returns the COMPLETE mapped history even past the byte budget, no `hasMore` key", async () => {
  // Same over-budget fixture as the `?limit=90` test: 100 × 50 KB = 5 MB
  // exceeds EVENTS_REPLAY_MAX_BYTES. The no-limit path (the panel's manual
  // "Rebuild from session JSONL" button and the CLI) must NOT be capped:
  // it is the one way to see JSONL-only events the persisted rows lack, and
  // "Load earlier" cannot page the JSONL (review finding on PR #230).
  const { runId } = seedRebuildFixture(REBUILD_LINE_COUNT, REBUILD_LINE_LEN);

  const res = await authedFetch(`/runs/${runId}/rebuild-events`);
  expect(res.status).toBe(200);
  const body = await res.json() as Record<string, unknown>;
  const events = body.events as Array<{ data: string }>;

  expect(events.length).toBe(REBUILD_LINE_COUNT);
  expect(events[0]!.data.startsWith("L000-")).toBe(true);
  expect(events[events.length - 1]!.data.startsWith("L099-")).toBe(true);
  expect(events.reduce((n, e) => n + e.data.length, 0)).toBeGreaterThan(EVENTS_REPLAY_MAX_BYTES);
  expect("hasMore" in body).toBe(false);
});

test("/runs/:id/rebuild-events without `limit` keeps the bare `{events, source}` shape when everything fits", async () => {
  // Under budget: 10 × 1 KB. Nothing is cut, so the additive-only contract
  // holds — no `hasMore` key at all, full list in order.
  const { runId } = seedRebuildFixture(10, 1000);

  const res = await authedFetch(`/runs/${runId}/rebuild-events`);
  expect(res.status).toBe(200);
  const body = await res.json() as Record<string, unknown>;
  const events = body.events as Array<{ data: string }>;

  expect(events.length).toBe(10);
  expect(events[0]!.data.startsWith("L000-")).toBe(true);
  expect(events[events.length - 1]!.data.startsWith("L009-")).toBe(true);
  expect("hasMore" in body).toBe(false);
  expect(typeof body.source).toBe("string");
});

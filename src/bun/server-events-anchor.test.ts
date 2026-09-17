// Covers docs/plans/first-load-reaches-last-user-message.md §2/§3/§5 U2
// through the real HTTP routes: SSE replay (`GET /tasks/:id/events`), the
// `?limit=` auto-rebuild snapshot (`GET /runs/:id/rebuild-events`), and
// confirms `/tasks/:id/events/page` stays UNANCHORED. `db-events-anchor.test.ts`
// covers `resolveAnchoredMinId`/`lastUserEventId`/`eventsForTask({anchor})`
// directly at the db layer — this file is the route-level companion, mirroring
// `server-rebuild-byte-budget.test.ts`'s conventions.
//
// Top-level: db.ts captures AGETOR_DATA_DIR at first import — same
// convention as every sibling *.test.ts that imports db.ts (see
// server-rebuild-byte-budget.test.ts, db-events-paging.test.ts). A beforeAll
// would race with whichever test file's import wins the module-cache race in
// `bun test`'s single process, so the mkdtemp + env assignment happens here,
// at module top level, before any dynamic import of db.ts/server.ts.
//
// AGETOR_API_PORT must be unique across the whole *.test.ts suite (checked
// via `grep -rhn "AGETOR_API_PORT = " src/bun/*.test.ts`); 4599 was unused.
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunEventStream, Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-server-events-anchor-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4599";

let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;
let harnesses: typeof import("./db.ts").harnesses;
let server: { stop: () => void; port: number };
let token: string;
let TASK_EVENTS_REPLAY_META_EVENT: string;
let encodeProjectPath: (cwd: string) => string;

beforeAll(async () => {
  ({ db, tasks, runs, harnesses } = await import("./db.ts"));
  const shared = await import("../shared/types.ts");
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
// server-rebuild-byte-budget.test.ts. Harness rows are deliberately left
// alone: each rebuild-fixture test mints its own uniquely-id'd harness
// alias, so there's no cross-test collision to clean up.
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
 *  payload. Copied from server-rebuild-byte-budget.test.ts's helper of the
 *  same name (not imported — that file owns its own fixture lifecycle at
 *  module scope). */
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

/** Seeds a task + single terminal run, then appends the given `spec` of
 *  small persisted `run_events` rows in order (one row per spec entry, tiny
 *  fixed-size payloads per stream) — used by the SSE replay and
 *  `/events/page` anchor tests, which read from the `run_events` table
 *  (unlike the JSONL-rebuild fixture below). Returns the ascending oracle
 *  `ids` array, index-aligned with `spec`. */
function seedEventsTask(spec: RunEventStream[]): { taskId: string; runId: string; ids: number[] } {
  const taskId = randomUUID();
  const runId = randomUUID();
  tasks.insert(makeTaskRow(taskId, "claude-code", "/tmp"));
  const now = Date.now();
  runs.insert({
    id: runId, taskId, agent: "claude-code", status: "succeeded",
    startedAt: now, endedAt: now + 1, exitCode: 0,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  const ids: number[] = [];
  const insertMany = db.transaction(() => {
    for (const stream of spec) {
      const payload = stream === "user" ? "u".repeat(5) : stream === "status" ? "s".repeat(5) : "a".repeat(5);
      ids.push(runs.appendEvent(runId, stream, payload)!);
    }
  });
  insertMany();
  return { taskId, runId, ids };
}

// ---------------------------------------------------------------------------
// 1. SSE replay: 1 user event followed by 900 assistant events -> the anchor
//    reaches all the way back to the user event (it's also the task's very
//    first event, so hasMore is false).
// ---------------------------------------------------------------------------

test("SSE replay anchors to the last user message: 1 user + 900 assistant -> earliestId is the user event, hasMore false, 901 data frames", async () => {
  const spec: RunEventStream[] = ["user", ...Array(900).fill("assistant" as RunEventStream)];
  const { taskId, ids } = seedEventsTask(spec);
  const userId = ids[0]!;

  const url = `${BASE()}/tasks/${taskId}/events?token=${encodeURIComponent(token)}`;
  const frames = await readSseFrames(url, 902, 20_000);

  expect(frames.length).toBe(902);
  const [metaFrame, ...dataFrames] = frames;
  expect(metaFrame!.event).toBe(TASK_EVENTS_REPLAY_META_EVENT);
  expect(metaFrame!.data.earliestId).toBe(userId);
  expect(metaFrame!.data.hasMore).toBe(false);
  expect(dataFrames.length).toBe(901);
  expect(dataFrames[0]!.data.id).toBe(userId);
  expect(dataFrames[dataFrames.length - 1]!.data.id).toBe(ids[ids.length - 1]);
});

// ---------------------------------------------------------------------------
// 1b. `?anchor=0` opts the replay out of the extension (the TUI dashboard's
//     `useCoalescedStream` passes it — it keeps only 500 lines, so an anchored
//     window would be fetched and discarded). Same seed as test 1: the
//     un-anchored window is the newest 800, the user event is NOT in it, and
//     `hasMore` is true because it (and nothing else) lies before the window.
// ---------------------------------------------------------------------------

test("SSE replay with ?anchor=0 skips the last-user-message extension: 1 user + 900 assistant -> newest 800 only, hasMore true", async () => {
  const spec: RunEventStream[] = ["user", ...Array(900).fill("assistant" as RunEventStream)];
  const { taskId, ids } = seedEventsTask(spec);
  const userId = ids[0]!;

  const url = `${BASE()}/tasks/${taskId}/events?anchor=0&token=${encodeURIComponent(token)}`;
  const frames = await readSseFrames(url, 801, 20_000);

  expect(frames.length).toBe(801);
  const [metaFrame, ...dataFrames] = frames;
  expect(metaFrame!.event).toBe(TASK_EVENTS_REPLAY_META_EVENT);
  expect(metaFrame!.data.earliestId).toBe(ids[ids.length - 800]);
  expect(metaFrame!.data.earliestId).not.toBe(userId);
  expect(metaFrame!.data.hasMore).toBe(true);
  expect(dataFrames.length).toBe(800);
  expect(dataFrames.every((f) => f.data.stream === "assistant")).toBe(true);
});

// ---------------------------------------------------------------------------
// 2. SSE replay ceiling fallback: 1 user + 3100 assistant events. The span
//    from the user event to the newest event (3101 events) exceeds
//    EVENTS_REPLAY_ANCHOR_MAX_EVENTS (3000), so the default 800-event window
//    stands unchanged.
// ---------------------------------------------------------------------------

test("SSE replay ceiling fallback: 1 user + 3100 assistant (span over EVENTS_REPLAY_ANCHOR_MAX_EVENTS) -> default 800-event window, hasMore true", async () => {
  const spec: RunEventStream[] = ["user", ...Array(3100).fill("assistant" as RunEventStream)];
  const { taskId, ids } = seedEventsTask(spec);
  const expectedWindow = ids.slice(-800);

  const url = `${BASE()}/tasks/${taskId}/events?token=${encodeURIComponent(token)}`;
  const frames = await readSseFrames(url, 801, 30_000);

  expect(frames.length).toBe(801);
  const [metaFrame, ...dataFrames] = frames;
  expect(metaFrame!.event).toBe(TASK_EVENTS_REPLAY_META_EVENT);
  expect(metaFrame!.data.earliestId).toBe(expectedWindow[0]);
  expect(metaFrame!.data.hasMore).toBe(true);
  expect(dataFrames.length).toBe(800);
  expect(dataFrames.map((f) => f.data.id)).toEqual(expectedWindow);
}, 35_000);

// ---------------------------------------------------------------------------
// 3. SSE replay with breadcrumbs older than the anchor: 2 status events
//    (older than everything, including the user event), then the user
//    event, then 900 assistant events. The anchor still reaches the user
//    event, but hasMore is now true because the 2 status breadcrumbs sit
//    before it.
// ---------------------------------------------------------------------------

test("SSE replay with status breadcrumbs older than the anchor: earliestId is still the user event, hasMore true", async () => {
  const spec: RunEventStream[] = ["status", "status", "user", ...Array(900).fill("assistant" as RunEventStream)];
  const { taskId, ids } = seedEventsTask(spec);
  const userId = ids[2]!;

  const url = `${BASE()}/tasks/${taskId}/events?token=${encodeURIComponent(token)}`;
  const frames = await readSseFrames(url, 902, 20_000);

  expect(frames.length).toBe(902);
  const [metaFrame, ...dataFrames] = frames;
  expect(metaFrame!.data.earliestId).toBe(userId);
  expect(metaFrame!.data.hasMore).toBe(true);
  expect(dataFrames.length).toBe(901);
  expect(dataFrames[0]!.data.id).toBe(userId);
});

// ---------------------------------------------------------------------------
// 4. /runs/:id/rebuild-events?limit=N anchors the in-memory mapped JSONL to
//    the newest `stream === "user"` event.
// ---------------------------------------------------------------------------

/** Mints a fresh, uniquely-id'd claude-code harness alias whose `home` is a
 *  throwaway temp dir — this is what keeps `jsonlPathFor` (in the
 *  `/runs/:id/rebuild-events` route) from resolving against the REAL
 *  `~/.claude/projects/…` tree: the built-in `claude-code` harness row
 *  (seeded by migration 013) has `home: null`, which falls through to the
 *  real homedir(). A distinct alias id with `home` set routes the lookup to
 *  our fixture directory instead. Copied from
 *  server-rebuild-byte-budget.test.ts. */
function makeClaudeHarnessAlias(): { id: string; home: string } {
  const id = `alias-${randomUUID()}`;
  const home = mkdtempSync(path.join(tmpdir(), "agetor-rebuild-anchor-harness-home-"));
  harnesses.insert({ id, kind: "claude-code", label: "Test Alias", home });
  return { id, home };
}

/** Seeds a task + run whose `claudeSessionId` points at a synthetic JSONL
 *  file written under the alias harness's `home`, at the exact path
 *  `jsonlPathFor`/`encodeProjectPath` (claude-tmux.ts) would resolve for
 *  this (cwd, sessionId, configDir) triple. `lineSpec` is a list of
 *  "user"|"assistant" line kinds, written in order, each assistant line a
 *  unique short text ("A000".."A0NN") so the returned window can be
 *  identified by content; the (at most one, in these tests) user line's
 *  text is a fixed marker. Generalizes
 *  server-rebuild-byte-budget.test.ts's `seedRebuildFixture` to also emit a
 *  leading/interior `type:"user"` line (see claude-tmux.ts's
 *  `mapParsedEventToChunks` "user" case, ~L1213-1231: a plain
 *  `{type:"user", uuid, message:{content:"…"}}` with a non-empty string
 *  `content` and no `isMeta`/`origin` maps straight to a `user` stream
 *  chunk). */
function seedRebuildAnchorFixture(lineSpec: Array<"user" | "assistant">): { runId: string; taskId: string } {
  const { id: harnessId, home } = makeClaudeHarnessAlias();
  const cwd = path.join(tmpdir(), `agetor-rebuild-anchor-cwd-${randomUUID()}`);
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
  let assistantIdx = 0;
  const lines = lineSpec.map((kind) => {
    if (kind === "user") {
      return JSON.stringify({
        type: "user",
        uuid: randomUUID(),
        message: { content: "the user's last message" },
      });
    }
    const text = `A${String(assistantIdx).padStart(4, "0")}`;
    assistantIdx++;
    return JSON.stringify({
      type: "assistant",
      uuid: randomUUID(),
      message: { content: [{ type: "text", text }] },
    });
  });
  writeFileSync(path.join(jsonlDir, `${sessionId}.jsonl`), lines.join("\n") + "\n");

  return { runId, taskId };
}

test("/runs/:id/rebuild-events?limit= anchors to the last user message: 1 user line + 900 assistant lines -> all 901 events, first is the user event, hasMore false", async () => {
  const lineSpec: Array<"user" | "assistant"> = ["user", ...Array(900).fill("assistant" as const)];
  const { runId } = seedRebuildAnchorFixture(lineSpec);

  const res = await authedFetch(`/runs/${runId}/rebuild-events?limit=800`);
  expect(res.status).toBe(200);
  const body = await res.json() as { events: Array<{ stream: string; data: string }>; hasMore: boolean };

  expect(body.events.length).toBe(901);
  expect(body.events[0]!.stream).toBe("user");
  expect(body.events[body.events.length - 1]!.data).toBe("A0899"); // newest assistant line
  expect(body.hasMore).toBe(false);
});

test("/runs/:id/rebuild-events?limit= with breadcrumbs before the user line: 2 assistant lines then the user line then 900 more -> anchors to the user line, hasMore true", async () => {
  const lineSpec: Array<"user" | "assistant"> = [
    "assistant", "assistant", "user", ...Array(900).fill("assistant" as const),
  ];
  const { runId } = seedRebuildAnchorFixture(lineSpec);

  const res = await authedFetch(`/runs/${runId}/rebuild-events?limit=800`);
  expect(res.status).toBe(200);
  const body = await res.json() as { events: Array<{ stream: string; data: string }>; hasMore: boolean };

  expect(body.events[0]!.stream).toBe("user");
  expect(body.events.length).toBe(901); // the 2 leading assistant lines are excluded
  expect(body.hasMore).toBe(true);
});

test("/runs/:id/rebuild-events?limit= ceiling fallback: 1 user line + 3100 assistant lines (span over the ceiling) -> default 800-event window, first event is NOT the user line", async () => {
  const lineSpec: Array<"user" | "assistant"> = ["user", ...Array(3100).fill("assistant" as const)];
  const { runId } = seedRebuildAnchorFixture(lineSpec);

  const res = await authedFetch(`/runs/${runId}/rebuild-events?limit=800`);
  expect(res.status).toBe(200);
  const body = await res.json() as { events: Array<{ stream: string; data: string }>; hasMore: boolean };

  expect(body.events.length).toBe(800);
  expect(body.events[0]!.stream).toBe("assistant");
  expect(body.events[body.events.length - 1]!.data).toBe("A3099"); // newest assistant line
  expect(body.hasMore).toBe(true);
}, 15_000);

// ---------------------------------------------------------------------------
// 5. /tasks/:id/events/page is deliberately NOT anchored.
// ---------------------------------------------------------------------------

test("/tasks/:id/events/page is not anchored: 1 user + 1700 assistant, paging from the top returns exactly `limit` events with no anchor extension", async () => {
  const spec: RunEventStream[] = ["user", ...Array(1700).fill("assistant" as RunEventStream)];
  const { taskId, ids } = seedEventsTask(spec);
  const newestId = ids[ids.length - 1]!;

  const res = await authedFetch(`/tasks/${taskId}/events/page?beforeId=${newestId + 1}&limit=800`);
  expect(res.status).toBe(200);
  const body = await res.json() as { events: Array<{ id: number; stream: string }>; earliestId: number | null; hasMore: boolean };

  expect(body.events.length).toBe(800);
  expect(body.events[0]!.stream).toBe("assistant");
  expect(body.events.map((e) => e.id)).toEqual(ids.slice(-800));
});

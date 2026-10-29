// Covers docs/plans/event-stream-forward-resume.md §3.1 / T6 / P8 through the
// real HTTP route `GET /tasks/:id/events`: `id:` lines on saved rows, the
// resume cursor (`Last-Event-ID` header, `?afterId=`), the snapshot answer for
// a gap that is too big or a cursor from another database, the CORS preflight
// and the test-only `POST /test/drop-task-streams` route.
// `db-run-events-plans.test.ts` / `event-resume.test.ts` cover the db and the
// pure decision at their own layers; this file is the route-level companion,
// mirroring `server-events-anchor.test.ts`.
//
// Top-level mkdtemp + env: db.ts captures AGETOR_DATA_DIR at first import
// (same convention as every sibling test that imports db.ts/server.ts).
//
// Two servers run in this one process so the env-gated drop route can be
// exercised in both states — the gate is read at `startApiServer()` call time:
//   • 4579 — AGETOR_TEST_DROP_STREAMS_ROUTE=1 → `/test/drop-task-streams` exists
//   • 4581 — flag unset                        → the route is a 404
// (4579/4581 are unique across src/ — grep `AGETOR_API_PORT = ` before reusing.)
import { test, expect, beforeAll, afterAll, afterEach, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunEvent, RunEventStream, Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-server-events-resume-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;
let orchestrator: typeof import("./orchestrator.ts");
let attachedClientCount: () => number;
let servers: Array<{ stop: () => void }> = [];
let token: string;
let TASK_EVENTS_REPLAY_META_EVENT: string;
const ON = "http://127.0.0.1:4579";
const OFF = "http://127.0.0.1:4581";

beforeAll(async () => {
  ({ db, tasks, runs } = await import("./db.ts"));
  orchestrator = await import("./orchestrator.ts");
  TASK_EVENTS_REPLAY_META_EVENT = (await import("../shared/types.ts")).TASK_EVENTS_REPLAY_META_EVENT;
  const server = await import("./server.ts");
  attachedClientCount = server.attachedClientCount;
  const { API_TOKEN } = await import("./api-config.ts");
  token = API_TOKEN;

  process.env.AGETOR_TEST_DROP_STREAMS_ROUTE = "1";
  process.env.AGETOR_API_PORT = "4579";
  servers.push(server.startApiServer() as unknown as { stop: () => void });
  delete process.env.AGETOR_TEST_DROP_STREAMS_ROUTE;
  process.env.AGETOR_API_PORT = "4581";
  servers.push(server.startApiServer() as unknown as { stop: () => void });
});

afterAll(() => {
  for (const s of servers) s.stop?.();
  rmTestDataDir(DATA_DIR);
});

// The SQLite db is process-wide: wipe what each test seeds.
afterEach(() => {
  db.run(`DELETE FROM run_events`);
  db.run(`DELETE FROM runs`);
  db.run(`DELETE FROM tasks`);
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

/** Seeds a task + terminal run, then appends one row per `spec` entry (each
 *  payload `size` bytes) in order. Returns the ascending ids. */
function seed(spec: RunEventStream[], size = 5): { taskId: string; runId: string; ids: number[] } {
  const taskId = randomUUID();
  const runId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  const now = Date.now();
  runs.insert({
    id: runId, taskId, agent: "claude-code", status: "succeeded",
    startedAt: now, endedAt: now + 1, exitCode: 0,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  const ids: number[] = [];
  db.transaction(() => {
    for (const stream of spec) ids.push(runs.appendEvent(runId, stream, "x".repeat(size))!.id);
  })();
  return { taskId, runId, ids };
}

interface Frame {
  event: string;
  /** The block's `id:` value, or null when it carried none. */
  id: string | null;
  data: any;
}

/** A long-lived SSE reader: a background pump collects parsed frames so a test
 *  can wait for specific ones and always `close()`s the stream. */
class Sse {
  frames: Frame[] = [];
  ended = false;
  private constructor(
    readonly status: number,
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly ctrl: AbortController,
  ) {}

  static async open(base: string, path: string, headers: Record<string, string> = {}): Promise<Sse> {
    const ctrl = new AbortController();
    const res = await fetch(`${base}${path}`, {
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${token}`, ...headers },
    });
    const sse = new Sse(res.status, res.body!.getReader(), ctrl);
    void sse.pump();
    return sse;
  }

  private async pump(): Promise<void> {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const r = await this.reader.read();
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const lines = block.split("\n");
          const dataLine = lines.find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const eventLine = lines.find((l) => l.startsWith("event:"));
          const idLine = lines.find((l) => l.startsWith("id:"));
          this.frames.push({
            event: eventLine ? eventLine.slice(6).trim() : "message",
            id: idLine ? idLine.slice(3).trim() : null,
            data: JSON.parse(dataLine.slice(5).trim()),
          });
        }
      }
    } catch {
      // aborted by close()
    }
    this.ended = true;
  }

  async waitFor(pred: (s: Sse) => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred(this)) {
      if (Date.now() > deadline) throw new Error(`timed out; frames so far: ${JSON.stringify(this.frames).slice(0, 600)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  meta(): Frame {
    return this.frames.find((f) => f.event === TASK_EVENTS_REPLAY_META_EVENT)!;
  }

  rows(): Frame[] {
    return this.frames.filter((f) => f.event === "message" && typeof f.data.stream === "string");
  }

  close(): void {
    this.ctrl.abort();
  }
}

const opened: Sse[] = [];
async function open(path: string, headers: Record<string, string> = {}, base = ON): Promise<Sse> {
  const s = await Sse.open(base, path, headers);
  opened.push(s);
  return s;
}
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

/** Opens a stream and waits until it has `n` row frames (after the meta). */
async function openAndRead(path: string, n: number, headers: Record<string, string> = {}, base = ON): Promise<Sse> {
  const s = await open(path, headers, base);
  expect(s.status).toBe(200);
  await s.waitFor((x) => x.meta() !== undefined && x.rows().length >= n);
  return s;
}

const post = (base: string, p: string, body: unknown, withToken = true) =>
  fetch(`${base}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(withToken ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const assistants = (n: number): RunEventStream[] => Array(n).fill("assistant" as RunEventStream);

// ---------------------------------------------------------------------------
// No cursor + `id:` lines
// ---------------------------------------------------------------------------

describe("no cursor", () => {
  test("connects exactly as before; every row frame carries an `id:` line equal to its JSON id, the meta none", async () => {
    const { taskId, ids } = seed(["user", "assistant", "assistant"]);
    const s = await openAndRead(`/tasks/${taskId}/events`, 3);
    expect(s.meta().data).toEqual({ earliestId: ids[0], hasMore: false });
    expect(s.meta().id).toBeNull();
    expect(s.rows().map((f) => f.data.id)).toEqual(ids);
    for (const f of s.rows()) expect(f.id).toBe(String(f.data.id));
    // Nothing but the meta and the rows.
    expect(s.frames.length).toBe(4);
  });

  test("malformed cursors connect fresh with 200 (header and query alike)", async () => {
    const { taskId, ids } = seed(assistants(3));
    for (const [path, headers] of [
      [`/tasks/${taskId}/events?afterId=abc`, {}],
      [`/tasks/${taskId}/events?afterId=-4`, {}],
      [`/tasks/${taskId}/events?afterId=1.5`, {}],
      [`/tasks/${taskId}/events?afterId=`, {}],
      [`/tasks/${taskId}/events`, { "last-event-id": "nope" }],
      [`/tasks/${taskId}/events`, { "last-event-id": "12345678901234567" }],
    ] as Array<[string, Record<string, string>]>) {
      const s = await openAndRead(path, 3, headers);
      expect(s.meta().data).toEqual({ earliestId: ids[0], hasMore: false });
      s.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

describe("resume", () => {
  test("?afterId= replays only later rows, with the exact resume meta", async () => {
    const { taskId, ids } = seed(assistants(10));
    const s = await openAndRead(`/tasks/${taskId}/events?afterId=${ids[4]}`, 5);
    expect(s.meta().data).toEqual({ earliestId: null, hasMore: false, resumedAfter: ids[4] });
    expect(s.meta().id).toBeNull();
    expect(s.rows().map((f) => f.data.id)).toEqual(ids.slice(5));
    for (const f of s.rows()) expect(f.id).toBe(String(f.data.id));
  });

  test("Last-Event-ID header resumes the same way; header beats query", async () => {
    const { taskId, ids } = seed(assistants(10));
    const h = await openAndRead(`/tasks/${taskId}/events`, 2, { "last-event-id": String(ids[7]) });
    expect(h.meta().data).toEqual({ earliestId: null, hasMore: false, resumedAfter: ids[7] });
    expect(h.rows().map((f) => f.data.id)).toEqual(ids.slice(8));
    h.close();

    const both = await openAndRead(`/tasks/${taskId}/events?afterId=${ids[2]}`, 2, { "last-event-id": String(ids[7]) });
    expect(both.meta().data.resumedAfter).toBe(ids[7]);
    expect(both.rows().map((f) => f.data.id)).toEqual(ids.slice(8));
    both.close();

    // A malformed header falls through to a valid query cursor (P2).
    const fall = await openAndRead(`/tasks/${taskId}/events?afterId=${ids[7]}`, 2, { "last-event-id": "junk" });
    expect(fall.meta().data.resumedAfter).toBe(ids[7]);
  });

  test("a cursor of 0 is a resume of every row (`resumedAfter: 0`), not a fresh connect — header and query alike", async () => {
    const { taskId, ids } = seed(assistants(3));
    for (const [p, headers] of [
      [`/tasks/${taskId}/events?afterId=0`, {}],
      [`/tasks/${taskId}/events`, { "last-event-id": "0" }],
    ] as Array<[string, Record<string, string>]>) {
      const s = await openAndRead(p, 3, headers);
      expect(s.meta().data).toEqual({ earliestId: null, hasMore: false, resumedAfter: 0 });
      expect(s.rows().map((f) => f.data.id)).toEqual(ids);
      s.close();
    }
  });

  test("the gap carries the task's subagent rows (with `subagentId`) and none of another task's rows interleaved in id space", async () => {
    const a = seed(["user"]);
    const b = seed(["assistant"]);
    // Ids interleave across tasks: A's gap is [sub, main], B's rows sit between.
    const sub = runs.appendEvent(a.runId, "stdout", "from a helper", null, "sub-1")!;
    runs.appendEvent(b.runId, "assistant", "b again");
    const main = runs.appendEvent(a.runId, "assistant", "main again")!;

    const s = await openAndRead(`/tasks/${a.taskId}/events?afterId=${a.ids[0]}`, 2);
    // Give a stray third row time to show up before asserting the exact list.
    await new Promise((r) => setTimeout(r, 100));
    expect(s.meta().data).toEqual({ earliestId: null, hasMore: false, resumedAfter: a.ids[0] });
    expect(s.rows().map((f) => f.data.id)).toEqual([sub.id, main.id]);
    expect(s.rows().every((f) => f.data.taskId === a.taskId)).toBe(true);
    const [subFrame, mainFrame] = s.rows();
    expect(subFrame!.data).toMatchObject({ runId: a.runId, stream: "stdout", data: "from a helper", subagentId: "sub-1", ts: sub.ts });
    expect(subFrame!.id).toBe(String(sub.id));
    expect(mainFrame!.data.subagentId ?? null).toBeNull();
  });

  test("a resume ignores ?anchor=0 — the meta and the gap are the same either way", async () => {
    const { taskId, ids } = seed(["user", ...assistants(4)]);
    const anchored = await openAndRead(`/tasks/${taskId}/events?afterId=${ids[2]}`, 2);
    const plain = await openAndRead(`/tasks/${taskId}/events?anchor=0&afterId=${ids[2]}`, 2);
    expect(plain.meta().data).toEqual(anchored.meta().data);
    expect(plain.rows().map((f) => f.data.id)).toEqual(anchored.rows().map((f) => f.data.id));
    expect(plain.rows().map((f) => f.data.id)).toEqual(ids.slice(3));
  });

  test("resuming at the newest row sends only the meta, then live rows carry `id:` and the stored ts", async () => {
    const { taskId, runId, ids } = seed(assistants(3));
    const s = await open(`/tasks/${taskId}/events`, { "last-event-id": String(ids[2]) });
    await s.waitFor((x) => x.meta() !== undefined);
    expect(s.meta().data).toEqual({ earliestId: null, hasMore: false, resumedAfter: ids[2] });
    expect(s.rows()).toHaveLength(0);

    orchestrator.appendRunStatusLine(taskId, runId, "live line");
    await s.waitFor((x) => x.rows().length === 1);
    const stored = db
      .query<{ id: number; ts: number }, [string]>(`SELECT id, ts FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT 1`)
      .get(runId)!;
    const live = s.rows()[0]!;
    expect(live.data.data).toBe("live line");
    expect(live.id).toBe(String(stored.id));
    expect(live.data.id).toBe(stored.id);
    expect(live.data.ts).toBe(stored.ts);
  });

  test("live-only frames carry no `id:` line (interaction)", async () => {
    // `interaction` / `interaction_resolved` / `subagent` events are emitted
    // without a saved row; drive one through the orchestrator's test hook,
    // which is the same `emit()` the interactions bridge uses.
    const { taskId, runId, ids } = seed(assistants(1));
    const s = await open(`/tasks/${taskId}/events`, { "last-event-id": String(ids[0]) });
    await s.waitFor((x) => x.meta() !== undefined);
    orchestrator.__emitForTest({
      runId,
      taskId,
      stream: "interaction",
      data: JSON.stringify({ id: "card-1" }),
      ts: Date.now(),
    } satisfies RunEvent);
    await s.waitFor((x) => x.frames.some((f) => f.data.stream === "interaction"));
    const card = s.frames.find((f) => f.data.stream === "interaction")!;
    expect(card.id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

describe("snapshot", () => {
  /** The no-cursor window of the same task and `anchor`, as ids + meta. */
  async function freshWindow(taskId: string, query: string, n: number) {
    const s = await openAndRead(`/tasks/${taskId}/events${query}`, n);
    const out = { meta: s.meta().data, ids: s.rows().map((f) => f.data.id) };
    s.close();
    return out;
  }

  test("a gap over 800 rows is a snapshot identical to a fresh connect (anchored by default, un-anchored with ?anchor=0)", async () => {
    // 1 user + 900 assistant: anchored fresh window = all 901 rows; un-anchored = newest 800.
    const { taskId, ids } = seed(["user", ...assistants(900)]);

    const anchoredFresh = await freshWindow(taskId, "", 901);
    const snap = await openAndRead(`/tasks/${taskId}/events?afterId=${ids[0]}`, 901);
    expect(snap.meta().data).toEqual({ ...anchoredFresh.meta, snapshotRequired: true });
    expect(snap.meta().data.earliestId).toBe(ids[0]);
    expect(snap.rows().map((f) => f.data.id)).toEqual(anchoredFresh.ids);
    for (const f of snap.rows()) expect(f.id).toBe(String(f.data.id));
    snap.close();

    const plainFresh = await freshWindow(taskId, "?anchor=0", 800);
    const plainSnap = await openAndRead(`/tasks/${taskId}/events?anchor=0`, 800, { "last-event-id": String(ids[0]) });
    expect(plainSnap.meta().data).toEqual({ ...plainFresh.meta, snapshotRequired: true });
    expect(plainSnap.meta().data.hasMore).toBe(true);
    expect(plainSnap.rows().map((f) => f.data.id)).toEqual(plainFresh.ids);
    expect(plainSnap.rows()).toHaveLength(800);
  }, 30_000);

  test("a gap over 4 MB is a snapshot identical to a fresh connect", async () => {
    // user (tiny) + five 1 MiB rows: only 6 rows, but 5 MiB after the cursor.
    const taskId = randomUUID();
    const runId = randomUUID();
    tasks.insert(makeTaskRow(taskId));
    const now = Date.now();
    runs.insert({
      id: runId, taskId, agent: "claude-code", status: "succeeded",
      startedAt: now, endedAt: now + 1, exitCode: 0,
      tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
    });
    const ids = [runs.appendEvent(runId, "user", "hi")!.id];
    for (let i = 0; i < 5; i++) ids.push(runs.appendEvent(runId, "assistant", "y".repeat(1024 * 1024))!.id);

    const fresh = await openAndRead(`/tasks/${taskId}/events`, 1);
    const freshIds = await (async () => {
      await fresh.waitFor((x) => x.rows().length >= 1);
      await new Promise((r) => setTimeout(r, 300));
      return fresh.rows().map((f) => f.data.id);
    })();
    const freshMeta = fresh.meta().data;
    fresh.close();

    const snap = await open(`/tasks/${taskId}/events?afterId=${ids[0]}`);
    await snap.waitFor((x) => x.meta() !== undefined && x.rows().length >= freshIds.length);
    await new Promise((r) => setTimeout(r, 300));
    expect(snap.meta().data).toEqual({ ...freshMeta, snapshotRequired: true });
    expect(snap.rows().map((f) => f.data.id)).toEqual(freshIds);
  }, 30_000);

  test("a cursor ahead of the database is a snapshot of the fresh window", async () => {
    const { taskId, ids } = seed(assistants(3));
    const s = await openAndRead(`/tasks/${taskId}/events?afterId=9999999999`, 3);
    expect(s.meta().data).toEqual({ earliestId: ids[0], hasMore: false, snapshotRequired: true });
    expect(s.rows().map((f) => f.data.id)).toEqual(ids);
  });

  test("a snapshot stream keeps going live with `id:` lines, and its last id resumes cleanly next time", async () => {
    const { taskId, runId, ids } = seed(assistants(2));
    const s = await openAndRead(`/tasks/${taskId}/events`, 2, { "last-event-id": "9999999999" });
    expect(s.meta().data.snapshotRequired).toBe(true);

    orchestrator.appendRunStatusLine(taskId, runId, "after the snapshot");
    await s.waitFor((x) => x.rows().length === 3);
    const live = s.rows()[2]!;
    expect(live.data.data).toBe("after the snapshot");
    expect(live.id).toBe(String(live.data.id));
    expect(live.data.id).toBeGreaterThan(ids[1]!);
    s.close();

    // What a client would send on its next reconnect: the last `id:` it saw.
    const next = await open(`/tasks/${taskId}/events`, { "last-event-id": live.id! });
    await next.waitFor((x) => x.meta() !== undefined);
    await new Promise((r) => setTimeout(r, 100));
    expect(next.meta().data).toEqual({ earliestId: null, hasMore: false, resumedAfter: live.data.id });
    expect(next.rows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

test("OPTIONS preflight allows the last-event-id header", async () => {
  const res = await fetch(`${ON}/tasks/${randomUUID()}/events`, {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization,last-event-id",
    },
  });
  const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(",").map((h) => h.trim());
  expect(allowed).toContain("last-event-id");
  expect(allowed).toContain("authorization");
});

// ---------------------------------------------------------------------------
// POST /test/drop-task-streams
// ---------------------------------------------------------------------------

describe("POST /test/drop-task-streams", () => {
  test("404 on a server started without AGETOR_TEST_DROP_STREAMS_ROUTE=1 (token or not)", async () => {
    expect((await post(OFF, "/test/drop-task-streams", { taskId: "x" })).status).toBe(404);
    expect((await post(OFF, "/test/drop-task-streams", { taskId: "x" }, false)).status).toBe(404);
  });

  test("enabled server: requires the token and validates the body", async () => {
    expect((await post(ON, "/test/drop-task-streams", { taskId: "x" }, false)).status).toBe(401);
    expect((await post(ON, "/test/drop-task-streams", {})).status).toBe(400);
    expect((await post(ON, "/test/drop-task-streams", { taskId: "" })).status).toBe(400);
    for (const holdMs of [-1, 30_001, 1.5, "5", null]) {
      const res = await post(ON, "/test/drop-task-streams", { taskId: "x", holdMs });
      expect(res.status).toBe(400);
      expect(typeof ((await res.json()) as { error: string }).error).toBe("string");
    }
    // Valid: nothing open for that task.
    const ok = await post(ON, "/test/drop-task-streams", { taskId: "x", holdMs: 0 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ closed: 0 });
  });

  test("closes every open stream of the task and releases their attached-client slots; other tasks are untouched", async () => {
    const a = seed(assistants(2));
    const b = seed(assistants(1));
    const baseline = attachedClientCount();
    const a1 = await openAndRead(`/tasks/${a.taskId}/events`, 2);
    const a2 = await openAndRead(`/tasks/${a.taskId}/events?anchor=0`, 2);
    const other = await openAndRead(`/tasks/${b.taskId}/events`, 1);
    expect(attachedClientCount()).toBe(baseline + 3);

    const res = await post(ON, "/test/drop-task-streams", { taskId: a.taskId });
    expect(await res.json()).toEqual({ closed: 2 });
    await a1.waitFor((s) => s.ended);
    await a2.waitFor((s) => s.ended);
    expect(other.ended).toBe(false);
    expect(attachedClientCount()).toBe(baseline + 1);

    // Dropping again finds nothing (the registry was cleaned up), and the
    // later abort of an already-dropped stream must not double-decrement.
    expect(await (await post(ON, "/test/drop-task-streams", { taskId: a.taskId })).json()).toEqual({ closed: 0 });
    a1.close();
    a2.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(attachedClientCount()).toBe(baseline + 1);

    other.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(attachedClientCount()).toBe(baseline);
  });

  test("holdMs parks a reconnect server-side until the hold ends, then it resumes from its Last-Event-ID over the gap", async () => {
    const { taskId, runId, ids } = seed(assistants(3));
    const s1 = await openAndRead(`/tasks/${taskId}/events`, 3);
    const lastId = s1.rows().at(-1)!.id!;
    expect(lastId).toBe(String(ids[2]));

    const holdMs = 700;
    const droppedAt = Date.now();
    expect(await (await post(ON, "/test/drop-task-streams", { taskId, holdMs })).json()).toEqual({ closed: 1 });
    await s1.waitFor((s) => s.ended);

    // Lands during the hold — the gap the reconnect has to cover.
    orchestrator.appendRunStatusLine(taskId, runId, "during the hold");

    let settled = false;
    const reconnect = Sse.open(ON, `/tasks/${taskId}/events`, { "last-event-id": lastId }).then((s) => {
      settled = true;
      opened.push(s);
      return s;
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(settled).toBe(false); // still parked: no headers yet
    const s2 = await reconnect;
    expect(Date.now() - droppedAt).toBeGreaterThanOrEqual(holdMs - 50);
    expect(s2.status).toBe(200);
    await s2.waitFor((s) => s.meta() !== undefined && s.rows().length >= 1);
    expect(s2.meta().data).toEqual({ earliestId: null, hasMore: false, resumedAfter: ids[2] });
    expect(s2.rows().map((f) => f.data.data)).toEqual(["during the hold"]);

    // The hold is over: a further connect is not delayed.
    const t0 = Date.now();
    const s3 = await openAndRead(`/tasks/${taskId}/events`, 1, { "last-event-id": lastId });
    expect(Date.now() - t0).toBeLessThan(400);
    s3.close();
  });

  test("a request aborted during a hold is released and leaks nothing", async () => {
    const { taskId } = seed(assistants(1));
    // The previous test's streams are closed in afterEach; let their aborts land.
    await new Promise((r) => setTimeout(r, 200));
    const baseline = attachedClientCount();
    await post(ON, "/test/drop-task-streams", { taskId, holdMs: 1500 });
    const ctrl = new AbortController();
    const pending = fetch(`${ON}/tasks/${taskId}/events`, {
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${token}` },
    }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();
    expect(await pending).toBeInstanceOf(Error);
    // Let the hold lapse so later tests start clean, then confirm no slot leaked.
    await new Promise((r) => setTimeout(r, 1600));
    expect(attachedClientCount()).toBe(baseline);
  });
});

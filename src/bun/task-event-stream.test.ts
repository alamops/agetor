// The extracted task event stream (docs/architecture/core-responsiveness.md): replay window, forward resume, snapshot answer,
// live buffer + dedup, the byte budget and teardown. The route-level companions are server-events-*.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunEvent, RunEventStream, Task, TaskEventsReplayMeta } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-task-event-stream-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;
let orchestrator: typeof import("./orchestrator.ts");
let stream: typeof import("./task-event-stream.ts");

beforeAll(async () => {
  ({ db, tasks, runs } = await import("./db.ts"));
  orchestrator = await import("./orchestrator.ts");
  stream = await import("./task-event-stream.ts");
});
afterAll(() => rmTestDataDir(DATA_DIR));
afterEach(() => {
  db.run(`DELETE FROM run_events`);
  db.run(`DELETE FROM runs`);
  db.run(`DELETE FROM tasks`);
});

function makeTaskRow(taskId: string): Task {
  return {
    id: taskId, title: "t", prompt: "p", agent: "claude-code", workdir: "/tmp", isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null, mode: null, model: null, effort: null,
    speed: "off", maxMode: false, opencodeServer: "shared", references: [], backlog: [], plans: [], draft: null, column: "ready",
    runId: null, createdAt: Date.now(), updatedAt: Date.now(), hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    archivedAt: null,
  };
}

function seed(spec: RunEventStream[], size = 5): { taskId: string; runId: string; ids: number[] } {
  const taskId = randomUUID();
  const runId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  const now = Date.now();
  runs.insert({
    id: runId, taskId, agent: "claude-code", status: "succeeded", startedAt: now, endedAt: now + 1, exitCode: 0,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  const ids: number[] = [];
  db.transaction(() => {
    for (const st of spec) ids.push(runs.appendEvent(runId, st, "x".repeat(size))!.id);
  })();
  return { taskId, runId, ids };
}

function collect(taskId: string, opts: Parameters<typeof stream.openTaskEventStream>[1]) {
  const metas: TaskEventsReplayMeta[] = [];
  const events: RunEvent[] = [];
  const handle = stream.openTaskEventStream(taskId, opts, { meta: (m) => metas.push(m), event: (e) => events.push(e) });
  return { metas, events, handle };
}

describe("openTaskEventStream", () => {
  test("a fresh open sends the meta frame, then the window oldest first", async () => {
    const { taskId, ids } = seed(["stdout", "stdout", "stdout"]);
    const c = collect(taskId, { cursor: null });
    await c.handle.started;
    expect(c.metas).toEqual([{ earliestId: ids[0]!, hasMore: false }]);
    expect(c.events.map((e) => e.id)).toEqual(ids);
    c.handle.close();
  });

  test("a resume sends only the rows after the cursor and says so", async () => {
    const { taskId, ids } = seed(["stdout", "stdout", "stdout", "stdout"]);
    const c = collect(taskId, { cursor: ids[1]! });
    await c.handle.started;
    expect(c.metas).toEqual([{ earliestId: null, hasMore: false, resumedAfter: ids[1]! }]);
    expect(c.events.map((e) => e.id)).toEqual([ids[2]!, ids[3]!]);
    c.handle.close();
  });

  test("a cursor ahead of the database answers a snapshot of the fresh window", async () => {
    const { taskId, ids } = seed(["stdout", "stdout"]);
    const c = collect(taskId, { cursor: 10_000_000 });
    await c.handle.started;
    expect(c.metas[0]).toMatchObject({ snapshotRequired: true, earliestId: ids[0]! });
    expect(c.events.map((e) => e.id)).toEqual(ids);
    c.handle.close();
  });

  test("a live event is delivered once, and one that raced the replay is deduplicated", async () => {
    const { taskId, runId, ids } = seed(["stdout"]);
    const c = collect(taskId, { cursor: null });
    // Lands while the replay read is in flight: it waits in the buffer and the replay already carries it.
    orchestrator.emitRunEvent({ id: ids[0]!, runId, taskId, stream: "stdout", data: "x".repeat(5), ts: Date.now() } as RunEvent);
    await c.handle.started;
    expect(c.events.filter((e) => e.id === ids[0]).length).toBe(1);
    // A genuinely new live row passes through.
    const added = runs.appendEvent(runId, "stdout", "live")!;
    orchestrator.emitRunEvent({ id: added.id, runId, taskId, stream: "stdout", data: "live", ts: added.ts } as RunEvent);
    expect(c.events.map((e) => e.id)).toEqual([ids[0]!, added.id]);
    c.handle.close();
  });

  test("a rewritten row (same id, new data) is not dropped as a duplicate", async () => {
    const { taskId, runId, ids } = seed(["tool_use"]);
    const c = collect(taskId, { cursor: null });
    await c.handle.started;
    orchestrator.emitRunEvent({ id: ids[0]!, runId, taskId, stream: "tool_use", data: "rewritten", ts: Date.now() } as RunEvent);
    expect(c.events.map((e) => e.data)).toEqual(["xxxxx", "rewritten"]);
    c.handle.close();
  });

  test("another task's live events are ignored, and nothing arrives after close", async () => {
    const a = seed(["stdout"]);
    const b = seed(["stdout"]);
    const c = collect(a.taskId, { cursor: null });
    await c.handle.started;
    orchestrator.emitRunEvent({ id: 9_000_001, runId: b.runId, taskId: b.taskId, stream: "stdout", data: "other", ts: 1 } as RunEvent);
    expect(c.events.length).toBe(1);
    c.handle.close();
    orchestrator.emitRunEvent({ id: 9_000_002, runId: a.runId, taskId: a.taskId, stream: "stdout", data: "late", ts: 1 } as RunEvent);
    expect(c.events.length).toBe(1);
    c.handle.close(); // idempotent
  });

  test("closing before the replay lands sends nothing", async () => {
    const { taskId } = seed(["stdout", "stdout"]);
    const c = collect(taskId, { cursor: null });
    c.handle.close();
    await c.handle.started;
    expect(c.metas).toEqual([]);
    expect(c.events).toEqual([]);
  });

  test("a sink that throws does not break the stream", async () => {
    const { taskId } = seed(["stdout", "stdout"]);
    let n = 0;
    const handle = stream.openTaskEventStream(taskId, { cursor: null }, {
      meta: () => { throw new Error("gone"); },
      event: () => { n++; throw new Error("gone"); },
    });
    await handle.started;
    expect(n).toBe(2);
    handle.close();
  });
});

describe("maxBytes", () => {
  test("clampMaxBytes and parseMaxBytesParam", () => {
    expect(stream.clampMaxBytes(1000)).toBe(64 * 1024);
    expect(stream.clampMaxBytes(256 * 1024)).toBe(256 * 1024);
    expect(stream.clampMaxBytes(10 ** 12)).toBe(4 * 1024 * 1024);
    for (const bad of [0, -5, NaN, Infinity, "5", null, undefined]) expect(stream.clampMaxBytes(bad)).toBeUndefined();
    expect(stream.parseMaxBytesParam("262144")).toBe(262144);
    expect(stream.parseMaxBytesParam("12abc")).toBeUndefined();
    expect(stream.parseMaxBytesParam("-1")).toBeUndefined();
    expect(stream.parseMaxBytesParam(null)).toBeUndefined();
    expect(stream.parseMaxBytesParam("999999999", 2 * 1024 * 1024)).toBe(2 * 1024 * 1024);
  });

  test("a 256 KB ask on ~3 MB of history returns at most 256 KB plus one oversize event", async () => {
    const { taskId } = seed(Array.from({ length: 60 }, () => "stdout" as RunEventStream), 50 * 1024);
    const c = collect(taskId, { cursor: null, maxBytes: 256 * 1024 });
    await c.handle.started;
    const bytes = c.events.reduce((n, e) => n + e.data.length, 0);
    expect(bytes).toBeLessThanOrEqual(256 * 1024 + 50 * 1024);
    expect(c.events.length).toBeGreaterThanOrEqual(1);
    expect(c.events.length).toBeLessThan(10);
    expect(c.metas[0]!.hasMore).toBe(true);
    c.handle.close();
  });

  test("with no maxBytes the whole recent window comes back, as before", async () => {
    const { taskId } = seed(Array.from({ length: 60 }, () => "stdout" as RunEventStream), 50 * 1024);
    const c = collect(taskId, { cursor: null });
    await c.handle.started;
    expect(c.events.length).toBeGreaterThan(40);
    c.handle.close();
  });

  test("a single event larger than the budget is still returned (the floor is one)", async () => {
    const { taskId } = seed(["stdout"], 400 * 1024);
    const c = collect(taskId, { cursor: null, maxBytes: 64 * 1024 });
    await c.handle.started;
    expect(c.events.length).toBe(1);
    c.handle.close();
  });
});

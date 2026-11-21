// `GET /tasks/:id/events` replays with an async database read, so live frames
// keep arriving while the read is in flight. A row committed before that read
// is in the replay AND has its own live send, which can land in the route's
// buffer (during the read) or after the buffer is drained. Either way the
// client must see it once (docs/architecture/core-responsiveness.md, the
// replay paragraph). Rows after the replay, and live-only frames, still go
// through.
//
// The race is made deterministic with a spy on the in-process `runs` module
// (`db-rpc.ts`'s in-process client calls the db.ts singleton's methods): while
// the replay read runs, it commits a row and sends it live, as a writer that
// raced the connect would.
//
// Port 4644 is unique across src/ (grep `AGETOR_API_PORT = ` before reusing).
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunEvent, Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-events-replay-dedup-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

let dbm: typeof import("./db.ts");
let orchestrator: typeof import("./orchestrator.ts");
let server: { stop: (force?: boolean) => void };
let token: string;
const BASE = "http://127.0.0.1:4644";

beforeAll(async () => {
  dbm = await import("./db.ts");
  orchestrator = await import("./orchestrator.ts");
  const { startApiServer } = await import("./server.ts");
  token = (await import("./api-config.ts")).API_TOKEN;
  process.env.AGETOR_API_PORT = "4644";
  server = startApiServer() as unknown as { stop: (force?: boolean) => void };
});

afterAll(() => {
  server?.stop(true);
  rmTestDataDir(DATA_DIR);
});

function makeTaskRow(taskId: string): Task {
  return {
    id: taskId, title: "t", prompt: "p", agent: "claude-code", workdir: "/tmp", isolation: "none",
    taskType: "task", branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: null, model: null, effort: null, speed: "off", maxMode: false, opencodeServer: "shared",
    references: [], backlog: [], plans: [], draft: null, column: "ready", runId: null,
    createdAt: Date.now(), updatedAt: Date.now(), hasOpenableRun: false,
    pendingInteractionCount: 0, openTerminalCount: 0, archivedAt: null,
  };
}

/** Commit a row and build its live frame, exactly what `saveAndEmit` sends. */
function commit(taskId: string, runId: string, data: string): RunEvent {
  const row = dbm.runs.appendEvent(runId, "assistant", data)!;
  return { id: row.id, runId, taskId, stream: "assistant", data, ts: row.ts, subagentId: null };
}

test("a row committed during the replay read is sent once, whether its live send is buffered or lands after the drain", async () => {
  const taskId = randomUUID();
  const runId = randomUUID();
  dbm.tasks.insert(makeTaskRow(taskId));
  const now = Date.now();
  dbm.runs.insert({
    id: runId, taskId, agent: "claude-code", status: "running", startedAt: now, endedAt: null, exitCode: null,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  const before = commit(taskId, runId, "before connect");

  let raced: RunEvent[] = [];
  const real = dbm.runs.eventsForTask.bind(dbm.runs);
  const spy = spyOn(dbm.runs, "eventsForTask").mockImplementation((...args: Parameters<typeof real>) => {
    if (args[0] === taskId && raced.length === 0) {
      // Two writers raced the connect: both rows commit before the read.
      raced = [commit(taskId, runId, "raced, sent while the read runs"), commit(taskId, runId, "raced, sent after the drain")];
      orchestrator.emitRunEvent(raced[0]!); // lands in the route's buffer
      setTimeout(() => {
        orchestrator.emitRunEvent(raced[1]!); // lands after the buffer is drained
        // A genuinely new row, and a live-only frame: both must go through.
        orchestrator.emitRunEvent(commit(taskId, runId, "after the replay"));
        orchestrator.emitRunEvent({ runId, taskId, stream: "interaction", data: "{}", ts: Date.now() });
      }, 50);
    }
    return real(...args);
  });

  const ctrl = new AbortController();
  const frames: Array<{ id: string | null; data: RunEvent }> = [];
  try {
    const res = await fetch(`${BASE}/tasks/${taskId}/events`, { signal: ctrl.signal, headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 10_000;
    while (!frames.some((f) => f.data.stream === "interaction")) {
      if (Date.now() > deadline) throw new Error(`timed out; frames: ${JSON.stringify(frames).slice(0, 600)}`);
      const r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const lines = block.split("\n");
        const dataLine = lines.find((l) => l.startsWith("data:"));
        if (!dataLine || lines.some((l) => l.startsWith("event:"))) continue;
        const idLine = lines.find((l) => l.startsWith("id:"));
        frames.push({ id: idLine ? idLine.slice(3).trim() : null, data: JSON.parse(dataLine.slice(5).trim()) as RunEvent });
      }
    }
  } finally {
    ctrl.abort();
    spy.mockRestore();
  }

  expect(raced).toHaveLength(2);
  const saved = frames.filter((f) => typeof f.data.id === "number").map((f) => f.data.data);
  expect(saved).toEqual(["before connect", "raced, sent while the read runs", "raced, sent after the drain", "after the replay"]);
  expect(frames.filter((f) => f.data.stream === "interaction")).toHaveLength(1);
  expect(before.id).toBeLessThan(raced[0]!.id!);
});

function newRun(): { taskId: string; runId: string } {
  const taskId = randomUUID();
  const runId = randomUUID();
  dbm.tasks.insert(makeTaskRow(taskId));
  dbm.runs.insert({
    id: runId, taskId, agent: "claude-code", status: "running", startedAt: Date.now(), endedAt: null, exitCode: null,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  return { taskId, runId };
}

/** Connect to the task stream and collect saved frames until the live-only sentinel arrives. */
async function collectSaved(taskId: string, cursor?: number): Promise<RunEvent[]> {
  const ctrl = new AbortController();
  const out: RunEvent[] = [];
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (cursor !== undefined) headers["last-event-id"] = String(cursor);
    const res = await fetch(`${BASE}/tasks/${taskId}/events`, { signal: ctrl.signal, headers });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 10_000;
    let seenSentinel = false;
    while (!seenSentinel) {
      if (Date.now() > deadline) throw new Error(`timed out; frames: ${JSON.stringify(out).slice(0, 600)}`);
      const r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const lines = block.split("\n");
        const dataLine = lines.find((l) => l.startsWith("data:"));
        if (!dataLine || lines.some((l) => l.startsWith("event:"))) continue;
        const ev = JSON.parse(dataLine.slice(5).trim()) as RunEvent;
        if (ev.stream === "interaction") seenSentinel = true;
        else if (typeof ev.id === "number") out.push(ev);
      }
    }
  } finally {
    ctrl.abort();
  }
  return out;
}

/** Rewrite a saved row in place and build its live frame, as the OpenCode mapper does. */
function rewrite(taskId: string, runId: string, id: number, data: string): RunEvent {
  dbm.runs.replaceEventData(id, data);
  return { id, runId, taskId, stream: "assistant", data, ts: Date.now(), subagentId: null };
}

const sentinel = (taskId: string, runId: string) =>
  setTimeout(() => orchestrator.emitRunEvent({ runId, taskId, stream: "interaction", data: "{}", ts: Date.now() }), 50);

test("an in-place rewrite of a replayed row reaches the client, on a fresh connect and on a resume", async () => {
  for (const mode of ["fresh", "resume"] as const) {
    const { taskId, runId } = newRun();
    const row = commit(taskId, runId, "generic name");
    const cursor = mode === "resume" ? row.id! - 1 : undefined;
    const real = dbm.runs.eventsForTask.bind(dbm.runs);
    const realAfter = dbm.runs.eventsForTaskAfter.bind(dbm.runs);
    const sendRewrite = () => {
      // The replay read already holds the old data; the rewrite lands after it.
      orchestrator.emitRunEvent(rewrite(taskId, runId, row.id!, "real name"));
      sentinel(taskId, runId);
    };
    const spy = spyOn(dbm.runs, "eventsForTask").mockImplementation((...args: Parameters<typeof real>) => {
      const out = real(...args);
      if (args[0] === taskId) void Promise.resolve(out).then(sendRewrite);
      return out;
    });
    const spyAfter = spyOn(dbm.runs, "eventsForTaskAfter").mockImplementation((...args: Parameters<typeof realAfter>) => {
      const out = realAfter(...args);
      if (args[0] === taskId) void Promise.resolve(out).then(sendRewrite);
      return out;
    });
    let frames: RunEvent[];
    try {
      frames = await collectSaved(taskId, cursor);
    } finally {
      spy.mockRestore();
      spyAfter.mockRestore();
    }
    expect(frames.map((f) => f.data)).toEqual(["generic name", "real name"]);
    expect(frames.every((f) => f.id === row.id)).toBe(true);
  }
});

test("a live duplicate of a replayed row (same id, same data) is still dropped", async () => {
  const { taskId, runId } = newRun();
  const row = commit(taskId, runId, "once");
  const real = dbm.runs.eventsForTask.bind(dbm.runs);
  const spy = spyOn(dbm.runs, "eventsForTask").mockImplementation((...args: Parameters<typeof real>) => {
    const out = real(...args);
    if (args[0] === taskId) {
      void Promise.resolve(out).then(() => {
        orchestrator.emitRunEvent(row); // the same frame, same data
        sentinel(taskId, runId);
      });
    }
    return out;
  });
  let frames: RunEvent[];
  try {
    frames = await collectSaved(taskId);
  } finally {
    spy.mockRestore();
  }
  expect(frames.map((f) => f.data)).toEqual(["once"]);
});

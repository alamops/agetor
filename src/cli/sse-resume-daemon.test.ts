// The CLI's `streamSse` against a real in-process core: a dropped
// `/tasks/:id/events` stream reconnects with the last SSE id as
// `last-event-id` and the core resumes over just the gap, or — when the gap is
// past the replay cap — answers a snapshot on the same connection
// (docs/plans/event-stream-forward-resume.md T6/T9). `sse.test.ts`,
// `logs.test.ts` and `Dashboard.test.tsx` cover each side with a mocked
// fetch/stream; this pins the two together over real HTTP, discovering the
// core the way `agetor logs` and the TUI do (the creds file + CLI token).
//
// AGETOR_DATA_DIR / AGETOR_API_PORT / the drop-route flag are set before any
// `../bun/*` import: db.ts captures the data dir at first import and
// `startApiServer()` reads the port and the flag when it is called.
// Port 4583 is unique across src/ (grep `AGETOR_API_PORT = ` before reusing).
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunEvent, TaskEventsReplayMeta } from "../shared/types.ts";
import { rmTestDataDir } from "../bun/test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-cli-sse-resume-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
const PORT = 4583;

let db: typeof import("../bun/db.ts");
let orchestrator: typeof import("../bun/orchestrator.ts");
let streamSse: typeof import("./sse.ts").streamSse;
let masterToken: string;
let server: { stop: () => void } | null = null;

beforeAll(async () => {
  db = await import("../bun/db.ts");
  orchestrator = await import("../bun/orchestrator.ts");
  ({ streamSse } = await import("./sse.ts"));
  const { API_TOKEN, CLI_TOKEN } = await import("../bun/api-config.ts");
  masterToken = API_TOKEN;
  const { startApiServer } = await import("../bun/server.ts");
  const prevPort = process.env.AGETOR_API_PORT;
  const prevFlag = process.env.AGETOR_TEST_DROP_STREAMS_ROUTE;
  process.env.AGETOR_API_PORT = String(PORT);
  process.env.AGETOR_TEST_DROP_STREAMS_ROUTE = "1";
  try {
    server = startApiServer() as unknown as { stop: () => void };
  } finally {
    if (prevPort === undefined) delete process.env.AGETOR_API_PORT;
    else process.env.AGETOR_API_PORT = prevPort;
    if (prevFlag === undefined) delete process.env.AGETOR_TEST_DROP_STREAMS_ROUTE;
    else process.env.AGETOR_TEST_DROP_STREAMS_ROUTE = prevFlag;
  }
  // What `agetor logs` / the TUI discover: the creds file with the CLI token.
  const { writeCoreCreds } = await import("../bun/core-creds.ts");
  writeCoreCreds(
    { port: PORT, token: CLI_TOKEN, pid: process.pid, kind: "cli-daemon", version: "test", startedAt: Date.now() },
    DATA_DIR,
  );
});

afterAll(() => {
  server?.stop();
  rmTestDataDir(DATA_DIR);
});

const handles: Array<{ close(): void }> = [];
// Only the rows this file seeded: in a full `bun test` run the db singleton
// is shared with every other file.
const seeded: Array<{ taskId: string; runId: string }> = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  for (const { taskId, runId } of seeded.splice(0)) {
    db.db.run(`DELETE FROM run_events WHERE run_id = ?`, [runId]);
    db.db.run(`DELETE FROM runs WHERE id = ?`, [runId]);
    db.db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

function seedTask(n: number): { taskId: string; runId: string; ids: number[] } {
  const taskId = randomUUID();
  const runId = randomUUID();
  seeded.push({ taskId, runId });
  const now = Date.now();
  db.tasks.insert({
    id: taskId, title: "t", prompt: "p", agent: "claude-code", workdir: "/tmp", isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: null, model: null, effort: null, speed: "off", maxMode: false, opencodeServer: "shared",
    references: [], backlog: [], plans: [], draft: null, column: "review", runId,
    createdAt: now, updatedAt: now, hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0, archivedAt: null,
  });
  db.runs.insert({
    id: runId, taskId, agent: "claude-code", status: "succeeded", startedAt: now, endedAt: now + 1, exitCode: 0,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  const ids: number[] = [];
  db.db.transaction(() => {
    ids.push(db.runs.appendEvent(runId, "user", "hello")!.id);
    for (let i = 1; i < n; i++) ids.push(db.runs.appendEvent(runId, "assistant", `chunk ${i}`)!.id);
  })();
  return { taskId, runId, ids };
}

/** Opens the task stream through `streamSse`, collecting rows and metas. */
function follow(taskId: string) {
  const rows: RunEvent[] = [];
  const metas: TaskEventsReplayMeta[] = [];
  let reconnects = 0;
  const h = streamSse<RunEvent>(`/tasks/${taskId}/events`, (e) => rows.push(e), {
    dataDir: DATA_DIR,
    onReconnect: () => reconnects++,
    onNamedEvent: (event, data) => {
      if (event === "replay_meta") metas.push(JSON.parse(data) as TaskEventsReplayMeta);
    },
  });
  handles.push(h);
  return { rows, metas, reconnects: () => reconnects };
}

async function waitUntil(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function drop(taskId: string, holdMs: number): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${PORT}/test/drop-task-streams`, {
    method: "POST",
    headers: { authorization: `Bearer ${masterToken}`, "content-type": "application/json" },
    body: JSON.stringify({ taskId, holdMs }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { closed: number }).closed;
}

test("a dropped stream reconnects with last-event-id and gets only the gap, nothing twice", async () => {
  const { taskId, runId, ids } = seedTask(3);
  const s = follow(taskId);
  await waitUntil(() => s.metas.length === 1 && s.rows.length === 3);
  expect(s.metas[0]).toEqual({ earliestId: ids[0]!, hasMore: false });
  expect(s.rows.map((e) => e.id)).toEqual(ids);

  expect(await drop(taskId, 400)).toBe(1);
  // Lands while the reconnect is parked: the gap.
  orchestrator.appendRunStatusLine(taskId, runId, "while you were away");

  await waitUntil(() => s.metas.length === 2 && s.rows.length === 4);
  expect(s.reconnects()).toBeGreaterThanOrEqual(1);
  expect(s.metas[1]).toEqual({ earliestId: null, hasMore: false, resumedAfter: ids[2] });
  expect(s.rows[3]).toMatchObject({ stream: "status", data: "while you were away" });
  expect(s.rows[3]!.id).toBeGreaterThan(ids[2]!);

  // Live rows keep flowing on the resumed connection, still each once.
  orchestrator.appendRunStatusLine(taskId, runId, "live again");
  await waitUntil(() => s.rows.length === 5);
  await new Promise((r) => setTimeout(r, 100));
  const seen = s.rows.map((e) => e.id);
  expect(new Set(seen).size).toBe(seen.length);
  expect(s.rows.map((e) => e.data).slice(3)).toEqual(["while you were away", "live again"]);
});

test("a gap past the replay cap reconnects into a snapshot of the fresh window on the same connection", async () => {
  const { taskId, runId, ids } = seedTask(2);
  const s = follow(taskId);
  await waitUntil(() => s.metas.length === 1 && s.rows.length === 2);

  expect(await drop(taskId, 600)).toBe(1);
  // 801 rows after the cursor: one more than the 800-event replay cap.
  db.db.transaction(() => {
    for (let i = 0; i < 801; i++) db.runs.appendEvent(runId, "assistant", `gap ${i}`);
  })();
  void ids;

  // The fresh window is anchored to the user row, so it holds all 803 rows.
  await waitUntil(() => s.metas.length === 2 && s.rows.length >= 2 + 803, 20_000);
  expect(s.reconnects()).toBeGreaterThanOrEqual(1);
  expect(s.metas[1]!.snapshotRequired).toBe(true);
  expect(s.metas[1]!.resumedAfter).toBeUndefined();
  const snapshot = s.rows.slice(2);
  expect(snapshot).toHaveLength(803);
  expect(snapshot[0]).toMatchObject({ stream: "user", data: "hello" });
  expect(snapshot.at(-1)).toMatchObject({ data: "gap 800" });
  expect(s.metas[1]!.earliestId).toBe(snapshot[0]!.id!);
}, 30_000);

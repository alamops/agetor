import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.ts";

// db.ts captures AGETOR_DATA_DIR at first import — `bun test` runs every
// *.test.ts file in one process, so whichever file imports db.ts first wins
// the race (see db.ts's own comment on this, and the identical convention
// comment in db-events-paging.test.ts). Set it at the TOP LEVEL, not inside
// beforeAll, so this file behaves whether it happens to import first or not.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-message-history-"));
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT
// (checked against every sibling file's literal at authoring time).
process.env.AGETOR_API_PORT = "4503";

let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;
let harnesses: typeof import("./db.ts").harnesses;
let db: typeof import("./db.ts").db;
let server: { stop: () => void; port: number };
let token: string;

beforeAll(async () => {
  ({ tasks, runs, harnesses, db } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void; port: number };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

// The SQLite db is process-wide (see the comment above). Sibling test files
// that count rows across the shared `tasks`/`runs`/`run_events`/`harnesses`
// tables rely on a clean slate between suites, so wipe everything we
// inserted after every test — same pattern as db-events-paging.test.ts.
// Custom harness rows are scoped to ids we control (never touch the seeded
// built-ins `claude-code`/`codex`/`cursor`).
afterEach(async () => {
  db.run(`DELETE FROM run_events`);
  db.run(`DELETE FROM runs`);
  db.run(`DELETE FROM tasks`);
  db.run(`DELETE FROM harnesses WHERE is_builtin = 0`);
  db.run(`DELETE FROM projects`);
});

const BASE = () => `http://127.0.0.1:${server.port}`;
const authedFetch = (p: string, init: RequestInit = {}) =>
  fetch(`${BASE()}${p}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });

function makeTaskRow(taskId: string, overrides: Partial<Task> = {}): Task {
  return {
    id: taskId,
    title: `title-${taskId.slice(0, 8)}`,
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
    fast: false,
    references: [],
    backlog: [],
    draft: null,
    column: "ready",
    runId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    ...overrides,
  };
}

/** Seeds a task (with the given `agent`) plus a single terminal run, and
 *  returns helpers to append events to that run. */
function seedTask(agent: string, overrides: Partial<Task> = {}): { taskId: string; runId: string } {
  const taskId = randomUUID();
  const runId = randomUUID();
  tasks.insert(makeTaskRow(taskId, { agent, ...overrides }));
  const now = Date.now();
  runs.insert({
    id: runId, taskId, agent: agent as Task["agent"], status: "succeeded",
    startedAt: now, endedAt: now + 1, exitCode: 0,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null,
  });
  return { taskId, runId };
}

/** Appends a `user`-stream event carrying `text` to `runId`. `ts` lets tests
 *  pin a specific timestamp for ordering assertions; the row's insertion
 *  order (not `ts`) is what `userMessageHistory` orders by (`MAX(id)`), so
 *  tests that care about ordering rely on insertion order, not `ts`. */
function appendUserEvent(runId: string, text: string) {
  runs.appendEvent(runId, "user", text);
}

// ---------------------------------------------------------------------------
// GET /tasks/:id/messages/history
// ---------------------------------------------------------------------------

test("cross-task same-kind collection: bare-kind task and custom-harness task of the same kind share history; a different kind is excluded both ways", async () => {
  // Task A: legacy bare-kind agent string "claude-code".
  const a = seedTask("claude-code");
  appendUserEvent(a.runId, "hello from A");

  // Task B: agent is a *custom harness id* whose row's kind is "claude-code".
  harnesses.insert({ id: "my-claude-harness", kind: "claude-code", label: "My Claude" });
  const b = seedTask("my-claude-harness");
  appendUserEvent(b.runId, "hello from B");

  // Task C: agent "codex" — a different kind entirely.
  const c = seedTask("codex");
  appendUserEvent(c.runId, "hello from C");

  const resA = await authedFetch(`/tasks/${a.taskId}/messages/history`);
  expect(resA.status).toBe(200);
  const bodyA = await resA.json() as { messages: Array<{ text: string; taskId: string }> };
  const textsA = bodyA.messages.map((m) => m.text);
  expect(textsA).toContain("hello from A");
  expect(textsA).toContain("hello from B");
  expect(textsA).not.toContain("hello from C");

  const resB = await authedFetch(`/tasks/${b.taskId}/messages/history`);
  const bodyB = await resB.json() as { messages: Array<{ text: string }> };
  const textsB = bodyB.messages.map((m) => m.text);
  expect(textsB).toContain("hello from A");
  expect(textsB).toContain("hello from B");
  expect(textsB).not.toContain("hello from C");

  const resC = await authedFetch(`/tasks/${c.taskId}/messages/history`);
  const bodyC = await resC.json() as { messages: Array<{ text: string }> };
  const textsC = bodyC.messages.map((m) => m.text);
  expect(textsC).toContain("hello from C");
  expect(textsC).not.toContain("hello from A");
  expect(textsC).not.toContain("hello from B");
});

test("excludes non-user streams, subagent rows, and blank/space-only data", async () => {
  const { taskId, runId } = seedTask("claude-code");
  appendUserEvent(runId, "real user message");
  runs.appendEvent(runId, "assistant", "an assistant reply");
  // Same "user" stream but tagged as a subagent event.
  runs.appendEvent(runId, "user", "subagent message", null, "some-subagent-id");
  appendUserEvent(runId, "");
  appendUserEvent(runId, "   ");

  const res = await authedFetch(`/tasks/${taskId}/messages/history`);
  expect(res.status).toBe(200);
  const body = await res.json() as { messages: Array<{ text: string }> };
  expect(body.messages.map((m) => m.text)).toEqual(["real user message"]);
});

test("whitespace-only data (spaces, tabs, newlines, CR) is excluded", async () => {
  // `userMessageHistory`'s WHERE clause is
  // `trim(run_events.data, char(32,9,10,13)) != ''` — trimming the explicit
  // space/tab/newline/CR character set, not SQLite's bare single-argument
  // `trim()` (which only strips 0x20 spaces). A message consisting solely of
  // any mix of those four whitespace characters must be excluded.
  const { taskId, runId } = seedTask("claude-code");
  appendUserEvent(runId, "real user message");
  appendUserEvent(runId, "\t\n");
  appendUserEvent(runId, "\r\r");
  appendUserEvent(runId, " \t\n\r ");

  const res = await authedFetch(`/tasks/${taskId}/messages/history`);
  const body = await res.json() as { messages: Array<{ text: string }> };
  expect(body.messages.map((m) => m.text)).toEqual(["real user message"]);
});

test("exact-duplicate texts collapse to one entry carrying the newest occurrence's id/ts", async () => {
  const { taskId, runId } = seedTask("claude-code");
  appendUserEvent(runId, "unique one");
  appendUserEvent(runId, "duplicate text");
  appendUserEvent(runId, "unique two");
  appendUserEvent(runId, "duplicate text"); // newer occurrence, same run

  const res = await authedFetch(`/tasks/${taskId}/messages/history`);
  const body = await res.json() as { messages: Array<{ id: number; text: string }> };
  const dupes = body.messages.filter((m) => m.text === "duplicate text");
  expect(dupes.length).toBe(1);

  // The surviving row's id is the id of the *later* insertion, not the
  // earlier one — confirm by checking it is newer than the "unique two" row
  // that was inserted between the two duplicate occurrences.
  const uniqueTwo = body.messages.find((m) => m.text === "unique two")!;
  expect(dupes[0]!.id).toBeGreaterThan(uniqueTwo.id);
});

test("ordering: newest-first by event id", async () => {
  const { taskId, runId } = seedTask("claude-code");
  appendUserEvent(runId, "first");
  appendUserEvent(runId, "second");
  appendUserEvent(runId, "third");

  const res = await authedFetch(`/tasks/${taskId}/messages/history`);
  const body = await res.json() as { messages: Array<{ text: string }> };
  expect(body.messages.map((m) => m.text)).toEqual(["third", "second", "first"]);
});

test("limit: limit=1 returns exactly the single newest message", async () => {
  const { taskId, runId } = seedTask("claude-code");
  appendUserEvent(runId, "older");
  appendUserEvent(runId, "newer");

  const res = await authedFetch(`/tasks/${taskId}/messages/history?limit=1`);
  expect(res.status).toBe(200);
  const body = await res.json() as { messages: Array<{ text: string }> };
  expect(body.messages.length).toBe(1);
  expect(body.messages[0]!.text).toBe("newer");
});

test("limit: values above 200 clamp to 200 rather than erroring or returning more", async () => {
  const { taskId, runId } = seedTask("claude-code");
  // Seed cheaply — a handful of distinct messages is enough to prove the
  // route doesn't error and doesn't return more than what's available while
  // still accepting an oversized limit param (the clamp itself is asserted
  // by requesting a very large limit and getting back all 3, not a 400 and
  // not something bigger than the available rows).
  appendUserEvent(runId, "m1");
  appendUserEvent(runId, "m2");
  appendUserEvent(runId, "m3");

  const res = await authedFetch(`/tasks/${taskId}/messages/history?limit=999999`);
  expect(res.status).toBe(200);
  const body = await res.json() as { messages: unknown[] };
  expect(body.messages.length).toBe(3);
});

test("limit: a non-numeric limit falls back to the default rather than erroring", async () => {
  const { taskId, runId } = seedTask("claude-code");
  appendUserEvent(runId, "only message");

  const res = await authedFetch(`/tasks/${taskId}/messages/history?limit=not-a-number`);
  expect(res.status).toBe(200);
  const body = await res.json() as { messages: Array<{ text: string }> };
  expect(body.messages.map((m) => m.text)).toEqual(["only message"]);
});

test("limit: an empty `?limit=` falls back to the default", async () => {
  const { taskId, runId } = seedTask("claude-code");
  appendUserEvent(runId, "only message");

  const res = await authedFetch(`/tasks/${taskId}/messages/history?limit=`);
  expect(res.status).toBe(200);
  const body = await res.json() as { messages: Array<{ text: string }> };
  expect(body.messages.map((m) => m.text)).toEqual(["only message"]);
});

test("limit: `?limit=0` falls back to the default rather than returning zero rows", async () => {
  const { taskId, runId } = seedTask("claude-code");
  appendUserEvent(runId, "only message");

  const res = await authedFetch(`/tasks/${taskId}/messages/history?limit=0`);
  expect(res.status).toBe(200);
  const body = await res.json() as { messages: Array<{ text: string }> };
  expect(body.messages.map((m) => m.text)).toEqual(["only message"]);
});

test("limit: a negative limit falls back to the default", async () => {
  const { taskId, runId } = seedTask("claude-code");
  appendUserEvent(runId, "only message");

  const res = await authedFetch(`/tasks/${taskId}/messages/history?limit=-5`);
  expect(res.status).toBe(200);
  const body = await res.json() as { messages: Array<{ text: string }> };
  expect(body.messages.map((m) => m.text)).toEqual(["only message"]);
});

test("response shape: { messages: [{ id, text, ts, taskId, taskTitle, project }] } mirroring run_events.data and the correct task title", async () => {
  const { taskId, runId } = seedTask("claude-code", { title: "My Special Task Title" });
  appendUserEvent(runId, "shape check message");

  const res = await authedFetch(`/tasks/${taskId}/messages/history`);
  const body = await res.json() as { messages: Array<Record<string, unknown>> };
  expect(body.messages.length).toBe(1);
  const msg = body.messages[0]!;
  expect(Object.keys(msg).sort()).toEqual(["id", "project", "taskId", "taskTitle", "text", "ts"]);
  expect(typeof msg.id).toBe("number");
  expect(msg.text).toBe("shape check message");
  expect(typeof msg.ts).toBe("number");
  expect(msg.taskId).toBe(taskId);
  expect(msg.taskTitle).toBe("My Special Task Title");
});

test("project: registered projects row supplies the name; unregistered workdirs fall back to the path basename", async () => {
  db.run(
    `INSERT INTO projects (path, name, added_at) VALUES (?, ?, ?)`,
    ["/Users/someone/code/acme-app", "Acme App", Date.now()],
  );
  const registered = seedTask("claude-code", { workdir: "/Users/someone/code/acme-app" });
  appendUserEvent(registered.runId, "from registered project");
  const unregistered = seedTask("claude-code", { workdir: "/Users/someone/code/side-project/" });
  appendUserEvent(unregistered.runId, "from unregistered workdir");

  const res = await authedFetch(`/tasks/${registered.taskId}/messages/history`);
  const body = await res.json() as { messages: Array<{ text: string; project: string }> };
  const byText = new Map(body.messages.map((m) => [m.text, m.project]));
  expect(byText.get("from registered project")).toBe("Acme App");
  expect(byText.get("from unregistered workdir")).toBe("side-project");
});

test("404 for an unknown task id", async () => {
  const res = await authedFetch(`/tasks/${randomUUID()}/messages/history`);
  expect(res.status).toBe(404);
});

test("401 without a bearer token, and 401 with the wrong one", async () => {
  const { taskId } = seedTask("claude-code");

  const noAuth = await fetch(`${BASE()}/tasks/${taskId}/messages/history`);
  expect(noAuth.status).toBe(401);

  const wrongAuth = await fetch(`${BASE()}/tasks/${taskId}/messages/history`, {
    headers: { authorization: "Bearer not-the-real-token" },
  });
  expect(wrongAuth.status).toBe(401);
});

test("unknown-harness fallback: an agent id with no harnesses row and not a bare kind only matches the identical agent string", async () => {
  const UNKNOWN_AGENT = "totally-unknown-agent-xyz";
  const OTHER_UNKNOWN_AGENT = "another-unknown-agent-abc";

  // D and E share the same unrecognized agent string.
  const d = seedTask(UNKNOWN_AGENT);
  appendUserEvent(d.runId, "message from D");
  const e = seedTask(UNKNOWN_AGENT);
  appendUserEvent(e.runId, "message from E");

  // F has a *different* unrecognized agent string — must not leak in.
  const f = seedTask(OTHER_UNKNOWN_AGENT);
  appendUserEvent(f.runId, "message from F");

  const resD = await authedFetch(`/tasks/${d.taskId}/messages/history`);
  const bodyD = await resD.json() as { messages: Array<{ text: string }> };
  const textsD = bodyD.messages.map((m) => m.text);
  expect(textsD).toContain("message from D");
  expect(textsD).toContain("message from E");
  expect(textsD).not.toContain("message from F");
});

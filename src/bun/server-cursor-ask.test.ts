import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-server-cursor-ask-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4491";
process.env.AGETOR_CURSOR_DRIVER = "fake";
process.env.AGETOR_SKIP_CLI_VERSION_FLOOR = "1";

let server: { stop: () => void } | null = null;
let token: string;
const url = (p: string) => `http://127.0.0.1:4491${p}`;

beforeAll(async () => {
  const db = await import("./db.ts");
  db.harnesses.setEnabled("cursor", true);
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function seedCursorTask(taskId: string, runId: string): Promise<void> {
  const { tasks, runs } = await import("./db.ts");
  const cwd = mkdtempSync(path.join(tmpdir(), `agetor-cursor-ask-${taskId}-`));
  tasks.insert({
    id: taskId, title: taskId, prompt: "do the thing", column: "ready",
    agent: "cursor", workdir: cwd, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null, mode: "auto",
    model: "composer-1", effort: null, speed: "off", maxMode: false, opencodeServer: "shared",
    references: [], backlog: [], plans: [], draft: null, runId: null,
    createdAt: Date.now(), updatedAt: Date.now(), hasOpenableRun: false,
    pendingInteractionCount: 0, openTerminalCount: 0, archivedAt: null,
  });
  runs.insert({
    id: runId,
    taskId,
    agent: "cursor",
    status: "orphaned",
    startedAt: Date.now(),
    endedAt: Date.now(),
    exitCode: null,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
  });
}

test("scraper answer still plans keystrokes", async () => {
  const { __testing, registerScrapedAskQuestions, listPendingForTask } = await import("./interactions.ts");
  __testing.reset();
  const cwd = mkdtempSync(path.join(tmpdir(), "agetor-cursor-ask-scraper-"));
  const { tasks } = await import("./db.ts");
  tasks.insert({
    id: "t-scraper", title: "t-scraper", prompt: "", column: "running",
    agent: "claude-code", workdir: cwd, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null, mode: null,
    model: "opus-4.7", effort: null, speed: "off", maxMode: false, opencodeServer: "shared",
    references: [], backlog: [], plans: [], draft: null, runId: "run-scraper",
    createdAt: Date.now(), updatedAt: Date.now(), hasOpenableRun: false,
    pendingInteractionCount: 0, openTerminalCount: 0, archivedAt: null,
  });
  const req = registerScrapedAskQuestions({
    taskId: "t-scraper", runId: "run-scraper", fingerprint: "fp-scraper",
    questions: [{ question: "Pick", multiSelect: false, options: [{ label: "Red" }, { label: "Green" }] }],
  });
  const res = await fetch(url(`/ask-questions/${req.id}/answer`), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ answers: [{ selected: ["Green"] }] }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).delivery).toBe("drive");
  expect(listPendingForTask("t-scraper")).toHaveLength(0);
});

test("cursor submit maps the label to the option id", async () => {
  const { __testing, registerCursorAskQuestions } = await import("./interactions.ts");
  __testing.reset();
  const registered = registerCursorAskQuestions({
    taskId: "t-map",
    runId: "run-map",
    toolCallId: "call-map",
    title: "Pick one",
    delivery: "live",
    questions: [{
      id: "q1",
      prompt: "Which option?",
      allowMultiple: false,
      options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }],
    }],
  });
  const pending = registered.answer;
  const res = await fetch(url(`/ask-questions/${registered.id}/answer`), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ answers: [{ selected: ["Beta"] }] }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
  expect(await pending).toEqual({ outcome: "answered", answers: [{ questionId: "q1", selectedOptionIds: ["b"] }] });
});

test("cursor skip posts { skip: true }", async () => {
  const { __testing, registerCursorAskQuestions } = await import("./interactions.ts");
  __testing.reset();
  const registered = registerCursorAskQuestions({
    taskId: "t-skip",
    runId: "run-skip",
    toolCallId: "call-skip",
    delivery: "live",
    questions: [{ id: "q1", prompt: "Which?", options: [{ id: "a", label: "Alpha" }] }],
  });
  const res = await fetch(url(`/ask-questions/${registered.id}/answer`), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ skip: true }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
  expect(await registered.answer).toEqual({ outcome: "skipped" });
});

test("a custom-only answer is 400 and the card stays up", async () => {
  const { __testing, registerCursorAskQuestions, listPendingForTask } = await import("./interactions.ts");
  __testing.reset();
  const registered = registerCursorAskQuestions({
    taskId: "t-custom",
    runId: "run-custom",
    toolCallId: "call-custom",
    delivery: "live",
    questions: [{ id: "q1", prompt: "Which?", options: [{ id: "a", label: "Alpha" }] }],
  });
  const res = await fetch(url(`/ask-questions/${registered.id}/answer`), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ answers: [{ selected: [], custom: "something else" }] }),
  });
  expect(res.status).toBe(400);
  expect(listPendingForTask("t-custom")).toHaveLength(1);
  const { answerCursorAsk } = await import("./interactions.ts");
  answerCursorAsk(registered.id, { outcome: "cancelled" });
});

test("restart follow-up submit sends the answer message without a live child", async () => {
  const { __testing, registerCursorAskQuestions } = await import("./interactions.ts");
  const { db } = await import("./db.ts");
  __testing.reset();
  await seedCursorTask("t-restart", "run-restart");
  const registered = registerCursorAskQuestions({
    taskId: "t-restart",
    runId: "run-restart",
    toolCallId: "call-restart",
    title: "Pick one",
    delivery: "restart-followup",
    questions: [{
      id: "q1",
      prompt: "Which option?",
      allowMultiple: false,
      options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }],
    }],
  });
  const res = await fetch(url(`/ask-questions/${registered.id}/answer`), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ answers: [{ selected: ["Beta"] }] }),
  });
  const body = await res.json() as { ok?: boolean; reason?: string };
  expect(res.status).toBe(200);
  expect(body.ok).toBe(true);
  const rows = db.query<{ data: string }, [string]>(
    `SELECT data FROM run_events WHERE data LIKE ?`,
  ).all("%Here are my answers%");
  expect(rows.some((row) => row.data.includes("Which option?") && row.data.includes("Beta"))).toBe(true);
});

test("restart follow-up skip sends the print-mode skip sentence", async () => {
  const { __testing, registerCursorAskQuestions } = await import("./interactions.ts");
  const { db } = await import("./db.ts");
  __testing.reset();
  await seedCursorTask("t-restart-skip", "run-restart-skip");
  const registered = registerCursorAskQuestions({
    taskId: "t-restart-skip",
    runId: "run-restart-skip",
    toolCallId: "call-restart-skip",
    delivery: "restart-followup",
    questions: [{ id: "q1", prompt: "Which?", options: [{ id: "a", label: "Alpha" }] }],
  });
  const res = await fetch(url(`/ask-questions/${registered.id}/answer`), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ skip: true }),
  });
  const body = await res.json() as { ok?: boolean; reason?: string };
  expect(res.status).toBe(200);
  expect(body.ok).toBe(true);
  const rows = db.query<{ data: string }, []>(
    `SELECT data FROM run_events WHERE data LIKE '%Questions skipped by the user%'`,
  ).all();
  expect(rows.some((row) => row.data === "Questions skipped by the user, continue with the information you already have")).toBe(true);
});

test("a second submit while the restart follow-up is in flight is 409", async () => {
  const { __testing, registerCursorAskQuestions } = await import("./interactions.ts");
  __testing.reset();
  process.env.AGETOR_TEST_HOLD_CURSOR_ASK_MS = "200";
  await seedCursorTask("t-inflight", "run-inflight");
  const registered = registerCursorAskQuestions({
    taskId: "t-inflight",
    runId: "run-inflight",
    toolCallId: "call-inflight",
    delivery: "restart-followup",
    questions: [{ id: "q1", prompt: "Which?", options: [{ id: "a", label: "Alpha" }] }],
  });
  const post = () => fetch(url(`/ask-questions/${registered.id}/answer`), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ answers: [{ selected: ["Alpha"] }] }),
  });
  const [first, second] = await Promise.all([post(), post()]);
  delete process.env.AGETOR_TEST_HOLD_CURSOR_ASK_MS;
  const statuses = [first.status, second.status].sort();
  expect(statuses).toEqual([200, 409]);
});

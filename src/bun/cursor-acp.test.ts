import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-cursor-acp-"));
process.env.AGETOR_DATA_DIR = dataDir;

const scratch = mkdtempSync(path.join(tmpdir(), "agetor-cursor-acp-peer-"));
const fakeScript = path.join(scratch, "fake-cursor-acp.mjs");

writeFileSync(fakeScript, `
import fs from "node:fs";
const scenario = process.env.CURSOR_FAKE_SCENARIO || "plain";
const captureFile = process.env.CURSOR_FAKE_CAPTURE || "";
let buf = "";
const waiting = new Map();
let nextId = 10000;
let promptId = null;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}
function capture(label, msg) {
  if (!captureFile) return;
  fs.appendFileSync(captureFile, JSON.stringify({ label, msg }) + "\\n");
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}
function notify(update) {
  send({ jsonrpc: "2.0", method: "session/update", params: { update } });
}
function endPrompt(result) {
  send({ jsonrpc: "2.0", id: promptId, result });
}

const Q1 = {
  id: "q1",
  prompt: "Which option?",
  options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }],
  allowMultiple: false,
};
const Q2 = {
  id: "q2",
  prompt: "Which other?",
  options: [{ id: "c", label: "Gamma" }, { id: "d", label: "Delta" }],
  allowMultiple: false,
};

async function onPrompt() {
  if (scenario === "ask" || scenario === "ask-newline" || scenario === "skip" || scenario === "cancel") {
    const toolCallId = scenario === "ask-newline" ? "call\\n1" : "call-1";
    notify({
      sessionUpdate: "tool_call",
      toolCallId,
      rawInput: { _toolName: "askQuestion", title: "Pick one", questions: [Q1] },
    });
    const result = await request("cursor/ask_question", { toolCallId, title: "Pick one", questions: [Q1] });
    capture("ask-result", result);
    endPrompt({ stopReason: "end_turn" });
    return;
  }
  if (scenario === "two") {
    const first = request("cursor/ask_question", { toolCallId: "call-1", title: "Pick one", questions: [Q1] });
    const second = request("cursor/ask_question", { toolCallId: "call-2", title: "Pick two", questions: [Q2] });
    const results = await Promise.all([first, second]);
    capture("ask-result", results);
    endPrompt({ stopReason: "end_turn" });
    return;
  }
  if (scenario === "thinking") {
    notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
    notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: " ok" } });
    notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } });
    notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " there" } });
    endPrompt({ stopReason: "end_turn" });
    return;
  }
  if (scenario === "usage") {
    endPrompt({
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 4, cachedReadTokens: 1, cachedWriteTokens: 2 },
    });
    return;
  }
  if (scenario === "plan") {
    notify({
      sessionUpdate: "tool_call",
      toolCallId: "plan-1",
      rawInput: { _toolName: "createPlan", name: "Ship it", plan: "do the thing" },
    });
    endPrompt({ stopReason: "end_turn" });
    return;
  }
  endPrompt({ stopReason: "end_turn" });
}

function onLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  capture("in", msg);
  if (msg.id !== undefined && waiting.has(msg.id) && (Object.prototype.hasOwnProperty.call(msg, "result") || Object.prototype.hasOwnProperty.call(msg, "error"))) {
    const resolve = waiting.get(msg.id);
    waiting.delete(msg.id);
    resolve(msg.result);
    return;
  }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
    return;
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-new" } });
    return;
  }
  if (msg.method === "session/load") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: msg.params.sessionId } });
    return;
  }
  if (msg.method === "session/set_config_option" || msg.method === "session/set_mode") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/prompt") {
    promptId = msg.id;
    void onPrompt();
    return;
  }
}

process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) onLine(line);
  }
});
`);

let spawnCursorViaAcp: typeof import("./cursor-acp.ts").spawnCursorViaAcp;
let spawnFakeCursorAsk: typeof import("./cursor-acp.ts").spawnFakeCursorAsk;
let rebuildOpenCursorAsks: typeof import("./cursor-acp.ts").rebuildOpenCursorAsks;
let FAKE_CURSOR_ASK_PROMPT_MARKER: typeof import("./cursor-acp.ts").FAKE_CURSOR_ASK_PROMPT_MARKER;
let answerCursorAsk: typeof import("./interactions.ts").answerCursorAsk;
let listPendingForTask: typeof import("./interactions.ts").listPendingForTask;
let __testing: typeof import("./interactions.ts").__testing;
let insertCursorAsk: typeof import("./db.ts").insertCursorAsk;
let listOpenCursorAsks: typeof import("./db.ts").listOpenCursorAsks;
let FX_USAGE_STATUS_PREFIX: string;

beforeAll(async () => {
  ({ spawnCursorViaAcp, spawnFakeCursorAsk, rebuildOpenCursorAsks, FAKE_CURSOR_ASK_PROMPT_MARKER } = await import("./cursor-acp.ts"));
  ({ answerCursorAsk, listPendingForTask, __testing } = await import("./interactions.ts"));
  ({ insertCursorAsk, listOpenCursorAsks } = await import("./db.ts"));
  ({ FX_USAGE_STATUS_PREFIX } = await import("../shared/types.ts"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

type Chunk = { stream: string; data: string; lineUuid?: string };

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

function readCapture(file: string): Array<{ label: string; msg: unknown }> {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { label: string; msg: unknown });
  } catch {
    return [];
  }
}

function launch(scenario: string, extra: { mode?: string | null; model?: string; resumeSessionId?: string } = {}) {
  __testing.reset();
  const taskId = `task-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  const capture = path.join(scratch, `cap-${runId}.jsonl`);
  const chunks: Chunk[] = [];
  const sessionIds: string[] = [];
  const agent = spawnCursorViaAcp({
    taskId,
    runId,
    argv: [process.execPath, fakeScript],
    env: {
      PATH: process.env.PATH ?? "",
      CURSOR_FAKE_SCENARIO: scenario,
      CURSOR_FAKE_CAPTURE: capture,
    },
    cwd: scratch,
    promptText: "hello",
    mode: extra.mode ?? "auto",
    model: extra.model ?? "composer-1",
    resumeSessionId: extra.resumeSessionId,
    onChunk: (stream, data, lineUuid) => chunks.push({ stream, data, lineUuid }),
    onSessionId: (id) => sessionIds.push(id),
  });
  return { agent, taskId, runId, capture, chunks, sessionIds };
}

test("ask blocks until the card is answered, then the turn succeeds", async () => {
  const { agent, taskId, capture, chunks, sessionIds } = launch("ask");
  await waitFor(() => listPendingForTask(taskId).length === 1);
  const pending = listPendingForTask(taskId)[0]!;
  expect(pending.kind).toBe("ask_questions");
  if (pending.kind !== "ask_questions") return;
  expect(pending.source).toBe("cursor");
  expect(pending.delivery).toBe("live");
  expect(answerCursorAsk(pending.id, {
    outcome: "answered",
    answers: [{ questionId: "q1", selectedOptionIds: ["b"] }],
  })).toBe(true);
  expect(await agent.done).toBe(0);
  expect(sessionIds).toEqual(["sess-new"]);
  const tool = chunks.find((c) => c.stream === "tool_use");
  expect(tool?.lineUuid).toBe("tool_call:call-1:started");
  const parsed = JSON.parse(tool!.data) as { name: string; input: { askQuestionToolCall: { args: { title: string } } } };
  expect(parsed.name).toBe("askQuestionToolCall");
  expect(parsed.input.askQuestionToolCall.args.title).toBe("Pick one");
  await waitFor(() => readCapture(capture).some((row) => row.label === "ask-result"));
  const result = readCapture(capture).find((row) => row.label === "ask-result")!.msg as {
    outcome: { outcome: string; answers: Array<{ questionId: string; selectedOptionIds: string[] }> };
  };
  expect(result.outcome.outcome).toBe("answered");
  expect(result.outcome.answers).toEqual([{ questionId: "q1", selectedOptionIds: ["b"] }]);
  agent.kill();
});

test("a newline in the tool-call id is preserved on the card and the line uuid", async () => {
  const { agent, taskId, chunks } = launch("ask-newline");
  await waitFor(() => listPendingForTask(taskId).length === 1);
  const pending = listPendingForTask(taskId)[0]!;
  if (pending.kind !== "ask_questions") throw new Error("expected ask");
  expect(pending.toolCallId).toBe("call\n1");
  answerCursorAsk(pending.id, { outcome: "answered", answers: [{ questionId: "q1", selectedOptionIds: ["a"] }] });
  expect(await agent.done).toBe(0);
  expect(chunks.some((c) => c.lineUuid === "tool_call:call\n1:started")).toBe(true);
});

test("skip sends the nested skipped outcome and the turn succeeds", async () => {
  const { agent, taskId, capture } = launch("skip");
  await waitFor(() => listPendingForTask(taskId).length === 1);
  const pending = listPendingForTask(taskId)[0]!;
  answerCursorAsk(pending.id, { outcome: "skipped" });
  expect(await agent.done).toBe(0);
  await waitFor(() => readCapture(capture).some((row) => row.label === "ask-result"));
  const result = readCapture(capture).find((row) => row.label === "ask-result")!.msg as { outcome: { outcome: string } };
  expect(result.outcome).toEqual({ outcome: "skipped" });
});

test("cancel sends the nested cancelled outcome and does not succeed", async () => {
  const { agent, taskId, capture } = launch("cancel");
  await waitFor(() => listPendingForTask(taskId).length === 1);
  const pending = listPendingForTask(taskId)[0]!;
  answerCursorAsk(pending.id, { outcome: "cancelled" });
  expect(await agent.done).toBe(1);
  await waitFor(() => readCapture(capture).some((row) => row.label === "ask-result"));
  const result = readCapture(capture).find((row) => row.label === "ask-result")!.msg as { outcome: { outcome: string } };
  expect(result.outcome).toEqual({ outcome: "cancelled" });
});

test("two ask requests register two cards", async () => {
  const { agent, taskId } = launch("two");
  await waitFor(() => listPendingForTask(taskId).length === 2);
  const pending = listPendingForTask(taskId);
  expect(pending.map((p) => p.kind === "ask_questions" ? p.title : "")).toEqual(["Pick one", "Pick two"]);
  for (const card of pending) {
    if (card.kind !== "ask_questions") continue;
    const qid = card.questions[0]?.id;
    const opt = card.questions[0]?.options[0]?.id;
    answerCursorAsk(card.id, { outcome: "answered", answers: [{ questionId: qid ?? "", selectedOptionIds: [opt ?? ""] }] });
  }
  expect(await agent.done).toBe(0);
});

test("contiguous thought and message deltas each flush as one chunk", async () => {
  const { agent, chunks } = launch("thinking");
  expect(await agent.done).toBe(0);
  const thinking = chunks.filter((c) => c.stream === "thinking").map((c) => c.data);
  const assistant = chunks.filter((c) => c.stream === "assistant").map((c) => c.data);
  expect(thinking).toEqual(["hmm ok"]);
  expect(assistant).toEqual(["Hi there"]);
});

test("prompt usage is one status chunk with cache token names renamed", async () => {
  const { agent, chunks } = launch("usage");
  expect(await agent.done).toBe(0);
  const usage = chunks.find((c) => c.stream === "status" && c.data.startsWith(FX_USAGE_STATUS_PREFIX));
  expect(usage).toBeTruthy();
  const body = JSON.parse(usage!.data.slice(FX_USAGE_STATUS_PREFIX.length)) as { turn: Record<string, number> };
  expect(body.turn).toEqual({ inputTokens: 3, outputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 2 });
});

test("createPlan tool_call matches the pinned shape", async () => {
  const { agent, chunks } = launch("plan");
  expect(await agent.done).toBe(0);
  const tool = chunks.find((c) => c.stream === "tool_use");
  const parsed = JSON.parse(tool!.data) as {
    name: string;
    input: { createPlanToolCall: { args: { name: string; plan: string } } };
  };
  expect(parsed.name).toBe("createPlanToolCall");
  expect(parsed.input.createPlanToolCall.args).toEqual({ name: "Ship it", plan: "do the thing" });
  expect(tool?.lineUuid).toBe("tool_call:plan-1:started");
});

test("plan mode sends session/set_mode and auto does not; model is a config option; resume is session/load", async () => {
  const planned = launch("plain", { mode: "plan", model: "gpt-5" });
  expect(await planned.agent.done).toBe(0);
  const plannedIn = readCapture(planned.capture).filter((r) => r.label === "in").map((r) => r.msg as { method?: string; params?: { modeId?: string; configId?: string; value?: string } });
  expect(plannedIn.some((m) => m.method === "session/set_mode" && m.params?.modeId === "plan")).toBe(true);
  expect(plannedIn.some((m) => m.method === "session/set_config_option" && m.params?.configId === "model" && m.params?.value === "gpt-5")).toBe(true);

  const auto = launch("plain", { mode: "auto" });
  expect(await auto.agent.done).toBe(0);
  const autoMethods = readCapture(auto.capture).filter((r) => r.label === "in").map((r) => (r.msg as { method?: string }).method);
  expect(autoMethods).not.toContain("session/set_mode");

  const resumed = launch("plain", { resumeSessionId: "sess-old" });
  expect(await resumed.agent.done).toBe(0);
  expect(resumed.sessionIds).toEqual(["sess-old"]);
  const load = readCapture(resumed.capture).filter((r) => r.label === "in").map((r) => r.msg as { method?: string });
  expect(load.some((m) => m.method === "session/load")).toBe(true);
  expect(load.some((m) => m.method === "session/new")).toBe(false);
});

test("fake ask marker blocks until the card is answered", async () => {
  __testing.reset();
  const taskId = `task-${randomUUID()}`;
  const chunks: Chunk[] = [];
  const agent = spawnFakeCursorAsk({
    taskId,
    runId: "run-fake",
    prompt: FAKE_CURSOR_ASK_PROMPT_MARKER,
    onChunk: (stream, data, lineUuid) => chunks.push({ stream, data, lineUuid }),
  });
  await waitFor(() => listPendingForTask(taskId).length === 1);
  let finished = false;
  void agent.done.then(() => { finished = true; });
  await new Promise((r) => setTimeout(r, 40));
  expect(finished).toBe(false);
  const pending = listPendingForTask(taskId)[0]!;
  answerCursorAsk(pending.id, { outcome: "skipped" });
  expect(await agent.done).toBe(0);
  expect(chunks.some((c) => c.stream === "tool_use" && c.data.includes("askQuestionToolCall"))).toBe(true);
});

test("fake :2 marker registers two cards and cancel does not succeed", async () => {
  __testing.reset();
  const taskId = `task-${randomUUID()}`;
  const agent = spawnFakeCursorAsk({
    taskId,
    runId: "run-fake-2",
    prompt: `${FAKE_CURSOR_ASK_PROMPT_MARKER}:2`,
    onChunk: () => {},
  });
  await waitFor(() => listPendingForTask(taskId).length === 2);
  agent.kill();
  expect(await agent.done).toBe(1);
  expect(listPendingForTask(taskId)).toHaveLength(0);
});

test("rebuildOpenCursorAsks re-registers open rows as restart follow-ups without a second insert", async () => {
  __testing.reset();
  insertCursorAsk({
    taskId: "task-rebuild",
    toolCallId: "call-rebuild",
    runId: "run-rebuild",
    payload: {
      title: "Pick one",
      questions: [{ id: "q1", prompt: "Which option?", allowMultiple: false, options: [{ id: "a", label: "Alpha" }] }],
    },
  });
  expect(listOpenCursorAsks()).toHaveLength(1);
  rebuildOpenCursorAsks();
  expect(listOpenCursorAsks()).toHaveLength(1);
  const pending = listPendingForTask("task-rebuild");
  expect(pending).toHaveLength(1);
  const card = pending[0]!;
  if (card.kind !== "ask_questions") throw new Error("expected ask");
  expect(card.delivery).toBe("restart-followup");
  expect(card.source).toBe("cursor");
  expect(card.questions[0]?.question).toBe("Which option?");
  rebuildOpenCursorAsks();
  expect(listPendingForTask("task-rebuild")).toHaveLength(1);
  expect(listOpenCursorAsks()).toHaveLength(1);
});

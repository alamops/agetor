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
if (scenario === "ask-after-kill") {
  // The parent kill() sends SIGTERM before it writes the cancelled ask
  // result. Stay up long enough to record that result.
  process.on("SIGTERM", () => {
    setTimeout(() => process.exit(0), 500);
  });
}
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
function replayBeforeSessionResult(id, sessionId) {
  notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAY_ASSISTANT" } });
  notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "REPLAY_THOUGHT" } });
  notify({
    sessionUpdate: "tool_call",
    toolCallId: "replay-1",
    title: "replayed tool",
    rawInput: { command: "replayed-cmd" },
  });
  notify({
    sessionUpdate: "tool_call_update",
    toolCallId: "replay-1",
    status: "completed",
    rawOutput: { stdout: "replayed-out" },
  });
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, result: { sessionId } }) + "\\n" +
    JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "AFTER_RESOLVE" } } } }) + "\\n"
  );
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
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      rawInput: { command: "should-not-replace-the-ask" },
      rawOutput: { answered: true },
    });
    endPrompt({ stopReason: "end_turn" });
    return;
  }
  if (scenario === "ask-grow") {
    notify({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      rawInput: { _toolName: "askQuestion", title: "Pick", questions: [{ id: "q1", prompt: "Short?", options: [{ id: "a", label: "Alpha" }], allowMultiple: false }] },
    });
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      rawInput: { _toolName: "askQuestion", title: "Pick", questions: [{ id: "q1", prompt: "Which option, really?", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }], allowMultiple: false }] },
    });
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      rawInput: { _toolName: "askQuestion", title: "Pick", questions: [{ id: "q1", prompt: "shrunk", options: [{ id: "a", label: "Alpha" }], allowMultiple: false }] },
    });
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
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "plan-1",
      status: "completed",
      rawInput: { command: "should-not-replace-the-plan" },
      rawOutput: { planUri: "" },
    });
    endPrompt({ stopReason: "end_turn" });
    return;
  }
  if (scenario === "tool") {
    notify({
      sessionUpdate: "tool_call",
      toolCallId: "sh-1",
      title: "Run ls",
      rawInput: { command: "l" },
    });
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "sh-1",
      status: "in_progress",
      rawInput: { command: "ls" },
    });
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "sh-1",
      status: "completed",
      rawInput: { command: "ls" },
      rawOutput: { stdout: "a.ts\\n", exitCode: 0 },
      content: [{ type: "content", content: { type: "text", text: "ignored" } }],
    });
    endPrompt({ stopReason: "end_turn" });
    return;
  }
  if (scenario === "tool-after-result") {
    notify({
      sessionUpdate: "tool_call",
      toolCallId: "sh-3",
      title: "Run ls",
      rawInput: { command: "l" },
    });
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "sh-3",
      status: "completed",
      rawInput: { command: "ls" },
      rawOutput: { stdout: "a.ts\\n" },
    });
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "sh-3",
      status: "completed",
      rawInput: { command: "ls -la" },
      rawOutput: { stdout: "late\\n" },
    });
    endPrompt({ stopReason: "end_turn" });
    return;
  }
  if (scenario === "tool-failed") {
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "sh-2",
      title: "Run rm",
      status: "failed",
      rawOutput: { stderr: "no" },
    });
    endPrompt({ stopReason: "end_turn" });
    return;
  }
  if (scenario === "replay") {
    notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "LIVE_TURN" } });
    notify({
      sessionUpdate: "tool_call",
      toolCallId: "live-1",
      title: "live tool",
      rawInput: { command: "live-cmd" },
    });
    endPrompt({ stopReason: "end_turn" });
    return;
  }
  if (scenario === "permission") {
    const result = await request("session/request_permission", {
      sessionId: "sess-new",
      toolCall: { toolCallId: "sh-1", title: "Run ls", kind: "execute" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    capture("permission-result", result);
    endPrompt({ stopReason: "end_turn" });
    return;
  }
  if (scenario === "ask-exit") {
    const toolCallId = "call-1";
    notify({
      sessionUpdate: "tool_call",
      toolCallId,
      rawInput: { _toolName: "askQuestion", title: "Pick one", questions: [Q1] },
    });
    const id = nextId++;
    waiting.set(id, (result) => capture("ask-result", result));
    send({
      jsonrpc: "2.0",
      id,
      method: "cursor/ask_question",
      params: { toolCallId, title: "Pick one", questions: [Q1] },
    });
    const exitFile = process.env.CURSOR_FAKE_EXIT_FILE || "";
    const started = Date.now();
    const poll = () => {
      if (exitFile && fs.existsSync(exitFile)) {
        process.exit(1);
        return;
      }
      if (Date.now() - started > 4000) {
        process.exit(1);
        return;
      }
      setTimeout(poll, 15);
    };
    poll();
    return;
  }
  if (scenario === "ask-after-kill") {
    const id = nextId++;
    const ask = {
      jsonrpc: "2.0",
      id,
      method: "cursor/ask_question",
      params: { toolCallId: "call-late", title: "Pick one", questions: [Q1] },
    };
    waiting.set(id, (result) => capture("ask-result", result));
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "pre-kill",
            title: "before",
            rawInput: { command: "echo hi" },
          },
        },
      }) + "\\n" + JSON.stringify(ask) + "\\n"
    );
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
    if (scenario === "replay") {
      replayBeforeSessionResult(msg.id, "sess-new");
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-new" } });
    return;
  }
  if (msg.method === "session/load") {
    if (scenario === "replay") {
      replayBeforeSessionResult(msg.id, msg.params.sessionId);
      return;
    }
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
let cursorAskResultWriteCount: typeof import("./cursor-acp.ts").cursorAskResultWriteCount;
let FAKE_CURSOR_ASK_PROMPT_MARKER: typeof import("./cursor-acp.ts").FAKE_CURSOR_ASK_PROMPT_MARKER;
let answerCursorAsk: typeof import("./interactions.ts").answerCursorAsk;
let listPendingForTask: typeof import("./interactions.ts").listPendingForTask;
let __testing: typeof import("./interactions.ts").__testing;
let insertCursorAsk: typeof import("./db.ts").insertCursorAsk;
let listOpenCursorAsks: typeof import("./db.ts").listOpenCursorAsks;
let FX_USAGE_STATUS_PREFIX: string;

beforeAll(async () => {
  ({ spawnCursorViaAcp, spawnFakeCursorAsk, rebuildOpenCursorAsks, cursorAskResultWriteCount, FAKE_CURSOR_ASK_PROMPT_MARKER } = await import("./cursor-acp.ts"));
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

function launch(
  scenario: string,
  extra: { mode?: string | null; model?: string; resumeSessionId?: string; killOnTool?: boolean } = {},
) {
  __testing.reset();
  const taskId = `task-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  const capture = path.join(scratch, `cap-${runId}.jsonl`);
  const exitFile = path.join(scratch, `exit-${runId}`);
  const chunks: Chunk[] = [];
  const sessionIds: string[] = [];
  let agent!: ReturnType<typeof spawnCursorViaAcp>;
  agent = spawnCursorViaAcp({
    taskId,
    runId,
    argv: [process.execPath, fakeScript],
    env: {
      PATH: process.env.PATH ?? "",
      CURSOR_FAKE_SCENARIO: scenario,
      CURSOR_FAKE_CAPTURE: capture,
      CURSOR_FAKE_EXIT_FILE: exitFile,
    },
    cwd: scratch,
    promptText: "hello",
    mode: extra.mode ?? "auto",
    model: extra.model ?? "composer-1",
    resumeSessionId: extra.resumeSessionId,
    onChunk: (stream, data, lineUuid) => {
      chunks.push({ stream, data, lineUuid });
      // The tool_use and the ask request share one stdout chunk. Killing
      // here runs before the reader parses the next line.
      if (extra.killOnTool && stream === "tool_use") agent.kill();
    },
    onSessionId: (id) => sessionIds.push(id),
  });
  return { agent, taskId, runId, capture, chunks, sessionIds, exitFile };
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
  const toolUses = chunks.filter((c) => c.stream === "tool_use");
  expect(toolUses).toHaveLength(1);
  expect(toolUses[0]!.data).toContain("askQuestionToolCall");
  expect(toolUses[0]!.data).not.toContain("should-not-replace-the-ask");
  const resultChunk = chunks.find((c) => c.stream === "tool_result");
  expect(resultChunk?.lineUuid).toBe("tool_call:call-1:completed");
  expect(JSON.parse(resultChunk!.data)).toEqual({
    toolUseId: "call-1",
    content: { answered: true },
    isError: false,
  });
  await waitFor(() => readCapture(capture).some((row) => row.label === "ask-result"));
  const result = readCapture(capture).find((row) => row.label === "ask-result")!.msg as {
    outcome: { outcome: string; answers: Array<{ questionId: string; selectedOptionIds: string[] }> };
  };
  expect(result.outcome.outcome).toBe("answered");
  expect(result.outcome.answers).toEqual([{ questionId: "q1", selectedOptionIds: ["b"] }]);
  agent.kill();
});

test("a larger ask update replaces the pin and a shorter one does not", async () => {
  const { agent, chunks } = launch("ask-grow");
  expect(await agent.done).toBe(0);
  const uses = chunks.filter((c) => c.stream === "tool_use");
  expect(uses).toHaveLength(2);
  expect(uses.every((c) => c.lineUuid === "tool_call:call-1:started")).toBe(true);
  const last = JSON.parse(uses[1]!.data) as {
    input: { askQuestionToolCall: { args: { questions: Array<{ prompt: string; options: Array<{ label: string }> }> } } };
  };
  expect(last.input.askQuestionToolCall.args.questions[0]?.prompt).toBe("Which option, really?");
  expect(last.input.askQuestionToolCall.args.questions[0]?.options.map((o) => o.label)).toEqual(["Alpha", "Beta"]);
  expect(uses[1]!.data).not.toContain("shrunk");
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
  expect(chunks.filter((c) => c.stream === "tool_use")).toHaveLength(1);
  const planResult = chunks.find((c) => c.stream === "tool_result");
  expect(planResult?.lineUuid).toBe("tool_call:plan-1:completed");
  expect(JSON.parse(planResult!.data).content).toEqual({ planUri: "" });
});

test("tool_call_update grows rawInput and emits rawOutput as the tool_result", async () => {
  const { agent, chunks } = launch("tool");
  expect(await agent.done).toBe(0);
  const uses = chunks.filter((c) => c.stream === "tool_use");
  expect(uses.map((c) => JSON.parse(c.data).input)).toEqual([{ command: "l" }, { command: "ls" }]);
  expect(uses.every((c) => c.lineUuid === "tool_call:sh-1:started")).toBe(true);
  const result = chunks.find((c) => c.stream === "tool_result");
  expect(result?.lineUuid).toBe("tool_call:sh-1:completed");
  expect(JSON.parse(result!.data)).toEqual({
    toolUseId: "sh-1",
    content: { stdout: "a.ts\n", exitCode: 0 },
    isError: false,
  });
});

test("a tool_call_update after the result does not emit another tool_use", async () => {
  const { agent, chunks } = launch("tool-after-result");
  expect(await agent.done).toBe(0);
  const uses = chunks.filter((c) => c.stream === "tool_use");
  expect(uses.map((c) => JSON.parse(c.data).input)).toEqual([{ command: "l" }, { command: "ls" }]);
  const resultAt = chunks.findIndex((c) => c.stream === "tool_result");
  expect(resultAt).toBeGreaterThan(-1);
  expect(chunks.findIndex((c) => c === uses[uses.length - 1])).toBeLessThan(resultAt);
  expect(chunks.some((c) => c.data.includes("ls -la"))).toBe(false);
  expect(chunks.filter((c) => c.stream === "tool_result")).toHaveLength(1);
});

test("a failed tool_call_update with no prior tool_call still pairs a tool_result", async () => {
  const { agent, chunks } = launch("tool-failed");
  expect(await agent.done).toBe(0);
  expect(chunks.some((c) => c.stream === "tool_use" && c.data.includes("Run rm"))).toBe(true);
  const result = chunks.find((c) => c.stream === "tool_result");
  expect(JSON.parse(result!.data)).toEqual({
    toolUseId: "sh-2",
    content: { stderr: "no" },
    isError: true,
  });
});

test("session/request_permission is allow-once, not method-not-found", async () => {
  const { agent, capture } = launch("permission", { mode: "plan" });
  expect(await agent.done).toBe(0);
  await waitFor(() => readCapture(capture).some((row) => row.label === "permission-result"));
  const result = readCapture(capture).find((row) => row.label === "permission-result")!.msg as {
    outcome: { outcome: string; optionId?: string };
  };
  expect(result).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
});

test("session/load replay is dropped; an update after the result line is kept", async () => {
  const { agent, chunks } = launch("replay", { resumeSessionId: "sess-old" });
  expect(await agent.done).toBe(0);
  const joined = chunks.map((c) => c.data).join("\n");
  expect(joined).not.toContain("REPLAY_ASSISTANT");
  expect(joined).not.toContain("REPLAY_THOUGHT");
  expect(joined).not.toContain("replayed-cmd");
  expect(joined).not.toContain("replayed-out");
  expect(joined).toContain("AFTER_RESOLVE");
  expect(joined).toContain("LIVE_TURN");
  expect(joined).toContain("live-cmd");
  expect(chunks.some((c) => c.lineUuid === "tool_call:replay-1:started")).toBe(false);
  expect(chunks.some((c) => c.lineUuid === "tool_call:live-1:started")).toBe(true);
});

test("session/new drops updates until its result line", async () => {
  const { agent, chunks } = launch("replay");
  expect(await agent.done).toBe(0);
  const joined = chunks.map((c) => c.data).join("\n");
  expect(joined).not.toContain("REPLAY_ASSISTANT");
  expect(joined).not.toContain("REPLAY_THOUGHT");
  expect(joined).not.toContain("replayed-cmd");
  expect(joined).toContain("AFTER_RESOLVE");
  expect(joined).toContain("LIVE_TURN");
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
  const result = chunks.find((c) => c.stream === "tool_result");
  expect(result?.lineUuid).toBe("tool_call:fake-ask-1:completed");
  expect(JSON.parse(result?.data ?? "{}")).toEqual({
    toolUseId: "fake-ask-1",
    content: "skipped",
    isError: false,
  });
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

test("cursor/ask_question read after kill answers cancelled and does not register a card", async () => {
  const { agent, taskId, capture, chunks } = launch("ask-after-kill", { killOnTool: true });
  expect(await agent.done).toBe(1);
  expect(listPendingForTask(taskId)).toEqual([]);
  expect(listOpenCursorAsks().some((row) => row.taskId === taskId)).toBe(false);
  expect(chunks.some((c) => c.data.includes("call-late"))).toBe(false);
  await waitFor(() => readCapture(capture).some((row) => row.label === "ask-result"));
  const result = readCapture(capture).find((row) => row.label === "ask-result")!.msg as {
    outcome: { outcome: string };
  };
  expect(result.outcome).toEqual({ outcome: "cancelled" });
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
  expect(card.followupCause).toBe("restart");
  expect(card.source).toBe("cursor");
  expect(card.questions[0]?.question).toBe("Which option?");
  rebuildOpenCursorAsks();
  expect(listPendingForTask("task-rebuild")).toHaveLength(1);
  expect(listOpenCursorAsks()).toHaveLength(1);
});

test("peer exit while a live ask is pending retargets that run's card and does not deliver", async () => {
  const { agent, taskId, exitFile } = launch("ask-exit");
  await waitFor(() => {
    const pending = listPendingForTask(taskId);
    const card = pending[0];
    return pending.length === 1 && card?.kind === "ask_questions" && card.delivery === "live";
  });
  const writes = cursorAskResultWriteCount();
  writeFileSync(exitFile, "x");
  expect(await agent.done).toBe(1);
  const pending = listPendingForTask(taskId);
  expect(pending).toHaveLength(1);
  const card = pending[0]!;
  if (card.kind !== "ask_questions") throw new Error("expected ask");
  expect(card.delivery).toBe("restart-followup");
  expect(card.followupCause).toBe("child-exit");
  expect(card.toolCallId).toBe("call-1");
  expect(listOpenCursorAsks().some((row) => row.taskId === taskId && row.toolCallId === "call-1")).toBe(true);
  expect(answerCursorAsk(card.id, {
    outcome: "answered",
    answers: [{ questionId: "q1", selectedOptionIds: ["a"] }],
  })).toBe(true);
  await new Promise((r) => setTimeout(r, 30));
  expect(cursorAskResultWriteCount()).toBe(writes);
  expect(listOpenCursorAsks().some((row) => row.taskId === taskId && row.toolCallId === "call-1")).toBe(false);
});

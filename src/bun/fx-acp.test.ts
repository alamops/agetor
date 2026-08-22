import { describe, test, expect, beforeAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// fx-acp.ts (unlike cursor-tmux.ts / gemini-tmux.ts) does NOT import
// db.ts/dataDir — it's a plain Bun.spawn driver over stdio with no on-disk
// NDJSON log of its own (fx writes its own --log-file, which this driver
// never reads). So there is no AGETOR_DATA_DIR-before-import dance needed
// here; confirmed by reading fx-acp.ts's imports (node:fs, node:path, "bun",
// ../shared/types.ts, and a TYPE-ONLY import from ./claude-tmux.ts that is
// erased at compile time and never pulls db.ts in at runtime).
import {
  dropFxSession,
  fxSessionActive,
  reapLiveFxProcs,
  spawnFxViaAcp,
  type FxLaunchOptions,
  type FxMode,
} from "./fx-acp.ts";
import { FX_USAGE_STATUS_PREFIX, SESSION_DIED_STATUS_PREFIX, type RunEventStream } from "../shared/types.ts";
// fx-acp.ts's own permission driving is the thing under test here, but the
// tests themselves need to reach into the SAME in-memory registry the driver
// awaits on — there is no other way to answer a carded fx_permission request
// from outside the driver (that's the whole point of the registry: it's the
// seam `POST /fx-permissions/:id/answer` uses in the real app). interactions.ts
// has no db.ts import (verified above the fake-server block already covers
// fx-acp.ts's own import graph) so pulling it in here doesn't need an
// AGETOR_DATA_DIR dance either.
import { answerFxPermission, listPendingForTask, type FxPermissionRequest } from "./interactions.ts";
import { deriveTodoProgress } from "../shared/todo-progress.ts";

/* ────────────────────────────────────────────────────────────────────────── *
 * Fake `fx acp` server: a real child process that speaks newline-delimited
 * JSON-RPC 2.0 over stdio, scenario-controlled via FX_FAKE_SCENARIO. Written
 * once to a mkdtemp dir at module load and reused (via argv + env) across
 * every test — no loose fixture files land in the repo.
 *
 * Every inbound message the fake receives (requests, notifications, and the
 * driver's own replies to server-initiated requests like
 * session/request_permission) is appended as one JSON line to
 * FX_FAKE_CAPTURE_FILE, `{label, msg}`, so tests can assert on what the
 * driver actually sent without race-prone stdout scraping.
 * ────────────────────────────────────────────────────────────────────────── */

const FAKE_ACP_SERVER_SRC = [
  'import { appendFileSync } from "node:fs";',
  "",
  'const scenario = process.env.FX_FAKE_SCENARIO || "happy";',
  'const captureFile = process.env.FX_FAKE_CAPTURE_FILE || "";',
  "",
  "function capture(label, msg) {",
  "  if (!captureFile) return;",
  "  try {",
  '    appendFileSync(captureFile, JSON.stringify({ label: label, msg: msg }) + "\\n");',
  "  } catch (e) {",
  "    // best effort",
  "  }",
  "}",
  "",
  "function send(obj) {",
  '  process.stdout.write(JSON.stringify(obj) + "\\n");',
  "}",
  "",
  "function ok(id, result) {",
  '  send({ jsonrpc: "2.0", id: id, result: result });',
  "}",
  "",
  "function fail(id, code, message) {",
  '  send({ jsonrpc: "2.0", id: id, error: { code: code, message: message } });',
  "}",
  "",
  "function notify(method, params) {",
  '  send({ jsonrpc: "2.0", method: method, params: params });',
  "}",
  "",
  "// Test hygiene: collapses the repeated",
  "// setTimeout(function () { ok(id, { stopReason: X }) }, N) shape that used",
  "// to be duplicated per scenario. `reason` defaults to \"end_turn\".",
  "function endTurn(id, ms, reason) {",
  "  setTimeout(function () {",
  '    ok(id, { stopReason: reason || "end_turn" });',
  "  }, ms);",
  "}",
  "",
  'process.on("SIGTERM", function () {',
  '  capture("sigterm", {});',
  "  process.exit(0);",
  "});",
  "",
  'let buf = "";',
  "let promptId = null;",
  "let cancelPromptResponded = false;",
  "let sessionCounter = 0;",
  "",
  "function streamHappyUpdates() {",
  '  notify("session/update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } } });',
  '  notify("session/update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } } });',
  '  notify("session/update", { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking..." } } });',
  '  notify("session/update", { update: { sessionUpdate: "tool_call", toolCallId: "tc-42", title: "Run ls", kind: "execute", rawInput: { cmd: "ls" } } });',
  '  notify("session/update", { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-42", status: "completed", rawOutput: { stdout: "a.txt" } } });',
  "}",
  "",
  "function handleInitialize(id, params) {",
  '  if (scenario === "unauth") {',
  '    fail(id, -32600, "Fx needs access to Vercel AI Gateway. Run fx login to authenticate.");',
  "    return;",
  "  }",
  '  if (scenario === "unauth-die-race") {',
  '    fail(id, -32600, "Fx needs access to Vercel AI Gateway. Run fx login to authenticate.");',
  "    process.exit(1);",
  "    return;",
  "  }",
  '  if (scenario === "initialize-error-mimics-timeout") {',
  "    // A REAL fx protocol error whose message happens to start with the",
  '    // exact wording our own RpcTimeoutError uses ("timed out waiting for").',
  "    // Regression: this must be classified by error CLASS, not by matching",
  "    // that text, or the driver would misreport this as a generic",
  "    // session-died sentinel instead of surfacing fx's actual message.",
  '    fail(id, -32000, "timed out waiting for gateway upstream");',
  "    return;",
  "  }",
  "  ok(id, {});",
  "}",
  "",
  "function handleSessionNew(id, params) {",
  "  sessionCounter = sessionCounter + 1;",
  '  const sessionId = "sess-" + scenario + "-" + sessionCounter;',
  '  ok(id, { sessionId: sessionId, modes: { availableModes: [{ id: "code" }, { id: "ask" }] } });',
  "}",
  "",
  "function handleSessionResume(id, params) {",
  '  capture("session/resume", params);',
  '  if (scenario === "resume-fallback") {',
  '    fail(id, -32601, "Method not found (fake, forcing fallback)");',
  "    return;",
  "  }",
  "  ok(id, {});",
  "}",
  "",
  "function handleSessionLoad(id, params) {",
  '  capture("session/load", params);',
  '  if (scenario === "resume-fallback") {',
  '    notify("session/update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAYED must be discarded" } } });',
  "    setTimeout(function () { ok(id, {}); }, 15);",
  "    return;",
  "  }",
  "  ok(id, {});",
  "}",
  "",
  "function handlePrompt(id, params) {",
  "  promptId = id;",
  '  capture("session/prompt", params);',
  '  if (scenario === "happy" || scenario === "resume" || scenario === "resume-fallback") {',
  "    streamHappyUpdates();",
  '    endTurn(id, 20, "end_turn");',
  "    return;",
  "  }",
  '  if (scenario === "permission") {',
  '    notify("session/update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "need permission" } } });',
  "    send({",
  '      jsonrpc: "2.0",',
  '      id: "perm-1",',
  '      method: "session/request_permission",',
  "      params: {",
  '        toolCall: { toolCallId: "tc-perm-1", title: "Run something", kind: "execute" },',
  "        options: [",
  '          { optionId: "allow-always", kind: "allow_always" },',
  '          { optionId: "allow-once", kind: "allow_once" },',
  '          { optionId: "reject-once", kind: "reject_once" }',
  "        ]",
  "      }",
  "    });",
  "    return;",
  "  }",
  '  if (scenario === "permission-stop") {',
  '    notify("session/update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "need permission" } } });',
  "    send({",
  '      jsonrpc: "2.0",',
  '      id: "perm-stop",',
  '      method: "session/request_permission",',
  "      params: {",
  '        toolCall: { toolCallId: "tc-perm-stop", title: "Run something", kind: "execute" },',
  "        options: [",
  '          { optionId: "allow-once", kind: "allow_once" },',
  '          { optionId: "reject-once", kind: "reject_once" }',
  "        ]",
  "      }",
  "    });",
  "    return;",
  "  }",
  '  if (scenario === "permission-empty") {',
  "    send({",
  '      jsonrpc: "2.0",',
  '      id: "perm-empty",',
  '      method: "session/request_permission",',
  "      params: {",
  '        toolCall: { toolCallId: "tc-empty", title: "Run something", kind: "execute" },',
  "        options: []",
  "      }",
  "    });",
  "    return;",
  "  }",
  '  if (scenario === "permission-die") {',
  "    send({",
  '      jsonrpc: "2.0",',
  '      id: "perm-die",',
  '      method: "session/request_permission",',
  "      params: {",
  '        toolCall: { toolCallId: "tc-die", title: "Run something", kind: "execute" },',
  "        options: [",
  '          { optionId: "allow-once", kind: "allow_once" },',
  '          { optionId: "reject-once", kind: "reject_once" }',
  "        ]",
  "      }",
  "    });",
  '    setTimeout(function () { process.exit(1); }, 20);',
  "    return;",
  "  }",
  '  if (scenario === "plan-update") {',
  '    notify("session/update", { update: { sessionUpdate: "plan", entries: [',
  '      { content: "Write tests", status: "completed", priority: "high" },',
  '      { content: "", status: "pending" },',
  '      { content: "Fix bug", status: "bogus-status", priority: "low" },',
  '      { content: "Ship it", status: "in_progress" }',
  "    ] } });",
  '    notify("session/update", { update: { sessionUpdate: "plan", entries: [] } });',
  '    endTurn(id, 15, "end_turn");',
  "    return;",
  "  }",
  '  if (scenario === "usage-update") {',
  '    notify("session/update", { update: { sessionUpdate: "usage_update", used: 100, size: 1000, cost: { amount: 0.05, currency: "USD" } } });',
  '    notify("session/update", { update: { sessionUpdate: "usage_update", used: 200, size: 1000, cost: { amount: 0.1 } } });',
  '    notify("session/update", { update: { sessionUpdate: "usage_update", used: "not-a-number", size: 1000 } });',
  '    endTurn(id, 15, "end_turn");',
  "    return;",
  "  }",
  '  if (scenario === "stopreason-refusal") {',
  '    endTurn(id, 10, "refusal");',
  "    return;",
  "  }",
  '  if (scenario === "stopreason-cancelled") {',
  '    endTurn(id, 10, "cancelled");',
  "    return;",
  "  }",
  '  if (scenario === "kill-cancel") {',
  '    notify("session/update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working..." } } });',
  "    return;",
  "  }",
  '  if (scenario === "cancel-permission-race") {',
  '    notify("session/update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working..." } } });',
  "    return;",
  "  }",
  '  if (scenario === "die-mid-turn") {',
  "    setTimeout(function () { process.exit(1); }, 20);",
  "    return;",
  "  }",
  '  if (scenario === "malformed-line") {',
  '    notify("session/update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "before" } } });',
  '    process.stdout.write("not json at all, this line should be skipped\\n");',
  '    notify("session/update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after" } } });',
  '    endTurn(id, 15, "end_turn");',
  "    return;",
  "  }",
  '  if (scenario === "missing-tool-call-id") {',
  '    notify("session/update", { update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Run", kind: "execute", rawInput: {} } });',
  '    notify("session/update", { update: { sessionUpdate: "tool_call_update", status: "completed", rawOutput: {} } });',
  '    endTurn(id, 15, "end_turn");',
  "    return;",
  "  }",
  '  if (scenario === "stall-for-drop") {',
  "    return;",
  "  }",
  "  streamHappyUpdates();",
  '  endTurn(id, 20, "end_turn");',
  "}",
  "",
  "function handleCancel(params) {",
  '  capture("session/cancel", params);',
  '  if (scenario === "kill-cancel" && promptId !== null && !cancelPromptResponded) {',
  "    cancelPromptResponded = true;",
  "    const respondId = promptId;",
  '    endTurn(respondId, 10, "cancelled");',
  "  }",
  '  if (scenario === "permission-stop" && promptId !== null && !cancelPromptResponded) {',
  "    cancelPromptResponded = true;",
  "    const respondId = promptId;",
  '    endTurn(respondId, 15, "cancelled");',
  "  }",
  '  if (scenario === "cancel-permission-race") {',
  "    // A permission request racing the client's cancel: sent AFTER the",
  "    // client's session/cancel arrived, while the prompt is still pending.",
  "    // The driver must answer it cancelled, never via the allow policy.",
  "    send({",
  '      jsonrpc: "2.0",',
  '      id: "perm-race",',
  '      method: "session/request_permission",',
  "      params: {",
  "        options: [",
  '          { optionId: "allow-always", kind: "allow_always" },',
  '          { optionId: "allow-once", kind: "allow_once" },',
  '          { optionId: "reject-once", kind: "reject_once" }',
  "        ]",
  "      }",
  "    });",
  "  }",
  "}",
  "",
  "function handleReply(msg) {",
  '  capture("reply", msg);',
  '  if (msg.id === "perm-1" && promptId !== null) {',
  '    endTurn(promptId, 10, "end_turn");',
  "  }",
  '  if (msg.id === "perm-empty" && promptId !== null) {',
  '    endTurn(promptId, 10, "end_turn");',
  "  }",
  '  if (msg.id === "perm-race" && promptId !== null) {',
  "    const respondId = promptId;",
  '    endTurn(respondId, 10, "cancelled");',
  "  }",
  "}",
  "",
  "function handleMethodMessage(msg) {",
  "  const id = msg.id;",
  "  const method = msg.method;",
  "  const params = msg.params;",
  '  if (method === "initialize") { handleInitialize(id, params); return; }',
  '  if (method === "session/new") { handleSessionNew(id, params); return; }',
  '  if (method === "session/resume") { handleSessionResume(id, params); return; }',
  '  if (method === "session/load") { handleSessionLoad(id, params); return; }',
  '  if (method === "session/set_mode") { ok(id, {}); return; }',
  '  if (method === "session/prompt") { handlePrompt(id, params); return; }',
  '  if (method === "session/cancel") { handleCancel(params); return; }',
  '  fail(id, -32601, "method not found (fake): " + method);',
  "}",
  "",
  "function onLine(line) {",
  "  let msg;",
  "  try {",
  "    msg = JSON.parse(line);",
  "  } catch (e) {",
  '    capture("malformed-inbound", line);',
  "    return;",
  "  }",
  "  const isReply = msg.id !== undefined && (Object.prototype.hasOwnProperty.call(msg, \"result\") || Object.prototype.hasOwnProperty.call(msg, \"error\"));",
  "  if (isReply) {",
  "    handleReply(msg);",
  "    return;",
  "  }",
  "  if (msg.method) {",
  "    handleMethodMessage(msg);",
  "  }",
  "}",
  "",
  'process.stdin.on("data", function (chunk) {',
  '  buf += chunk.toString("utf8");',
  "  let nl;",
  '  while ((nl = buf.indexOf("\\n")) >= 0) {',
  "    const line = buf.slice(0, nl);",
  "    buf = buf.slice(nl + 1);",
  "    if (line.trim().length > 0) onLine(line);",
  "  }",
  "});",
  "",
].join("\n");

let fakeScriptPath: string;
let scratchDir: string;

beforeAll(() => {
  scratchDir = mkdtempSync(path.join(tmpdir(), "agetor-fx-acp-test-"));
  fakeScriptPath = path.join(scratchDir, "fake-fx-acp.mjs");
  writeFileSync(fakeScriptPath, FAKE_ACP_SERVER_SRC);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Test helpers.
 * ────────────────────────────────────────────────────────────────────────── */

type Chunk = { stream: RunEventStream; data: string; lineUuid?: string };

async function waitFor(predicate: () => boolean, timeoutMs = 4000, intervalMs = 15): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out waiting for condition");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function readCaptured(captureFile: string): Array<{ label: string; msg: unknown }> {
  if (!existsSync(captureFile)) return [];
  return readFileSync(captureFile, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function spawnFake(
  scenario: string,
  opts: { mode?: FxMode; resumeSessionId?: string; env?: Record<string, string> } = {},
) {
  const chunks: Chunk[] = [];
  const onChunk: FxLaunchOptions["onChunk"] = (stream, data, lineUuid) => chunks.push({ stream, data, lineUuid });
  const sessionIds: string[] = [];
  const taskId = `task-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  const captureFile = path.join(scratchDir, `capture-${runId}.jsonl`);

  const agent = spawnFxViaAcp({
    taskId,
    runId,
    argv: [process.execPath, fakeScriptPath],
    env: { FX_FAKE_SCENARIO: scenario, FX_FAKE_CAPTURE_FILE: captureFile, ...(opts.env ?? {}) },
    cwd: tmpdir(),
    promptText: "hello fx",
    mode: opts.mode ?? "auto",
    resumeSessionId: opts.resumeSessionId,
    onChunk,
    onSessionId: (id) => sessionIds.push(id),
  });

  return { agent, chunks, sessionIds, taskId, runId, captureFile };
}

/** Poll the shared interactions registry until an `fx_permission` card shows
 *  up for this task, then return it. Mirrors how the real UI would discover
 *  a card via `GET /tasks/:id/events` replay / SSE — there is no push hook
 *  in this test file, so we poll the same registry the route handler reads. */
async function waitForFxPermissionCard(taskId: string, timeoutMs = 4000): Promise<FxPermissionRequest> {
  let found: FxPermissionRequest | undefined;
  await waitFor(() => {
    found = listPendingForTask(taskId).find((r) => r.kind === "fx_permission") as FxPermissionRequest | undefined;
    return found !== undefined;
  }, timeoutMs);
  return found!;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 1. Happy path — first turn.
 * ────────────────────────────────────────────────────────────────────────── */

describe("happy path (first turn)", () => {
  test(
    "streams assistant/thinking/tool chunks with correctly-shaped line_uuids, fires onSessionId, resolves ok, and reaps the child",
    async () => {
      const { agent, chunks, sessionIds, taskId, runId, captureFile } = spawnFake("happy");

      expect(fxSessionActive(taskId)).toBe(true);

      const code = await agent.done;
      expect(code).toBe(0);

      // Session id surfaced exactly once, from session/new.
      expect(sessionIds).toEqual([`sess-happy-1`]);

      const assistantChunks = chunks.filter((c) => c.stream === "assistant");
      const thinkingChunks = chunks.filter((c) => c.stream === "thinking");
      const toolUseChunks = chunks.filter((c) => c.stream === "tool_use");
      const toolResultChunks = chunks.filter((c) => c.stream === "tool_result");

      expect(assistantChunks.map((c) => c.data)).toEqual(["Hello ", "world"]);
      expect(assistantChunks.map((c) => c.lineUuid)).toEqual([`fx:${runId}:0`, `fx:${runId}:1`]);

      expect(thinkingChunks).toHaveLength(1);
      expect(thinkingChunks[0]?.data).toBe("thinking...");
      expect(thinkingChunks[0]?.lineUuid).toBe(`fx:${runId}:2`);

      expect(toolUseChunks).toHaveLength(1);
      expect(toolUseChunks[0]?.lineUuid).toBe("fx:tool:tc-42:use");
      expect(JSON.parse(toolUseChunks[0]!.data)).toMatchObject({
        id: "tc-42",
        name: "Run ls (execute)",
        input: { cmd: "ls" },
        serverSide: false,
      });

      expect(toolResultChunks).toHaveLength(1);
      expect(toolResultChunks[0]?.lineUuid).toBe("fx:tool:tc-42:result");
      expect(JSON.parse(toolResultChunks[0]!.data)).toMatchObject({
        toolUseId: "tc-42",
        content: { stdout: "a.txt" },
        isError: false,
      });

      // No leak: the in-memory session is gone post-settlement...
      expect(fxSessionActive(taskId)).toBe(false);
      // ...and the child process was actually torn down (SIGTERM observed by
      // the fake), not merely forgotten about in the map.
      await waitFor(() => readCaptured(captureFile).some((e) => e.label === "sigterm"));
    },
    10_000,
  );
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 2. Resume — follow-up turn.
 * ────────────────────────────────────────────────────────────────────────── */

describe("resume turn", () => {
  test(
    "sends session/resume with the prior session id and does not re-fire onSessionId",
    async () => {
      const resumeId = "resume-existing-id-1";
      const { agent, sessionIds, captureFile } = spawnFake("resume", { resumeSessionId: resumeId });

      const code = await agent.done;
      expect(code).toBe(0);
      expect(sessionIds).toEqual([]); // not re-announced on resume

      const entries = readCaptured(captureFile);
      const resumeReq = entries.find((e) => e.label === "session/resume");
      expect(resumeReq).toBeDefined();
      expect((resumeReq!.msg as { sessionId?: string }).sessionId).toBe(resumeId);
    },
    10_000,
  );
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 3. Resume fallback: session/resume -32601 → session/load, discarding
 *    anything replayed as session/update before the load response.
 * ────────────────────────────────────────────────────────────────────────── */

describe("resume fallback (session/load)", () => {
  test(
    "falls back to session/load on -32601 and discards replayed session/update history",
    async () => {
      const resumeId = "resume-existing-id-2";
      const { agent, chunks, captureFile } = spawnFake("resume-fallback", { resumeSessionId: resumeId });

      const code = await agent.done;
      expect(code).toBe(0);

      const entries = readCaptured(captureFile);
      expect(entries.some((e) => e.label === "session/resume")).toBe(true);
      const loadReq = entries.find((e) => e.label === "session/load");
      expect(loadReq).toBeDefined();
      expect((loadReq!.msg as { sessionId?: string }).sessionId).toBe(resumeId);

      // The replayed chunk sent by the fake WHILE session/load was pending
      // must never reach onChunk.
      expect(chunks.some((c) => c.data.includes("REPLAYED"))).toBe(false);

      // The turn still proceeds normally after the fallback completes.
      expect(chunks.some((c) => c.stream === "assistant" && c.data === "Hello ")).toBe(true);
    },
    10_000,
  );
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 4. Permission policy.
 * ────────────────────────────────────────────────────────────────────────── */

describe("session/request_permission auto-answer policy", () => {
  /** Shared by every mode that answers `session/request_permission`
   *  SYNCHRONOUSLY — yolo (allow) and any unknown/future mode id (fail-closed
   *  reject) — neither ever surfaces a card, so this also asserts
   *  `listPendingForTask` stays empty for both callers. */
  async function permissionOutcomeFor(mode: FxMode): Promise<{ outcome: string; optionId?: string }> {
    const { agent, taskId, captureFile } = spawnFake("permission", { mode });
    const code = await agent.done;
    expect(code).toBe(0);
    expect(listPendingForTask(taskId)).toHaveLength(0);

    const entries = readCaptured(captureFile);
    const reply = entries.find((e) => e.label === "reply" && (e.msg as { id?: string }).id === "perm-1");
    expect(reply).toBeDefined();
    const result = (reply!.msg as { result?: { outcome?: { outcome: string; optionId?: string } } }).result;
    expect(result?.outcome).toBeDefined();
    return result!.outcome!;
  }

  test("auto mode registers a card, and the driver's reply echoes whatever the card is answered with", async () => {
    const { agent, taskId, captureFile } = spawnFake("permission", { mode: "auto" });

    const card = await waitForFxPermissionCard(taskId);
    expect(card.taskId).toBe(taskId);
    expect(card.mode).toBe("auto");
    expect(card.toolCall).toEqual({ toolCallId: "tc-perm-1", title: "Run something", kind: "execute" });
    // Every option lacks a `name` on the wire (see the fake's "permission"
    // scenario) — the driver falls back to `optionId` for each.
    expect(card.options).toEqual([
      { optionId: "allow-always", name: "allow-always", kind: "allow_always" },
      { optionId: "allow-once", name: "allow-once", kind: "allow_once" },
      { optionId: "reject-once", name: "reject-once", kind: "reject_once" },
    ]);

    expect(answerFxPermission(card.id, { optionId: "allow-once" })).toBe(true);

    const code = await agent.done;
    expect(code).toBe(0);

    const entries = readCaptured(captureFile);
    const reply = entries.find((e) => e.label === "reply" && (e.msg as { id?: string }).id === "perm-1");
    expect(reply).toBeDefined();
    const result = (reply!.msg as { result?: { outcome?: { outcome: string; optionId?: string } } }).result;
    expect(result?.outcome).toEqual({ outcome: "selected", optionId: "allow-once" });

    // The card is gone from the registry once answered.
    expect(listPendingForTask(taskId)).toHaveLength(0);
  }, 10_000);

  test("yolo mode answers allow_once with no card ever registered", async () => {
    const outcome = await permissionOutcomeFor("yolo");
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
  }, 10_000);

  test("ask mode registers a card, and answering it reject-once flows through to fx", async () => {
    const { agent, taskId, captureFile } = spawnFake("permission", { mode: "ask" });

    const card = await waitForFxPermissionCard(taskId);
    expect(card.mode).toBe("ask");

    expect(answerFxPermission(card.id, { optionId: "reject-once" })).toBe(true);

    const code = await agent.done;
    expect(code).toBe(0);

    const entries = readCaptured(captureFile);
    const reply = entries.find((e) => e.label === "reply" && (e.msg as { id?: string }).id === "perm-1");
    expect(reply).toBeDefined();
    const result = (reply!.msg as { result?: { outcome?: { outcome: string; optionId?: string } } }).result;
    expect(result?.outcome).toEqual({ outcome: "selected", optionId: "reject-once" });

    expect(listPendingForTask(taskId)).toHaveLength(0);
  }, 10_000);

  test("a card answered cancelled replies with outcome cancelled", async () => {
    const { agent, taskId, captureFile } = spawnFake("permission", { mode: "ask" });

    const card = await waitForFxPermissionCard(taskId);
    expect(answerFxPermission(card.id, { cancelled: true })).toBe(true);

    const code = await agent.done;
    expect(code).toBe(0); // the fake resolves end_turn on any reply to perm-1

    const entries = readCaptured(captureFile);
    const reply = entries.find((e) => e.label === "reply" && (e.msg as { id?: string }).id === "perm-1");
    expect(reply).toBeDefined();
    const result = (reply!.msg as { result?: { outcome?: { outcome: string; optionId?: string } } }).result;
    expect(result?.outcome).toEqual({ outcome: "cancelled" });

    expect(listPendingForTask(taskId)).toHaveLength(0);
  }, 10_000);

  test("kill() while a card is open resolves the card (registry empties) and fx receives outcome cancelled", async () => {
    const { agent, chunks, taskId, captureFile } = spawnFake("permission-stop", { mode: "auto" });

    await waitFor(() => chunks.some((c) => c.stream === "assistant" && c.data === "need permission"));
    const card = await waitForFxPermissionCard(taskId);
    expect(card.mode).toBe("auto");

    agent.kill();

    // The card must resolve out of the registry promptly, driven by
    // cancelFxTurn's drain loop — not left dangling until the process dies.
    await waitFor(() => listPendingForTask(taskId).length === 0);

    const code = await agent.done;
    expect(code).toBe(1);

    const entries = readCaptured(captureFile);
    const reply = entries.find((e) => e.label === "reply" && (e.msg as { id?: string }).id === "perm-stop");
    expect(reply).toBeDefined();
    const result = (reply!.msg as { result?: { outcome?: { outcome: string; optionId?: string } } }).result;
    expect(result?.outcome).toEqual({ outcome: "cancelled" });
  }, 10_000);

  test("empty options auto-cancels with no card ever registered, and emits a status chunk saying so", async () => {
    const { agent, chunks, taskId, captureFile } = spawnFake("permission-empty", { mode: "auto" });

    const code = await agent.done;
    expect(code).toBe(0);

    expect(listPendingForTask(taskId)).toHaveLength(0);

    const entries = readCaptured(captureFile);
    const reply = entries.find((e) => e.label === "reply" && (e.msg as { id?: string }).id === "perm-empty");
    expect(reply).toBeDefined();
    const result = (reply!.msg as { result?: { outcome?: { outcome: string; optionId?: string } } }).result;
    expect(result?.outcome).toEqual({ outcome: "cancelled" });

    const statusChunks = chunks.filter((c) => c.stream === "status");
    expect(statusChunks.some((c) => c.data.includes("no options"))).toBe(true);
  }, 10_000);

  test("process death while a card is open removes it from the registry (settleFx's sweep) and fails the turn", async () => {
    const { agent, chunks, taskId } = spawnFake("permission-die", { mode: "auto" });

    const card = await waitForFxPermissionCard(taskId);
    expect(card.toolCall.toolCallId).toBe("tc-die");

    const code = await agent.done;
    expect(code).toBe(1);

    // settleFx's card sweep resolved it — never left dangling past death.
    expect(listPendingForTask(taskId)).toHaveLength(0);

    const statusChunks = chunks.filter((c) => c.stream === "status");
    expect(statusChunks.some((c) => c.data.startsWith(SESSION_DIED_STATUS_PREFIX))).toBe(true);
  }, 10_000);

  test("unknown/future mode id fails closed to reject_once", async () => {
    // "weird-unknown" isn't a real FxMode, but the driver's policy switch
    // takes the reject arm for anything that isn't "yolo"/"auto" — cast past
    // the type to exercise that fail-closed default the same way an
    // unreleased mode id passed through verbatim from buildCommand would.
    const outcome = await permissionOutcomeFor("weird-unknown" as FxMode);
    expect(outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
  }, 10_000);

  test("a permission request arriving AFTER cancel is answered cancelled, not via the allow policy", async () => {
    // Regression for the cancel-window race: kill() sends session/cancel,
    // and the fake replies by sending a session/request_permission (with
    // allow options) — i.e. a request racing the cancellation. Even in
    // permissive "auto" mode the driver must answer it with outcome
    // "cancelled": an allow here would authorize fx to START a new tool
    // action in the middle of a user-initiated Stop.
    const { agent, chunks, captureFile } = spawnFake("cancel-permission-race", { mode: "auto" });
    await waitFor(() => chunks.some((c) => c.stream === "assistant" && c.data.includes("working")));
    agent.kill();
    const code = await agent.done;
    expect(code).toBe(1);

    const entries = readCaptured(captureFile);
    const reply = entries.find((e) => e.label === "reply" && (e.msg as { id?: string }).id === "perm-race");
    expect(reply).toBeDefined();
    const result = (reply!.msg as { result?: { outcome?: { outcome: string; optionId?: string } } }).result;
    expect(result?.outcome).toEqual({ outcome: "cancelled" });
  }, 10_000);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 4b. `plan` → synthetic TodoWrite tool_use.
 * ────────────────────────────────────────────────────────────────────────── */

describe("plan session/update → TodoWrite tool_use", () => {
  test(
    "coerces entries (blank content dropped, bogus status → pending, priority dropped) and a later empty-entries plan clears it",
    async () => {
      const { agent, chunks } = spawnFake("plan-update");
      const code = await agent.done;
      expect(code).toBe(0);

      const toolUseChunks = chunks.filter((c) => c.stream === "tool_use");
      expect(toolUseChunks).toHaveLength(2);

      const first = JSON.parse(toolUseChunks[0]!.data);
      expect(first.name).toBe("TodoWrite");
      // "Write tests" (completed), the blank-content entry dropped, "Fix bug"
      // (bogus status → pending, priority dropped), "Ship it" (in_progress).
      expect(first.input.todos).toEqual([
        { content: "Write tests", status: "completed" },
        { content: "Fix bug", status: "pending" },
        { content: "Ship it", status: "in_progress" },
      ]);

      const second = JSON.parse(toolUseChunks[1]!.data);
      expect(second.name).toBe("TodoWrite");
      expect(second.input.todos).toEqual([]);

      // deriveTodoProgress reads the LAST TodoWrite snapshot — the explicit
      // empty clear — so it must report null (no usable state), not the
      // first snapshot's counts.
      const progress = deriveTodoProgress(chunks.map((c) => ({ stream: c.stream, data: c.data })));
      expect(progress).toBeNull();
    },
    10_000,
  );

  test("deriveTodoProgress over just the first snapshot reports 1/3 completed", async () => {
    // Re-derive over a prefix of the same event stream (everything up to and
    // including the first plan's tool_use) to assert the {completed,total}
    // shape independent of the second (clearing) snapshot.
    const { agent, chunks } = spawnFake("plan-update");
    await agent.done;

    const toolUseChunks = chunks.filter((c) => c.stream === "tool_use");
    const firstIndex = chunks.indexOf(toolUseChunks[0]!);
    const prefix = chunks.slice(0, firstIndex + 1).map((c) => ({ stream: c.stream, data: c.data }));

    const progress = deriveTodoProgress(prefix);
    expect(progress).not.toBeNull();
    expect(progress!.completed).toBe(1);
    expect(progress!.total).toBe(3);
  }, 10_000);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 4c. `usage_update` → FX_USAGE_STATUS_PREFIX status chunk.
 * ────────────────────────────────────────────────────────────────────────── */

describe("usage_update session/update → status chunk", () => {
  test(
    "valid used/size/cost emits a chunk; a malformed cost drops only cost; non-numeric used/size drops the whole update",
    async () => {
      const { agent, chunks } = spawnFake("usage-update");
      const code = await agent.done;
      expect(code).toBe(0);

      const usageChunks = chunks
        .filter((c) => c.stream === "status" && c.data.startsWith(FX_USAGE_STATUS_PREFIX))
        .map((c) => JSON.parse(c.data.slice(FX_USAGE_STATUS_PREFIX.length)));

      // Only two of the three fake updates should have produced a chunk —
      // the third (non-numeric `used`) is silently dropped in full.
      expect(usageChunks).toHaveLength(2);
      expect(usageChunks[0]).toEqual({ used: 100, size: 1000, cost: { amount: 0.05, currency: "USD" } });
      // Malformed cost (missing `currency`) is dropped on its own —
      // used/size still emit with no `cost` key at all.
      expect(usageChunks[1]).toEqual({ used: 200, size: 1000 });
      expect("cost" in usageChunks[1]).toBe(false);
    },
    10_000,
  );
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 5. stopReason mapping.
 * ────────────────────────────────────────────────────────────────────────── */

describe("stopReason mapping", () => {
  test(
    "refusal fails the turn and emits a status chunk naming it",
    async () => {
      const { agent, chunks } = spawnFake("stopreason-refusal");
      const code = await agent.done;
      expect(code).toBe(1);
      const statusChunks = chunks.filter((c) => c.stream === "status");
      expect(statusChunks.some((c) => c.data === "fx turn ended: refusal")).toBe(true);
    },
    10_000,
  );

  test(
    "cancelled (via server-reported stopReason, not a kill) settles the turn as failed with no extra status noise",
    async () => {
      const { agent, chunks } = spawnFake("stopreason-cancelled");
      const code = await agent.done;
      expect(code).toBe(1);
      // The driver leaves cancelled-vs-failed classification to the
      // orchestrator's own `handle.cancelled` flag — no status chunk here.
      expect(chunks.filter((c) => c.stream === "status")).toHaveLength(0);
    },
    10_000,
  );
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 6. Unauthenticated initialize.
 * ────────────────────────────────────────────────────────────────────────── */

describe("unauthenticated fx binary", () => {
  test(
    "surfaces the actionable Vercel AI Gateway message as a status chunk and fails the turn",
    async () => {
      const { agent, chunks } = spawnFake("unauth");
      const code = await agent.done;
      expect(code).toBe(1);
      const statusChunks = chunks.filter((c) => c.stream === "status");
      expect(statusChunks.some((c) => c.data.includes("Fx needs access to Vercel AI Gateway"))).toBe(true);
    },
    10_000,
  );
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 6.5. RpcTimeoutError classification — regression.
 *
 * `isTimeoutError` distinguishes "we gave up waiting" (our own RpcTimeoutError
 * class, thrown only by `withTimeout`'s internal timer) from a real fx error
 * whose message happens to start with the identical wording. If that
 * distinction were ever done by string-matching instead of `instanceof`, a
 * real fx protocol error reading "timed out waiting for X" would be
 * misreported as the generic SESSION_DIED_STATUS_PREFIX sentinel instead of
 * fx's own actionable message.
 * ────────────────────────────────────────────────────────────────────────── */

describe("RpcTimeoutError classification", () => {
  test(
    "a real fx error whose message starts with 'timed out waiting for' is surfaced verbatim, never reclassified as SESSION_DIED",
    async () => {
      const { agent, chunks } = spawnFake("initialize-error-mimics-timeout");
      const code = await agent.done;
      expect(code).toBe(1);

      const statusChunks = chunks.filter((c) => c.stream === "status");
      expect(statusChunks).toHaveLength(1);
      // Verbatim fx error text (plus the driver's own "(code N)" suffix from
      // errMessage/handleLine) — not the synthetic "fx did not respond to
      // initialize within 30000ms" wording `isTimeoutError`'s true branch
      // would have produced had it string-matched instead of class-checked.
      expect(statusChunks[0]!.data).toBe("timed out waiting for gateway upstream (code -32000)");
      expect(statusChunks[0]!.data.startsWith("timed out waiting for")).toBe(true);
      expect(statusChunks[0]!.data.startsWith(SESSION_DIED_STATUS_PREFIX)).toBe(false);
    },
    10_000,
  );
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 7. Kill / cancel.
 * ────────────────────────────────────────────────────────────────────────── */

describe("kill() during an in-flight turn", () => {
  test(
    "sends session/cancel, the fake resolves with stopReason cancelled, and done resolves promptly (no hang on the grace period)",
    async () => {
      const { agent, chunks, captureFile } = spawnFake("kill-cancel");

      // Wait until the turn is actually in flight (the fake has started
      // streaming) before cancelling, so session/cancel has a live prompt to
      // interrupt.
      await waitFor(() => chunks.some((c) => c.stream === "assistant" && c.data === "working..."));

      const killedAt = Date.now();
      agent.kill();
      const code = await agent.done;
      const elapsedMs = Date.now() - killedAt;

      expect(code).toBe(1);
      // Well under CANCEL_WAIT_MS (3000ms) plus KILL_GRACE_MS (2000ms) — the
      // fake answers session/cancel almost immediately, so this proves the
      // driver didn't fall through to the force-kill timeout.
      expect(elapsedMs).toBeLessThan(2000);

      const entries = readCaptured(captureFile);
      expect(entries.some((e) => e.label === "session/cancel")).toBe(true);
    },
    10_000,
  );
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 8. Death.
 * ────────────────────────────────────────────────────────────────────────── */

describe("process death", () => {
  test(
    "an unexpected mid-turn exit with no prompt response emits the SESSION_DIED sentinel and fails the turn",
    async () => {
      const { agent, chunks } = spawnFake("die-mid-turn");
      const code = await agent.done;
      expect(code).toBe(1);
      const statusChunks = chunks.filter((c) => c.stream === "status");
      expect(statusChunks.some((c) => c.data.startsWith(SESSION_DIED_STATUS_PREFIX))).toBe(true);
    },
    10_000,
  );

  test(
    "an actionable initialize error that arrives just before the process exits wins over the generic session-died sentinel",
    async () => {
      const { agent, chunks } = spawnFake("unauth-die-race");
      const code = await agent.done;
      expect(code).toBe(1);
      const statusChunks = chunks.filter((c) => c.stream === "status");
      // The actionable auth message must be present...
      expect(statusChunks.some((c) => c.data.includes("Fx needs access to Vercel AI Gateway"))).toBe(true);
      // ...and the generic death sentinel must NOT have clobbered it (the
      // driver settles on the first failure, so only one status chunk should
      // exist at all).
      expect(statusChunks.some((c) => c.data.startsWith(SESSION_DIED_STATUS_PREFIX))).toBe(false);
    },
    10_000,
  );
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 9. Malformed line mid-stream.
 * ────────────────────────────────────────────────────────────────────────── */

describe("malformed stdout line", () => {
  test(
    "a non-JSON line is skipped without interrupting subsequent chunks or the turn",
    async () => {
      const { agent, chunks } = spawnFake("malformed-line");
      const code = await agent.done;
      expect(code).toBe(0);
      const assistantChunks = chunks.filter((c) => c.stream === "assistant");
      expect(assistantChunks.map((c) => c.data)).toEqual(["before", "after"]);
    },
    10_000,
  );
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 10. tool_call_update with a missing toolCallId.
 * ────────────────────────────────────────────────────────────────────────── */

describe("tool_call_update with no toolCallId", () => {
  test(
    "is dropped rather than emitted as an orphan tool_result",
    async () => {
      const { agent, chunks } = spawnFake("missing-tool-call-id");
      const code = await agent.done;
      expect(code).toBe(0);
      expect(chunks.filter((c) => c.stream === "tool_use")).toHaveLength(1);
      expect(chunks.filter((c) => c.stream === "tool_result")).toHaveLength(0);
    },
    10_000,
  );
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 11. dropFxSession.
 * ────────────────────────────────────────────────────────────────────────── */

describe("dropFxSession", () => {
  test(
    "kills a live turn's process and clears the in-memory session",
    async () => {
      const { agent, sessionIds, taskId, captureFile } = spawnFake("stall-for-drop");

      // Wait until the session is actually live (session/new resolved) before
      // dropping it, so this exercises tearing down a real in-flight turn
      // rather than one that never got that far.
      await waitFor(() => sessionIds.length === 1);
      expect(fxSessionActive(taskId)).toBe(true);

      dropFxSession(taskId);

      expect(fxSessionActive(taskId)).toBe(false);
      const code = await agent.done;
      expect(code).toBe(1);

      await waitFor(() => readCaptured(captureFile).some((e) => e.label === "sigterm"));
    },
    10_000,
  );

  test("is a safe no-op when no session exists for the task", () => {
    expect(() => dropFxSession(`task-nonexistent-${randomUUID()}`)).not.toThrow();
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 12. reapLiveFxProcs.
 * ────────────────────────────────────────────────────────────────────────── */

describe("reapLiveFxProcs", () => {
  test(
    "SIGKILLs every live fx child directly (no signal sent to the test process itself) and the turn settles failed once the exit is observed",
    async () => {
      const { agent, sessionIds, taskId, captureFile } = spawnFake("stall-for-drop");

      // Wait until the session is actually live before reaping, so this
      // exercises tearing down a real in-flight turn.
      await waitFor(() => sessionIds.length === 1);
      expect(fxSessionActive(taskId)).toBe(true);

      // reapLiveFxProcs() only ever calls proc.kill("SIGKILL") on the tracked
      // children — it never delivers a signal to this test process, so no
      // SIGINT/SIGTERM/SIGHUP handler runs and bun's own test process stays
      // untouched.
      reapLiveFxProcs();

      const code = await agent.done;
      expect(code).toBe(1);
      // The exit watcher (proc.exited.then(...)) observes the SIGKILL exit,
      // fails the turn with the SESSION_DIED sentinel, and settleFx clears
      // the in-memory session — same end state as dropFxSession, reached via
      // a different (signal-handler) entry point.
      expect(fxSessionActive(taskId)).toBe(false);

      // SIGKILL bypasses the fake's own SIGTERM handler entirely — no
      // "sigterm" capture line is ever written. This distinguishes
      // reapLiveFxProcs's hard kill from dropFxSession/killProc's graceful
      // SIGTERM-then-SIGKILL sequence (asserted in the sibling test above).
      expect(readCaptured(captureFile).some((e) => e.label === "sigterm")).toBe(false);
    },
    10_000,
  );

  test("is a safe no-op when no fx child is currently live", () => {
    expect(() => reapLiveFxProcs()).not.toThrow();
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 13. Signal-handler registration (module-load side effect).
 * ────────────────────────────────────────────────────────────────────────── */

describe("signal handlers", () => {
  test("SIGINT/SIGTERM/SIGHUP reap handlers are installed once fx-acp.ts has been imported", () => {
    // fx-acp.ts is imported at the top of this file, so its top-level
    // `for (const [sig] of FX_REAP_SIGNALS) process.on(sig, ...)` loop has
    // already run by the time this test executes — verified by presence,
    // not by re-importing (Bun's module cache means a second import
    // wouldn't re-run the registration anyway).
    expect(process.listenerCount("SIGINT")).toBeGreaterThanOrEqual(1);
    expect(process.listenerCount("SIGTERM")).toBeGreaterThanOrEqual(1);
    expect(process.listenerCount("SIGHUP")).toBeGreaterThanOrEqual(1);
  });
});

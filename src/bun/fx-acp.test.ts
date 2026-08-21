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
import { dropFxSession, fxSessionActive, spawnFxViaAcp, type FxLaunchOptions, type FxMode } from "./fx-acp.ts";
import { SESSION_DIED_STATUS_PREFIX, type RunEventStream } from "../shared/types.ts";

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
  '    setTimeout(function () { ok(id, { stopReason: "end_turn" }); }, 20);',
  "    return;",
  "  }",
  '  if (scenario === "permission") {',
  '    notify("session/update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "need permission" } } });',
  "    send({",
  '      jsonrpc: "2.0",',
  '      id: "perm-1",',
  '      method: "session/request_permission",',
  "      params: {",
  "        options: [",
  '          { optionId: "allow-always", kind: "allow_always" },',
  '          { optionId: "allow-once", kind: "allow_once" },',
  '          { optionId: "reject-once", kind: "reject_once" }',
  "        ]",
  "      }",
  "    });",
  "    return;",
  "  }",
  '  if (scenario === "stopreason-refusal") {',
  '    setTimeout(function () { ok(id, { stopReason: "refusal" }); }, 10);',
  "    return;",
  "  }",
  '  if (scenario === "stopreason-cancelled") {',
  '    setTimeout(function () { ok(id, { stopReason: "cancelled" }); }, 10);',
  "    return;",
  "  }",
  '  if (scenario === "kill-cancel") {',
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
  '    setTimeout(function () { ok(id, { stopReason: "end_turn" }); }, 15);',
  "    return;",
  "  }",
  '  if (scenario === "missing-tool-call-id") {',
  '    notify("session/update", { update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Run", kind: "execute", rawInput: {} } });',
  '    notify("session/update", { update: { sessionUpdate: "tool_call_update", status: "completed", rawOutput: {} } });',
  '    setTimeout(function () { ok(id, { stopReason: "end_turn" }); }, 15);',
  "    return;",
  "  }",
  '  if (scenario === "stall-for-drop") {',
  "    return;",
  "  }",
  "  streamHappyUpdates();",
  '  setTimeout(function () { ok(id, { stopReason: "end_turn" }); }, 20);',
  "}",
  "",
  "function handleCancel(params) {",
  '  capture("session/cancel", params);',
  '  if (scenario === "kill-cancel" && promptId !== null && !cancelPromptResponded) {',
  "    cancelPromptResponded = true;",
  "    const respondId = promptId;",
  '    setTimeout(function () { ok(respondId, { stopReason: "cancelled" }); }, 10);',
  "  }",
  "}",
  "",
  "function handleReply(msg) {",
  '  capture("reply", msg);',
  '  if (msg.id === "perm-1" && promptId !== null) {',
  '    setTimeout(function () { ok(promptId, { stopReason: "end_turn" }); }, 10);',
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
  async function permissionOutcomeFor(mode: FxMode): Promise<{ outcome: string; optionId?: string }> {
    const { agent, captureFile } = spawnFake("permission", { mode });
    const code = await agent.done;
    expect(code).toBe(0);

    const entries = readCaptured(captureFile);
    const reply = entries.find((e) => e.label === "reply" && (e.msg as { id?: string }).id === "perm-1");
    expect(reply).toBeDefined();
    const result = (reply!.msg as { result?: { outcome?: { outcome: string; optionId?: string } } }).result;
    expect(result?.outcome).toBeDefined();
    return result!.outcome!;
  }

  test("auto mode answers allow_once (fail-scoped preference)", async () => {
    const outcome = await permissionOutcomeFor("auto");
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
  }, 10_000);

  test("yolo mode answers allow_once", async () => {
    const outcome = await permissionOutcomeFor("yolo");
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
  }, 10_000);

  test("ask mode answers reject_once", async () => {
    const outcome = await permissionOutcomeFor("ask");
    expect(outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
  }, 10_000);

  test("unknown/future mode id fails closed to reject_once", async () => {
    // "weird-unknown" isn't a real FxMode, but the driver's policy switch
    // takes the reject arm for anything that isn't "yolo"/"auto" — cast past
    // the type to exercise that fail-closed default the same way an
    // unreleased mode id passed through verbatim from buildCommand would.
    const outcome = await permissionOutcomeFor("weird-unknown" as FxMode);
    expect(outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
  }, 10_000);
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

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

// db.ts captures AGETOR_DATA_DIR at first import; copilot-tmux imports dataDir
// from it. This dir holds the db singleton's open sqlite file for the whole
// run, so it is deliberately left for the OS to reap (`rmTestDataDir` refuses
// a dir that holds a live agetor.sqlite).
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-copilot-tmux-"));

const mod = await import("./copilot-tmux.ts");
const {
  COPILOT_LOGIN_STATUS_TEXT,
  COPILOT_PLAN_TOOL_NAME,
  buildCopilotShellCommand,
  copilotExitPath,
  copilotLogPath,
  copilotPlanChunk,
  copilotPromptPath,
  copilotSessionActive,
  copilotUsagePath,
  createCopilotMapCtx,
  dropCopilotSession,
  finalizeCopilotTurn,
  mapCopilotEvent,
  parseCopilotUsageFile,
  readCopilotPlanFile,
  reattachCopilotSession,
  spawnCopilotViaTmux,
} = mod;
const { copilotHome } = await import("./copilot-home.ts");
const { resolveTmuxBin, tmuxSocketArgs } = await import("./tmux-resolution.ts");
const { sessionNameFor, sessionExistsByName } = await import("./claude-tmux.ts");
const { FX_USAGE_STATUS_PREFIX, SESSION_DIED_STATUS_PREFIX } = await import("../shared/types.ts");
const fake = await import("./copilot-fake.ts");

import type { RunEventStream } from "../shared/types.ts";
import type { CopilotSubagentSink, CopilotMapCtx } from "./copilot-tmux.ts";

const scratch = mkdtempSync(path.join(tmpdir(), "agetor-copilot-scratch-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

type Chunk = { stream: RunEventStream; data: string; lineUuid?: string };
function collect() {
  const chunks: Chunk[] = [];
  const onChunk = (stream: RunEventStream, data: string, lineUuid?: string) =>
    chunks.push({ stream, data, lineUuid });
  return { chunks, onChunk };
}

type SinkCall =
  | { kind: "started"; info: Parameters<CopilotSubagentSink["started"]>[0] }
  | { kind: "event"; parent: string; stream: RunEventStream; data: string; lineUuid: string }
  | { kind: "settled"; toolCallId: string; status: string }
  | { kind: "settleAll"; status: string };
function recordingSink() {
  const calls: SinkCall[] = [];
  const sink: CopilotSubagentSink = {
    started: (info) => calls.push({ kind: "started", info }),
    event: (parent, stream, data, lineUuid) => calls.push({ kind: "event", parent, stream, data, lineUuid }),
    settled: (toolCallId, status) => calls.push({ kind: "settled", toolCallId, status }),
    settleAll: (status) => calls.push({ kind: "settleAll", status }),
  };
  return { sink, calls };
}

function ctxFor(init: Partial<Parameters<typeof createCopilotMapCtx>[0]> = {}): CopilotMapCtx {
  return createCopilotMapCtx({
    runId: "run-1",
    model: "claude-sonnet-5.5",
    mode: "auto",
    turnStartedAt: 0,
    ...init,
  });
}

let evSeq = 0;
function ev(type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  evSeq += 1;
  return JSON.stringify({ type, data, id: `evt-${evSeq}`, timestamp: 1, parentId: null, ...extra });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * mapCopilotEvent
 * ────────────────────────────────────────────────────────────────────────── */

describe("mapCopilotEvent", () => {
  test("assistant.message with content emits assistant under copilot:<id>", () => {
    const res = mapCopilotEvent(
      JSON.stringify({ type: "assistant.message", id: "abc", data: { messageId: "m", content: "Hello" } }),
      0,
      ctxFor(),
    );
    expect(res.chunks).toEqual([{ stream: "assistant", data: "Hello", lineUuid: "copilot:abc" }]);
    expect(res.done).toBeUndefined();
  });

  test("assistant.message with empty content and tool requests emits nothing", () => {
    const res = mapCopilotEvent(
      ev("assistant.message", { messageId: "m", content: "", toolRequests: [{ toolCallId: "c1" }] }),
      0,
      ctxFor(),
    );
    expect(res.chunks).toEqual([]);
  });

  test("assistant.reasoning emits thinking; reasoningText fallback only when no reasoning event preceded", () => {
    const ctx = ctxFor();
    const r = mapCopilotEvent(ev("assistant.reasoning", { reasoningId: "r1", content: "thinking hard" }), 0, ctx);
    expect(r.chunks.map((c) => [c.stream, c.data])).toEqual([["thinking", "thinking hard"]]);

    // Message right after a reasoning event: reasoningText must NOT duplicate it.
    const m1 = mapCopilotEvent(
      ev("assistant.message", { messageId: "m1", content: "A", reasoningText: "thinking hard" }),
      1,
      ctx,
    );
    expect(m1.chunks.map((c) => c.stream)).toEqual(["assistant"]);

    // Next message has no reasoning event before it: the fallback fires first.
    const m2 = mapCopilotEvent(
      ev("assistant.message", { messageId: "m2", content: "B", reasoningText: "late thought" }),
      2,
      ctx,
    );
    expect(m2.chunks.map((c) => [c.stream, c.data])).toEqual([
      ["thinking", "late thought"],
      ["assistant", "B"],
    ]);
    expect(m2.chunks[0]!.lineUuid).toMatch(/:thinking$/);
  });

  test("tool.execution_start maps to tool_use, MCP tools are named '<server> · <tool>'", () => {
    const plain = mapCopilotEvent(
      JSON.stringify({
        type: "tool.execution_start",
        id: "t1",
        data: { toolCallId: "call_1", toolName: "bash", arguments: { command: "ls" } },
      }),
      0,
      ctxFor(),
    );
    expect(plain.chunks).toHaveLength(1);
    expect(plain.chunks[0]!.stream).toBe("tool_use");
    expect(plain.chunks[0]!.lineUuid).toBe("copilot:t1");
    expect(JSON.parse(plain.chunks[0]!.data)).toMatchObject({
      id: "call_1",
      name: "bash",
      input: { command: "ls" },
    });

    const mcp = mapCopilotEvent(
      ev("tool.execution_start", {
        toolCallId: "call_2",
        toolName: "github-mcp-server-search",
        mcpServerName: "github",
        mcpToolName: "search_issues",
        arguments: { q: "bug" },
      }),
      1,
      ctxFor(),
    );
    expect(JSON.parse(mcp.chunks[0]!.data).name).toBe("github · search_issues");
  });

  test("tool.execution_complete maps success, failure and error.message", () => {
    const ok = mapCopilotEvent(
      ev("tool.execution_complete", { toolCallId: "call_1", success: true, result: { content: "out" } }),
      0,
      ctxFor(),
    );
    expect(ok.chunks[0]!.stream).toBe("tool_result");
    expect(JSON.parse(ok.chunks[0]!.data)).toEqual({ toolUseId: "call_1", content: "out", isError: false });

    const denied = mapCopilotEvent(
      ev("tool.execution_complete", {
        toolCallId: "call_2",
        success: false,
        error: { message: "Permission denied because no interactive user response was available" },
      }),
      1,
      ctxFor(),
    );
    expect(JSON.parse(denied.chunks[0]!.data)).toEqual({
      toolUseId: "call_2",
      content: "Permission denied because no interactive user response was available",
      isError: true,
    });
  });

  test("events with parentToolCallId route to the sink, never the main stream", () => {
    const { sink, calls } = recordingSink();
    const ctx = ctxFor({ sink });
    const lines = [
      ev("tool.execution_start", { toolCallId: "n1", toolName: "grep", arguments: {}, parentToolCallId: "sub1" }),
      ev("tool.execution_complete", { toolCallId: "n1", success: true, result: { content: "x" }, parentToolCallId: "sub1" }),
      ev("assistant.message", { messageId: "nm", content: "nested", parentToolCallId: "sub1" }),
    ];
    for (const [i, l] of lines.entries()) {
      expect(mapCopilotEvent(l, i, ctx).chunks).toEqual([]);
    }
    expect(calls.map((c) => (c.kind === "event" ? [c.parent, c.stream] : [c.kind]))).toEqual([
      ["sub1", "tool_use"],
      ["sub1", "tool_result"],
      ["sub1", "assistant"],
    ]);
    const first = calls[0] as Extract<SinkCall, { kind: "event" }>;
    expect(first.lineUuid).toMatch(/^copilot:evt-/);
  });

  test("subagent events with no sink are dropped, not leaked to the main stream", () => {
    const res = mapCopilotEvent(
      ev("assistant.message", { messageId: "nm", content: "nested", parentToolCallId: "sub1" }),
      0,
      ctxFor(),
    );
    expect(res.chunks).toEqual([]);
  });

  test("subagent.started / completed / failed / cancelled drive the sink", () => {
    const { sink, calls } = recordingSink();
    const ctx = ctxFor({ sink });
    mapCopilotEvent(
      ev("subagent.started", {
        toolCallId: "s1",
        agentName: "explore",
        agentDisplayName: "Explore",
        agentDescription: "Scan the repo",
        agentType: "explore",
      }),
      0,
      ctx,
    );
    mapCopilotEvent(ev("subagent.completed", { toolCallId: "s1", agentName: "explore", agentDisplayName: "Explore" }), 1, ctx);
    mapCopilotEvent(ev("subagent.failed", { toolCallId: "s2", agentName: "x", agentDisplayName: "X", error: "boom" }), 2, ctx);
    mapCopilotEvent(
      ev("subagent.completed", { toolCallId: "s3", agentName: "y", agentDisplayName: "Y", cancelled: true }),
      3,
      ctx,
    );
    expect(calls).toEqual([
      {
        kind: "started",
        info: { toolCallId: "s1", name: "Explore", description: "Scan the repo", agentType: "explore" },
      },
      { kind: "settled", toolCallId: "s1", status: "completed" },
      { kind: "settled", toolCallId: "s2", status: "failed" },
      { kind: "settled", toolCallId: "s3", status: "failed" },
    ]);
  });

  test("session.error / session.warning / compaction become status lines", () => {
    const ctx = ctxFor();
    const err = mapCopilotEvent(
      ev("session.error", { errorType: "query", message: "Model unavailable", remediation: "Try again later", statusCode: 500 }),
      0,
      ctx,
    );
    expect(err.chunks).toHaveLength(1);
    expect(err.chunks[0]!.stream).toBe("status");
    expect(err.chunks[0]!.data).toBe("⚠ GitHub Copilot: Model unavailable — Try again later");

    const warn = mapCopilotEvent(ev("session.warning", { warningType: "effort", message: "Effort high unsupported" }), 1, ctx);
    expect(warn.chunks.map((c) => [c.stream, c.data])).toEqual([["status", "⚠ Effort high unsupported"]]);

    expect(mapCopilotEvent(ev("session.compaction_start", {}), 2, ctx).chunks[0]!.data).toBe("context compacting…");
    expect(mapCopilotEvent(ev("session.compaction_complete", {}), 3, ctx).chunks[0]!.data).toBe("context compacted");
  });

  test("retry notices dedupe per distinct message; unrelated session.info is ignored", () => {
    const ctx = ctxFor();
    const retry1 = mapCopilotEvent(
      ev("assistant.turn_retry", { message: "Retrying (attempt 1)" }, { ephemeral: true }),
      0,
      ctx,
    );
    expect(retry1.chunks).toHaveLength(1);
    expect(retry1.chunks[0]!.data).toContain("Retrying (attempt 1)");
    const retry1Again = mapCopilotEvent(
      ev("assistant.turn_retry", { message: "Retrying (attempt 1)" }, { ephemeral: true }),
      1,
      ctx,
    );
    expect(retry1Again.chunks).toEqual([]);
    const retry2 = mapCopilotEvent(
      ev("session.info", { message: "Retrying… (attempt 2)" }, { ephemeral: true }),
      2,
      ctx,
    );
    expect(retry2.chunks).toHaveLength(1);

    expect(mapCopilotEvent(ev("session.info", { message: "Connected to workspace" }, { ephemeral: true }), 3, ctx).chunks).toEqual([]);
    const effort = mapCopilotEvent(
      ev("session.info", { message: "Reasoning effort high is not supported by this model" }, { ephemeral: true }),
      4,
      ctx,
    );
    expect(effort.chunks).toHaveLength(1);
    expect(effort.chunks[0]!.stream).toBe("status");
  });

  test("exit_plan_mode.requested (ephemeral) stashes planContent without emitting", () => {
    const ctx = ctxFor({ mode: "plan" });
    const res = mapCopilotEvent(
      ev("exit_plan_mode.requested", { requestId: "r", summary: "s", planContent: "# Plan\n1. do it", actions: [], recommendedAction: "x" }, { ephemeral: true }),
      0,
      ctx,
    );
    expect(res.chunks).toEqual([]);
    expect(ctx.planContent).toBe("# Plan\n1. do it");
  });

  test("result maps to done with the exit code and session id", () => {
    const ok = mapCopilotEvent(ev("result", { sessionId: "sess-1", exitCode: 0, usage: {} }), 0, ctxFor());
    expect(ok.done).toBe(0);
    expect(ok.sessionId).toBe("sess-1");
    expect(mapCopilotEvent(ev("result", { sessionId: "s", exitCode: 1 }), 0, ctxFor()).done).toBe(1);
    // A result with no exitCode field reads as success.
    expect(mapCopilotEvent(ev("result", { sessionId: "s" }), 0, ctxFor()).done).toBe(0);
  });

  test("the real 1.0.104 result shape (top-level exitCode, no data/id) is honoured", () => {
    // Captured from a provider-500 run: session.error, then this line, rc 1.
    const line = JSON.stringify({
      type: "result",
      timestamp: "2026-10-27T03:28:27.852Z",
      sessionId: "af36f550-3d71-4b4a-81bb-738bbb14ee2a",
      exitCode: 1,
      usage: { premiumRequests: 0, totalApiDurationMs: 0, sessionDurationMs: 16510 },
    });
    const res = mapCopilotEvent(line, 37, ctxFor());
    expect(res.done).toBe(1);
    expect(res.sessionId).toBe("af36f550-3d71-4b4a-81bb-738bbb14ee2a");
  });

  test("a turn_retry with only a machine reason reads as a retry notice", () => {
    const res = mapCopilotEvent(
      ev("assistant.turn_retry", { turnId: "0", model: "gpt-5.4", reason: "api_error" }, { ephemeral: true }),
      0,
      ctxFor(),
    );
    expect(res.chunks.map((c) => [c.stream, c.data])).toEqual([
      ["status", "↻ GitHub Copilot: retrying request (api_error)…"],
    ]);
  });

  test("an abort makes the later result non-zero (Copilot exits 0 after SIGINT)", () => {
    const ctx = ctxFor();
    const abort = mapCopilotEvent(ev("abort", { reason: "user_initiated" }), 0, ctx);
    expect(abort.chunks.map((c) => [c.stream, c.data])).toEqual([["status", "turn aborted"]]);
    expect(ctx.aborted).toBe(true);
    expect(mapCopilotEvent(ev("assistant.idle", { aborted: true }), 1, ctx).chunks).toEqual([]);
    expect(mapCopilotEvent(ev("result", { sessionId: "s", exitCode: 0 }), 2, ctx).done).toBe(1);
  });

  test("user.message, ephemeral deltas, unknown types and blank lines are ignored", () => {
    const ctx = ctxFor();
    for (const line of [
      ev("user.message", { content: "hi" }),
      ev("assistant.message_delta", { deltaContent: "x" }, { ephemeral: true }),
      ev("assistant.message", { messageId: "m", content: "should be skipped" }, { ephemeral: true }),
      ev("tool.shell_output", { chunk: "x" }, { ephemeral: true }),
      ev("some.future.event", { a: 1 }),
      "",
      "   ",
    ]) {
      expect(mapCopilotEvent(line, 0, ctx)).toEqual({ chunks: [] });
    }
  });

  test("non-JSON lines become stderr; the login status fires once per run", () => {
    const ctx = ctxFor();
    const a = mapCopilotEvent("Error: No authentication information found.", 0, ctx);
    expect(a.chunks).toEqual([
      { stream: "stderr", data: "Error: No authentication information found.", lineUuid: "copilot:raw:0" },
      { stream: "status", data: COPILOT_LOGIN_STATUS_TEXT, lineUuid: "copilot:login:run-1" },
    ]);
    const b = mapCopilotEvent("Error: No authentication information found. (again)", 1, ctx);
    expect(b.chunks.map((c) => c.stream)).toEqual(["stderr"]);
    const other = mapCopilotEvent("some other banner", 2, ctxFor());
    expect(other.chunks.map((c) => c.stream)).toEqual(["stderr"]);
    // Valid JSON that isn't an event envelope is treated as plain text too.
    expect(mapCopilotEvent("42", 3, ctxFor()).chunks[0]!.stream).toBe("stderr");
  });

  test("'auto picked' status fires once, on the first main-stream message with a model", () => {
    const ctx = ctxFor({ model: "auto" });
    const first = mapCopilotEvent(
      JSON.stringify({ type: "assistant.message", id: "e1", data: { messageId: "m", content: "Hi", model: "gpt-6.1-sol" } }),
      0,
      ctx,
    );
    expect(first.chunks.map((c) => [c.stream, c.data])).toEqual([
      ["status", "GitHub Copilot auto picked gpt-6.1-sol"],
      ["assistant", "Hi"],
    ]);
    const second = mapCopilotEvent(
      ev("assistant.message", { messageId: "m2", content: "Again", model: "gpt-6.1-sol" }),
      1,
      ctx,
    );
    expect(second.chunks.map((c) => c.stream)).toEqual(["assistant"]);

    const explicit = ctxFor({ model: "claude-sonnet-5.5" });
    const res = mapCopilotEvent(ev("assistant.message", { messageId: "m", content: "Hi", model: "claude-sonnet-5.5" }), 0, explicit);
    expect(res.chunks.map((c) => c.stream)).toEqual(["assistant"]);

    // A subagent's message never claims the "auto picked" line.
    const { sink } = recordingSink();
    const subCtx = ctxFor({ model: "auto", sink });
    mapCopilotEvent(
      ev("assistant.message", { messageId: "m", content: "n", model: "x", parentToolCallId: "s" }),
      0,
      subCtx,
    );
    expect(subCtx.autoReported).toBe(false);
  });

  test("line uuids are stable across re-mapping and fall back to the line index without an id", () => {
    const line = JSON.stringify({ type: "assistant.message", id: "stable-id", data: { messageId: "m", content: "x" } });
    const a = mapCopilotEvent(line, 3, ctxFor());
    const b = mapCopilotEvent(line, 3, ctxFor());
    expect(a.chunks[0]!.lineUuid).toBe("copilot:stable-id");
    expect(b.chunks[0]!.lineUuid).toBe(a.chunks[0]!.lineUuid);
    const noId = mapCopilotEvent(JSON.stringify({ type: "assistant.message", data: { messageId: "m", content: "x" } }), 7, ctxFor());
    expect(noId.chunks[0]!.lineUuid).toBe("copilot:line:7");
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Usage + plan helpers
 * ────────────────────────────────────────────────────────────────────────── */

describe("parseCopilotUsageFile", () => {
  test("sums token metrics across models and converts nano-AIU to credits", () => {
    const text = JSON.stringify({
      modelMetrics: {
        "claude-sonnet-5.5": {
          usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 5, reasoningTokens: 3 },
        },
        "gpt-6-luna": { usage: { inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      },
      totalNanoAiu: 3_000_000_000,
      aiCreditsStatus: "available",
    });
    expect(parseCopilotUsageFile(text)).toEqual({
      turn: { inputTokens: 120, outputTokens: 12, cacheReadTokens: 50, cacheWriteTokens: 5, reasoningTokens: 3 },
      aiCredits: 3,
    });
  });

  test("omits aiCredits when unavailable or zero, keeps tokens", () => {
    const base = { modelMetrics: { m: { usage: { inputTokens: 1, outputTokens: 2 } } } };
    for (const extra of [
      { totalNanoAiu: 5e9, aiCreditsStatus: "unavailable" },
      { totalNanoAiu: 0, aiCreditsStatus: "available" },
      {},
    ]) {
      const res = parseCopilotUsageFile(JSON.stringify({ ...base, ...extra }));
      expect(res).toEqual({ turn: { inputTokens: 1, outputTokens: 2 } });
    }
  });

  test("falls back to the per-model nano-AIU sum and returns credits-only payloads", () => {
    const res = parseCopilotUsageFile(
      JSON.stringify({ modelMetrics: { a: { totalNanoAiu: 1e9 }, b: { totalNanoAiu: 2e9 } } }),
    );
    expect(res).toEqual({ aiCredits: 3 });
  });

  test("returns null for junk and for payloads with nothing usable", () => {
    expect(parseCopilotUsageFile("not json")).toBeNull();
    expect(parseCopilotUsageFile("[]")).toBeNull();
    expect(parseCopilotUsageFile("{}")).toBeNull();
    expect(parseCopilotUsageFile(JSON.stringify({ modelMetrics: { m: { usage: { inputTokens: "x" } } } }))).toBeNull();
  });
});

describe("readCopilotPlanFile", () => {
  function planDir(sessionId: string, content: string): { home: string; file: string } {
    const home = mkdtempSync(path.join(scratch, "home-"));
    const dir = path.join(home, "session-state", sessionId);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "plan.md");
    writeFileSync(file, content);
    return { home, file };
  }

  test("returns the content when mtime is at/after sinceMs, else null", () => {
    const { home, file } = planDir("sess-a", "# The plan\n");
    const mtime = statSync(file).mtimeMs;
    expect(readCopilotPlanFile(home, "sess-a", mtime)).toBe("# The plan\n");
    expect(readCopilotPlanFile(home, "sess-a", mtime - 5_000)).toBe("# The plan\n");
    expect(readCopilotPlanFile(home, "sess-a", mtime + 5_000)).toBeNull();
    // A stale plan from an earlier turn is ignored.
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(file, old, old);
    expect(readCopilotPlanFile(home, "sess-a", Date.now() - 60_000)).toBeNull();
  });

  test("null for a missing file, blank content, or an unsafe session id", () => {
    const { home } = planDir("sess-b", "   \n");
    expect(readCopilotPlanFile(home, "sess-b", 0)).toBeNull();
    expect(readCopilotPlanFile(home, "nope", 0)).toBeNull();
    expect(readCopilotPlanFile(home, "../sess-b", 0)).toBeNull();
    expect(readCopilotPlanFile(home, "a/b", 0)).toBeNull();
    expect(readCopilotPlanFile(home, "", 0)).toBeNull();
  });
});

test("copilotPlanChunk is a copilot_plan tool_use with a stable id and line uuid", () => {
  const chunk = copilotPlanChunk("run-9", "# Plan");
  expect(chunk.stream).toBe("tool_use");
  expect(chunk.lineUuid).toBe("copilot:plan:run-9");
  expect(JSON.parse(chunk.data)).toMatchObject({
    id: "copilot-plan:run-9",
    name: COPILOT_PLAN_TOOL_NAME,
    input: { plan: "# Plan" },
  });
  expect(COPILOT_PLAN_TOOL_NAME).toBe("copilot_plan");
});

describe("finalizeCopilotTurn", () => {
  const usageText = JSON.stringify({ modelMetrics: { m: { usage: { inputTokens: 5, outputTokens: 1 } } } });

  function run(over: Partial<Parameters<typeof finalizeCopilotTurn>[0]> = {}) {
    const { chunks, onChunk } = collect();
    const { sink, calls } = recordingSink();
    const ctx = ctxFor({ mode: over.mode ?? "auto" });
    finalizeCopilotTurn({
      runId: "run-1",
      code: 0,
      mode: "auto",
      sessionId: "sess",
      copilotHome: scratch,
      turnStartedAt: 0,
      ctx,
      usageText,
      emit: onChunk,
      sink,
      ...over,
    });
    return { chunks, calls, ctx };
  }

  test("emits the usage sentinel, then the plan chunk, then settles subagents", () => {
    const ctx = ctxFor({ mode: "plan" });
    ctx.planContent = "# Stashed plan";
    const { chunks, calls } = run({ mode: "plan", ctx });
    expect(chunks.map((c) => c.stream)).toEqual(["status", "tool_use"]);
    expect(chunks[0]!.data.startsWith(FX_USAGE_STATUS_PREFIX)).toBe(true);
    expect(JSON.parse(chunks[0]!.data.slice(FX_USAGE_STATUS_PREFIX.length))).toEqual({
      turn: { inputTokens: 5, outputTokens: 1 },
    });
    expect(chunks[0]!.lineUuid).toBe("copilot:usage:run-1");
    expect(JSON.parse(chunks[1]!.data).input.plan).toBe("# Stashed plan");
    expect(calls).toEqual([{ kind: "settleAll", status: "completed" }]);
  });

  test("falls back to plan.md written this turn; no plan chunk outside Plan mode or on failure", () => {
    const home = mkdtempSync(path.join(scratch, "fhome-"));
    mkdirSync(path.join(home, "session-state", "sess"), { recursive: true });
    writeFileSync(path.join(home, "session-state", "sess", "plan.md"), "# From file");
    const planned = run({ mode: "plan", ctx: ctxFor({ mode: "plan" }), copilotHome: home });
    expect(planned.chunks.filter((c) => c.stream === "tool_use")).toHaveLength(1);

    const auto = run({ mode: "auto", copilotHome: home });
    expect(auto.chunks.filter((c) => c.stream === "tool_use")).toHaveLength(0);

    const failed = run({ mode: "plan", ctx: ctxFor({ mode: "plan" }), copilotHome: home, code: 1 });
    expect(failed.chunks.filter((c) => c.stream === "tool_use")).toHaveLength(0);
    expect(failed.calls).toEqual([{ kind: "settleAll", status: "orphaned" }]);
  });

  test("a throwing emitter never blocks subagent settlement", () => {
    const { sink, calls } = recordingSink();
    finalizeCopilotTurn({
      runId: "run-1",
      code: 0,
      mode: "auto",
      sessionId: "sess",
      copilotHome: scratch,
      turnStartedAt: 0,
      ctx: ctxFor(),
      usageText,
      emit: () => {
        throw new Error("boom");
      },
      sink,
    });
    expect(calls).toEqual([{ kind: "settleAll", status: "completed" }]);
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * buildCopilotShellCommand
 * ────────────────────────────────────────────────────────────────────────── */

describe("buildCopilotShellCommand", () => {
  const base = {
    argv: ["copilot", "--output-format", "json"],
    promptPath: "/d/run.prompt.txt",
    logPath: "/d/run.jsonl",
    exitPath: "/d/run.exit",
    stripClassicTokens: ["GH_TOKEN", "GITHUB_TOKEN"],
    unsetAllowAll: false,
  };

  test("shape: sh -c <script> sh <argv…>, prompt on stdin, exit code captured", () => {
    const cmd = buildCopilotShellCommand(base);
    expect(cmd.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(cmd[3]).toBe("sh");
    expect(cmd.slice(4)).toEqual(base.argv);
    const script = cmd[2]!;
    expect(script).toContain(`case "\${GH_TOKEN-}" in ghp_*) unset GH_TOKEN;; esac;`);
    expect(script).toContain(`case "\${GITHUB_TOKEN-}" in ghp_*) unset GITHUB_TOKEN;; esac;`);
    expect(script).toContain(`"$@" < '/d/run.prompt.txt' > '/d/run.jsonl' 2>&1; echo $? > '/d/run.exit'`);
    expect(script).not.toContain("COPILOT_ALLOW_ALL");
  });

  test("unsetAllowAll adds the unset guard; an empty strip list adds no token guards", () => {
    const script = buildCopilotShellCommand({ ...base, stripClassicTokens: [], unsetAllowAll: true })[2]!;
    expect(script.startsWith("unset COPILOT_ALLOW_ALL; ")).toBe(true);
    expect(script).not.toContain("ghp_");
  });

  test("quotes paths with single quotes; argv elements are never interpolated", () => {
    const cmd = buildCopilotShellCommand({
      ...base,
      argv: ["copilot", "--model", "x; rm -rf /"],
      promptPath: "/d/it's.txt",
    });
    expect(cmd[2]).toContain(`< '/d/it'\\''s.txt'`);
    expect(cmd[2]).not.toContain("rm -rf");
    expect(cmd[cmd.length - 1]).toBe("x; rm -rf /");
  });

  test("rejects a guard variable name that is not a POSIX identifier; empty argv throws", () => {
    expect(() => buildCopilotShellCommand({ ...base, stripClassicTokens: ["GH_TOKEN; rm -rf /"] })).toThrow();
    expect(() => buildCopilotShellCommand({ ...base, argv: [] })).toThrow();
  });

  /** Run the wrapper under a plain `sh` with a stub that dumps selected env vars. */
  async function runWrapped(
    env: Record<string, string>,
    over: Partial<typeof base>,
  ): Promise<{ out: string; exit: string }> {
    const dir = mkdtempSync(path.join(scratch, "wrap-"));
    const stub = path.join(dir, "stub.sh");
    writeFileSync(
      stub,
      `#!/bin/sh\ncat >/dev/null\nprintf 'GH=%s|GITHUB=%s|ALLOW=%s\\n' "\${GH_TOKEN-unset}" "\${GITHUB_TOKEN-unset}" "\${COPILOT_ALLOW_ALL-unset}"\nexit 3\n`,
    );
    chmodSync(stub, 0o755);
    const promptPath = path.join(dir, "p.txt");
    writeFileSync(promptPath, "hello");
    const logPath = path.join(dir, "l.txt");
    const exitPath = path.join(dir, "e.txt");
    const cmd = buildCopilotShellCommand({
      ...base,
      ...over,
      argv: [stub],
      promptPath,
      logPath,
      exitPath,
    });
    const proc = Bun.spawn(cmd, { env: { PATH: process.env.PATH ?? "", ...env }, stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    return {
      out: (await Bun.file(logPath).text()).trim(),
      exit: (await Bun.file(exitPath).text()).trim(),
    };
  }

  test("pane behaviour: classic ghp_ tokens are dropped, other tokens kept, exit code recorded", async () => {
    const dropped = await runWrapped({ GH_TOKEN: "ghp_classic", GITHUB_TOKEN: "gho_oauth" }, {});
    expect(dropped.out).toBe("GH=unset|GITHUB=gho_oauth|ALLOW=unset");
    expect(dropped.exit).toBe("3");
    const keptFineGrained = await runWrapped({ GH_TOKEN: "github_pat_abc" }, {});
    expect(keptFineGrained.out).toBe("GH=github_pat_abc|GITHUB=unset|ALLOW=unset");
    // A variable the harness env sets is excluded from stripClassicTokens by the caller.
    const harnessSet = await runWrapped({ GH_TOKEN: "ghp_classic" }, { stripClassicTokens: ["GITHUB_TOKEN"] });
    expect(harnessSet.out).toBe("GH=ghp_classic|GITHUB=unset|ALLOW=unset");
  });

  test("pane behaviour: COPILOT_ALLOW_ALL is unset only when asked", async () => {
    const restricted = await runWrapped({ COPILOT_ALLOW_ALL: "true" }, { unsetAllowAll: true });
    expect(restricted.out).toBe("GH=unset|GITHUB=unset|ALLOW=unset");
    const auto = await runWrapped({ COPILOT_ALLOW_ALL: "true" }, { unsetAllowAll: false });
    expect(auto.out).toBe("GH=unset|GITHUB=unset|ALLOW=true");
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * copilotHome
 * ────────────────────────────────────────────────────────────────────────── */

describe("copilotHome", () => {
  const home = process.env.HOME ?? "";
  test("precedence: harness env > harness.home > process env > ~/.copilot", () => {
    expect(
      copilotHome({ harnessEnv: { COPILOT_HOME: "/env" }, harnessHome: "/home", processEnv: { COPILOT_HOME: "/proc" } }),
    ).toBe("/env");
    expect(copilotHome({ harnessHome: "/home", processEnv: { COPILOT_HOME: "/proc" } })).toBe("/home");
    expect(copilotHome({ processEnv: { COPILOT_HOME: "/proc" } })).toBe("/proc");
    expect(copilotHome({ processEnv: {} }).endsWith(path.join(".copilot"))).toBe(true);
  });

  test("blank values are skipped and a leading ~ is expanded", () => {
    expect(copilotHome({ harnessEnv: { COPILOT_HOME: "  " }, harnessHome: "", processEnv: { COPILOT_HOME: "/proc" } })).toBe("/proc");
    expect(copilotHome({ harnessHome: "~/alt", processEnv: {} })).toBe(path.join(home, "alt"));
    expect(copilotHome({ harnessEnv: null, harnessHome: null, processEnv: {} })).toBe(path.join(home, ".copilot"));
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Paths
 * ────────────────────────────────────────────────────────────────────────── */

test("per-run paths live under <dataDir>/copilot-logs", async () => {
  // Under a full `bun test` run db.ts's dataDir may come from whichever test
  // file imported it first, not this file's AGETOR_DATA_DIR.
  const { dataDir } = await import("./db.ts");
  const dir = path.join(dataDir, "copilot-logs");
  expect(copilotLogPath("r1")).toBe(path.join(dir, "r1.jsonl"));
  expect(copilotPromptPath("r1")).toBe(path.join(dir, "r1.prompt.txt"));
  expect(copilotExitPath("r1")).toBe(path.join(dir, "r1.exit"));
  expect(copilotUsagePath("r1")).toBe(path.join(dir, "r1.usage.json"));
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Lifecycle (spawn / settle / kill / death / reattach) through real tmux on
 * the isolated `agetor-test` socket (NODE_ENV=test), hosting a stub `copilot`.
 * ────────────────────────────────────────────────────────────────────────── */

const realTmux = Bun.which("tmux");
const hasTmux = realTmux !== null;
const lifecycle = hasTmux ? describe : describe.skip;

interface StubSpec {
  /** Static JSON lines (or plain text) printed in order. `{{PROMPT}}` is replaced by stdin. */
  lines: string[];
  /** Seconds to sleep before the first line. */
  sleepBefore?: number;
  /** Seconds to sleep after the lines (before exiting). */
  sleepAfter?: number;
  /** Sleep after this many lines have printed (reattach test). */
  sleepAfterFirstLine?: number;
  exitCode?: number;
  /** Write this JSON text to $STUB_USAGE before printing the last line. */
  usageJson?: string;
}

function makeStub(spec: StubSpec): string {
  const dir = mkdtempSync(path.join(scratch, "stub-"));
  const file = path.join(dir, "copilot");
  const body: string[] = ["#!/bin/sh", 'prompt=$(cat)'];
  if (spec.sleepBefore) body.push(`sleep ${spec.sleepBefore}`);
  spec.lines.forEach((line, i) => {
    const escaped = line.replace(/'/g, `'\\''`).replace(/\{\{PROMPT\}\}/g, `'"$prompt"'`);
    if (spec.usageJson && i === spec.lines.length - 1) {
      body.push(`printf '%s' '${spec.usageJson.replace(/'/g, `'\\''`)}' > "$STUB_USAGE"`);
    }
    body.push(`printf '%s\\n' '${escaped}'`);
    if (i === 0 && spec.sleepAfterFirstLine) body.push(`sleep ${spec.sleepAfterFirstLine}`);
  });
  if (spec.sleepAfter) body.push(`sleep ${spec.sleepAfter}`);
  body.push(`exit ${spec.exitCode ?? 0}`);
  writeFileSync(file, body.join("\n") + "\n");
  chmodSync(file, 0o755);
  return file;
}

function j(type: string, id: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, id, data, timestamp: 1, parentId: null, ...extra });
}

function newIds() {
  const suffix = randomUUID().slice(0, 8);
  return { taskId: `tcp${suffix}00`, runId: `run-cp-${suffix}`, sessionId: randomUUID() };
}

function launchOpts(
  ids: ReturnType<typeof newIds>,
  stub: string,
  onChunk: (s: RunEventStream, d: string, u?: string) => void,
  over: Partial<Parameters<typeof spawnCopilotViaTmux>[0]> = {},
): Parameters<typeof spawnCopilotViaTmux>[0] {
  const home = mkdtempSync(path.join(scratch, "chome-"));
  return {
    taskId: ids.taskId,
    runId: ids.runId,
    argv: [stub, "--output-format", "json"],
    env: { STUB_USAGE: copilotUsagePath(ids.runId), COPILOT_HOME: home },
    cwd: scratch,
    promptText: "hello-prompt",
    onChunk,
    sessionId: ids.sessionId,
    copilotHome: home,
    mode: "auto",
    model: "auto",
    stripClassicTokens: [],
    ...over,
  };
}

lifecycle("spawnCopilotViaTmux lifecycle", () => {
  const T = 30_000;

  // Other test files in the same `bun test` process point AGETOR_TMUX_BIN at
  // /bin/echo (session-reaper, orchestrator); these tests need the real tmux.
  let prevTmuxBin: string | undefined;
  beforeAll(() => {
    prevTmuxBin = process.env.AGETOR_TMUX_BIN;
    process.env.AGETOR_TMUX_BIN = realTmux!;
  });
  afterAll(() => {
    if (prevTmuxBin === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = prevTmuxBin;
  });

  test("success: stdin prompt, mapped chunks, subagent routing, usage sentinel, settleAll(completed)", async () => {
    const ids = newIds();
    const usage = JSON.stringify({
      modelMetrics: { "claude-sonnet-5.5": { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 } } },
      totalNanoAiu: 4e9,
      aiCreditsStatus: "available",
    });
    const stub = makeStub({
      lines: [
        j("assistant.message", "e1", { messageId: "m1", content: "stdin={{PROMPT}}", model: "claude-sonnet-5.5" }),
        j("subagent.started", "e2", { toolCallId: "sub", agentName: "explore", agentDisplayName: "Explore", agentDescription: "d" }),
        j("tool.execution_start", "e3", { toolCallId: "n1", toolName: "grep", arguments: {}, parentToolCallId: "sub" }),
        j("subagent.completed", "e4", { toolCallId: "sub", agentName: "explore", agentDisplayName: "Explore" }),
        j("result", "e5", { sessionId: ids.sessionId, exitCode: 0 }),
      ],
      usageJson: usage,
    });
    const { chunks, onChunk } = collect();
    const { sink, calls } = recordingSink();
    const sessionIds: string[] = [];
    const agent = await spawnCopilotViaTmux(
      launchOpts(ids, stub, onChunk, { onSubagent: sink, onSessionId: (id) => sessionIds.push(id) }),
    );
    expect(copilotSessionActive(ids.taskId)).toBe(true);
    const code = await agent.done;
    expect(code).toBe(0);
    expect(copilotSessionActive(ids.taskId)).toBe(false);
    expect(sessionIds).toEqual([ids.sessionId]);

    const streams = chunks.map((c) => c.stream);
    expect(chunks.find((c) => c.stream === "assistant")?.data).toBe("stdin=hello-prompt");
    expect(chunks.find((c) => c.data === "GitHub Copilot auto picked claude-sonnet-5.5")).toBeDefined();
    // Subagent traffic never reaches the main stream.
    expect(streams.filter((s) => s === "tool_use")).toHaveLength(0);
    expect(calls.map((c) => c.kind)).toEqual(["started", "event", "settled", "settleAll"]);
    expect((calls[3] as { status: string }).status).toBe("completed");
    const usageChunk = chunks.find((c) => c.data.startsWith(FX_USAGE_STATUS_PREFIX));
    expect(usageChunk?.lineUuid).toBe(`copilot:usage:${ids.runId}`);
    expect(JSON.parse(usageChunk!.data.slice(FX_USAGE_STATUS_PREFIX.length))).toEqual({
      turn: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 },
      aiCredits: 4,
    });
    // The usage sentinel is the last thing emitted before `done`.
    expect(chunks[chunks.length - 1]).toBe(usageChunk!);
  }, T);

  test("plan mode: exit_plan_mode planContent becomes the last chunk, after the usage sentinel", async () => {
    const ids = newIds();
    const stub = makeStub({
      lines: [
        j("exit_plan_mode.requested", "p1", { requestId: "r", summary: "s", planContent: "# Plan\n- step", actions: [], recommendedAction: "x" }, { ephemeral: true }),
        j("assistant.message", "p2", { messageId: "m", content: "Here is the plan." }),
        j("result", "p3", { sessionId: ids.sessionId, exitCode: 0 }),
      ],
      usageJson: JSON.stringify({ modelMetrics: { m: { usage: { inputTokens: 1, outputTokens: 1 } } } }),
    });
    const { chunks, onChunk } = collect();
    const agent = await spawnCopilotViaTmux(launchOpts(ids, stub, onChunk, { mode: "plan" }));
    expect(await agent.done).toBe(0);
    const last = chunks[chunks.length - 1]!;
    expect(last.stream).toBe("tool_use");
    expect(last.lineUuid).toBe(`copilot:plan:${ids.runId}`);
    expect(JSON.parse(last.data)).toMatchObject({ name: "copilot_plan", input: { plan: "# Plan\n- step" } });
    expect(chunks[chunks.length - 2]!.data.startsWith(FX_USAGE_STATUS_PREFIX)).toBe(true);
  }, T);

  test("plan mode falls back to plan.md written during the turn", async () => {
    const ids = newIds();
    const home = mkdtempSync(path.join(scratch, "planhome-"));
    const planFile = path.join(home, "session-state", ids.sessionId, "plan.md");
    // The stub writes the file; sessions dir must exist first.
    mkdirSync(path.dirname(planFile), { recursive: true });
    const stub = makeStub({
      lines: [j("assistant.message", "q1", { messageId: "m", content: "planning" }), j("result", "q2", { sessionId: ids.sessionId, exitCode: 0 })],
      sleepBefore: 1,
    });
    // Prepend a write of plan.md to the stub (after `sleep 1`, i.e. during the turn).
    const original = await Bun.file(stub).text();
    writeFileSync(stub, original.replace("sleep 1", `sleep 1\nprintf '# From file' > '${planFile}'`));
    const { chunks, onChunk } = collect();
    const agent = await spawnCopilotViaTmux(
      launchOpts(ids, stub, onChunk, { mode: "plan", copilotHome: home, env: { COPILOT_HOME: home } }),
    );
    expect(await agent.done).toBe(0);
    const plan = chunks.find((c) => c.stream === "tool_use");
    expect(plan).toBeDefined();
    expect(JSON.parse(plan!.data).input.plan).toBe("# From file");
  }, T);

  test("unauthenticated: stderr + login status once, non-zero, subagents settled orphaned", async () => {
    const ids = newIds();
    const stub = makeStub({
      lines: ["Error: No authentication information found.", "Run 'copilot login' to authenticate."],
      exitCode: 1,
    });
    const { chunks, onChunk } = collect();
    const { sink, calls } = recordingSink();
    const agent = await spawnCopilotViaTmux(launchOpts(ids, stub, onChunk, { onSubagent: sink }));
    expect(await agent.done).toBe(1);
    expect(chunks.filter((c) => c.data === COPILOT_LOGIN_STATUS_TEXT)).toHaveLength(1);
    expect(chunks.filter((c) => c.stream === "stderr")).toHaveLength(2);
    expect(calls).toEqual([{ kind: "settleAll", status: "orphaned" }]);
  }, T);

  test("a process exit with no result event still settles (exit file path)", async () => {
    const ids = newIds();
    const stub = makeStub({ lines: [j("assistant.message", "x1", { messageId: "m", content: "no result" })], exitCode: 0 });
    const { chunks, onChunk } = collect();
    const agent = await spawnCopilotViaTmux(launchOpts(ids, stub, onChunk));
    expect(await agent.done).toBe(0);
    expect(chunks.some((c) => c.stream === "assistant")).toBe(true);
  }, T);

  test("an abort Copilot didn't ask for resolves non-zero even though it exits 0", async () => {
    const ids = newIds();
    const stub = makeStub({
      lines: [
        j("abort", "a1", { reason: "user_initiated" }),
        j("assistant.idle", "a2", { aborted: true }),
        j("result", "a3", { sessionId: ids.sessionId, exitCode: 0 }),
      ],
      exitCode: 0,
    });
    const { chunks, onChunk } = collect();
    const agent = await spawnCopilotViaTmux(launchOpts(ids, stub, onChunk));
    expect(await agent.done).toBe(1);
    expect(chunks.some((c) => c.data === "turn aborted")).toBe(true);
  }, T);

  test("kill() resolves non-zero, settles subagents orphaned and removes the session", async () => {
    const ids = newIds();
    const stub = makeStub({
      lines: [j("assistant.message", "k1", { messageId: "m", content: "working" })],
      sleepAfter: 30,
    });
    const { onChunk } = collect();
    const { sink, calls } = recordingSink();
    const agent = await spawnCopilotViaTmux(launchOpts(ids, stub, onChunk, { onSubagent: sink }));
    await Bun.sleep(500);
    await agent.kill();
    expect(await agent.done).toBe(1);
    expect(calls).toEqual([{ kind: "settleAll", status: "orphaned" }]);
    expect(copilotSessionActive(ids.taskId)).toBe(false);
    expect(await sessionExistsByName(sessionNameFor(ids.taskId))).toBe(false);
  }, T);

  test("dropCopilotSession kills a live turn", async () => {
    const ids = newIds();
    const stub = makeStub({ lines: [j("assistant.message", "d1", { messageId: "m", content: "x" })], sleepAfter: 30 });
    const { onChunk } = collect();
    const agent = await spawnCopilotViaTmux(launchOpts(ids, stub, onChunk));
    await Bun.sleep(300);
    await dropCopilotSession(ids.taskId);
    expect(await agent.done).toBe(1);
    expect(await sessionExistsByName(sessionNameFor(ids.taskId))).toBe(false);
  }, T);

  test("external session death emits the session-ended sentinel and resolves non-zero", async () => {
    const ids = newIds();
    const stub = makeStub({ lines: [j("assistant.message", "x1", { messageId: "m", content: "hi" })], sleepAfter: 60 });
    const { chunks, onChunk } = collect();
    const { sink, calls } = recordingSink();
    const agent = await spawnCopilotViaTmux(launchOpts(ids, stub, onChunk, { onSubagent: sink }));
    await Bun.sleep(500);
    Bun.spawnSync([resolveTmuxBin(), ...tmuxSocketArgs(), "kill-session", "-t", "=" + sessionNameFor(ids.taskId)]);
    expect(await agent.done).toBe(1);
    expect(chunks.some((c) => c.stream === "status" && c.data.startsWith(SESSION_DIED_STATUS_PREFIX))).toBe(true);
    expect(calls).toEqual([{ kind: "settleAll", status: "orphaned" }]);
  }, 40_000);

  test("reattach replays from offset 0, deduped against the seeded uuids, and resolves on result", async () => {
    const ids = newIds();
    const stub = makeStub({
      lines: [
        j("assistant.message", "r1", { messageId: "m1", content: "already persisted" }),
        j("assistant.message", "r2", { messageId: "m2", content: "new after restart" }),
        j("result", "r3", { sessionId: ids.sessionId, exitCode: 0 }),
      ],
      sleepAfterFirstLine: 2,
    });
    // Host the turn the way spawn would, but with no tailer (an agetor that
    // has since restarted).
    const logPath = copilotLogPath(ids.runId);
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(logPath, "");
    writeFileSync(copilotPromptPath(ids.runId), "hello");
    const shell = buildCopilotShellCommand({
      argv: [stub],
      promptPath: copilotPromptPath(ids.runId),
      logPath,
      exitPath: copilotExitPath(ids.runId),
      stripClassicTokens: [],
      unsetAllowAll: false,
    });
    const name = sessionNameFor(ids.taskId);
    const started = Bun.spawnSync([
      resolveTmuxBin(),
      ...tmuxSocketArgs(),
      "new-session", "-d", "-s", name, "-c", scratch, "--", ...shell,
    ]);
    expect(started.exitCode).toBe(0);

    const { chunks, onChunk } = collect();
    const agent = await reattachCopilotSession({
      taskId: ids.taskId,
      runId: ids.runId,
      sessionName: name,
      onChunk,
      seenLineUuids: new Set(["copilot:r1"]),
      sessionId: ids.sessionId,
      copilotHome: scratch,
      mode: "auto",
      model: "claude-sonnet-5.5",
    });
    expect(agent).not.toBeNull();
    expect(await agent!.done).toBe(0);
    expect(chunks.filter((c) => c.stream === "assistant").map((c) => c.data)).toEqual(["new after restart"]);
  }, T);

  test("reattach returns null when the session is gone", async () => {
    const ids = newIds();
    const res = await reattachCopilotSession({
      taskId: ids.taskId,
      runId: ids.runId,
      sessionName: sessionNameFor(ids.taskId),
      onChunk: () => {},
      seenLineUuids: new Set(),
      sessionId: ids.sessionId,
      copilotHome: scratch,
      mode: "auto",
      model: null,
    });
    expect(res).toBeNull();
  });
});

test("a failed tmux launch throws instead of hanging", async () => {
  const dir = mkdtempSync(path.join(scratch, "faketmux-"));
  const bin = path.join(dir, "tmux");
  writeFileSync(bin, `#!${process.execPath}\nprocess.stderr.write("no server running");\nprocess.exit(1);\n`);
  chmodSync(bin, 0o755);
  const prevBin = process.env.AGETOR_TMUX_BIN;
  process.env.AGETOR_TMUX_BIN = bin;
  try {
    const ids = newIds();
    const { onChunk } = collect();
    await expect(
      spawnCopilotViaTmux(launchOpts(ids, "/bin/echo", onChunk)),
    ).rejects.toThrow(/failed to start GitHub Copilot session/);
    expect(copilotSessionActive(ids.taskId)).toBe(false);
  } finally {
    if (prevBin === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = prevBin;
  }
});

/* ────────────────────────────────────────────────────────────────────────── *
 * copilot-fake: scripted turns play through the real mapper.
 * ────────────────────────────────────────────────────────────────────────── */

describe("copilot-fake", () => {
  const input = { runId: "run-fake", sessionId: "sess-fake", model: "auto", subagentMs: 30 };

  test("marker detection: last marker wins, none → basic", () => {
    expect(fake.detectFakeCopilotScenario("hi")).toBe("basic");
    expect(fake.detectFakeCopilotScenario(`x ${fake.FAKE_COPILOT_STREAM_PROMPT_MARKER}`)).toBe("stream");
    expect(fake.detectFakeCopilotScenario(`${fake.FAKE_COPILOT_PLAN_PROMPT_MARKER}`)).toBe("plan");
    expect(fake.detectFakeCopilotScenario(`${fake.FAKE_COPILOT_AUTH_PROMPT_MARKER}`)).toBe("auth");
    expect(
      fake.detectFakeCopilotScenario(`${fake.FAKE_COPILOT_STREAM_PROMPT_MARKER} then ${fake.FAKE_COPILOT_PLAN_PROMPT_MARKER}`),
    ).toBe("plan");
    expect(fake.FAKE_COPILOT_STREAM_PROMPT_MARKER).toBe("__agetor_fake_copilot_stream__");
  });

  test("subagent delay env is parsed with a default and clamp", () => {
    expect(fake.fakeCopilotSubagentMs({})).toBe(1500);
    expect(fake.fakeCopilotSubagentMs({ AGETOR_FAKE_COPILOT_SUBAGENT_MS: "250" })).toBe(250);
    expect(fake.fakeCopilotSubagentMs({ AGETOR_FAKE_COPILOT_SUBAGENT_MS: "-5" })).toBe(1500);
    expect(fake.fakeCopilotSubagentMs({ AGETOR_FAKE_COPILOT_SUBAGENT_MS: "999999" })).toBe(60_000);
  });

  test("stream scenario: thinking, tool card, auto status, subagent sink, usage sentinel", async () => {
    const script = fake.fakeCopilotScript(`go ${fake.FAKE_COPILOT_STREAM_PROMPT_MARKER}`, input);
    const { chunks, onChunk } = collect();
    const { sink, calls } = recordingSink();
    const agent = fake.playFakeCopilotTurn({
      script,
      runId: input.runId,
      sessionId: input.sessionId,
      model: "auto",
      mode: "auto",
      copilotHome: scratch,
      onChunk,
      sink,
    });
    expect(await agent.done).toBe(0);
    const streams = chunks.map((c) => c.stream);
    expect(streams).toContain("thinking");
    expect(streams).toContain("tool_use");
    expect(streams).toContain("tool_result");
    expect(chunks.some((c) => c.data === "GitHub Copilot auto picked claude-sonnet-5.5")).toBe(true);
    expect(calls.map((c) => c.kind)).toEqual(["started", "event", "event", "event", "settled", "settleAll"]);
    const usage = chunks.find((c) => c.data.startsWith(FX_USAGE_STATUS_PREFIX));
    expect(JSON.parse(usage!.data.slice(FX_USAGE_STATUS_PREFIX.length)).aiCredits).toBe(2.5);
    // Not Plan mode → no plan chunk.
    expect(chunks.some((c) => c.stream === "tool_use" && c.lineUuid?.startsWith("copilot:plan:"))).toBe(false);
  });

  test("plan scenario in Plan mode ends with the copilot_plan tool_use", async () => {
    const script = fake.fakeCopilotScript(fake.FAKE_COPILOT_PLAN_PROMPT_MARKER, input);
    const { chunks, onChunk } = collect();
    const agent = fake.playFakeCopilotTurn({
      script,
      runId: input.runId,
      sessionId: input.sessionId,
      model: "auto",
      mode: "plan",
      copilotHome: scratch,
      onChunk,
    });
    expect(await agent.done).toBe(0);
    const last = chunks[chunks.length - 1]!;
    expect(last.lineUuid).toBe("copilot:plan:run-fake");
    expect(JSON.parse(last.data).input.plan).toContain("# Fake plan");
  });

  test("auth scenario fails with the login status line", async () => {
    const script = fake.fakeCopilotScript(fake.FAKE_COPILOT_AUTH_PROMPT_MARKER, input);
    const { chunks, onChunk } = collect();
    const agent = fake.playFakeCopilotTurn({
      script,
      runId: input.runId,
      sessionId: input.sessionId,
      model: "auto",
      mode: "auto",
      copilotHome: scratch,
      onChunk,
    });
    expect(await agent.done).toBe(1);
    expect(chunks.filter((c) => c.data === COPILOT_LOGIN_STATUS_TEXT)).toHaveLength(1);
  });

  test("kill() stops playback, settles subagents orphaned and resolves 1", async () => {
    const script = fake.fakeCopilotScript(fake.FAKE_COPILOT_STREAM_PROMPT_MARKER, { ...input, subagentMs: 10_000 });
    const { onChunk } = collect();
    const { sink, calls } = recordingSink();
    const agent = fake.playFakeCopilotTurn({
      script,
      runId: input.runId,
      sessionId: input.sessionId,
      model: "auto",
      mode: "auto",
      copilotHome: scratch,
      onChunk,
      sink,
    });
    await Bun.sleep(200);
    agent.kill();
    expect(await agent.done).toBe(1);
    expect(calls[calls.length - 1]).toEqual({ kind: "settleAll", status: "orphaned" });
  });
});

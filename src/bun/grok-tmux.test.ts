import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.ts captures AGETOR_DATA_DIR at first import; grok-tmux imports dataDir
// from it. Set a temp dir before importing (mirrors codex-tmux.test.ts).
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-grok-tmux-"));

const { mapGrokEvent, grokLogPath } = await import("./grok-tmux.ts");
import type { RunEventStream } from "../shared/types.ts";

type Chunk = { stream: RunEventStream; data: string; lineUuid?: string };
function collect() {
  const chunks: Chunk[] = [];
  const onChunk = (stream: RunEventStream, data: string, lineUuid?: string) =>
    chunks.push({ stream, data, lineUuid });
  return { chunks, onChunk };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Assistant-text shapes → "assistant" chunks.
 * ────────────────────────────────────────────────────────────────────────── */

test("agent_message with id+text maps to an assistant chunk, key folds the line index", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent({ type: "agent_message", id: "m1", text: "hello" }, onChunk, 0);
  expect(chunks).toEqual([{ stream: "assistant", data: "hello", lineUuid: "agent_message:m1:0" }]);
});

test("message with content.text (no id) maps to an assistant chunk keyed by line index", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent({ type: "message", content: { text: "hi" } }, onChunk, 3);
  expect(chunks).toEqual([{ stream: "assistant", data: "hi", lineUuid: "line:3" }]);
});

test("ACP-style session/update agent_message_chunk maps to an assistant chunk", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent(
    {
      method: "session/update",
      update: { sessionUpdate: "agent_message_chunk", content: { text: "partial" } },
    },
    onChunk,
    5,
  );
  expect(chunks).toEqual([{ stream: "assistant", data: "partial", lineUuid: "line:5" }]);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Thinking / reasoning shapes → "thinking" chunks.
 * ────────────────────────────────────────────────────────────────────────── */

test("reasoning event with id+text maps to a thinking chunk, key folds the line index", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent({ type: "reasoning", id: "r1", text: "pondering" }, onChunk, 2);
  expect(chunks).toEqual([{ stream: "thinking", data: "pondering", lineUuid: "reasoning:r1:2" }]);
});

test("a 'think' substring type (no id) maps to a thinking chunk keyed by line index", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent({ type: "thinking_delta", content: "hmm" }, onChunk, 9);
  expect(chunks).toEqual([{ stream: "thinking", data: "hmm", lineUuid: "line:9" }]);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Tool / command shapes → tool_use (+ tool_result), with and without output.
 * ────────────────────────────────────────────────────────────────────────── */

test("tool event with an `output` field emits tool_use + tool_result with :use/:result key suffixes", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent({ type: "tool_call", id: "t1", command: "ls", output: "file.txt" }, onChunk, 0);
  expect(chunks).toHaveLength(2);
  expect(chunks[0]?.stream).toBe("tool_use");
  expect(chunks[0]?.lineUuid).toBe("tool_call:t1:use");
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({ name: "tool_call", input: { command: "ls" } });
  expect(chunks[1]?.stream).toBe("tool_result");
  expect(chunks[1]?.lineUuid).toBe("tool_call:t1:result");
  expect(JSON.parse(chunks[1]!.data)).toMatchObject({ content: "file.txt" });
});

test("tool event with a `result` field (not `output`) also emits tool_result", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent({ type: "command_execution", id: "t2", result: { ok: true } }, onChunk, 0);
  const result = chunks.find((c) => c.stream === "tool_result");
  expect(result).toBeDefined();
  expect(result?.lineUuid).toBe("command_execution:t2:result");
  expect(JSON.parse(result!.data)).toMatchObject({ content: { ok: true } });
});

test("tool event without output/result emits only tool_use", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent({ type: "command_execution", id: "c1", command: "ls -la" }, onChunk, 0);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.stream).toBe("tool_use");
  expect(chunks[0]?.lineUuid).toBe("command_execution:c1:use");
});

test("tool_use key does NOT fold the line index (unlike text chunks) — repeats read as state updates", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent({ type: "tool_call", id: "t3", command: "pwd" }, onChunk, 42);
  expect(chunks[0]?.lineUuid).toBe("tool_call:t3:use");
});

test("ACP-style session/update with a tool/command/plan sessionUpdate emits tool_use with the raw update payload", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent(
    { method: "session/update", update: { sessionUpdate: "tool_call", input: { cmd: "ls" } } },
    onChunk,
    2,
  );
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.stream).toBe("tool_use");
  expect(chunks[0]?.lineUuid).toBe("line:2");
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({ sessionUpdate: "tool_call" });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Error / failed shapes → stderr + done:1.
 * ────────────────────────────────────────────────────────────────────────── */

test("error event with error.message emits stderr and done=1, bare key even though it has an id", () => {
  const { chunks, onChunk } = collect();
  const r = mapGrokEvent({ type: "error", id: "e1", error: { message: "boom" } }, onChunk, 4);
  expect(r.done).toBe(1);
  // Errors aren't deltas: the key is NOT folded with the line index the way
  // assistant/thinking text chunks are.
  expect(chunks).toEqual([{ stream: "stderr", data: "boom", lineUuid: "error:e1" }]);
});

test("a 'fail' substring type with a string error emits stderr and done=1", () => {
  const { chunks, onChunk } = collect();
  const r = mapGrokEvent({ type: "turn_failed", error: "model down" }, onChunk, 0);
  expect(r.done).toBe(1);
  expect(chunks).toEqual([{ stream: "stderr", data: "model down", lineUuid: "line:0" }]);
});

test("error event with no error/message/text field falls back to a generic message", () => {
  const { chunks, onChunk } = collect();
  const r = mapGrokEvent({ type: "error" }, onChunk, 0);
  expect(r.done).toBe(1);
  expect(chunks[0]?.data).toBe("grok turn failed");
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Completion shapes → done:0, no chunk.
 * ────────────────────────────────────────────────────────────────────────── */

const completionCases: Array<[string, Record<string, unknown>]> = [
  ["turn.completed-ish type", { type: "turn.completed" }],
  ["bare 'done' type", { type: "done" }],
  ["'finished' type", { type: "finished" }],
  ["exact 'result' type", { type: "result" }],
];

for (const [label, evt] of completionCases) {
  test(`completion shape (${label}) resolves done=0 and emits no chunk`, () => {
    const { chunks, onChunk } = collect();
    const r = mapGrokEvent(evt, onChunk, 0);
    expect(r.done).toBe(0);
    expect(chunks).toHaveLength(0);
  });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Unrecognized events: text falls back to generic tool_use; pure noise drops.
 * ────────────────────────────────────────────────────────────────────────── */

test("unrecognized event type with text falls back to a generic tool_use chunk", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent({ type: "unknown_thing", id: "u1", text: "some text" }, onChunk, 0);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.stream).toBe("tool_use");
  expect(chunks[0]?.lineUuid).toBe("unknown_thing:u1");
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({ name: "unknown_thing", text: "some text" });
});

test("unrecognized event with no text anywhere is pure protocol noise — no chunk emitted", () => {
  const { chunks, onChunk } = collect();
  const r = mapGrokEvent({ type: "ping" }, onChunk, 0);
  expect(chunks).toHaveLength(0);
  expect(r.sessionId).toBeUndefined();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Session-id sniffing.
 * ────────────────────────────────────────────────────────────────────────── */

test("session_id at the top level is sniffed even off an otherwise-silent event", () => {
  const { chunks, onChunk } = collect();
  const r = mapGrokEvent({ type: "ping", session_id: "sess-1" }, onChunk, 0);
  expect(r.sessionId).toBe("sess-1");
  expect(chunks).toHaveLength(0);
});

test("camelCase sessionId at the top level is sniffed", () => {
  const { onChunk } = collect();
  const r = mapGrokEvent({ type: "ping", sessionId: "sess-2" }, onChunk, 0);
  expect(r.sessionId).toBe("sess-2");
});

test("session id one level deep (inside `update`) is sniffed", () => {
  const { onChunk } = collect();
  const r = mapGrokEvent({ type: "ping", update: { sessionId: "sess-3" } }, onChunk, 0);
  expect(r.sessionId).toBe("sess-3");
});

test("session_id one level deep (inside an arbitrary wrapper field) is sniffed", () => {
  const { onChunk } = collect();
  const r = mapGrokEvent({ type: "ping", params: { session_id: "sess-4" } }, onChunk, 0);
  expect(r.sessionId).toBe("sess-4");
});

/* ────────────────────────────────────────────────────────────────────────── *
 * line_uuid determinism + delta safety (the textKey line-index folding).
 * ────────────────────────────────────────────────────────────────────────── */

test("delta safety: the same message id at different lineIndex values yields DIFFERENT keys", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent({ type: "message", id: "m1", text: "partial one" }, onChunk, 0);
  mapGrokEvent({ type: "message", id: "m1", text: "partial two" }, onChunk, 1);
  expect(chunks).toHaveLength(2);
  expect(chunks[0]?.lineUuid).toBe("message:m1:0");
  expect(chunks[1]?.lineUuid).toBe("message:m1:1");
  expect(chunks[0]?.lineUuid).not.toBe(chunks[1]?.lineUuid);
});

test("replay determinism: the same event at the same lineIndex twice yields the SAME key twice", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent({ type: "message", id: "m1", text: "hello" }, onChunk, 3);
  mapGrokEvent({ type: "message", id: "m1", text: "hello" }, onChunk, 3);
  expect(chunks).toHaveLength(2);
  expect(chunks[0]?.lineUuid).toBe("message:m1:3");
  expect(chunks[1]?.lineUuid).toBe(chunks[0]?.lineUuid);
});

test("events without an id get a deterministic line:<n> key", () => {
  const { chunks, onChunk } = collect();
  mapGrokEvent({ type: "message", text: "no id here" }, onChunk, 7);
  expect(chunks[0]?.lineUuid).toBe("line:7");
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Path helper (mirrors codexLogPath's reattach-derivability guarantee).
 * ────────────────────────────────────────────────────────────────────────── */

test("grokLogPath is derivable from runId alone (so reattach can recompute it)", () => {
  const p = grokLogPath("run-xyz");
  expect(p.endsWith(path.join("grok-logs", "run-xyz.jsonl"))).toBe(true);
});

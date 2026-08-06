import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.ts captures AGETOR_DATA_DIR at first import; gemini-tmux imports dataDir
// from it. Set a temp dir before importing.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-gemini-tmux-"));

const { mapGeminiEvent, geminiLogPath } = await import("./gemini-tmux.ts");
import type { RunEventStream } from "../shared/types.ts";

type Chunk = { stream: RunEventStream; data: string; lineUuid?: string };
function collect() {
  const chunks: Chunk[] = [];
  const onChunk = (stream: RunEventStream, data: string, lineUuid?: string) =>
    chunks.push({ stream, data, lineUuid });
  return { chunks, onChunk };
}

// Event fixtures below are taken verbatim from a real spike against
// `gemini --output-format stream-json` (CLI 0.54.0, live API) — not
// inferred from docs. See CLAUDE.md's "Agent command shape" section.

test("init is silent (agetor already knows the session id — it self-issued it)", () => {
  const { chunks, onChunk } = collect();
  const r = mapGeminiEvent(
    { type: "init", timestamp: "2026-08-06T15:11:57.646Z", session_id: "b89c9f01-1938-474f-b8be-19be0dc071ad", model: "auto" },
    onChunk,
    { n: 0 },
  );
  expect(chunks).toHaveLength(0);
  expect(r.done).toBeUndefined();
});

test("message role:user is silent (the orchestrator already recorded it before spawning)", () => {
  const { chunks, onChunk } = collect();
  mapGeminiEvent(
    { type: "message", role: "user", content: "Reply with exactly the word PONG and nothing else." },
    onChunk,
    { n: 0 },
  );
  expect(chunks).toHaveLength(0);
});

test("message role:assistant maps to an assistant chunk", () => {
  const { chunks, onChunk } = collect();
  mapGeminiEvent({ type: "message", role: "assistant", content: "PONG", delta: true }, onChunk, { n: 0 });
  expect(chunks).toEqual([{ stream: "assistant", data: "PONG", lineUuid: "message:0" }]);
});

test("multiple assistant message deltas get distinct sequential line_uuids", () => {
  const { chunks, onChunk } = collect();
  const seq = { n: 0 };
  mapGeminiEvent({ type: "message", role: "assistant", content: "I have created the file " }, onChunk, seq);
  mapGeminiEvent({ type: "message", role: "assistant", content: "`created.txt`." }, onChunk, seq);
  expect(chunks.map((c) => c.lineUuid)).toEqual(["message:0", "message:1"]);
});

test("tool_use maps to a tool_use chunk keyed by tool_id", () => {
  const { chunks, onChunk } = collect();
  mapGeminiEvent(
    {
      type: "tool_use",
      tool_name: "write_file",
      tool_id: "write_file__5lh6ryus",
      parameters: { file_path: "created.txt", content: "DONE" },
    },
    onChunk,
    { n: 0 },
  );
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.stream).toBe("tool_use");
  expect(chunks[0]?.lineUuid).toBe("tool_use:write_file__5lh6ryus");
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({
    id: "write_file__5lh6ryus",
    name: "write_file",
    input: { file_path: "created.txt", content: "DONE" },
  });
});

test("tool_result (success) maps to a tool_result chunk with isError:false", () => {
  const { chunks, onChunk } = collect();
  mapGeminiEvent({ type: "tool_result", tool_id: "write_file__5lh6ryus", status: "success" }, onChunk, { n: 0 });
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.stream).toBe("tool_result");
  expect(chunks[0]?.lineUuid).toBe("tool_result:write_file__5lh6ryus");
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({ toolUseId: "write_file__5lh6ryus", isError: false });
});

test("tool_result with a non-success status marks the chunk as an error", () => {
  const { chunks, onChunk } = collect();
  mapGeminiEvent({ type: "tool_result", tool_id: "write_file__abc", status: "failed" }, onChunk, { n: 0 });
  expect(JSON.parse(chunks[0]!.data).isError).toBe(true);
});

test("tool_use then tool_result for the SAME tool_id produce distinct line_uuids", () => {
  // The whole point of the `${type}:${tool_id}` scheme: unlike codex's
  // command_execution (one event → two chunks with an explicit :use/:result
  // suffix), gemini emits tool_use and tool_result as SEPARATE events that
  // happen to share the same tool_id — the event-type prefix alone is
  // enough to keep them from colliding under the (run_id, line_uuid)
  // unique index.
  const { chunks, onChunk } = collect();
  const seq = { n: 0 };
  mapGeminiEvent({ type: "tool_use", tool_name: "write_file", tool_id: "w1", parameters: {} }, onChunk, seq);
  mapGeminiEvent({ type: "tool_result", tool_id: "w1", status: "success" }, onChunk, seq);
  expect(chunks.map((c) => c.lineUuid)).toEqual(["tool_use:w1", "tool_result:w1"]);
});

test("result with status:success resolves done=0 and emits nothing", () => {
  const { chunks, onChunk } = collect();
  const r = mapGeminiEvent(
    { type: "result", status: "success", stats: { total_tokens: 11969, tool_calls: 0 } },
    onChunk,
    { n: 0 },
  );
  expect(r.done).toBe(0);
  expect(chunks).toHaveLength(0);
});

test("result with a non-success status emits stderr and resolves done=1", () => {
  const { chunks, onChunk } = collect();
  const r = mapGeminiEvent(
    { type: "result", status: "error", error: { message: "503 Service Unavailable" } },
    onChunk,
    { n: 0 },
  );
  expect(r.done).toBe(1);
  expect(chunks).toEqual([{ stream: "stderr", data: "503 Service Unavailable", lineUuid: "result:0" }]);
});

test("result with a non-success status and no error field falls back to a generic message", () => {
  const { chunks, onChunk } = collect();
  mapGeminiEvent({ type: "result", status: "turn_limit_exceeded" }, onChunk, { n: 0 });
  expect(chunks[0]?.data).toBe("gemini turn failed (status: turn_limit_exceeded)");
});

test("top-level error event emits stderr without resolving the turn", () => {
  const { chunks, onChunk } = collect();
  const r = mapGeminiEvent({ type: "error", error: "transport error" }, onChunk, { n: 0 });
  expect(r.done).toBeUndefined();
  expect(chunks).toEqual([{ stream: "stderr", data: "transport error", lineUuid: "error:0" }]);
});

test("id-less events (result, error) get a deterministic per-run seq suffix", () => {
  const { chunks, onChunk } = collect();
  const seq = { n: 0 };
  mapGeminiEvent({ type: "error", error: "first" }, onChunk, seq);
  mapGeminiEvent({ type: "error", error: "second" }, onChunk, seq);
  // Two distinct keys → both rows survive INSERT OR IGNORE on (run_id, line_uuid).
  expect(chunks.map((c) => c.lineUuid)).toEqual(["error:0", "error:1"]);
});

test("unknown event types are silent forward-compat", () => {
  const { chunks, onChunk } = collect();
  mapGeminiEvent({ type: "some_future_event", foo: "bar" }, onChunk, { n: 0 });
  expect(chunks).toHaveLength(0);
});

test("geminiLogPath is derivable from runId alone (so reattach can recompute it)", () => {
  const p = geminiLogPath("run-xyz");
  expect(p.endsWith(path.join("gemini-logs", "run-xyz.jsonl"))).toBe(true);
});

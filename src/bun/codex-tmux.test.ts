import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.ts captures AGETOR_DATA_DIR at first import; codex-tmux imports dataDir
// from it. Set a temp dir before importing.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-codex-tmux-"));

const { mapCodexEvent, codexLogPath } = await import("./codex-tmux.ts");
import type { RunEventStream } from "../shared/types.ts";

type Chunk = { stream: RunEventStream; data: string; lineUuid?: string };
function collect() {
  const chunks: Chunk[] = [];
  const onChunk = (stream: RunEventStream, data: string, lineUuid?: string) =>
    chunks.push({ stream, data, lineUuid });
  return { chunks, onChunk };
}

test("thread.started returns the thread_id and emits nothing", () => {
  const { chunks, onChunk } = collect();
  const r = mapCodexEvent({ type: "thread.started", thread_id: "abc-123" }, onChunk, { n: 0 });
  expect(r.threadId).toBe("abc-123");
  expect(chunks).toHaveLength(0);
});

test("agent_message item maps to an assistant chunk keyed by event-type:item-id", () => {
  const { chunks, onChunk } = collect();
  mapCodexEvent(
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "hi there" } },
    onChunk,
    { n: 0 },
  );
  expect(chunks).toEqual([{ stream: "assistant", data: "hi there", lineUuid: "item.completed:item_0" }]);
});

test("reasoning item maps to a thinking chunk", () => {
  const { chunks, onChunk } = collect();
  mapCodexEvent(
    { type: "item.completed", item: { id: "item_1", type: "reasoning", text: "let me think" } },
    onChunk,
    { n: 0 },
  );
  expect(chunks).toEqual([{ stream: "thinking", data: "let me think", lineUuid: "item.completed:item_1" }]);
});

test("error item maps to a stderr chunk", () => {
  const { chunks, onChunk } = collect();
  mapCodexEvent(
    { type: "item.completed", item: { id: "item_2", type: "error", message: "boom" } },
    onChunk,
    { n: 0 },
  );
  expect(chunks).toEqual([{ stream: "stderr", data: "boom", lineUuid: "item.completed:item_2" }]);
});

test("command_execution emits tool_use + tool_result with DISTINCT line_uuids", () => {
  const { chunks, onChunk } = collect();
  mapCodexEvent(
    {
      type: "item.completed",
      item: { id: "item_3", type: "command_execution", command: "ls -la", aggregated_output: "file.txt", exit_code: 0 },
    },
    onChunk,
    { n: 0 },
  );
  expect(chunks).toHaveLength(2);
  expect(chunks[0]?.stream).toBe("tool_use");
  expect(chunks[0]?.lineUuid).toBe("item.completed:item_3:use");
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({ name: "shell", input: { command: "ls -la" } });
  expect(chunks[1]?.stream).toBe("tool_result");
  expect(chunks[1]?.lineUuid).toBe("item.completed:item_3:result");
  expect(JSON.parse(chunks[1]!.data)).toMatchObject({ toolUseId: "item_3", isError: false });
});

test("command_execution with non-zero exit marks the tool_result as an error", () => {
  const { chunks, onChunk } = collect();
  mapCodexEvent(
    {
      type: "item.completed",
      item: { id: "item_4", type: "command_execution", command: "false", aggregated_output: "", exit_code: 1 },
    },
    onChunk,
    { n: 0 },
  );
  const result = chunks.find((c) => c.stream === "tool_result");
  expect(result).toBeDefined();
  expect(JSON.parse(result!.data).isError).toBe(true);
});

test("item.started and turn.started are silent (avoid double-render)", () => {
  const { chunks, onChunk } = collect();
  mapCodexEvent({ type: "item.started", item: { id: "item_0", type: "agent_message" } }, onChunk, { n: 0 });
  mapCodexEvent({ type: "turn.started" }, onChunk, { n: 0 });
  expect(chunks).toHaveLength(0);
});

test("started and completed of the same item never collide on line_uuid", () => {
  // The whole point of the `${event.type}:${id}` scheme: item.started and
  // item.completed share `item.id` but must produce distinct keys so the
  // (run_id, line_uuid) unique index doesn't drop the completed event.
  const startKey = "item.started:item_9";
  const { chunks, onChunk } = collect();
  // item.started is silent, so assert via a hypothetical: the completed key is
  // namespaced by event type and so differs from any started key.
  mapCodexEvent(
    { type: "item.completed", item: { id: "item_9", type: "agent_message", text: "x" } },
    onChunk,
    { n: 0 },
  );
  expect(chunks[0]?.lineUuid).toBe("item.completed:item_9");
  expect(chunks[0]?.lineUuid).not.toBe(startKey);
});

test("turn.completed resolves done=0; turn.failed emits stderr + done=1", () => {
  const a = collect();
  expect(mapCodexEvent({ type: "turn.completed" }, a.onChunk, { n: 0 }).done).toBe(0);
  expect(a.chunks).toHaveLength(0);

  const b = collect();
  const r = mapCodexEvent({ type: "turn.failed", error: { message: "model 400" } }, b.onChunk, { n: 0 });
  expect(r.done).toBe(1);
  expect(b.chunks).toEqual([{ stream: "stderr", data: "model 400", lineUuid: "turn.failed:0" }]);
});

test("id-less events (error, turn.failed) get a deterministic per-run seq suffix", () => {
  const { chunks, onChunk } = collect();
  const seq = { n: 0 };
  mapCodexEvent({ type: "error", message: "first" }, onChunk, seq);
  mapCodexEvent({ type: "error", message: "second" }, onChunk, seq);
  // Two distinct keys → both rows survive INSERT OR IGNORE on (run_id, line_uuid).
  expect(chunks.map((c) => c.lineUuid)).toEqual(["error:0", "error:1"]);
});

test("unknown item type with text falls back to an assistant chunk", () => {
  const { chunks, onChunk } = collect();
  mapCodexEvent(
    { type: "item.completed", item: { id: "item_5", type: "web_search", text: "searched X" } },
    onChunk,
    { n: 0 },
  );
  expect(chunks[0]).toMatchObject({ stream: "assistant", data: "searched X" });
});

test("unknown item type without text falls back to a generic tool_use", () => {
  const { chunks, onChunk } = collect();
  mapCodexEvent(
    { type: "item.completed", item: { id: "item_6", type: "file_change", path: "a.ts" } },
    onChunk,
    { n: 0 },
  );
  expect(chunks[0]?.stream).toBe("tool_use");
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({ name: "file_change", input: { path: "a.ts" } });
});

test("codexLogPath is derivable from runId alone (so reattach can recompute it)", () => {
  const p = codexLogPath("run-xyz");
  expect(p.endsWith(path.join("codex-logs", "run-xyz.jsonl"))).toBe(true);
});

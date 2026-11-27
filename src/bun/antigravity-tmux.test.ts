import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-antigravity-tmux-"));

const { AntigravityTextCoalescer, mapAntigravityEvent } = await import("./antigravity-tmux.ts");
import type { RunEventStream } from "../shared/types.ts";

type Chunk = { stream: RunEventStream; data: string; lineUuid?: string };
function collect() {
  const chunks: Chunk[] = [];
  const onChunk = (stream: RunEventStream, data: string, lineUuid?: string) =>
    chunks.push({ stream, data, lineUuid });
  return { chunks, onChunk };
}

test("init captures conversation_id as sessionId", () => {
  const { chunks, onChunk } = collect();
  const res = mapAntigravityEvent(
    {
      event: "init",
      conversation_id: "test-conv-1234",
      init: { model: "gemini-3.8-flash-high", cwd: "/tmp" },
    },
    onChunk,
    0,
  );
  expect(chunks).toHaveLength(0);
  expect(res.sessionId).toBe("test-conv-1234");
  expect(res.done).toBeUndefined();
});

test("agent_response step_update emits assistant chunk with text_delta", () => {
  const { chunks, onChunk } = collect();
  const res = mapAntigravityEvent(
    {
      event: "step_update",
      step_update: {
        step_index: 1,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: "Hello from Antigravity!",
      },
    },
    onChunk,
    1,
  );
  expect(chunks).toEqual([
    {
      stream: "assistant",
      data: "Hello from Antigravity!",
      lineUuid: "antigravity:step_1",
    },
  ]);
  expect(res.assistantTextEmitted).toBe(true);
});

test("tool step_update emits tool_use on ACTIVE and tool_result on DONE", () => {
  const { chunks: chunks1, onChunk: onChunk1 } = collect();
  mapAntigravityEvent(
    {
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "view_file",
        tool_info: { name: "view_file", parameters: { AbsolutePath: "/path/to/file" } },
      },
    },
    onChunk1,
    2,
  );
  expect(chunks1).toHaveLength(1);
  expect(chunks1[0]?.stream).toBe("tool_use");
  expect(chunks1[0]?.lineUuid).toBe("tool_use:step_2");
  expect(JSON.parse(chunks1[0]!.data)).toMatchObject({
    id: "step_2",
    name: "view_file",
    input: { AbsolutePath: "/path/to/file" },
  });

  const { chunks: chunks2, onChunk: onChunk2 } = collect();
  mapAntigravityEvent(
    {
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "DONE",
        step_type: "tool",
        tool_name: "view_file",
        tool_info: { name: "view_file", output: "file contents here" },
      },
    },
    onChunk2,
    3,
  );
  expect(chunks2).toHaveLength(1);
  expect(chunks2[0]?.stream).toBe("tool_result");
  expect(chunks2[0]?.lineUuid).toBe("tool_result:step_2");
  expect(JSON.parse(chunks2[0]!.data)).toMatchObject({
    toolUseId: "step_2",
    content: "file contents here",
    isError: false,
  });
});

test("result event with SUCCESS resolves done: 0", () => {
  const { chunks, onChunk } = collect();
  const res = mapAntigravityEvent(
    {
      event: "result",
      result: {
        conversation_id: "test-conv-1234",
        status: "SUCCESS",
        response: "All done!\n",
      },
    },
    onChunk,
    4,
    true, // prior assistant text already emitted
  );
  expect(chunks).toHaveLength(0);
  expect(res.done).toBe(0);
  expect(res.sessionId).toBe("test-conv-1234");
});

test("result event with SUCCESS and no prior assistant text emits final response", () => {
  const { chunks, onChunk } = collect();
  const res = mapAntigravityEvent(
    {
      event: "result",
      result: {
        conversation_id: "test-conv-1234",
        status: "SUCCESS",
        response: "Direct response",
      },
    },
    onChunk,
    5,
    false,
  );
  expect(chunks).toEqual([
    {
      stream: "assistant",
      data: "Direct response",
      lineUuid: "antigravity:result:5",
    },
  ]);
  expect(res.done).toBe(0);
});

test("result event with ERROR emits stderr and resolves done: 1", () => {
  const { chunks, onChunk } = collect();
  const res = mapAntigravityEvent(
    {
      event: "result",
      result: {
        conversation_id: "test-conv-1234",
        status: "ERROR",
        error: "Quota exceeded",
      },
    },
    onChunk,
    6,
  );
  expect(chunks).toEqual([
    {
      stream: "stderr",
      data: "Quota exceeded",
      lineUuid: "antigravity:result:6",
    },
  ]);
  expect(res.done).toBe(1);
});

test("AntigravityTextCoalescer folds multi-delta ACTIVE + DONE agent_response into one intact Markdown chunk", () => {
  const { chunks, onChunk } = collect();
  const coalescer = new AntigravityTextCoalescer();
  const deltas = [
    "### Root Causes\n1. **",
    "Flat suffixe",
    "d Antigravity models wit",
    "h no effort ladder:** Bo",
    "th the curated list and `agy models`",
  ];
  let emitted = false;
  deltas.forEach((text_delta, idx) => {
    const res = mapAntigravityEvent(
      {
        event: "step_update",
        step_update: { step_index: 215, state: "ACTIVE", step_type: "agent_response", text_delta },
      },
      onChunk,
      idx,
      emitted,
      coalescer,
    );
    if (res.assistantTextEmitted) emitted = true;
  });
  expect(chunks).toHaveLength(0);
  expect(coalescer.hasPending()).toBe(true);

  const doneRes = mapAntigravityEvent(
    {
      event: "step_update",
      step_update: { step_index: 215, state: "DONE", step_type: "agent_response", text_delta: "\n" },
    },
    onChunk,
    deltas.length,
    emitted,
    coalescer,
  );
  expect(doneRes.assistantTextEmitted).toBe(true);
  expect(coalescer.hasPending()).toBe(false);
  expect(chunks).toEqual([
    {
      stream: "assistant",
      data: "### Root Causes\n1. **Flat suffixed Antigravity models with no effort ladder:** Both the curated list and `agy models`\n",
      lineUuid: "antigravity:step_215",
    },
  ]);

  // Follow-up SUCCESS result must not duplicate the already-emitted text.
  const endRes = mapAntigravityEvent(
    {
      event: "result",
      result: { status: "SUCCESS", response: "### Root Causes..." },
    },
    onChunk,
    deltas.length + 1,
    true,
    coalescer,
  );
  expect(endRes.done).toBe(0);
  expect(chunks).toHaveLength(1);
});

test("single DONE agent_response emits immediately, and empty DONE (tool-only turn) emits nothing", () => {
  const { chunks, onChunk } = collect();
  const coalescer = new AntigravityTextCoalescer();

  const empty = mapAntigravityEvent(
    { event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response" } },
    onChunk,
    0,
    false,
    coalescer,
  );
  expect(empty.assistantTextEmitted).toBeUndefined();
  expect(chunks).toHaveLength(0);

  const single = mapAntigravityEvent(
    {
      event: "step_update",
      step_update: { step_index: 147, state: "DONE", step_type: "agent_response", text_delta: "Waiting for tests.\n" },
    },
    onChunk,
    1,
    false,
    coalescer,
  );
  expect(single.assistantTextEmitted).toBe(true);
  expect(chunks).toEqual([
    { stream: "assistant", data: "Waiting for tests.\n", lineUuid: "antigravity:step_147" },
  ]);
});

test("tool step flushes pending assistant deltas first, and tool ERROR emits tool_result with isError: true", () => {
  const { chunks, onChunk } = collect();
  const coalescer = new AntigravityTextCoalescer();

  mapAntigravityEvent(
    { event: "step_update", step_update: { step_index: 10, state: "ACTIVE", step_type: "agent_response", text_delta: "Checking " } },
    onChunk,
    0,
    false,
    coalescer,
  );
  mapAntigravityEvent(
    { event: "step_update", step_update: { step_index: 10, state: "ACTIVE", step_type: "agent_response", text_delta: "file..." } },
    onChunk,
    1,
    false,
    coalescer,
  );
  mapAntigravityEvent(
    {
      event: "step_update",
      step_update: {
        step_index: 11,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "read_file",
        tool_info: { name: "read_file", parameters: { Path: "/missing.ts" } },
      },
    },
    onChunk,
    2,
    false,
    coalescer,
  );
  mapAntigravityEvent(
    {
      event: "step_update",
      step_update: {
        step_index: 11,
        state: "ERROR",
        step_type: "tool",
        tool_name: "read_file",
        tool_info: {
          name: "read_file",
          parameters: { Path: "/missing.ts" },
          error: { type: "TOOL_ERROR", message: "file does not exist" },
        },
      },
    },
    onChunk,
    3,
    true,
    coalescer,
  );

  expect(chunks.map((c) => c.stream)).toEqual(["assistant", "tool_use", "tool_result"]);
  expect(chunks[0]).toEqual({ stream: "assistant", data: "Checking file...", lineUuid: "antigravity:step_10" });
  expect(chunks[2]?.lineUuid).toBe("tool_result:step_11");
  expect(JSON.parse(chunks[2]!.data)).toEqual({
    toolUseId: "step_11",
    content: "file does not exist",
    isError: true,
  });
});

test("result event flushes pending ACTIVE deltas without duplicating result.response", () => {
  const { chunks, onChunk } = collect();
  const coalescer = new AntigravityTextCoalescer();

  mapAntigravityEvent(
    { event: "step_update", step_update: { step_index: 20, state: "ACTIVE", step_type: "agent_response", text_delta: "All " } },
    onChunk,
    0,
    false,
    coalescer,
  );
  mapAntigravityEvent(
    { event: "step_update", step_update: { step_index: 20, state: "ACTIVE", step_type: "agent_response", text_delta: "done!" } },
    onChunk,
    1,
    false,
    coalescer,
  );
  const res = mapAntigravityEvent(
    { event: "result", result: { status: "SUCCESS", response: "All done!" } },
    onChunk,
    2,
    false,
    coalescer,
  );
  expect(res.done).toBe(0);
  expect(chunks).toEqual([
    { stream: "assistant", data: "All done!", lineUuid: "antigravity:step_20" },
  ]);
});

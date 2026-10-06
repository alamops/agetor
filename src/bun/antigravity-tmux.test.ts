import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-antigravity-tmux-"));

const { mapAntigravityEvent } = await import("./antigravity-tmux.ts");
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
      lineUuid: "antigravity:1",
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

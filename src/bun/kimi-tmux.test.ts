import { test, expect, describe, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.ts captures AGETOR_DATA_DIR at first import; kimi-tmux imports dataDir
// from it. Set a temp dir before importing (mirrors codex-tmux.test.ts).
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-kimi-tmux-"));

const { mapKimiEvent, kimiLogPath, mapKimiWireEvent } = await import("./kimi-tmux.ts");
import type { RunEventStream } from "../shared/types.ts";

type Chunk = { stream: RunEventStream; data: string; lineUuid?: string };
function collect() {
  const chunks: Chunk[] = [];
  const onChunk = (stream: RunEventStream, data: string, lineUuid?: string) =>
    chunks.push({ stream, data, lineUuid });
  return { chunks, onChunk };
}

test("assistant message with string content maps to an assistant chunk keyed by kimi:<lineNo>", () => {
  const { chunks, onChunk } = collect();
  mapKimiEvent(JSON.stringify({ role: "assistant", content: "hi there" }), onChunk, 0);
  expect(chunks).toEqual([{ stream: "assistant", data: "hi there", lineUuid: "kimi:0" }]);
});

test("assistant message with array-of-parts content concatenates text parts", () => {
  const { chunks, onChunk } = collect();
  mapKimiEvent(
    JSON.stringify({
      role: "assistant",
      content: [
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
        { type: "image", url: "ignored" }, // non-text part dropped
      ],
    }),
    onChunk,
    3,
  );
  expect(chunks).toEqual([{ stream: "assistant", data: "hello world", lineUuid: "kimi:3" }]);
});

test("assistant message with tool_calls emits one tool_use per call with distinct dedup keys", () => {
  const { chunks, onChunk } = collect();
  mapKimiEvent(
    JSON.stringify({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
        { id: "call_2", type: "function", function: { name: "list_dir", arguments: '{"path":"."}' } },
      ],
    }),
    onChunk,
    5,
  );
  expect(chunks).toHaveLength(2);
  expect(chunks[0]?.stream).toBe("tool_use");
  expect(chunks[0]?.lineUuid).toBe("kimi:5:tool:call_1");
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({
    id: "call_1",
    name: "read_file",
    input: { path: "a.ts" },
    serverSide: false,
  });
  expect(chunks[1]?.stream).toBe("tool_use");
  expect(chunks[1]?.lineUuid).toBe("kimi:5:tool:call_2");
  expect(JSON.parse(chunks[1]!.data)).toMatchObject({
    id: "call_2",
    name: "list_dir",
    input: { path: "." },
  });
  // Dedup keys distinct per call on the same line.
  expect(chunks[0]?.lineUuid).not.toBe(chunks[1]?.lineUuid);
});

test("tool_call arguments that aren't JSON pass through as raw text (defensive)", () => {
  const { chunks, onChunk } = collect();
  mapKimiEvent(
    JSON.stringify({
      role: "assistant",
      tool_calls: [{ id: "call_bad", type: "function", function: { name: "run", arguments: "not-json{{{" } }],
    }),
    onChunk,
    1,
  );
  expect(chunks).toHaveLength(1);
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({ id: "call_bad", name: "run", input: "not-json{{{" });
});

test("tool_call without a type field is still emitted (regression for the loosened gate)", () => {
  const { chunks, onChunk } = collect();
  mapKimiEvent(
    JSON.stringify({
      role: "assistant",
      tool_calls: [{ id: "call_notype", function: { name: "grep", arguments: "{}" } }],
    }),
    onChunk,
    2,
  );
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.stream).toBe("tool_use");
  expect(chunks[0]?.lineUuid).toBe("kimi:2:tool:call_notype");
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({ id: "call_notype", name: "grep" });
});

test('tool_call with type:"custom" is skipped', () => {
  const { chunks, onChunk } = collect();
  mapKimiEvent(
    JSON.stringify({
      role: "assistant",
      tool_calls: [
        { id: "call_custom", type: "custom", function: { name: "weird", arguments: "{}" } },
        { id: "call_fn", type: "function", function: { name: "ok", arguments: "{}" } },
      ],
    }),
    onChunk,
    4,
  );
  // Only the "function"-typed call survives; the "custom" one is skipped.
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.lineUuid).toBe("kimi:4:tool:call_fn");
});

test('role:"tool" maps to a tool_result correlated by tool_call_id', () => {
  const { chunks, onChunk } = collect();
  mapKimiEvent(
    JSON.stringify({ role: "tool", tool_call_id: "call_1", content: "file contents here" }),
    onChunk,
    6,
  );
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.stream).toBe("tool_result");
  expect(chunks[0]?.lineUuid).toBe("kimi:6");
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({
    toolUseId: "call_1",
    content: "file contents here",
    isError: false,
  });
});

test('role:"user" line is skipped (prompt echo)', () => {
  const { chunks, onChunk } = collect();
  mapKimiEvent(JSON.stringify({ role: "user", content: "do the thing" }), onChunk, 7);
  expect(chunks).toHaveLength(0);
});

test("non-JSON line is emitted as a stderr chunk with dedup key kimi:<lineNo>, not swallowed", () => {
  const { chunks, onChunk } = collect();
  mapKimiEvent("this is not json at all {{{", onChunk, 8);
  expect(chunks).toEqual([{ stream: "stderr", data: "this is not json at all {{{", lineUuid: "kimi:8" }]);
});

test("blank lines emit nothing (caller is responsible for not advancing lineNo on them)", () => {
  const { chunks, onChunk } = collect();
  mapKimiEvent("", onChunk, 9);
  mapKimiEvent("   \n", onChunk, 9);
  expect(chunks).toHaveLength(0);
});

test("dedup keys are stable across a replay of the same content (reattach-style second pass)", () => {
  const lines = [
    JSON.stringify({ role: "assistant", content: "first" }),
    JSON.stringify({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_a", type: "function", function: { name: "x", arguments: "{}" } }],
    }),
    JSON.stringify({ role: "tool", tool_call_id: "call_a", content: "result" }),
    "not json",
  ];

  const passOne = collect();
  lines.forEach((line, idx) => mapKimiEvent(line, passOne.onChunk, idx));

  // Simulate a reattach: re-tail the same log content from offset 0, feeding
  // the identical lineNo sequence (deterministic from file content alone).
  const passTwo = collect();
  lines.forEach((line, idx) => mapKimiEvent(line, passTwo.onChunk, idx));

  const keysOne = passOne.chunks.map((c) => c.lineUuid);
  const keysTwo = passTwo.chunks.map((c) => c.lineUuid);
  expect(keysTwo).toEqual(keysOne);
  expect(keysOne).toEqual(["kimi:0", "kimi:1:tool:call_a", "kimi:2", "kimi:3"]);
});

test("unknown/forward-compat role is silent", () => {
  const { chunks, onChunk } = collect();
  mapKimiEvent(JSON.stringify({ role: "system", content: "some future role" }), onChunk, 10);
  expect(chunks).toHaveLength(0);
});

test("kimiLogPath(runId) is derivable from runId alone (so reattach can recompute it)", () => {
  const p = kimiLogPath("run-xyz");
  expect(p.endsWith(path.join("kimi-logs", "run-xyz.jsonl"))).toBe(true);
});

// ─── Exit-code sidecar semantics ────────────────────────────────────────────
//
// The exit-code → outcome mapping (0 → clean; non-zero → failure; 75 →
// "retryable" status chunk before the failure) lives inline inside the
// deathTimer callback in kimi-tmux.ts (readKimiExitCode + the branch in
// startKimiTailer's setInterval), not behind an exported helper the way, say,
// mapKimiEvent is. There is no seam to reach it without spawning a real tmux
// session and racing the death watch (DEATH_POLL_MS/DEATH_GRACE_MS), and the
// task instructions are explicit: don't export new symbols from kimi-tmux.ts
// to make this testable. So the 0/1/75 mapping (incl. the "kimi exited with
// code 75 (retryable)" status wording) is left uncovered here by design —
// it's exercised end-to-end instead by the fake-driver orchestrator test
// (T7, orchestrator-kimi.test.ts) and by the live-binary smoke test called
// for in the plan's open questions (§8.7) before the harness ships enabled.

// ─── mapKimiWireEvent (wire.jsonl thinking parity) ─────────────────────────
//
// Pure parser for the internal wire.jsonl artifact both kimi-cli and
// kimi-code write. Two envelope shapes carry a `{"type":"think",...}` leaf;
// everything else (text parts, tool records, the metadata header, malformed
// lines) is either skipped or — for a protocol-version bump — signals the
// caller to stop tailing via `{disable: true}`.
describe("mapKimiWireEvent", () => {
  test("kimi-cli envelope: ContentPart/think payload maps to a thinking chunk keyed by kimiwire:<lineNo>", () => {
    const { chunks, onChunk } = collect();
    const line = JSON.stringify({
      timestamp: 1700000000000,
      message: {
        type: "ContentPart",
        payload: { type: "think", think: "reasoning about the fix…", encrypted: null },
      },
    });
    mapKimiWireEvent(line, onChunk, 12);
    expect(chunks).toEqual([{ stream: "thinking", data: "reasoning about the fix…", lineUuid: "kimiwire:12" }]);
  });

  test("kimi-code envelope: content.part/think part maps to a thinking chunk", () => {
    const { chunks, onChunk } = collect();
    const line = JSON.stringify({
      type: "context.append_loop_event",
      time: 1700000000000,
      event: {
        type: "content.part",
        stepUuid: "x",
        part: { type: "think", think: "weighing two approaches…" },
      },
    });
    mapKimiWireEvent(line, onChunk, 4);
    expect(chunks).toEqual([{ stream: "thinking", data: "weighing two approaches…", lineUuid: "kimiwire:4" }]);
  });

  test("metadata header with protocol_version 1.x emits nothing and does not disable the tailer", () => {
    const { chunks, onChunk } = collect();
    const result = mapKimiWireEvent(JSON.stringify({ type: "metadata", protocol_version: "1.10" }), onChunk, 0);
    expect(chunks).toHaveLength(0);
    expect(result).toBeUndefined();
  });

  test("metadata header with a non-1.x protocol_version returns {disable: true} and emits nothing", () => {
    const { chunks, onChunk } = collect();
    const result = mapKimiWireEvent(JSON.stringify({ type: "metadata", protocol_version: "2.0" }), onChunk, 0);
    expect(chunks).toHaveLength(0);
    expect(result).toEqual({ disable: true });
  });

  test("text parts are ignored in both envelope shapes", () => {
    const { chunks, onChunk } = collect();
    mapKimiWireEvent(
      JSON.stringify({ message: { type: "ContentPart", payload: { type: "text", text: "hello" } } }),
      onChunk,
      1,
    );
    mapKimiWireEvent(
      JSON.stringify({ event: { type: "content.part", part: { type: "text", text: "hello" } } }),
      onChunk,
      2,
    );
    expect(chunks).toHaveLength(0);
  });

  test("tool-call/tool-result wire records are ignored in both envelope shapes", () => {
    const { chunks, onChunk } = collect();
    mapKimiWireEvent(
      JSON.stringify({
        message: { type: "ContentPart", payload: { type: "tool_call", name: "read_file", arguments: "{}" } },
      }),
      onChunk,
      1,
    );
    mapKimiWireEvent(
      JSON.stringify({ event: { type: "content.part", part: { type: "tool_result", content: "ok" } } }),
      onChunk,
      2,
    );
    expect(chunks).toHaveLength(0);
  });

  test("SubagentEvent (kimi-cli nested envelope) is skipped even when it wraps a think leaf", () => {
    const { chunks, onChunk } = collect();
    const line = JSON.stringify({
      message: {
        type: "SubagentEvent",
        payload: {
          message: { type: "ContentPart", payload: { type: "think", think: "nested subagent reasoning" } },
        },
      },
    });
    mapKimiWireEvent(line, onChunk, 7);
    expect(chunks).toHaveLength(0);
  });

  test("a think leaf with an empty string think field is skipped", () => {
    const { chunks, onChunk } = collect();
    mapKimiWireEvent(
      JSON.stringify({ message: { type: "ContentPart", payload: { type: "think", think: "", encrypted: null } } }),
      onChunk,
      3,
    );
    expect(chunks).toHaveLength(0);
  });

  test("an encrypted-only think leaf (no plaintext think field) is skipped", () => {
    const { chunks, onChunk } = collect();
    // `think` entirely absent, only `encrypted` present.
    mapKimiWireEvent(
      JSON.stringify({ event: { type: "content.part", part: { type: "think", encrypted: "opaque-ciphertext" } } }),
      onChunk,
      3,
    );
    expect(chunks).toHaveLength(0);
  });

  test("a malformed JSON line is completely silent — no chunk, no stderr chunk", () => {
    // Deliberate contrast with the primary mapKimiEvent (see the "non-JSON
    // line is emitted as a stderr chunk" test above): wire.jsonl is an
    // internal, undocumented artifact, so a malformed line there is
    // best-effort and must never surface as noise in the run panel.
    const onChunk = mock((_stream: RunEventStream, _data: string, _lineUuid?: string) => {});
    const result = mapKimiWireEvent("this is not valid json at all {{{", onChunk, 9);
    expect(onChunk).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  test("pathological inputs do not throw: a huge line", () => {
    const { chunks, onChunk } = collect();
    const huge = "x".repeat(500_000);
    const line = JSON.stringify({
      message: { type: "ContentPart", payload: { type: "think", think: huge, encrypted: null } },
    });
    expect(() => mapKimiWireEvent(line, onChunk, 0)).not.toThrow();
    expect(chunks).toEqual([{ stream: "thinking", data: huge, lineUuid: "kimiwire:0" }]);
  });

  test("pathological inputs do not throw: deeply-nested JSON", () => {
    const { chunks, onChunk } = collect();
    let nested: unknown = { leaf: true };
    for (let i = 0; i < 1000; i++) nested = { nested };
    const line = JSON.stringify({ unrelated: nested });
    expect(() => mapKimiWireEvent(line, onChunk, 0)).not.toThrow();
    expect(chunks).toHaveLength(0);
  });

  test('pathological inputs do not throw: non-object JSON ("42", "[1,2]", "null")', () => {
    const { chunks, onChunk } = collect();
    expect(() => mapKimiWireEvent("42", onChunk, 0)).not.toThrow();
    expect(() => mapKimiWireEvent("[1,2]", onChunk, 1)).not.toThrow();
    expect(() => mapKimiWireEvent("null", onChunk, 2)).not.toThrow();
    expect(chunks).toHaveLength(0);
  });

  test("dedup keys are stable across a replay of the same lines with the same lineNos", () => {
    const lines = [
      JSON.stringify({ message: { type: "ContentPart", payload: { type: "think", think: "first" } } }),
      JSON.stringify({ event: { type: "content.part", part: { type: "think", think: "second" } } }),
      JSON.stringify({ type: "metadata", protocol_version: "1.10" }),
      "not json",
    ];

    const passOne = collect();
    lines.forEach((line, idx) => mapKimiWireEvent(line, passOne.onChunk, idx));

    // Simulate a reattach: re-tail the same wire.jsonl content from offset 0,
    // feeding the identical lineNo sequence (deterministic from file content
    // alone, mirroring the mapKimiEvent replay test above).
    const passTwo = collect();
    lines.forEach((line, idx) => mapKimiWireEvent(line, passTwo.onChunk, idx));

    const keysOne = passOne.chunks.map((c) => c.lineUuid);
    const keysTwo = passTwo.chunks.map((c) => c.lineUuid);
    expect(keysTwo).toEqual(keysOne);
    expect(keysOne).toEqual(["kimiwire:0", "kimiwire:1"]);
  });
});

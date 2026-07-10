import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.ts captures AGETOR_DATA_DIR at first import; cursor-tmux imports dataDir
// from it. Set a temp dir before importing (mirrors codex-tmux.test.ts).
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-cursor-tmux-"));

const { mapCursorEvent, cursorLogPath, readCursorExitCode } = await import("./cursor-tmux.ts");
import type { RunEventStream } from "../shared/types.ts";

type Chunk = { stream: RunEventStream; data: string; lineUuid?: string };
function collect() {
  const chunks: Chunk[] = [];
  const onChunk = (stream: RunEventStream, data: string, lineUuid?: string) =>
    chunks.push({ stream, data, lineUuid });
  return { chunks, onChunk };
}

test("system/init carries the session_id and emits no visible chunk", () => {
  const { chunks, onChunk } = collect();
  const r = mapCursorEvent({ type: "system", subtype: "init", session_id: "sess-1" }, onChunk, 0);
  expect(r.sessionId).toBe("sess-1");
  expect(r.done).toBeUndefined();
  expect(chunks).toHaveLength(0);
});

test("assistant event with multiple text content blocks concatenates into one assistant chunk", () => {
  const { chunks, onChunk } = collect();
  mapCursorEvent(
    {
      type: "assistant",
      session_id: "sess-1",
      message: {
        content: [
          { type: "text", text: "Hello, " },
          { type: "text", text: "world" },
          { type: "not-text", text: "should be ignored" },
        ],
      },
    },
    onChunk,
    3,
  );
  expect(chunks).toEqual([{ stream: "assistant", data: "Hello, world", lineUuid: "cursor:3" }]);
});

test("assistant event with no text blocks emits nothing", () => {
  const { chunks, onChunk } = collect();
  mapCursorEvent({ type: "assistant", message: { content: [] } }, onChunk, 1);
  expect(chunks).toHaveLength(0);
});

test("user event is skipped — no chunk — but still reports session id when present", () => {
  const { chunks, onChunk } = collect();
  const r = mapCursorEvent({ type: "user", session_id: "sess-1", message: { content: [{ type: "text", text: "hi" }] } }, onChunk, 2);
  expect(chunks).toHaveLength(0);
  expect(r.sessionId).toBe("sess-1");
});

test("tool_call started emits a tool_use chunk keyed tool_call:<call_id>:started", () => {
  const { chunks, onChunk } = collect();
  mapCursorEvent(
    { type: "tool_call", call_id: "call-7", subtype: "started", tool_call: { command: "ls -la" } },
    onChunk,
    4,
  );
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.stream).toBe("tool_use");
  expect(chunks[0]?.lineUuid).toBe("tool_call:call-7:started");
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({
    id: "call-7",
    name: "command",
    input: { command: "ls -la" },
    serverSide: false,
  });
});

test("tool_call completed emits a tool_result chunk keyed tool_call:<call_id>:completed, distinct from started", () => {
  const started = collect();
  mapCursorEvent({ type: "tool_call", call_id: "call-7", subtype: "started", tool_call: { command: "ls" } }, started.onChunk, 4);

  const completed = collect();
  mapCursorEvent(
    { type: "tool_call", call_id: "call-7", subtype: "completed", tool_call: { output: "file.txt" } },
    completed.onChunk,
    5,
  );
  expect(completed.chunks).toHaveLength(1);
  expect(completed.chunks[0]?.stream).toBe("tool_result");
  expect(completed.chunks[0]?.lineUuid).toBe("tool_call:call-7:completed");
  expect(JSON.parse(completed.chunks[0]!.data)).toMatchObject({
    toolUseId: "call-7",
    content: { output: "file.txt" },
    isError: false,
  });

  // Distinct keys so (run_id, line_uuid) doesn't drop one of the pair.
  expect(started.chunks[0]?.lineUuid).not.toBe(completed.chunks[0]?.lineUuid);
});

test("tool_call with a missing call_id falls back to a line-indexed key", () => {
  const { chunks, onChunk } = collect();
  mapCursorEvent({ type: "tool_call", subtype: "started", tool_call: { foo: "bar" } }, onChunk, 9);
  expect(chunks[0]?.lineUuid).toBe("tool_call:line9:started");
});

test("tool_call name prefers a string-valued name field over the first object key (Fix 3)", () => {
  const { chunks, onChunk } = collect();
  mapCursorEvent(
    { type: "tool_call", call_id: "call-9", subtype: "started", tool_call: { name: "shellToolCall", args: {} } },
    onChunk,
    7,
  );
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({ name: "shellToolCall" });
});

test("tool_call name falls back to the first object key when no name/tool/tool_name field is present", () => {
  const { chunks, onChunk } = collect();
  mapCursorEvent(
    { type: "tool_call", call_id: "call-10", subtype: "started", tool_call: { shellToolCall: { command: "ls" } } },
    onChunk,
    8,
  );
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({ name: "shellToolCall" });
});

test("tool_call with an unknown subtype still renders generically (forward-compat) rather than dropping it", () => {
  const { chunks, onChunk } = collect();
  mapCursorEvent({ type: "tool_call", call_id: "call-8", subtype: "queued", tool_call: { x: 1 } }, onChunk, 6);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.stream).toBe("tool_use");
  expect(chunks[0]?.lineUuid).toBe("tool_call:call-8:queued");
});

test("result success (is_error false) resolves done=0, and the result text becomes an assistant chunk when no assistant text preceded it", () => {
  const { chunks, onChunk } = collect();
  const r = mapCursorEvent({ type: "result", subtype: "success", is_error: false, result: "final answer" }, onChunk, 10);
  expect(r.done).toBe(0);
  expect(chunks).toEqual([{ stream: "assistant", data: "final answer", lineUuid: "cursor:10" }]);
});

test("result text is suppressed when assistant text already streamed in the same turn (Fix 1)", () => {
  // `mapCursorEvent` is a pure per-line mapper with no memory of its own, so
  // callers thread "did assistant text already stream this turn" in via the
  // `priorAssistantText` param (and read it back out via
  // `result.assistantTextEmitted`) the same way `lineIndex` is threaded.
  // An assistant chunk streams first, then a `result` event carrying the
  // SAME final answer — the result text must not surface a second time.
  const { chunks, onChunk } = collect();
  const r1 = mapCursorEvent(
    { type: "assistant", message: { content: [{ type: "text", text: "already narrated this" }] } },
    onChunk,
    10,
  );
  expect(r1.assistantTextEmitted).toBe(true);

  const r2 = mapCursorEvent(
    { type: "result", subtype: "success", is_error: false, result: "already narrated this" },
    onChunk,
    11,
    r1.assistantTextEmitted === true,
  );
  expect(r2.done).toBe(0);

  const assistantChunks = chunks.filter((c) => c.stream === "assistant");
  expect(assistantChunks).toHaveLength(1);
  expect(assistantChunks[0]?.data).toBe("already narrated this");
});

test("result with is_error true resolves done=1", () => {
  const { chunks, onChunk } = collect();
  // No `priorAssistantText` passed (defaults to false) — no assistant text
  // preceded this result in the turn, so it's still the sole source of the
  // final narration and must be emitted.
  const r = mapCursorEvent({ type: "result", subtype: "error", is_error: true, result: "it broke" }, onChunk, 12);
  expect(r.done).toBe(1);
  expect(chunks).toEqual([{ stream: "assistant", data: "it broke", lineUuid: "cursor:12" }]);
});

test("result with an empty/missing result string still resolves done without emitting a chunk", () => {
  const { chunks, onChunk } = collect();
  const r = mapCursorEvent({ type: "result", is_error: false, result: "" }, onChunk, 13);
  expect(r.done).toBe(0);
  expect(chunks).toHaveLength(0);
});

test("unknown top-level event type is silently ignored — no crash, no chunk, mirrors codex's default case", () => {
  const { chunks, onChunk } = collect();
  expect(() => mapCursorEvent({ type: "some_future_event", session_id: "sess-9", weird: { a: 1 } }, onChunk, 14)).not.toThrow();
  const r = mapCursorEvent({ type: "some_future_event", session_id: "sess-9" }, onChunk, 14);
  expect(r.sessionId).toBe("sess-9");
  expect(r.done).toBeUndefined();
  expect(chunks).toHaveLength(0);
});

test("event with no type field at all is treated as unknown and does not throw", () => {
  const { chunks, onChunk } = collect();
  expect(() => mapCursorEvent({}, onChunk, 0)).not.toThrow();
  expect(chunks).toHaveLength(0);
});

test("non-tool_call events get cursor:<lineIndex> line_uuids that are stable across a replay from index 0 (idempotent reattach)", () => {
  // Build a synthetic NDJSON-equivalent stream: one of each event kind that
  // produces a visible chunk, at fixed line indices.
  const events: Array<{ evt: Parameters<typeof mapCursorEvent>[0]; lineIndex: number }> = [
    { evt: { type: "system", subtype: "init", session_id: "sess-1" }, lineIndex: 0 },
    { evt: { type: "user", session_id: "sess-1" }, lineIndex: 1 },
    { evt: { type: "assistant", message: { content: [{ type: "text", text: "step one" }] } }, lineIndex: 2 },
    { evt: { type: "tool_call", call_id: "call-1", subtype: "started", tool_call: { cmd: "ls" } }, lineIndex: 3 },
    { evt: { type: "tool_call", call_id: "call-1", subtype: "completed", tool_call: { out: "ok" } }, lineIndex: 4 },
    { evt: { type: "assistant", message: { content: [{ type: "text", text: "step two" }] } }, lineIndex: 5 },
    { evt: { type: "result", is_error: false, result: "done" }, lineIndex: 6 },
  ];

  function runOnce(): (string | undefined)[] {
    const { chunks, onChunk } = collect();
    for (const { evt, lineIndex } of events) mapCursorEvent(evt, onChunk, lineIndex);
    return chunks.map((c) => c.lineUuid);
  }

  const first = runOnce();
  const second = runOnce(); // simulates reattach: same log re-read from offset 0
  expect(first.length).toBeGreaterThan(0);
  expect(second).toEqual(first);
  // Sanity: the non-tool_call chunks specifically use the cursor:<lineIndex> scheme.
  expect(first).toEqual([
    "cursor:2", // assistant "step one"
    "tool_call:call-1:started",
    "tool_call:call-1:completed",
    "cursor:5", // assistant "step two"
    "cursor:6", // result -> assistant "done"
  ]);
});

test("cursorLogPath(runId) is derivable from runId alone and lives under dataDir/cursor-logs/", () => {
  const p = cursorLogPath("run-abc");
  expect(p.endsWith(path.join("cursor-logs", "run-abc.jsonl"))).toBe(true);
});

// readCursorExitCode (Fix 2's pure exit-sidecar parser): the death-watch
// consults this to distinguish a clean process exit (hosting shell wrote
// `echo $? > <exitfile>` before the tmux session went away) from a genuine
// session death (nothing written, session just vanished). The exitfile path
// is derived the same way cursorLogPath's is — `<dataDir>/cursor-logs/<runId>.exit`
// — but that helper isn't exported (module-private), so tests write directly
// to the sibling path alongside the exported .jsonl path.
function cursorExitPathForTest(runId: string): string {
  return path.join(path.dirname(cursorLogPath(runId)), `${runId}.exit`);
}

test("readCursorExitCode returns null when no exitfile exists yet (turn still in flight)", () => {
  expect(readCursorExitCode("run-no-exitfile")).toBeNull();
});

test("readCursorExitCode parses a plain integer exit code written by `echo $? > <exitfile>`", () => {
  const dir = path.dirname(cursorLogPath("run-exit-0"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(cursorExitPathForTest("run-exit-0"), "0\n");
  expect(readCursorExitCode("run-exit-0")).toBe(0);

  writeFileSync(cursorExitPathForTest("run-exit-1"), "1\n");
  expect(readCursorExitCode("run-exit-1")).toBe(1);

  writeFileSync(cursorExitPathForTest("run-exit-137"), "137\n");
  expect(readCursorExitCode("run-exit-137")).toBe(137);
});

test("readCursorExitCode returns null for non-numeric or empty sidecar contents", () => {
  const dir = path.dirname(cursorLogPath("run-exit-garbage"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(cursorExitPathForTest("run-exit-garbage"), "not-a-number\n");
  expect(readCursorExitCode("run-exit-garbage")).toBeNull();

  writeFileSync(cursorExitPathForTest("run-exit-empty"), "");
  expect(readCursorExitCode("run-exit-empty")).toBeNull();
});

// Note on malformed-JSON-line handling (plan §5 TT2 point 9): that logic lives
// in the module-private `flushCursorLog`, which is only reachable through
// `spawnCursorViaTmux`/`reattachCursorSession` — both of which spawn a real
// tmux session, out of bounds for this file's "pure mapper/path tests only"
// contract (and codex-tmux.test.ts draws the same line — it doesn't exercise
// `flushCodexLog`'s JSON.parse failure path either). Per code review of
// cursor-tmux.ts:290-305, a line that fails `JSON.parse` is NOT thrown past —
// it's caught, surfaced as a `stderr` chunk containing the raw line text
// (lineUuid left undefined), `nextLineIndex` is still incremented, and the
// tailer continues to the next line.

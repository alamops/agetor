import { test, expect } from "bun:test";
import { homedir } from "node:os";
import {
  encodeProjectPath,
  isAgetorInterceptReply,
  jsonlPathFor,
  mapJsonlEventToChunks,
  sessionNameFor,
} from "./claude-tmux.ts";
import {
  ASK_QUESTIONS_REPLY_PREFIX,
  PLAN_APPROVED_REPLY_PREFIX,
  PLAN_REJECTED_REPLY_PREFIX,
} from "./interactions.ts";

test("jsonlPathFor with home=null falls back to the system homedir", () => {
  const p = jsonlPathFor("/a/b", "session-uuid", null);
  expect(p.startsWith(homedir())).toBe(true);
  expect(p.endsWith("/session-uuid.jsonl")).toBe(true);
  expect(p).toContain(encodeProjectPath("/a/b"));
});

test("jsonlPathFor honors a per-harness HOME override", () => {
  const p = jsonlPathFor("/a/b", "session-uuid", "/tmp/alt-home");
  expect(p).toBe(`/tmp/alt-home/.claude/projects/${encodeProjectPath("/a/b")}/session-uuid.jsonl`);
});

test("encodeProjectPath turns every slash and dot into a dash", () => {
  expect(encodeProjectPath("/Users/foo/bar")).toBe("-Users-foo-bar");
  expect(encodeProjectPath("/")).toBe("-");
  expect(encodeProjectPath("/a/b/c/d")).toBe("-a-b-c-d");
  // Dot segments (e.g. `.agetor`) collapse to double-dash where they meet
  // a separator — matches claude code's own directory naming under
  // ~/.claude/projects/. Without this, JSONL discovery looks at the wrong dir.
  expect(encodeProjectPath("/Users/foo/.agetor/worktrees/bar"))
    .toBe("-Users-foo--agetor-worktrees-bar");
  expect(encodeProjectPath("/x/y.z/q")).toBe("-x-y-z-q");
});

test("sessionNameFor uses the first 12 chars of the task id", () => {
  expect(sessionNameFor("abcdef0123456789-rest")).toBe("agetor-abcdef012345");
});

interface Record { stream: string; data: string }
function recorder(): {
  out: Record[];
  onChunk: (s: Record["stream"], d: string) => void;
} {
  const out: Record[] = [];
  return {
    out,
    onChunk: (stream, data) => out.push({ stream, data }),
  };
}

test("mapJsonlEventToChunks: assistant text block → `assistant` stream, no end-of-turn", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "hello world" }],
      stop_reason: "tool_use", // still going
    },
  });
  const res = mapJsonlEventToChunks(line, onChunk);
  expect(res.endOfTurn).toBe(false);
  expect(out).toEqual([{ stream: "assistant", data: "hello world" }]);
});

test("mapJsonlEventToChunks: thinking block emits on `thinking` stream verbatim (no prefix)", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "thinking", thinking: "let me consider…" }] },
  });
  mapJsonlEventToChunks(line, onChunk);
  expect(out[0]).toEqual({ stream: "thinking", data: "let me consider…" });
});

test("mapJsonlEventToChunks: redacted_thinking emits a placeholder so the user knows reasoning happened", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "redacted_thinking", data: "..." }] },
  });
  mapJsonlEventToChunks(line, onChunk);
  expect(out[0]).toEqual({ stream: "thinking", data: "[redacted thinking]" });
});

test("mapJsonlEventToChunks: tool_use block emits `tool_use` stream with JSON {id,name,input}", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [{
        type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la" },
      }],
    },
  });
  mapJsonlEventToChunks(line, onChunk);
  expect(out[0]!.stream).toBe("tool_use");
  const parsed = JSON.parse(out[0]!.data);
  expect(parsed).toMatchObject({ id: "toolu_1", name: "Bash", input: { command: "ls -la" } });
});

test("mapJsonlEventToChunks: server_tool_use rides the same stream with serverSide=true", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "server_tool_use", id: "srv_1", name: "web_search", input: { q: "x" } }] },
  });
  mapJsonlEventToChunks(line, onChunk);
  expect(out[0]!.stream).toBe("tool_use");
  expect(JSON.parse(out[0]!.data).serverSide).toBe(true);
});

test("mapJsonlEventToChunks: image content block surfaces as a placeholder so the UI shows something", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }] },
  });
  mapJsonlEventToChunks(line, onChunk);
  expect(out[0]).toEqual({ stream: "assistant", data: "[image]" });
});

test("mapJsonlEventToChunks: assistant with stop_reason=end_turn signals endOfTurn + status", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
  });
  const res = mapJsonlEventToChunks(line, onChunk);
  expect(res.endOfTurn).toBe(true);
  const status = out.find((r) => r.stream === "status");
  expect(status?.data).toBe("turn complete");
});

test("mapJsonlEventToChunks: user.content[].tool_result → `tool_result` stream with JSON payload", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok", is_error: false }] },
  });
  mapJsonlEventToChunks(line, onChunk);
  expect(out[0]!.stream).toBe("tool_result");
  const parsed = JSON.parse(out[0]!.data);
  expect(parsed).toMatchObject({ toolUseId: "toolu_1", content: "ok", isError: false });
});

test("mapJsonlEventToChunks: AskUserQuestion intercept reply overrides is_error → false", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "user",
    message: { content: [{
      type: "tool_result",
      tool_use_id: "toolu_2",
      content: `${ASK_QUESTIONS_REPLY_PREFIX} "Q1"="A1". You can now continue with the user's answers in mind.`,
      is_error: true,
    }] },
  });
  mapJsonlEventToChunks(line, onChunk);
  const parsed = JSON.parse(out[0]!.data);
  expect(parsed.isError).toBe(false);
});

test("mapJsonlEventToChunks: ExitPlanMode approval reply overrides is_error → false", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "user",
    message: { content: [{
      type: "tool_result",
      tool_use_id: "toolu_3",
      content: `${PLAN_APPROVED_REPLY_PREFIX} and wants you to implement it now.`,
      is_error: true,
    }] },
  });
  mapJsonlEventToChunks(line, onChunk);
  const parsed = JSON.parse(out[0]!.data);
  expect(parsed.isError).toBe(false);
});

test("mapJsonlEventToChunks: intercept reply in array-of-text-blocks shape also overrides is_error", () => {
  // Defensive: claude has historically emitted tool_result.content as both a
  // bare string and an array of `{type:"text", text:"…"}` blocks. The override
  // must work for the array form too, or a future claude release could
  // silently revert the rendering.
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "user",
    message: { content: [{
      type: "tool_result",
      tool_use_id: "toolu_5",
      content: [{
        type: "text",
        text: `${ASK_QUESTIONS_REPLY_PREFIX} "Q1"="A1". You can now continue with the user's answers in mind.`,
      }],
      is_error: true,
    }] },
  });
  mapJsonlEventToChunks(line, onChunk);
  const parsed = JSON.parse(out[0]!.data);
  expect(parsed.isError).toBe(false);
});

test("mapJsonlEventToChunks: real tool error (non-intercept content) preserves is_error → true", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "user",
    message: { content: [{
      type: "tool_result",
      tool_use_id: "toolu_4",
      content: "Error: command not found",
      is_error: true,
    }] },
  });
  mapJsonlEventToChunks(line, onChunk);
  const parsed = JSON.parse(out[0]!.data);
  expect(parsed.isError).toBe(true);
});

test("isAgetorInterceptReply: handles string content, array-of-text-blocks, and rejects non-matches", () => {
  expect(isAgetorInterceptReply(`${ASK_QUESTIONS_REPLY_PREFIX} ...`)).toBe(true);
  expect(isAgetorInterceptReply(`${PLAN_APPROVED_REPLY_PREFIX} ...`)).toBe(true);
  expect(isAgetorInterceptReply(`${PLAN_REJECTED_REPLY_PREFIX} ...`)).toBe(true);
  expect(isAgetorInterceptReply([{ type: "text", text: `${ASK_QUESTIONS_REPLY_PREFIX} x` }])).toBe(true);
  // Non-text blocks contribute nothing and don't trip the match.
  expect(isAgetorInterceptReply([{ type: "image", source: {} }])).toBe(false);
  expect(isAgetorInterceptReply("Error: command failed")).toBe(false);
  expect(isAgetorInterceptReply("")).toBe(false);
  expect(isAgetorInterceptReply(null)).toBe(false);
  expect(isAgetorInterceptReply(undefined)).toBe(false);
});

test("mapJsonlEventToChunks: user with string content emits a `user` stream event", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({ type: "user", message: { content: "hi" } });
  mapJsonlEventToChunks(line, onChunk);
  expect(out).toEqual([{ stream: "user", data: "hi" }]);
});

test("mapJsonlEventToChunks: user.content[].text → `user` stream (array-form prompt)", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "user",
    message: { content: [{ type: "text", text: "hello there" }] },
  });
  mapJsonlEventToChunks(line, onChunk);
  expect(out).toEqual([{ stream: "user", data: "hello there" }]);
});

test("mapJsonlEventToChunks: empty user string content stays silent", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({ type: "user", message: { content: "" } });
  mapJsonlEventToChunks(line, onChunk);
  expect(out).toEqual([]);
});

test("mapJsonlEventToChunks: invalid JSON surfaces a stderr chunk", () => {
  const { out, onChunk } = recorder();
  const res = mapJsonlEventToChunks("not json {", onChunk);
  expect(res.endOfTurn).toBe(false);
  expect(out[0]!.stream).toBe("stderr");
  expect(out[0]!.data).toContain("jsonl parse error");
});

test("mapJsonlEventToChunks: system permission-mode event surfaces as status", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({ type: "system", permissionMode: "auto" });
  mapJsonlEventToChunks(line, onChunk);
  expect(out[0]).toEqual({ stream: "status", data: "permission-mode: auto" });
});

test("mapJsonlEventToChunks: top-level permission-mode (claude variant) surfaces as status", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({ type: "permission-mode", permissionMode: "plan" });
  mapJsonlEventToChunks(line, onChunk);
  expect(out[0]).toEqual({ stream: "status", data: "permission-mode: plan" });
});

test("mapJsonlEventToChunks: summary checkpoints surface as a status breadcrumb", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({ type: "summary", summary: "Earlier turns compacted" });
  mapJsonlEventToChunks(line, onChunk);
  expect(out[0]).toEqual({ stream: "status", data: "summary: Earlier turns compacted" });
});

test("mapJsonlEventToChunks: unknown event types are no-ops", () => {
  const { out, onChunk } = recorder();
  mapJsonlEventToChunks(JSON.stringify({ type: "attachment", whatever: 1 }), onChunk);
  mapJsonlEventToChunks(JSON.stringify({ type: "ai-title", title: "x" }), onChunk);
  expect(out).toEqual([]);
});

test("mapJsonlEventToChunks: forwards the JSONL line uuid as the third onChunk arg", () => {
  // Reattach dedup depends on this — each chunk has to know which JSONL line
  // it came from so `run_events.line_uuid` can serve as the idempotency key.
  const seen: { stream: string; data: string; uuid?: string }[] = [];
  const onChunk = (s: string, d: string, uuid?: string) => seen.push({ stream: s, data: d, uuid });
  const line = JSON.stringify({
    type: "assistant",
    uuid: "line-uuid-123",
    message: { content: [{ type: "text", text: "hi" }] },
  });
  const res = mapJsonlEventToChunks(line, onChunk);
  expect(res.lineUuid).toBe("line-uuid-123");
  expect(seen[0]?.uuid).toBe("line-uuid-123");
});

test("mapJsonlEventToChunks: end-of-turn marker also carries the line uuid", () => {
  const seen: { stream: string; uuid?: string }[] = [];
  const onChunk = (s: string, _d: string, uuid?: string) => seen.push({ stream: s, uuid });
  const line = JSON.stringify({
    type: "assistant",
    uuid: "end-line",
    message: { stop_reason: "end_turn", content: [] },
  });
  const res = mapJsonlEventToChunks(line, onChunk);
  expect(res.endOfTurn).toBe(true);
  expect(seen.find((s) => s.stream === "status")?.uuid).toBe("end-line");
});

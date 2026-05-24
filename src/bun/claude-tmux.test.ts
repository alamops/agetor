import { test, expect } from "bun:test";
import { homedir } from "node:os";

// cycleToMode's tmux send-keys call runs `Bun.spawnSync` on the tmux
// binary; point it at /bin/echo so the per-press spawn is fast and the
// (irrelevant) exit code stays 0 instead of depending on whether real
// tmux is installed on the test host.
process.env.AGETOR_TMUX_BIN = "/bin/echo";

import {
  CLAUDE_MODE_ACCEPT_EDITS,
  CLAUDE_MODE_AUTO,
  CLAUDE_MODE_BYPASS,
  CLAUDE_MODE_DEFAULT,
  CLAUDE_MODE_PLAN,
  cycleDistance,
  cycleOrderFor,
  cycleToMode,
  encodeProjectPath,
  isAgetorInterceptReply,
  jsonlPathFor,
  mapJsonlEventToChunks,
  sessionNameFor,
  toClaudeModeString,
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

test("jsonlPathFor honors a per-harness CLAUDE_CONFIG_DIR override", () => {
  // claude treats CLAUDE_CONFIG_DIR as the `.claude/` equivalent, so the
  // override path itself is the root — no `.claude/` segment in between.
  const p = jsonlPathFor("/a/b", "session-uuid", "/tmp/alt-home");
  expect(p).toBe(`/tmp/alt-home/projects/${encodeProjectPath("/a/b")}/session-uuid.jsonl`);
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

test("mapJsonlEventToChunks: task-notification user message → `status` breadcrumb, not a user bubble", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "user",
    origin: { kind: "task-notification" },
    message: {
      content:
        "<task-notification>\n<task-id>b21qu207r</task-id>\n<status>completed</status>\n<summary>Background command \"Find bun executable\" completed (exit code 0)</summary>\n</task-notification>",
    },
  });
  mapJsonlEventToChunks(line, onChunk);
  expect(out).toEqual([
    { stream: "status", data: 'background task: Background command "Find bun executable" completed (exit code 0)' },
  ]);
});

test("mapJsonlEventToChunks: task-notification without a summary still emits a generic status", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "user",
    origin: { kind: "task-notification" },
    message: { content: "<task-notification><status>completed</status></task-notification>" },
  });
  mapJsonlEventToChunks(line, onChunk);
  expect(out).toEqual([{ stream: "status", data: "background task completed" }]);
});

test("mapJsonlEventToChunks: malformed-tool-call retry (isMeta) → status breadcrumb, not a user bubble", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "user",
    isMeta: true,
    message: { content: "Your tool call was malformed and could not be parsed. Please retry." },
  });
  mapJsonlEventToChunks(line, onChunk);
  expect(out).toEqual([
    { stream: "status", data: "Your tool call was malformed and could not be parsed. Please retry." },
  ]);
});

test("mapJsonlEventToChunks: large multi-line isMeta blob is truncated to one capped line", () => {
  const { out, onChunk } = recorder();
  const longFirstLine = "x".repeat(200);
  const line = JSON.stringify({
    type: "user",
    isMeta: true,
    message: { content: [{ type: "text", text: `${longFirstLine}\nsecond line\nthird line` }] },
  });
  mapJsonlEventToChunks(line, onChunk);
  expect(out.length).toBe(1);
  expect(out[0]!.stream).toBe("status");
  expect(out[0]!.data).toBe("x".repeat(137) + "…");
});

test("mapJsonlEventToChunks: isMeta breadcrumb strips a leading wrapper tag", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "user",
    isMeta: true,
    message: { content: "<local-command-caveat>Caveat: generated while running local commands.</local-command-caveat>" },
  });
  mapJsonlEventToChunks(line, onChunk);
  expect(out).toEqual([
    { stream: "status", data: "Caveat: generated while running local commands.</local-command-caveat>" },
  ]);
});

test("mapJsonlEventToChunks: isMeta entry with only non-text blocks falls back to a generic label", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "user",
    isMeta: true,
    message: { content: [{ type: "image", source: {} }] },
  });
  mapJsonlEventToChunks(line, onChunk);
  expect(out).toEqual([{ stream: "status", data: "synthetic message" }]);
});

test("mapJsonlEventToChunks: empty isMeta content stays silent", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({ type: "user", isMeta: true, message: { content: "" } });
  mapJsonlEventToChunks(line, onChunk);
  expect(out).toEqual([]);
});

test("mapJsonlEventToChunks: genuine human turn (no isMeta) still emits a user bubble", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({ type: "user", message: { content: "ship the fix please" } });
  mapJsonlEventToChunks(line, onChunk);
  expect(out).toEqual([{ stream: "user", data: "ship the fix please" }]);
});

test("mapJsonlEventToChunks: tool_result user entry (no isMeta) still emits tool_result, not a breadcrumb", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok", is_error: false }] },
  });
  mapJsonlEventToChunks(line, onChunk);
  expect(out.length).toBe(1);
  expect(out[0]!.stream).toBe("tool_result");
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

test("toClaudeModeString translates agetor shorthand to canonical claude strings", () => {
  expect(toClaudeModeString("bypass")).toBe(CLAUDE_MODE_BYPASS);
  expect(toClaudeModeString("ask")).toBe(CLAUDE_MODE_DEFAULT);
  // Already canonical / unknown — pass through verbatim.
  expect(toClaudeModeString("auto")).toBe(CLAUDE_MODE_AUTO);
  expect(toClaudeModeString("acceptEdits")).toBe(CLAUDE_MODE_ACCEPT_EDITS);
  expect(toClaudeModeString("plan")).toBe(CLAUDE_MODE_PLAN);
  expect(toClaudeModeString("dontAsk")).toBe("dontAsk");
});

test("cycleOrderFor: base 3 modes always present; bypass only when enabled; auto always at the end", () => {
  expect(cycleOrderFor(false)).toEqual([
    CLAUDE_MODE_DEFAULT,
    CLAUDE_MODE_ACCEPT_EDITS,
    CLAUDE_MODE_PLAN,
    CLAUDE_MODE_AUTO,
  ]);
  expect(cycleOrderFor(true)).toEqual([
    CLAUDE_MODE_DEFAULT,
    CLAUDE_MODE_ACCEPT_EDITS,
    CLAUDE_MODE_PLAN,
    CLAUDE_MODE_BYPASS,
    CLAUDE_MODE_AUTO,
  ]);
});

test("cycleDistance returns press count via forward cycle", () => {
  const cycle = cycleOrderFor(false); // default, acceptEdits, plan, auto
  expect(cycleDistance(cycle, CLAUDE_MODE_DEFAULT, CLAUDE_MODE_ACCEPT_EDITS)).toBe(1);
  expect(cycleDistance(cycle, CLAUDE_MODE_DEFAULT, CLAUDE_MODE_PLAN)).toBe(2);
  expect(cycleDistance(cycle, CLAUDE_MODE_DEFAULT, CLAUDE_MODE_AUTO)).toBe(3);
  // wrap-around: from auto to default is one press, not three back.
  expect(cycleDistance(cycle, CLAUDE_MODE_AUTO, CLAUDE_MODE_DEFAULT)).toBe(1);
  // same mode → 0 presses (caller can skip).
  expect(cycleDistance(cycle, CLAUDE_MODE_PLAN, CLAUDE_MODE_PLAN)).toBe(0);
});

test("cycleDistance returns null when target isn't in the cycle (e.g. bypass without launch flag)", () => {
  const cycle = cycleOrderFor(false); // bypass NOT included
  expect(cycleDistance(cycle, CLAUDE_MODE_DEFAULT, CLAUDE_MODE_BYPASS)).toBeNull();
  // Same for an unrecognized mode.
  expect(cycleDistance(cycle, CLAUDE_MODE_DEFAULT, "dontAsk")).toBeNull();
});

test("cycleDistance with bypass enabled: order goes plan → bypass → auto", () => {
  const cycle = cycleOrderFor(true);
  // From bypass: one press lands on auto, two presses on default.
  expect(cycleDistance(cycle, CLAUDE_MODE_BYPASS, CLAUDE_MODE_AUTO)).toBe(1);
  expect(cycleDistance(cycle, CLAUDE_MODE_BYPASS, CLAUDE_MODE_DEFAULT)).toBe(2);
  // plan → bypass is exactly one press (the new neighbour).
  expect(cycleDistance(cycle, CLAUDE_MODE_PLAN, CLAUDE_MODE_BYPASS)).toBe(1);
});

test("system event updates state.permissionMode (dispatchLine path)", async () => {
  // Use the test harness for SessionState since the watcher path needs a
  // real fs but we only care that dispatchLine routes the permissionMode
  // off `system` events into SessionState.
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-mode-track";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");
  expect(state.permissionMode).toBeNull();
  __forTest.dispatchLine(
    state,
    JSON.stringify({ type: "system", permissionMode: "acceptEdits" }),
  );
  expect(state.permissionMode).toBe("acceptEdits");
  // Subsequent permission-mode events overwrite.
  __forTest.dispatchLine(
    state,
    JSON.stringify({ type: "permission-mode", permissionMode: "auto" }),
  );
  expect(state.permissionMode).toBe("auto");
  __forTest.uninstallSession(taskId);
});

test("dispatchLine: permissionMode still updates when the event's uuid is already in seenLineUuids (reattach path)", async () => {
  // On reattach, seenLineUuids is pre-seeded from run_events.line_uuid so
  // the user-facing chunk replay stays idempotent. The permissionMode
  // tracking has to run BEFORE that dedup check — otherwise the field
  // would stay null until claude emitted a fresh mode event, and the
  // first cycleToMode call after every restart would skip with
  // "current mode unknown".
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-mode-track-dedup";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");
  state.seenLineUuids.add("system-event-uuid-1");
  __forTest.dispatchLine(state, JSON.stringify({
    type: "system",
    uuid: "system-event-uuid-1",
    permissionMode: "bypassPermissions",
  }));
  expect(state.permissionMode).toBe("bypassPermissions");
  __forTest.uninstallSession(taskId);
});

test("resumeJsonlOffset: returns EOF for an existing JSONL so the tailer skips historical content", async () => {
  // Pins the resume fix: when claude --resume reopens an existing JSONL,
  // the tailer must NOT re-dispatch historical end_turn markers, or the
  // freshly-pushed turn slot for the new prompt would pop on a stale
  // event and flip the new run to `succeeded` before claude has even
  // processed the prompt. The fix is to anchor state.offset at the file
  // size at spawn time; this test verifies the helper that produces it.
  const { mkdtempSync, writeFileSync, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { __forTest } = await import("./claude-tmux.ts");

  const dir = mkdtempSync(path.join(tmpdir(), "agetor-resume-offset-"));
  const jsonlPath = path.join(dir, "session.jsonl");
  const historical = [
    JSON.stringify({ type: "system", uuid: "u1", permissionMode: "default" }),
    JSON.stringify({ type: "user", uuid: "u2", message: { role: "user", content: "hi" } }),
    JSON.stringify({ type: "assistant", uuid: "u3", message: { role: "assistant", content: [], stop_reason: "end_turn" } }),
  ].join("\n") + "\n";
  writeFileSync(jsonlPath, historical);
  const fileSize = statSync(jsonlPath).size;

  // Offset must point at EOF so the tailer skips the historical end_turn
  // marker on u3 — that was the source of the spurious `succeeded` flip.
  expect(__forTest.resumeJsonlOffset(jsonlPath)).toBe(fileSize);
});

test("resumeJsonlOffset: returns 0 for a missing JSONL so a fresh spawn behaves like a cold start", async () => {
  // Fresh-spawn path: the JSONL doesn't exist yet (claude creates it on
  // boot), so the helper must return 0 — the tailer then reads from the
  // very beginning when claude writes its first events.
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { __forTest } = await import("./claude-tmux.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-resume-missing-"));
  expect(__forTest.resumeJsonlOffset(path.join(dir, "session.jsonl"))).toBe(0);
});

test("cycleToMode: noop when already at target", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-cycle-noop";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");
  state.permissionMode = CLAUDE_MODE_ACCEPT_EDITS;
  const result = await cycleToMode(taskId, "acceptEdits");
  expect(result).toEqual({ ok: true, presses: 0, via: "noop" });
  __forTest.uninstallSession(taskId);
});

test("cycleToMode: returns 'current mode unknown' before claude's first event", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-cycle-unknown";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");
  expect(state.permissionMode).toBeNull();
  const result = await cycleToMode(taskId, "auto");
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("current mode unknown");
  __forTest.uninstallSession(taskId);
});

test("cycleToMode: success on first attempt when the JSONL event reports the target", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-cycle-success";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");
  state.permissionMode = CLAUDE_MODE_DEFAULT;
  // cycleToMode installs the listener synchronously inside the Promise
  // executor before tmux send-keys runs, so a synchronous dispatchLine
  // call after invoking it (but before the await) fires the listener and
  // resolves the verification.
  const pending = cycleToMode(taskId, "auto");
  __forTest.dispatchLine(state, JSON.stringify({
    type: "permission-mode",
    permissionMode: CLAUDE_MODE_AUTO,
  }));
  const result = await pending;
  // Cycle: [default, acceptEdits, plan, auto] — 3 presses.
  expect(result).toEqual({ ok: true, presses: 3, via: "shift-tab" });
  __forTest.uninstallSession(taskId);
});

test("cycleToMode: retries from the newly-observed mode when the first press lands short", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-cycle-retry";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");
  state.permissionMode = CLAUDE_MODE_DEFAULT;
  // First attempt: dispatch a "wrong" mode (acceptEdits) so cycleToMode
  // observes the mismatch and retries. Second attempt: dispatch the target.
  const pending = cycleToMode(taskId, "auto");
  __forTest.dispatchLine(state, JSON.stringify({
    type: "permission-mode",
    permissionMode: CLAUDE_MODE_ACCEPT_EDITS,
  }));
  // Yield once so cycleToMode's await-continuation can install the next
  // listener before we fire the next synthetic event.
  await Promise.resolve();
  __forTest.dispatchLine(state, JSON.stringify({
    type: "permission-mode",
    permissionMode: CLAUDE_MODE_AUTO,
  }));
  const result = await pending;
  // Attempt 1: default → auto = 3 presses (lands on acceptEdits instead).
  // Attempt 2: acceptEdits → auto = 2 presses. Total: 5.
  expect(result).toEqual({ ok: true, presses: 5, via: "shift-tab" });
  __forTest.uninstallSession(taskId);
});

test("cycleToMode: returns 'verification timed out' when no JSONL event follows", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const prevTimeout = __forTest.setModeVerifyTimeoutMs(20);
  try {
    const taskId = "task-cycle-timeout";
    const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");
    state.permissionMode = CLAUDE_MODE_DEFAULT;
    const result = await cycleToMode(taskId, "auto");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("verification timed out");
      expect(result.attempts).toBe(1);
      // lastObserved should still be the pre-press mode because the JSONL
      // event never arrived to update it.
      expect(result.lastObserved).toBe(CLAUDE_MODE_DEFAULT);
    }
    // Listener slot must be cleared after the timeout so a late event
    // can't fire on a stale resolver.
    expect(state.onPermissionMode).toBeNull();
    __forTest.uninstallSession(taskId);
  } finally {
    __forTest.setModeVerifyTimeoutMs(prevTimeout);
  }
});

test("cycleToMode: gives up with 'verification mismatch' after MAX_VERIFY_ATTEMPTS wrong modes", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-cycle-mismatch";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");
  state.permissionMode = CLAUDE_MODE_DEFAULT;
  const pending = cycleToMode(taskId, "auto");
  // Three wrong modes back to back — exhausts MAX_VERIFY_ATTEMPTS.
  __forTest.dispatchLine(state, JSON.stringify({
    type: "permission-mode",
    permissionMode: CLAUDE_MODE_ACCEPT_EDITS,
  }));
  // Yield once so cycleToMode's await-continuation can install the next
  // listener before we fire the next synthetic event.
  await Promise.resolve();
  __forTest.dispatchLine(state, JSON.stringify({
    type: "permission-mode",
    permissionMode: CLAUDE_MODE_PLAN,
  }));
  // Yield once so cycleToMode's await-continuation can install the next
  // listener before we fire the next synthetic event.
  await Promise.resolve();
  __forTest.dispatchLine(state, JSON.stringify({
    type: "permission-mode",
    permissionMode: CLAUDE_MODE_DEFAULT,
  }));
  const result = await pending;
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("verification mismatch");
    expect(result.attempts).toBe(__forTest.MAX_VERIFY_ATTEMPTS);
    expect(result.lastObserved).toBe(CLAUDE_MODE_DEFAULT);
  }
  __forTest.uninstallSession(taskId);
});

test("cycleToMode: /plan target bypasses the verify loop entirely", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-cycle-plan";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");
  state.permissionMode = CLAUDE_MODE_DEFAULT;
  // No dispatched event — /plan returns immediately without waiting.
  const result = await cycleToMode(taskId, "plan");
  expect(result).toEqual({ ok: true, presses: 0, via: "slash-plan" });
  expect(state.onPermissionMode).toBeNull();
  __forTest.uninstallSession(taskId);
});

test("cycleToMode: overlapping calls don't clobber each other's listeners", async () => {
  // Identity-guard regression test: without the `state.onPermissionMode
  // === myListener` check in the timeout handler, the earlier call's
  // setTimeout would null out the *later* call's listener, causing both
  // calls to falsely time out. With the guard, the later caller wins
  // (its listener fires on the next JSONL event) and the earlier caller
  // gracefully times out without affecting the later one.
  const { __forTest } = await import("./claude-tmux.ts");
  const prevTimeout = __forTest.setModeVerifyTimeoutMs(40);
  try {
    const taskId = "task-cycle-race";
    const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");
    state.permissionMode = CLAUDE_MODE_DEFAULT;

    // Two overlapping calls. `b` is launched synchronously after `a`,
    // so by the time the dispatch fires the session slot holds b's
    // listener. b should win; a should fall through to timeout.
    const a = cycleToMode(taskId, "auto");
    const b = cycleToMode(taskId, "acceptEdits");
    __forTest.dispatchLine(state, JSON.stringify({
      type: "permission-mode",
      permissionMode: CLAUDE_MODE_ACCEPT_EDITS,
    }));
    const [ra, rb] = await Promise.all([a, b]);

    expect(rb).toEqual({ ok: true, presses: 1, via: "shift-tab" });
    expect(ra.ok).toBe(false);
    if (!ra.ok) expect(ra.reason).toBe("verification timed out");
    __forTest.uninstallSession(taskId);
  } finally {
    __forTest.setModeVerifyTimeoutMs(prevTimeout);
  }
});

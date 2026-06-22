import { test, expect } from "bun:test";
import { homedir } from "node:os";

// cycleToMode's tmux send-keys call runs `Bun.spawnSync` on the tmux
// binary; point it at /bin/echo so the per-press spawn is fast and the
// (irrelevant) exit code stays 0 instead of depending on whether real
// tmux is installed on the test host.
process.env.AGETOR_TMUX_BIN = "/bin/echo";

import {
  CLAUDE_API_ERROR_STATUS_PREFIX,
  CLAUDE_MODE_ACCEPT_EDITS,
  CLAUDE_MODE_AUTO,
  CLAUDE_MODE_BYPASS,
  CLAUDE_MODE_DEFAULT,
  CLAUDE_MODE_PLAN,
  cycleDistance,
  cycleOrderFor,
  cycleToMode,
  encodeProjectPath,
  jsonlPathFor,
  mapJsonlEventToChunks,
  rebuildEventsFromJsonl,
  sessionNameFor,
  toClaudeModeString,
} from "./claude-tmux.ts";

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

test("mapJsonlEventToChunks: assistant with stop_reason=end_turn signals endOfTurn (no banner — banner is emitted by dispatchLine on confirmation)", () => {
  // mapJsonlEventToChunks now returns endOfTurn:true as a STAGING signal, not
  // a fire signal. The "turn complete" banner is emitted by firePendingEndTurn
  // in dispatchLine once the next line confirms the turn is really over. This
  // prevents spurious banners when claude stamps end_turn on every split line
  // of a response (thinking, text, tool_use) including mid-flight ones.
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
  });
  const res = mapJsonlEventToChunks(line, onChunk);
  expect(res.endOfTurn).toBe(true);
  // Text chunk emitted normally.
  expect(out.some((r) => r.stream === "assistant" && r.data === "done")).toBe(true);
  // Banner NOT emitted here — dispatchLine emits it when confirmed.
  expect(out.some((r) => r.stream === "status" && r.data === "turn complete")).toBe(false);
});

test("mapJsonlEventToChunks: stop_reason=end_turn with a tool_use block returns endOfTurn:true (staging signal) but no banner", () => {
  // All end_turn lines — regardless of content type — return endOfTurn:true as
  // a staging signal for dispatchLine. The "turn complete" banner is NOT emitted
  // here; dispatchLine suppresses it until the next line confirms the turn is
  // over (i.e., is not a same-message continuation or a tool_result). The
  // tool_use chunk itself is still streamed normally.
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }],
      stop_reason: "end_turn",
    },
  });
  const res = mapJsonlEventToChunks(line, onChunk);
  expect(res.endOfTurn).toBe(true);
  // tool_use chunk still emitted — it carries real work.
  expect(out.some((r) => r.stream === "tool_use")).toBe(true);
  // Banner NOT emitted; dispatchLine emits it when confirmed.
  expect(out.some((r) => r.stream === "status" && r.data === "turn complete")).toBe(false);
});

test("mapJsonlEventToChunks: stop_reason=end_turn with text+tool_use still returns endOfTurn:true (staging) with no banner", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "let me check that" },
        { type: "tool_use", id: "t2", name: "Read", input: {} },
      ],
      stop_reason: "end_turn",
    },
  });
  const res = mapJsonlEventToChunks(line, onChunk);
  expect(res.endOfTurn).toBe(true);
  expect(out.some((r) => r.stream === "assistant" && r.data === "let me check that")).toBe(true);
  expect(out.some((r) => r.stream === "status" && r.data === "turn complete")).toBe(false);
});

test("mapJsonlEventToChunks: synthetic isApiErrorMessage line emits an api-error status and signals endOfTurn so the run resolves", () => {
  // Without this branch the run would sit in `running` forever — claude
  // stamps stop_reason: "stop_sequence" (not end_turn) on API-error
  // messages, so the regular end_turn detection misses them. The
  // orchestrator's chunk handler pattern-matches on the api-error status
  // prefix to flip the task to the `blocked` column.
  //
  // Uses a uuid-aware recorder (the shared `recorder()` drops the third
  // arg) because this test specifically asserts that the status chunk is
  // emitted with `uuid: undefined` so the partial unique index on
  // `(run_id, line_uuid)` doesn't drop the row.
  const out: { stream: string; data: string; uuid: string | undefined }[] = [];
  const onChunk = (stream: Record["stream"], data: string, uuid?: string) => out.push({ stream, data, uuid });
  const line = JSON.stringify({
    type: "assistant",
    uuid: "err-1",
    isApiErrorMessage: true,
    apiErrorStatus: 529,
    message: {
      stop_reason: "stop_sequence",
      content: [{ type: "text", text: "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment." }],
    },
  });
  const res = mapJsonlEventToChunks(line, onChunk);
  expect(res.endOfTurn).toBe(true);
  // The user-facing error text still rides the regular assistant stream
  // with the JSONL line uuid (so it dedups on reattach).
  const assistantRow = out.find((r) => r.stream === "assistant" && r.data.startsWith("API Error: 529"));
  expect(assistantRow).toBeDefined();
  expect(assistantRow!.uuid).toBe("err-1");
  // Sentinel status chunk the orchestrator pattern-matches on. Must start
  // with the full prefix (trailing space/colon rules out a hypothetical
  // future status that begins with the word "api").
  const status = out.find((r) => r.stream === "status" && r.data.startsWith(CLAUDE_API_ERROR_STATUS_PREFIX));
  expect(status).toBeDefined();
  expect(status!.data).toContain("HTTP 529");
  // Critically: emitted with uuid:undefined. If we reused the assistant
  // line's uuid the partial unique index would silently drop this row via
  // INSERT OR IGNORE and the breadcrumb would vanish on panel reload.
  expect(status!.uuid).toBeUndefined();
});

test("mapJsonlEventToChunks: isApiErrorMessage without apiErrorStatus still emits a sentinel status (HTTP suffix omitted)", () => {
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "assistant",
    uuid: "err-2",
    isApiErrorMessage: true,
    message: {
      stop_reason: "stop_sequence",
      content: [{ type: "text", text: "API Error: connection reset" }],
    },
  });
  const res = mapJsonlEventToChunks(line, onChunk);
  expect(res.endOfTurn).toBe(true);
  const status = out.find((r) => r.stream === "status" && r.data.startsWith(CLAUDE_API_ERROR_STATUS_PREFIX));
  expect(status).toBeDefined();
  expect(status!.data).not.toContain("HTTP");
});

test("mapJsonlEventToChunks: system{subtype:turn_duration} emits the duration as a status breadcrumb", () => {
  // Claude 2.1.x writes a `system{subtype:"turn_duration"}` line right
  // after the assistant end_turn. The end_turn itself already produced
  // "turn complete"; this just adds the duration so the user sees at a
  // glance whether the turn was quick or long.
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "system",
    subtype: "turn_duration",
    durationMs: 52647,
    uuid: "9e139a67-4473-4578-bae0-9ce18c651c76",
  });
  const res = mapJsonlEventToChunks(line, onChunk);
  expect(res.endOfTurn).toBe(false);
  expect(out).toEqual([{ stream: "status", data: "turn duration: 53s" }]);
});

test("mapJsonlEventToChunks: system{subtype:away_summary} stays silent (resumption context, not user-relevant)", () => {
  // away_summary is claude's own recap of what just happened, written for
  // its future-self on resume. Surfacing it as a breadcrumb would just
  // duplicate the assistant text the user already read.
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "system",
    subtype: "away_summary",
    content: "Goal was building the X feature; finished applying review fixes.",
    uuid: "f85ee077-f89c-494e-9c50-951d29c76ddd",
  });
  mapJsonlEventToChunks(line, onChunk);
  expect(out).toEqual([]);
});

test("mapJsonlEventToChunks: queue-operation enqueue with a task-notification payload becomes a background-task breadcrumb", () => {
  // Claude 2.1.x delivers background-task completion notifications via
  // `queue-operation` events; older versions delivered the same content
  // as synthetic `user` entries with `origin.kind: "task-notification"`.
  // The user-facing breadcrumb is the same — extract the `<summary>` and
  // prefix with `background task:`.
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "queue-operation",
    operation: "enqueue",
    content: "<task-notification>\n<task-id>bt7k1k0qf</task-id>\n<summary>Background command \"Wait for dev server ready\" completed (exit code 0)</summary>\n</task-notification>",
  });
  mapJsonlEventToChunks(line, onChunk);
  expect(out).toEqual([{
    stream: "status",
    data: `background task: Background command "Wait for dev server ready" completed (exit code 0)`,
  }]);
});

test("mapJsonlEventToChunks: queue-operation remove stays silent (just the dequeue half of an enqueue/remove pair)", () => {
  // The `remove` half is claude popping the notification off its input
  // queue once it's been processed — it carries no content the user
  // hasn't already seen from the matching `enqueue`.
  const { out, onChunk } = recorder();
  const line = JSON.stringify({ type: "queue-operation", operation: "remove" });
  mapJsonlEventToChunks(line, onChunk);
  expect(out).toEqual([]);
});

test("mapJsonlEventToChunks: queue-operation enqueue with a task-notification but no <summary> emits a generic 'completed' breadcrumb", () => {
  // Mirrors the existing user/origin.kind handler's fallback so both
  // delivery paths (synthetic user entry vs. queue-operation) produce
  // the same UX for the same logical event. Without this, a 2.1.x
  // task-notification payload missing its `<summary>` would go dark in
  // the run panel even though something measurable completed.
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "queue-operation",
    operation: "enqueue",
    content: "<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>",
  });
  mapJsonlEventToChunks(line, onChunk);
  expect(out).toEqual([{ stream: "status", data: "background task completed" }]);
});

test("mapJsonlEventToChunks: queue-operation enqueue of an unrecognised payload type stays silent (no raw XML in the panel)", () => {
  // Non-task-notification enqueues (future event kinds claude might
  // queue) shouldn't dump arbitrary content into the user's run panel.
  // The task-notification prefix check is the only allow-listed
  // generic fallback.
  const { out, onChunk } = recorder();
  const line = JSON.stringify({
    type: "queue-operation",
    operation: "enqueue",
    content: "<some-future-payload>opaque content</some-future-payload>",
  });
  mapJsonlEventToChunks(line, onChunk);
  expect(out).toEqual([]);
});

test("formatTurnDuration: rolls 59999ms over to '1m' rather than printing '60s'", async () => {
  // Round-then-branch boundary check. With a naive `(ms/1000).toFixed(0)`
  // inside the `< 60_000` branch, 59999ms would render as "60s" — visually
  // jarring next to a turn that's clearly already a minute. The roll-over
  // matters for any duration that lands within 500ms of a minute boundary.
  const { mapJsonlEventToChunks } = await import("./claude-tmux.ts");
  const cases: Array<{ ms: number; expected: string }> = [
    { ms: 250, expected: "250ms" },
    { ms: 1500, expected: "1.5s" },
    { ms: 9999, expected: "10.0s" },
    { ms: 52647, expected: "53s" },
    { ms: 59_499, expected: "59s" },
    { ms: 59_999, expected: "1m" },
    { ms: 60_000, expected: "1m" },
    { ms: 90_500, expected: "1m 31s" },
    { ms: 3_600_000, expected: "60m" },
  ];
  for (const { ms, expected } of cases) {
    const out: { stream: string; data: string }[] = [];
    mapJsonlEventToChunks(
      JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: ms, uuid: `dur-${ms}` }),
      (stream, data) => out.push({ stream, data }),
    );
    expect(out[0]?.data).toBe(`turn duration: ${expected}`);
  }
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

test("mapJsonlEventToChunks: CR/LF in user content is normalized to \\n (tmux paste-buffer delivers \\n as \\r, dedup keys on bytes)", () => {
  // String-form: claude transcribes the pasted prompt verbatim, including
  // the `\r` characters tmux substituted for our `\n`s. Without normalization
  // the JSONL emit's data differs byte-for-byte from the live `sendInput`
  // emit (which has the original `\n`s), breaking the run panel's dedup.
  const s = recorder();
  mapJsonlEventToChunks(
    JSON.stringify({ type: "user", message: { content: "line one\r\rline two\r\nline three" } }),
    s.onChunk,
  );
  expect(s.out).toEqual([{ stream: "user", data: "line one\n\nline two\nline three" }]);

  // Array-form: same normalization applies to every text block.
  const a = recorder();
  mapJsonlEventToChunks(
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "para one\r\rpara two" }] },
    }),
    a.onChunk,
  );
  expect(a.out).toEqual([{ stream: "user", data: "para one\n\npara two" }]);
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

test("mapJsonlEventToChunks: end-of-turn marker carries the line uuid on the return value", () => {
  // The banner no longer comes from mapJsonlEventToChunks (it's emitted by
  // dispatchLine's firePendingEndTurn when the turn is confirmed). The uuid is
  // still accessible via res.lineUuid for the caller to stage correctly.
  const seen: { stream: string; uuid?: string }[] = [];
  const onChunk = (s: string, _d: string, uuid?: string) => seen.push({ stream: s, uuid });
  const line = JSON.stringify({
    type: "assistant",
    uuid: "end-line",
    message: { stop_reason: "end_turn", content: [] },
  });
  const res = mapJsonlEventToChunks(line, onChunk);
  expect(res.endOfTurn).toBe(true);
  expect(res.lineUuid).toBe("end-line");
  // No "status" chunk from this function — the banner is emitted later by dispatchLine.
  expect(seen.find((s) => s.stream === "status")).toBeUndefined();
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

test("dispatchLine: already-seen end_turn still fires onEndOfTurn (reattach + crashed-before-status-update path)", async () => {
  // Reattach scenario where agetor died in the narrow window between persisting
  // the end_turn to `run_events` and updating the run row to `succeeded`. On
  // restart seenLineUuids is pre-seeded, so the replayed end_turn hits the
  // dedup path. It must STILL drive popEndOfTurn (via staging + firing on the
  // next non-continuation line) so the run row transitions. Without this the
  // run stays `running` (badge stuck "in progress") forever.
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-end-turn-dedup-reattach";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");

  let endOfTurnFired = false;
  state.onEndOfTurn = () => { endOfTurnFired = true; };
  state.seenLineUuids.add("end-turn-uuid-1");

  const emitted: { stream: string; data: string }[] = [];
  state.lastChunk = (stream, data) => emitted.push({ stream, data });

  __forTest.dispatchLine(state, JSON.stringify({
    type: "assistant",
    uuid: "end-turn-uuid-1",
    message: { id: "msg-R", role: "assistant", content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
  }));

  // Staged, not yet fired — needs a confirming next line.
  expect(endOfTurnFired).toBe(false);
  expect(state.pendingEndTurn?.messageId).toBe("msg-R");

  // Non-continuation line fires it.  emitBanner:false so no "turn complete" emitted.
  __forTest.dispatchLine(state, JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 1000 }));
  expect(endOfTurnFired).toBe(true);
  // Prior process already emitted "turn complete" — no duplicate.
  expect(emitted.some((e) => e.data === "turn complete")).toBe(false);
  __forTest.uninstallSession(taskId);
});

test("dispatchLine: end_turn staging — tool_use line stages but tool_result cancels, slot never popped", async () => {
  // The core of the fix: claude stamps end_turn on a tool_use split line.
  // dispatchLine STAGES the pending end_turn (doesn't pop the slot yet).
  // When the tool_result arrives on the next dispatchLine call, isEndTurnContinuation
  // returns true → the pending is cancelled. The slot stays alive — the turn isn't over.
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-staging-tooluse-cancel";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");

  const recorded: { stream: string; data: string }[] = [];
  void __forTest.pushTurnSlot(state, (stream, data) => recorded.push({ stream, data }));

  // The buggy end_turn+tool_use line — should stage, not fire.
  __forTest.dispatchLine(state, JSON.stringify({
    type: "assistant",
    uuid: "et-tu",
    message: { id: "msg-abc", role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      stop_reason: "end_turn" },
  }));
  expect(state.pendingEndTurn?.messageId).toBe("msg-abc");
  expect(state.turnQueue.length).toBe(1); // not popped yet

  // tool_result arrives → continuation → cancel the pending
  __forTest.dispatchLine(state, JSON.stringify({
    type: "user",
    uuid: "tr-1",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  }));
  expect(state.pendingEndTurn).toBeNull();
  expect(state.turnQueue.length).toBe(1); // still alive
  expect(recorded.some((r) => r.stream === "status" && r.data === "turn complete")).toBe(false);
  __forTest.uninstallSession(taskId);
});

test("dispatchLine: a user-INTERRUPT tool_result FIRES the staged turn-end (run resolves — the ExitPlanMode reject fix)", async () => {
  // Esc'ing a modal (or Ctrl+C) makes claude write a cancel tool_result. Unlike
  // a normal tool_result (which continues the turn), this ENDS it. The staged
  // end_turn must FIRE — otherwise the run hangs "Agent is working" forever
  // (the bug behind rejecting an ExitPlanMode plan).
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-staging-interrupt-fires";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");

  const recorded: { stream: string; data: string }[] = [];
  void __forTest.pushTurnSlot(state, (stream, data) => recorded.push({ stream, data }));

  // ExitPlanMode tool_use with end_turn → staged.
  __forTest.dispatchLine(state, JSON.stringify({
    type: "assistant", uuid: "ep-1",
    message: { id: "msg-plan", role: "assistant",
      content: [{ type: "tool_use", id: "plan1", name: "ExitPlanMode", input: { plan: "x" } }],
      stop_reason: "end_turn" },
  }));
  expect(state.pendingEndTurn?.messageId).toBe("msg-plan");
  expect(state.turnQueue.length).toBe(1);

  // Interrupt tool_result (Esc) → must FIRE the end_turn, not cancel it.
  __forTest.dispatchLine(state, JSON.stringify({
    type: "user", uuid: "int-1",
    message: { content: [{ type: "tool_result", tool_use_id: "plan1",
      content: "The user doesn't want to proceed with this tool use. The tool use was rejected." }] },
  }));
  expect(state.pendingEndTurn).toBeNull();   // fired, not lingering
  expect(state.turnQueue.length).toBe(0);    // slot popped → the run resolves
  expect(recorded.some((r) => r.stream === "status" && r.data === "turn complete")).toBe(true);
  __forTest.uninstallSession(taskId);
});

test("dispatchLine: end_turn staging — thinking/text split lines stage+cancel, real end fires on confirmation", async () => {
  // Reproduces the EXACT Guest Mode failure sequence:
  // line 120: end_turn [thinking]  → stage (was previously STILL_FIRES with hasPendingToolUse fix)
  // line 121: end_turn [text]      → same message.id → cancel staged, re-stage
  // line 122: end_turn [tool_use]  → same message.id → cancel, re-stage
  // line 123: user [tool_result]   → continuation    → cancel
  // No slot pop at any point — the turn is still in progress.
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-staging-thinking-cancel";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");

  const recorded: { stream: string; data: string }[] = [];
  const donePromise = __forTest.pushTurnSlot(state, (stream, data) => recorded.push({ stream, data }));

  const mkLine = (blk: object, uuid: string) => JSON.stringify({
    type: "assistant", uuid,
    message: { id: "msg-XYZ", role: "assistant", content: [blk], stop_reason: "end_turn" },
  });

  __forTest.dispatchLine(state, mkLine({ type: "thinking", thinking: "hmm" }, "u1"));
  expect(state.pendingEndTurn?.messageId).toBe("msg-XYZ");
  expect(state.turnQueue.length).toBe(1);

  __forTest.dispatchLine(state, mkLine({ type: "text", text: "I'll check" }, "u2"));
  expect(state.pendingEndTurn?.messageId).toBe("msg-XYZ"); // re-staged
  expect(state.turnQueue.length).toBe(1);

  __forTest.dispatchLine(state, mkLine({ type: "tool_use", id: "t1", name: "Bash", input: {} }, "u3"));
  expect(state.pendingEndTurn?.messageId).toBe("msg-XYZ"); // re-staged
  expect(state.turnQueue.length).toBe(1);

  __forTest.dispatchLine(state, JSON.stringify({
    type: "user", uuid: "u4",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
  }));
  expect(state.pendingEndTurn).toBeNull(); // cancelled
  expect(state.turnQueue.length).toBe(1); // still alive

  // Now a new different message arrives (a real turn end) → pending is null already,
  // so no spurious fire. Verify no banner was emitted throughout.
  expect(recorded.some((r) => r.stream === "status" && r.data === "turn complete")).toBe(false);

  // Cleanup: the donePromise never resolves (turn didn't end); that's correct.
  // Reject it to avoid test hanging.
  state.turnQueue[0]?.reject?.(new Error("cleanup"));
  await donePromise.catch(() => {});
  __forTest.uninstallSession(taskId);
});

test("dispatchLine: pending end_turn fires when next line is a non-continuation (real turn end confirmed)", async () => {
  // When a real end_turn is followed by a non-tool_result, non-same-message
  // line (e.g. a new user text prompt, or a last-prompt event), the pending
  // fires: emits "turn complete" banner and pops the slot.
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-staging-fires-on-confirm";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");

  const recorded: { stream: string; data: string }[] = [];
  const donePromise = __forTest.pushTurnSlot(state, (stream, data) => recorded.push({ stream, data }));

  __forTest.dispatchLine(state, JSON.stringify({
    type: "assistant", uuid: "et-real",
    message: { id: "msg-REAL", role: "assistant",
      content: [{ type: "text", text: "all done!" }], stop_reason: "end_turn" },
  }));
  expect(state.pendingEndTurn?.messageId).toBe("msg-REAL");
  expect(state.turnQueue.length).toBe(1); // not popped yet

  // Non-continuation line (a system event — different type, no same message.id)
  __forTest.dispatchLine(state, JSON.stringify({
    type: "system", uuid: "sys-1", subtype: "turn_duration", durationMs: 5000,
  }));

  // Pending fired: banner emitted, slot popped
  expect(state.pendingEndTurn).toBeNull();
  expect(state.turnQueue.length).toBe(0);
  expect(recorded.some((r) => r.stream === "status" && r.data === "turn complete")).toBe(true);
  expect(await donePromise).toBe(0);
  __forTest.uninstallSession(taskId);
});

test("dispatchLine: already-seen end_turn (reattach/dedup) is staged and fires on next non-continuation line", async () => {
  // The crash-between-persist-and-status-update case: an already-seen end_turn
  // is staged (not fired immediately). On the next call with a non-continuation
  // line, it fires — no banner (emitBanner:false), but popEndOfTurn runs so
  // the run-row transitions correctly.
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-dedup-et-staged";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");

  let endOfTurnFired = false;
  state.onEndOfTurn = () => { endOfTurnFired = true; };
  state.seenLineUuids.add("seen-et-uuid");

  __forTest.dispatchLine(state, JSON.stringify({
    type: "assistant", uuid: "seen-et-uuid",
    message: { id: "msg-SEEN", role: "assistant",
      content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
  }));
  // Staged, not fired yet.
  expect(state.pendingEndTurn?.messageId).toBe("msg-SEEN");
  expect(endOfTurnFired).toBe(false);

  // Next non-continuation line fires it (emitBanner:false since it was dedup).
  __forTest.dispatchLine(state, JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 1000 }));
  expect(state.pendingEndTurn).toBeNull();
  expect(endOfTurnFired).toBe(true);
  __forTest.uninstallSession(taskId);
});

test("dispatchLine: already-seen end_turn tool_use (dedup) cancelled by next tool_result — onEndOfTurn never fires", async () => {
  // Dedup + tool_use: the pending is staged with emitBanner:false. If the
  // next line is a tool_result (continuation), the pending is cancelled and
  // onEndOfTurn never fires. The run SHOULD NOT be marked done here.
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-dedup-tooluse-cancel";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");

  let endOfTurnFired = false;
  state.onEndOfTurn = () => { endOfTurnFired = true; };
  state.seenLineUuids.add("seen-tu-uuid");

  __forTest.dispatchLine(state, JSON.stringify({
    type: "assistant", uuid: "seen-tu-uuid",
    message: { id: "msg-TU", role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      stop_reason: "end_turn" },
  }));
  expect(state.pendingEndTurn?.messageId).toBe("msg-TU");

  __forTest.dispatchLine(state, JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
  }));
  expect(state.pendingEndTurn).toBeNull();
  expect(endOfTurnFired).toBe(false);
  __forTest.uninstallSession(taskId);
});

test("dispatchLine: already-seen NON-end_turn line does NOT touch the turn queue or fire onEndOfTurn", async () => {
  // Inverse of the end_turn carve-out: only end_turn lines should drive
  // queue bookkeeping on the dedup path. A replayed tool_use or text
  // assistant line must skip cleanly, leaving turnQueue + onEndOfTurn
  // untouched. Guards against accidental over-trigger if isEndOfTurnEvent
  // ever gets widened (e.g. to other stop_reason values).
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-non-end-turn-dedup";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");

  // Push a slot and install an onEndOfTurn — both should survive the dispatch.
  const recorded: { stream: string; data: string }[] = [];
  void __forTest.pushTurnSlot(state, (stream, data) => {
    recorded.push({ stream, data });
  });
  let endOfTurnFired = false;
  state.onEndOfTurn = () => { endOfTurnFired = true; };

  state.seenLineUuids.add("tool-use-uuid");
  __forTest.dispatchLine(state, JSON.stringify({
    type: "assistant",
    uuid: "tool-use-uuid",
    message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }], stop_reason: "tool_use" },
  }));

  // Slot still queued, listener still armed, no chunk re-emitted.
  expect(state.turnQueue.length).toBe(1);
  expect(state.onEndOfTurn).not.toBeNull();
  expect(endOfTurnFired).toBe(false);
  expect(recorded).toEqual([]);
  __forTest.uninstallSession(taskId);
});

test("dispatchLine: already-seen end_turn pops the head turn slot after next confirming line (mid-pipeline dedup edge case)", async () => {
  // Duplicate end_turn (watcher + sync-flush reaching same offset): the slot
  // must be popped exactly once after the confirming next line. With staging,
  // the dedup'd end_turn stages the pending (emitBanner:false), and the next
  // non-continuation line fires it — resolving done and popping the slot.
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-end-turn-dedup-live";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");

  const recorded: { stream: string; data: string }[] = [];
  const donePromise = __forTest.pushTurnSlot(state, (stream, data) => {
    recorded.push({ stream, data });
  });

  state.seenLineUuids.add("end-turn-uuid-2");

  __forTest.dispatchLine(state, JSON.stringify({
    type: "assistant",
    uuid: "end-turn-uuid-2",
    message: { id: "msg-D2", role: "assistant", content: [], stop_reason: "end_turn" },
  }));

  // Staged — not popped yet.
  expect(state.turnQueue.length).toBe(1);
  expect(state.pendingEndTurn?.messageId).toBe("msg-D2");

  // Confirming next line (a system event — not a continuation).
  __forTest.dispatchLine(state, JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 100 }));

  // Slot now popped; no duplicate chunks; done resolves.
  expect(state.turnQueue.length).toBe(0);
  expect(state.pendingEndTurn).toBeNull();
  // No "turn complete" re-emitted (emitBanner:false on the dedup path).
  expect(recorded.some((r) => r.data === "turn complete")).toBe(false);
  expect(await donePromise).toBe(0);
  __forTest.uninstallSession(taskId);
});

test("flush: fires a staged end_turn after END_TURN_IDLE_FIRE_MS with no new data (idle path)", async () => {
  // Edge case: end_turn is the very last write to the JSONL — no following
  // last-prompt, mode event, or tool_result arrives to trigger the fire
  // via normal continuation logic. flush() detects idle (no new bytes +
  // stagedAt age ≥ END_TURN_IDLE_FIRE_MS) and fires the pending directly.
  const { __forTest } = await import("./claude-tmux.ts");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = mkdtempSync("/tmp/agetor-flush-idle-test-");
  const jsonlPath = join(dir, "session.jsonl");
  // Write a single end_turn line — this is the whole file.
  writeFileSync(jsonlPath, JSON.stringify({
    type: "assistant", uuid: "et-idle",
    message: { id: "msg-IDLE", role: "assistant",
      content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
  }) + "\n");

  const taskId = "task-flush-idle";
  const state = __forTest.installSession(taskId, jsonlPath);
  const recorded: { stream: string; data: string }[] = [];
  const donePromise = __forTest.pushTurnSlot(state, (stream, data) => recorded.push({ stream, data }));

  // First flush: reads the end_turn line, stages the pending.
  await __forTest.flush(state);
  expect(state.pendingEndTurn?.messageId).toBe("msg-IDLE");
  expect(state.turnQueue.length).toBe(1); // not popped yet

  // Second flush with no new data but NOT yet past the idle threshold — still pending.
  await __forTest.flush(state);
  expect(state.pendingEndTurn).not.toBeNull(); // still waiting

  // Backdate stagedAt past the idle threshold, then flush again with no data.
  const pending = state.pendingEndTurn;
  if (!pending) throw new Error("expected pending end_turn before idle backdate");
  pending.stagedAt -= 1000; // older than END_TURN_IDLE_FIRE_MS (800ms)
  await __forTest.flush(state);

  // Idle path fires: pending cleared, slot popped, banner emitted, done resolves.
  expect(state.pendingEndTurn).toBeNull();
  expect(state.turnQueue.length).toBe(0);
  expect(recorded.some((r) => r.stream === "status" && r.data === "turn complete")).toBe(true);
  expect(await donePromise).toBe(0);
  __forTest.uninstallSession(taskId);
});

test("staging: a cancelled run drops its pending end_turn so a late JSONL line cannot fire a stale banner", async () => {
  // Race condition the prior review flagged: after the staging refactor,
  // there's a window between staging an end_turn and the next line confirming
  // it. If the user cancels in that window, the kill paths must drop
  // state.pendingEndTurn — otherwise the late line fires firePendingEndTurn,
  // emitting a "turn complete" banner via state.lastChunk on a run the
  // orchestrator has already marked `cancelled`.
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-cancel-clears-pending";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");
  const recorded: { stream: string; data: string }[] = [];
  state.lastChunk = (stream, data) => recorded.push({ stream, data });

  // Stage a pending end_turn manually (mirrors what dispatchLine does after
  // an end_turn line arrives but before the next line confirms it).
  state.pendingEndTurn = {
    messageId: "msg-CANCEL",
    uuid: "uuid-cancelled",
    emitBanner: true,
    stagedAt: Date.now(),
  };

  // Simulate the cancel cleanup the kill paths do.
  state.pendingEndTurn = null;
  for (const slot of state.turnQueue.splice(0)) slot.reject?.(new Error("cancelled"));

  // Now a late JSONL line arrives (e.g., claude's response to Ctrl+C, or the
  // idle-fire path in flush). Without the cleanup the staged pending would
  // fire here; with it, firePendingEndTurn becomes a no-op.
  __forTest.firePendingEndTurn(state);
  __forTest.dispatchLine(state, JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 100 }));

  // No "turn complete" banner emitted on the cancelled run.
  expect(recorded.some((r) => r.data === "turn complete")).toBe(false);
  __forTest.uninstallSession(taskId);
});

test("rebuildEventsFromJsonl: emits 'turn complete' for a real turn end (rebuild endpoint parity)", () => {
  // The /runs/:id/rebuild-events endpoint must produce the SAME event shape
  // as the live SSE path — including "turn complete" banners. Looping
  // mapJsonlEventToChunks per-line would emit zero banners after the staging
  // refactor (banner moved to firePendingEndTurn). rebuildEventsFromJsonl
  // drives a synthetic SessionState through the same dispatch pipeline so the
  // banner survives.
  const lines = [
    JSON.stringify({ type: "assistant", uuid: "u1",
      message: { id: "msg-A", role: "assistant", content: [{ type: "text", text: "hello" }], stop_reason: "end_turn" } }),
    JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 1000 }),
  ].join("\n");
  const out: { stream: string; data: string }[] = [];
  rebuildEventsFromJsonl(lines, (stream, data) => out.push({ stream, data }));
  // Text emitted, banner emitted (in correct order: text then turn complete then duration).
  expect(out.some((r) => r.stream === "assistant" && r.data === "hello")).toBe(true);
  expect(out.some((r) => r.stream === "status" && r.data === "turn complete")).toBe(true);
  expect(out.some((r) => r.stream === "status" && r.data === "turn duration: 1.0s")).toBe(true);
});

test("rebuildEventsFromJsonl: suppresses spurious 'turn complete' for split-line end_turn (Guest Mode quirk)", () => {
  // Same staging guarantee on the rebuild path: an end_turn line followed by
  // a tool_result (continuation) must NOT produce a "turn complete" banner.
  // Without this the rebuild would emit the same spurious dividers the live
  // tailer used to emit before the staging fix.
  const lines = [
    JSON.stringify({ type: "assistant", uuid: "u1",
      message: { id: "msg-A", role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
        stop_reason: "end_turn" } }),
    JSON.stringify({ type: "user", uuid: "u2",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
  ].join("\n");
  const out: { stream: string; data: string }[] = [];
  rebuildEventsFromJsonl(lines, (stream, data) => out.push({ stream, data }));
  expect(out.some((r) => r.stream === "tool_use")).toBe(true);
  expect(out.some((r) => r.stream === "tool_result")).toBe(true);
  expect(out.some((r) => r.stream === "status" && r.data === "turn complete")).toBe(false);
});

test("rebuildEventsFromJsonl: fires staged end_turn at EOF (last line is the turn end)", () => {
  // Edge case mirrors flush()'s idle-fire path: if the JSONL's last line is
  // an end_turn (no following line to confirm via continuation check), the
  // EOF fire in rebuildEventsFromJsonl must still emit the banner so the
  // rebuilt stream isn't missing the closing divider.
  const lines = [
    JSON.stringify({ type: "assistant", uuid: "u1",
      message: { id: "msg-A", role: "assistant",
        content: [{ type: "text", text: "all done" }], stop_reason: "end_turn" } }),
  ].join("\n");
  const out: { stream: string; data: string }[] = [];
  rebuildEventsFromJsonl(lines, (stream, data) => out.push({ stream, data }));
  expect(out.some((r) => r.stream === "assistant" && r.data === "all done")).toBe(true);
  expect(out.some((r) => r.stream === "status" && r.data === "turn complete")).toBe(true);
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

test("cycleToMode: success on first attempt when the status bar shows the target", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const prevPoll = __forTest.setModePollIntervalMs(1);
  // The status bar already reports auto once the presses land.
  const prevPane = __forTest.setCaptureModePane(() => "⏵⏵ auto mode on (shift+tab to cycle)");
  try {
    const taskId = "task-cycle-success";
    const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");
    state.permissionMode = CLAUDE_MODE_DEFAULT;
    const result = await cycleToMode(taskId, "auto");
    // Cycle: [default, acceptEdits, plan, auto] — 3 presses.
    expect(result).toEqual({ ok: true, presses: 3, via: "shift-tab" });
    // The verifier mirrors the observed mode back onto the session.
    expect(state.permissionMode).toBe(CLAUDE_MODE_AUTO);
    __forTest.uninstallSession(taskId);
  } finally {
    __forTest.setCaptureModePane(prevPane);
    __forTest.setModePollIntervalMs(prevPoll);
  }
});

test("cycleToMode: retries from the newly-observed mode when the first press lands short", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const prevPoll = __forTest.setModePollIntervalMs(1);
  // Attempt 1 (from default) settles on acceptEdits; once cycleToMode records
  // that landing on the session, attempt 2's bar reports auto.
  const prevPane = __forTest.setCaptureModePane((s) =>
    s.permissionMode === CLAUDE_MODE_ACCEPT_EDITS
      ? "⏵⏵ auto mode on (shift+tab to cycle)"
      : "⏵⏵ accept edits on (shift+tab to cycle)",
  );
  try {
    const taskId = "task-cycle-retry";
    const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");
    state.permissionMode = CLAUDE_MODE_DEFAULT;
    const result = await cycleToMode(taskId, "auto");
    // Attempt 1: default → auto = 3 presses (lands on acceptEdits instead).
    // Attempt 2: acceptEdits → auto = 2 presses. Total: 5.
    expect(result).toEqual({ ok: true, presses: 5, via: "shift-tab" });
    expect(state.permissionMode).toBe(CLAUDE_MODE_AUTO);
    __forTest.uninstallSession(taskId);
  } finally {
    __forTest.setCaptureModePane(prevPane);
    __forTest.setModePollIntervalMs(prevPoll);
  }
});

test("cycleToMode: returns 'verification timed out' when the status bar never confirms", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const prevTimeout = __forTest.setModeVerifyTimeoutMs(20);
  const prevPoll = __forTest.setModePollIntervalMs(1);
  // Bar shows no recognisable mode banner (e.g. the auto opt-in modal is
  // painted over it) — readPaneMode returns null on every poll.
  const prevPane = __forTest.setCaptureModePane(() => "Some unrelated output\n❯ ");
  try {
    const taskId = "task-cycle-timeout";
    const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");
    state.permissionMode = CLAUDE_MODE_DEFAULT;
    const result = await cycleToMode(taskId, "auto");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("verification timed out");
      expect(result.attempts).toBe(1);
      // lastObserved stays at the pre-press mode — the bar never moved.
      expect(result.lastObserved).toBe(CLAUDE_MODE_DEFAULT);
    }
    __forTest.uninstallSession(taskId);
  } finally {
    __forTest.setCaptureModePane(prevPane);
    __forTest.setModePollIntervalMs(prevPoll);
    __forTest.setModeVerifyTimeoutMs(prevTimeout);
  }
});

test("cycleToMode: gives up with 'verification mismatch' after MAX_VERIFY_ATTEMPTS wrong modes", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const prevPoll = __forTest.setModePollIntervalMs(1);
  // Each attempt lands on a wrong mode, keyed off where the previous attempt
  // left the session: default → acceptEdits → plan → default.
  const prevPane = __forTest.setCaptureModePane((s) => {
    if (s.permissionMode === CLAUDE_MODE_ACCEPT_EDITS) return "⏸ plan mode on (shift+tab to cycle)";
    if (s.permissionMode === CLAUDE_MODE_PLAN) return "? for shortcuts";
    return "⏵⏵ accept edits on (shift+tab to cycle)";
  });
  try {
    const taskId = "task-cycle-mismatch";
    const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");
    state.permissionMode = CLAUDE_MODE_DEFAULT;
    const result = await cycleToMode(taskId, "auto");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("verification mismatch");
      expect(result.attempts).toBe(__forTest.MAX_VERIFY_ATTEMPTS);
      expect(result.lastObserved).toBe(CLAUDE_MODE_DEFAULT);
    }
    __forTest.uninstallSession(taskId);
  } finally {
    __forTest.setCaptureModePane(prevPane);
    __forTest.setModePollIntervalMs(prevPoll);
  }
});

test("cycleToMode: /plan target bypasses the verify loop entirely", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-cycle-plan";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");
  state.permissionMode = CLAUDE_MODE_DEFAULT;
  // No pane scrape — /plan returns immediately without verifying.
  const result = await cycleToMode(taskId, "plan");
  expect(result).toEqual({ ok: true, presses: 0, via: "slash-plan" });
  __forTest.uninstallSession(taskId);
});

test("cycleToMode: overlapping calls on the same task both resolve", async () => {
  // With pane-scrape verification there are no shared listeners to clobber;
  // two overlapping calls just both poll the bar. This is a smoke test that
  // concurrent cycleToMode calls (e.g. a user double-PATCH) each settle.
  const { __forTest } = await import("./claude-tmux.ts");
  const prevPoll = __forTest.setModePollIntervalMs(1);
  const prevPane = __forTest.setCaptureModePane(() => "⏵⏵ auto mode on (shift+tab to cycle)");
  try {
    const taskId = "task-cycle-race";
    const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");
    state.permissionMode = CLAUDE_MODE_DEFAULT;
    const [ra, rb] = await Promise.all([
      cycleToMode(taskId, "auto"),
      cycleToMode(taskId, "auto"),
    ]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(state.permissionMode).toBe(CLAUDE_MODE_AUTO);
    __forTest.uninstallSession(taskId);
  } finally {
    __forTest.setCaptureModePane(prevPane);
    __forTest.setModePollIntervalMs(prevPoll);
  }
});

test("readPaneMode: reads the trailing status-bar banner, ignoring mode phrases in output above it", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-readpane-anchor";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");
  // A decoy "auto mode on" in assistant output must NOT win over the real
  // banner on the trailing line.
  const prevPane = __forTest.setCaptureModePane(() =>
    [
      "Assistant: I'll switch to auto mode on your behalf.",
      "❯ ",
      "  ⏸ plan mode on (shift+tab to cycle) · ← for agents",
    ].join("\n"),
  );
  try {
    expect(__forTest.readPaneMode(state)).toBe(CLAUDE_MODE_PLAN);
  } finally {
    __forTest.setCaptureModePane(prevPane);
    __forTest.uninstallSession(taskId);
  }
});

test("readPaneMode: default mode recognised via the '? for shortcuts' trailing hint", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-readpane-default";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");
  const prevPane = __forTest.setCaptureModePane(() => "❯ \n  ? for shortcuts · ← for agents");
  try {
    expect(__forTest.readPaneMode(state)).toBe(CLAUDE_MODE_DEFAULT);
  } finally {
    __forTest.setCaptureModePane(prevPane);
    __forTest.uninstallSession(taskId);
  }
});

test("readPaneMode: null when a mode phrase lacks the cycle-hint banner (e.g. modal covering the bar)", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "task-readpane-null";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");
  // "auto mode on" appears, but not as the trailing `(shift+tab to cycle)` banner.
  const prevPane = __forTest.setCaptureModePane(() => "talking about auto mode on\n❯ ");
  try {
    expect(__forTest.readPaneMode(state)).toBeNull();
  } finally {
    __forTest.setCaptureModePane(prevPane);
    __forTest.uninstallSession(taskId);
  }
});

test("resolveAskCard resolves the card AND clears the session askCardId (so a failed drive can re-collect)", async () => {
  const { __forTest, resolveAskCard } = await import("./claude-tmux.ts");
  const { __testing, registerScrapedAskQuestions, activeAskQuestionsForTask } =
    await import("./interactions.ts");
  __testing.reset();
  const taskId = "task-resolve-ask-card";
  const state = __forTest.installSession(taskId, "/tmp/never-read.jsonl");
  const card = registerScrapedAskQuestions({
    taskId, runId: "r1",
    questions: [{ question: "Q", options: [{ label: "A" }] }],
    fingerprint: "fp",
  });
  state.askCardId = card.id;
  expect(activeAskQuestionsForTask(taskId)).toHaveLength(1);

  resolveAskCard(card.id, taskId);
  expect(activeAskQuestionsForTask(taskId)).toHaveLength(0); // interaction dropped
  expect(state.askCardId).toBeNull();                        // tracker cleared → scraper can re-collect
  __forTest.uninstallSession(taskId);
});

test("resolveAskCard still drops the card with no live session (the route's no-tmux path)", async () => {
  const { resolveAskCard } = await import("./claude-tmux.ts");
  const { __testing, registerScrapedAskQuestions, activeAskQuestionsForTask } =
    await import("./interactions.ts");
  __testing.reset();
  const card = registerScrapedAskQuestions({
    taskId: "task-resolve-ask-nosession", runId: "r1",
    questions: [{ question: "Q", options: [{ label: "A" }] }],
    fingerprint: "fp",
  });
  expect(activeAskQuestionsForTask("task-resolve-ask-nosession")).toHaveLength(1);
  resolveAskCard(card.id, "task-resolve-ask-nosession"); // no installSession → no state
  expect(activeAskQuestionsForTask("task-resolve-ask-nosession")).toHaveLength(0);
});

test("readPendingAskQuestionsFromJsonl: returns the unanswered AskUserQuestion tool_use, with previews", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const jsonl = path.join(mkdtempSync(path.join(tmpdir(), "agetor-askjsonl-")), "s.jsonl");
  const toolUse = {
    type: "assistant",
    message: { content: [{
      type: "tool_use", id: "tu1", name: "AskUserQuestion",
      input: { questions: [{
        question: "How far should this go?", header: "Scope", multiSelect: false,
        options: [
          { label: "Plugins + curated built-ins", description: "Enumerate plugins AND a curated built-in list.", preview: "/ autocomplete shows:\n  /deploy ... [plugin]\n  /init ... [builtin]" },
          { label: "Plugins only", description: "Enumerate enabled-plugin items only.", preview: "/ autocomplete shows:\n  /deploy ... [plugin]" },
        ],
      }] },
    }] },
  };
  // A prior unrelated line + the pending tool_use, no matching tool_result.
  writeFileSync(jsonl,
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "go" }] } }) + "\n"
    + JSON.stringify(toolUse) + "\n");

  const qs = __forTest.readPendingAskQuestionsFromJsonl(jsonl);
  expect(qs).not.toBeNull();
  expect(qs!.length).toBe(1);
  expect(qs![0]!.question).toBe("How far should this go?");
  expect(qs![0]!.header).toBe("Scope");
  expect(qs![0]!.options.map((o) => o.label)).toEqual(["Plugins + curated built-ins", "Plugins only"]);
  expect(qs![0]!.options[0]!.description).toBe("Enumerate plugins AND a curated built-in list.");
  expect(qs![0]!.options[0]!.preview).toContain("[builtin]"); // the multi-line preview survives
});

test("readPendingAskQuestionsFromJsonl: null once the tool_use has a matching tool_result (answered)", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const jsonl = path.join(mkdtempSync(path.join(tmpdir(), "agetor-askjsonl2-")), "s.jsonl");
  writeFileSync(jsonl,
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "AskUserQuestion", input: { questions: [{ question: "Q?", options: [{ label: "A" }] }] } }] } }) + "\n"
    + JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "answered" }] } }) + "\n");
  expect(__forTest.readPendingAskQuestionsFromJsonl(jsonl)).toBeNull();
});

test("readPendingAskQuestionsFromJsonl: null when there's no AskUserQuestion / the file is missing", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  expect(__forTest.readPendingAskQuestionsFromJsonl("/no/such/agetor/file.jsonl")).toBeNull();
});

test("shouldWaitForAskJsonl: stalls only for a lossy pane with no JSONL, inside the grace window", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const wait = __forTest.shouldWaitForAskJsonl;
  const lossy = "❯ 1. Plugins + curated\n  ✂ 5 lines hidden\n  2. Plugins only";
  const simple = "❯ 1. Plugins + curated\n  2. Plugins only";
  const now = 1_000_000;
  // Lossy pane, no JSONL yet, modal just appeared → wait for the JSONL.
  expect(wait(false, lossy, now, now)).toBe(true);
  // Grace expired (>2s since first seen) → register from the pane instead.
  expect(wait(false, lossy, now - 2_001, now)).toBe(false);
  // Simple pane → never wait; the pane already renders it cleanly.
  expect(wait(false, simple, now, now)).toBe(false);
  // JSONL already available → use it, don't wait.
  expect(wait(true, lossy, now, now)).toBe(false);
  // No firstSeenAt recorded → don't wait.
  expect(wait(false, lossy, null, now)).toBe(false);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * collectAskQuestionsFromPane — per-option preview capture orchestration
 *
 * Drives the real collector against an in-memory fake pane (no tmux) that
 * renders claude's side-by-side preview layout for the current (tab, cursor)
 * and tracks navigation, so we can assert: every option's preview is scraped,
 * the cursor (and tab) is restored to the start, and the pane was grown.
 * ────────────────────────────────────────────────────────────────────────── */
import type { NavKey } from "./claude-questions.ts";

type FakeOption = { label: string; preview?: string[] };
type FakeTab = { header: string; question: string; multiSelect: boolean; options: FakeOption[] };

/** Render one frame of the modal as tmux would capture it: option list on the
 *  left, the FOCUSED option's preview in a box to the right (col 30). */
function renderFakeModal(tabs: FakeTab[], tab: number, cursor: number): string {
  const COL = 30, W = 28;
  const cur = tabs[tab]!;
  const out: string[] = ["─".repeat(80)];
  out.push(tabs.length > 1
    ? "←  " + tabs.map((t) => "☐ " + t.header).join("  ") + "  ✔ Submit  →"
    : " ☐ " + cur.header);
  out.push("", cur.question, "");

  const leftParts = cur.options.map((o, i) =>
    (i === cursor ? "❯ " : "  ") + (i + 1) + ". " + (cur.multiSelect ? "[ ] " : "") + o.label);
  const prev = cur.options[cursor]?.preview;
  const boxRows: string[] = [];
  if (prev && prev.length) {
    boxRows.push("┌" + "─".repeat(W) + "┐");
    for (const pl of prev) boxRows.push("│ " + pl.padEnd(W - 1) + "│");
    boxRows.push("└" + "─".repeat(W) + "┘");
  }
  const numRows = Math.max(leftParts.length, boxRows.length);
  for (let r = 0; r < numRows; r++) {
    const left = leftParts[r] ?? "";
    const box = boxRows[r] ?? "";
    out.push(box ? left.padEnd(COL) + box : left);
  }
  if (cur.multiSelect) out.push("  Next");
  out.push("  Chat about this", "─".repeat(80),
    tabs.length > 1
      ? "Enter to select · Tab/Arrow keys to navigate · Esc to cancel"
      : "Enter to select · ↑/↓ to navigate · Esc to cancel");
  return out.join("\n");
}

/** In-memory PaneIo: clamps Up at option 0 and Down at the last option (no
 *  wrap — matching the real TUI), resets the cursor to 0 on a tab switch, and
 *  logs every key + resize so the test can assert cursor/tab restoration. */
function makeFakePane(tabs: FakeTab[]) {
  let tab = 0, cursor = 0, w = 120, h = 30;
  const log: string[] = [];
  const io = {
    capture: () => renderFakeModal(tabs, tab, cursor),
    send: (key: NavKey) => {
      log.push(key);
      if (key === "Down") cursor = Math.min(cursor + 1, tabs[tab]!.options.length - 1);
      else if (key === "Up") cursor = Math.max(cursor - 1, 0);
      else if (key === "Right") { tab = Math.min(tab + 1, tabs.length - 1); cursor = 0; }
      else if (key === "Left") { tab = Math.max(tab - 1, 0); cursor = 0; }
      return true;
    },
    size: () => ({ w, h }),
    resize: (nw: number, nh: number) => { w = nw; h = nh; log.push(`resize:${nw}x${nh}`); },
    restore: (nw: number, nh: number) => { w = nw; h = nh; log.push(`restore:${nw}x${nh}`); },
    sleep: async () => { /* no delay in tests */ },
  };
  return { io, log, at: () => ({ tab, cursor, w, h }) };
}

test("collectAskQuestionsFromPane: flat question scrapes every option's preview and restores the cursor", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const tabs: FakeTab[] = [{
    header: "Pick", question: "Which option?", multiSelect: false,
    options: [
      { label: "Alpha", preview: ["a-one", "a-two", "a-three"] },
      { label: "Beta", preview: ["b-one", "b-two"] },
      { label: "Gamma", preview: ["g-only"] },
    ],
  }];
  const { io, log, at } = makeFakePane(tabs);
  const state = __forTest.installSession("ask-flat", "/tmp/never-read.jsonl");
  try {
    const res = await __forTest.collectAskQuestionsFromPane(state, renderFakeModal(tabs, 0, 0), io);
    expect(res).not.toBeNull();
    expect(res!.length).toBe(1);
    expect(res![0]!.multiSelect).toBe(false);
    expect(res![0]!.options.map((o) => o.label)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(res![0]!.options[0]!.preview).toBe("a-one\na-two\na-three");
    expect(res![0]!.options[1]!.preview).toBe("b-one\nb-two");
    expect(res![0]!.options[2]!.preview).toBe("g-only");
    // The pane was grown (and restored), and the cursor walked back to option 0.
    expect(log.some((l) => l.startsWith("resize:"))).toBe(true);
    expect(log.some((l) => l.startsWith("restore:"))).toBe(true);
    expect(at().cursor).toBe(0);
    // Net option navigation is balanced (equal Downs and Ups).
    expect(log.filter((l) => l === "Down").length).toBe(log.filter((l) => l === "Up").length);
  } finally {
    __forTest.uninstallSession("ask-flat");
  }
});

test("collectAskQuestionsFromPane: tabbed multi-question scrapes previews per tab and restores tab+cursor", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const tabs: FakeTab[] = [
    {
      header: "Size", question: "Pick sizes", multiSelect: true,
      options: [
        { label: "Small", preview: ["s-1", "s-2"] },
        { label: "Large", preview: ["l-1"] },
      ],
    },
    {
      header: "Crust", question: "Pick a crust", multiSelect: false,
      options: [
        { label: "Thin", preview: ["t-1", "t-2", "t-3"] },
        { label: "Deep", preview: ["d-1"] },
      ],
    },
  ];
  const { io, log, at } = makeFakePane(tabs);
  const state = __forTest.installSession("ask-tabbed", "/tmp/never-read.jsonl");
  try {
    const res = await __forTest.collectAskQuestionsFromPane(state, renderFakeModal(tabs, 0, 0), io);
    expect(res).not.toBeNull();
    expect(res!.length).toBe(2);
    expect(res![0]!.header).toBe("Size");
    expect(res![0]!.multiSelect).toBe(true);
    expect(res![0]!.options.map((o) => o.label)).toEqual(["Small", "Large"]);
    expect(res![0]!.options[0]!.preview).toBe("s-1\ns-2");
    expect(res![0]!.options[1]!.preview).toBe("l-1");
    expect(res![1]!.header).toBe("Crust");
    expect(res![1]!.multiSelect).toBe(false);
    expect(res![1]!.options[0]!.preview).toBe("t-1\nt-2\nt-3");
    expect(res![1]!.options[1]!.preview).toBe("d-1");
    // Returned to the first tab, cursor at option 0; tab navigation balanced.
    expect(at().tab).toBe(0);
    expect(at().cursor).toBe(0);
    expect(log.filter((l) => l === "Right").length).toBe(log.filter((l) => l === "Left").length);
  } finally {
    __forTest.uninstallSession("ask-tabbed");
  }
});

test("collectAskQuestionsFromPane: flat no-preview question takes the fast path (no resize, no navigation)", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const tabs: FakeTab[] = [{
    header: "Pick", question: "Which option?", multiSelect: false,
    options: [{ label: "Yes" }, { label: "No" }],
  }];
  const { io, log } = makeFakePane(tabs);
  const state = __forTest.installSession("ask-nopreview", "/tmp/never-read.jsonl");
  try {
    const res = await __forTest.collectAskQuestionsFromPane(state, renderFakeModal(tabs, 0, 0), io);
    expect(res).not.toBeNull();
    expect(res![0]!.options.map((o) => o.label)).toEqual(["Yes", "No"]);
    expect(res![0]!.options.every((o) => o.preview === undefined)).toBe(true);
    // Fast path: no grow, no keystrokes.
    expect(log.length).toBe(0);
  } finally {
    __forTest.uninstallSession("ask-nopreview");
  }
});

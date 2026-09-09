import { describe, test, expect } from "bun:test";
import {
  FX_SESSION_TITLE_MAX_LEN,
  FxTextCoalescer,
  extractFxProviderValue,
  fxRefusedStatusLine,
  isFxContextDiagnostic,
  mapFxUpdate,
} from "./fx-acp.ts";
import type { FxUpdateCtx } from "./fx-acp.ts";
import {
  FX_USAGE_STATUS_PREFIX,
  FX_SESSION_TITLE_STATUS_PREFIX,
  FX_RECOVERY_STATUS_PREFIX,
} from "../shared/types.ts";
import type { FxRecoveryPayload } from "../shared/types.ts";
import { fxRecoverySummaryLine } from "../shared/fx-recovery.ts";
import { deriveTodoProgress } from "../shared/todo-progress.ts";
import { SENT_FILES_TOOL_NAME, parseSentFilesToolUse } from "../shared/sent-files.ts";

/**
 * Pure unit tests of `mapFxUpdate` — no child process, no tmpdir, no
 * `agent.done` awaiting. `fx-acp.test.ts` still exercises this mapper
 * end-to-end through a real spawned fake `fx acp` child (one integration
 * test per update family); this file is where the per-field coercion rules
 * (fallbacks, drops, id minting) are pinned down cheaply and exhaustively.
 */

/** A fresh `ctx` with its own independent seq counter, mirroring the
 *  `() => state.seq++` closure `dispatchSessionUpdate` passes in production.
 *  `current` exposes the counter's next value without consuming it, so a
 *  test can assert "the counter did not move" without guessing. `lastTitle`
 *  is a real, mutable field (typed via `FxUpdateCtx`, not just structurally
 *  compatible with it) so the `session_info_update` dedupe tests can both
 *  read it back after a call and assert it stays untouched when nothing was
 *  emitted — mirroring how `dispatchSessionUpdate` carries `state.lastTitle`
 *  across calls in production. The five recovery/review fields
 *  (`lastRecoveryJson`, `replaying`, `replayedPaused`, `lastRecovery`,
 *  `reviewHeldWarned`) mirror that exact pattern for the recovery channel and
 *  the held-tool guidance: explicitly initialized (not just left off the
 *  object, even though `FxUpdateCtx` types them optional) so a test can both
 *  seed one before a call (e.g. `ctx.replaying = true`) and read it back
 *  after, the same way `dispatchSessionUpdate` carries them across calls via
 *  `FxSessionState` in production. */
function makeCtx(runId = "run-1"): FxUpdateCtx & { readonly current: number } {
  let seq = 0;
  return {
    runId,
    nextSeq: () => seq++,
    lastTitle: undefined,
    lastRecoveryJson: undefined,
    replaying: undefined,
    replayedPaused: undefined,
    lastRecovery: undefined,
    reviewHeldWarned: undefined,
    get current() {
      return seq;
    },
  };
}

describe("agent_message_chunk / agent_thought_chunk", () => {
  test("maps text to assistant/thinking chunks with fx:<runId>:<seq> line uuids, incrementing per emitted chunk", () => {
    const ctx = makeCtx("run-A");
    const assistant = mapFxUpdate(
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
      ctx,
    );
    expect(assistant).toEqual([{ stream: "assistant", data: "hi", lineUuid: "fx:run-A:0" }]);

    const thinking = mapFxUpdate(
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
      ctx,
    );
    expect(thinking).toEqual([{ stream: "thinking", data: "hmm", lineUuid: "fx:run-A:1" }]);
  });

  test("empty text produces no chunk and does NOT bump the seq counter", () => {
    const ctx = makeCtx("run-B");
    expect(
      mapFxUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } }, ctx),
    ).toEqual([]);
    expect(
      mapFxUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "" } }, ctx),
    ).toEqual([]);
    expect(ctx.current).toBe(0);

    // The next REAL chunk still gets seq 0 — proof the two empty calls above
    // never consumed a sequence number.
    const next = mapFxUpdate(
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "real" } },
      ctx,
    );
    expect(next).toEqual([{ stream: "assistant", data: "real", lineUuid: "fx:run-B:0" }]);
  });

  test("missing content, or a non-text content block, also yields no chunk", () => {
    const ctx = makeCtx();
    expect(mapFxUpdate({ sessionUpdate: "agent_message_chunk" }, ctx)).toEqual([]);
    expect(
      mapFxUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "image" } }, ctx),
    ).toEqual([]);
    expect(ctx.current).toBe(0);
  });

  test("agent_thought_chunk carries a string messageId onto the mapped thinking chunk when fx sends one", () => {
    const ctx = makeCtx("run-TH1");
    const chunks = mapFxUpdate(
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "reasoning…" }, messageId: "m1" },
      ctx,
    );
    expect(chunks).toEqual([{ stream: "thinking", data: "reasoning…", lineUuid: "fx:run-TH1:0", messageId: "m1" }]);
  });

  test("agent_thought_chunk with no messageId (fx today) still maps cleanly, with the field undefined", () => {
    const ctx = makeCtx("run-TH2");
    const chunks = mapFxUpdate(
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "reasoning…" } },
      ctx,
    );
    expect(chunks).toEqual([{ stream: "thinking", data: "reasoning…", lineUuid: "fx:run-TH2:0" }]);
    expect(chunks[0]!.messageId).toBeUndefined();
  });

  test("agent_thought_chunk with a non-text content block (or missing content) yields no chunk, and does not bump the seq counter", () => {
    const ctx = makeCtx();
    expect(mapFxUpdate({ sessionUpdate: "agent_thought_chunk" }, ctx)).toEqual([]);
    expect(
      mapFxUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "image" } }, ctx),
    ).toEqual([]);
    expect(ctx.current).toBe(0);
  });
});

describe("tool_call → tool_use", () => {
  test("uses the wire toolCallId and names the tool 'title (kind)' when both are present", () => {
    const ctx = makeCtx("run-C");
    const chunks = mapFxUpdate(
      { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Run ls", kind: "execute", rawInput: { cmd: "ls" } },
      ctx,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.stream).toBe("tool_use");
    expect(chunks[0]!.lineUuid).toBe("fx:tool:tc-1:use");
    expect(JSON.parse(chunks[0]!.data)).toEqual({
      id: "tc-1",
      name: "Run ls (execute)",
      input: { cmd: "ls" },
      serverSide: false,
    });
  });

  test("name falls back to title-only, kind-only, or the literal 'tool_call' when neither is present", () => {
    const ctx = makeCtx();
    const titleOnly = mapFxUpdate({ sessionUpdate: "tool_call", toolCallId: "tc-2", title: "Do thing" }, ctx);
    expect(JSON.parse(titleOnly[0]!.data).name).toBe("Do thing");

    const kindOnly = mapFxUpdate({ sessionUpdate: "tool_call", toolCallId: "tc-3", kind: "execute" }, ctx);
    expect(JSON.parse(kindOnly[0]!.data).name).toBe("execute");

    const neither = mapFxUpdate({ sessionUpdate: "tool_call", toolCallId: "tc-4" }, ctx);
    expect(JSON.parse(neither[0]!.data).name).toBe("tool_call");

    // A blank-string title/kind is treated the same as absent, not as a
    // real (empty) label.
    const blank = mapFxUpdate({ sessionUpdate: "tool_call", toolCallId: "tc-4b", title: "", kind: "" }, ctx);
    expect(JSON.parse(blank[0]!.data).name).toBe("tool_call");
  });

  test("a missing toolCallId mints a seq<n> id instead, and still consumes the shared counter", () => {
    const ctx = makeCtx("run-D");
    const minted = mapFxUpdate({ sessionUpdate: "tool_call", title: "No id" }, ctx);
    expect(minted).toHaveLength(1);
    expect(minted[0]!.lineUuid).toBe("fx:tool:seq0:use");
    expect(JSON.parse(minted[0]!.data).id).toBe("seq0");

    // The counter moved — the next seq-consuming update sees 1, not 0.
    const next = mapFxUpdate(
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
      ctx,
    );
    expect(next[0]!.lineUuid).toBe("fx:run-D:1");
  });

  test("input prefers rawInput; falls back to the whole update when rawInput is absent", () => {
    const ctx = makeCtx();
    const withRawInput = mapFxUpdate({ sessionUpdate: "tool_call", toolCallId: "tc-5", rawInput: { a: 1 } }, ctx);
    expect(JSON.parse(withRawInput[0]!.data).input).toEqual({ a: 1 });

    const update = { sessionUpdate: "tool_call", toolCallId: "tc-6", title: "T" };
    const withoutRawInput = mapFxUpdate(update, ctx);
    expect(JSON.parse(withoutRawInput[0]!.data).input).toEqual(update);
  });

  test("fx ≥0.0.8's real `name` wins over the legacy title/kind synthesis, and a differing title rides alongside as `title`", () => {
    const ctx = makeCtx("run-N1");
    const chunks = mapFxUpdate(
      { sessionUpdate: "tool_call", toolCallId: "tc-n1", name: "shell", title: "Run ls", kind: "execute", rawInput: { cmd: "ls" } },
      ctx,
    );
    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0]!.data)).toEqual({
      id: "tc-n1",
      name: "shell",
      input: { cmd: "ls" },
      serverSide: false,
      title: "Run ls",
    });
  });

  test("a real `name` equal to the title carries no separate `title` key — nothing new to say", () => {
    const ctx = makeCtx();
    const chunks = mapFxUpdate({ sessionUpdate: "tool_call", toolCallId: "tc-n2", name: "shell", title: "shell" }, ctx);
    const parsed = JSON.parse(chunks[0]!.data);
    expect(parsed.name).toBe("shell");
    expect("title" in parsed).toBe(false);
  });

  test("no `name` at all falls back to the legacy 'title (kind)' synthesis and never carries a `title` key — the title is already folded into `name`", () => {
    const ctx = makeCtx();
    const chunks = mapFxUpdate({ sessionUpdate: "tool_call", toolCallId: "tc-n3", title: "Do thing", kind: "execute" }, ctx);
    const parsed = JSON.parse(chunks[0]!.data);
    expect(parsed.name).toBe("Do thing (execute)");
    expect("title" in parsed).toBe(false);
  });

  test("an empty-string `name` is treated as absent — falls back to legacy synthesis, no `title` key", () => {
    const ctx = makeCtx();
    const chunks = mapFxUpdate(
      { sessionUpdate: "tool_call", toolCallId: "tc-n4", name: "", title: "Do thing", kind: "execute" },
      ctx,
    );
    const parsed = JSON.parse(chunks[0]!.data);
    expect(parsed.name).toBe("Do thing (execute)");
    expect("title" in parsed).toBe(false);
  });
});

describe("tool_call_update → tool_result", () => {
  test("completed maps isError:false; failed maps isError:true", () => {
    const ctx = makeCtx();
    const completed = mapFxUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", rawOutput: { stdout: "ok" } },
      ctx,
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]!.stream).toBe("tool_result");
    expect(completed[0]!.lineUuid).toBe("fx:tool:tc-1:result");
    expect(JSON.parse(completed[0]!.data)).toEqual({ toolUseId: "tc-1", content: { stdout: "ok" }, isError: false });

    const failed = mapFxUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "tc-2", status: "failed", content: "boom" },
      ctx,
    );
    expect(JSON.parse(failed[0]!.data)).toEqual({ toolUseId: "tc-2", content: "boom", isError: true });
  });

  test("non-terminal statuses (pending, in_progress, unknown, absent) are ignored — no chunk", () => {
    const ctx = makeCtx();
    for (const status of ["pending", "in_progress", "something-else", undefined]) {
      expect(
        mapFxUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tc-x", status }, ctx),
      ).toEqual([]);
    }
  });

  test("a missing toolCallId drops the event even when status is terminal — no unpairable orphan", () => {
    const ctx = makeCtx();
    expect(mapFxUpdate({ sessionUpdate: "tool_call_update", status: "completed" }, ctx)).toEqual([]);
    expect(mapFxUpdate({ sessionUpdate: "tool_call_update", status: "failed" }, ctx)).toEqual([]);
  });

  test("content prefers rawOutput, then content, then the whole update", () => {
    const ctx = makeCtx();
    const withRawOutput = mapFxUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "tc-y", status: "completed", rawOutput: "ro", content: "c" },
      ctx,
    );
    expect(JSON.parse(withRawOutput[0]!.data).content).toBe("ro");

    const withContentOnly = mapFxUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "tc-y2", status: "completed", content: "c" },
      ctx,
    );
    expect(JSON.parse(withContentOnly[0]!.data).content).toBe("c");

    const update = { sessionUpdate: "tool_call_update", toolCallId: "tc-z", status: "completed" };
    const bare = mapFxUpdate(update, ctx);
    expect(JSON.parse(bare[0]!.data).content).toEqual(update);
  });
});

describe("tool_call_update → held-tool review guidance (review_unavailable)", () => {
  // fx's hard-wired auto-mode reviewer can be unavailable on an account
  // (e.g. HTTP 403 for that tier); fx then holds/denies the call and tells
  // the MODEL why via a JSON error object riding the tool_result content —
  // `{"error":{"type":"tool_review_held"|"tool_permission_denied",
  // "reason":"review_unavailable", …}}` — which agetor also surfaces to the
  // USER, once per run, as a plain guidance status line.
  const heldError = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      error: {
        type: "tool_review_held",
        tool_name: "shell",
        message: "The action did not run because safety review was unavailable — try again shortly.",
        reason: "review_unavailable",
        held: true,
        ...overrides,
      },
    });

  test("review_unavailable warns once per ctx: the tool_result chunk is followed by a warning status chunk; a second held call in the same ctx warns no further", () => {
    const ctx = makeCtx("run-H1");
    const content = heldError();
    const first = mapFxUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "tc-h1", status: "failed", content },
      ctx,
    );
    expect(first).toHaveLength(2);
    expect(first[0]!.stream).toBe("tool_result");
    expect(first[0]!.lineUuid).toBe("fx:tool:tc-h1:result");
    expect(JSON.parse(first[0]!.data)).toEqual({ toolUseId: "tc-h1", content, isError: true });
    expect(first[1]!.stream).toBe("status");
    expect(first[1]!.lineUuid).toBe("fx:run-H1:0");
    expect(first[1]!.data.startsWith("⚠ fx held this tool call")).toBe(true);
    expect(first[1]!.data).toContain("Switch this task's mode to Full access (or Ask)");
    expect(ctx.reviewHeldWarned).toBe(true);

    const second = mapFxUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "tc-h2", status: "failed", content: heldError() },
      ctx,
    );
    expect(second).toHaveLength(1);
    expect(second[0]!.stream).toBe("tool_result");
  });

  test("type: tool_permission_denied + reason: review_unavailable also warns", () => {
    const ctx = makeCtx("run-H2");
    const content = JSON.stringify({
      error: { type: "tool_permission_denied", tool_name: "shell", reason: "review_unavailable" },
    });
    const chunks = mapFxUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "tc-h3", status: "completed", content },
      ctx,
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.stream).toBe("status");
    expect(chunks[1]!.data.startsWith("⚠ fx held this tool call")).toBe(true);
    expect(ctx.reviewHeldWarned).toBe(true);
  });

  test("reason: review_caution or user_denied never warns", () => {
    for (const reason of ["review_caution", "user_denied"]) {
      const ctx = makeCtx();
      const content = JSON.stringify({ error: { type: "tool_review_held", reason } });
      const chunks = mapFxUpdate(
        { sessionUpdate: "tool_call_update", toolCallId: "tc-h4", status: "failed", content },
        ctx,
      );
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.stream).toBe("tool_result");
      expect(ctx.reviewHeldWarned).toBeUndefined();
    }
  });

  test("a `type` outside {tool_review_held, tool_permission_denied} never warns, even with reason: review_unavailable", () => {
    const ctx = makeCtx();
    const content = JSON.stringify({ error: { type: "some_other_error", reason: "review_unavailable" } });
    const chunks = mapFxUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "tc-h5", status: "failed", content },
      ctx,
    );
    expect(chunks).toHaveLength(1);
    expect(ctx.reviewHeldWarned).toBeUndefined();
  });

  test("non-JSON content emits no warning and does not throw", () => {
    const ctx = makeCtx();
    expect(() =>
      mapFxUpdate(
        { sessionUpdate: "tool_call_update", toolCallId: "tc-h6", status: "failed", content: "not json at all" },
        ctx,
      ),
    ).not.toThrow();
    const chunks = mapFxUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "tc-h7", status: "failed", content: "still not json" },
      ctx,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.stream).toBe("tool_result");
    expect(ctx.reviewHeldWarned).toBeUndefined();
  });

  test("an already-parsed plain-object content (via rawOutput, not stringified) is tolerated the same as a JSON string", () => {
    const ctx = makeCtx();
    const chunks = mapFxUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-h8",
        status: "failed",
        rawOutput: { error: { type: "tool_review_held", reason: "review_unavailable" } },
      },
      ctx,
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.data.startsWith("⚠ fx held this tool call")).toBe(true);
    expect(ctx.reviewHeldWarned).toBe(true);
  });

  // ── Finding #1 (fix-fx-harness-rate-limit F1) ──
  // Real fx 0.0.8 traffic never sends the string/rawOutput shapes above — a
  // `tool_call_update`'s `content` is the ACP `ToolCallContent[]` array
  // shape, source-verified against `src/acp/types.zig writeToolCallUpdate`:
  // `[{"type":"content","content":{"type":"text","text":"<held JSON
  // string>"}}]`, with no `rawOutput` field on this update kind at all. The
  // string/object tests above pin pre-existing tolerance that stays for
  // robustness; these pin the shape that actually fires against real fx.

  test("real ACP ToolCallContent[] wire shape — [{type:\"content\", content:{type:\"text\", text: <held JSON>}}] — warns exactly like the string form, after the real tool_result chunk", () => {
    const ctx = makeCtx("run-H9");
    const content = [{ type: "content", content: { type: "text", text: heldError() } }];
    const chunks = mapFxUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "tc-h9", status: "failed", content },
      ctx,
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.stream).toBe("tool_result");
    // toolResultContent (and so the real tool_result chunk's data) is
    // unaffected by this fix — still the raw content array, verbatim.
    expect(JSON.parse(chunks[0]!.data).content).toEqual(content);
    expect(chunks[1]!.stream).toBe("status");
    expect(chunks[1]!.lineUuid).toBe("fx:run-H9:0");
    expect(chunks[1]!.data.startsWith("⚠ fx held this tool call")).toBe(true);
    expect(chunks[1]!.data).toContain("Switch this task's mode to Full access (or Ask)");
    expect(ctx.reviewHeldWarned).toBe(true);
  });

  test("a bare {type:\"text\", text} block with no {type:\"content\"} wrapper also warns", () => {
    const ctx = makeCtx();
    const content = [{ type: "text", text: heldError() }];
    const chunks = mapFxUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "tc-h10", status: "failed", content },
      ctx,
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.data.startsWith("⚠ fx held this tool call")).toBe(true);
    expect(ctx.reviewHeldWarned).toBe(true);
  });

  test("an array of non-JSON / non-matching text content never warns, and never throws — including a non-text inner block and a non-content item mixed in", () => {
    const ctx = makeCtx();
    const content = [
      { type: "content", content: { type: "text", text: "not json at all" } },
      { type: "text", text: "still not json" },
      { type: "content", content: { type: "image", uri: "file:///x.png" } }, // non-text inner block — ignored
      { type: "diff", path: "/x", oldText: "a", newText: "b" }, // non-content item — ignored
    ];
    expect(() =>
      mapFxUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tc-h11", status: "failed", content }, ctx),
    ).not.toThrow();
    const chunks = mapFxUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "tc-h12", status: "failed", content },
      ctx,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.stream).toBe("tool_result");
    expect(ctx.reviewHeldWarned).toBeUndefined();
  });

  test("walks past an earlier array item that parses to JSON but has no `error` key to find a later match", () => {
    const ctx = makeCtx();
    const content = [
      { type: "content", content: { type: "text", text: JSON.stringify({ note: "not an error object" }) } },
      { type: "content", content: { type: "text", text: heldError({ tool_name: "second" }) } },
    ];
    const chunks = mapFxUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "tc-h13", status: "failed", content },
      ctx,
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.data.startsWith("⚠ fx held this tool call")).toBe(true);
    expect(ctx.reviewHeldWarned).toBe(true);
  });
});

describe("tool_call_update → dormant resource_link → synthetic SendUserFile mapping", () => {
  function resourceLinkUpdate(overrides: Record<string, unknown> = {}, links: Record<string, unknown>[]) {
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-file",
      status: "completed",
      content: links.map((link) => ({ type: "content", content: link })),
      ...overrides,
    };
  }

  test("a completed update with one file:// resource_link emits the real tool_result plus a paired SendUserFile use/result", () => {
    const ctx = makeCtx();
    const chunks = mapFxUpdate(
      resourceLinkUpdate({ title: "Chart" }, [
        {
          type: "resource_link",
          uri: "file:///tmp/chart.png",
          name: "chart.png",
          mimeType: "image/png",
          size: 1234,
        },
      ]),
      ctx,
    );

    expect(chunks).toHaveLength(3);

    // Real tool_result, unchanged.
    expect(chunks[0]!.stream).toBe("tool_result");
    expect(chunks[0]!.lineUuid).toBe("fx:tool:tc-file:result");
    expect(JSON.parse(chunks[0]!.data).toolUseId).toBe("tc-file");

    // Synthetic tool_use.
    const useChunk = chunks[1]!;
    expect(useChunk.stream).toBe("tool_use");
    expect(useChunk.lineUuid).toBe("fx:tool:tc-file:sent-files:use");
    const use = JSON.parse(useChunk.data);
    expect(use.id).toBe("tc-file:sent-files");
    expect(use.name).toBe(SENT_FILES_TOOL_NAME);
    expect(use.serverSide).toBe(false);
    const parsedRequest = parseSentFilesToolUse(use.name, use.input);
    expect(parsedRequest).toEqual({
      files: ["/tmp/chart.png"],
      caption: "Chart",
      status: "normal",
      display: null,
    });

    // Synthetic tool_result.
    const resultChunk = chunks[2]!;
    expect(resultChunk.stream).toBe("tool_result");
    expect(resultChunk.lineUuid).toBe("fx:tool:tc-file:sent-files:result");
    const result = JSON.parse(resultChunk.data);
    expect(result.toolUseId).toBe("tc-file:sent-files");
    expect(result.content).toBe("1 file delivered to user.");
    expect(result.isError).toBe(false);
    expect(result.attachments).toEqual([
      { path: "/tmp/chart.png", size: 1234, isImage: true, mediaType: "image/png" },
    ]);
  });

  test("an https:// resource_link is not a local file — only the normal tool_result is emitted", () => {
    const ctx = makeCtx();
    const chunks = mapFxUpdate(
      resourceLinkUpdate({}, [
        { type: "resource_link", uri: "https://example.com/chart.png", name: "chart.png" },
      ]),
      ctx,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.stream).toBe("tool_result");
  });

  test("an in_progress status with a resource_link emits nothing at all (not even the normal result)", () => {
    const ctx = makeCtx();
    const chunks = mapFxUpdate(
      resourceLinkUpdate({ status: "in_progress" }, [
        { type: "resource_link", uri: "file:///tmp/chart.png" },
      ]),
      ctx,
    );
    expect(chunks).toEqual([]);
  });

  test("a failed status never adds the synthetic pair, even with a resource_link present", () => {
    const ctx = makeCtx();
    const chunks = mapFxUpdate(
      resourceLinkUpdate({ status: "failed" }, [
        { type: "resource_link", uri: "file:///tmp/chart.png" },
      ]),
      ctx,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.stream).toBe("tool_result");
    expect(JSON.parse(chunks[0]!.data).isError).toBe(true);
  });

  test("a plain text content block is left alone — unchanged output, no synthetic pair", () => {
    const ctx = makeCtx();
    const chunks = mapFxUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-text",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "done" } }],
      },
      ctx,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.stream).toBe("tool_result");
  });

  test("two resource_links produce files.length === 2 and a pluralized delivery message", () => {
    const ctx = makeCtx();
    const chunks = mapFxUpdate(
      resourceLinkUpdate({}, [
        { type: "resource_link", uri: "file:///tmp/a.png" },
        { type: "resource_link", uri: "file:///tmp/b.md" },
      ]),
      ctx,
    );
    expect(chunks).toHaveLength(3);
    const use = JSON.parse(chunks[1]!.data);
    expect(use.input.files).toEqual(["/tmp/a.png", "/tmp/b.md"]);
    const result = JSON.parse(chunks[2]!.data);
    expect(result.content).toBe("2 files delivered to user.");
    expect(result.attachments).toHaveLength(2);
  });

  test("a percent-encoded file:// URI decodes to the literal path", () => {
    const ctx = makeCtx();
    const chunks = mapFxUpdate(
      resourceLinkUpdate({}, [{ type: "resource_link", uri: "file:///tmp/a%20b.png" }]),
      ctx,
    );
    const use = JSON.parse(chunks[1]!.data);
    expect(use.input.files).toEqual(["/tmp/a b.png"]);
  });

  test("mimeType absent falls back to isImagePath for the isImage flag, and no caption key when title is blank/absent", () => {
    const ctx = makeCtx();
    const chunks = mapFxUpdate(
      resourceLinkUpdate({ title: "   " }, [{ type: "resource_link", uri: "file:///tmp/photo.jpg" }]),
      ctx,
    );
    const use = JSON.parse(chunks[1]!.data);
    expect("caption" in use.input).toBe(false);
    const result = JSON.parse(chunks[2]!.data);
    expect(result.attachments[0].isImage).toBe(true);
    expect(result.attachments[0].mediaType).toBeNull();
  });
});

describe("plan → synthetic TodoWrite tool_use", () => {
  test("drops blank-content entries, coerces a bogus status to pending, and drops priority", () => {
    const ctx = makeCtx("run-P");
    const chunks = mapFxUpdate(
      {
        sessionUpdate: "plan",
        entries: [
          { content: "Write tests", status: "completed", priority: "high" },
          { content: "", status: "pending" },
          { content: "Fix bug", status: "bogus-status", priority: "low" },
          { content: "Ship it", status: "in_progress" },
        ],
      },
      ctx,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.stream).toBe("tool_use");
    expect(chunks[0]!.lineUuid).toBe("fx:run-P:0");

    const parsed = JSON.parse(chunks[0]!.data);
    expect(parsed.id).toBe("fx-plan");
    expect(parsed.name).toBe("TodoWrite");
    expect(parsed.serverSide).toBe(false);
    expect(parsed.input.todos).toEqual([
      { content: "Write tests", status: "completed" },
      { content: "Fix bug", status: "pending" },
      { content: "Ship it", status: "in_progress" },
    ]);
    // priority never survives into the emitted todo shape.
    expect(parsed.input.todos.some((t: Record<string, unknown>) => "priority" in t)).toBe(false);
  });

  test("an explicit empty entries array still emits — todos: [] is a valid clear signal", () => {
    const ctx = makeCtx();
    const chunks = mapFxUpdate({ sessionUpdate: "plan", entries: [] }, ctx);
    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0]!.data).input.todos).toEqual([]);
  });

  test("a non-array `entries` (or a missing one) is dropped entirely — never emitted as a bogus empty clear", () => {
    const ctx = makeCtx();
    expect(mapFxUpdate({ sessionUpdate: "plan", entries: "not-an-array" }, ctx)).toEqual([]);
    expect(mapFxUpdate({ sessionUpdate: "plan", entries: null }, ctx)).toEqual([]);
    expect(mapFxUpdate({ sessionUpdate: "plan" }, ctx)).toEqual([]);
  });

  test("individually malformed entries inside a valid array are dropped, not fatal to the rest", () => {
    const ctx = makeCtx();
    const chunks = mapFxUpdate(
      { sessionUpdate: "plan", entries: [null, "a string", 42, { content: "   " }, { content: "Real" }] },
      ctx,
    );
    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0]!.data).input.todos).toEqual([{ content: "Real", status: "pending" }]);
  });

  test("cross-checked against deriveTodoProgress: 1/3 completed, mid-turn active item surfaced", () => {
    const ctx = makeCtx("run-Q");
    const chunks = mapFxUpdate(
      {
        sessionUpdate: "plan",
        entries: [
          { content: "A", status: "completed" },
          { content: "B", status: "pending" },
          { content: "C", status: "in_progress" },
        ],
      },
      ctx,
    );
    const progress = deriveTodoProgress(chunks.map((c) => ({ stream: c.stream, data: c.data })));
    expect(progress).not.toBeNull();
    expect(progress!.completed).toBe(1);
    expect(progress!.total).toBe(3);
  });
});

describe("usage_update → FX_USAGE_STATUS_PREFIX status chunk", () => {
  test("valid used/size/cost emits the sentinel-prefixed JSON payload", () => {
    const ctx = makeCtx("run-U");
    const chunks = mapFxUpdate(
      { sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 0.01, currency: "USD" } },
      ctx,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.stream).toBe("status");
    expect(chunks[0]!.lineUuid).toBe("fx:run-U:0");
    expect(chunks[0]!.data.startsWith(FX_USAGE_STATUS_PREFIX)).toBe(true);
    expect(JSON.parse(chunks[0]!.data.slice(FX_USAGE_STATUS_PREFIX.length))).toEqual({
      used: 10,
      size: 100,
      cost: { amount: 0.01, currency: "USD" },
    });
  });

  test("a malformed cost object is dropped on its own — used/size still emit with no cost key", () => {
    const ctx = makeCtx();
    const missingCurrency = mapFxUpdate(
      { sessionUpdate: "usage_update", used: 1, size: 2, cost: { amount: 0.5 } },
      ctx,
    );
    const payload1 = JSON.parse(missingCurrency[0]!.data.slice(FX_USAGE_STATUS_PREFIX.length));
    expect(payload1).toEqual({ used: 1, size: 2 });
    expect("cost" in payload1).toBe(false);

    const nonObjectCost = mapFxUpdate({ sessionUpdate: "usage_update", used: 3, size: 4, cost: "free" }, ctx);
    const payload2 = JSON.parse(nonObjectCost[0]!.data.slice(FX_USAGE_STATUS_PREFIX.length));
    expect(payload2).toEqual({ used: 3, size: 4 });
  });

  test("non-numeric (or missing) used/size drops the whole update", () => {
    const ctx = makeCtx();
    expect(mapFxUpdate({ sessionUpdate: "usage_update", used: "nope", size: 100 }, ctx)).toEqual([]);
    expect(mapFxUpdate({ sessionUpdate: "usage_update", used: 10, size: "nope" }, ctx)).toEqual([]);
    expect(mapFxUpdate({ sessionUpdate: "usage_update", used: 10 }, ctx)).toEqual([]);
    expect(mapFxUpdate({ sessionUpdate: "usage_update" }, ctx)).toEqual([]);
  });

  test("a small fractional cost amount ({amount: 0.0012, currency: 'USD'}) round-trips exactly into the {used,size,cost} payload", () => {
    const ctx = makeCtx("run-U2");
    const chunks = mapFxUpdate(
      { sessionUpdate: "usage_update", used: 500, size: 128000, cost: { amount: 0.0012, currency: "USD" } },
      ctx,
    );
    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0]!.data.slice(FX_USAGE_STATUS_PREFIX.length))).toEqual({
      used: 500,
      size: 128000,
      cost: { amount: 0.0012, currency: "USD" },
    });
  });
});


describe("session_info_update → FX_SESSION_TITLE_STATUS_PREFIX status chunk", () => {
  test("a real, non-placeholder title emits one status chunk and records it onto ctx.lastTitle", () => {
    const ctx = makeCtx("run-T1");
    const chunks = mapFxUpdate(
      { sessionUpdate: "session_info_update", title: "Fix flaky worktree test", updatedAt: "2026-09-08T00:00:00Z" },
      ctx,
    );
    expect(chunks).toEqual([
      { stream: "status", data: FX_SESSION_TITLE_STATUS_PREFIX + "Fix flaky worktree test", lineUuid: "fx:run-T1:0" },
    ]);
    expect(ctx.lastTitle).toBe("Fix flaky worktree test");
  });

  test("fx's placeholder \"Untitled session\" never emits and leaves ctx.lastTitle untouched", () => {
    const ctx = makeCtx();
    expect(mapFxUpdate({ sessionUpdate: "session_info_update", title: "Untitled session" }, ctx)).toEqual([]);
    expect(ctx.lastTitle).toBeUndefined();
    expect(ctx.current).toBe(0);
  });

  test("an identical title repeated in the same ctx is silently deduped on the second (and further) occurrence", () => {
    const ctx = makeCtx("run-T2");
    const first = mapFxUpdate({ sessionUpdate: "session_info_update", title: "Same title" }, ctx);
    expect(first).toEqual([
      { stream: "status", data: FX_SESSION_TITLE_STATUS_PREFIX + "Same title", lineUuid: "fx:run-T2:0" },
    ]);
    const second = mapFxUpdate({ sessionUpdate: "session_info_update", title: "Same title" }, ctx);
    const third = mapFxUpdate({ sessionUpdate: "session_info_update", title: "Same title" }, ctx);
    expect(second).toEqual([]);
    expect(third).toEqual([]);
    // The seq counter never moved for either deduped (silent) call.
    expect(ctx.current).toBe(1);
    expect(ctx.lastTitle).toBe("Same title");
  });

  test("a genuinely changed title after an earlier one emits again and overwrites ctx.lastTitle", () => {
    const ctx = makeCtx("run-T3");
    mapFxUpdate({ sessionUpdate: "session_info_update", title: "First" }, ctx);
    const changed = mapFxUpdate({ sessionUpdate: "session_info_update", title: "Second" }, ctx);
    expect(changed).toEqual([
      { stream: "status", data: FX_SESSION_TITLE_STATUS_PREFIX + "Second", lineUuid: "fx:run-T3:1" },
    ]);
    expect(ctx.lastTitle).toBe("Second");
  });

  test("an empty-string or non-string title is ignored — no chunk, ctx.lastTitle untouched", () => {
    const ctx = makeCtx();
    expect(mapFxUpdate({ sessionUpdate: "session_info_update", title: "" }, ctx)).toEqual([]);
    expect(mapFxUpdate({ sessionUpdate: "session_info_update", title: 42 }, ctx)).toEqual([]);
    expect(mapFxUpdate({ sessionUpdate: "session_info_update", title: null }, ctx)).toEqual([]);
    expect(mapFxUpdate({ sessionUpdate: "session_info_update", title: { nested: true } }, ctx)).toEqual([]);
    expect(mapFxUpdate({ sessionUpdate: "session_info_update" }, ctx)).toEqual([]);
    expect(ctx.lastTitle).toBeUndefined();
    expect(ctx.current).toBe(0);
  });

  // NOTE: a bare `_meta.fx.modelResponseRecovery` update with no `title` is
  // covered in the dedicated "session_info_update → FX_RECOVERY_STATUS_PREFIX"
  // describe block below — it does NOT emit nothing (the pre-Wave-2 pinning
  // here was wrong: the recovery channel has been live since fx 0.0.7, see
  // the plan's §2 and the file header on `fx-acp.ts`).

  test("newlines/tabs/double spaces and leading/trailing whitespace are collapsed and trimmed before emitting", () => {
    const ctx = makeCtx("run-T4");
    const chunks = mapFxUpdate(
      { sessionUpdate: "session_info_update", title: "  Fix   flaky\n\tworktree   test  " },
      ctx,
    );
    expect(chunks).toEqual([
      { stream: "status", data: FX_SESSION_TITLE_STATUS_PREFIX + "Fix flaky worktree test", lineUuid: "fx:run-T4:0" },
    ]);
    expect(ctx.lastTitle).toBe("Fix flaky worktree test");
  });

  test("a 500-char title emits exactly FX_SESSION_TITLE_MAX_LEN characters", () => {
    const ctx = makeCtx("run-T5");
    const longTitle = "x".repeat(500);
    const chunks = mapFxUpdate({ sessionUpdate: "session_info_update", title: longTitle }, ctx);
    expect(chunks).toHaveLength(1);
    const emitted = chunks[0]!.data.slice(FX_SESSION_TITLE_STATUS_PREFIX.length);
    expect(emitted).toHaveLength(FX_SESSION_TITLE_MAX_LEN);
    expect(emitted).toBe("x".repeat(FX_SESSION_TITLE_MAX_LEN));
  });

  test("two raw titles differing only in whitespace normalize to the same string — the second call dedupes to nothing", () => {
    const ctx = makeCtx("run-T6");
    const first = mapFxUpdate({ sessionUpdate: "session_info_update", title: "Fix the bug" }, ctx);
    expect(first).toEqual([
      { stream: "status", data: FX_SESSION_TITLE_STATUS_PREFIX + "Fix the bug", lineUuid: "fx:run-T6:0" },
    ]);
    const second = mapFxUpdate({ sessionUpdate: "session_info_update", title: "Fix   the\nbug" }, ctx);
    expect(second).toEqual([]);
    expect(ctx.lastTitle).toBe("Fix the bug");
  });

  test("a title that normalizes to empty (all whitespace) is ignored — no chunk, ctx.lastTitle untouched", () => {
    const ctx = makeCtx();
    expect(mapFxUpdate({ sessionUpdate: "session_info_update", title: "   \n" }, ctx)).toEqual([]);
    expect(ctx.lastTitle).toBeUndefined();
    expect(ctx.current).toBe(0);
  });

  test("\"Untitled session\" padded with whitespace still normalizes to the placeholder and is dropped", () => {
    const ctx = makeCtx();
    expect(mapFxUpdate({ sessionUpdate: "session_info_update", title: "  Untitled session  " }, ctx)).toEqual([]);
    expect(ctx.lastTitle).toBeUndefined();
  });
});

describe("session_info_update → FX_RECOVERY_STATUS_PREFIX sentinel (model response recovery)", () => {
  // Live wire shapes below are drawn from the plan's §2 (fx ACP spike,
  // 2026-09-08/09, `docs/plans/fix-fx-harness-rate-limit.md`) — this is the
  // channel fx has always used to stream Vercel AI Gateway rate-limit
  // retry/pause/recovery progress over
  // `session_info_update._meta.fx.modelResponseRecovery`. The prior test
  // pinned here ("the legacy pre-0.0.8 shape … emits nothing") was wrong —
  // the channel is live since fx 0.0.7 and `mapFxUpdate` now maps it.

  /** Strips `FX_RECOVERY_STATUS_PREFIX` off a chunk's `data` and parses the
   *  remainder — used instead of a raw string `toBe` for multi-field
   *  payloads so a test doesn't have to hand-match `extractFields`' internal
   *  key-insertion order to pass; `toEqual` below compares structurally. */
  function parseRecoveryChunk(chunk: { data: string }): unknown {
    expect(chunk.data.startsWith(FX_RECOVERY_STATUS_PREFIX)).toBe(true);
    return JSON.parse(chunk.data.slice(FX_RECOVERY_STATUS_PREFIX.length));
  }

  test("a bare recovery object with no recognized fields (and no title) still emits exactly one sentinel chunk keyed off `state` alone, with a fx:<runId>:<seq> lineUuid, and records it onto ctx.lastRecovery/ctx.lastRecoveryJson", () => {
    const ctx = makeCtx("run-R0");
    const chunks = mapFxUpdate(
      {
        sessionUpdate: "session_info_update",
        _meta: { fx: { modelResponseRecovery: { attempted: true, succeeded: true } } },
      },
      ctx,
    );
    // Neither `attempted` nor `succeeded` is a field `extractFields` knows,
    // and there's no valid `state` string either, so the payload defaults to
    // bare `{state:"active"}` (parseFxRecoveryMeta's documented fallback) —
    // a single-key object, so a literal `JSON.stringify` comparison is
    // unambiguous regardless of key-insertion order.
    const expected: FxRecoveryPayload = { state: "active" };
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.stream).toBe("status");
    expect(chunks[0]!.lineUuid).toBe("fx:run-R0:0");
    expect(chunks[0]!.data).toBe(FX_RECOVERY_STATUS_PREFIX + JSON.stringify(expected));
    expect(ctx.lastRecovery).toEqual(expected);
    expect(ctx.lastRecoveryJson).toBe(JSON.stringify(expected));
    expect(ctx.lastTitle).toBeUndefined();
  });

  test("an active update WITH delaySeconds after one WITHOUT emits two distinct sentinel chunks and no summary line; an identical consecutive update after that emits nothing", () => {
    const ctx = makeCtx("run-R1");
    const withoutDelay: FxRecoveryPayload = {
      state: "active",
      kind: "auto_retry",
      cause: "rate_limited",
      action: "retrying_request",
      message:
        "⚠ Rate limited · HTTP 429 · rate_limit_exceeded: Free tier requests on this model are rate-limited. · retrying request · attempt 5/10",
      attempt: 5,
      attemptLimit: 10,
      durable: true,
    };
    const withDelay: FxRecoveryPayload = {
      ...withoutDelay,
      delaySeconds: 8,
      message:
        "⚠ Rate limited · HTTP 429 · rate_limit_exceeded: Free tier requests on this model are rate-limited. · retrying request in 8s · attempt 5/10",
    };
    const update = (payload: FxRecoveryPayload) => ({
      sessionUpdate: "session_info_update",
      _meta: { fx: { modelResponseRecovery: payload } },
    });

    const first = mapFxUpdate(update(withoutDelay), ctx);
    expect(first).toHaveLength(1); // sentinel only — no summary line for `active`
    expect(first[0]!.lineUuid).toBe("fx:run-R1:0");
    expect(parseRecoveryChunk(first[0]!)).toEqual(withoutDelay);

    const second = mapFxUpdate(update(withDelay), ctx);
    expect(second).toHaveLength(1);
    expect(second[0]!.lineUuid).toBe("fx:run-R1:1");
    expect(parseRecoveryChunk(second[0]!)).toEqual(withDelay);
    expect(second[0]!.data).not.toBe(first[0]!.data); // different JSON — delaySeconds + message changed

    // An identical consecutive update (same payload again) is deduped — no
    // chunk at all, and the seq counter doesn't move for a deduped call.
    const third = mapFxUpdate(update(withDelay), ctx);
    expect(third).toEqual([]);
    expect(ctx.current).toBe(2);
    expect(ctx.lastRecovery).toEqual(withDelay);
  });

  test("a `paused` update (not replaying) emits a sentinel chunk plus a persisted plain summary line equal to fxRecoverySummaryLine(payload), and records the payload onto ctx.lastRecovery", () => {
    const ctx = makeCtx("run-R2");
    const pausedPayload: FxRecoveryPayload = {
      state: "paused",
      kind: "terminal_provider_error",
      cause: "rate_limited",
      action: "paused",
      requiredAction: "continue_later",
      message:
        "⚠ Rate limited · HTTP 429 · rate_limit_exceeded: Free tier requests on this model are rate-limited. · recovery paused after 10/10 attempts",
      attempt: 10,
      attemptLimit: 10,
      durable: true,
    };
    const chunks = mapFxUpdate(
      { sessionUpdate: "session_info_update", _meta: { fx: { modelResponseRecovery: pausedPayload } } },
      ctx,
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.stream).toBe("status");
    expect(chunks[0]!.lineUuid).toBe("fx:run-R2:0");
    expect(parseRecoveryChunk(chunks[0]!)).toEqual(pausedPayload);

    const summary = fxRecoverySummaryLine(pausedPayload);
    expect(summary).not.toBeNull();
    expect(summary).toContain(" — resume once the limit clears, or send a new message.");
    expect(chunks[1]!.stream).toBe("status");
    expect(chunks[1]!.lineUuid).toBe("fx:run-R2:1");
    expect(chunks[1]!.data).toBe(summary as string);

    expect(ctx.lastRecovery).toEqual(pausedPayload);
    expect(ctx.lastRecovery!.state).toBe("paused");
  });

  test("a `recovered` update emits a sentinel plus the plain line \"✓ recovered · succeeded on attempt 1/10\"", () => {
    const ctx = makeCtx("run-R3");
    const recoveredPayload: FxRecoveryPayload = {
      state: "recovered",
      kind: "auto_recovered",
      message: "✓ recovered · succeeded on attempt 1/10",
      attempt: 1,
      attemptLimit: 10,
      durable: true,
    };
    const chunks = mapFxUpdate(
      { sessionUpdate: "session_info_update", _meta: { fx: { modelResponseRecovery: recoveredPayload } } },
      ctx,
    );
    expect(chunks).toHaveLength(2);
    expect(parseRecoveryChunk(chunks[0]!)).toEqual(recoveredPayload);
    expect(chunks[1]!.data).toBe("✓ recovered · succeeded on attempt 1/10");
    expect(fxRecoverySummaryLine(recoveredPayload)).toBe("✓ recovered · succeeded on attempt 1/10");
    expect(ctx.lastRecovery).toEqual(recoveredPayload);
  });

  test("a `recovered` update with no `message` field falls back to the same computed \"✓ recovered · succeeded on attempt N/M\" text", () => {
    const ctx = makeCtx("run-R3b");
    const chunks = mapFxUpdate(
      {
        sessionUpdate: "session_info_update",
        _meta: {
          fx: { modelResponseRecovery: { state: "recovered", kind: "auto_recovered", attempt: 1, attemptLimit: 10 } },
        },
      },
      ctx,
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.data).toBe("✓ recovered · succeeded on attempt 1/10");
  });

  test("`\"modelResponseRecovery\": null` clears the checkpoint — sentinel {state:\"cleared\"}, no plain line", () => {
    const ctx = makeCtx("run-R4");
    const chunks = mapFxUpdate(
      { sessionUpdate: "session_info_update", _meta: { fx: { modelResponseRecovery: null } } },
      ctx,
    );
    const expected: FxRecoveryPayload = { state: "cleared" };
    expect(chunks).toHaveLength(1); // no summary line — fxRecoverySummaryLine(cleared) === null
    expect(chunks[0]!.data).toBe(FX_RECOVERY_STATUS_PREFIX + JSON.stringify(expected));
    expect(fxRecoverySummaryLine(expected)).toBeNull();
    expect(ctx.lastRecovery).toEqual(expected);
  });

  test("ctx.replaying suppresses the summary line but not the sentinel, stamps the emitted body with replayed:true (finding #8), and flags ctx.replayedPaused for a paused update; ctx.lastRecovery is left untouched (undefined)", () => {
    const ctx = makeCtx("run-R5");
    ctx.replaying = true;
    const pausedPayload: FxRecoveryPayload = {
      state: "paused",
      kind: "terminal_provider_error",
      cause: "rate_limited",
      action: "paused",
      requiredAction: "continue_later",
      message: "⚠ Rate limited · HTTP 429 · … · recovery paused after 7/10 attempts",
      attempt: 7,
      attemptLimit: 10,
      durable: true,
    };
    const chunks = mapFxUpdate(
      { sessionUpdate: "session_info_update", _meta: { fx: { modelResponseRecovery: pausedPayload } } },
      ctx,
    );
    expect(chunks).toHaveLength(1); // sentinel only — no plain summary line while replaying
    expect(chunks[0]!.stream).toBe("status");
    // The EMITTED sentinel body carries the replay marker...
    expect(parseRecoveryChunk(chunks[0]!)).toEqual({ ...pausedPayload, replayed: true });
    expect(ctx.replayedPaused).toBe(true);
    expect(ctx.lastRecovery).toBeUndefined(); // only set on the non-replaying branch
    // ...but the dedupe key does NOT — it's computed from the plain payload,
    // so a later byte-identical LIVE update still dedupes/resets correctly
    // (finding #2) rather than being treated as distinct.
    expect(ctx.lastRecoveryJson).toBe(JSON.stringify(pausedPayload));
  });

  test("an `active` update while replaying emits only the sentinel and never sets ctx.replayedPaused", () => {
    const ctx = makeCtx("run-R6");
    ctx.replaying = true;
    const chunks = mapFxUpdate(
      {
        sessionUpdate: "session_info_update",
        _meta: { fx: { modelResponseRecovery: { state: "active", attempt: 1, attemptLimit: 3 } } },
      },
      ctx,
    );
    expect(chunks).toHaveLength(1);
    expect(ctx.replayedPaused).toBeUndefined();
    expect(ctx.lastRecovery).toBeUndefined();
  });

  test("finding #8: the `replayed` marker appears ONLY on the emitted body while ctx.replaying is true — a live (non-replaying) sentinel for the identical payload carries no `replayed` key at all, not even `replayed: false`", () => {
    const payload: FxRecoveryPayload = { state: "active", attempt: 4, attemptLimit: 10 };

    const replayingCtx = makeCtx("run-R7a");
    replayingCtx.replaying = true;
    const replayed = mapFxUpdate(
      { sessionUpdate: "session_info_update", _meta: { fx: { modelResponseRecovery: payload } } },
      replayingCtx,
    );
    expect(replayed).toHaveLength(1);
    const replayedBody = parseRecoveryChunk(replayed[0]!);
    expect(replayedBody).toEqual({ ...payload, replayed: true });
    expect((replayedBody as { replayed?: boolean }).replayed).toBe(true);

    const liveCtxUndefined = makeCtx("run-R7b"); // ctx.replaying left undefined (the production default)
    const live = mapFxUpdate(
      { sessionUpdate: "session_info_update", _meta: { fx: { modelResponseRecovery: payload } } },
      liveCtxUndefined,
    );
    expect(live).toHaveLength(1);
    const liveBody = parseRecoveryChunk(live[0]!);
    expect(liveBody).toEqual(payload);
    expect("replayed" in (liveBody as object)).toBe(false);

    const liveCtxFalse = makeCtx("run-R7c");
    liveCtxFalse.replaying = false; // explicit false — same as undefined for this purpose
    const liveExplicit = mapFxUpdate(
      { sessionUpdate: "session_info_update", _meta: { fx: { modelResponseRecovery: payload } } },
      liveCtxFalse,
    );
    const liveExplicitBody = parseRecoveryChunk(liveExplicit[0]!);
    expect("replayed" in (liveExplicitBody as object)).toBe(false);
  });

  test("a {title, updatedAt} update still emits the title sentinel exactly as before, and no recovery chunk", () => {
    const ctx = makeCtx("run-TI1");
    const chunks = mapFxUpdate(
      { sessionUpdate: "session_info_update", title: "Fix flaky worktree test", updatedAt: "2026-09-08T00:00:00Z" },
      ctx,
    );
    expect(chunks).toEqual([
      { stream: "status", data: FX_SESSION_TITLE_STATUS_PREFIX + "Fix flaky worktree test", lineUuid: "fx:run-TI1:0" },
    ]);
    expect(ctx.lastRecoveryJson).toBeUndefined();
    expect(ctx.lastRecovery).toBeUndefined();
  });

  test("a recovery-only update never emits a title chunk, and never touches ctx.lastTitle", () => {
    const ctx = makeCtx("run-TI2");
    const chunks = mapFxUpdate(
      {
        sessionUpdate: "session_info_update",
        _meta: { fx: { modelResponseRecovery: { state: "active", attempt: 1, attemptLimit: 3 } } },
      },
      ctx,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks.every((c) => !c.data.startsWith(FX_SESSION_TITLE_STATUS_PREFIX))).toBe(true);
    expect(ctx.lastTitle).toBeUndefined();
  });

  test("a synthetic update carrying both a title and a recovery meta emits both — recovery sentinel first, then the title sentinel", () => {
    const ctx = makeCtx("run-TI3");
    const chunks = mapFxUpdate(
      {
        sessionUpdate: "session_info_update",
        title: "Both at once",
        _meta: { fx: { modelResponseRecovery: { state: "active", attempt: 2, attemptLimit: 5 } } },
      },
      ctx,
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.data.startsWith(FX_RECOVERY_STATUS_PREFIX)).toBe(true);
    expect(chunks[0]!.lineUuid).toBe("fx:run-TI3:0");
    expect(chunks[1]!.data).toBe(FX_SESSION_TITLE_STATUS_PREFIX + "Both at once");
    expect(chunks[1]!.lineUuid).toBe("fx:run-TI3:1");
    expect(ctx.lastTitle).toBe("Both at once");
    expect(ctx.lastRecovery).toEqual({ state: "active", attempt: 2, attemptLimit: 5 });
  });
});

describe("fxRefusedStatusLine (finding #3: use the shared isFxRecoveryResumable predicate)", () => {
  // Previously this enrichment checked `recovery?.state === "paused"` alone
  // — every Resume affordance (RunPanel, CLI, TUI) instead gates on
  // `isFxRecoveryResumable`, which additionally requires `requiredAction` to
  // be absent or `continue_later`. A `paused` checkpoint needing a human
  // decision (`inspect_uncertain_tool`, `change_request`) is NOT something
  // Resume can act on, so its status line must stay plain, not claim
  // "resumable".

  test("paused + requiredAction: continue_later → enriched with the attempt fraction", () => {
    const recovery: FxRecoveryPayload = {
      state: "paused",
      requiredAction: "continue_later",
      attempt: 7,
      attemptLimit: 10,
    };
    expect(fxRefusedStatusLine("refused", recovery)).toBe(
      "fx turn ended: refused (response paused after 7/10 attempts — resumable)",
    );
  });

  test("paused + requiredAction absent defaults to resumable (continue_later is the only variant observed live)", () => {
    const recovery: FxRecoveryPayload = { state: "paused", attempt: 3, attemptLimit: 5 };
    expect(fxRefusedStatusLine("refused", recovery)).toBe(
      "fx turn ended: refused (response paused after 3/5 attempts — resumable)",
    );
  });

  test("paused + requiredAction: inspect_uncertain_tool (needs a human decision, not Resume-able) → plain line", () => {
    const recovery: FxRecoveryPayload = {
      state: "paused",
      requiredAction: "inspect_uncertain_tool",
      attempt: 4,
      attemptLimit: 10,
    };
    expect(fxRefusedStatusLine("refused", recovery)).toBe("fx turn ended: refused");
  });

  test("paused + requiredAction: change_request → plain line", () => {
    const recovery: FxRecoveryPayload = { state: "paused", requiredAction: "change_request", attempt: 1 };
    expect(fxRefusedStatusLine("refused", recovery)).toBe("fx turn ended: refused");
  });

  test("undefined recovery → plain line, for both the real wire reason and the ACP-canonical alias", () => {
    expect(fxRefusedStatusLine("refused", undefined)).toBe("fx turn ended: refused");
    expect(fxRefusedStatusLine("refusal", undefined)).toBe("fx turn ended: refusal");
  });

  test("attempt numbers omitted entirely (not \"N/undefined\") when either is unknown", () => {
    const missingAttempt: FxRecoveryPayload = { state: "paused", requiredAction: "continue_later", attemptLimit: 10 };
    expect(fxRefusedStatusLine("refused", missingAttempt)).toBe("fx turn ended: refused (response paused — resumable)");
    const missingLimit: FxRecoveryPayload = { state: "paused", requiredAction: "continue_later", attempt: 3 };
    expect(fxRefusedStatusLine("refused", missingLimit)).toBe("fx turn ended: refused (response paused — resumable)");
    const missingBoth: FxRecoveryPayload = { state: "paused", requiredAction: "continue_later" };
    expect(fxRefusedStatusLine("refused", missingBoth)).toBe("fx turn ended: refused (response paused — resumable)");
  });

  test("state other than paused (active/recovered/cleared) → plain line even with requiredAction: continue_later", () => {
    for (const state of ["active", "recovered", "cleared"] as const) {
      const recovery: FxRecoveryPayload = { state, requiredAction: "continue_later", attempt: 2, attemptLimit: 10 };
      expect(fxRefusedStatusLine("refused", recovery)).toBe("fx turn ended: refused");
    }
  });
});

describe("mixed session_info_update / tool_call_update sequence — lineUuid uniqueness", () => {
  test("a shared ctx across recovery, title, and tool_call_update chunks produces no duplicate lineUuids", () => {
    const ctx = makeCtx("run-MIX");
    const allChunks: { lineUuid?: string }[] = [];

    allChunks.push(
      ...mapFxUpdate(
        {
          sessionUpdate: "session_info_update",
          _meta: { fx: { modelResponseRecovery: { state: "active", attempt: 1, attemptLimit: 3 } } },
        },
        ctx,
      ),
    );
    allChunks.push(...mapFxUpdate({ sessionUpdate: "session_info_update", title: "Mixed sequence" }, ctx));
    allChunks.push(
      ...mapFxUpdate(
        { sessionUpdate: "tool_call_update", toolCallId: "tc-mix", status: "completed", rawOutput: "ok" },
        ctx,
      ),
    );
    allChunks.push(
      ...mapFxUpdate(
        {
          sessionUpdate: "session_info_update",
          _meta: {
            fx: {
              modelResponseRecovery: {
                state: "paused",
                requiredAction: "continue_later",
                message: "⚠ paused",
                attempt: 3,
                attemptLimit: 3,
              },
            },
          },
        },
        ctx,
      ),
    );
    allChunks.push(
      ...mapFxUpdate(
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-held",
          status: "failed",
          content: JSON.stringify({ error: { type: "tool_review_held", reason: "review_unavailable" } }),
        },
        ctx,
      ),
    );

    // 1 (active recovery) + 1 (title) + 1 (tool_result) + 2 (paused sentinel
    // + summary line) + 2 (tool_result + held-tool warning) = 7 chunks.
    expect(allChunks).toHaveLength(7);
    const lineUuids = allChunks.map((c) => c.lineUuid);
    expect(lineUuids.every((id) => typeof id === "string")).toBe(true);
    expect(new Set(lineUuids).size).toBe(lineUuids.length);
  });
});

describe("extractFxProviderValue", () => {
  test("well-formed configOptions with a provider entry returns its currentValue", () => {
    expect(
      extractFxProviderValue({
        configOptions: [{ id: "provider", currentValue: "gateway", options: ["gateway", "codex", "grok"] }],
      }),
    ).toBe("gateway");
  });

  test("returns the value when configOptions sits at the top level of a full session/new-shaped result, alongside sibling fields", () => {
    // The exact shape fx sends back from session/new/session/resume/session/load
    // — sessionId and modes are siblings of configOptions at the top level,
    // not nested under some other key. extractFxProviderValue reads
    // `result.configOptions` directly, so this pins that it isn't expecting
    // some wrapper object.
    expect(
      extractFxProviderValue({
        sessionId: "sess-1",
        modes: { availableModes: [{ id: "code" }, { id: "ask" }] },
        configOptions: [{ id: "provider", currentValue: "codex" }],
      }),
    ).toBe("codex");
  });

  test("finds the provider entry even when it isn't first in the array", () => {
    expect(
      extractFxProviderValue({
        configOptions: [
          { id: "some-other-option", currentValue: "x" },
          { id: "provider", currentValue: "grok" },
        ],
      }),
    ).toBe("grok");
  });

  test("configOptions missing entirely returns null", () => {
    expect(extractFxProviderValue({ sessionId: "sess-1" })).toBeNull();
    expect(extractFxProviderValue({})).toBeNull();
  });

  test("configOptions present but non-array returns null", () => {
    expect(extractFxProviderValue({ configOptions: "not-an-array" })).toBeNull();
    expect(extractFxProviderValue({ configOptions: { id: "provider", currentValue: "gateway" } })).toBeNull();
    expect(extractFxProviderValue({ configOptions: 42 })).toBeNull();
    expect(extractFxProviderValue({ configOptions: null })).toBeNull();
  });

  test("entries without an id (or a non-object entry) are skipped, not fatal", () => {
    expect(
      extractFxProviderValue({
        configOptions: [null, "a string", 42, { currentValue: "gateway" }, { id: "not-provider", currentValue: "x" }],
      }),
    ).toBeNull();
  });

  test("a provider entry with a non-string currentValue returns null", () => {
    expect(extractFxProviderValue({ configOptions: [{ id: "provider", currentValue: 42 }] })).toBeNull();
    expect(extractFxProviderValue({ configOptions: [{ id: "provider", currentValue: null }] })).toBeNull();
    expect(extractFxProviderValue({ configOptions: [{ id: "provider", currentValue: undefined }] })).toBeNull();
    expect(extractFxProviderValue({ configOptions: [{ id: "provider", currentValue: { nested: true } }] })).toBeNull();
    expect(extractFxProviderValue({ configOptions: [{ id: "provider" }] })).toBeNull();
  });

  test("a provider entry with an empty-string currentValue returns null, not the empty string", () => {
    expect(extractFxProviderValue({ configOptions: [{ id: "provider", currentValue: "" }] })).toBeNull();
  });

  test("a currentValue over 64 chars returns null; exactly 64 chars is still returned", () => {
    const at64 = "p".repeat(64);
    const over64 = "p".repeat(65);
    expect(extractFxProviderValue({ configOptions: [{ id: "provider", currentValue: at64 }] })).toBe(at64);
    expect(extractFxProviderValue({ configOptions: [{ id: "provider", currentValue: over64 }] })).toBeNull();
  });

  test("result itself being null, a primitive, or an array still returns null rather than throwing", () => {
    expect(extractFxProviderValue(null)).toBeNull();
    expect(extractFxProviderValue(undefined)).toBeNull();
    expect(extractFxProviderValue("gateway")).toBeNull();
    expect(extractFxProviderValue(42)).toBeNull();
    // An array is `typeof "object"`, so this exercises that Array.isArray on
    // its (nonexistent) .configOptions property fails closed rather than
    // throwing.
    expect(extractFxProviderValue([{ id: "provider", currentValue: "gateway" }])).toBeNull();
  });
});

describe("unknown / forward-compat sessionUpdate variants", () => {
  test("every unrecognized (or missing) kind maps to no chunks, without touching the seq counter", () => {
    const ctx = makeCtx();
    const variants = [
      "current_mode_update",
      "available_commands_update",
      "user_message_chunk",
      "session_info_update",
      "config_option_update",
      "some_future_variant",
      undefined,
    ];
    for (const kind of variants) {
      expect(mapFxUpdate({ sessionUpdate: kind }, ctx)).toEqual([]);
    }
    expect(ctx.current).toBe(0);
  });

  test("the true default branch (no dedicated case at all) still returns [] for every known no-writer kind plus an unknown future one", () => {
    const ctx = makeCtx();
    const variants = [
      "current_mode_update",
      "available_commands_update",
      "user_message_chunk",
      "config_option_update",
      "some_future_variant_2026",
    ];
    for (const kind of variants) {
      expect(mapFxUpdate({ sessionUpdate: kind }, ctx)).toEqual([]);
    }
    expect(ctx.current).toBe(0);
  });
});

describe("agent_message_chunk carrying fx [context] diagnostics", () => {
  test("a chunk made only of [context] lines maps to one status line each (blank lines dropped), one seq per line", () => {
    const ctx = makeCtx();
    const text =
      '[context] skill description "a" truncated: observed=1040 bytes effective=1024 bytes\n\n[context] skill catalog omitted 2 entries\n';
    expect(mapFxUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, ctx)).toEqual([
      {
        stream: "status",
        data: '[context] skill description "a" truncated: observed=1040 bytes effective=1024 bytes',
        lineUuid: "fx:run-1:0",
      },
      { stream: "status", data: "[context] skill catalog omitted 2 entries", lineUuid: "fx:run-1:1" },
    ]);
    expect(ctx.current).toBe(2);
  });

  test("prose that contains, follows, or merely mentions a [context] line stays a single assistant chunk", () => {
    for (const text of ["Note:\n[context] foo", "[context] foo\nbut then prose", "see the [context] docs", "[contextual] aside"]) {
      const ctx = makeCtx();
      expect(mapFxUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, ctx)).toEqual([
        { stream: "assistant", data: text, lineUuid: "fx:run-1:0" },
      ]);
    }
  });

  test("isFxContextDiagnostic: all-or-nothing over non-blank lines; blank-only text is not a diagnostic", () => {
    expect(isFxContextDiagnostic("[context] a")).toBe(true);
    expect(isFxContextDiagnostic("  [context] a\n\n[context] b\n")).toBe(true);
    expect(isFxContextDiagnostic("[context] a\nprose")).toBe(false);
    expect(isFxContextDiagnostic("\n  \n")).toBe(false);
    expect(isFxContextDiagnostic("")).toBe(false);
  });
});

describe("FxTextCoalescer", () => {
  test("consecutive same-stream deltas merge into one chunk carrying the FIRST delta's line uuid", () => {
    const c = new FxTextCoalescer();
    expect(c.push({ stream: "assistant", data: "Hello ", lineUuid: "fx:r:0" })).toEqual([]);
    expect(c.push({ stream: "assistant", data: "world", lineUuid: "fx:r:1" })).toEqual([]);
    expect(c.pending).toBe(true);
    expect(c.flush()).toEqual([{ stream: "assistant", data: "Hello world", lineUuid: "fx:r:0" }]);
    expect(c.pending).toBe(false);
    // Flushing an empty coalescer yields nothing, and doesn't throw.
    expect(c.flush()).toEqual([]);
  });

  test("a delta on the other text stream closes the open message first", () => {
    const c = new FxTextCoalescer();
    c.push({ stream: "assistant", data: "answer", lineUuid: "fx:r:0" });
    expect(c.push({ stream: "thinking", data: "hmm", lineUuid: "fx:r:1" })).toEqual([
      { stream: "assistant", data: "answer", lineUuid: "fx:r:0" },
    ]);
    expect(c.push({ stream: "thinking", data: "…", lineUuid: "fx:r:2" })).toEqual([]);
    expect(c.flush()).toEqual([{ stream: "thinking", data: "hmm…", lineUuid: "fx:r:1" }]);
  });

  test("any non-text chunk flushes buffered text AHEAD of itself and passes through in wire order", () => {
    const c = new FxTextCoalescer();
    c.push({ stream: "assistant", data: "I'll run ls", lineUuid: "fx:r:0" });
    const tool = { stream: "tool_use" as const, data: "{}", lineUuid: "fx:tool:1:use" };
    expect(c.push(tool)).toEqual([{ stream: "assistant", data: "I'll run ls", lineUuid: "fx:r:0" }, tool]);
    // Nothing buffered → a non-text chunk passes straight through alone,
    // and a uuid-less status chunk is a boundary just the same.
    expect(c.push(tool)).toEqual([tool]);
    c.push({ stream: "assistant", data: "done", lineUuid: "fx:r:3" });
    const status = { stream: "status" as const, data: "fx turn ended: max_tokens" };
    expect(c.push(status)).toEqual([{ stream: "assistant", data: "done", lineUuid: "fx:r:3" }, status]);
    expect(c.pending).toBe(false);
  });

  describe("messageId split rule (fx ≥0.0.8)", () => {
    test("two assistant chunks with differing string messageIds ('a' then 'b') flush the first as soon as the second arrives", () => {
      const c = new FxTextCoalescer();
      const a = { stream: "assistant" as const, data: "first message", lineUuid: "fx:r:0", messageId: "a" };
      const b = { stream: "assistant" as const, data: "second message", lineUuid: "fx:r:1", messageId: "b" };
      expect(c.push(a)).toEqual([]);
      // 'b' arriving is the boundary: 'a' flushes immediately, ahead of 'b'
      // ever being delivered — 'b' is now the one buffered.
      const onArrival = c.push(b);
      expect(onArrival).toEqual([{ stream: "assistant", data: "first message", lineUuid: "fx:r:0" }]);
      expect(c.pending).toBe(true);
      const onExplicitFlush = c.flush();
      expect(onExplicitFlush).toEqual([{ stream: "assistant", data: "second message", lineUuid: "fx:r:1" }]);
      // Texts intact and un-mingled: two total outputs across the sequence,
      // the first carrying 'a'-chunk's own lineUuid, the second 'b'-chunk's.
      expect(onArrival[0]!.data).toBe(a.data);
      expect(onExplicitFlush[0]!.data).toBe(b.data);
      expect(onArrival[0]!.lineUuid).toBe(a.lineUuid);
      expect(onExplicitFlush[0]!.lineUuid).toBe(b.lineUuid);
    });

    test("the same messageId across multiple deltas stays one buffered (unsplit) message", () => {
      const c = new FxTextCoalescer();
      expect(c.push({ stream: "assistant", data: "Hello ", lineUuid: "fx:r:0", messageId: "same" })).toEqual([]);
      expect(c.push({ stream: "assistant", data: "world", lineUuid: "fx:r:1", messageId: "same" })).toEqual([]);
      expect(c.flush()).toEqual([{ stream: "assistant", data: "Hello world", lineUuid: "fx:r:0" }]);
    });

    test("a messageId followed by a chunk with NO messageId does not split — a change requires BOTH sides to be strings", () => {
      const c = new FxTextCoalescer();
      expect(c.push({ stream: "assistant", data: "Hello ", lineUuid: "fx:r:0", messageId: "a" })).toEqual([]);
      expect(c.push({ stream: "assistant", data: "world", lineUuid: "fx:r:1" })).toEqual([]);
      expect(c.flush()).toEqual([{ stream: "assistant", data: "Hello world", lineUuid: "fx:r:0" }]);
    });

    test("no messageId followed by a chunk WITH one does not split either — same both-sides-string requirement", () => {
      const c = new FxTextCoalescer();
      expect(c.push({ stream: "assistant", data: "Hello ", lineUuid: "fx:r:0" })).toEqual([]);
      expect(c.push({ stream: "assistant", data: "world", lineUuid: "fx:r:1", messageId: "b" })).toEqual([]);
      expect(c.flush()).toEqual([{ stream: "assistant", data: "Hello world", lineUuid: "fx:r:0" }]);
    });

    test("the split rule applies identically to thinking chunks, not just assistant ones", () => {
      const c = new FxTextCoalescer();
      const a = { stream: "thinking" as const, data: "hmm ", lineUuid: "fx:r:0", messageId: "a" };
      const b = { stream: "thinking" as const, data: "wait", lineUuid: "fx:r:1", messageId: "b" };
      expect(c.push(a)).toEqual([]);
      expect(c.push(b)).toEqual([{ stream: "thinking", data: "hmm ", lineUuid: "fx:r:0" }]);
      expect(c.flush()).toEqual([{ stream: "thinking", data: "wait", lineUuid: "fx:r:1" }]);
    });

    // Per the task brief: verify what's actually true about whether a
    // flushed FxChunk ever retains `messageId`, rather than assuming either
    // way. Reading FxTextCoalescer.flush() (fx-acp.ts) shows it builds its
    // output object literal from only `stream`/`data`/`lineUuid` — the
    // buffered `messageId` is consulted for the split decision and then
    // discarded, never copied onto the emitted chunk. So the fact to pin is
    // at the coalescer itself, independent of `emit`/`deliver` (which are
    // unexported and out of this pure-mapper file's reach): a flushed chunk
    // never carries a `messageId` key, regardless of what the buffered
    // input(s) carried.
    test("a flushed chunk never carries a messageId field, even though the input chunk did", () => {
      const c = new FxTextCoalescer();
      c.push({ stream: "assistant", data: "hi", lineUuid: "fx:r:0", messageId: "a" });
      const [flushed] = c.flush();
      expect(flushed).toBeDefined();
      expect("messageId" in flushed!).toBe(false);
    });
  });
});

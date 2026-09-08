import { describe, test, expect } from "bun:test";
import {
  FX_SESSION_TITLE_MAX_LEN,
  FxTextCoalescer,
  extractFxProviderValue,
  isFxContextDiagnostic,
  mapFxUpdate,
} from "./fx-acp.ts";
import type { FxUpdateCtx } from "./fx-acp.ts";
import { FX_USAGE_STATUS_PREFIX, FX_SESSION_TITLE_STATUS_PREFIX } from "../shared/types.ts";
import { deriveTodoProgress } from "../shared/todo-progress.ts";

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
 *  across calls in production. */
function makeCtx(runId = "run-1"): FxUpdateCtx & { readonly current: number } {
  let seq = 0;
  return {
    runId,
    nextSeq: () => seq++,
    lastTitle: undefined,
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

  test("the legacy pre-0.0.8 shape (_meta.fx.modelResponseRecovery, no title) emits nothing", () => {
    const ctx = makeCtx();
    const chunks = mapFxUpdate(
      {
        sessionUpdate: "session_info_update",
        _meta: { fx: { modelResponseRecovery: { attempted: true, succeeded: true } } },
      },
      ctx,
    );
    expect(chunks).toEqual([]);
    expect(ctx.lastTitle).toBeUndefined();
  });

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

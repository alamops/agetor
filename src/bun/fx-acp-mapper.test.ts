import { describe, test, expect } from "bun:test";
import { extractFxProviderValue, mapFxUpdate } from "./fx-acp.ts";
import { FX_USAGE_STATUS_PREFIX } from "../shared/types.ts";
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
 *  test can assert "the counter did not move" without guessing. */
function makeCtx(runId = "run-1") {
  let seq = 0;
  return {
    runId,
    nextSeq: () => seq++,
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
});

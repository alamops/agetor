import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FX_USAGE_STATUS_PREFIX, type FxUsagePayload } from "../shared/types.ts";
import { deriveTodoProgress } from "../shared/todo-progress.ts";

// opencode-events.ts reuses the tmux mapper's helpers, so it transitively loads db.ts, which captures
// AGETOR_DATA_DIR at first import: set it at module top level and load the modules dynamically.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-opencode-events-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

const { createOpencodeEventMapper, snapshotToChunks } = await import("./opencode-events.ts");
const { mapOpencodePart, mapOpencodeEvent, createOpencodeMapCtx } = await import("./opencode-tmux.ts");
const { rmTestDataDir } = await import("./test-data-dir.ts");
type OpencodeMappedChunk = import("./opencode-events.ts").OpencodeMappedChunk;
type OpencodeEventLike = import("./opencode-events.ts").OpencodeEventLike;

afterAll(() => {
  rmTestDataDir(DATA_DIR);
});

const FIXTURES = path.join(import.meta.dir, "fixtures", "opencode");
function jsonl<T = Record<string, any>>(name: string): T[] {
  return readFileSync(path.join(FIXTURES, name), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}
function events(name: string): OpencodeEventLike[] {
  return jsonl<OpencodeEventLike>(name);
}
function sessionOf(evts: OpencodeEventLike[]): string {
  const e = evts.find((x) => (x.data as any)?.sessionID);
  return (e!.data as any).sessionID as string;
}
function feedAll(m: ReturnType<typeof createOpencodeEventMapper>, evts: OpencodeEventLike[]): OpencodeMappedChunk[] {
  return evts.flatMap((e) => m.feed(e));
}
function run(name: string) {
  const evts = events(name);
  const sessionId = sessionOf(evts);
  const mapper = createOpencodeEventMapper({ sessionId });
  return { evts, sessionId, mapper, chunks: feedAll(mapper, evts) };
}
function usageOf(c: OpencodeMappedChunk): FxUsagePayload {
  expect(c.stream).toBe("status");
  expect(c.data.startsWith(FX_USAGE_STATUS_PREFIX)).toBe(true);
  return JSON.parse(c.data.slice(FX_USAGE_STATUS_PREFIX.length)) as FxUsagePayload;
}
const isUsage = (c: OpencodeMappedChunk) => c.stream === "status" && c.data.startsWith(FX_USAGE_STATUS_PREFIX);
const uuids = (cs: OpencodeMappedChunk[]) => cs.map((c) => c.lineUuid);
/** `uuid → stream + data` as a sorted array (array diffs print fast; a Map diff can stall bun). */
function byUuid(cs: OpencodeMappedChunk[]): string[] {
  return cs.map((c) => `${c.lineUuid}\u0000${c.stream}\u0000${c.data}`).sort();
}

describe("basic tool turn (v2-http-tool-turn)", () => {
  const { chunks, mapper, sessionId } = run("v2-http-tool-turn.jsonl");

  test("tool_use, tool_result, usage per step and the final text, in order; nothing from ignored events", () => {
    expect(chunks.map((c) => c.stream)).toEqual(["tool_use", "tool_result", "status", "assistant", "status"]);
    const use = JSON.parse(chunks[0]!.data);
    expect(use).toEqual({ id: "call_fixture0001", name: "shell", input: { command: "echo hi" }, serverSide: false });
    expect(JSON.parse(chunks[1]!.data)).toEqual({ toolUseId: "call_fixture0001", content: "hi\n", isError: false });
    expect(chunks[3]).toMatchObject({ stream: "assistant", data: "OK" });
    expect(chunks[0]!.lineUuid).toBe(`opencode:${sessionId}:tool:call_fixture0001:use`);
    expect(chunks[1]!.lineUuid).toBe(`opencode:${sessionId}:tool:call_fixture0001:result`);
    expect(chunks[3]!.lineUuid).toBe(`opencode:${sessionId}:text:msg_fixture0003:0`);
    expect(new Set(uuids(chunks)).size).toBe(chunks.length);
  });

  test("terminal() is succeeded after session.execution.succeeded", () => {
    expect(mapper.terminal()).toEqual({ outcome: "succeeded" });
  });

  test("usage is cumulative per step; session.usage.updated is not counted twice", () => {
    const usages = chunks.filter(isUsage).map(usageOf);
    expect(usages).toHaveLength(2);
    expect(usages[0]!.turn).toMatchObject({ inputTokens: 12596, outputTokens: 39, cacheReadTokens: 0 });
    expect(usages[1]!.turn).toMatchObject({ inputTokens: 12596 + 232, outputTokens: 39 + 3, cacheReadTokens: 12416 });
    expect(usages[1]!.cost!.amount).toBeCloseTo(0.0019128 + 0.000073848, 9);
    expect(mapper.usage()).toMatchObject({ input: 12828, output: 42, reasoning: 0, cacheRead: 12416, cacheWrite: 0 });
  });

  test("events of another session map to nothing", () => {
    const other = createOpencodeEventMapper({ sessionId: "ses_somebody_else" });
    expect(feedAll(other, events("v2-http-tool-turn.jsonl"))).toEqual([]);
    expect(other.terminal()).toBeNull();
  });
});

describe("shape compatibility with the tmux mapper", () => {
  const { chunks, sessionId } = run("v2-http-tool-turn.jsonl");

  test("tool_use / tool_result / assistant data are byte-identical to mapOpencodePart for the equivalent part", () => {
    const part = {
      type: "tool",
      partID: "prt_x",
      id: "call_fixture0001",
      tool: "shell",
      state: { status: "completed", input: { command: "echo hi" }, output: "hi\n", title: "shell" },
    };
    const [tmuxUse, tmuxResult] = mapOpencodePart(part).chunks;
    expect(chunks[0]!.stream).toBe(tmuxUse!.stream);
    expect(chunks[0]!.data).toBe(tmuxUse!.data);
    expect(chunks[1]!.stream).toBe(tmuxResult!.stream);
    expect(chunks[1]!.data).toBe(tmuxResult!.data);
    const [tmuxText] = mapOpencodePart({ type: "text", id: "prt_t", text: "OK" }).chunks;
    expect(chunks[3]).toMatchObject({ stream: tmuxText!.stream, data: tmuxText!.data });
  });

  test("a failed tool is byte-identical to the tmux error part", () => {
    const m = createOpencodeEventMapper({ sessionId: "ses_s" });
    m.feed({ type: "session.tool.input.started", data: { sessionID: "ses_s", assistantMessageID: "msg_a", id: "call_1", name: "read" } });
    const [, res] = [
      ...m.feed({ type: "session.tool.called", data: { sessionID: "ses_s", assistantMessageID: "msg_a", id: "call_1", input: { filePath: "x" } } }),
      ...m.feed({ type: "session.tool.failed", data: { sessionID: "ses_s", assistantMessageID: "msg_a", id: "call_1", error: { type: "x", message: "File not found" } } }),
    ];
    const part = { type: "tool", partID: "prt_x", id: "call_1", tool: "read", state: { status: "error", input: { filePath: "x" }, error: "File not found" } };
    expect(res!.data).toBe(mapOpencodePart(part).chunks[1]!.data);
  });

  test("thinking data equals the tmux reasoning chunk", () => {
    const m = createOpencodeEventMapper({ sessionId: "ses_s" });
    const [c] = m.feed({ type: "session.reasoning.ended", data: { sessionID: "ses_s", assistantMessageID: "msg_a", ordinal: 0, text: "hmm" } });
    const [t] = mapOpencodePart({ type: "reasoning", id: "prt_r", text: "hmm" }).chunks;
    expect(c).toMatchObject({ stream: t!.stream, data: t!.data });
  });

  test("the usage status line equals the tmux step_finish line for the same tokens", () => {
    const ctx = createOpencodeMapCtx(2);
    const line = JSON.stringify({
      type: "step_finish",
      sessionID: sessionId,
      part: { id: "prt_f", type: "step-finish", cost: 0.0019127999999999999, tokens: { input: 12596, output: 39, reasoning: 0, cache: { read: 0, write: 0 } } },
    });
    const tmux = mapOpencodeEvent(line, ctx, 0).chunks[0]!;
    expect(chunks.find(isUsage)!.data).toBe(tmux.data);
  });
});

describe("reasoning and todowrite (v2-http-todowrite)", () => {
  const { chunks } = run("v2-http-todowrite.jsonl");

  test("reasoning.ended becomes one thinking chunk with the full text", () => {
    const thinking = chunks.filter((c) => c.stream === "thinking");
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({ data: "Write the todo list, then reply OK.", lineUuid: "opencode:ses_fixture0010:reasoning:msg_fixture0011:0" });
  });

  test("todowrite surfaces as TodoWrite with {content,status} only (cancelled reads as completed)", () => {
    const use = chunks.find((c) => c.stream === "tool_use")!;
    expect(JSON.parse(use.data)).toMatchObject({
      name: "TodoWrite",
      input: { todos: [{ content: "alpha", status: "completed" }, { content: "beta", status: "pending" }, { content: "gamma", status: "completed" }] },
    });
    const progress = deriveTodoProgress(chunks);
    expect(progress).toMatchObject({ completed: 2, total: 3 });
  });
});

describe("errors, quota hint and retry", () => {
  test("402: one status line with the quota hint (step.failed and execution.failed do not double); terminal failed", () => {
    const { chunks, mapper } = run("v2-http-quota-402.jsonl");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.stream).toBe("status");
    expect(chunks[0]!.data).toStartWith("opencode: Upstream request failed: Insufficient account funds — the model's provider has no balance");
    expect(chunks[0]!.data).toContain("(OpenCode Go)");
    expect(chunks[0]!.lineUuid).toBe("opencode:ses_fixture0020:error:msg_fixture0021");
    expect(mapper.terminal()).toEqual({ outcome: "failed", error: "Upstream request failed: Insufficient account funds" });
  });

  test("execution.failed alone (no failing step) yields its own status line", () => {
    const evts = events("v2-http-quota-402.jsonl").filter((e) => e.type !== "session.step.failed");
    const m = createOpencodeEventMapper({ sessionId: "ses_fixture0020" });
    const chunks = feedAll(m, evts);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.lineUuid).toBe("opencode:ses_fixture0020:error:execution:1");
    expect(chunks[0]!.data).toContain("Insufficient account funds");
  });

  test("a non-quota error has no hint", () => {
    const m = createOpencodeEventMapper({ sessionId: "ses_s" });
    const [c] = m.feed({ type: "session.execution.failed", data: { sessionID: "ses_s", error: { type: "provider.no-route", message: "Model unavailable" } } });
    expect(c!.data).toBe("opencode: Model unavailable");
  });

  test("retry.scheduled yields one status line per attempt", () => {
    const { chunks, mapper } = run("v2-http-retry.jsonl");
    const retries = chunks.filter((c) => c.data.includes("retrying"));
    expect(retries.map((c) => c.data)).toEqual([
      "opencode: Rate limited by the provider (retry after 5s) — retrying (attempt 1)",
      "opencode: Rate limited by the provider (retry after 5s) — retrying (attempt 2)",
    ]);
    expect(retries[0]!.lineUuid).not.toBe(retries[1]!.lineUuid);
    expect(chunks.find((c) => c.stream === "assistant")).toMatchObject({ data: "Done." });
    expect(mapper.terminal()).toEqual({ outcome: "succeeded" });
  });
});

describe("interrupt and steer", () => {
  test("interrupted: aborted tool is an error result, the aborted step prints no error but keeps its tokens, terminal interrupted(user)", () => {
    const evts = events("v2-http-interrupt.jsonl");
    const cut = evts.findIndex((e) => e.type === "session.execution.interrupted") + 1;
    const sessionId = sessionOf(evts);
    const m = createOpencodeEventMapper({ sessionId });
    const chunks = feedAll(m, evts.slice(0, cut));
    expect(m.terminal()).toEqual({ outcome: "interrupted", reason: "user" });
    expect(chunks.map((c) => c.stream)).toEqual(["thinking", "tool_use", "tool_result", "status"]);
    expect(JSON.parse(chunks[2]!.data)).toMatchObject({ content: "Tool execution interrupted", isError: true });
    expect(isUsage(chunks[3]!)).toBe(true);
    expect(chunks.some((c) => c.stream === "status" && c.data.startsWith("opencode:"))).toBe(false);
  });

  test("a later session.execution.started clears the terminal; the next execution succeeds", () => {
    const evts = events("v2-http-interrupt.jsonl");
    const m = createOpencodeEventMapper({ sessionId: sessionOf(evts) });
    const chunks = feedAll(m, evts);
    expect(m.terminal()).toEqual({ outcome: "succeeded" });
    expect(chunks.filter((c) => c.stream === "assistant").map((c) => c.data)).toEqual(["READY"]);
    // Both executions' usage accumulates into the same (lifetime) totals.
    expect(m.usage().output).toBe(57 + 3);
  });

  test("steer: two user deliveries in one execution map to one tool call, one answer, one terminal", () => {
    const { evts, chunks, mapper } = run("v2-http-steer.jsonl");
    expect(evts.filter((e) => e.type === "session.inbox.enqueued")).toHaveLength(2);
    expect(chunks.filter((c) => c.stream === "assistant").map((c) => c.data)).toEqual(["DONE\n\nBANANA"]);
    expect(chunks.filter((c) => c.stream === "tool_use")).toHaveLength(1);
    expect(chunks.filter((c) => c.stream === "tool_result")).toHaveLength(1);
    expect(chunks.filter(isUsage)).toHaveLength(2);
    expect(mapper.terminal()).toEqual({ outcome: "succeeded" });
    expect(new Set(uuids(chunks)).size).toBe(chunks.length);
  });
});

describe("subagent: parent and child interleaved on one event stream (v2-http-subagent)", () => {
  const evts = events("v2-http-subagent.jsonl");
  const created = evts.find((e) => e.type === "session.created")!.data as any;
  const child = created.sessionID as string;
  const parent = created.parentID as string;

  test("each mapper keeps only its own session's events", () => {
    const p = createOpencodeEventMapper({ sessionId: parent });
    const c = createOpencodeEventMapper({ sessionId: child });
    const pc = feedAll(p, evts);
    const cc = feedAll(c, evts);
    expect(pc.length).toBeGreaterThan(0);
    expect(cc.length).toBeGreaterThan(0);
    expect(pc.every((x) => x.lineUuid.startsWith(`opencode:${parent}:`))).toBe(true);
    expect(cc.every((x) => x.lineUuid.startsWith(`opencode:${child}:`))).toBe(true);
    expect(cc.some((x) => x.stream === "tool_result" && x.data.includes("CHILD"))).toBe(true);
    expect(p.terminal()).toEqual({ outcome: "succeeded" });
    expect(c.terminal()).toEqual({ outcome: "succeeded" });
  });
});

describe("snapshotToChunks", () => {
  const messages = jsonl("v2-http-messages-tool-turn.jsonl");
  const userId = messages[0]!.id as string;
  const sessionId = sessionOf(events("v2-http-tool-turn.jsonl"));

  test("maps assistant messages after the anchor user message; user and idle messages produce nothing", () => {
    const snap = snapshotToChunks(messages, { sessionId, afterUserMessageId: userId });
    expect(snap.map((c) => c.stream)).toEqual(["tool_use", "tool_result", "status", "assistant", "status"]);
    expect(snapshotToChunks(messages, { sessionId })).toEqual(snap);
  });

  test("an anchor that is not in the page maps nothing; messages before the anchor are skipped", () => {
    expect(snapshotToChunks(messages, { sessionId, afterUserMessageId: "msg_nope" })).toEqual([]);
    const two = [...messages.slice(0, 1), ...messages.slice(1), { ...messages[0], id: "msg_user2" }, { ...messages[2], id: "msg_fixture0042" }];
    const after = snapshotToChunks(two, { sessionId, afterUserMessageId: "msg_user2" });
    expect(after.map((c) => c.stream)).toEqual(["assistant", "status"]);
    expect(after[0]!.lineUuid).toBe(`opencode:${sessionId}:text:msg_fixture0042:0`);
  });

  test("a running tool yields only its tool_use; a streaming tool nothing", () => {
    const running = structuredClone(messages);
    const tool = (running[1] as any).content[0];
    tool.state = { status: "running", input: { command: "echo hi" }, metadata: {} };
    const snap = snapshotToChunks(running, { sessionId, afterUserMessageId: userId });
    expect(snap.filter((c) => c.stream === "tool_use")).toHaveLength(1);
    expect(snap.filter((c) => c.stream === "tool_result")).toHaveLength(0);
    tool.state = { status: "streaming", input: '{"comm' };
    expect(snapshotToChunks(running, { sessionId, afterUserMessageId: userId }).filter((c) => c.stream.startsWith("tool_"))).toEqual([]);
  });

  test("a failed tool and an assistant error are mapped like their live counterparts", () => {
    const quota = snapshotToChunks(jsonl("v2-http-messages-quota-402.jsonl"), { sessionId: "ses_fixture0020", afterUserMessageId: "msg_fixture0020" });
    const live = run("v2-http-quota-402.jsonl").chunks;
    expect(quota).toEqual(live);
  });

  test("never throws on garbage", () => {
    for (const bad of [null, undefined, 5, "x", [null, 5, "x", [], {}], [{ type: "assistant" }], [{ id: "m", type: "assistant", content: "oops" }], [{ id: "m", type: "assistant", content: [null, { type: "tool" }, { type: "tool", id: "c", state: 3 }, { type: "text", text: 5 }] }]]) {
      expect(() => snapshotToChunks(bad as any, { sessionId })).not.toThrow();
    }
    expect(snapshotToChunks([{ id: "m", type: "assistant", content: "oops" }], { sessionId })).toEqual([]);
  });
});

describe("snapshot then live: every line uuid exactly once (I5)", () => {
  for (const [events_, messages_] of [
    ["v2-http-tool-turn.jsonl", "v2-http-messages-tool-turn.jsonl"],
    ["v2-http-todowrite.jsonl", "v2-http-messages-todowrite.jsonl"],
  ] as const) {
    describe(events_, () => {
      const evts = events(events_);
      const sessionId = sessionOf(evts);
      const messages = jsonl(messages_);
      const anchor = messages[0]!.id as string;
      const live = run(events_).chunks;

      test("snapshot chunks and live chunks agree on uuid AND content", () => {
        const snap = snapshotToChunks(messages, { sessionId, afterUserMessageId: anchor });
        expect(byUuid(snap)).toEqual(byUuid(live));
        expect(uuids(snap)).toEqual(uuids(live));
      });

      test("a mapper seeded with the full snapshot emits nothing when the same turn replays live", () => {
        const m = createOpencodeEventMapper({ sessionId });
        const seeded = m.seedFromSnapshot(messages, { afterUserMessageId: anchor });
        expect(seeded.length).toBe(live.length);
        expect(feedAll(m, evts)).toEqual([]);
        expect(m.usage()).toEqual(run(events_).mapper.usage());
        expect(m.terminal()).toEqual({ outcome: "succeeded" });
      });

      test("mid-turn snapshot (first step in flight) + the remaining live events == the whole turn, once each", () => {
        // Snapshot: the first assistant message exists with its tool still running, nothing after.
        const partial = structuredClone(messages.slice(0, 2));
        const am = partial[1] as any;
        delete am.tokens;
        delete am.cost;
        delete am.finish;
        delete am.time.completed;
        am.content = am.content.map((c: any) =>
          c.type === "tool" ? { ...c, state: { status: "running", input: c.state.input, metadata: {} } } : c,
        );
        const m = createOpencodeEventMapper({ sessionId });
        const seeded = m.seedFromSnapshot(partial, { afterUserMessageId: anchor });
        // Live resumes after the tool was called: the subscription sees everything from tool.success on.
        const from = evts.findIndex((e) => e.type === "session.tool.success");
        const rest = feedAll(m, evts.slice(from));
        const all = [...seeded, ...rest];
        expect(uuids(all).sort()).toEqual(uuids(live).sort());
        expect(new Set(uuids(all)).size).toBe(all.length);
        expect(m.usage()).toEqual(run(events_).mapper.usage());
      });

      test("replaying the whole live stream into a snapshot-seeded mapper after live already ran adds nothing", () => {
        const m = createOpencodeEventMapper({ sessionId });
        const first = feedAll(m, evts);
        expect(first.length).toBe(live.length);
        expect(m.seedFromSnapshot(messages, { afterUserMessageId: anchor })).toEqual([]);
        expect(feedAll(m, evts)).toEqual([]);
        expect(m.usage()).toEqual(run(events_).mapper.usage());
      });
    });
  }

  test("a tool whose input was still streaming in the snapshot gets its name from the seed", () => {
    const m = createOpencodeEventMapper({ sessionId: "ses_s" });
    m.seedFromSnapshot(
      [
        { id: "msg_u", type: "user", text: "go" },
        { id: "msg_a", type: "assistant", content: [{ type: "tool", id: "call_1", name: "todowrite", state: { status: "streaming", input: "{" } }] },
      ],
      { afterUserMessageId: "msg_u" },
    );
    const [use] = m.feed({ type: "session.tool.called", data: { sessionID: "ses_s", assistantMessageID: "msg_a", id: "call_1", input: { todos: [{ content: "a", status: "pending" }] } } });
    expect(JSON.parse(use!.data).name).toBe("TodoWrite");
  });
});

describe("mapper lifecycle and robustness", () => {
  test("reset() forgets terminal, usage and produced uuids", () => {
    const { evts, mapper, chunks } = run("v2-http-tool-turn.jsonl");
    expect(mapper.terminal()).not.toBeNull();
    mapper.reset();
    expect(mapper.terminal()).toBeNull();
    expect(mapper.usage()).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
    expect(feedAll(mapper, evts)).toEqual(chunks);
  });

  test("terminal() and usage() return copies", () => {
    const { mapper } = run("v2-http-tool-turn.jsonl");
    (mapper.usage() as any).input = 1;
    (mapper.terminal() as any).outcome = "failed";
    expect(mapper.usage().input).toBe(12828);
    expect(mapper.terminal()!.outcome).toBe("succeeded");
  });

  test("malformed frames never throw and produce nothing", () => {
    const m = createOpencodeEventMapper({ sessionId: "ses_s" });
    const bad: unknown[] = [
      null,
      undefined,
      42,
      "session.text.ended",
      [],
      {},
      { type: 7 },
      { type: "session.text.ended" },
      { type: "session.text.ended", data: "x" },
      { type: "session.text.ended", data: null },
      { type: "session.text.ended", data: { sessionID: "ses_s" } },
      { type: "session.text.ended", data: { sessionID: "ses_s", assistantMessageID: "m", ordinal: -1, text: "x" } },
      { type: "session.text.ended", data: { sessionID: "ses_s", assistantMessageID: "m", ordinal: 0, text: 5 } },
      { type: "session.text.ended", data: { sessionID: "ses_s", assistantMessageID: "m", ordinal: 0, text: "" } },
      { type: "session.reasoning.ended", data: { sessionID: "ses_s", assistantMessageID: "m", ordinal: 0 } },
      { type: "session.tool.called", data: { sessionID: "ses_s" } },
      { type: "session.tool.success", data: { sessionID: "ses_s", id: "" } },
      { type: "session.tool.failed", data: { sessionID: "ses_s", id: 3 } },
      { type: "session.step.ended", data: { sessionID: "ses_s" } },
      { type: "session.retry.scheduled", data: { sessionID: "ses_s", assistantMessageID: "m" } },
      { type: "session.unknown.future", data: { sessionID: "ses_s" } },
      { type: "session.inbox.delivered", data: { sessionID: "ses_s", inboxID: "i" } },
    ];
    for (const b of bad) expect(m.feed(b as any)).toEqual([]);
    expect(m.terminal()).toBeNull();
  });

  test("a tool called without a prior input.started falls back to the generic name; a tool result needs no name", () => {
    const m = createOpencodeEventMapper({ sessionId: "ses_s" });
    const [use] = m.feed({ type: "session.tool.called", data: { sessionID: "ses_s", assistantMessageID: "m", id: "c1", input: { a: 1 } } });
    expect(JSON.parse(use!.data)).toMatchObject({ id: "c1", name: "tool", input: { a: 1 } });
    const [res] = m.feed({ type: "session.tool.success", data: { sessionID: "ses_s", assistantMessageID: "m", id: "c1", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } });
    expect(JSON.parse(res!.data).content).toBe("a\nb");
  });

  test("a failed tool without content keeps the error text (permission reject reason)", () => {
    const m = createOpencodeEventMapper({ sessionId: "ses_s" });
    const [res] = m.feed({ type: "session.tool.failed", data: { sessionID: "ses_s", assistantMessageID: "m", id: "c1", error: { type: "permission.rejected", message: "no thanks" } } });
    expect(JSON.parse(res!.data)).toEqual({ toolUseId: "c1", content: "no thanks", isError: true });
  });
});

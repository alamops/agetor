import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FX_USAGE_STATUS_PREFIX, type FxUsagePayload } from "../shared/types.ts";
import { deriveTodoProgress } from "../shared/todo-progress.ts";
import { mapOpencodePart, opencodeUsagePayload } from "./opencode-map-helpers.ts";
import {
  createOpencodeEventMapper,
  __forTest as eventsForTest,
  type OpencodeEventLike,
  type OpencodeMappedChunk,
} from "./opencode-events.ts";

const { snapshotToChunks } = eventsForTest;

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
  const { chunks } = run("v2-http-tool-turn.jsonl");

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
    // The tmux mapper builds its line from exactly these two helpers.
    const expected = FX_USAGE_STATUS_PREFIX + JSON.stringify(opencodeUsagePayload({ input: 12596, output: 39, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.0019127999999999999 }));
    expect(chunks.find(isUsage)!.data).toBe(expected);
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
    expect(chunks[0]!.lineUuid).toBe("opencode:ses_fixture0020:error:execution:msg_fixture0021");
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
    // Each mapper's output equals what it produces from ONLY its own session's events: a missing
    // session filter would also stamp the other session's content with this session's uuid prefix.
    const own = (id: string) => evts.filter((e) => (e.data as any)?.sessionID === id);
    expect(pc).toEqual(feedAll(createOpencodeEventMapper({ sessionId: parent }), own(parent)));
    expect(cc).toEqual(feedAll(createOpencodeEventMapper({ sessionId: child }), own(child)));
    expect(own(parent).length + own(child).length).toBeLessThan(evts.length + 1);
    expect(pc.filter((x) => x.stream === "tool_use").length).toBe(1);
    expect(cc.filter((x) => x.stream === "tool_use").length).toBe(1);
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
      { type: "session.tool.input.ended", data: { sessionID: "ses_s", assistantMessageID: "m", id: "c1", text: "{}" } },
      { type: "session.tool.input.delta", data: { sessionID: "ses_s", assistantMessageID: "m", id: "c1", delta: "{" } },
      { type: "session.tool.progress", data: { sessionID: "ses_s", assistantMessageID: "m", id: "c1", metadata: {} } },
      { type: "session.usage.updated", data: { sessionID: "ses_s", cost: 1, tokens: { input: 1, output: 1 } } },
      { type: "permission.asked", data: { sessionID: "ses_s" } },
      { type: "form.created", data: { sessionID: "ses_s" } },
      { type: "session.agent.selected", data: { sessionID: "ses_s", agent: "build" } },
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

/* ── fix round: provisional blocks, paging, error state, name fallback, usage gating ────────────── */

const SID = "ses_prov";
const MODEL = { id: "m", providerID: "p" };
function user(id: string) {
  return { id, type: "user", text: "go", time: { created: 1 } };
}
function assistant(id: string, content: unknown[], extra: Record<string, unknown> = {}) {
  return { id, type: "assistant", agent: "build", model: MODEL, content, time: { created: 2 }, ...extra };
}
const done = (extra: Record<string, unknown> = {}) => ({ time: { created: 2, completed: 3 }, finish: "stop", ...extra });
const textEnded = (msg: string, ordinal: number, text: string): OpencodeEventLike => ({
  type: "session.text.ended",
  data: { sessionID: SID, assistantMessageID: msg, ordinal, text },
});
const tok = (input: number) => ({ input, output: 1, reasoning: 0, cache: { read: 0, write: 0 } });

describe("snapshot of a streaming message (R-M2: blocks are empty until their .ended)", () => {
  test("an empty text/reasoning item of an unfinished message emits nothing and records no uuid; the live .ended inserts it", () => {
    const m = createOpencodeEventMapper({ sessionId: SID });
    const seeded = m.seedFromSnapshot(
      [user("u"), assistant("a", [{ type: "reasoning", text: "" }, { type: "text", text: "" }])],
      { afterUserMessageId: "u" },
    );
    expect(seeded).toEqual([]);
    expect(m.provisionalUuids()).toEqual([]);
    expect(m.feed(textEnded("a", 0, "the whole answer"))).toEqual([
      { stream: "assistant", data: "the whole answer", lineUuid: `opencode:${SID}:text:a:0` },
    ]);
    const [r] = m.feed({ type: "session.reasoning.ended", data: { sessionID: SID, assistantMessageID: "a", ordinal: 0, text: "hmm" } });
    expect(r).toEqual({ stream: "thinking", data: "hmm", lineUuid: `opencode:${SID}:reasoning:a:0` });
    expect(m.feed(textEnded("a", 0, "the whole answer"))).toEqual([]);
  });

  test("a non-empty item of an unfinished message is final: emitted once, its live .ended dropped, nothing replaced", () => {
    const m = createOpencodeEventMapper({ sessionId: SID });
    const seeded = m.seedFromSnapshot(
      [user("u"), assistant("a", [{ type: "text", text: "block one" }, { type: "text", text: "" }])],
      { afterUserMessageId: "u" },
    );
    expect(seeded).toEqual([{ stream: "assistant", data: "block one", lineUuid: `opencode:${SID}:text:a:0` }]);
    expect(m.provisionalUuids()).toEqual([]);
    expect(m.feed(textEnded("a", 0, "block one"))).toEqual([]);
    expect(m.feed(textEnded("a", 1, "block two")).map((c) => [c.lineUuid.slice(-1), c.replace])).toEqual([["1", undefined]]);
  });

  test("a lost .ended is recovered by seeding again: only the missing uuid is emitted", () => {
    const m = createOpencodeEventMapper({ sessionId: SID });
    m.seedFromSnapshot([user("u"), assistant("a", [{ type: "text", text: "" }])], { afterUserMessageId: "u" });
    const again = m.seedFromSnapshot(
      [user("u"), assistant("a", [{ type: "text", text: "final" }], done({ tokens: tok(5) }))],
      { afterUserMessageId: "u" },
    );
    expect(again.map((c) => [c.stream, c.replace])).toEqual([["assistant", undefined], ["status", undefined]]);
    expect(m.seedFromSnapshot([user("u"), assistant("a", [{ type: "text", text: "final" }], done({ tokens: tok(5) }))], { afterUserMessageId: "u" })).toEqual([]);
    expect(m.usage().input).toBe(5);
  });
});

describe("paged seeding (R-S4)", () => {
  const older = [user("u0"), assistant("a0", [{ type: "text", text: "old" }], done({ tokens: tok(7) }))];
  const page1 = [user("u"), assistant("a1", [{ type: "text", text: "one" }], done({ tokens: tok(200), cost: 0.5 }))];
  const page2 = [assistant("a2", [{ type: "text", text: "two" }], done({ tokens: tok(100), cost: 0.25 })), { id: "i", type: "idle", outcome: "succeeded" }];

  test("totals merge across pages; the anchor may be on an earlier page; pages before it map nothing", () => {
    const m = createOpencodeEventMapper({ sessionId: SID });
    const seed = m.beginSeed({ afterUserMessageId: "u" });
    expect(seed.push(older)).toEqual([]);
    expect(seed.anchorFound()).toBe(false);
    const c1 = seed.push(page1);
    const c2 = seed.push(page2);
    expect(seed.anchorFound()).toBe(true);
    seed.end();
    expect(seed.push(page2)).toEqual([]);
    const usages = [...c1, ...c2].filter(isUsage).map(usageOf);
    expect(usages.map((u) => u.turn!.inputTokens)).toEqual([200, 300]);
    expect(usages[1]!.cost!.amount).toBeCloseTo(0.75, 9);
    expect(m.usage()).toMatchObject({ input: 300, output: 2 });
    expect([...c1, ...c2].filter((c) => c.stream === "assistant").map((c) => c.data)).toEqual(["one", "two"]);
    // A live step.ended for an already-seeded message adds nothing.
    expect(m.feed({ type: "session.step.ended", data: { sessionID: SID, assistantMessageID: "a2", finish: "stop", cost: 0.25, tokens: tok(100) } })).toEqual([]);
    expect(m.usage().input).toBe(300);
  });

  test("an anchor that never shows up maps nothing", () => {
    const m = createOpencodeEventMapper({ sessionId: SID });
    const seed = m.beginSeed({ afterUserMessageId: "missing" });
    expect(seed.push(older)).toEqual([]);
    expect(seed.push(page2)).toEqual([]);
    expect(seed.anchorFound()).toBe(false);
  });

  test("seedFromSnapshot is the one-page case and equals a one-push seed", () => {
    const a = createOpencodeEventMapper({ sessionId: SID });
    const b = createOpencodeEventMapper({ sessionId: SID });
    const all = [...page1, ...page2];
    const viaSeed = b.beginSeed({ afterUserMessageId: "u" }).push(all);
    expect(a.seedFromSnapshot(all, { afterUserMessageId: "u" })).toEqual(viaSeed);
    expect(a.usage()).toEqual(b.usage());
  });
});

describe("seed restores error state (R-S5)", () => {
  const quotaErr = { type: "provider.quota", message: "Insufficient account funds", status: 402 };

  test("step.failed seen only in the snapshot: execution.failed does not print the line again", () => {
    const m = createOpencodeEventMapper({ sessionId: SID });
    const seeded = m.seedFromSnapshot([user("u"), assistant("a", [], { error: quotaErr, time: { created: 2, completed: 3 } })], { afterUserMessageId: "u" });
    expect(seeded.map((c) => c.lineUuid)).toEqual([`opencode:${SID}:error:a`]);
    expect(m.feed({ type: "session.execution.failed", data: { sessionID: SID, error: quotaErr } })).toEqual([]);
    expect(m.terminal()).toMatchObject({ outcome: "failed" });
  });

  test("the execution error uuid is keyed on the last assistant message, live or seeded, never a counter", () => {
    const live = createOpencodeEventMapper({ sessionId: SID });
    live.feed({ type: "session.step.started", data: { sessionID: SID, assistantMessageID: "a" } });
    const seeded = createOpencodeEventMapper({ sessionId: SID });
    seeded.seedFromSnapshot([user("u"), assistant("a", [{ type: "text", text: "x" }], done())], { afterUserMessageId: "u" });
    const fail = { type: "session.execution.failed", data: { sessionID: SID, error: { type: "x", message: "boom" } } };
    expect(live.feed(fail)).toEqual(seeded.feed(fail));
    expect(live.feed(fail)).toEqual([]);
    expect(createOpencodeEventMapper({ sessionId: SID }).feed(fail)[0]!.lineUuid).toBe(`opencode:${SID}:error:execution:none`);
  });
});

describe("a live chunk fed before the seed (R-S6)", () => {
  const todos = { todos: [{ content: "a", status: "pending" }] };
  const called: OpencodeEventLike = { type: "session.tool.called", data: { sessionID: SID, assistantMessageID: "a", id: "c1", input: todos, executed: false } };

  test("a tool_use emitted with the generic name is replaced with the real name when the snapshot arrives", () => {
    const m = createOpencodeEventMapper({ sessionId: SID });
    const [first] = m.feed(called);
    expect(JSON.parse(first!.data).name).toBe("tool");
    expect(first!.provisional).toBe(true);
    expect(m.provisionalUuids()).toEqual([`opencode:${SID}:tool:c1:use`]);
    const seeded = m.seedFromSnapshot(
      [user("u"), assistant("a", [{ type: "tool", id: "c1", name: "todowrite", state: { status: "running", input: todos, metadata: {} } }])],
      { afterUserMessageId: "u" },
    );
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({ stream: "tool_use", replace: true, lineUuid: `opencode:${SID}:tool:c1:use` });
    expect(seeded[0]!.provisional).toBeUndefined();
    expect(JSON.parse(seeded[0]!.data).name).toBe("TodoWrite");
    expect(m.provisionalUuids()).toEqual([]);
  });

  test("the same when the snapshot still shows the tool as streaming (name only)", () => {
    const m = createOpencodeEventMapper({ sessionId: SID });
    m.feed(called);
    const seeded = m.seedFromSnapshot(
      [user("u"), assistant("a", [{ type: "tool", id: "c1", name: "todowrite", state: { status: "streaming", input: "{" } }])],
      { afterUserMessageId: "u" },
    );
    expect(seeded.map((c) => [c.replace, JSON.parse(c.data).name])).toEqual([[true, "TodoWrite"]]);
  });

  test("a snapshot taken first keeps the real name when the live tool.called arrives after it", () => {
    const m = createOpencodeEventMapper({ sessionId: SID });
    m.seedFromSnapshot([user("u"), assistant("a", [{ type: "tool", id: "c1", name: "todowrite", state: { status: "streaming", input: "{" } }])], { afterUserMessageId: "u" });
    const [use] = m.feed(called);
    expect(JSON.parse(use!.data).name).toBe("TodoWrite");
    expect(use!.provisional).toBeUndefined();
  });
});

describe("usage only for completed messages (R-S7)", () => {
  test("an in-progress message with zeroed tokens neither counts nor swallows the live step.ended", () => {
    const m = createOpencodeEventMapper({ sessionId: SID });
    const seeded = m.seedFromSnapshot(
      [user("u"), assistant("a", [{ type: "text", text: "par" }], { tokens: tok(0), cost: 0 })],
      { afterUserMessageId: "u" },
    );
    expect(seeded.some(isUsage)).toBe(false);
    expect(m.usage().input).toBe(0);
    const live = m.feed({ type: "session.step.ended", data: { sessionID: SID, assistantMessageID: "a", finish: "stop", cost: 0.1, tokens: tok(42) } });
    expect(live.filter(isUsage).map(usageOf)[0]!.turn!.inputTokens).toBe(42);
    expect(m.usage().input).toBe(42);
  });
});

describe("db-free module graph (R-S8)", () => {
  test("opencode-events.ts and opencode-map-helpers.ts import neither db.ts nor the tmux driver", () => {
    for (const f of ["opencode-events.ts", "opencode-map-helpers.ts"]) {
      const src = readFileSync(path.join(import.meta.dir, f), "utf8");
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      expect(imports.filter((i) => /db\.ts|opencode-tmux|claude-tmux|core-spawn|orchestrator/.test(i))).toEqual([]);
    }
  });
});

import { describe, expect, test } from "bun:test";
import type { GlobalEvent, RunEvent, TaskEventsReplayMeta } from "../../shared/types.ts";
import { BACKPRESSURE_BYTES, GLOBAL_EVENT_FORWARD, createSubscriptions } from "./subscriptions.ts";
import type { PhoneChannel } from "./types.ts";

/** A phone channel that records what it is sent. */
function fakeChannel() {
  const sent: Array<{ type: string; body: Record<string, unknown> }> = [];
  const peerFns = new Set<(p: boolean) => void>();
  const closeFns = new Set<(r: string) => void>();
  let queued = 0;
  let present = true;
  const ch: PhoneChannel = {
    principal: { kind: "device", deviceId: "d", deviceName: "n", level: "observe", sessionId: "s", sessionHash: new Uint8Array(32), approvePub: new Uint8Array(65) },
    send: (type, body) => void sent.push({ type, body: body as Record<string, unknown> }),
    queuedBytes: () => queued,
    peerPresent: () => present,
    onClose: (fn) => (closeFns.add(fn), () => void closeFns.delete(fn)),
    onPeerChange: (fn) => (peerFns.add(fn), () => void peerFns.delete(fn)),
  };
  return {
    ch,
    sent,
    setQueued: (n: number) => void (queued = n),
    setPeer: (p: boolean) => {
      present = p;
      for (const f of [...peerFns]) f(p);
    },
    close: () => closeFns.forEach((f) => f("test")),
    types: () => sent.map((s) => s.type),
  };
}

/** A fake of `openTaskEventStream`: records opens and lets the test push events through the sink. */
function fakeStream() {
  const opens: Array<{ taskId: string; opts: { cursor: number | null; maxBytes?: number }; sink: { meta(m: TaskEventsReplayMeta): void; event(e: RunEvent): void }; closed: boolean }> = [];
  const open = ((taskId: string, opts: { cursor: number | null; maxBytes?: number }, sink: { meta(m: TaskEventsReplayMeta): void; event(e: RunEvent): void }) => {
    const rec = { taskId, opts, sink, closed: false };
    opens.push(rec);
    return { close: () => void (rec.closed = true), started: Promise.resolve() };
  }) as never;
  return { open, opens, live: () => opens.filter((o) => !o.closed) };
}

function fakeBus() {
  const subs = new Set<(ev: GlobalEvent) => void>();
  return { subscribe: (fn: (ev: GlobalEvent) => void) => (subs.add(fn), () => void subs.delete(fn)), emit: (ev: GlobalEvent) => subs.forEach((f) => f(ev)), count: () => subs.size };
}

const ev = (id: number, stream: RunEvent["stream"] = "assistant", data = "hi"): RunEvent => ({ id, runId: "r", taskId: "t1", stream, data, ts: 1 });

describe("task subscriptions", () => {
  test("opens the shared stream with the cursor and the 256 KB first-load budget, and forwards meta and events with their projection", () => {
    const c = fakeChannel();
    const s = fakeStream();
    const subs = createSubscriptions(c.ch, { openTaskEventStream: s.open });
    subs.subscribeTask("sub1", "t1", null, null);
    expect(s.opens[0]).toMatchObject({ taskId: "t1", opts: { cursor: null, maxBytes: 262144 } });
    s.opens[0]!.sink.meta({ earliestId: 3, hasMore: true });
    s.opens[0]!.sink.event(ev(3, "user", "<system-reminder>x</system-reminder>"));
    expect(c.sent[0]).toEqual({ type: "task-meta", body: { sub: "sub1", taskId: "t1", meta: { earliestId: 3, hasMore: true } } });
    expect(c.sent[1]!.type).toBe("task-event");
    expect((c.sent[1]!.body.parsed as { kind: string }).kind).toBe("user");
    expect((c.sent[1]!.body.event as RunEvent).id).toBe(3);
  });

  test("a resume passes the phone's cursor and its own byte budget", () => {
    const c = fakeChannel();
    const s = fakeStream();
    createSubscriptions(c.ch, { openTaskEventStream: s.open }).subscribeTask("a", "t1", 40, 65536);
    expect(s.opens[0]!.opts).toMatchObject({ cursor: 40, maxBytes: 65536 });
  });

  test("a snapshot answer is forwarded in the meta frame", () => {
    const c = fakeChannel();
    const s = fakeStream();
    createSubscriptions(c.ch, { openTaskEventStream: s.open }).subscribeTask("a", "t1", 999, null);
    s.opens[0]!.sink.meta({ earliestId: 1, hasMore: false, snapshotRequired: true });
    expect((c.sent[0]!.body.meta as TaskEventsReplayMeta).snapshotRequired).toBe(true);
  });

  test("a tool result over 16 KB arrives cut with the event id to fetch it by", () => {
    const c = fakeChannel();
    const s = fakeStream();
    createSubscriptions(c.ch, { openTaskEventStream: s.open }).subscribeTask("a", "t1", null, null);
    s.opens[0]!.sink.event({ ...ev(9, "tool_result", JSON.stringify({ toolUseId: "x", content: "y".repeat(30_000), isError: false })) });
    expect(c.sent[0]!.body.truncated).toEqual({ eventId: 9, fullBytes: expect.any(Number) });
  });

  test("unsubscribe and re-subscribing the same id release the old stream", () => {
    const c = fakeChannel();
    const s = fakeStream();
    const subs = createSubscriptions(c.ch, { openTaskEventStream: s.open });
    subs.subscribeTask("a", "t1", null, null);
    subs.subscribeTask("a", "t2", null, null);
    expect(s.opens.map((o) => o.closed)).toEqual([true, false]);
    subs.unsubscribe("a");
    expect(s.live()).toHaveLength(0);
    expect(subs.count()).toBe(0);
    s.opens[1]!.sink.event(ev(1)); // late events from a released stream are dropped
    expect(c.sent).toHaveLength(0);
  });

  test("closing the session releases every subscriber (no leak)", () => {
    const c = fakeChannel();
    const s = fakeStream();
    const bus = fakeBus();
    const subs = createSubscriptions(c.ch, { openTaskEventStream: s.open, subscribeGlobal: bus.subscribe });
    subs.subscribeTask("a", "t1", null, null);
    subs.subscribeTask("b", "t2", null, null);
    subs.subscribeGlobal("g");
    expect(s.live()).toHaveLength(2);
    expect(bus.count()).toBe(1);
    c.close();
    expect(s.live()).toHaveLength(0);
    expect(bus.count()).toBe(0);
    expect(subs.count()).toBe(0);
  });

  test("a phone that opens too many subscriptions is refused", () => {
    const c = fakeChannel();
    const subs = createSubscriptions(c.ch, { openTaskEventStream: fakeStream().open, maxSubscriptions: 3 });
    for (let i = 0; i < 3; i++) subs.subscribeTask(`s${i}`, "t1", null, null);
    expect(() => subs.subscribeTask("s3", "t1", null, null)).toThrow("too many subscriptions");
  });
});

describe("backpressure", () => {
  test("past 4 MB queued the subscription is dropped and the phone told to take a snapshot", () => {
    const c = fakeChannel();
    const s = fakeStream();
    const subs = createSubscriptions(c.ch, { openTaskEventStream: s.open });
    subs.subscribeTask("a", "t1", null, null);
    const sink = s.opens[0]!.sink;
    sink.event(ev(1));
    expect(c.types()).toEqual(["task-event"]);
    c.setQueued(BACKPRESSURE_BYTES + 1);
    sink.event(ev(2));
    sink.event(ev(3));
    expect(c.types()).toEqual(["task-event", "snapshot-required"]);
    expect(c.sent[1]!.body).toEqual({ sub: "a", reason: "backpressure" });
    expect(s.opens[0]!.closed).toBe(true);
    expect(subs.count()).toBe(0);
  });

  test("a phone that never drains: every event pumped adds to the queue until the cap drops it, and nothing grows after", () => {
    const c = fakeChannel();
    const s = fakeStream();
    createSubscriptions(c.ch, { openTaskEventStream: s.open }).subscribeTask("a", "t1", null, null);
    let queued = 0;
    c.ch.queuedBytes = () => queued;
    c.ch.send = (type, body) => {
      c.sent.push({ type, body: body as Record<string, unknown> });
      queued += 1_000_000;
    };
    for (let i = 1; i <= 20; i++) s.opens[0]!.sink.event(ev(i));
    expect(c.types().filter((t) => t === "snapshot-required")).toHaveLength(1);
    expect(c.sent.length).toBeLessThan(10);
  });

  test("the global subscription is dropped the same way", () => {
    const c = fakeChannel();
    const bus = fakeBus();
    createSubscriptions(c.ch, { subscribeGlobal: bus.subscribe }).subscribeGlobal("g");
    c.setQueued(BACKPRESSURE_BYTES + 1);
    bus.emit({ kind: "tasks-changed", cursor: "1" } as unknown as GlobalEvent);
    expect(c.types()).toEqual(["snapshot-required"]);
    expect(bus.count()).toBe(0);
  });
});

describe("peer presence", () => {
  test("while the phone is away the stream is released; on return it resumes from the last id", () => {
    const c = fakeChannel();
    const s = fakeStream();
    createSubscriptions(c.ch, { openTaskEventStream: s.open }).subscribeTask("a", "t1", null, null);
    s.opens[0]!.sink.event(ev(7));
    c.setPeer(false);
    expect(s.opens[0]!.closed).toBe(true);
    c.setPeer(true);
    expect(s.opens).toHaveLength(2);
    expect(s.opens[1]!.opts.cursor).toBe(7);
    expect(s.live()).toHaveLength(1);
  });

  test("a subscription made while the phone is away starts when it returns", () => {
    const c = fakeChannel();
    const s = fakeStream();
    c.setPeer(false);
    createSubscriptions(c.ch, { openTaskEventStream: s.open }).subscribeTask("a", "t1", 5, null);
    expect(s.opens).toHaveLength(0);
    c.setPeer(true);
    expect(s.opens[0]!.opts.cursor).toBe(5);
  });

  test("the global subscription pauses and, on return, says there was a gap", () => {
    const c = fakeChannel();
    const bus = fakeBus();
    createSubscriptions(c.ch, { subscribeGlobal: bus.subscribe }).subscribeGlobal("g");
    c.setPeer(false);
    expect(bus.count()).toBe(0);
    c.setPeer(true);
    expect(bus.count()).toBe(1);
    expect(c.sent.at(-1)).toEqual({ type: "snapshot-required", body: { sub: "g", reason: "gap" } });
  });
});

describe("the global event allowlist", () => {
  test("forwards exactly: column, interaction, pipeline, run-status, tasks-changed, files-sent, send-failed, harness-swap, fx-auto-resume", () => {
    const forwarded = Object.entries(GLOBAL_EVENT_FORWARD).filter(([, v]) => v).map(([k]) => k).sort();
    expect(forwarded).toEqual(["column", "files-sent", "fx-auto-resume", "harness-swap", "interaction", "pipeline", "run-status", "send-failed", "tasks-changed"]);
    expect(GLOBAL_EVENT_FORWARD.update).toBe(false);
  });

  test("an allowed event reaches the phone; `update` does not", () => {
    const c = fakeChannel();
    const bus = fakeBus();
    createSubscriptions(c.ch, { subscribeGlobal: bus.subscribe }).subscribeGlobal("g");
    bus.emit({ kind: "update", task: { id: "t1" } } as unknown as GlobalEvent);
    bus.emit({ kind: "run-status", taskId: "t1", runId: "r", status: "succeeded" } as unknown as GlobalEvent);
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({ type: "global-event", body: { sub: "g", event: { kind: "run-status", taskId: "t1", runId: "r", status: "succeeded" } } });
  });
});

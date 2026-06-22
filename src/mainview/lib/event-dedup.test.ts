import { describe, expect, test } from "bun:test";
import { createEventDeduper, eventDedupKey } from "./event-dedup.ts";
import type { RunEvent } from "../../shared/types.ts";

const ev = (e: Partial<RunEvent>): RunEvent => ({
  runId: "run-1",
  taskId: "task-1",
  stream: "stdout",
  data: "",
  ts: 0,
  ...e,
});

describe("eventDedupKey", () => {
  test("user key drops ts and normalizes newlines", () => {
    const live = ev({ stream: "user", data: "hello\r\nworld", ts: 100 });
    const jsonl = ev({ stream: "user", data: "hello\nworld", ts: 999 });
    expect(eventDedupKey(live)).toBe(eventDedupKey(jsonl));
  });

  test("non-user key keeps ts so same-tick distinct events stay apart", () => {
    const a = ev({ stream: "assistant", data: "chunk", ts: 100 });
    const b = ev({ stream: "assistant", data: "chunk", ts: 101 });
    expect(eventDedupKey(a)).not.toBe(eventDedupKey(b));
  });

  test("same user text on different runs stays distinct", () => {
    const a = ev({ stream: "user", data: "yes", runId: "run-1" });
    const b = ev({ stream: "user", data: "yes", runId: "run-2" });
    expect(eventDedupKey(a)).not.toBe(eventDedupKey(b));
  });
});

describe("createEventDeduper", () => {
  test("collapses the live echo + JSONL twin of a user message", () => {
    const d = createEventDeduper();
    expect(d.accept(ev({ stream: "user", data: "hi", ts: 1 }))).toBe(true);
    expect(d.accept(ev({ stream: "user", data: "hi", ts: 50 }))).toBe(false);
  });

  test("keeps genuinely distinct high-volume events", () => {
    const d = createEventDeduper();
    expect(d.accept(ev({ stream: "assistant", data: "a", ts: 1 }))).toBe(true);
    expect(d.accept(ev({ stream: "assistant", data: "b", ts: 1 }))).toBe(true);
    expect(d.accept(ev({ stream: "assistant", data: "a", ts: 1 }))).toBe(false);
  });

  // The regression: a follow-up folded into a long in-flight turn. The live
  // echo lands immediately; the JSONL twin only arrives after claude finishes
  // the (long) current response — thousands of events later. With a single
  // capped+evicted set the live echo's key would be gone by then and the twin
  // would render as a duplicate. The durable `user` set must survive it.
  test("user dedup survives eviction of thousands of intervening events", () => {
    const d = createEventDeduper({ cap: 50, keep: 40 });
    // Live echo of the folded user message.
    expect(d.accept(ev({ stream: "user", data: "do the thing", ts: 1 }))).toBe(true);
    // A long response streams in — far more than `cap` volatile events.
    for (let i = 0; i < 5000; i++) {
      d.accept(ev({ stream: "assistant", data: `chunk-${i}`, ts: 1000 + i }));
    }
    // The JSONL twin finally arrives (different ts). It must still be a dup.
    expect(d.accept(ev({ stream: "user", data: "do the thing", ts: 9999 }))).toBe(false);
  });

  test("volatile set is trimmed (oldest evicted) past the cap", () => {
    const d = createEventDeduper({ cap: 10, keep: 5 });
    for (let i = 0; i < 20; i++) {
      d.accept(ev({ stream: "stdout", data: `line-${i}`, ts: i }));
    }
    // An early, since-evicted key re-appears as "new" after trimming.
    expect(d.accept(ev({ stream: "stdout", data: "line-0", ts: 0 }))).toBe(true);
  });

  test("high-volume volatile events never evict user keys (separate sets)", () => {
    // userCap below the volatile count proves the two sets are independent:
    // 5000 stdout events must not touch the durable user set.
    const d = createEventDeduper({ cap: 50, keep: 40, userCap: 100, userKeep: 80 });
    expect(d.accept(ev({ stream: "user", data: "keep me", ts: 1 }))).toBe(true);
    for (let i = 0; i < 5000; i++) {
      d.accept(ev({ stream: "stdout", data: `line-${i}`, ts: 1000 + i }));
    }
    expect(d.accept(ev({ stream: "user", data: "keep me", ts: 9999 }))).toBe(false);
  });

  test("durable user set is bounded by userCap (belt-and-suspenders)", () => {
    const d = createEventDeduper({ userCap: 10, userKeep: 5 });
    for (let i = 0; i < 20; i++) {
      // Distinct runs so each user message gets a distinct key.
      d.accept(ev({ stream: "user", data: "msg", runId: `run-${i}`, ts: i }));
    }
    // The oldest user key has been evicted past the cap, so it re-accepts.
    expect(d.accept(ev({ stream: "user", data: "msg", runId: "run-0", ts: 0 }))).toBe(true);
  });
});

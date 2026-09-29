import { beforeEach, expect, test } from "bun:test";
import { __forTest, publishPipelineGlobalEvent, subscribePipelineGlobalEvents } from "./pipeline-events.ts";
import type { GlobalEvent } from "../../shared/types.ts";

// Plain module-state tests — no React/jsdom (house convention). The listener
// set is a process-wide singleton, hence `__forTest.reset()` in `beforeEach`.

function pipelineEv(overrides: Partial<Extract<GlobalEvent, { kind: "pipeline" }>> = {}): GlobalEvent {
  return {
    kind: "pipeline",
    taskId: "parent-1",
    status: "running",
    activeStepIds: ["s1"],
    stepCount: 1,
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

function columnEv(taskId = "step-1"): GlobalEvent {
  return { kind: "column", taskId, runId: null, column: "running", prev: "ready", ts: 1 };
}

beforeEach(() => {
  __forTest.reset();
});

test("a subscriber receives every published event, in order, with the same object", () => {
  const seen: GlobalEvent[] = [];
  subscribePipelineGlobalEvents((e) => seen.push(e));
  const a = pipelineEv();
  const b = columnEv();
  const c: GlobalEvent = { kind: "run-status", taskId: "step-1", runId: "r1", status: "succeeded", ts: 2 };
  publishPipelineGlobalEvent(a);
  publishPipelineGlobalEvent(b);
  publishPipelineGlobalEvent(c);
  expect(seen).toEqual([a, b, c]);
  expect(seen[0]).toBe(a);
});

test("unsubscribe stops delivery and is idempotent; other subscribers keep receiving", () => {
  const first: GlobalEvent[] = [];
  const second: GlobalEvent[] = [];
  const off = subscribePipelineGlobalEvents((e) => first.push(e));
  subscribePipelineGlobalEvents((e) => second.push(e));
  publishPipelineGlobalEvent(pipelineEv({ ts: 1 }));
  off();
  off();
  publishPipelineGlobalEvent(pipelineEv({ ts: 2 }));
  expect(first.map((e) => e.ts)).toEqual([1]);
  expect(second.map((e) => e.ts)).toEqual([1, 2]);
  expect(__forTest.listenerCount()).toBe(1);
});

test("publishing with no subscribers is a no-op (never throws)", () => {
  expect(() => publishPipelineGlobalEvent(pipelineEv())).not.toThrow();
  expect(__forTest.listenerCount()).toBe(0);
});

test("a listener that unsubscribes mid-dispatch doesn't skip its siblings", () => {
  const seen: string[] = [];
  const offA = subscribePipelineGlobalEvents(() => {
    seen.push("a");
    offA();
  });
  subscribePipelineGlobalEvents(() => seen.push("b"));
  subscribePipelineGlobalEvents(() => seen.push("c"));
  publishPipelineGlobalEvent(pipelineEv());
  expect(seen).toEqual(["a", "b", "c"]);
  publishPipelineGlobalEvent(pipelineEv());
  expect(seen).toEqual(["a", "b", "c", "b", "c"]);
});

test("a throwing listener is contained — publish still returns and later listeners still fire", () => {
  const seen: string[] = [];
  const origWarn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...args: unknown[]) => { warned.push(args); };
  try {
    subscribePipelineGlobalEvents(() => { throw new Error("boom"); });
    subscribePipelineGlobalEvents(() => seen.push("after"));
    expect(() => publishPipelineGlobalEvent(pipelineEv())).not.toThrow();
  } finally {
    console.warn = origWarn;
  }
  expect(seen).toEqual(["after"]);
  expect(warned.length).toBe(1);
});

test("the same listener subscribed twice is held once (Set semantics) and one unsubscribe removes it", () => {
  let n = 0;
  const cb = () => { n += 1; };
  const off1 = subscribePipelineGlobalEvents(cb);
  subscribePipelineGlobalEvents(cb);
  publishPipelineGlobalEvent(pipelineEv());
  expect(n).toBe(1);
  off1();
  publishPipelineGlobalEvent(pipelineEv());
  expect(n).toBe(1);
  expect(__forTest.listenerCount()).toBe(0);
});

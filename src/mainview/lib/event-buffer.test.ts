import { describe, expect, test } from "bun:test";
import { createEventBuffer } from "./event-buffer.ts";

/** A manual arm strategy: instead of rAF/timers, capture the flush so the test
 *  can `fire()` it deterministically and observe arm/disarm bookkeeping. */
const makeFakeScheduler = () => {
  let scheduled: (() => void) | null = null;
  let armCount = 0;
  let disarmCount = 0;
  return {
    arm: (flush: () => void) => {
      scheduled = flush;
      armCount++;
      return () => {
        scheduled = null;
        disarmCount++;
      };
    },
    /** Invoke the armed flush. The buffer's flush disarms itself. */
    fire: () => scheduled?.(),
    isArmed: () => scheduled !== null,
    armCount: () => armCount,
    disarmCount: () => disarmCount,
  };
};

describe("createEventBuffer", () => {
  test("arms once across multiple pushes, then emits the whole batch on fire", () => {
    const batches: number[][] = [];
    const s = makeFakeScheduler();
    const b = createEventBuffer<number>((batch) => batches.push(batch), s.arm);

    b.push(1);
    b.push(2);
    b.push(3);
    expect(s.armCount()).toBe(1); // pushes coalesce — armed only once
    expect(batches).toEqual([]); // nothing emitted until the flush fires

    s.fire();
    expect(batches).toEqual([[1, 2, 3]]);
    expect(s.isArmed()).toBe(false);
  });

  test("re-arms on the next push after a fire (the freeze-fix invariant)", () => {
    const batches: number[][] = [];
    const s = makeFakeScheduler();
    const b = createEventBuffer<number>((batch) => batches.push(batch), s.arm);

    b.push(1);
    s.fire();
    expect(batches).toEqual([[1]]);

    // The handle was reset, so a subsequent event must schedule a fresh flush.
    b.push(2);
    expect(s.armCount()).toBe(2);
    s.fire();
    expect(batches).toEqual([[1], [2]]);
  });

  test("flushNow drains immediately, cancels the pending arm, and re-arms next push", () => {
    const batches: number[][] = [];
    const s = makeFakeScheduler();
    const b = createEventBuffer<number>((batch) => batches.push(batch), s.arm);

    b.push(1);
    b.push(2);
    expect(s.isArmed()).toBe(true);

    b.flushNow(); // the focus / visibility recovery path
    expect(batches).toEqual([[1, 2]]);
    expect(s.disarmCount()).toBe(1); // pending arm was cancelled
    expect(s.isArmed()).toBe(false);

    b.push(3);
    expect(s.armCount()).toBe(2); // re-armed
    s.fire();
    expect(batches).toEqual([[1, 2], [3]]);
  });

  test("flushNow with nothing buffered does not emit or arm", () => {
    const batches: number[][] = [];
    const s = makeFakeScheduler();
    const b = createEventBuffer<number>((batch) => batches.push(batch), s.arm);

    b.flushNow();
    expect(batches).toEqual([]);
    expect(s.armCount()).toBe(0);
  });

  test("a fire with nothing buffered is a harmless no-op (idempotent flush)", () => {
    const batches: number[][] = [];
    const s = makeFakeScheduler();
    const b = createEventBuffer<number>((batch) => batches.push(batch), s.arm);

    b.push(1);
    s.fire(); // emits [1], disarms
    s.fire(); // already disarmed / empty — must not emit again
    expect(batches).toEqual([[1]]);
  });

  test("dispose cancels the pending arm and discards buffered items without emitting", () => {
    const batches: number[][] = [];
    const s = makeFakeScheduler();
    const b = createEventBuffer<number>((batch) => batches.push(batch), s.arm);

    b.push(1);
    b.push(2);
    b.dispose();
    expect(batches).toEqual([]); // dropped, not flushed
    expect(s.disarmCount()).toBe(1);
    expect(s.isArmed()).toBe(false);

    // A later flush has nothing to emit (pending was cleared).
    b.flushNow();
    expect(batches).toEqual([]);
  });

  test("each emitted batch is a fresh array — pending resets between flushes", () => {
    const batches: number[][] = [];
    const s = makeFakeScheduler();
    const b = createEventBuffer<number>((batch) => batches.push(batch), s.arm);

    b.push(1);
    s.fire();
    b.push(2);
    s.fire();
    expect(batches).toEqual([[1], [2]]);
    expect(batches[0]).not.toBe(batches[1]); // distinct arrays, no shared buffer
  });
});

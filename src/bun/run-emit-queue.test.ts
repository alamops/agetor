import { describe, expect, test } from "bun:test";
import { appendAndEmit, pendingRunQueues } from "./run-emit-queue.ts";

/** Simulated insert latency (the worker round-trip); never followed by a timing assertion. */
const latency = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nextTick = () => new Promise<void>((r) => setImmediate(r));

describe("appendAndEmit", () => {
  test("1000 interleaved calls over 3 runs emit in call order per run", async () => {
    const emitted: Record<number, number[]> = { 1: [], 2: [], 3: [] };
    const expected: Record<number, number[]> = { 1: [], 2: [], 3: [] };
    const calls: Promise<number>[] = [];
    for (let i = 0; i < 1000; i++) {
      const run = (i % 3) + 1;
      expected[run]!.push(i);
      const delay = Math.random() * 3;
      calls.push(
        appendAndEmit(
          run,
          async () => {
            await latency(delay);
            return i;
          },
          (row) => emitted[run]!.push(row),
        ),
      );
    }
    const rows = await Promise.all(calls);
    expect(rows).toEqual(Array.from({ length: 1000 }, (_, i) => i));
    for (const run of [1, 2, 3]) expect(emitted[run]).toEqual(expected[run]!);
  });

  test("a failing insert rejects only its own call and does not stall the queue", async () => {
    const origError = console.error;
    console.error = () => {};
    try {
      const emitted: number[] = [];
      const a = appendAndEmit(7, async () => 1, (r) => emitted.push(r));
      const b = appendAndEmit(7, async () => { throw new Error("boom"); }, (r) => emitted.push(r));
      const c = appendAndEmit(7, async () => 3, (r) => emitted.push(r));
      expect(await a).toBe(1);
      await expect(b).rejects.toThrow("boom");
      expect(await c).toBe(3);
      expect(emitted).toEqual([1, 3]);
    } finally {
      console.error = origError;
    }
  });

  test("different runs do not wait on each other", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = appendAndEmit("A", async () => { await gate; return "A"; }, (r) => order.push(r));
    const fast = appendAndEmit("B", async () => "B", (r) => order.push(r));
    // B finishes while A's insert is still blocked on the gate.
    await fast;
    expect(order).toEqual(["B"]);
    release();
    await slow;
    expect(order).toEqual(["B", "A"]);
  });

  test("the per-run entry is deleted once settled", async () => {
    const origError = console.error;
    console.error = () => {};
    try {
      await Promise.all([
        appendAndEmit(1, async () => 1, () => {}),
        appendAndEmit(2, async () => 2, () => {}),
        appendAndEmit(2, async () => { throw new Error("x"); }, () => {}).catch(() => {}),
      ]);
      await nextTick();
      expect(pendingRunQueues()).toBe(0);
    } finally {
      console.error = origError;
    }
  });

  test("a throwing emitter does not lose the row or stall the run", async () => {
    const origError = console.error;
    console.error = () => {};
    try {
      const seen: number[] = [];
      const a = appendAndEmit(9, async () => 1, () => { throw new Error("emit"); });
      const b = appendAndEmit(9, async () => 2, (r) => seen.push(r));
      expect(await a).toBe(1);
      expect(await b).toBe(2);
      expect(seen).toEqual([2]);
    } finally {
      console.error = origError;
    }
  });
});

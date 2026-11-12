import { describe, expect, test } from "bun:test";
import { mapWithConcurrency } from "./map-with-concurrency.ts";
import { mapWithConcurrency as reexported } from "../components/worktrees/worktree-delete-intent.ts";

describe("mapWithConcurrency", () => {
  test("caps in-flight work at the limit and preserves input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (ms, index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, ms));
      inFlight -= 1;
      return `${index}:${ms}`;
    });
    expect(peak).toBe(2);
    expect(results).toEqual(["0:5", "1:1", "2:4", "3:2", "4:3"]);
  });

  test("never has more than N in flight across many manually-settled items", async () => {
    // Settle by hand rather than by timer so the assertion holds at every
    // step, not just at the peak: after each settle exactly one new call may
    // start, and the in-flight count never exceeds the cap.
    const pending: Array<() => void> = [];
    let inFlight = 0;
    const samples: number[] = [];
    const run = mapWithConcurrency(Array.from({ length: 16 }, (_, i) => i), 2, async (n) => {
      inFlight += 1;
      samples.push(inFlight);
      await new Promise<void>((resolve) => pending.push(resolve));
      inFlight -= 1;
      return n;
    });
    for (let settled = 0; settled < 16; settled++) {
      // Let the workers pick up their next item.
      await Promise.resolve();
      await Promise.resolve();
      expect(inFlight).toBeLessThanOrEqual(2);
      pending.shift()!();
    }
    expect(await run).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(Math.max(...samples)).toBe(2);
  });

  test("an empty input resolves to an empty array without calling the worker", async () => {
    let calls = 0;
    const results = await mapWithConcurrency([], 5, async () => {
      calls += 1;
      return 0;
    });
    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });

  test("a non-positive limit still runs the work (treated as 1)", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3], 0, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return n * 2;
    });
    expect(peak).toBe(1);
    expect(results).toEqual([2, 4, 6]);
  });

  test("the Worktrees delete-intent module re-exports the same helper", () => {
    expect(reexported).toBe(mapWithConcurrency);
  });
});

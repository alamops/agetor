import { describe, expect, test } from "bun:test";
import { BAR_CLOCK_MAX_MS, BAR_CLOCK_MIN_MS, BAR_CLOCK_PANEL_TICK_MS, barClockDelay } from "./use-bar-clock.ts";

// The bar's one timer (docs/architecture/app-bar.md § Harnesses button and
// panel, "Clock"): it re-renders at the next instant the model changes on its
// own, clamped to 1 s – 30 min. The hook itself is DOM behavior (house
// convention: Playwright's job, e2e/app-bar.spec.ts); the delay it arms is
// this pure function.

const NOW = 1_800_000_000_000;

describe("bar clock constants", () => {
  test("the clamp is 1 s to 30 min and the open-panel beat is 30 s", () => {
    expect(BAR_CLOCK_MIN_MS).toBe(1_000);
    expect(BAR_CLOCK_MAX_MS).toBe(30 * 60_000);
    expect(BAR_CLOCK_PANEL_TICK_MS).toBe(30_000);
  });
});

describe("barClockDelay", () => {
  test("nothing scheduled: wait the longest, so a slept laptop is still caught", () => {
    expect(barClockDelay(null, NOW)).toBe(BAR_CLOCK_MAX_MS);
  });

  test("a change inside the window fires exactly then", () => {
    expect(barClockDelay(NOW + 5_000, NOW)).toBe(5_000);
    expect(barClockDelay(NOW + 12 * 60_000, NOW)).toBe(12 * 60_000);
  });

  test("a change due now, already past, or under a second waits the minimum (no busy loop)", () => {
    expect(barClockDelay(NOW, NOW)).toBe(BAR_CLOCK_MIN_MS);
    expect(barClockDelay(NOW - 60_000, NOW)).toBe(BAR_CLOCK_MIN_MS);
    expect(barClockDelay(NOW + 1, NOW)).toBe(BAR_CLOCK_MIN_MS);
    expect(barClockDelay(NOW + BAR_CLOCK_MIN_MS - 1, NOW)).toBe(BAR_CLOCK_MIN_MS);
  });

  test("a change far away waits at most 30 min", () => {
    expect(barClockDelay(NOW + 2 * 3_600_000, NOW)).toBe(BAR_CLOCK_MAX_MS);
    expect(barClockDelay(NOW + BAR_CLOCK_MAX_MS + 1, NOW)).toBe(BAR_CLOCK_MAX_MS);
  });

  test("both bounds are inclusive", () => {
    expect(barClockDelay(NOW + BAR_CLOCK_MIN_MS, NOW)).toBe(BAR_CLOCK_MIN_MS);
    expect(barClockDelay(NOW + BAR_CLOCK_MIN_MS + 1, NOW)).toBe(BAR_CLOCK_MIN_MS + 1);
    expect(barClockDelay(NOW + BAR_CLOCK_MAX_MS, NOW)).toBe(BAR_CLOCK_MAX_MS);
    expect(barClockDelay(NOW + BAR_CLOCK_MAX_MS - 1, NOW)).toBe(BAR_CLOCK_MAX_MS - 1);
  });
});

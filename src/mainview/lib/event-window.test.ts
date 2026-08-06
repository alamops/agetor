import { describe, expect, test } from "bun:test";
import { eventWindowKeepCount } from "./event-window.ts";
import { EVENTS_WINDOW_MAX } from "../../shared/types.ts";

describe("eventWindowKeepCount", () => {
  const max = 100;

  test("under-cap, near bottom: no trim", () => {
    expect(eventWindowKeepCount(50, true, max)).toBeNull();
  });

  test("under-cap, mid-history: no trim", () => {
    expect(eventWindowKeepCount(50, false, max)).toBeNull();
  });

  test("length === max, near bottom: no trim (boundary is inclusive)", () => {
    expect(eventWindowKeepCount(max, true, max)).toBeNull();
  });

  test("length === max, mid-history: no trim (boundary is inclusive)", () => {
    expect(eventWindowKeepCount(max, false, max)).toBeNull();
  });

  test("over-cap, near bottom, just past max: trims to max", () => {
    expect(eventWindowKeepCount(max + 1, true, max)).toBe(max);
  });

  test("over-cap, near bottom, far past max: trims to max", () => {
    expect(eventWindowKeepCount(max * 10, true, max)).toBe(max);
  });

  test("mid-history deferral: just past max, not near bottom, defers", () => {
    expect(eventWindowKeepCount(max + 1, false, max)).toBeNull();
  });

  test("mid-history deferral: length === 2*max, not near bottom, defers (boundary is inclusive)", () => {
    expect(eventWindowKeepCount(max * 2, false, max)).toBeNull();
  });

  test("mid-history hard cap: length === 2*max + 1, not near bottom, trims to max", () => {
    expect(eventWindowKeepCount(max * 2 + 1, false, max)).toBe(max);
  });

  test("mid-history hard cap: far past 2*max, not near bottom, still trims to max", () => {
    expect(eventWindowKeepCount(max * 20, false, max)).toBe(max);
  });

  test("production wiring: EVENTS_WINDOW_MAX sanity check", () => {
    // Exercise the real constant so the production relationship (front-trim
    // engages once the live window exceeds EVENTS_WINDOW_MAX, and mid-history
    // readers get held until 2x that) stays correct if the constant changes.
    expect(eventWindowKeepCount(EVENTS_WINDOW_MAX, true, EVENTS_WINDOW_MAX)).toBeNull();
    expect(eventWindowKeepCount(EVENTS_WINDOW_MAX + 1, true, EVENTS_WINDOW_MAX)).toBe(
      EVENTS_WINDOW_MAX,
    );
    expect(
      eventWindowKeepCount(EVENTS_WINDOW_MAX + 1, false, EVENTS_WINDOW_MAX),
    ).toBeNull();
    expect(
      eventWindowKeepCount(EVENTS_WINDOW_MAX * 2 + 1, false, EVENTS_WINDOW_MAX),
    ).toBe(EVENTS_WINDOW_MAX);
  });

  test("degenerate max=0: any positive length is over-cap and trims to 0", () => {
    // length <= max (0) is only true for length === 0, so any length > 0
    // exceeds the cap immediately. Near-bottom trims straight to 0; the
    // mid-history deferral window (max*2 === 0) can never hold anything
    // back, so mid-history also trims to 0 for any positive length.
    expect(eventWindowKeepCount(0, true, 0)).toBeNull();
    expect(eventWindowKeepCount(1, true, 0)).toBe(0);
    expect(eventWindowKeepCount(1, false, 0)).toBe(0);
  });
});

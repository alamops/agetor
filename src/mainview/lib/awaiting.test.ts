import { describe, expect, test } from "bun:test";
import { AWAITING_RING_CLASS, awaitingLabel } from "./awaiting.ts";

describe("awaitingLabel", () => {
  test("nothing pending → Review", () => {
    expect(awaitingLabel(0)).toBe("Review");
  });

  test("a negative count (never sent, defensive) → Review", () => {
    expect(awaitingLabel(-1)).toBe("Review");
  });

  test("exactly one pending → Answer", () => {
    expect(awaitingLabel(1)).toBe("Answer");
  });

  test("several pending → Answer (N)", () => {
    expect(awaitingLabel(2)).toBe("Answer (2)");
    expect(awaitingLabel(12)).toBe("Answer (12)");
  });
});

describe("AWAITING_RING_CLASS", () => {
  test("is the card's exact amber ring (semantic token, no palette class)", () => {
    expect(AWAITING_RING_CLASS).toBe("ring-2 ring-warning/60 ring-offset-2 ring-offset-background");
  });
});

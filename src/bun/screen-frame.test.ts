import { describe, expect, test } from "bun:test";
import {
  MIN_VISIBLE_WIDTH,
  MIN_VISIBLE_HEIGHT,
  frameIsVisible,
  intersection,
  repairFrame,
  type DisplayInfo,
  type Rect,
} from "./screen-frame.ts";

// Real three-display layout captured from the dev machine. Negative origins
// on ABOVE/LEFT are the whole point — they sit above/left of PRIMARY's
// (0,0) origin, matching how Electrobun reports secondary displays.
const PRIMARY: DisplayInfo = {
  bounds: { x: 0, y: 0, width: 1728, height: 1117 },
  workArea: { x: 0, y: 33, width: 1728, height: 1084 },
  isPrimary: true,
};
const ABOVE: DisplayInfo = {
  bounds: { x: -449, y: -1080, width: 2560, height: 1080 },
  workArea: { x: -449, y: -1080, width: 2560, height: 1080 },
  isPrimary: false,
};
const LEFT: DisplayInfo = {
  bounds: { x: -1366, y: 0, width: 1366, height: 1024 },
  workArea: { x: -1366, y: 0, width: 1366, height: 1024 },
  isPrimary: false,
};
const DISPLAYS: DisplayInfo[] = [PRIMARY, ABOVE, LEFT];

describe("intersection", () => {
  test("disjoint rects have no intersection", () => {
    const a: Rect = { x: 0, y: 0, width: 100, height: 100 };
    const b: Rect = { x: 500, y: 500, width: 100, height: 100 };
    expect(intersection(a, b)).toBeNull();
  });

  test("partial overlap returns the exact overlap rect", () => {
    const a: Rect = { x: 0, y: 0, width: 100, height: 100 };
    const b: Rect = { x: 50, y: 50, width: 100, height: 100 };
    expect(intersection(a, b)).toEqual({ x: 50, y: 50, width: 50, height: 50 });
  });

  test("identical rects intersect to the same rect", () => {
    const a: Rect = { x: 10, y: 20, width: 300, height: 400 };
    expect(intersection(a, { ...a })).toEqual(a);
  });

  test("one rect fully containing the other returns the inner rect", () => {
    const outer: Rect = { x: 0, y: 0, width: 1000, height: 1000 };
    const inner: Rect = { x: 100, y: 200, width: 50, height: 60 };
    expect(intersection(outer, inner)).toEqual(inner);
    expect(intersection(inner, outer)).toEqual(inner);
  });

  test("edge-touching only (zero-area overlap) is not an intersection", () => {
    // a's right edge lands exactly on b's left edge: a.x + a.width === b.x.
    // Zero-area contact doesn't count — x2 <= x1 must reject it, not just x2 < x1.
    const a: Rect = { x: 0, y: 0, width: 100, height: 100 };
    const b: Rect = { x: 100, y: 0, width: 100, height: 100 };
    expect(intersection(a, b)).toBeNull();
  });

  test("correct with negative coordinates on both rects", () => {
    const a: Rect = { x: -1366, y: 0, width: 1366, height: 1024 };
    const b: Rect = { x: -800, y: -200, width: 1000, height: 500 };
    expect(intersection(a, b)).toEqual({ x: -800, y: 0, width: 800, height: 300 });
  });
});

describe("frameIsVisible", () => {
  test("empty displays list means 'unknown', not 'invisible' — returns true", () => {
    // Screen.getAllDisplays() returns [] under bun test (no native enumeration
    // library loaded). An empty list carries no information about the real
    // layout, so it must not be treated as "nothing is visible" — that would
    // make every repair path fire in tests and mask the bug it exists to catch.
    const frame: Rect = { x: 5000, y: 5000, width: 800, height: 600 };
    expect(frameIsVisible(frame, [])).toBe(true);
  });

  test("window wholly inside PRIMARY is visible", () => {
    expect(frameIsVisible({ x: 100, y: 100, width: 400, height: 300 }, DISPLAYS)).toBe(true);
  });

  test("window wholly inside ABOVE is visible", () => {
    expect(frameIsVisible({ x: -400, y: -1000, width: 800, height: 600 }, DISPLAYS)).toBe(true);
  });

  test("window wholly inside LEFT is visible", () => {
    expect(frameIsVisible({ x: -1200, y: 100, width: 800, height: 600 }, DISPLAYS)).toBe(true);
  });

  test("window straddling PRIMARY and LEFT is visible", () => {
    expect(frameIsVisible({ x: -200, y: 0, width: 400, height: 200 }, DISPLAYS)).toBe(true);
  });

  // Boundary triple around MIN_VISIBLE_WIDTH x MIN_VISIBLE_HEIGHT (120x40).
  // Each frame sits flush against PRIMARY's right edge (x + width === 1728)
  // and is fully within bounds vertically, so the frame *is* the overlap
  // rect exactly — no extra arithmetic to get wrong.
  test("overlap of 119x40 (width one short) is not visible", () => {
    expect(MIN_VISIBLE_WIDTH).toBe(120);
    const frame: Rect = { x: 1728 - 119, y: 0, width: 119, height: 40 };
    expect(frameIsVisible(frame, DISPLAYS)).toBe(false);
  });

  test("overlap of 120x39 (height one short) is not visible", () => {
    expect(MIN_VISIBLE_HEIGHT).toBe(40);
    const frame: Rect = { x: 1728 - 120, y: 0, width: 120, height: 39 };
    expect(frameIsVisible(frame, DISPLAYS)).toBe(false);
  });

  test("overlap of exactly 120x40 meets the threshold and is visible", () => {
    const frame: Rect = { x: 1728 - 120, y: 0, width: 120, height: 40 };
    expect(frameIsVisible(frame, DISPLAYS)).toBe(true);
  });

  test("window entirely off every display is not visible", () => {
    expect(frameIsVisible({ x: 5000, y: 5000, width: 800, height: 600 }, DISPLAYS)).toBe(false);
  });
});

describe("repairFrame", () => {
  test("visible frame is returned unchanged, same object identity", () => {
    const frame: Rect = { x: 100, y: 100, width: 400, height: 300 };
    const result = repairFrame(frame, DISPLAYS);
    expect(result).toBe(frame);
    expect(result).toEqual({ x: 100, y: 100, width: 400, height: 300 });
  });

  test("empty displays list leaves the frame unchanged", () => {
    const frame: Rect = { x: 5000, y: 5000, width: 800, height: 600 };
    const result = repairFrame(frame, []);
    expect(result).toBe(frame);
  });

  test("degenerate zero-size frame is left unchanged (dead window pointer regression guard)", () => {
    // getWindowFrame reports {0,0,0,0} for a window whose native handle is
    // already gone. Centering that would produce a live, zero-sized window.
    const frame: Rect = { x: 0, y: 0, width: 0, height: 0 };
    const result = repairFrame(frame, DISPLAYS);
    expect(result).toBe(frame);
  });

  test("degenerate frame with zero height is left unchanged", () => {
    const frame: Rect = { x: 200, y: 200, width: 800, height: 0 };
    const result = repairFrame(frame, DISPLAYS);
    expect(result).toBe(frame);
  });

  test("degenerate frame with negative width is left unchanged", () => {
    const frame: Rect = { x: 200, y: 200, width: -100, height: 600 };
    const result = repairFrame(frame, DISPLAYS);
    expect(result).toBe(frame);
  });

  test("off-screen frame is centered on the primary display's workArea, not bounds", () => {
    const frame: Rect = { x: 9000, y: 9000, width: 1200, height: 800 };
    const result = repairFrame(frame, DISPLAYS);
    // PRIMARY.workArea = {x:0, y:33, width:1728, height:1084}
    // x = round(0 + (1728-1200)/2) = round(264) = 264
    // y = round(33 + (1084-800)/2) = round(175) = 175
    expect(result).toEqual({ x: 264, y: 175, width: 1200, height: 800 });
  });

  test("off-screen frame larger than the primary workArea is clamped to it", () => {
    const frame: Rect = { x: 9000, y: 9000, width: 2000, height: 1200 };
    const result = repairFrame(frame, DISPLAYS);
    // Both dimensions exceed PRIMARY.workArea (1728x1084), so both clamp to
    // the full workArea and the origin collapses to the workArea's own origin.
    expect(result).toEqual({ x: 0, y: 33, width: 1728, height: 1084 });
    expect(Number.isInteger(result.x)).toBe(true);
    expect(Number.isInteger(result.y)).toBe(true);
  });

  test("no display flagged primary falls back to the first usable display in list order", () => {
    const noPrimary: DisplayInfo[] = [
      { ...LEFT, isPrimary: false },
      { ...ABOVE, isPrimary: false },
      { ...PRIMARY, isPrimary: false },
    ];
    const frame: Rect = { x: 9000, y: 9000, width: 800, height: 600 };
    const result = repairFrame(frame, noPrimary);
    // Falls back to LEFT (first in the array), workArea {x:-1366,y:0,width:1366,height:1024}
    // x = round(-1366 + (1366-800)/2) = round(-1083) = -1083
    // y = round(0 + (1024-600)/2) = round(212) = 212
    expect(result).toEqual({ x: -1083, y: 212, width: 800, height: 600 });
  });

  test("primary flagged but degenerate (0x0 workArea) is skipped for the first usable non-primary", () => {
    const degeneratePrimary: DisplayInfo = { ...PRIMARY, workArea: { x: 0, y: 0, width: 0, height: 0 } };
    const displays: DisplayInfo[] = [degeneratePrimary, ABOVE, LEFT];
    const frame: Rect = { x: 9000, y: 9000, width: 800, height: 600 };
    const result = repairFrame(frame, displays);
    // degeneratePrimary is filtered out of `usable` entirely, so the primary
    // flag never matches anything usable — falls to first usable, ABOVE.
    // ABOVE.workArea = {x:-449,y:-1080,width:2560,height:1080}
    // x = round(-449 + (2560-800)/2) = round(431) = 431
    // y = round(-1080 + (1080-600)/2) = round(-840) = -840
    expect(result).toEqual({ x: 431, y: -840, width: 800, height: 600 });
  });

  test("every display degenerate leaves the frame unchanged", () => {
    const allDegenerate: DisplayInfo[] = [
      { ...PRIMARY, workArea: { x: 0, y: 0, width: 0, height: 0 } },
      { ...ABOVE, workArea: { x: 0, y: 0, width: -10, height: 0 } },
    ];
    const frame: Rect = { x: 9000, y: 9000, width: 800, height: 600 };
    const result = repairFrame(frame, allDegenerate);
    expect(result).toBe(frame);
  });

  test("result is never NaN, negative-size, or fractional-origin for an odd-sized frame", () => {
    const frame: Rect = { x: 9001, y: 9001, width: 401, height: 301 };
    const result = repairFrame(frame, DISPLAYS);
    expect(Number.isNaN(result.x)).toBe(false);
    expect(Number.isNaN(result.y)).toBe(false);
    expect(result.width).toBeGreaterThanOrEqual(0);
    expect(result.height).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.x)).toBe(true);
    expect(Number.isInteger(result.y)).toBe(true);
  });
});

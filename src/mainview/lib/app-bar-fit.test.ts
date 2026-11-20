import { describe, expect, test } from "bun:test";
import {
  APP_BAR_FIT_HYSTERESIS_PX,
  chooseFitStep,
  requiredWidth,
  stepHides,
  type AppBarPartWidths,
  type AppBarStep,
} from "./app-bar-fit.ts";

// step 0 = 700, 1 = 640, 2 = 540, 3 = 480.
const W: AppBarPartWidths = { full: 700, wordmark: 60, harnessText: 100, until: 60 };

describe("stepHides", () => {
  test("matches the collapse ladder; no step ever moves an action into a menu", () => {
    expect(stepHides(0)).toEqual({ wordmark: false, harnessText: false, until: false });
    expect(stepHides(1)).toEqual({ wordmark: true, harnessText: false, until: false });
    expect(stepHides(2)).toEqual({ wordmark: true, harnessText: true, until: false });
    expect(stepHides(3)).toEqual({ wordmark: true, harnessText: true, until: true });
  });
});

describe("requiredWidth", () => {
  test("subtracts each hidden part", () => {
    expect([0, 1, 2, 3].map((s) => requiredWidth(s as AppBarStep, W))).toEqual([700, 640, 540, 480]);
  });
});

describe("chooseFitStep", () => {
  test("a wide bar stays at step 0", () => {
    expect(chooseFitStep(1200, W, 0)).toBe(0);
    expect(chooseFitStep(700, W, 0)).toBe(0);
  });

  test("each threshold, one pixel either side, when growing", () => {
    expect(chooseFitStep(699, W, 0)).toBe(1);
    expect(chooseFitStep(640, W, 0)).toBe(1);
    expect(chooseFitStep(639, W, 0)).toBe(2);
    expect(chooseFitStep(540, W, 0)).toBe(2);
    expect(chooseFitStep(539, W, 0)).toBe(3);
    expect(chooseFitStep(480, W, 0)).toBe(3);
  });

  test("nothing fits: the last step (the header clips, the document does not scroll)", () => {
    expect(chooseFitStep(300, W, 0)).toBe(3);
    expect(chooseFitStep(0, W, 2)).toBe(3);
  });

  test("hysteresis: shrinking the step needs the spare margin, growing does not", () => {
    // From step 2, step 1 fits exactly at 640 but not with the margin.
    expect(chooseFitStep(640, W, 2)).toBe(2);
    expect(chooseFitStep(640 + APP_BAR_FIT_HYSTERESIS_PX - 1, W, 2)).toBe(2);
    expect(chooseFitStep(640 + APP_BAR_FIT_HYSTERESIS_PX, W, 2)).toBe(1);
    // From step 1, one pixel short of step 1 grows immediately.
    expect(chooseFitStep(639, W, 1)).toBe(2);
  });

  test("a big jump in width can skip steps in either direction", () => {
    expect(chooseFitStep(2000, W, 3)).toBe(0);
    expect(chooseFitStep(490, W, 0)).toBe(3);
  });

  test("unmeasured input renders step 0", () => {
    expect(chooseFitStep(100, { ...W, full: 0 }, 2)).toBe(0);
    expect(chooseFitStep(100, { ...W, full: Number.NaN }, 2)).toBe(0);
    expect(chooseFitStep(Number.NaN, W, 2)).toBe(0);
  });

  test("no 'until' text: step 3 needs the same width as step 2", () => {
    const noUntil = { ...W, until: 0 };
    expect(requiredWidth(3, noUntil)).toBe(requiredWidth(2, noUntil));
    expect(chooseFitStep(540, noUntil, 0)).toBe(2);
  });

  test("every step is reachable and none is skipped while the width falls one pixel at a time", () => {
    const seen = new Set<AppBarStep>();
    let previous: AppBarStep = 0;
    for (let available = 800; available >= 400; available--) {
      previous = chooseFitStep(available, W, previous);
      seen.add(previous);
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });
});

import { describe, expect, test } from "bun:test";
import {
  APP_BAR_FIT_HYSTERESIS_PX,
  chooseFitStep,
  requiredWidth,
  stepHides,
  type AppBarPartWidths,
  type AppBarStep,
} from "./app-bar-fit.ts";

// step 0 = 700, 1 = 640, 2 = 630 (Import 40 → More 30), 3 = 530, 4 = 470.
const W: AppBarPartWidths = { full: 700, wordmark: 60, importAction: 40, more: 30, harnessText: 100, until: 60 };

describe("stepHides", () => {
  test("matches the collapse ladder", () => {
    expect(stepHides(0)).toEqual({ wordmark: false, importInMore: false, harnessText: false, until: false });
    expect(stepHides(1)).toEqual({ wordmark: true, importInMore: false, harnessText: false, until: false });
    expect(stepHides(2)).toEqual({ wordmark: true, importInMore: true, harnessText: false, until: false });
    expect(stepHides(3)).toEqual({ wordmark: true, importInMore: true, harnessText: true, until: false });
    expect(stepHides(4)).toEqual({ wordmark: true, importInMore: true, harnessText: true, until: true });
  });
});

describe("requiredWidth", () => {
  test("subtracts each hidden part; step 2 swaps Import for More", () => {
    expect([0, 1, 2, 3, 4].map((s) => requiredWidth(s as AppBarStep, W))).toEqual([700, 640, 630, 530, 470]);
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
    expect(chooseFitStep(630, W, 0)).toBe(2);
    expect(chooseFitStep(629, W, 0)).toBe(3);
    expect(chooseFitStep(530, W, 0)).toBe(3);
    expect(chooseFitStep(529, W, 0)).toBe(4);
    expect(chooseFitStep(470, W, 0)).toBe(4);
  });

  test("nothing fits: the last step (the header clips, the document does not scroll)", () => {
    expect(chooseFitStep(300, W, 0)).toBe(4);
    expect(chooseFitStep(0, W, 2)).toBe(4);
  });

  test("hysteresis: shrinking the step needs the spare margin, growing does not", () => {
    // From step 3, step 2 fits exactly at 630 but not with the margin.
    expect(chooseFitStep(630, W, 3)).toBe(3);
    expect(chooseFitStep(630 + APP_BAR_FIT_HYSTERESIS_PX - 1, W, 3)).toBe(3);
    expect(chooseFitStep(630 + APP_BAR_FIT_HYSTERESIS_PX, W, 3)).toBe(2);
    // From step 2, one pixel short of step 2 grows immediately.
    expect(chooseFitStep(629, W, 2)).toBe(3);
  });

  test("a big jump in width can skip steps in either direction", () => {
    expect(chooseFitStep(2000, W, 4)).toBe(0);
    expect(chooseFitStep(480, W, 0)).toBe(4);
  });

  test("unmeasured input renders step 0", () => {
    expect(chooseFitStep(100, { ...W, full: 0 }, 3)).toBe(0);
    expect(chooseFitStep(100, { ...W, full: Number.NaN }, 3)).toBe(0);
    expect(chooseFitStep(Number.NaN, W, 3)).toBe(0);
  });

  test("no 'until' text: step 4 needs the same width as step 3", () => {
    const noUntil = { ...W, until: 0 };
    expect(requiredWidth(4, noUntil)).toBe(requiredWidth(3, noUntil));
    expect(chooseFitStep(530, noUntil, 0)).toBe(3);
  });
});

describe("Import and More are the same box (the shipped case)", () => {
  // Both are one 32 px icon button with the same gap, so swapping one for the
  // other frees nothing: step 2 needs exactly what step 1 needs and Import only
  // ever moves together with step 3 (the 'Harnesses' text collapse).
  const EQ: AppBarPartWidths = { ...W, importAction: 40, more: 40 };

  test("step 2 frees no width", () => {
    expect(requiredWidth(2, EQ)).toBe(requiredWidth(1, EQ));
  });

  test("step 2 is never chosen on its own, growing or shrinking, at any width", () => {
    // `previous` is never 2 here: the fit can only reach 2 from 2.
    for (const previous of [0, 1, 3, 4] as AppBarStep[]) {
      for (let available = 400; available <= 800; available++) {
        expect(chooseFitStep(available, EQ, previous), `${available}px from ${previous}`).not.toBe(2);
      }
    }
  });

  test("the fit goes 1 -> 3, never 2", () => {
    expect(chooseFitStep(requiredWidth(1, EQ), EQ, 0)).toBe(1);
    expect(chooseFitStep(requiredWidth(1, EQ) - 1, EQ, 1)).toBe(3);
  });
});


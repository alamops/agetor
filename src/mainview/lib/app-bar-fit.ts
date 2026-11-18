/**
 * The app bar's collapse ladder as pure arithmetic. The bar measures a hidden
 * step-0 copy of itself (the "ghost", `components/app-bar/AppBar.tsx`) and
 * `chooseFitStep` picks the smallest step whose content fits the header.
 * Contract: docs/architecture/app-bar.md.
 *
 * Ladder (D-P3): 0 everything · 1 wordmark hidden · 2 Import moves into the
 * More menu · 3 "Harnesses" text, count and % hidden · 4 "until HH:MM" hidden.
 * The logo, status dot, meter, failover badge, Settings, Pipelines, Git and
 * Worktrees never hide.
 */

export type AppBarStep = 0 | 1 | 2 | 3 | 4;

export interface AppBarPartWidths {
  /** The whole step-0 content, left cluster + gap + right cluster. */
  full: number;
  /** The wordmark and the gap that separates it from its neighbor. */
  wordmark: number;
  /** The Import button and its gap. */
  importAction: number;
  /** The More button and its gap. */
  more: number;
  /** "Harnesses", the count and the % (with their gaps). */
  harnessText: number;
  /** The "until HH:MM" text and its gap. */
  until: number;
}

/** Subpixel jitter absorber: shrinking the step needs this much spare room. */
export const APP_BAR_FIT_HYSTERESIS_PX = 8;

export const APP_BAR_LAST_STEP: AppBarStep = 4;

export function stepHides(step: AppBarStep): {
  wordmark: boolean;
  importInMore: boolean;
  harnessText: boolean;
  until: boolean;
} {
  return {
    wordmark: step >= 1,
    importInMore: step >= 2,
    harnessText: step >= 3,
    until: step >= 4,
  };
}

/** The width the bar needs at `step`. */
export function requiredWidth(step: AppBarStep, w: AppBarPartWidths): number {
  const hides = stepHides(step);
  let width = w.full;
  if (hides.wordmark) width -= w.wordmark;
  if (hides.importInMore) width = width - w.importAction + w.more;
  if (hides.harnessText) width -= w.harnessText;
  if (hides.until) width -= w.until;
  return width;
}

function measured(w: AppBarPartWidths): boolean {
  return Number.isFinite(w.full) && w.full > 0;
}

/**
 * The step to render for `available` px of header content width.
 *
 * - The smallest step that fits wins; if none fits, the last one (the header
 *   then clips instead of scrolling the document).
 * - Hysteresis: going to a smaller step (less collapsed) needs
 *   {@link APP_BAR_FIT_HYSTERESIS_PX} of spare room; going to a larger step
 *   happens as soon as the current one overflows.
 * - Unmeasured input (zero or non-finite `full`) renders step 0.
 */
export function chooseFitStep(available: number, w: AppBarPartWidths, previous: AppBarStep): AppBarStep {
  if (!measured(w) || !Number.isFinite(available)) return 0;
  const steps: AppBarStep[] = [0, 1, 2, 3, 4];
  const fits = (s: AppBarStep, slack: number) => requiredWidth(s, w) <= available - slack;
  // The step that fits with no slack at all: what we need once we must grow.
  const needed = steps.find((s) => fits(s, 0)) ?? APP_BAR_LAST_STEP;
  if (needed > previous) return needed;
  // Shrinking: only when the smaller step fits with the hysteresis margin.
  const relaxed = steps.find((s) => fits(s, APP_BAR_FIT_HYSTERESIS_PX)) ?? APP_BAR_LAST_STEP;
  return relaxed < previous ? relaxed : previous;
}

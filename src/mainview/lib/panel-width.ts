/**
 * Persisted width for the RunPanel slide-over (user-resizable via the drag
 * handle on the panel's left edge).
 *
 * localStorage rather than the server-side preferences API on purpose — same
 * rationale as `panel-collapse.ts`: pure webview chrome that must resolve
 * *synchronously during the first render*, otherwise the panel paints at the
 * default width and snaps a frame later.
 *
 * Every access is wrapped: `globalThis.localStorage` throws (not returns
 * null) under some privacy/sandbox settings, and `setItem` throws on quota.
 * A storage failure must never take the panel down with it, so the reader
 * falls back to the default and the writer is best-effort.
 */

import { NEW_TASK_PANEL_WIDTH_KEY, type PanelStorage } from "./panel-collapse.ts";

export { NEW_TASK_PANEL_WIDTH_KEY };

/** Storage key for the RunPanel's persisted width (px, integer). */
export const RUN_PANEL_WIDTH_KEY = "agetor:runPanelWidth";

/** Default width when nothing (valid) is persisted. */
export const RUN_PANEL_DEFAULT_WIDTH = 720;

/** Narrowest the user can drag the panel — below this the header buttons
 *  and the composer toolbar start wrapping into unusable layouts. */
export const RUN_PANEL_MIN_WIDTH = 420;

/** Widest the panel may grow, as a fraction of the viewport — the board
 *  behind it must stay visible enough to keep context. Mirrors the CSS
 *  `max-w-[90vw]` backstop on the `<aside>` itself. */
export const RUN_PANEL_MAX_VIEWPORT_FRACTION = 0.9;

function defaultStorage(): PanelStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Clamp a candidate width into the allowed range for the given viewport.
 * The lower bound wins over the upper one when the viewport is so narrow
 * that 90vw < min width — the CSS `max-w-[90vw]` on the panel is what caps
 * the *rendered* width in that degenerate case, so state never goes below
 * the minimum and re-widening the window restores a usable panel.
 */
export function clampPanelWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return RUN_PANEL_DEFAULT_WIDTH;
  const cap = Math.max(
    RUN_PANEL_MIN_WIDTH,
    Math.floor(viewportWidth * RUN_PANEL_MAX_VIEWPORT_FRACTION),
  );
  return Math.min(Math.max(Math.round(width), RUN_PANEL_MIN_WIDTH), cap);
}

/** Read the persisted panel width, clamped for the given viewport. Defaults
 *  to `RUN_PANEL_DEFAULT_WIDTH` (clamped) whenever storage is unavailable,
 *  empty, or holds a non-numeric value. */
export function readPanelWidth(
  viewportWidth: number,
  storage: PanelStorage | null = defaultStorage(),
): number {
  let raw: string | null = null;
  if (storage) {
    try {
      raw = storage.getItem(RUN_PANEL_WIDTH_KEY);
    } catch {
      raw = null;
    }
  }
  const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
  return clampPanelWidth(
    Number.isNaN(parsed) ? RUN_PANEL_DEFAULT_WIDTH : parsed,
    viewportWidth,
  );
}

/** Persist the panel width. Best-effort — a throwing/full storage is
 *  swallowed, the panel just won't remember its width next launch. */
export function writePanelWidth(
  width: number,
  storage: PanelStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(RUN_PANEL_WIDTH_KEY, String(Math.round(width)));
  } catch {
    /* quota / disabled storage — width simply doesn't persist */
  }
}

// ---------------------------------------------------------------------------
// New Task panel width (resizable by drag and keyboard).
// ---------------------------------------------------------------------------

/** Default width when nothing (valid) is persisted. */
export const NEW_TASK_PANEL_DEFAULT_WIDTH = 384;
/** Narrowest the user can make the panel. */
export const NEW_TASK_PANEL_MIN_WIDTH = 320;
/** Widest the user can make the panel. */
export const NEW_TASK_PANEL_MAX_WIDTH = 560;
/** The board must keep at least this much room next to the panel. */
export const NEW_TASK_PANEL_MIN_BOARD_WIDTH = 480;

/**
 * Generic width clamp: inside `[min, max]`, and (when `viewportWidth` is given)
 * no wider than `viewportWidth - minRemaining` so the content next to the
 * panel keeps its room. The lower bound wins on a degenerate viewport, so state
 * never goes below the minimum and re-widening the window restores a usable
 * panel.
 */
export function clampWidth(
  width: number,
  opts: { min: number; max: number; fallback: number; viewportWidth?: number; minRemaining?: number },
): number {
  if (!Number.isFinite(width)) return opts.fallback;
  let cap = opts.max;
  if (opts.viewportWidth !== undefined) cap = Math.min(cap, opts.viewportWidth - (opts.minRemaining ?? 0));
  cap = Math.max(opts.min, cap);
  return Math.min(Math.max(Math.round(width), opts.min), cap);
}

/** Clamp a New Task panel width for the given viewport. */
export function clampNewTaskPanelWidth(width: number, viewportWidth: number): number {
  return clampWidth(width, {
    min: NEW_TASK_PANEL_MIN_WIDTH,
    max: NEW_TASK_PANEL_MAX_WIDTH,
    fallback: NEW_TASK_PANEL_DEFAULT_WIDTH,
    viewportWidth,
    minRemaining: NEW_TASK_PANEL_MIN_BOARD_WIDTH,
  });
}

/** Read the persisted New Task panel width, clamped for the viewport. */
export function readNewTaskPanelWidth(
  viewportWidth: number,
  storage: PanelStorage | null = defaultStorage(),
): number {
  let raw: string | null = null;
  if (storage) {
    try {
      raw = storage.getItem(NEW_TASK_PANEL_WIDTH_KEY);
    } catch {
      raw = null;
    }
  }
  const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
  return clampNewTaskPanelWidth(Number.isNaN(parsed) ? NEW_TASK_PANEL_DEFAULT_WIDTH : parsed, viewportWidth);
}

/** Persist the New Task panel width. Best-effort. */
export function writeNewTaskPanelWidth(
  width: number,
  storage: PanelStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(NEW_TASK_PANEL_WIDTH_KEY, String(Math.round(width)));
  } catch {
    /* quota / disabled storage — width simply doesn't persist */
  }
}

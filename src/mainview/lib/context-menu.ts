/** Pure geometry + keyboard-nav helpers for `ui/context-menu.tsx`, plus the
 *  native-context-menu suppression policy (owner decision D2 (b) in
 *  `docs/plans/task-context-menu.md`). No React, no DOM globals — everything
 *  here takes plain numbers/objects so it's testable without a browser. */

export interface PlaceContextMenuInput {
  /** Cursor (or anchor-rect) position the menu opens from, viewport coords. */
  x: number;
  y: number;
  /** Measured panel size. */
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Minimum gap kept between the panel and every viewport edge. Default 8,
   *  matching `InfoTip`'s `VIEWPORT_MARGIN`. */
  margin?: number;
}

/**
 * Positions a context menu opening bottom-right of `{x, y}` (the natural
 * right-click reading direction), flipping to the opposite side on whichever
 * axis would overflow the viewport, then clamping into the margin — same
 * two-step (place-then-clamp) strategy `InfoTip` uses for its popover, so a
 * menu opened near a corner never renders partly off-screen.
 */
export function placeContextMenu(input: PlaceContextMenuInput): { top: number; left: number } {
  const { x, y, width, height, viewportWidth, viewportHeight } = input;
  const margin = input.margin ?? 8;

  let left = x;
  if (x + width > viewportWidth - margin) left = x - width;

  let top = y;
  if (y + height > viewportHeight - margin) top = y - height;

  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  left = clamp(left, margin, viewportWidth - width - margin);
  top = clamp(top, margin, viewportHeight - height - margin);

  return { top, left };
}

/**
 * Roving-focus step for the menu's ArrowUp/ArrowDown handling: advance from
 * `current` by `delta`, wrapping around the ends, and skipping any index
 * whose `enabled[i]` is false (separators and disabled items never receive
 * focus). `current === -1` means nothing is focused yet — `delta === 1`
 * lands on the first enabled item, `delta === -1` on the last, mirroring
 * "open the menu, press Down, land on the top item". If no index is enabled
 * at all, there's nowhere to move to, so `current` is returned unchanged.
 */
export function moveMenuIndex(current: number, delta: 1 | -1, enabled: readonly boolean[]): number {
  const n = enabled.length;
  if (n === 0 || !enabled.some(Boolean)) return current;

  if (current === -1) {
    if (delta === 1) {
      const first = enabled.indexOf(true);
      return first;
    }
    const last = enabled.lastIndexOf(true);
    return last;
  }

  let i = current;
  for (let step = 0; step < n; step++) {
    i = (i + delta + n) % n;
    if (enabled[i]) return i;
  }
  // Unreachable given the `.some(Boolean)` guard above, but keeps the
  // function total instead of possibly returning undefined-shaped -1 math.
  return current;
}

/**
 * CSS selector for the surfaces where WebKit's native right-click menu must
 * keep working instead of being replaced by our own (owner decision D2 (b)):
 * anything the user might want to spell-check / "Look Up" / paste-and-match-
 * style into — text-entry `input`s (excluding the non-text input variants,
 * which have no native text-editing menu of their own), `textarea`,
 * editable rich-text regions, and the xterm terminal (which ships its own
 * right-click paste/selection behavior we must not shadow).
 */
export const NATIVE_CONTEXT_MENU_SELECTOR =
  'input:not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="range"]):not([type="file"]), textarea, [contenteditable]:not([contenteditable="false"]), .xterm';

/**
 * Whether `target` (the `contextmenu` event's `event.target`) sits inside a
 * surface the native menu must keep serving. Duck-types the DOM `Element`
 * contract (`closest`) instead of requiring an actual `Element`/`Node`, so
 * this is callable from a unit test with a plain stub object — no jsdom
 * needed. `null`/`undefined`/an object with no `closest` all resolve to
 * false (nothing to preserve).
 */
export function keepsNativeContextMenu(target: EventTarget | null): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null | undefined;
  return Boolean(el?.closest?.(NATIVE_CONTEXT_MENU_SELECTOR));
}

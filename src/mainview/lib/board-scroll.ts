/**
 * Session memory for the kanban board's scroll position
 * (`docs/plans/board-scroll-position.md`).
 *
 * `App.tsx` swaps whole pages under `<AnimatePresence mode="wait">`, so going
 * to any pipeline page unmounts the board and its `.kanban-scroll` element
 * comes back at `0,0`. This module keeps the offsets across that remount:
 *
 * - The board saves both axes from its `onScroll` (never at unmount — a
 *   detached or hidden element reads `0,0`).
 * - A stable callback ref calls `restoreBoardScroll` when the scroller
 *   mounts again, which writes the offsets back synchronously (the spike in
 *   the investigation proved that sticks, even under motion's initial
 *   `opacity:0; translateY(8px)`).
 * - When the user left from a pipeline-parent card (its body, Open or
 *   Answer/Review button, or its context menu's Open pipeline), that card's
 *   id is the "departure". The first return reveals it by the minimum
 *   distance, only when it is now ENTIRELY out of the scroller's client box,
 *   and then forgets it.
 *
 * Module state only, never `localStorage`: a reload starts at the top (D2).
 * No React import — the pure parts are unit-tested with `bun test`.
 */

/** A rectangle in one coordinate space (client pixels, as
 *  `getBoundingClientRect()` returns them). */
export interface ViewportRect { left: number; top: number; right: number; bottom: number }

let offsets = { left: 0, top: 0 };
let departure: string | null = null;

/** One axis of `revealScrollDelta`: how far the view must move so the target
 *  span `[tS, tE]` sits inside `[vS, vE]`, by the minimum distance. A target
 *  larger than the view aligns its start, unless it already overlaps. */
function axisDelta(vS: number, vE: number, tS: number, tE: number): number {
  if (tS >= vS && tE <= vE) return 0;
  if (tE - tS > vE - vS) return tS < vE && tE > vS ? 0 : tS - vS;
  if (tS < vS) return tS - vS;
  return tE - vE;
}

/** The scroll delta that brings `target` into `view`, or `null` when nothing
 *  should move: the target has no area, or any part of it is already inside
 *  the view (D6 — a partly visible card stays put). Touching edges count as
 *  out of view. Otherwise each axis moves by the minimum distance (D7). */
export function revealScrollDelta(view: ViewportRect, target: ViewportRect): { dx: number; dy: number } | null {
  if (target.right - target.left <= 0 || target.bottom - target.top <= 0) return null;
  const overlaps =
    target.left < view.right && target.right > view.left && target.top < view.bottom && target.bottom > view.top;
  if (overlaps) return null;
  return {
    dx: axisDelta(view.left, view.right, target.left, target.right),
    dy: axisDelta(view.top, view.bottom, target.top, target.bottom),
  };
}

/** Remember the board's offsets — called from its `onScroll`. */
export function saveBoardScroll(left: number, top: number): void {
  offsets = { left, top };
}

/** The last saved board offsets (`0,0` until the board is first scrolled). */
export function boardScrollOffsets(): { left: number; top: number } {
  return { ...offsets };
}

/** Record that the board was left from this pipeline-parent card. Only the
 *  card paths call it (`fromBoardCard`), once their navigation commits; a
 *  later record overwrites an earlier one. */
export function recordBoardDeparture(taskId: string): void {
  departure = taskId;
}

/** Return the departure card id and clear it, so it reveals at most once. */
export function takeBoardDeparture(): string | null {
  const id = departure;
  departure = null;
  return id;
}

/** Forget the departure without using it (the board came back without a
 *  remount, so there is nothing to reveal). */
export function discardBoardDeparture(): void {
  departure = null;
}

/** Restore the board's scroll position on a freshly mounted scroller: write
 *  the saved offsets, take the departure, reveal that card when it is
 *  rendered and entirely out of view, then save the resulting (possibly
 *  clamped) offsets synchronously. That last save is what makes React
 *  StrictMode's second ref call idempotent — without it the second call
 *  would write the pre-reveal offsets back, since the `scroll` event that
 *  would have saved them fires after the commit. */
export function restoreBoardScroll(el: HTMLElement): void {
  el.scrollLeft = offsets.left;
  el.scrollTop = offsets.top;
  const id = takeBoardDeparture();
  if (id) {
    const card = el.querySelector(`[data-task-id="${CSS.escape(id)}"]`);
    if (card) {
      const box = el.getBoundingClientRect();
      const left = box.left + el.clientLeft;
      const top = box.top + el.clientTop;
      const view = { left, top, right: left + el.clientWidth, bottom: top + el.clientHeight };
      const delta = revealScrollDelta(view, card.getBoundingClientRect());
      if (delta) {
        el.scrollLeft += delta.dx;
        el.scrollTop += delta.dy;
      }
    }
  }
  saveBoardScroll(el.scrollLeft, el.scrollTop);
}

/** Reset the module state between unit tests. */
export function resetBoardScrollMemoryForTest(): void {
  offsets = { left: 0, top: 0 };
  departure = null;
}

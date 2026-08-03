// Pure decision helper for RunPanel's live-event-window front-trim.
//
// Background: RunPanel caps the live `events` array at `EVENTS_WINDOW_MAX` so
// a long-running task doesn't grow an unbounded in-memory/DOM list — once the
// window is exceeded, the SSE flush callback trims from the FRONT (oldest
// events), which is content ABOVE whatever the user is currently looking at.
// Trimming unconditionally on every flush is fine when the user is pinned to
// the bottom (the same content they'd never scroll back to is what's getting
// dropped), but a user parked mid-history to read old messages gets that
// history yanked out from under them on every flush — `nearBottomRef` is
// false there, so neither pin-to-bottom path fires to mask the jump, and
// "Load earlier"'s scroll-restore only compensates for its own prepend, not
// for a concurrent trim shrinking the front. This module answers "should this
// flush trim the front now, or defer?" so RunPanel can skip the trim while a
// reader is mid-history, without letting the window grow forever.

/**
 * Decides how many of the newest events to keep on this flush, or whether to
 * skip trimming entirely.
 *
 * Returns `null` (don't trim — keep everything) when either:
 *  - `length` hasn't exceeded `max` yet, so there's nothing to trim; or
 *  - the user is NOT near the bottom (mid-history) AND `length` is still
 *    under `max * 2` — deferring the trim so content already on screen (or
 *    just above it) doesn't vanish out from under a reader. This is a
 *    deferral, not an exemption: a reader who stays mid-history through
 *    enough flushes to double the window still hits the hard cap below,
 *    which is the accepted trade-off that bounds memory over an unbounded
 *    task.
 *
 * Returns `max` (trim to the newest `max` events) once the window would
 * otherwise exceed the 2x hard cap, or whenever the user IS near the bottom —
 * trimming content that's already scrolled out of view above a bottom-pinned
 * reader is invisible to them.
 */
export function eventWindowKeepCount(length: number, nearBottom: boolean, max: number): number | null {
  if (length <= max) return null;
  if (!nearBottom && length <= max * 2) return null;
  return max;
}

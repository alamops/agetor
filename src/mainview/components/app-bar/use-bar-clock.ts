import { useEffect, useRef } from "react";

/** Never re-render the bar more often than this for a state change… */
export const BAR_CLOCK_MIN_MS = 1_000;
/** …nor leave it longer than this without a look (a laptop that slept). */
export const BAR_CLOCK_MAX_MS = 30 * 60_000;
/** While the panel is open it also re-renders on this beat ("updated N ago"). */
export const BAR_CLOCK_PANEL_TICK_MS = 30_000;

/** The delay until the next re-render for a model whose answer changes at
 *  `nextChangeAt`, clamped to [BAR_CLOCK_MIN_MS, BAR_CLOCK_MAX_MS]. */
export function barClockDelay(nextChangeAt: number | null, now: number): number {
  if (nextChangeAt === null) return BAR_CLOCK_MAX_MS;
  return Math.min(BAR_CLOCK_MAX_MS, Math.max(BAR_CLOCK_MIN_MS, nextChangeAt - now));
}

/**
 * The bar's one timer. It calls `onTick` at the next instant the harness
 * model changes on its own (a cooldown ends, a meter resets, a snapshot turns
 * stale), and every 30 s while the panel is open. One `setTimeout` for the
 * state change (re-armed when `nextChangeAt` changes, cleared on unmount) and,
 * only while the panel is open, one `setInterval`.
 *
 * `onTick` bumps a counter in `AppBar`, which re-reads the wall clock; this
 * hook never holds time itself, so a model rebuild from fresh data also gets
 * a fresh `now`.
 */
export function useBarClock(
  nextChangeAt: number | null,
  panelOpen: boolean,
  /** The counter `onTick` bumps: re-arms the timer after it fires, even when `nextChangeAt` is unchanged (a clamped wait). */
  tick: number,
  onTick: () => void,
): void {
  const tickRef = useRef(onTick);
  tickRef.current = onTick;

  useEffect(() => {
    const id = setTimeout(() => tickRef.current(), barClockDelay(nextChangeAt, Date.now()));
    return () => clearTimeout(id);
  }, [nextChangeAt, tick]);

  useEffect(() => {
    if (!panelOpen) return;
    const id = setInterval(() => tickRef.current(), BAR_CLOCK_PANEL_TICK_MS);
    return () => clearInterval(id);
  }, [panelOpen]);
}

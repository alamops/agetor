// Coalescing buffer for the unified task-level event stream the run panel
// renders. Incoming SSE events are accumulated and emitted in batches so the
// open-time replay burst (the server streams the whole history one frame per
// event) collapses to O(N) renders instead of O(N²) — see the RunPanel SSE
// effect and the `event-dedup` helper it pairs with.
//
// Extracted as a pure, scheduler-agnostic helper (like `event-dedup.ts`) so the
// load-bearing invariant can be unit-tested apart from the React effect: a
// flush must *re-arm* on the next push. The original inline version gated
// arming on `if (raf === 0)` against a raw rAF handle; when the macOS WKWebView
// suspended an occluded window, WebKit could drop the pending rAF without ever
// firing it, leaving the handle non-zero so no future event rescheduled — the
// stream froze until a remount. Routing every arm/flush through this buffer
// (and resetting the handle inside `flush`) is what guarantees recovery.
//
// The buffer knows nothing about rAF, timers, or `visibilitychange`. The caller
// injects an `arm` strategy (in RunPanel: race a `requestAnimationFrame`
// against a `setTimeout` fallback) and may call `flushNow()` directly from
// focus / visibility handlers to drain the instant the window returns.

/** Arms a deferred `flush`. Returns a thunk that cancels the pending
 *  invocation. The buffer calls this at most once per armed cycle (one arm per
 *  flush), so the strategy is free to schedule several racing timers and cancel
 *  them all in the returned thunk. */
export type ArmStrategy = (flush: () => void) => () => void;

export interface EventBuffer<T> {
  /** Queue an item and arm a flush if one isn't already pending. */
  push(item: T): void;
  /** Drain immediately (cancelling any pending arm). No-op when empty. Safe to
   *  call repeatedly and from event handlers — this is the focus / visibility
   *  recovery path. */
  flushNow(): void;
  /** Cancel any pending arm and discard buffered items without emitting. */
  dispose(): void;
}

/**
 * Create a coalescing event buffer.
 *
 * @param emit  Called with each non-empty batch, in push order. In RunPanel
 *              this appends to React state.
 * @param arm   Schedules a deferred flush; see {@link ArmStrategy}.
 */
export function createEventBuffer<T>(
  emit: (batch: T[]) => void,
  arm: ArmStrategy,
): EventBuffer<T> {
  let pending: T[] = [];
  // The cancel thunk for the in-flight arm, or null when nothing is armed.
  // Doubles as the "is something scheduled?" flag — resetting it to null inside
  // `flush` is what lets the next push re-arm (the regression-prone invariant).
  let disarm: (() => void) | null = null;

  const flush = () => {
    if (disarm) {
      disarm();
      disarm = null;
    }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    emit(batch);
  };

  return {
    push(item: T) {
      pending.push(item);
      if (!disarm) disarm = arm(flush);
    },
    flushNow() {
      flush();
    },
    dispose() {
      if (disarm) {
        disarm();
        disarm = null;
      }
      pending = [];
    },
  };
}

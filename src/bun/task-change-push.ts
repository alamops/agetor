import type { GlobalEvent } from "../shared/types.ts";
import { currentRev } from "./db-async.ts";
import { publishGlobalEvent } from "./orchestrator.ts";
import { onTasksChanged } from "./task-change-bus.ts";
import { currentTaskDeltaCursor, primeTaskDeltaEpoch } from "./task-delta-route.ts";

// The push half of the board's delta refresh (docs/plans/non-blocking-core.md,
// T12/T14b): every `task-change-bus` announcement (a worker reply whose rev moved
// - migration 093's triggers - or a decoration change from terminals, the stall
// registry or interactions) becomes one `tasks-changed {cursor}` event on the
// EXISTING global SSE stream (`GET /events`; no new connection), throttled and
// coalesced:
//   - the first change after a quiet period of at least `intervalMs` goes out at
//     once (leading edge);
//   - changes inside the window collapse into ONE trailing emit when it ends;
//   - so at most one event per `intervalMs`, and a burst of 100 changes is two.
// An emit does no database read: the cursor is the cached epoch + the rev the
// worker replies piggyback + the decoration rev. A failed emit (the epoch read
// failed while the database restarts) is logged and dropped: the next change
// emits again and the client's safety poll covers the gap.

/** Trailing/leading throttle window of the `tasks-changed` event. */
export const TASKS_CHANGED_INTERVAL_MS = 250;

export interface TasksChangedPushDeps {
  /** Subscribe to "some task changed"; returns the unsubscribe. */
  subscribe(cb: () => void): () => void;
  /** The cursor to announce (no database read). */
  cursor(): Promise<string>;
  publish(e: GlobalEvent): void;
  intervalMs: number;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  log(message: string): void;
}

/** Wire the throttle over injected dependencies; returns the stop function. */
export function createTasksChangedPush(deps: TasksChangedPushDeps): () => void {
  let lastEmitAt = -Infinity;
  let timer: unknown = null;
  let dirty = false;

  const emit = (): void => {
    lastEmitAt = deps.now();
    dirty = false;
    deps.cursor().then(
      (cursor) => deps.publish({ kind: "tasks-changed", cursor, ts: Date.now() }),
      (err: unknown) => deps.log(`[agetor:tasks-changed] no cursor, event dropped: ${err instanceof Error ? err.message : String(err)}`),
    );
  };

  const onTimer = (): void => {
    timer = null;
    // The trailing emit opens a new window, so a later change gets its own timer.
    if (dirty) emit();
  };

  const unsubscribe = deps.subscribe(() => {
    const wait = lastEmitAt + deps.intervalMs - deps.now();
    if (timer === null && wait <= 0) {
      emit();
      return;
    }
    dirty = true;
    if (timer === null) timer = deps.setTimer(onTimer, Math.max(1, wait));
  });

  return () => {
    unsubscribe();
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
    dirty = false;
  };
}

/** Production wiring: boot calls this once (index.ts, headless.ts) after the
 *  boot gate opens. Primes the cached epoch so no emit reads the database. */
export function startTasksChangedPush(): () => void {
  void primeTaskDeltaEpoch().catch((err: unknown) => {
    console.warn("[agetor:tasks-changed] epoch read failed; retried on the first emit:", err instanceof Error ? err.message : err);
  });
  return createTasksChangedPush({
    subscribe: (cb) => onTasksChanged(() => cb()),
    cursor: () => currentTaskDeltaCursor(currentRev()),
    publish: publishGlobalEvent,
    intervalMs: TASKS_CHANGED_INTERVAL_MS,
    now: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    log: (m) => console.warn(m),
  });
}

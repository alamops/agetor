/**
 * In-memory registry of tasks whose in-flight turn the claude-tmux stall
 * watchdog has flagged as possibly stuck (no transcript activity past the
 * stall threshold — see TURN_STALLED_STATUS_PREFIX in shared/types.ts).
 *
 * Deliberately NOT persisted: the mark describes a live process condition,
 * and after a restart the reattached session's watchdog re-derives it within
 * one threshold window if the wedge is real. Written by orchestrator.ts's
 * chunk handler (sentinel match) and cleared on resume / turn settle /
 * task teardown; read by server.ts to decorate `Task.stalledSince` onto API
 * responses. Its own module (rather than orchestrator state) so it's
 * gate-testable without orchestrator.ts's module-load side effects.
 */

const stalled = new Map<string, number>();

/** Mark a task's in-flight turn as possibly stuck. First mark wins — a
 *  repeated sentinel for the same continuous stall keeps the original
 *  timestamp so the UI's "since …" doesn't slide. */
export function markStalled(taskId: string, at: number): void {
  if (!stalled.has(taskId)) stalled.set(taskId, at);
}

export function clearStalled(taskId: string): void {
  stalled.delete(taskId);
}

/** `Date.now()` when the task was flagged, or null when it isn't. */
export function stalledSince(taskId: string): number | null {
  return stalled.get(taskId) ?? null;
}

/** Test-only reset so cases can't leak marks into each other. */
export function __clearAllStalled(): void {
  stalled.clear();
}

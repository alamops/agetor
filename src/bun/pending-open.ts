/**
 * Tiny in-memory store for a cold-start deep-link open request.
 *
 * When a notification's `agetor://task/<id>` deep link is clicked while no
 * main window exists (app was fully dismissed), Electrobun surfaces it as an
 * `open-url` event before the webview has had a chance to connect to the
 * `/app/events` SSE channel — there's no client to broadcast the
 * `open_task` AppEvent to yet. `setPendingOpenTask` stashes the taskId here;
 * the SSE route calls `consumePendingOpenTask()` right after a client
 * subscribes so the very first thing it hears is the open request it missed.
 *
 * Pure module-level state, no side effects at import time, so it's trivially
 * testable and safe to import from both index.ts and server.ts.
 */

let pendingOpenTaskId: string | null = null;

/** Record a taskId to be delivered to the next `/app/events` subscriber. */
export function setPendingOpenTask(taskId: string): void {
  pendingOpenTaskId = taskId;
}

/** Return and clear the pending taskId, or `null` if none is queued. */
export function consumePendingOpenTask(): string | null {
  const taskId = pendingOpenTaskId;
  pendingOpenTaskId = null;
  return taskId;
}

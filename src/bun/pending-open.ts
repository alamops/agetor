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
 * The entry carries a short TTL. `EventSource` reconnects automatically, so
 * without an expiry a taskId stashed now could be drained by an unrelated
 * reconnect minutes later and suddenly open a task the user clicked long ago.
 * The TTL bounds that: only a subscriber that connects within
 * PENDING_OPEN_TTL_MS of the click gets the open; a later flush returns null.
 *
 * Pure module-level state, no side effects at import time, so it's trivially
 * testable (both setters accept an injectable `now`) and safe to import from
 * both index.ts and server.ts.
 */

/** How long a stashed open stays deliverable. Long enough to cover a window
 *  cold-start + webview boot, short enough that a later reconnect can't
 *  resurrect a stale click. */
export const PENDING_OPEN_TTL_MS = 10_000;

let pending: { taskId: string; ts: number } | null = null;

/** Record a taskId to be delivered to the next `/app/events` subscriber. */
export function setPendingOpenTask(taskId: string, now: number = Date.now()): void {
  pending = { taskId, ts: now };
}

/**
 * Return and clear the pending taskId, or `null` if none is queued or the
 * queued one is older than PENDING_OPEN_TTL_MS (stale — dropped, not opened).
 */
export function consumePendingOpenTask(now: number = Date.now()): string | null {
  const entry = pending;
  pending = null;
  if (!entry) return null;
  if (now - entry.ts > PENDING_OPEN_TTL_MS) return null;
  return entry.taskId;
}

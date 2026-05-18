import type { AppEvent } from "../shared/types.ts";

/**
 * Coordinates "warn before quit when runs are active". Three actors share
 * state via this module:
 *
 *   • index.ts hooks Electrobun's `before-quit` event. If there are running
 *     runs and `forceQuit` is false, it broadcasts a `quit_request` to the
 *     webview and denies the quit.
 *   • server.ts exposes `GET /app/events` (SSE channel the webview
 *     subscribes to) and `POST /app/force-quit` (sets the flag + re-issues
 *     Utils.quit()).
 *   • The webview's QuitConfirmDialog hits `/app/force-quit` when the user
 *     confirms; the next `before-quit` fires with the flag set and
 *     short-circuits to `allow: true`.
 *
 * The flag is intentionally one-shot: each Utils.quit() consumes it. That
 * way a "cancel" path (user dismisses the dialog → never calls force-quit)
 * doesn't leave the next legitimate Cmd+Q ungated.
 */

type Listener = (e: AppEvent) => void;
const listeners = new Set<Listener>();

export function subscribeAppEvents(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function broadcastAppEvent(e: AppEvent): void {
  for (const fn of listeners) fn(e);
}

let forceQuit = false;

/** True iff the next Utils.quit() should be allowed through. Consuming —
 *  calling this resets the flag so a follow-up quit won't be auto-allowed. */
export function consumeForceQuit(): boolean {
  if (!forceQuit) return false;
  forceQuit = false;
  return true;
}

/** Arm the force-quit flag. Called by `POST /app/force-quit` after the
 *  webview's confirm dialog returns "Quit anyway". Returns `true` when this
 *  call actually flipped the flag — `false` means a previous call already
 *  armed it. Callers (the endpoint) use the return value to dedupe rapid
 *  retries: only the first request queues the Utils.quit() side effect, the
 *  rest are no-ops. */
export function armForceQuit(): boolean {
  if (forceQuit) return false;
  forceQuit = true;
  return true;
}

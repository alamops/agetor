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
 *
 * "Quit completely" (docs/plans/always-on-host.md D6/D7): with the background
 * option on, a plain quit parks the core under the login item instead of
 * stopping it. A quit that should stop everything carries `completely` —
 * either on the force-quit flag (the confirm dialog's "Quit completely"
 * button, via `POST /app/force-quit {completely:true}`) or, for the
 * "Quit Agetor Completely" menu item, on a separate one-shot
 * (`requestQuitCompletely` / `consumeQuitCompletely`) because that path needs
 * no confirm when nothing is running. `before-quit` reads whichever applies.
 */

type Listener = (e: AppEvent) => void;
const listeners = new Set<Listener>();

export function subscribeAppEvents(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** True while at least one `/app/events` client is connected. A boot-time
 *  notice sent with no listener reaches nobody — `/app/events` replays
 *  nothing — so callers that must not lose one check this first. */
export function hasAppEventListeners(): boolean {
  return listeners.size > 0;
}

export function broadcastAppEvent(e: AppEvent): void {
  for (const fn of listeners) fn(e);
}

let forceQuit = false;
let forceQuitCompletely = false;
let quitCompletely = false;

/** Non-null iff the next Utils.quit() should be allowed through; the value
 *  says whether it was armed as a "quit completely". Consuming — calling this
 *  resets the flag so a follow-up quit won't be auto-allowed. Truthiness is
 *  the "allowed" answer, so callers that only need that keep working. */
export function consumeForceQuit(): { completely: boolean } | null {
  if (!forceQuit) return null;
  const completely = forceQuitCompletely;
  forceQuit = false;
  forceQuitCompletely = false;
  return { completely };
}

/** Arm the force-quit flag. Called by `POST /app/force-quit` after the
 *  webview's confirm dialog returns "Quit anyway" (or "Quit completely"). Returns
 *  `true` when this call actually flipped the flag — `false` means a previous
 *  call already armed it. Callers (the endpoint) use the return value to
 *  dedupe rapid retries: only the first request queues the Utils.quit() side
 *  effect, the rest are no-ops. A repeat call never downgrades or upgrades the
 *  mode the first one chose. */
export function armForceQuit(opts?: { completely?: boolean }): boolean {
  if (forceQuit) return false;
  forceQuit = true;
  forceQuitCompletely = opts?.completely === true;
  return true;
}

/** Mark the next quit as "completely" without arming the force-quit bypass —
 *  the "Quit Agetor Completely" menu item calls this, then `Utils.quit()`.
 *  One-shot: `consumeQuitCompletely` resets it, so a cancelled quit doesn't
 *  turn the next plain Cmd+Q into a complete one. */
export function requestQuitCompletely(): void {
  quitCompletely = true;
}

/** True (once) when the menu path asked for a complete quit. */
export function consumeQuitCompletely(): boolean {
  if (!quitCompletely) return false;
  quitCompletely = false;
  return true;
}

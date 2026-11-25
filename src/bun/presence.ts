/**
 * Whether anyone is at the Mac: the window's focus, which task is open, and when the window last had focus
 * (docs/specs/remote-readiness-spec.md "Push notifications", grill D5).
 *
 * Two sources feed it:
 * - Electrobun's native window `focus` / `blur` events (`setNativeWindowFocus`): authoritative in the app once seen,
 *   because a backgrounded webview can't always report.
 * - The webview's `PUT /app/presence` report (`setWebviewPresence`): focus, the selected task and its view. The backup
 *   for focus, and the only source of the selected task. A headless core has neither, so `presence()` reads
 *   "not focused, nothing selected, no app attached" there and every qualifying event notifies.
 *
 * The notification policy (notification-policy.ts) reads it for the OS decision and the phone sink for "no push while
 * the window had focus in the last 2 minutes". Module state, one per core; `__testing.reset()` for tests.
 */

export type PresenceView = "run-panel" | "pipeline" | null;

export interface Presence {
  focused: boolean;
  selectedTaskId: string | null;
  view: string | null;
  /** The last time the window was focused (now, while it is), or null if it never was in this core's life. */
  lastFocusedAt: number | null;
  /** True when a desktop app owns this core. A background core has none and counts as away. */
  appAttached: boolean;
}

type Listener = (p: Presence) => void;

let nativeFocused: boolean | null = null;
let webviewFocused = false;
let selectedTaskId: string | null = null;
let view: PresenceView = null;
let lastFocusedAt: number | null = null;
let appAttached = false;
let clock: () => number = Date.now;
const listeners = new Set<Listener>();

function effectiveFocus(): boolean {
  // Native overrides the webview once a native event has been seen.
  return nativeFocused ?? webviewFocused;
}

function touchFocus(wasFocused: boolean): void {
  if (effectiveFocus() && !wasFocused) lastFocusedAt = clock();
  // Leaving focus stamps the moment it ended.
  if (!effectiveFocus() && wasFocused) lastFocusedAt = clock();
}

function emit(): void {
  const p = presence();
  for (const l of [...listeners]) {
    try {
      l(p);
    } catch {
      /* a listener must not break the others */
    }
  }
}

export function setNativeWindowFocus(focused: boolean): void {
  const was = effectiveFocus();
  nativeFocused = focused;
  touchFocus(was);
  emit();
}

export function setWebviewPresence(p: { focused: boolean; selectedTaskId: string | null; view: PresenceView }): void {
  const was = effectiveFocus();
  webviewFocused = p.focused;
  selectedTaskId = p.selectedTaskId;
  view = p.selectedTaskId === null ? null : p.view;
  touchFocus(was);
  emit();
}

export function setAppAttached(attached: boolean): void {
  appAttached = attached;
  if (!attached) {
    // No app: nothing is focused or selected any more.
    const was = effectiveFocus();
    nativeFocused = null;
    webviewFocused = false;
    selectedTaskId = null;
    view = null;
    touchFocus(was);
  }
  emit();
}

export function presence(): Presence {
  const focused = effectiveFocus();
  return {
    focused,
    selectedTaskId,
    view,
    lastFocusedAt: focused ? clock() : lastFocusedAt,
    appAttached,
  };
}

/** Whether the window had focus within `windowMs` (default 2 minutes), the rule for sealed pushes. A core with no app is always away. */
export function atTheMac(windowMs = 2 * 60 * 1000): boolean {
  const p = presence();
  if (!p.appAttached) return false;
  if (p.focused) return true;
  return p.lastFocusedAt !== null && clock() - p.lastFocusedAt < windowMs;
}

export function onPresenceChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const __testing = {
  reset(now: () => number = Date.now): void {
    nativeFocused = null;
    webviewFocused = false;
    selectedTaskId = null;
    view = null;
    lastFocusedAt = null;
    appAttached = false;
    clock = now;
    listeners.clear();
  },
};

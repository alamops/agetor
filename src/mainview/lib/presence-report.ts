/**
 * Reports what the window shows to the core (`PUT /app/presence`): whether it has focus, which task is open and in which view.
 * The core's notification policy reads it (src/bun/presence.ts, grill D5): it decides the OS notifications and the 2-minute
 * "at the Mac" rule for phone pushes from it, so the webview never posts or clears a Notification Center entry itself.
 *
 * Rules (docs/architecture/notifications.md): debounced to 250 ms (the trailing report wins), deduped against the last report sent,
 * fire-and-forget, and after an error nothing is sent for 5 seconds (the next report then carries the latest state). Pure of the DOM so
 * it unit-tests with fake timers; `App.tsx` feeds it from focus/blur, the selected task and the view.
 */

export interface PresenceReport {
  focused: boolean;
  selectedTaskId: string | null;
  view: "run-panel" | "pipeline" | null;
}

export const PRESENCE_DEBOUNCE_MS = 250;
export const PRESENCE_BACKOFF_MS = 5000;

export interface PresenceReporterDeps {
  send: (report: PresenceReport) => Promise<unknown>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface PresenceReporter {
  /** Record the latest state; it goes out after the debounce, unless it equals what the core already has. */
  update(report: PresenceReport): void;
  /** Send the latest state now (a window blur must not wait a quarter second to stop suppressing a notification). */
  flush(): void;
  dispose(): void;
}

const same = (a: PresenceReport | null, b: PresenceReport): boolean =>
  a !== null && a.focused === b.focused && a.selectedTaskId === b.selectedTaskId && a.view === b.view;

export function createPresenceReporter(deps: PresenceReporterDeps): PresenceReporter {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let wanted: PresenceReport | null = null;
  let lastSent: PresenceReport | null = null;
  let timer: unknown = null;
  let backoffUntil = 0;
  let disposed = false;

  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const attempt = () => {
    timer = null;
    if (disposed || wanted === null || same(lastSent, wanted)) return;
    const wait = backoffUntil - now();
    if (wait > 0) {
      // Still backing off after an error: try again once it ends, with whatever is latest then.
      timer = setTimer(attempt, wait);
      return;
    }
    const report = wanted;
    lastSent = report;
    deps.send(report).catch(() => {
      // Not delivered: forget it was sent so the next change (or the retry below) resends, and pause.
      if (same(lastSent, report)) lastSent = null;
      backoffUntil = now() + PRESENCE_BACKOFF_MS;
      if (!disposed && timer === null) timer = setTimer(attempt, PRESENCE_BACKOFF_MS);
    });
  };

  return {
    update(report) {
      if (disposed) return;
      wanted = report;
      if (same(lastSent, report)) {
        cancel();
        return;
      }
      cancel();
      timer = setTimer(attempt, PRESENCE_DEBOUNCE_MS);
    },
    flush() {
      if (disposed || wanted === null) return;
      cancel();
      attempt();
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
}

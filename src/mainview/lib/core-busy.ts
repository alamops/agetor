// "Is the core answering?" watchdog behind the app-level busy banner.
//
// WHY: every webview request goes through `j()` (api.ts) → `fetchWithRecovery`
// (net-retry.ts), whose `/health` probe only runs after a *transit*
// rejection. A request the core accepted but never answers — because the
// Bun main thread is blocked (a session restore seeding a large task, a
// VACUUM) — simply hangs, and the UI shows a skeleton forever with no hint
// why. This module watches the requests `j()` registers: once any of them
// has been pending longer than `PENDING_THRESHOLD_MS`, it probes the
// unauthenticated `GET /health` route with a short abort. A probe that gets
// no answer means the core itself is stuck (not just one slow route), so
// the banner shows; the next successful probe — or every tracked request
// settling — clears it.
//
// It is purely observational: nothing is aborted, retried or re-issued
// because of it (mutations stay `retry: false` in api.ts), and the copy the
// banner shows is neutral, because the webview's ~6-connections-per-host
// cap can occasionally delay a probe on a perfectly healthy core. Expected
// blocks (the Compact database request, which freezes the core for its
// whole duration behind its own modal) suspend it via `suspendCoreBusy()`.
//
// Plan: docs/plans/non-blocking-session-restore.md (decision E, task T5).

/** How long a tracked request must be pending before the first probe. */
export const PENDING_THRESHOLD_MS = 3000;
/** Abort for one `/health` probe. Mirrors net-retry.ts's default. */
export const PROBE_TIMEOUT_MS = 1500;
/** Interval between probes while a request stays over the threshold. */
export const REPROBE_INTERVAL_MS = 2000;

type TimerHandle = ReturnType<typeof setTimeout>;

/** The one fetch shape the probe needs — narrower than `typeof fetch`
 *  (whose Bun typing carries `preconnect`) so a test double is a plain
 *  function. */
export type CoreBusyFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface CoreBusyDeps {
  fetchImpl: CoreBusyFetch;
  /** API origin, e.g. `http://127.0.0.1:4317` — the probe hits `${base}/health`. */
  base: string;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
}

export interface CoreBusyMonitor {
  /** Registers `p` as an in-flight request for its lifetime and returns a
   *  promise settling exactly like `p` (same value, same rejection). */
  trackRequest<T>(p: Promise<T>): Promise<T>;
  /** Suspends probing (and hides the banner) until the returned disposer
   *  runs. Nested suspensions stack; the disposer is idempotent. */
  suspend(): () => void;
  subscribe(fn: () => void): () => void;
  /** True while the latest probe got no answer and nothing suspends it. */
  getBusy(): boolean;
  /** Test/HMR helper: forgets every tracked request, timer and listener. */
  reset(): void;
}

/** Builds an independent monitor. The app uses the module-level default
 *  below; tests build their own with injected fetch/clock/timers. */
export function createCoreBusyMonitor(deps: CoreBusyDeps): CoreBusyMonitor {
  const pending = new Map<number, number>(); // request id → start time
  const listeners = new Set<() => void>();
  let nextId = 1;
  let busy = false;
  let suspendCount = 0;
  let timer: TimerHandle | null = null;
  let probing = false;

  const visibleBusy = () => busy && suspendCount === 0;

  function setBusy(next: boolean): void {
    const before = visibleBusy();
    busy = next;
    if (visibleBusy() !== before) notify();
  }

  function notify(): void {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (e) {
        console.warn("[agetor] core-busy listener threw", e);
      }
    }
  }

  function clearTimer(): void {
    if (timer !== null) {
      deps.clearTimeout(timer);
      timer = null;
    }
  }

  /** Oldest still-pending request's start, or null when nothing is in flight. */
  function oldestStart(): number | null {
    let oldest: number | null = null;
    for (const start of pending.values()) {
      if (oldest === null || start < oldest) oldest = start;
    }
    return oldest;
  }

  /** Re-derives what should happen next from the current state: idle when
   *  nothing is in flight (or suspended), a timer to the moment the oldest
   *  request crosses the threshold, or a probe right now. Safe to call from
   *  any transition — it never arms two timers or two probes. */
  function schedule(): void {
    if (probing) return; // the probe's own completion re-schedules
    clearTimer();
    const oldest = oldestStart();
    if (oldest === null) {
      // Every tracked request settled, so the core demonstrably answered.
      setBusy(false);
      return;
    }
    if (suspendCount > 0) return; // resume() re-schedules
    const dueIn = oldest + PENDING_THRESHOLD_MS - deps.now();
    if (dueIn > 0) {
      timer = deps.setTimeout(() => {
        timer = null;
        schedule();
      }, dueIn);
      return;
    }
    void probe();
  }

  async function probe(): Promise<void> {
    probing = true;
    const controller = new AbortController();
    const abortTimer = deps.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let alive = false;
    try {
      const res = await deps.fetchImpl(`${deps.base}/health`, { signal: controller.signal });
      alive = res.ok;
    } catch {
      alive = false;
    } finally {
      deps.clearTimeout(abortTimer);
      probing = false;
    }
    clearTimer();
    if (pending.size === 0) {
      // Everything settled while the probe ran: the core answered.
      setBusy(false);
      return;
    }
    // A suspension that began mid-probe wins: the expected block it covers
    // must not flip the banner on.
    if (suspendCount > 0) return;
    setBusy(!alive);
    // Something is still over the threshold (or will be): keep watching at
    // the re-probe cadence so the banner both appears for a newly stuck
    // core and clears as soon as it answers again.
    timer = deps.setTimeout(() => {
      timer = null;
      schedule();
    }, REPROBE_INTERVAL_MS);
  }

  return {
    trackRequest<T>(p: Promise<T>): Promise<T> {
      const id = nextId++;
      pending.set(id, deps.now());
      if (timer === null && !probing) schedule();
      return p.finally(() => {
        pending.delete(id);
        if (pending.size === 0) schedule();
      });
    },
    suspend(): () => void {
      const before = visibleBusy();
      suspendCount++;
      clearTimer();
      if (visibleBusy() !== before) notify();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        suspendCount--;
        if (suspendCount === 0) {
          // Whatever the core was doing during the expected block is over or
          // about to be; start from a clean slate rather than re-showing a
          // stale verdict from before the suspension.
          busy = false;
          schedule();
        }
      };
    },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    getBusy: visibleBusy,
    reset(): void {
      clearTimer();
      pending.clear();
      listeners.clear();
      busy = false;
      suspendCount = 0;
      probing = false;
    },
  };
}

// --- module-level default, used by api.ts and <CoreBusyBanner> -------------

let defaultDeps: CoreBusyDeps = {
  fetchImpl: (url, init) => fetch(url, init),
  base: "",
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

const defaultMonitor = createCoreBusyMonitor({
  fetchImpl: (url, init) => defaultDeps.fetchImpl(url, init),
  get base() {
    return defaultDeps.base;
  },
  now: () => defaultDeps.now(),
  setTimeout: (fn, ms) => defaultDeps.setTimeout(fn, ms),
  clearTimeout: (handle) => defaultDeps.clearTimeout(handle),
});

/** Points the default monitor at the API origin (api.ts calls this once
 *  with its `BASE`) and optionally swaps fetch/clock/timers. Kept separate
 *  from api.ts so this module never imports it — api.ts imports us. */
export function configureCoreBusy(deps: Partial<CoreBusyDeps>): void {
  defaultDeps = { ...defaultDeps, ...deps };
}

export function trackRequest<T>(p: Promise<T>): Promise<T> {
  return defaultMonitor.trackRequest(p);
}

export function suspendCoreBusy(): () => void {
  return defaultMonitor.suspend();
}

export function subscribeCoreBusy(fn: () => void): () => void {
  return defaultMonitor.subscribe(fn);
}

export function getCoreBusy(): boolean {
  return defaultMonitor.getBusy();
}

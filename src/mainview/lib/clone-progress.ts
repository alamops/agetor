/**
 * In-memory fan-out for `clone_progress` `AppEvent`s (see `CloneProgressPhase`
 * and `AppEvent` in `src/shared/types.ts`,
 * docs/plans/clone-repository-all-providers.md Addendum A).
 *
 * WKWebView caps HTTP/1.1 connections per host at ~6, and two are already
 * spent on permanent SSE channels (`/app/events`, plus one per open task's
 * `/tasks/:id/events`) — so `CloneProjectDialog` must NOT open its own
 * `EventSource` for clone progress. Instead `App.tsx`'s single
 * `subscribeAppEvents` handler forwards every `clone_progress` event here via
 * `publishCloneProgress`, and the dialog subscribes to just the one
 * `cloneId` it minted via `subscribeCloneProgress`.
 *
 * Plain module state, no React — a `useEffect`/`useState` pair in the
 * component is enough to consume it, and it stays unit-testable with
 * `bun:test` (there is no jsdom in this repo).
 */
import type { AppEvent } from "../../shared/types.ts";

/** The one `AppEvent` variant this module cares about. */
export type CloneProgressEvent = Extract<AppEvent, { type: "clone_progress" }>;

type Listener = (e: CloneProgressEvent) => void;

/** Phases `AppEvent`'s doc comment calls terminal — once one of these is
 *  published for a `cloneId`, no further event for that id is expected. */
const TERMINAL_PHASES: ReadonlySet<CloneProgressEvent["phase"]> = new Set([
  "done",
  "failed",
  "cancelled",
]);

/** How long a terminal event's entry (its `latest` snapshot plus, in
 *  practice, an already-empty listener set — the dialog unsubscribes in its
 *  own `finally`) is kept around before being dropped, so a subscriber that
 *  attaches in the narrow window right after a terminal event still sees it
 *  via `latestCloneProgress`. Mutable only for tests (`__forTest`) — kept
 *  short in production too since nothing needs it once the dialog has
 *  reacted to the terminal phase. In practice `subscribeCloneProgress`'s own
 *  unsubscribe closure already drops a terminal (or never-published-to)
 *  entry synchronously once its last listener detaches, so this timer is a
 *  backstop for the case where a terminal event is published with no
 *  subscriber left at all (nothing to trigger the synchronous path). */
let cleanupDelayMs = 5000;

/** How long a NON-terminal entry is kept before being reclaimed outright.
 *  Every publish — terminal or not — (re-)arms one of these two timers (see
 *  `publishCloneProgress`), which is what covers a daemon that dies mid-clone
 *  without ever emitting a terminal phase: nothing else would ever schedule
 *  that entry's cleanup, since only a fresh publish resets the timer and a
 *  dead daemon publishes nothing further. Long enough to never fire during a
 *  real clone (each progress line re-arms it), short enough that a
 *  genuinely-abandoned entry doesn't live forever. Mutable only for tests. */
let staleReclaimMs = 60_000;

interface Entry {
  latest: CloneProgressEvent;
  listeners: Set<Listener>;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, Entry>();

/** Publish one `clone_progress` event to any subscriber of its `cloneId`.
 *  Called from `App.tsx`'s `subscribeAppEvents` handler — never from the
 *  dialog itself. */
export function publishCloneProgress(e: CloneProgressEvent): void {
  const existing = entries.get(e.cloneId);
  if (existing?.cleanupTimer) clearTimeout(existing.cleanupTimer);
  const entry: Entry = {
    latest: e,
    listeners: existing?.listeners ?? new Set(),
    cleanupTimer: null,
  };
  entries.set(e.cloneId, entry);
  for (const cb of entry.listeners) cb(e);
  // Every publish arms (or re-arms) a reclaim timer, terminal or not — see
  // `staleReclaimMs`'s doc comment for why a non-terminal phase needs one
  // too. A fresh publish under the same id always supersedes whatever timer
  // the previous publish armed (the `clearTimeout` above), so a clone that
  // keeps emitting progress lines never gets reclaimed mid-flight.
  const delay = TERMINAL_PHASES.has(e.phase) ? cleanupDelayMs : staleReclaimMs;
  entry.cleanupTimer = setTimeout(() => {
    // Only drop the entry if nothing re-published for this id in the
    // meantime (a fresh `cloneRepo` attempt could in principle reuse an
    // id, though callers always mint a new uuid per submit) — identity
    // check against the map's current entry, not just presence.
    if (entries.get(e.cloneId) === entry) entries.delete(e.cloneId);
  }, delay);
}

/** Subscribe to progress for one `cloneId`. Returns an unsubscribe function.
 *  Safe to call before the first event for that id has arrived — the
 *  callback just won't fire until `publishCloneProgress` does (use
 *  `latestCloneProgress` for the current snapshot at subscribe time). */
export function subscribeCloneProgress(cloneId: string, cb: Listener): () => void {
  let entry = entries.get(cloneId);
  if (!entry) {
    // No event yet — hold a listener-only placeholder so an event arriving
    // moments later (a real race: the dialog subscribes right before
    // awaiting `api.cloneProject`, but the network round-trip means the
    // first progress event could theoretically already be in flight) still
    // reaches it. `latest` is set on the first `publishCloneProgress` call,
    // which always replaces this placeholder wholesale.
    entry = { latest: undefined as unknown as CloneProgressEvent, listeners: new Set(), cleanupTimer: null };
    entries.set(cloneId, entry);
  }
  entry.listeners.add(cb);
  return () => {
    const current = entries.get(cloneId);
    if (!current) return;
    current.listeners.delete(cb);
    // Drop the entry the moment its last listener detaches with nothing
    // left worth keeping around: either a placeholder that never saw an
    // event (a submit that 400s before `cloneRepo` even runs — a bad dest,
    // launch validation, an unresolvable URL — produces zero
    // `clone_progress` events, so nothing would otherwise ever clean this
    // up) or an entry whose latest event is already terminal (the dialog
    // has reacted; no one will ever subscribe to this id again). A
    // non-terminal `latest` is left alone here — the reclaim timer armed by
    // `publishCloneProgress` is what eventually cleans that one up, since
    // the dialog can close (and unsubscribe) before the clone itself
    // resolves, e.g. after a Cancel.
    if (current.listeners.size === 0 && (!current.latest || TERMINAL_PHASES.has(current.latest.phase))) {
      if (current.cleanupTimer) clearTimeout(current.cleanupTimer);
      entries.delete(cloneId);
    }
  };
}

/** The most recent event published for `cloneId`, or `null` if none has
 *  arrived (or its entry was already cleaned up). Lets a subscriber attached
 *  after the fact — e.g. a re-render — catch up synchronously instead of
 *  waiting for the next event. */
export function latestCloneProgress(cloneId: string): CloneProgressEvent | null {
  return entries.get(cloneId)?.latest ?? null;
}

/** Test-only seam: production code must never call this. Lets tests shrink
 *  the terminal-cleanup / stale-reclaim delays instead of sleeping the real
 *  5s/60s, inspect the map's size to prove entries aren't leaking, and reset
 *  the module's state between runs (the map is module-level and `bun test`
 *  runs every file in one process). */
export const __forTest = {
  setCleanupDelayMs(ms: number): void {
    cleanupDelayMs = ms;
  },
  setStaleReclaimMs(ms: number): void {
    staleReclaimMs = ms;
  },
  /** Total number of tracked `cloneId` entries right now, terminal or not,
   *  subscribed or not — the leak-detection seam. */
  entryCount(): number {
    return entries.size;
  },
  reset(): void {
    for (const entry of entries.values()) {
      if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    }
    entries.clear();
    cleanupDelayMs = 5000;
    staleReclaimMs = 60_000;
  },
};

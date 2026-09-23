import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  __forTest,
  latestCloneProgress,
  publishCloneProgress,
  subscribeCloneProgress,
  type CloneProgressEvent,
} from "./clone-progress.ts";

// Plain module-state tests — no React/jsdom (house convention). The module
// is a singleton map shared across every test in this file (and, since
// `bun test` runs the whole process in one go, across every OTHER test file
// that happens to import it — hence `__forTest.reset()` in `beforeEach`).

function ev(overrides: Partial<CloneProgressEvent> = {}): CloneProgressEvent {
  return {
    type: "clone_progress",
    cloneId: "clone-1",
    phase: "receiving",
    percent: 42,
    line: "Receiving objects: 42% (420/1000)",
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  __forTest.reset();
});

afterEach(() => {
  __forTest.reset();
});

test("subscribeCloneProgress delivers events published for its own cloneId", () => {
  const received: CloneProgressEvent[] = [];
  const unsubscribe = subscribeCloneProgress("clone-1", (e) => received.push(e));
  publishCloneProgress(ev());
  unsubscribe();
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ cloneId: "clone-1", phase: "receiving", percent: 42 });
});

test("a subscriber never sees events published for a different cloneId", () => {
  const received: CloneProgressEvent[] = [];
  const unsubscribe = subscribeCloneProgress("clone-1", (e) => received.push(e));
  publishCloneProgress(ev({ cloneId: "clone-2" }));
  unsubscribe();
  expect(received).toHaveLength(0);
});

test("unsubscribe stops further delivery to that callback only", () => {
  const a: CloneProgressEvent[] = [];
  const b: CloneProgressEvent[] = [];
  const unsubA = subscribeCloneProgress("clone-1", (e) => a.push(e));
  const unsubB = subscribeCloneProgress("clone-1", (e) => b.push(e));
  publishCloneProgress(ev({ phase: "counting", percent: null }));
  unsubA();
  publishCloneProgress(ev({ phase: "receiving", percent: 10 }));
  unsubB();
  expect(a).toHaveLength(1);
  expect(b).toHaveLength(2);
});

test("calling the unsubscribe function twice is a no-op the second time", () => {
  const received: CloneProgressEvent[] = [];
  const unsubscribe = subscribeCloneProgress("clone-1", (e) => received.push(e));
  unsubscribe();
  unsubscribe();
  publishCloneProgress(ev());
  expect(received).toHaveLength(0);
});

test("latestCloneProgress returns null before any event for that id has been published", () => {
  expect(latestCloneProgress("clone-never-seen")).toBeNull();
});

test("latestCloneProgress reflects the most recently published event", () => {
  publishCloneProgress(ev({ phase: "counting", percent: null }));
  publishCloneProgress(ev({ phase: "receiving", percent: 55 }));
  expect(latestCloneProgress("clone-1")).toMatchObject({ phase: "receiving", percent: 55 });
});

test("a subscriber attached after events already fired can still catch up via latestCloneProgress", () => {
  publishCloneProgress(ev({ phase: "starting", percent: null }));
  publishCloneProgress(ev({ phase: "resolving", percent: 80 }));
  // The late subscriber's callback fires only for FUTURE events — this is
  // what `latestCloneProgress` (checked separately, above) is for; here we
  // just confirm attaching late doesn't throw and doesn't retroactively
  // replay past events onto the new callback.
  const received: CloneProgressEvent[] = [];
  const unsubscribe = subscribeCloneProgress("clone-1", (e) => received.push(e));
  expect(received).toHaveLength(0);
  expect(latestCloneProgress("clone-1")).toMatchObject({ phase: "resolving", percent: 80 });
  publishCloneProgress(ev({ phase: "checking-out", percent: 99 }));
  unsubscribe();
  expect(received).toHaveLength(1);
});

test("a terminal phase (done) is dropped from latestCloneProgress after the cleanup delay", async () => {
  __forTest.setCleanupDelayMs(20);
  publishCloneProgress(ev({ phase: "done", percent: 100 }));
  expect(latestCloneProgress("clone-1")).not.toBeNull();
  await new Promise((r) => setTimeout(r, 60));
  expect(latestCloneProgress("clone-1")).toBeNull();
});

test("a terminal phase (failed) is also cleaned up", async () => {
  __forTest.setCleanupDelayMs(20);
  publishCloneProgress(ev({ phase: "failed", percent: null, line: "authentication failed" }));
  await new Promise((r) => setTimeout(r, 60));
  expect(latestCloneProgress("clone-1")).toBeNull();
});

test("a terminal phase (cancelled) is also cleaned up", async () => {
  __forTest.setCleanupDelayMs(20);
  publishCloneProgress(ev({ phase: "cancelled", percent: null }));
  await new Promise((r) => setTimeout(r, 60));
  expect(latestCloneProgress("clone-1")).toBeNull();
});

test("a non-terminal phase is unaffected by the short cleanupDelayMs (it uses the separate, longer staleReclaimMs timer instead)", async () => {
  __forTest.setCleanupDelayMs(20);
  publishCloneProgress(ev({ phase: "receiving", percent: 50 }));
  await new Promise((r) => setTimeout(r, 60));
  expect(latestCloneProgress("clone-1")).not.toBeNull();
});

test("a fresh publish after a terminal phase cancels the pending cleanup", async () => {
  __forTest.setCleanupDelayMs(20);
  publishCloneProgress(ev({ phase: "done", percent: 100 }));
  // Re-published under the same id before the cleanup timer would have
  // fired (a fresh clone attempt reusing the id is not something real
  // callers do — they mint a new uuid per submit — but the module must not
  // let a stale timer reach in and delete a just-refreshed entry).
  publishCloneProgress(ev({ phase: "receiving", percent: 5 }));
  await new Promise((r) => setTimeout(r, 60));
  expect(latestCloneProgress("clone-1")).toMatchObject({ phase: "receiving", percent: 5 });
});

test("__forTest.reset clears all entries and restores the default cleanup delay", async () => {
  __forTest.setCleanupDelayMs(20_000);
  publishCloneProgress(ev({ phase: "receiving", percent: 5 }));
  expect(latestCloneProgress("clone-1")).not.toBeNull();
  __forTest.reset();
  expect(latestCloneProgress("clone-1")).toBeNull();
  // A terminal event published after reset uses the restored (long) default
  // delay, not the short one set above — proven by it still being present
  // after a short wait.
  publishCloneProgress(ev({ phase: "done", percent: 100 }));
  await new Promise((r) => setTimeout(r, 30));
  expect(latestCloneProgress("clone-1")).not.toBeNull();
});

// --- Leak-cleanup coverage (review H3) ---------------------------------
//
// Two cases the module used to leak an entry forever: (a) a placeholder
// that never saw a single `clone_progress` event (the request that would
// have produced them 400s before `cloneRepo` even runs), and (b) a
// non-terminal `latest` whose daemon died mid-clone, so no further publish
// ever arrives to schedule a cleanup. `__forTest.entryCount()` is the
// leak-detection seam: it reports the map's raw size regardless of whether
// anything is still subscribed.

test("a placeholder entry with zero events is dropped as soon as its only subscriber unsubscribes", () => {
  const unsubscribe = subscribeCloneProgress("clone-1", () => {});
  expect(__forTest.entryCount()).toBe(1);
  unsubscribe();
  expect(__forTest.entryCount()).toBe(0);
  expect(latestCloneProgress("clone-1")).toBeNull();
});

test("an entry whose latest event is terminal is dropped synchronously (not just after the cleanup timer) once its last subscriber unsubscribes", () => {
  // Default (long) cleanupDelayMs on purpose — proves the drop happens on
  // unsubscribe itself, not by coincidentally outracing the timer.
  const unsubscribe = subscribeCloneProgress("clone-1", () => {});
  publishCloneProgress(ev({ phase: "done", percent: 100 }));
  expect(__forTest.entryCount()).toBe(1);
  unsubscribe();
  expect(__forTest.entryCount()).toBe(0);
});

test("an entry whose latest event is non-terminal survives its last subscriber unsubscribing (reclaimed later by the stale timer instead)", async () => {
  __forTest.setStaleReclaimMs(20);
  const unsubscribe = subscribeCloneProgress("clone-1", () => {});
  publishCloneProgress(ev({ phase: "receiving", percent: 50 }));
  unsubscribe();
  // Not dropped immediately — a daemon that's still running (or a dialog
  // the user merely closed early) shouldn't lose its live snapshot the
  // instant the one subscriber detaches.
  expect(__forTest.entryCount()).toBe(1);
  await new Promise((r) => setTimeout(r, 60));
  // But it doesn't live forever either — the stale-reclaim timer armed by
  // the `publishCloneProgress` call above eventually sweeps it.
  expect(__forTest.entryCount()).toBe(0);
});

test("a non-terminal entry with no subscriber at all is still reclaimed by the stale timer (e.g. the daemon died mid-clone)", async () => {
  __forTest.setStaleReclaimMs(20);
  publishCloneProgress(ev({ phase: "receiving", percent: 10 }));
  expect(__forTest.entryCount()).toBe(1);
  await new Promise((r) => setTimeout(r, 60));
  expect(__forTest.entryCount()).toBe(0);
  expect(latestCloneProgress("clone-1")).toBeNull();
});

test("a fresh non-terminal publish re-arms the stale-reclaim timer, same as a terminal publish re-arms the cleanup timer", async () => {
  __forTest.setStaleReclaimMs(40);
  publishCloneProgress(ev({ phase: "counting", percent: null }));
  // Re-published before the first timer would have fired — must not be
  // reclaimed at the original deadline.
  await new Promise((r) => setTimeout(r, 20));
  publishCloneProgress(ev({ phase: "receiving", percent: 5 }));
  await new Promise((r) => setTimeout(r, 30));
  expect(__forTest.entryCount()).toBe(1);
  // But the re-armed timer still fires eventually.
  await new Promise((r) => setTimeout(r, 30));
  expect(__forTest.entryCount()).toBe(0);
});

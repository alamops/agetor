// The history pager's state machine (review S10): a Refresh clicked while
// "Load more" is in flight supersedes that request, so the dropped answer can
// no longer clear `loadingMore` and the refresh must.
import { describe, expect, test } from "bun:test";
import { INITIAL_HISTORY_STATE, historyReducer, type HistoryAction, type HistoryState } from "./StackHistory.tsx";
import type { HarnessSwapEvent } from "../../../shared/types.ts";

function event(id: string): HarnessSwapEvent {
  return {
    id, stackId: "s", taskId: null, taskTitle: null, fromHarnessId: "a", fromLabel: "A", toHarnessId: "b", toLabel: "B",
    trigger: "manual", reason: "user", source: null, message: null, model: null, resetsAtMs: null,
    fromRunId: null, toRunId: null, continuation: null, at: 1,
  } as HarnessSwapEvent;
}

function run(actions: HistoryAction[], from: HistoryState = INITIAL_HISTORY_STATE): HistoryState {
  return actions.reduce(historyReducer, from);
}

describe("historyReducer", () => {
  test("Refresh during Load more: the button leaves Loading…, the stale page is dropped", () => {
    let s = run([
      { type: "load", generation: 1 },
      { type: "page", generation: 1, page: { events: [event("e1")], nextCursor: "c1" }, append: false },
      { type: "more", generation: 1 },
    ]);
    expect(s.loadingMore).toBe(true);
    s = run([{ type: "load", generation: 2 }], s);
    expect(s.loadingMore).toBe(false);
    expect(s.loading).toBe(true);
    // The superseded "more" answer (and its failure) land late and change nothing.
    const stale = run([
      { type: "page", generation: 1, page: { events: [event("old")], nextCursor: null }, append: true },
      { type: "failed", generation: 1, action: "more", message: "late" },
    ], s);
    expect(stale).toBe(s);
    s = run([{ type: "page", generation: 2, page: { events: [event("e1"), event("e0")], nextCursor: "c2" }, append: false }], s);
    expect(s).toMatchObject({ loading: false, loadingMore: false, error: null, cursor: "c2" });
    expect(s.events.map((e) => e.id)).toEqual(["e1", "e0"]);
  });

  test("Load more appends and moves the cursor; a failed page keeps the list and remembers what to retry", () => {
    let s = run([
      { type: "load", generation: 1 },
      { type: "page", generation: 1, page: { events: [event("e1")], nextCursor: "c1" }, append: false },
      { type: "more", generation: 1 },
      { type: "page", generation: 1, page: { events: [event("e2")], nextCursor: null }, append: true },
    ]);
    expect(s.events.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(s).toMatchObject({ cursor: null, loadingMore: false, loading: false });

    s = run([
      { type: "load", generation: 2 },
      { type: "page", generation: 2, page: { events: [event("e1")], nextCursor: "c1" }, append: false },
      { type: "more", generation: 2 },
      { type: "failed", generation: 2, action: "more", message: "boom" },
    ]);
    expect(s).toMatchObject({ error: "boom", failedAction: "more", loadingMore: false, loading: false });
    expect(s.events.map((e) => e.id)).toEqual(["e1"]);
  });

  test("a failed first load stops the spinner and retries as a load", () => {
    const s = run([
      { type: "load", generation: 1 },
      { type: "failed", generation: 1, action: "load", message: "down" },
    ]);
    expect(s).toMatchObject({ error: "down", failedAction: "load", loading: false, loadingMore: false });
  });
});

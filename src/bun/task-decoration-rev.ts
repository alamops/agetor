import { markTasksChanged } from "./task-change-bus.ts";

// Revision counter for the IN-MEMORY task decorations (open terminals, pending
// interaction cards, the stall mark). The database's `task_revs` log cannot see
// them (docs/plans/non-blocking-core.md §3), so the three registries call
// `noteDecorationChanged` and the delta route folds this counter into its cursor
// (`task-delta-route.ts`): a client polling with `since` then hears about a
// decoration change that did not touch a row.
//
// Why a main-thread counter instead of touching `task_revs`: the decorations are
// main-thread state that dies with the process, so a counter that also dies with
// it is exactly right, and the per-process `BOOT_ID` (folded into the cursor's
// epoch) turns every restart into a snapshot, where a client rebuilds from
// scratch. Touching `task_revs` would cost a worker round trip and a write per
// terminal open or card, and would persist a fact that is not persistent.
//
// This module imports nothing but the change bus, so the registries it is called
// from stay gate-testable.

/** Identifies this process: the decoration counter restarts at 0 with it. */
export const BOOT_ID = Math.random().toString(16).slice(2, 10).padEnd(8, "0");

/** Most distinct tasks remembered. Past it the oldest entries are dropped and
 *  `decorationChangedSince` reports "too old" for a cursor that predates them. */
export const MAX_TRACKED = 2000;

let rev = 0;
/** Highest rev of any entry dropped by pruning (a cursor below it must snapshot). */
let prunedFloor = 0;
/** task id -> the rev of its latest decoration change; insertion order = rev order. */
const changedAt = new Map<string, number>();

/** The current decoration revision (0 until the first change in this process). */
export function currentDecorationRev(): number {
  return rev;
}

/** A task's decoration changed. `parentId` is the pipeline parent whose folded
 *  pending count moves with a step's. Never throws; announces on the change bus. */
export function noteDecorationChanged(taskId: string, parentId?: string | null): void {
  rev += 1;
  for (const id of parentId ? [taskId, parentId] : [taskId]) {
    changedAt.delete(id);
    changedAt.set(id, rev);
  }
  while (changedAt.size > MAX_TRACKED) {
    const oldest = changedAt.entries().next().value as [string, number];
    changedAt.delete(oldest[0]);
    prunedFloor = Math.max(prunedFloor, oldest[1]);
  }
  markTasksChanged("decoration");
}

/** Ids whose decoration changed after `since`, or `null` when the history no
 *  longer reaches back that far (the caller answers a snapshot). */
export function decorationChangedSince(since: number): string[] | null {
  if (since < prunedFloor) return null;
  const out: string[] = [];
  for (const [id, at] of changedAt) if (at > since) out.push(id);
  return out;
}

/** Test-only: forget every change (the counter is kept so cursors stay monotonic). */
export function __resetDecorationRevForTests(): void {
  changedAt.clear();
  prunedFloor = 0;
}

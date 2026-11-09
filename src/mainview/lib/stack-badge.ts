import { stackPositionText } from "../../shared/harness-stack.ts";
import type { HarnessStack, Task, TaskHarnessState } from "../../shared/types.ts";

/**
 * The state the task-card's stack chip renders.
 *
 * A task that has never failed over has no `harnessState`, so its `n/m` is
 * derived from the CURRENT stack membership of its account (an account edited
 * into another stack shows the train it is really in). The task's own
 * persisted failover state supplies the LIVE fields; its position/count are
 * re-derived whenever the current membership disagrees, because a deleted
 * member renumbers the train and the stored rank is only a snapshot (review
 * R13-M1).
 *
 * When the membership moved to a different stack, the position/count come from
 * the new train but the task's LIVE failover fields (`pendingSwap`,
 * `allExhausted`, `lastMove`) are kept: they describe what the task is doing
 * right now, and RunPanel renders them straight from `task.harnessState`. Zeroing
 * them here made the card claim "nothing happening" while the panel showed a
 * swap or a quota countdown (R11-S1). An account removed from every stack keeps
 * its recorded state until the next move.
 */
export function stackBadgeStateFor(
  task: Pick<Task, "agent" | "harnessState">,
  stacks: readonly HarnessStack[],
): TaskHarnessState | null {
  const state = task.harnessState;
  for (const stack of stacks) {
    const index = stack.members.findIndex((m) => m.harnessId === task.agent);
    if (index < 0) continue;
    const count = stack.members.length;
    if (state && state.stackId === stack.id) {
      // The same train, but a deleted member renumbers it: the stored rank is
      // a snapshot, so never render a position the current membership no
      // longer has (review R13-M1). Live failover fields are untouched.
      if (state.position === index && state.count === count) return state;
      return { ...state, position: index, count };
    }
    return {
      ...state,
      stackId: stack.id,
      position: index,
      count,
      tried: state?.tried ?? [],
      pendingSwap: state?.pendingSwap ?? null,
      allExhausted: state?.allExhausted ?? null,
      lastMove: state?.lastMove ?? null,
    };
  }
  return state ?? null;
}

/** An account's place in its stack, for the small `n/m` chips. */
export interface StackPosition {
  stack: HarnessStack;
  /** 1-based (`1` is the primary). */
  position: number;
  count: number;
  /** The chip text, `"n/m"`, exactly as the CLI prints it. */
  text: string;
}

/**
 * Where `harnessId` sits in its stack, or null when it is in no stack **or its
 * stack has fewer than two accounts**. A one-account stack cannot fail over,
 * so every surface (New Task chip, launch pickers, the RunPanel account line,
 * Settings → Harnesses) hides the `1/1` chip and its "fails over…" copy
 * rather than promise a failover that cannot happen.
 *
 * The "fewer than two members → no chip" rule lives only in the shared
 * `stackPositionText` (src/shared/harness-stack.ts), which the CLI uses too;
 * this helper is the webview's single entry point to it (review N9).
 */
export function stackPositionFor(
  stacks: readonly HarnessStack[],
  harnessId: string,
): StackPosition | null {
  for (const stack of stacks) {
    const index = stack.members.findIndex((m) => m.harnessId === harnessId);
    if (index < 0) continue;
    const text = stackPositionText(stack, harnessId);
    if (text === null) return null;
    return { stack, position: index + 1, count: stack.members.length, text };
  }
  return null;
}

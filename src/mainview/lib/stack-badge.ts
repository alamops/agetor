import { stackPositionText } from "../../shared/harness-stack.ts";
import {
  DEFAULT_MODEL,
  type AgentStatus,
  type Harness,
  type HarnessLimitState,
  type HarnessStack,
  type Task,
  type TaskHarnessState,
} from "../../shared/types.ts";

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
      ...(state?.scheduledSwitch ? { scheduledSwitch: state.scheduledSwitch } : {}),
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

/**
 * The model a task will actually run, lower-cased the way the core stores a
 * per-model cooldown (`task.model ?? DEFAULT_MODEL[kind]`, review S2). The
 * kind comes from the task's stack (every member shares it); a task outside
 * every stack has no per-model rows that matter, so a null model stays null.
 */
export function resolvedTaskModel(
  task: Pick<Task, "agent" | "model">,
  stacks: readonly HarnessStack[],
): string | null {
  if (task.model) return task.model.toLowerCase();
  const stack = stacks.find((st) => st.members.some((m) => m.harnessId === task.agent));
  return stack ? DEFAULT_MODEL[stack.kind].toLowerCase() : null;
}

/**
 * The cooldown that applies to `harnessId` for a task on `resolvedModel` right
 * now: an account-wide row, or a per-model row for that exact model (a row for
 * another model does not stop this task). The latest end wins. A row whose
 * instant has passed is not cooling. Several rows per account exist since
 * migration 087.
 */
export function activeCooldown(
  limitStates: readonly HarnessLimitState[],
  harnessId: string,
  resolvedModel: string | null,
  now: number,
): HarnessLimitState | null {
  let best: HarnessLimitState | null = null;
  for (const row of limitStates) {
    if (row.harnessId !== harnessId || row.exhaustedUntilMs <= now) continue;
    const rowModel = row.model ? row.model.toLowerCase() : null;
    if (rowModel !== null && rowModel !== resolvedModel) continue;
    if (!best || row.exhaustedUntilMs > best.exhaustedUntilMs) best = row;
  }
  return best;
}

/** `HH:MM` for a reset today, with the date added when it is another day. */
export function formatResetClock(ms: number, now: number): string {
  const at = new Date(ms);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === new Date(now).toDateString()
    ? time
    : `${at.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export interface StackPickerOption {
  id: string;
  label: string;
}

/**
 * The RunPanel account picker's rows for a stacked task (D18): only the
 * stack's members, in stack order, each `<label> n/m`, with a cooling mark
 * (model-aware) and the unavailable / not-logged-in suffixes. Null when the
 * task's account is in no stack or in a one-account stack (the caller then
 * keeps the full account list).
 */
export function stackPickerOptions(args: {
  task: Pick<Task, "agent" | "model">;
  stacks: readonly HarnessStack[];
  harnesses: readonly Harness[];
  agents: readonly AgentStatus[];
  limitStates: readonly HarnessLimitState[];
  now: number;
}): StackPickerOption[] | null {
  const { task, stacks, harnesses, agents, limitStates, now } = args;
  const stack = stacks.find((st) => st.members.some((m) => m.harnessId === task.agent));
  if (!stack || stack.members.length < 2) return null;
  const model = resolvedTaskModel(task, stacks);
  return stack.members.map((member, index) => {
    const label = harnesses.find((h) => h.id === member.harnessId)?.label ?? member.label;
    const status = agents.find((a) => a.harnessId === member.harnessId);
    const available = status?.available ?? true;
    const loggedOut = available && status?.loggedIn === false;
    const cooling = activeCooldown(limitStates, member.harnessId, model, now);
    const coolText = cooling ? ` ⏳ cooling until ${formatResetClock(cooling.exhaustedUntilMs, now)}` : "";
    const suffix = !available ? " (unavailable)" : loggedOut ? " (not logged in)" : "";
    return { id: member.harnessId, label: `${label} ${index + 1}/${stack.members.length}${coolText}${suffix}` };
  });
}

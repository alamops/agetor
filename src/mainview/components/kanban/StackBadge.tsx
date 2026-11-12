import { cn } from "@/lib/utils";
import { stackPositionFor } from "@/lib/stack-badge";
import type { HarnessStack } from "../../../shared/types.ts";

/**
 * The display slice of `TaskHarnessState` this chip needs. Kept structural so
 * a card can pass a state derived from the account's stack membership before
 * the task has ever run (T15: "badge from `harnessState` or the account's
 * stack").
 */
export interface StackBadgeState {
  position: number;
  count?: number;
  pendingSwap?: { to: string } | null;
  /** "Switch to next account" requested during a live turn. */
  scheduledSwitch?: { requestedAt: number } | null;
  allExhausted?: {
    nextAttemptAt: number;
    reason: string;
    attempts: number;
    max: number;
    inFlight?: boolean;
  } | null;
}

/**
 * A small chip naming a task's position in its harness account stack
 * (`2/3`). Position 1 is the primary. An all-exhausted state and a cooling
 * current account use the `--warning` token (the latter adds an hourglass
 * marker); a pending swap and a live retry keep `--info`. `title` explains
 * the state in one sentence.
 *
 * A stack with fewer than two accounts cannot fail over, so the chip never
 * shows `1/1` or the "fails over…" copy for it: it renders nothing unless
 * something live (a swap, a retry, an exhausted wait, a cooling account) is
 * worth showing, and then names that state instead of a position.
 */
export function StackBadge({
  state,
  /** Account-global cooldown for the CURRENT account (`HarnessLimitState`).
   *  The card used to hide a cooling account until the task itself blocked;
   *  the badge now marks it (review nit). A past instant reads as not cooling. */
  coolingUntilMs,
  /** The model a per-model cooldown is for (null/absent: the whole account).
   *  Named in the title so "cooling" never reads as the account being out. */
  coolingModel,
  /** The task is running right now (`task.column === "running"`). With an
   *  `allExhausted` marker that is the retry run itself, not a wait. */
  running,
  className,
}: {
  state: StackBadgeState | null | undefined;
  coolingUntilMs?: number | null;
  coolingModel?: string | null;
  running?: boolean;
  className?: string;
}) {
  if (!state) return null;
  const position = state.position + 1;
  const count = state.count ?? position;
  const single = count < 2;
  const pending = state.pendingSwap != null;
  const scheduled = state.scheduledSwitch != null && !pending;
  const ex = state.allExhausted;
  // The retry run is live: the marker keeps its attempt count (and
  // `inFlight`) for the successor's whole life, so a running task with the
  // marker is "running after a quota reset", never "retrying…" (review S20).
  const liveRetry = ex != null && (ex.inFlight === true || running === true);
  // A started retry keeps `allExhausted` for its attempt count but clears the
  // timer; that is cyan "in flight", not amber "out of quota".
  const retrying = liveRetry
    || (ex != null && ex.nextAttemptAt <= 0 && ex.reason !== "no-usable-member" && ex.attempts < ex.max);
  // "No usable member" is a manual fix (disabled/logged-out/missing CLI), not
  // a quota wait — the amber tooltip must not claim the stack is out of quota.
  const noUsable = ex != null && !retrying && ex.reason === "no-usable-member";
  const exhausted = ex != null && !retrying;
  const cooling = coolingUntilMs != null && coolingUntilMs > Date.now();
  if (single && !pending && !scheduled && ex == null && !cooling) return null;
  const attempt = ex ? `attempt ${Math.min(ex.attempts + 1, ex.max)}/${ex.max}` : "";
  const forModel = coolingModel ? ` for ${coolingModel}` : "";
  const coolingDetail = cooling
    ? single
      ? `Its account is cooling${forModel} until ${new Date(coolingUntilMs).toLocaleString()}`
      : `Account ${position} of ${count} — its current account is cooling${forModel} until ${new Date(coolingUntilMs).toLocaleString()}`
    : null;
  const title = liveRetry
    ? ex!.reason === "no-usable-member"
      ? `Running (${attempt})`
      : `Running after a quota reset (${attempt})`
    : retrying
      ? "Retrying on the next available account…"
      : noUsable
        ? "No account in this stack can run this task — fix one in Settings → Harnesses"
        : exhausted
          ? "Every account in this stack is out of quota"
          : pending
            ? "Switching to the next account…"
            : scheduled
              ? "Switch to the next account scheduled for the end of this turn"
              : coolingDetail ?? `Account ${position} of ${count} — fails over to the next account at its limit`;
  // A one-account stack has no meaningful position: name the state instead.
  const label = !single
    ? `${position}/${count}`
    : liveRetry
      ? "running"
      : retrying
        ? "retrying"
        : noUsable
          ? "no account"
          : exhausted
            ? "out of quota"
            : pending
              ? "switching"
              : scheduled
                ? "switch scheduled"
                : "cooling";
  return (
    <span
      data-testid="task-card-stack-badge"
      role="img"
      aria-label={`${label}: ${title}`}
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium",
        exhausted || cooling
          ? "border-warning/40 text-warning"
          : "border-info/40 text-info",
        className,
      )}
    >
      {pending || retrying || scheduled ? "⇄ " : ""}
      {cooling ? "⏳ " : ""}
      {label}
    </span>
  );
}

/**
 * The plain `n/m` position chip next to an account name (New Task harness
 * grid, the launch pickers). Nothing for an account in no stack or in a
 * one-account stack ({@link stackPositionFor}).
 */
export function StackPositionChip({
  stacks,
  harnessId,
  className,
}: {
  stacks: readonly HarnessStack[];
  harnessId: string;
  className?: string;
}) {
  const at = stackPositionFor(stacks, harnessId);
  if (!at) return null;
  return (
    <span
      data-testid="stack-position-chip"
      title={`Account ${at.position} of ${at.count} in stack "${at.stack.label}" — fails over to the next account at its limit`}
      className={cn("ml-1 text-[10px] text-info", className)}
    >
      {at.position}/{at.count}
    </span>
  );
}

import { cn } from "@/lib/utils";

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
  allExhausted?: {
    nextAttemptAt: number;
    reason: string;
    attempts: number;
    max: number;
  } | null;
}

/**
 * A small chip naming a task's position in its harness account stack
 * (`2/3`). Position 1 is the primary. An all-exhausted state and a cooling
 * current account use the `--warning` token (the latter adds an hourglass
 * marker); a pending swap keeps `--info`. `title` explains the failover in
 * one sentence.
 */
export function StackBadge({
  state,
  /** Account-global cooldown for the CURRENT account (`HarnessLimitState`).
   *  The card used to hide a cooling account until the task itself blocked;
   *  the badge now marks it (review nit). A past instant reads as not cooling. */
  coolingUntilMs,
  className,
}: {
  state: StackBadgeState | null | undefined;
  coolingUntilMs?: number | null;
  className?: string;
}) {
  if (!state) return null;
  const position = state.position + 1;
  const count = state.count ?? position;
  const pending = state.pendingSwap != null;
  const ex = state.allExhausted;
  // A started retry keeps `allExhausted` for its attempt count but clears the
  // timer; that is cyan "in flight", not amber "out of quota".
  const retrying = ex != null && ex.nextAttemptAt <= 0 && ex.reason !== "no-usable-member" && ex.attempts < ex.max;
  // "No usable member" is a manual fix (disabled/logged-out/missing CLI), not
  // a quota wait — the amber tooltip must not claim the stack is out of quota.
  const noUsable = ex != null && !retrying && ex.reason === "no-usable-member";
  const exhausted = ex != null && !retrying;
  const cooling = coolingUntilMs != null && coolingUntilMs > Date.now();
  const coolingDetail = cooling
    ? `Account ${position} of ${count} — its current account is cooling until ${new Date(coolingUntilMs).toLocaleString()}`
    : null;
  const title = retrying
    ? "Retrying on the next available account…"
    : noUsable
      ? "No account in this stack can run this task — fix one in Settings"
      : exhausted
        ? "Every account in this stack is out of quota"
        : pending
          ? "Switching to the next account…"
          : coolingDetail ?? `Account ${position} of ${count} — fails over to the next account at its limit`;
  return (
    <span
      data-testid="task-card-stack-badge"
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium",
        exhausted || cooling
          ? "border-warning/40 text-warning"
          : "border-info/40 text-info",
        className,
      )}
    >
      {pending || retrying ? "⇄ " : ""}
      {cooling ? "⏳ " : ""}
      {position}/{count}
    </span>
  );
}

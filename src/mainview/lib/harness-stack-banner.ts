/**
 * What the RunPanel header's harness-stack line says, as a pure function of
 * the task (no React, no clock of its own) so every branch is unit-testable.
 * The precedence comes from `harnessStackBannerMode` (pending swap →
 * all-exhausted → recent move). Model: docs/architecture/harness-stacks.md.
 */
import { harnessMoveNote, harnessStackBannerMode } from "../../shared/harness-stack.ts";
import type { Task } from "../../shared/types.ts";

export type HarnessStackBannerView =
  | { kind: "pending"; text: string }
  | { kind: "moved"; text: string }
  /** The retry run is live (`inFlight`, or the task is running): no Run now —
   *  a manual run would only bounce off "task already running". */
  | { kind: "retry-running"; text: string }
  | { kind: "exhausted"; text: string; runNow: true };

export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function harnessStackBannerView(
  task: Pick<Task, "agent" | "column" | "harnessState">,
  /** Account id → its user-facing label (falls back to the id). */
  labelOf: (harnessId: string) => string,
  now: number,
): HarnessStackBannerView | null {
  const state = task.harnessState;
  const mode = harnessStackBannerMode(state, now);
  if (mode === "pending" && state?.pendingSwap) {
    return { kind: "pending", text: `Switching to ${labelOf(state.pendingSwap.to)}…` };
  }
  if (mode === "moved" && state?.lastMove) {
    return { kind: "moved", text: harnessMoveNote(state.lastMove, labelOf(state.lastMove.to)) };
  }
  const ex = mode === "exhausted" ? state?.allExhausted : null;
  if (!ex) return null;
  // The marker keeps its attempt count — and `inFlight` — for the retry
  // successor's whole life, so "retrying…" plus Run now painted for the
  // entire retry run and Run now answered "task already running" (review
  // S20). A running task with the marker IS the retry run.
  if (ex.inFlight === true || task.column === "running") {
    const attempt = `attempt ${Math.min(ex.attempts + 1, ex.max)}/${ex.max}`;
    const account = labelOf(task.agent);
    return {
      kind: "retry-running",
      text: ex.reason === "no-usable-member"
        ? `Running on ${account} (${attempt}).`
        : `Running on ${account} after a quota reset (${attempt}).`,
    };
  }
  const targetAt = ex.nextAttemptAt;
  const secondsLeft = targetAt > 0 ? Math.max(0, Math.ceil((targetAt - now) / 1000)) : 0;
  // A retry that already fired keeps the persisted attempt count but has no
  // next timer (nextAttemptAt 0) until the run row exists. That is "in
  // progress", not "nothing usable".
  const retrying = targetAt <= 0 && ex.reason !== "no-usable-member" && ex.attempts < ex.max;
  const text = ex.attempts >= ex.max
    ? "Every account in this stack is out of quota — run the task manually after a reset."
    : targetAt > 0
      ? `Every account in this stack is out of quota — retrying in ${formatCountdown(secondsLeft)} (attempt ${ex.attempts + 1}/${ex.max}).`
      : retrying
        ? `Retrying on the next available account (attempt ${ex.attempts + 1}/${ex.max})…`
        : "No account in this stack can run this task — fix one in Settings → Stacks.";
  return { kind: "exhausted", text, runNow: true };
}

/**
 * The board card's "waiting on you" look and wording, shared by every
 * surface that has to read the same as the card: the kanban `TaskCard`
 * itself and the pipeline run view's `StepNode` (a step that needs the
 * user). Defining them once means "same as the card" holds by
 * construction instead of by copy — see
 * `docs/plans/pipeline-blocked-step-highlight.md` §3.2. The glow overlay
 * that goes with the ring is `AwaitingGlow`
 * (`@/components/ui/awaiting-glow`).
 */

/**
 * The call-to-action wording for something waiting on the user, by its
 * pending structured-interaction count: `Answer (N)` for several, `Answer`
 * for exactly one, else `Review` — the signal is then a `blocked` column or
 * block with no answerable payload (an error, a missing handoff, codex's
 * approval heuristic), so promising a Q&A flow would be wrong.
 */
export function awaitingLabel(pendingCount: number): string {
  if (pendingCount > 1) return `Answer (${pendingCount})`;
  if (pendingCount === 1) return "Answer";
  return "Review";
}

/** The static amber ring around a card/node that is waiting on the user.
 *  A ring (box-shadow) rather than an animated property: the pulse lives on
 *  `AwaitingGlow`'s separate overlay, so nothing here repaints per frame. */
export const AWAITING_RING_CLASS = "ring-2 ring-warning/60 ring-offset-2 ring-offset-background";

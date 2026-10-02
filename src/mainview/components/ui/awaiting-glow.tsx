/**
 * The "waiting on you" glow — a separate overlay whose OPACITY pulses,
 * rather than animating `filter: drop-shadow` (or a box-shadow keyframe) on
 * the host itself: filter animations re-rasterize the whole host on the CPU
 * every frame (60–120 Hz, for as long as it's awaiting), and a box-shadow
 * keyframe would also clobber the host's `ring-*` (`AWAITING_RING_CLASS` in
 * `@/lib/awaiting`), whereas an opacity animation is compositor-only. The
 * shadow is static and paints outside the overlay's box, so the overlay is
 * invisible over the host's own content and `pointer-events-none` keeps
 * clicks and drags untouched. Stops pulsing under reduced motion.
 *
 * Render it as the LAST child of a `relative` host (it's `absolute inset-0`
 * and inherits the host's corner radius). Shared by the kanban `TaskCard`
 * and the pipeline run view's `StepNode`.
 */
export function AwaitingGlow() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 rounded-[inherit] animate-awaiting-pulse motion-reduce:animate-none"
      style={{ boxShadow: "0 0 14px hsl(var(--warning) / 0.85)" }}
    />
  );
}

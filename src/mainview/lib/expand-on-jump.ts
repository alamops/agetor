// DOM-free helper for the search-jump auto-expand behavior in RunPanel: a
// tool-call card (or its folded result / thinking block) collapses by
// default, but jumping search onto a match inside a collapsed block should
// still reveal it. RunPanel's active-match highlight effect is imperative
// (classList + scrollIntoView on the matched `[data-evid]` element) rather
// than a prop threaded through the `sections` memo, to avoid re-deriving the
// whole section tree on every match navigation — this module rides the same
// imperative channel via a bubbling CustomEvent instead of new props.
export const EXPAND_EVENT = "agetor:expand-on-jump";

/** True iff `root` is the highlighted element (or an ancestor of it) that
 *  dispatched `EXPAND_EVENT` — i.e. `target` (the event's bubbling origin)
 *  contains `root`. `node.contains(node)` is true, which is intentional: a
 *  block whose own root IS the matched element should still expand. */
export function isExpandTargetFor(target: unknown, root: Element | null): boolean {
  if (!root) return false;
  if (!(target instanceof Node)) return false;
  return target.contains(root);
}

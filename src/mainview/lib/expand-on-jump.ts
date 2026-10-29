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

/** What a search jump carries on `EXPAND_EVENT`'s `detail`: the query the
 *  jump matched, so a listener that renders only part of its content inline
 *  (the formatted handoff card — `docs/plans/formatted-handoff.md` D10) can
 *  tell whether the match is visible or only in its modal. Every field is
 *  optional: a dispatch without a `detail` (or with a malformed one) reads
 *  as `{}`, which keeps the plain "expand me" listeners unchanged. */
export interface ExpandOnJumpDetail {
  query?: string;
}

/** Read an {@link ExpandOnJumpDetail} off a dispatched `EXPAND_EVENT`,
 *  tolerating a plain `Event`, a missing `detail` and non-string fields. */
export function expandDetailOf(evt: unknown): ExpandOnJumpDetail {
  const detail = (evt as { detail?: unknown } | null | undefined)?.detail;
  if (detail === null || typeof detail !== "object") return {};
  const query = (detail as { query?: unknown }).query;
  return typeof query === "string" ? { query } : {};
}

// Identity-preserving helpers for the pipeline run state RunPanel keeps for a
// pipeline STEP task (`docs/plans/formatted-handoff.md` K7). The parent's run
// is refetched (debounced) on every `pipeline` event, and each response is a
// freshly parsed object tree even when nothing changed; storing it as-is
// would change the identity of everything derived from it (graph, history
// record, the handoff view context) and re-render every handoff card and
// prompt bubble about twice a second. These helpers reduce a value to a
// content signature so an unchanged one keeps its previous identity.
//
// Pure and DOM-free (unit-tested without a DOM env).

/** A content signature of `value`: equal for structurally equal JSON values
 *  (key order is stable because the server serializes the same shape each
 *  time). `null`/`undefined` have their own signatures. A value JSON can't
 *  serialize (cyclic) yields a unique signature, i.e. "always changed". */
export function contentSignature(value: unknown): string {
  if (value === undefined) return "u";
  try {
    return `j${JSON.stringify(value)}`;
  } catch {
    return `x${Math.random()}`;
  }
}

/** A value paired with its signature. */
export interface Signed<T> {
  sig: string;
  value: T;
}

/** `next`, unless `prev` holds a value with the same content signature — then
 *  `prev` itself (same object, same `value` identity). `sig` is `next`'s
 *  signature when the caller already computed it. */
export function reuseIfSameContent<T>(prev: Signed<T> | null | undefined, next: T, sig: string = contentSignature(next)): Signed<T> {
  if (prev && prev.sig === sig) return prev;
  return { sig, value: next };
}

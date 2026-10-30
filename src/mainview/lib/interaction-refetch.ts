// Bookkeeping for the run panel's pending-interaction refetch.
//
// The panel refetches `GET /tasks/:id/interactions/pending` when the task
// stream (re)connects, while interaction cards also arrive and resolve over
// SSE. Without care, the in-flight response overwrites what the stream said in
// the meantime: a card that landed over SSE while the request was in flight is
// lost, and a card the user resolved meanwhile reappears. This tracker records
// those two kinds of change during one refetch so the response can be merged
// with them, and tokens make a superseded response (a newer refetch, a task
// switch) get ignored instead of applied.

/** Server list, plus cards that arrived over SSE while the request was in
 *  flight (deduped by id, the server copy wins), minus any id resolved
 *  meanwhile. Order: server order, then arrival order. */
export function mergeRefetchedInteractions<T extends { id: string }>(
  list: T[],
  arrived: readonly T[],
  resolvedIds: ReadonlySet<string>,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of [...list, ...arrived]) {
    if (resolvedIds.has(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

export interface InteractionRefetchTracker<T extends { id: string }> {
  /** Start a refetch (superseding any earlier one); returns its token. */
  begin(): number;
  /** Record a card that arrived over SSE. No-op outside a refetch. */
  noteArrived(item: T): void;
  /** Record a card resolved over SSE. No-op outside a refetch. */
  noteResolved(id: string): void;
  /** End the refetch `token` started and return what arrived/resolved during
   *  it, or `null` when the token is stale (a newer `begin` or a `cancel`). */
  finish(token: number): { arrived: T[]; resolvedIds: Set<string> } | null;
  /** End any in-flight refetch (task switch / unmount). */
  cancel(): void;
}

export function createInteractionRefetchTracker<
  T extends { id: string },
>(): InteractionRefetchTracker<T> {
  let nextToken = 0;
  /** Token of the refetch in flight, or null when none is. */
  let active: number | null = null;
  let arrived: T[] = [];
  let resolvedIds = new Set<string>();

  return {
    begin() {
      active = ++nextToken;
      arrived = [];
      resolvedIds = new Set();
      return active;
    },
    noteArrived(item) {
      if (active === null) return;
      // A card resolved and then re-sent under the same id is live again.
      resolvedIds.delete(item.id);
      arrived.push(item);
    },
    noteResolved(id) {
      if (active === null) return;
      resolvedIds.add(id);
    },
    finish(token) {
      if (active === null || token !== active) return null;
      const result = { arrived, resolvedIds };
      active = null;
      arrived = [];
      resolvedIds = new Set();
      return result;
    },
    cancel() {
      active = null;
      arrived = [];
      resolvedIds = new Set();
    },
  };
}

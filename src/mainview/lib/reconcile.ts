// Identity-preserving list reconciliation for poll-driven state. Lives in
// lib (not App.tsx) so RunPanel's own 2s backstop polls (`/tasks/:id/runs`,
// `/tasks/:id/subagents`) can use the exact same helper the board uses —
// before this every one of those ticks handed React a brand-new array and
// re-rendered the whole open panel while a run merely streamed.

/**
 * Reconcile a freshly-fetched list against the previously-rendered one,
 * preserving object identity for entries that haven't actually changed.
 * Poll-driven fetches (`/tasks` every 2s, `/harnesses` every 15s, RunPanel's
 * `/runs` + `/subagents` every 2s while a run is active) otherwise
 * hand back brand-new object graphs every tick even when nothing changed
 * server-side — that defeats `React.memo` on every downstream card/column
 * and force-renders the selected-task sync effect. Deep-equality here is a
 * plain `JSON.stringify` compare: cheap at this scale (hundreds of small
 * objects, once per poll) and robust against any field changing without a
 * corresponding `updatedAt` bump (e.g. `pendingInteractionCount`,
 * `runningSubagents`, `openTerminalCount` are all computed server-side per
 * request and aren't reflected in `updatedAt`).
 *
 * `cache`, when passed, memoizes each entry's serialized form by id so a
 * poll where nothing changed only has to `JSON.stringify` the freshly
 * fetched (`next`) side — the `prev` side is a cache hit as long as the
 * cached entry's object reference still matches what's actually in `prev`
 * (it can legitimately not: several call sites patch `tasks` state directly
 * for optimistic updates, bypassing this function, so a stale/mismatched
 * cache entry falls back to recomputing rather than trusting a stringified
 * form for a different object). Entries whose id no longer appears in
 * `next` are evicted so the cache doesn't grow unboundedly across a
 * session's worth of deleted/archived tasks.
 *
 * Returns `prev` itself (same array reference) when every entry, in the
 * same order, is unchanged — letting the caller's `setState` bail out
 * entirely instead of triggering a render.
 */
export function reconcileById<T>(
  prev: T[],
  next: T[],
  keyOf: (item: T) => string,
  cache?: Map<string, { obj: T; json: string }>,
): T[] {
  const prevByKey = new Map(prev.map((item) => [keyOf(item), item] as const));
  const seen = new Set<string>();
  const merged = next.map((item) => {
    const key = keyOf(item);
    seen.add(key);
    const old = prevByKey.get(key);
    const nextJson = JSON.stringify(item);
    let unchanged = false;
    if (old !== undefined) {
      const cached = cache?.get(key);
      const oldJson = cached && cached.obj === old ? cached.json : JSON.stringify(old);
      unchanged = oldJson === nextJson;
    }
    const finalItem = unchanged ? old! : item;
    if (cache) cache.set(key, { obj: finalItem, json: nextJson });
    return finalItem;
  });
  if (cache) {
    for (const key of cache.keys()) {
      if (!seen.has(key)) cache.delete(key);
    }
  }
  if (merged.length === prev.length && merged.every((item, i) => item === prev[i])) {
    return prev;
  }
  return merged;
}

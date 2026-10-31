/**
 * Fold one pending-interaction payload into the panel's list.
 *
 * A new id is appended. The same id replaces the previous payload when it
 * changed — a Cursor card keeps its id when the child exits and the delivery
 * flips from `"live"` to `"restart-followup"`. Ignoring that republish left
 * an open panel on "Cursor is waiting". An identical payload returns the
 * same array so a replay does not re-render the card.
 */
export function mergePendingInteraction<T extends { id: string }>(current: readonly T[], incoming: T): T[] {
  const index = current.findIndex((item) => item.id === incoming.id);
  if (index === -1) return [...current, incoming];
  if (JSON.stringify(current[index]) === JSON.stringify(incoming)) return current as T[];
  const next = current.slice();
  next[index] = incoming;
  return next;
}

/**
 * Fold a pending-interaction bootstrap snapshot into the list the live
 * stream already holds.
 *
 * The snapshot is whatever the server had when the fetch ran. By the time
 * it arrives, the stream may have replaced a card (same id, new delivery)
 * or removed one. Those live facts win: an id already in `current` keeps
 * that payload, and an id in `resolvedIds` is not put back. Ids that appear
 * only in the snapshot are appended — questions that fired before the panel
 * subscribed. An unchanged list returns the same array.
 */
export function mergePendingInteractionSnapshot<T extends { id: string }>(
  current: readonly T[],
  snapshot: readonly T[],
  resolvedIds: ReadonlySet<string>,
): T[] {
  const currentIds = new Set(current.map((item) => item.id));
  const additions: T[] = [];
  for (const item of snapshot) {
    if (resolvedIds.has(item.id) || currentIds.has(item.id)) continue;
    additions.push(item);
  }
  if (additions.length === 0) return current as T[];
  return [...current, ...additions];
}

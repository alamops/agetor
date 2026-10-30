/**
 * A Cursor ACP tool call arrives as `tool_call`, then again as
 * `tool_call_update` once `rawInput` has grown. The driver re-emits the
 * `tool_use` chunk (same id, new payload). Transcripts show the latest
 * payload only — an earlier partial would sit beside it as a second card.
 */
export function supersededToolUseIndexes(
  events: ReadonlyArray<{ stream: string; data: string }>,
): Set<number> {
  const last = new Map<string, number>();
  for (let i = 0; i < events.length; i++) {
    const id = toolUseId(events[i]!);
    if (id) last.set(id, i);
  }
  const skip = new Set<number>();
  for (let i = 0; i < events.length; i++) {
    const id = toolUseId(events[i]!);
    if (id && last.get(id) !== i) skip.add(i);
  }
  return skip;
}

/**
 * Drop earlier `tool_use` rows that share an id with a later one.
 * A Cursor ACP update rebroadcasts the same call as its `rawInput` grows.
 * The open panel and the TUI keep the latest payload only, so those
 * partials do not consume the live window. An unchanged list returns the
 * same array.
 */
export function foldToolUseRevisions<T extends { stream: string; data: string }>(
  events: readonly T[],
): T[] {
  const skip = supersededToolUseIndexes(events);
  if (skip.size === 0) return events as T[];
  return events.filter((_, index) => !skip.has(index));
}

function toolUseId(event: { stream: string; data: string }): string | null {
  if (event.stream !== "tool_use") return null;
  try {
    const parsed = JSON.parse(event.data) as { id?: unknown };
    return typeof parsed.id === "string" && parsed.id.length > 0 ? parsed.id : null;
  } catch {
    return null;
  }
}

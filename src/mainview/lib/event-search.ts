// Pure search-over-events logic for the task-details message stream
// (RunPanel). Kept DOM-free (like subagent-tabs.ts / command-message.ts) so
// the matching/navigation math can be unit-tested without a DOM harness —
// this repo has no jsdom/testing-library, so anything that touches the log's
// actual React tree has to be validated by testing the logic it's driven by
// instead. RunPanel itself owns the client-assigned `id` scheme it hands to
// `findMatchingEventIds` (an index into whatever event list is currently
// displayed, since the server doesn't guarantee a stable id across every
// source an event can come from — see `StreamEvent` in RunPanel.tsx).
import type { RunEventStream } from "../../shared/types.ts";

/** Best-effort JSON.parse that never throws — malformed/partial JSON (e.g. a
 *  tool input truncated by an older agetor mapper) falls back to `null`
 *  rather than blowing up the search. */
function tryParseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** Render a JSON value as search-friendly text: pass strings through as-is,
 *  stringify anything else (objects/arrays/numbers) so nested tool input/
 *  result text is still searchable. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * Human-visible search text for one event, mirroring exactly what
 * `RunEventList` renders for that `stream` — so a match always corresponds to
 * something the user can actually see on screen. Returns `null` for streams
 * the log never renders (`interaction`/`interaction_resolved` are consumed
 * into interaction cards keyed by request id, not by event; `subagent` is a
 * tab-strip lifecycle delta, not a transcript line) — those events can never
 * match a query.
 *
 * `tool_use`/`tool_result` carry JSON (`{ id, name, input }` /
 * `{ toolUseId, content }` per the `RunEvent` doc comment in shared/types.ts);
 * malformed JSON (legacy truncated payloads, corrupt persisted rows) falls
 * back to the raw string rather than throwing, same as every other
 * best-effort JSON.parse over transcript data in this codebase.
 */
export function searchableEventText(stream: RunEventStream, data: string): string | null {
  switch (stream) {
    case "interaction":
    case "interaction_resolved":
    case "subagent":
      return null;
    case "tool_use": {
      const parsed = tryParseJson(data) as { name?: unknown; input?: unknown } | null;
      if (!parsed || typeof parsed !== "object") return data;
      const parts = [textOf(parsed.name), textOf(parsed.input)].filter((s) => s !== "");
      return parts.length > 0 ? parts.join(" ") : data;
    }
    case "tool_result": {
      const parsed = tryParseJson(data) as { content?: unknown } | null;
      if (!parsed || typeof parsed !== "object" || !("content" in parsed)) return data;
      return textOf(parsed.content);
    }
    case "user":
    case "assistant":
    case "thinking":
    case "status":
    case "stderr":
    case "stdout":
    default:
      return data;
  }
}

/** Minimal shape `findMatchingEventIds` needs — RunPanel maps its
 *  `displayedEvents` (whatever shape those happen to be — live `StreamEvent`s
 *  with a client id, or `RunEvent`s replayed from a JSONL rebuild with none)
 *  into this before calling in, assigning `id` fresh each time. */
export interface SearchableEvent {
  id: number;
  stream: RunEventStream;
  data: string;
}

/**
 * Ids (in `events` order) of every event whose searchable text contains
 * `query`, case-insensitively. `query` is trimmed first — an empty/whitespace
 * query matches nothing (search is "off", not "match everything").
 */
export function findMatchingEventIds(events: ReadonlyArray<SearchableEvent>, query: string): number[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const needle = trimmed.toLowerCase();
  const out: number[] = [];
  for (const e of events) {
    const text = searchableEventText(e.stream, e.data);
    if (text === null) continue;
    if (text.toLowerCase().includes(needle)) out.push(e.id);
  }
  return out;
}

/**
 * Step the active-match *position* (an index into the `matches` array — not
 * an event id) by one, wrapping around both ends. Pass `current = -1` for
 * "nothing selected yet": stepping forward lands on the first match, backward
 * lands on the last. Returns -1 when there's nothing to select.
 */
export function stepMatchIndex(matchCount: number, current: number, dir: 1 | -1): number {
  if (matchCount === 0) return -1;
  if (current < 0) return dir === 1 ? 0 : matchCount - 1;
  return (current + dir + matchCount) % matchCount;
}

/**
 * Recompute the active-match *position* (matching `stepMatchIndex`'s
 * index-into-`matches` convention) after `matches` is recomputed — e.g. on
 * every keystroke, or when the underlying event list shifts under an open
 * search. If `prevActiveId` (the event id that was active before this
 * recompute) is still present in the new `matches`, keep pointing at it —
 * its position may have shifted, but the same event stays selected instead
 * of navigation progress silently resetting on every keystroke. Otherwise
 * default to the first match (position 0): a fresh query, or one whose
 * previous match scrolled out of the matched set, should land on the top hit
 * rather than nothing. Returns -1 when there are no matches at all.
 */
export function resolveActiveMatchIndex(matches: number[], prevActiveId: number | null): number {
  if (matches.length === 0) return -1;
  if (prevActiveId !== null) {
    const idx = matches.indexOf(prevActiveId);
    if (idx !== -1) return idx;
  }
  return 0;
}

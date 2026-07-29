// Pure search-over-events logic for the task-details message stream
// (RunPanel). Kept DOM-free (like subagent-tabs.ts / command-message.ts) so
// the matching/navigation math can be unit-tested without a DOM harness —
// this repo has no jsdom/testing-library, so anything that touches the log's
// actual React tree has to be validated by testing the logic it's driven by
// instead. `findMatchingEventIds` uses each event's position in the array
// RunPanel hands it (`displayedEvents`, in `RunEvent` order) as the match id
// — the server doesn't guarantee a stable id across every source an event
// can come from (live SSE vs. a JSONL rebuild splice — see `StreamEvent` in
// RunPanel.tsx), but a positional index scoped to "whatever's currently
// displayed" is always available, and it's exactly what the log's
// `data-evid` DOM attribute is keyed on too.
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
 * Search text for one event's own JSON/string payload. This is raw event
 * data — a superset/approximation of what `RunEventList` actually renders,
 * not a faithful re-implementation of it (no markdown formatting, no
 * per-tool input summarizer, no truncated-JSON repair) — good enough to
 * decide "does this event contain the query," not a guarantee that every
 * matched substring is visible verbatim on screen. Returns `null` for
 * streams the log never renders as their own block (`interaction`/
 * `interaction_resolved` are consumed into interaction cards keyed by
 * request id, not by event; `subagent` is a tab-strip lifecycle delta, not a
 * transcript line) — those events can never match a query.
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

/** Frozen empty-matches sentinel, returned (rather than a fresh `[]`)
 *  whenever there's nothing to match — a blank/whitespace query, an empty
 *  `events` array, or a query with zero hits — so callers get a stable
 *  identity for "no results" instead of a new array reference every call. */
export const NO_MATCHES: readonly number[] = Object.freeze([]);

/**
 * Ids (positions in `events`, matching the `data-evid` attribute
 * `RunEventList` renders) of every event whose searchable text contains
 * `query`, case-insensitively. `query` is trimmed first — an empty/
 * whitespace query matches nothing (search is "off", not "match
 * everything") — and an empty `events` array always matches nothing.
 *
 * `RunEventList` folds a `tool_result` into the `ToolUseBlock` of the
 * `tool_use` it answers (paired by `toolUseId` ↔ `id`, matching the
 * `ParsedToolUse`/`ParsedToolResult` shapes in RunPanel.tsx) whenever that
 * owning call appears earlier in the stream — the standalone "orphan tool
 * result" card only renders when no such owner exists. A search match has
 * to land on a DOM block that's actually rendered, so this mirrors that
 * fold: a `tool_result` with an earlier owning `tool_use` is excluded from
 * matching at its own index, and its text is appended to the owner's
 * searchable text instead. An orphan `tool_result` (no owner, or the
 * "owner" only appears later / never arrives) stays independently matchable
 * at its own index, same as every other stream.
 */
export function findMatchingEventIds(
  events: ReadonlyArray<{ stream: RunEventStream; data: string }>,
  query: string,
): readonly number[] {
  const trimmed = query.trim();
  if (!trimmed || events.length === 0) return NO_MATCHES;
  const needle = trimmed.toLowerCase();

  // Pass 1: each event's own searchable text, plus a toolUseId → index map
  // for every tool_use that published a non-empty id (legacy normalized
  // events carry `id: ""`, which is falsy and deliberately never
  // registered as an owner — an orphan id can't own anything).
  const ownText: (string | null)[] = new Array(events.length);
  const toolUseIndexById = new Map<string, number>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    ownText[i] = searchableEventText(e.stream, e.data);
    if (e.stream === "tool_use") {
      const parsed = tryParseJson(e.data) as { id?: unknown } | null;
      const id = parsed && typeof parsed === "object" ? parsed.id : undefined;
      if (typeof id === "string" && id) toolUseIndexById.set(id, i);
    }
  }

  // Pass 2: fold each owned tool_result's text into its owner's entry, and
  // mark the tool_result's own index as owned so pass 3 skips it as a
  // separate match target.
  const foldedText = new Map<number, string[]>();
  const owned = new Array<boolean>(events.length).fill(false);
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.stream !== "tool_result") continue;
    const parsed = tryParseJson(e.data) as { toolUseId?: unknown } | null;
    const toolUseId = parsed && typeof parsed === "object" ? parsed.toolUseId : undefined;
    if (typeof toolUseId !== "string" || !toolUseId) continue;
    const ownerIdx = toolUseIndexById.get(toolUseId);
    // Only an EARLIER tool_use counts as an owner — RunEventList only ever
    // folds a result into a call it has already rendered, never one that
    // hasn't arrived yet (or itself, which can't happen, but >= guards it).
    if (ownerIdx === undefined || ownerIdx >= i) continue;
    owned[i] = true;
    const text = ownText[i];
    if (text) {
      const list = foldedText.get(ownerIdx);
      if (list) list.push(text);
      else foldedText.set(ownerIdx, [text]);
    }
  }

  // Pass 3: match. An owned tool_result contributes no match of its own —
  // its text was folded into the owner above instead.
  const out: number[] = [];
  for (let i = 0; i < events.length; i++) {
    if (owned[i]) continue;
    const extra = foldedText.get(i);
    const text = extra ? `${ownText[i] ?? ""} ${extra.join(" ")}` : ownText[i];
    if (!text) continue;
    if (text.toLowerCase().includes(needle)) out.push(i);
  }
  return out.length > 0 ? out : NO_MATCHES;
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
export function resolveActiveMatchIndex(matches: ReadonlyArray<number>, prevActiveId: number | null): number {
  if (matches.length === 0) return -1;
  if (prevActiveId !== null) {
    const idx = matches.indexOf(prevActiveId);
    if (idx !== -1) return idx;
  }
  return 0;
}

/**
 * Archived-history retention: shrink one persisted `tool_result` payload in
 * place (docs/plans/non-blocking-session-restore.md, decision F / §8 A1).
 *
 * `tool_result` rows are 76 % of `run_events.data` on a long-lived database
 * (multi-MB file reads, command output, base64 images) and almost all of that
 * is dead weight once a task has been archived for a month — nothing renders
 * it expanded, nothing re-derives state from its tail. The retention pass
 * (`src/bun/retention.ts`) therefore rewrites each such row with
 * {@link trimToolResultData}, keeping the row, its id and its `line_uuid` (so
 * dedup, paging, unarchive and resume are untouched) but cutting the bulky
 * `content` to a 4 KB budget.
 *
 * Every harness persists `tool_result` as `{ toolUseId, content, isError,
 * attachments? }` and differs only in the shape of `content`:
 *
 *   - a string (codex, antigravity, most gemini, plain claude),
 *   - an array of blocks (claude: `{type:"text",text}` plus possibly
 *     base64 `image`/`document` blocks; fx: ACP items
 *     `{type:"content",content:{type:"text",text}}`),
 *   - a plain object (cursor's `tool_call`, some gemini/fx results).
 *
 * The output is still valid JSON in the same envelope, with a `retention`
 * marker as the FIRST key — the retention SQL skips already-trimmed rows with a
 * `substr(data, 1, 13) != '{"retention":'` prefilter, which makes the pass
 * idempotent and crash-resumable without parsing anything. `toolUseId`,
 * `isError` and `attachments` are never touched, so `parseSentFilesToolResult`,
 * the TODO tracker and the transcript pairing keep working: the anchors those
 * consumers read sit in the first bytes of the text, which the trim preserves.
 *
 * Zero runtime imports (the type import below is erased), so this module is
 * usable from the Bun side and the webview alike.
 */
import type { ToolResultRetention } from "./types";

/** UTF-8 byte length of `s` (lone surrogates count as the 3-byte U+FFFD a
 *  `TextEncoder` would substitute, matching how SQLite stores them). */
export function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * The longest prefix of `s` whose UTF-8 encoding fits in `maxBytes`, cut on a
 * code-point boundary — a surrogate pair is never split, so the result is
 * always well-formed text. Returns `s` itself (same reference) when it
 * already fits. Cost is O(min(s.length, maxBytes)): it stops at the cut.
 */
export function cutUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  // Cheap exits before walking: every UTF-16 unit is at most 3 bytes.
  if (s.length * 3 <= maxBytes) return s;
  let bytes = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    let width = 3;
    let units = 1;
    if (c < 0x80) width = 1;
    else if (c < 0x800) width = 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        width = 4;
        units = 2;
      }
    }
    if (bytes + width > maxBytes) return s.slice(0, i);
    bytes += width;
    i += units;
  }
  return s;
}

const ELLIPSIS = "…";
/** Longest block-type label echoed into a removal placeholder. */
const MAX_TYPE_LABEL = 40;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Cut a string to `maxBytes` and mark the cut with `…`; same string when it fits. */
function cutWithEllipsis(s: string, maxBytes: number): string {
  const cut = cutUtf8(s, maxBytes);
  return cut === s ? s : cut + ELLIPSIS;
}

/** `{type:"text",text}` placeholder for a block the trim removed. */
function removedBlock(item: unknown): { type: "text"; text: string } {
  const type = isPlainObject(item) && typeof item.type === "string" && item.type ? item.type : "unknown";
  const label = type.length > MAX_TYPE_LABEL ? type.slice(0, MAX_TYPE_LABEL) : type;
  return { type: "text", text: `[${label} block removed by retention]` };
}

/** The text carried by a block the renderers treat as text — a bare
 *  `{type:"text",text}` or fx's ACP wrapper `{type:"content",content:{type:"text",text}}`
 *  (see `acpTextContentValue` in `src/bun/fx-acp.ts`). */
function blockText(item: unknown): string | undefined {
  if (!isPlainObject(item)) return undefined;
  if (item.type === "text" && typeof item.text === "string") return item.text;
  if (item.type === "content" && isPlainObject(item.content)) {
    const inner = item.content;
    if (inner.type === "text" && typeof inner.text === "string") return inner.text;
  }
  return undefined;
}

/** `item` with its text replaced (the same wrapper shape in, the same out). */
function withBlockText(item: Record<string, unknown>, text: string): Record<string, unknown> {
  if (item.type === "content" && isPlainObject(item.content)) {
    return { ...item, content: { ...item.content, text } };
  }
  return { ...item, text };
}

/**
 * Trim an array-of-blocks `content`: text blocks are kept in order while the
 * shared `maxBytes` text budget lasts (the block that crosses it is cut with
 * `…`), later blocks are dropped, and every non-text block met while budget
 * remains (image, document, anything unrecognised) becomes a tiny placeholder
 * text block — those carry the base64 payloads that make a row huge without
 * any text to cut. Returns `null` when nothing changed.
 */
function trimBlocks(blocks: unknown[], maxBytes: number): unknown[] | null {
  const out: unknown[] = [];
  let budget = maxBytes;
  let changed = false;
  for (let i = 0; i < blocks.length; i++) {
    const item = blocks[i];
    if (budget <= 0) {
      // Budget spent: everything after is dropped (a pathological array of
      // thousands of tiny blocks must not keep growing the output).
      changed = true;
      break;
    }
    const text = blockText(item);
    if (text === undefined) {
      out.push(removedBlock(item));
      changed = true;
      continue;
    }
    const bytes = utf8Length(text);
    if (bytes <= budget) {
      out.push(item);
      budget -= bytes;
      continue;
    }
    out.push(withBlockText(item as Record<string, unknown>, cutUtf8(text, budget) + ELLIPSIS));
    budget = 0;
    changed = true;
  }
  return changed ? out : null;
}

/** Trimmed `content`, or `undefined` when it is already within budget (or of a
 *  shape the trim leaves alone). */
function trimContent(content: unknown, maxBytes: number): unknown | undefined {
  if (typeof content === "string") {
    const cut = cutWithEllipsis(content, maxBytes);
    return cut === content ? undefined : cut;
  }
  if (Array.isArray(content)) return trimBlocks(content, maxBytes) ?? undefined;
  if (isPlainObject(content)) {
    // Whole-payload fallback for cursor/gemini/fx object results: there is no
    // separable text field, so the object becomes its own JSON, cut to budget
    // (every renderer already accepts a string `content`).
    const json = JSON.stringify(content);
    if (json === undefined) return undefined;
    const cut = cutWithEllipsis(json, maxBytes);
    return cut === json ? undefined : cut;
  }
  return undefined;
}

/**
 * Trim one stored `tool_result` `data` string to roughly `maxBytes` of
 * content, or return `null` when it must be left untouched: not JSON, not a
 * plain object, already carrying a `retention` marker, the whole payload
 * already within `maxBytes`, `content` of a shape/size with nothing to cut, or
 * (defensively) a result that would not actually be smaller than the input.
 *
 * On success `data` is the re-serialized payload — `retention` FIRST, then
 * `toolUseId`, `content` (trimmed), `isError`, `attachments`, then any other
 * original keys in their original order — and `originalBytes` the UTF-8 length
 * of the input (also recorded inside `retention`). `now` is the trim timestamp
 * (ms epoch), passed in so callers and tests control it.
 */
export function trimToolResultData(
  data: string,
  maxBytes: number,
  now: number,
): { data: string; originalBytes: number } | null {
  // Cheap size gate before any parse: a payload with more UTF-16 units than the
  // budget has more bytes than the budget; one with ≤ budget/3 units surely fits.
  if (data.length * 3 <= maxBytes) return null;
  const originalBytes = utf8Length(data);
  if (originalBytes <= maxBytes) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (Object.prototype.hasOwnProperty.call(parsed, "retention")) return null;
  if (!Object.prototype.hasOwnProperty.call(parsed, "content")) return null;

  const trimmedContent = trimContent(parsed.content, maxBytes);
  if (trimmedContent === undefined) return null;

  const retention: ToolResultRetention = { trimmed: true, originalBytes, trimmedAt: now };
  const out: Record<string, unknown> = { retention };
  if ("toolUseId" in parsed) out.toolUseId = parsed.toolUseId;
  out.content = trimmedContent;
  if ("isError" in parsed) out.isError = parsed.isError;
  if ("attachments" in parsed) out.attachments = parsed.attachments;
  for (const key of Object.keys(parsed)) {
    if (key === "toolUseId" || key === "content" || key === "isError" || key === "attachments") continue;
    out[key] = parsed[key];
  }

  const serialized = JSON.stringify(out);
  if (utf8Length(serialized) >= originalBytes) return null;
  return { data: serialized, originalBytes };
}

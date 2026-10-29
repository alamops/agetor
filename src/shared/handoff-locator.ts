/**
 * The one linear-time locator for `<handoff>…</handoff>` blocks in agent
 * text — shared by the bun-side runner (via `parseHandoff` /
 * `classifyStepResponse` in `./pipeline.ts`) and by every display surface
 * (the webview's handoff card, run-view history, `agetor logs`, the TUI), so
 * "is this a real handoff" can never be answered differently in two places.
 * Kept free of runtime imports except `PIPELINE_LIMITS` so the webview and
 * the CLI can import it. See `docs/plans/formatted-handoff.md` (K1).
 *
 * Two scan modes:
 *
 * - **Code-aware** (default). Prose is scanned as Markdown: a tag inside an
 *   inline code span or a fenced code block is not an open tag (an agent that
 *   merely *talks about* the `<handoff>` contract in backticks no longer pairs
 *   that mention with its real closing tag). Once a real open tag is found
 *   the scanner switches to block mode: the first close tag ends the block and
 *   Markdown is ignored inside it (a ```` ```json ```` fence or stray
 *   backticks within the JSON don't matter), then prose scanning resumes after
 *   the close with a fresh code state. Code state also resets at every
 *   *segment start* (one segment = one transcript event, rendered on its own
 *   by the Markdown renderer); a block may still pair across segments.
 * - **Legacy** (`codeAware: false`). Exactly the tokenization the runner used
 *   before this module existed — no Markdown awareness at all. Kept for the
 *   delta-streaming harnesses (see `HANDOFF_DELTA_STREAM_KINDS` in
 *   `./pipeline.ts`), whose per-chunk events would otherwise split a fence
 *   across segments.
 *
 * Both modes scan only the trailing `PIPELINE_LIMITS.handoffScanTailBytes`
 * UTF-16 code units, reject `<handoffx…>` as an open tag, tolerate attributes
 * on the open tag, and tolerate whitespace around the close tag's name. Every
 * lookup is memoized or moves strictly forward, so the work is linear in the
 * scanned text however hostile the input (50k unclosed opens, 50k unmatched
 * backtick runs of cycling lengths, 50k fence-like lines, 50k quoted mentions
 * — all pinned by `handoff-locator.test.ts`).
 */
import { PIPELINE_LIMITS } from "./types.ts";

/** The XML-ish tag a step's agent is asked to wrap its final handoff JSON
 *  in — `<handoff>{...}</handoff>`. Single source of truth for both the
 *  prompt text (`composeStepPrompt`) and the parser's tag matching; renamed
 *  from `agetor_handoff` per the owner's D3 pick. Re-exported from
 *  `./pipeline.ts`. */
export const HANDOFF_TAG = "handoff";

/** One located block. All offsets index into the `text` handed to {@link
 *  findHandoffBlocks}: `text.slice(start, openEnd)` is the open tag,
 *  `text.slice(openEnd, closeStart)` the inner text, `text.slice(closeStart,
 *  end)` the close tag. */
export interface HandoffBlockSpan {
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
}

const OPEN_PREFIX = `<${HANDOFF_TAG}`;

const CH_NEWLINE = 10;
const CH_TAB = 9;
const CH_CR = 13;
const CH_SPACE = 32;
const CH_GT = 62;
const CH_BACKTICK = 96;
const CH_TILDE = 126;

const ASCII_UPPER_RE = /[A-Z]/;
const ASCII_UPPER_G_RE = /[A-Z]/g;

/** ASCII-only lower-casing. Unlike `toLowerCase()` this never changes the
 *  string's length (a handful of non-ASCII characters, e.g. `İ`, expand
 *  under full case mapping and would shift every later offset), and the tag
 *  name only contains ASCII letters, so the matches are identical. */
function asciiLower(s: string): string {
  if (!ASCII_UPPER_RE.test(s)) return s;
  return s.replace(ASCII_UPPER_G_RE, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** ASCII/Unicode whitespace as JS's `\s` regex class sees it — the scanner
 *  must agree with the original regex's `\s` for the "whitespace around the
 *  close tag" and "whitespace after the tag name" tolerances. */
function isWs(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/** Match `</\s*handoff\s*>` at `p` (which must point at a `</`) in the
 *  lower-cased text — returns the index just past the `>` or `-1`. Cost is
 *  the two whitespace runs plus the tag name, never more. */
function matchCloseTagAt(lower: string, p: number): number {
  let i = p + 2;
  while (isWs(lower[i])) i++;
  if (!lower.startsWith(HANDOFF_TAG, i)) return -1;
  i += HANDOFF_TAG.length;
  while (isWs(lower[i])) i++;
  return lower[i] === ">" ? i + 1 : -1;
}

/** First `</\s*handoff\s*>` at or after `from` — `{start, end}` or `null`.
 *  Linear: every `</` candidate is checked once and the search resumes past
 *  it, so a run of `</` + whitespace is walked exactly once. */
function findCloseTag(lower: string, from: number): { start: number; end: number } | null {
  let p = from;
  for (;;) {
    const at = lower.indexOf("</", p);
    if (at === -1) return null;
    const end = matchCloseTagAt(lower, at);
    if (end !== -1) return { start: at, end };
    p = at + 2;
  }
}

interface OpenTag {
  start: number;
  openEnd: number;
}

/** Memoizing lookups over the lower-cased tail shared by both scan modes. */
function createTagFinder(lower: string) {
  // "first `>` at or after i" — valid for any i in [gtFrom, gt] (or any
  // i >= gtFrom when gt === -1: no `>` remains at all), so a run of
  // `<handoff ` false-opens with no `>` is walked once, not once per candidate.
  let gtFrom = -1;
  let gt = -1;
  const firstGtAfter = (i: number): number => {
    if (gtFrom !== -1 && i >= gtFrom && (gt === -1 || i <= gt)) return gt;
    gtFrom = i;
    gt = lower.indexOf(">", i);
    return gt;
  };

  // The next open tag at or after `from`, memoized: the result is valid for
  // any query in [openFrom, openAt] (every position in that range has the
  // same first candidate), and a `null` result holds for every later query.
  let openFrom = -1;
  let openAt = -1;
  let openResult: OpenTag | null = null;
  const nextOpenTag = (from: number): OpenTag | null => {
    if (openFrom !== -1 && from >= openFrom && from <= openAt) return openResult;
    let cursor = from;
    let result: OpenTag | null = null;
    for (;;) {
      const open = lower.indexOf(OPEN_PREFIX, cursor);
      if (open === -1) break;
      const afterName = open + OPEN_PREFIX.length;
      const next = lower[afterName];
      if (next === ">") {
        result = { start: open, openEnd: afterName + 1 };
        break;
      }
      if (isWs(next)) {
        const g = firstGtAfter(afterName);
        if (g === -1) break; // an open tag whose attributes never close — nothing after it can match either
        result = { start: open, openEnd: g + 1 };
        break;
      }
      cursor = open + 1; // `<handoffx…` — not an open tag
    }
    openFrom = from;
    openAt = result === null ? Number.POSITIVE_INFINITY : result.start;
    openResult = result;
    return result;
  };

  return { nextOpenTag };
}

type TagFinder = ReturnType<typeof createTagFinder>;

/** Exactly the pre-existing tokenization: an open tag (attributes allowed up
 *  to the next `>`, `<handoffx>` is not one) pairs with the FIRST close tag
 *  after it, the scan resumes after that close, no Markdown awareness. */
function scanLegacy(lower: string, finder: TagFinder, out: HandoffBlockSpan[]): void {
  let cursor = 0;
  for (;;) {
    const open = finder.nextOpenTag(cursor);
    if (open === null) return;
    const close = findCloseTag(lower, open.openEnd);
    if (close === null) return; // no close after this open → no later open can have one either
    out.push({ start: open.start, openEnd: open.openEnd, closeStart: close.start, end: close.end });
    cursor = close.end;
  }
}

/** End of the line starting at `i` (index of its `\n`), never past `bound`. */
function lineEndOf(t: string, i: number, bound: number): number {
  for (let k = i; k < bound; k++) if (t.charCodeAt(k) === CH_NEWLINE) return k;
  return bound;
}

/** Whether `[i, end)` is empty or whitespace only. */
function isBlankLine(t: string, i: number, end: number): boolean {
  for (let k = i; k < end; k++) {
    const c = t.charCodeAt(k);
    if (c !== CH_SPACE && c !== CH_TAB && c !== CH_CR) return false;
  }
  return true;
}

/** Skip leading whitespace and `>` blockquote markers of the line `[i, end)`. */
function skipLinePrefix(t: string, i: number, end: number): number {
  let k = i;
  while (k < end) {
    const c = t.charCodeAt(k);
    if (c === CH_SPACE || c === CH_TAB || c === CH_GT) k++;
    else break;
  }
  return k;
}

/** If the line `[i, end)` opens a fenced code block — after optional `>`
 *  markers and leading whitespace, ≥3 backticks (with no backtick in the rest
 *  of the line) or ≥3 tildes — its fence character and length, else `null`. */
function fenceOpener(t: string, i: number, end: number): { ch: number; len: number } | null {
  const start = skipLinePrefix(t, i, end);
  if (start >= end) return null;
  const ch = t.charCodeAt(start);
  if (ch !== CH_BACKTICK && ch !== CH_TILDE) return null;
  let k = start;
  while (k < end && t.charCodeAt(k) === ch) k++;
  const len = k - start;
  if (len < 3) return null;
  if (ch === CH_BACKTICK) {
    for (let j = k; j < end; j++) if (t.charCodeAt(j) === CH_BACKTICK) return null;
  }
  return { ch, len };
}

/** Whether the line `[i, end)` closes a fence opened with `ch` × `minLen`:
 *  the same character repeated at least as many times, then only whitespace. */
function isFenceCloser(t: string, i: number, end: number, ch: number, minLen: number): boolean {
  const start = skipLinePrefix(t, i, end);
  let k = start;
  while (k < end && t.charCodeAt(k) === ch) k++;
  if (k - start < minLen) return false;
  return isBlankLine(t, k, end);
}

/** Memoized "next occurrence of one character at or after `from`" over `t` —
 *  valid for any query in [from0, at] of the search that produced it, and a
 *  miss (`-1`) holds for every later query. Keeps the per-paragraph backtick
 *  collection from re-scanning a long stretch with no backticks. */
function createCharSearch(t: string, ch: string) {
  let from0 = -1;
  let at = -1;
  return (from: number): number => {
    if (from0 !== -1 && from >= from0 && (at === -1 || from <= at)) return at;
    from0 = from;
    at = t.indexOf(ch, from);
    return at;
  };
}

/**
 * The code-aware scan (see the module doc). `starts` are ascending segment
 * starts in `t` coordinates, always beginning with `0`.
 *
 * The scan walks lines. Outside a fence, a *paragraph* (the lines up to the
 * next blank line, fence-opener line or segment end) is the unit inline code
 * spans live in: its backtick runs are collected once into parallel arrays and
 * linked to the next run of the SAME length (`nx`), so a run opens a span
 * exactly when `nx` is set, and an unmatched run is literal. Walking the runs
 * in order gives CommonMark's earliest-starting-span precedence, and every run
 * is visited once. A real open tag ends the paragraph walk: the block is
 * closed by the first close tag anywhere after it, and scanning resumes there
 * (inside the same paragraph's tables when the close lands inside it, else
 * from a fresh line walk at the close) with the fence state cleared.
 */
function scanCodeAware(
  t: string,
  lower: string,
  finder: TagFinder,
  starts: readonly number[],
  out: HandoffBlockSpan[],
): void {
  const n = t.length;
  const nextBacktick = createCharSearch(t, "`");
  let pos = 0;
  let segIdx = 0;

  outer: while (pos < n) {
    while (segIdx + 1 < starts.length && starts[segIdx + 1]! <= pos) segIdx++;
    const segStart = starts[segIdx]!;
    const segEnd = segIdx + 1 < starts.length ? starts[segIdx + 1]! : n;

    let first = finder.nextOpenTag(pos);
    if (first === null) return; // no open tag anywhere after here
    if (first.start >= segEnd) {
      pos = segEnd; // nothing in this segment can open a block
      continue;
    }

    let i = pos;
    let fenceCh = 0;
    let fenceLen = 0;
    while (i < segEnd) {
      const le = lineEndOf(t, i, segEnd);
      const next = le < segEnd ? le + 1 : segEnd;

      if (fenceCh !== 0) {
        if (isFenceCloser(t, i, le, fenceCh, fenceLen)) fenceCh = 0;
        i = next;
        continue;
      }
      const atLineStart = i === segStart || t.charCodeAt(i - 1) === CH_NEWLINE;
      if (atLineStart) {
        if (isBlankLine(t, i, le)) {
          i = next;
          continue;
        }
        const f = fenceOpener(t, i, le);
        if (f !== null) {
          fenceCh = f.ch;
          fenceLen = f.len;
          i = next;
          continue;
        }
      }

      // A paragraph starts at `i`: find where it ends.
      let pEnd = next;
      while (pEnd < segEnd) {
        const e = lineEndOf(t, pEnd, segEnd);
        if (isBlankLine(t, pEnd, e) || fenceOpener(t, pEnd, e) !== null) break;
        pEnd = e < segEnd ? e + 1 : segEnd;
      }

      first = finder.nextOpenTag(i);
      if (first === null) return;
      if (first.start >= segEnd) {
        pos = segEnd;
        continue outer;
      }
      if (first.start >= pEnd) {
        i = pEnd; // no candidate tag in this paragraph — no need for its code spans
        continue;
      }

      // Backtick runs of the paragraph, each linked to the next run of equal length.
      const rp: number[] = [];
      const rl: number[] = [];
      for (let q = nextBacktick(i); q !== -1 && q < pEnd; ) {
        let e = q + 1;
        while (e < pEnd && t.charCodeAt(e) === CH_BACKTICK) e++;
        rp.push(q);
        rl.push(e - q);
        q = nextBacktick(e);
      }
      const rc = rp.length;
      const nx: number[] = new Array<number>(rc);
      if (rc > 0) {
        const lastOfLen = new Map<number, number>();
        for (let k = rc - 1; k >= 0; k--) {
          nx[k] = lastOfLen.get(rl[k]!) ?? -1;
          lastOfLen.set(rl[k]!, k);
        }
      }

      let p = i;
      let k = 0;
      for (;;) {
        const cand = finder.nextOpenTag(p);
        if (cand === null) return;
        if (cand.start >= pEnd) break;

        // Walk the runs before the candidate; a span that reaches past it swallows it.
        let swallowed = false;
        while (k < rc && rp[k]! < cand.start) {
          const m = nx[k]!;
          if (m === -1) {
            k++; // unmatched run — literal text
            continue;
          }
          const spanEnd = rp[m]! + rl[m]!;
          k = m + 1;
          if (cand.start < spanEnd) {
            swallowed = true;
            p = spanEnd;
            break;
          }
        }
        if (swallowed) continue;

        const close = findCloseTag(lower, cand.openEnd);
        if (close === null) return; // no close after this open → none can follow
        out.push({ start: cand.start, openEnd: cand.openEnd, closeStart: close.start, end: close.end });
        fenceCh = 0;
        if (close.end < pEnd) {
          p = close.end;
          while (k < rc && rp[k]! < p) k++;
          continue;
        }
        if (close.end >= segEnd) {
          pos = close.end;
          continue outer;
        }
        i = close.end;
        break;
      }
      if (i < pEnd) i = pEnd;
    }
    pos = segEnd;
  }
}

/** Ascending, de-duplicated segment starts in tail coordinates, beginning at 0. */
function tailSegmentStarts(raw: readonly number[] | undefined, base: number, n: number): number[] {
  const starts = [0];
  if (raw === undefined || raw.length === 0) return starts;
  const shifted: number[] = [];
  for (const s of raw) {
    const v = s - base;
    if (v > 0 && v < n) shifted.push(v);
  }
  shifted.sort((a, b) => a - b);
  for (const v of shifted) if (v !== starts[starts.length - 1]) starts.push(v);
  return starts;
}

/**
 * Every real `<handoff …>…</handoff>` block in `text`, in order, within the
 * trailing `PIPELINE_LIMITS.handoffScanTailBytes` code units (the contract says
 * a block ends the final message, so anything further back is prose). Offsets
 * index into `text`. Options:
 *
 * - `segmentStarts` — offsets in `text` where a new segment (one transcript
 *   event) begins; code-aware scanning resets its Markdown state there. Ignored
 *   by the legacy mode. Omitted: the whole text is one segment.
 * - `codeAware` — default `true`; `false` selects the legacy tokenization.
 *
 * An open tag pairs with the FIRST close tag after it (so a nested
 * `<handoff><handoff>{…}</handoff></handoff>` pairs the outer open with the
 * inner close), and the scan resumes after that close; callers that want "the
 * handoff" take the last span.
 */
export function findHandoffBlocks(
  text: string,
  opts?: { segmentStarts?: readonly number[]; codeAware?: boolean },
): HandoffBlockSpan[] {
  const max = PIPELINE_LIMITS.handoffScanTailBytes;
  const base = text.length > max ? text.length - max : 0;
  const tail = base === 0 ? text : text.slice(base);
  const lower = asciiLower(tail);
  const finder = createTagFinder(lower);
  const out: HandoffBlockSpan[] = [];
  if (opts?.codeAware === false) {
    scanLegacy(lower, finder, out);
  } else {
    scanCodeAware(tail, lower, finder, tailSegmentStarts(opts?.segmentStarts, base, tail.length), out);
  }
  if (base !== 0) {
    for (const s of out) {
      s.start += base;
      s.openEnd += base;
      s.closeStart += base;
      s.end += base;
    }
  }
  return out;
}

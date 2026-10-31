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
 *   the close with a fresh code state. An open tag whose body is prose (no
 *   `{` or fence right after it) is only a block when its close tag lands in
 *   prose too: the scan keeps reading Markdown past it, and a close inside a
 *   fence or code span leaves it a plain mention, and a close in prose may
 *   anchor the block only at an open tag the walk itself met in prose. A block
 *   whose close tag sits inside a fence opened after its open tag (a mention
 *   ending its line right before a fenced example, which looks body-shaped, or
 *   a sloppy block whose own fence never closed) resumes the scan on the next
 *   line still inside that fence. Code state also resets at every
 *   *segment start* (one segment = one transcript event, rendered on its own
 *   by the Markdown renderer); a block may still pair across segments. A
 *   stray mention that escaped code before the real block can't swallow it
 *   either: the block starts at the last open tag before its close that
 *   begins a line, when there is one; failing that, at the first mid-line open
 *   whose body starts JSON after a prose-mention start. Neither rule ever
 *   moves the start past the block's last `{`, since every later start would
 *   leave no JSON object to parse.
 * - **Legacy** (`codeAware: false`). Exactly the tokenization the runner used
 *   before this module existed — no Markdown awareness at all. Kept for the
 *   delta-streaming harnesses (see `HANDOFF_DELTA_STREAM_KINDS` in
 *   `./pipeline.ts`), whose per-chunk events would otherwise split a fence
 *   across segments.
 *
 * Both modes scan only the trailing `PIPELINE_LIMITS.handoffScanTailBytes`
 * UTF-16 code units (code-aware mode seeds the window's fence state from the
 * cut-off text of the segment it lands in, so a cut inside a fenced block can't
 * turn the fence's closing line into an opener), reject `<handoffx…>` as an open tag, tolerate attributes
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
const OPEN_PREFIX_RE = new RegExp(OPEN_PREFIX, "i");

/** Cheap pre-check every surface runs before the real locator: whether
 *  `text` contains the open-tag prefix at all, matched case-insensitively
 *  exactly like {@link findHandoffBlocks} (so `<HANDOFF>` is never skipped
 *  by one surface and found by another). `false` proves there is no block;
 *  `true` only means the locator has to look. */
export function mayContainHandoffOpenTag(text: string): boolean {
  return OPEN_PREFIX_RE.test(text);
}

const CH_NEWLINE = 10;
const CH_TAB = 9;
const CH_CR = 13;
const CH_SPACE = 32;
const CH_GT = 62;
const CH_BACKTICK = 96;
const CH_TILDE = 126;
const CH_HASH = 35;
const CH_STAR = 42;
const CH_DASH = 45;
const CH_QUOTE = 34;
const CH_LBRACE = 123;
const CH_EQUALS = 61;
const CH_UNDERSCORE = 95;

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

/** Whether the line `[i, end)` is an ATX heading — after optional `>`
 *  markers and leading whitespace, 1–6 `#` then whitespace or end of line. A
 *  heading is a one-line block: it interrupts a paragraph and is never
 *  continued, so an inline code span can't cross into or out of it. */
function isAtxHeading(t: string, i: number, end: number): boolean {
  const start = skipLinePrefix(t, i, end);
  let k = start;
  while (k < end && t.charCodeAt(k) === CH_HASH) k++;
  const n = k - start;
  if (n < 1 || n > 6) return false;
  if (k === end) return true;
  const c = t.charCodeAt(k);
  return c === CH_SPACE || c === CH_TAB || c === CH_CR;
}

/** Whether the line `[i, end)` is a thematic break (`***`, `- - -`, `___`) or
 *  a setext heading underline (`===`, `---`): after optional `>` markers and
 *  leading whitespace, ≥3 of one of those characters (≥1 for `=`) with only
 *  spaces/tabs between them. Either way the paragraph ends after this line —
 *  whether the line closes a heading or stands alone doesn't matter here,
 *  since it carries no backticks or tags. */
function isRuleLine(t: string, i: number, end: number): boolean {
  const start = skipLinePrefix(t, i, end);
  if (start >= end) return false;
  const ch = t.charCodeAt(start);
  if (ch !== CH_STAR && ch !== CH_DASH && ch !== CH_UNDERSCORE && ch !== CH_EQUALS) return false;
  let count = 0;
  for (let k = start; k < end; k++) {
    const c = t.charCodeAt(k);
    if (c === ch) count++;
    else if (c === CH_SPACE || c === CH_TAB || c === CH_CR) {
      if (ch === CH_EQUALS && count > 0) return isBlankLine(t, k, end); // `===` allows trailing spaces only
    } else return false;
  }
  return count >= (ch === CH_EQUALS ? 1 : 3);
}

/** Whether the open tag starting at `idx` begins its line: only spaces/tabs
 *  between it and the previous newline, the text start or a segment start. */
function opensLine(t: string, idx: number, isSegStart: (k: number) => boolean): boolean {
  let k = idx;
  for (;;) {
    if (k === 0 || isSegStart(k)) return true;
    const c = t.charCodeAt(k - 1);
    if (c === CH_NEWLINE) return true;
    if (c !== CH_SPACE && c !== CH_TAB) return false;
    k--;
  }
}

/** Whether the open tag `o` is followed — after optional whitespace, line
 *  breaks included, and before `closeStart` — by a JSON object (`{`) or a
 *  code fence (three backticks or tildes): the shape of a real block's body,
 *  as opposed to a prose mention of the tag (`<handoff> block at the end`). */
function opensBody(t: string, o: OpenTag, closeStart: number): boolean {
  let k = o.openEnd;
  while (k < closeStart) {
    const c = t.charCodeAt(k);
    if (c !== CH_SPACE && c !== CH_TAB && c !== CH_CR && c !== CH_NEWLINE) break;
    k++;
  }
  if (k >= closeStart) return false;
  const c = t.charCodeAt(k);
  if (c === CH_LBRACE) return true;
  return (
    (c === CH_BACKTICK || c === CH_TILDE) &&
    k + 2 < closeStart &&
    t.charCodeAt(k + 1) === c &&
    t.charCodeAt(k + 2) === c
  );
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
 * A candidate open tag whose body is a prose mention doesn't jump to its
 * close: the scan keeps walking Markdown and decides when it reaches that
 * close (see `pend` below) — a close in prose makes the mention a block, a
 * close in a fence or inline span makes it none, and a body-shaped open met
 * in prose before the close takes over as the block's open.
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
 * from a fresh line walk at the close) with the fence state cleared — unless
 * the close sits inside a fence opened after the open tag, when the walk
 * resumes on the next line inside that fence (see `fenceAtClose`). A
 * paragraph also ends at an ATX heading line (a one-line paragraph of its own)
 * and after a thematic-break / setext-underline line, as CommonMark has it.
 *
 * When more open tags sit between the real open tag and its close, the block
 * starts at the LAST of them that begins its own line (the contract's shape —
 * `<handoff>` on its own line), if any. An earlier stray mention of the tag in
 * prose that escaped code (a malformed inline span) therefore no longer
 * swallows the real block. An open tag that doesn't begin a line — the inner
 * one of `<handoff><handoff>{…}`, or a mention inside a JSON string — moves
 * the start only when the open tag chosen so far is a prose mention (its body doesn't
 * start with `{` or a fence) and this one is the FIRST after it whose body
 * does and that doesn't follow a `"`: `Here: <handoff>{…}</handoff>` after a
 * stray mention. A block whose own open tag already starts a JSON body never
 * moves for a later mid-line tag, so a mention inside its JSON can't either.
 * Both rules consider only opens that end at or before the block's last `{`:
 * every candidate body ends at the same close, so a start past that brace can
 * only fail to parse, where an earlier start's brace-balanced fallback may
 * still succeed (`<handoff>\n{…}\n<handoff>\n</handoff>` keeps the first open).
 */
function scanCodeAware(
  t: string,
  lower: string,
  finder: TagFinder,
  starts: readonly number[],
  out: HandoffBlockSpan[],
  resume?: WindowResume,
): void {
  const n = t.length;
  const nextBacktick = createCharSearch(t, "`");
  let segStartSet: Set<number> | null = null;
  const isSegStart = (k: number): boolean => {
    if (starts.length <= 1) return k === 0;
    segStartSet ??= new Set(starts);
    return segStartSet.has(k);
  };
  // The block's open tag (see the doc above). Only opens that end at or before
  // the block's last `{` are candidates: every candidate body ends at the same
  // close, so a start past that brace leaves no JSON object to parse, while the
  // earlier start's brace-balanced fallback may still find one. The backward
  // brace scan is bounded by `[cand.openEnd, closeStart)`, opens strictly
  // between `cand` and that brace are visited once each (and the whitespace
  // after each one at most once — it can't run past the next tag), and the
  // scan resumes past the close, so this stays linear.
  // `seen`, when given, lists the only later opens that may be considered (the
  // prose opens a pending mention's walk met, ascending); otherwise every open
  // after `cand` counts — a body-shaped block's body is opaque.
  const anchorOpen = (cand: OpenTag, closeStart: number, seen?: readonly OpenTag[]): OpenTag => {
    let lastBrace = closeStart - 1;
    while (lastBrace >= cand.openEnd && t.charCodeAt(lastBrace) !== CH_LBRACE) lastBrace--;
    if (lastBrace < cand.openEnd) return cand; // no JSON anywhere — moving can't help
    let best = cand;
    let shapedAfterBest: OpenTag | null = null;
    const consider = (o: OpenTag): void => {
      if (opensLine(t, o.start, isSegStart)) {
        best = o;
        shapedAfterBest = null;
      } else if (shapedAfterBest === null && t.charCodeAt(o.start - 1) !== CH_QUOTE && opensBody(t, o, closeStart)) {
        shapedAfterBest = o;
      }
    };
    if (seen === undefined) {
      for (let o = finder.nextOpenTag(cand.openEnd); o !== null && o.openEnd <= lastBrace; ) {
        consider(o);
        o = finder.nextOpenTag(o.openEnd);
      }
    } else {
      for (const o of seen) {
        if (o.openEnd > lastBrace) break;
        consider(o);
      }
    }
    return shapedAfterBest !== null && !opensBody(t, best, closeStart) ? shapedAfterBest : best;
  };
  // Segment index of offset `k` (the last start at or before it).
  const segIndexOf = (k: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= k) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const segEndOf = (si: number): number => (si + 1 < starts.length ? starts[si + 1]! : n);
  // The fence a body-shaped block's close tag sits in, if any: the block's open
  // was found in prose at `from` (no fence open there), so walk the lines after
  // `from`'s line up to the one holding `closeStart` with the usual fence rules,
  // resetting at segment starts. A real block with a fenced body closes its
  // fence before the close tag; a close inside a still-open fence means the
  // fence started a code block the close belongs to — a prose mention ending a
  // line before a fenced example (`… opened by <handoff>` + a fence holding a
  // close tag), or a sloppy block whose fence never closed. Either way the
  // scan must resume inside that fence: resuming with a cleared fence state read
  // the fence's closing line as an opener and hid everything after it. Linear:
  // the first line search is bounded by `closeStart` (the block body), and each
  // later line is walked by at most one call, since the next call starts past
  // this close and only walks lines that begin after its own open's line.
  const fenceAtClose = (from: number, closeStart: number): { ch: number; len: number } | null => {
    let si = segIndexOf(from);
    let segEnd = segEndOf(si);
    const first = lineEndOf(t, from, Math.min(segEnd, closeStart));
    if (first >= closeStart) return null; // the close is on the open's own line
    let i = first < segEnd ? first + 1 : segEnd;
    let ch = 0;
    let len = 0;
    while (i <= closeStart) {
      if (i >= segEnd) {
        si++;
        if (si >= starts.length) break;
        i = starts[si]!;
        segEnd = segEndOf(si);
        ch = 0;
        continue;
      }
      const le = lineEndOf(t, i, segEnd);
      if (ch !== 0) {
        if (isFenceCloser(t, i, le, ch, len)) ch = 0;
      } else {
        const f = fenceOpener(t, i, le);
        if (f !== null) {
          ch = f.ch;
          len = f.len;
        }
      }
      i = le < segEnd ? le + 1 : segEnd;
    }
    return ch === 0 ? null : { ch, len };
  };
  // A prose mention (an open tag whose body doesn't start a JSON object or a
  // fence) waiting to see where its close tag lands. The scan keeps walking
  // Markdown past the mention instead of jumping to the close: a close found in
  // prose makes the mention a block (anchored as above), a close inside a fence
  // or an inline code span means the mention was only prose — no block, and the
  // code state that hid the close is the one the scan carries on with. Jumping
  // straight to the close and resuming there with a cleared fence state read a
  // fence's closing line as an opener and hid everything after it. A body-shaped
  // open met in prose before the close takes over at once: it is the block the
  // anchoring rules would pick, and its body is opaque as usual. `lastBrace` is
  // the pending pair's last `{` before the close (`-2` = not computed yet);
  // `seen` the further opens the walk met in prose before the close — the only
  // ones the block may be anchored at, since an open inside a fence or an inline
  // code span the walk skipped is code, not a start.
  let pend: {
    open: OpenTag;
    close: { start: number; end: number };
    lastBrace: number;
    seen: OpenTag[];
  } | null = null;
  const pendLastBrace = (pd: NonNullable<typeof pend>): number => {
    if (pd.lastBrace === -2) {
      let b = pd.close.start - 1;
      while (b >= pd.open.openEnd && t.charCodeAt(b) !== CH_LBRACE) b--;
      pd.lastBrace = b < pd.open.openEnd ? -1 : b;
    }
    return pd.lastBrace;
  };
  // Whether a prose open met while `pd` waits is the block's start per the
  // anchoring rules: body-shaped, before the pair's last `{`, and either
  // beginning its line or not following a `"`.
  const takesOver = (pd: NonNullable<typeof pend>, o: OpenTag): boolean =>
    o.openEnd <= pendLastBrace(pd) &&
    opensBody(t, o, pd.close.start) &&
    (opensLine(t, o.start, isSegStart) || t.charCodeAt(o.start - 1) !== CH_QUOTE);
  // The next thing the scan must look at, at or after `from`: an open tag or
  // the pending mention's close, whichever comes first (`-1`: neither remains).
  const nextEventAt = (from: number): number => {
    const o = finder.nextOpenTag(from);
    const c = pend === null ? -1 : pend.close.start;
    if (o === null) return c;
    return c !== -1 && c < o.start ? c : o.start;
  };
  // The scan starts at `resume.pos` (a line start) when the tail window cut a
  // fence open (see `fenceStateAtWindow`); otherwise at the window's start.
  let pos = resume?.pos ?? 0;
  let segIdx = 0;
  // A fence to resume in at `pos` (a line start in the same segment) — set when
  // a block's close tag sat inside a fence (see `fenceAtClose`), or seeded from
  // the text the tail window cut off.
  let carryCh = resume?.ch ?? 0;
  let carryLen = resume?.len ?? 0;

  outer: while (pos < n) {
    while (segIdx + 1 < starts.length && starts[segIdx + 1]! <= pos) segIdx++;
    const segStart = starts[segIdx]!;
    const segEnd = segIdx + 1 < starts.length ? starts[segIdx + 1]! : n;
    const initCh = carryCh;
    const initLen = carryLen;
    carryCh = 0;
    carryLen = 0;

    let ev = nextEventAt(pos);
    if (ev === -1) return; // no open tag anywhere after here, nothing pending
    if (ev >= segEnd) {
      pos = segEnd; // nothing in this segment can open or close a block
      continue;
    }

    let i = pos;
    let fenceCh = initCh;
    let fenceLen = initLen;
    while (i < segEnd) {
      const le = lineEndOf(t, i, segEnd);
      const next = le < segEnd ? le + 1 : segEnd;

      if (fenceCh !== 0) {
        if (pend !== null && pend.close.start < next) pend = null; // the mention's close is fenced code
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
          if (pend !== null && pend.close.start < next) pend = null; // close in the fence's info string
          fenceCh = f.ch;
          fenceLen = f.len;
          i = next;
          continue;
        }
      }

      // A paragraph starts at `i`: find where it ends. A heading or rule line
      // is a paragraph of its own; a heading interrupts the paragraph before
      // it, a rule / setext underline ends the paragraph after itself.
      let pEnd = next;
      if (!(atLineStart && (isAtxHeading(t, i, le) || isRuleLine(t, i, le)))) {
        while (pEnd < segEnd) {
          const e = lineEndOf(t, pEnd, segEnd);
          if (isBlankLine(t, pEnd, e) || fenceOpener(t, pEnd, e) !== null || isAtxHeading(t, pEnd, e)) break;
          const rule = isRuleLine(t, pEnd, e);
          pEnd = e < segEnd ? e + 1 : segEnd;
          if (rule) break;
        }
      }

      ev = nextEventAt(i);
      if (ev === -1) return;
      if (ev >= segEnd) {
        pos = segEnd;
        continue outer;
      }
      if (ev >= pEnd) {
        i = pEnd; // nothing to decide in this paragraph — no need for its code spans
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
        const pendClose = pend === null ? -1 : pend.close.start;
        const atClose = pendClose !== -1 && (cand === null || pendClose < cand.start);
        const at = atClose ? pendClose : cand === null ? -1 : cand.start;
        if (at === -1) return; // no open tag after here, nothing pending
        if (at >= pEnd) break;

        // Walk the runs before `at`; a span that reaches past it swallows it.
        let spanEnd = -1;
        while (k < rc && rp[k]! < at) {
          const m = nx[k]!;
          if (m === -1) {
            k++; // unmatched run — literal text
            continue;
          }
          const end = rp[m]! + rl[m]!;
          k = m + 1;
          if (at < end) {
            spanEnd = end;
            break;
          }
        }
        // A pending open with a `{` before its close is a block body in prose
        // form (`<handoff>\nNote: run `npm test\n{json}\n</handoff>`), not a
        // mention: an unbalanced backtick inside it may pair with one after the
        // close, but the span it makes is an artifact of reading the body as
        // Markdown, so the close counts as prose (legacy finds this block too).
        // A brace-less body stays a mention whose close is inline code. Trade-off:
        // a mention followed by a span that holds a `{` and the close
        // (`<handoff> … `{…}</handoff>``) now pairs; an open tag inside such a
        // span still is not a start.
        const closeIsProse = atClose && pend !== null && pendLastBrace(pend) !== -1;
        if (spanEnd !== -1 && !closeIsProse) {
          if (atClose) pend = null; // the mention's close is inline code — the mention was prose
          p = spanEnd;
          continue;
        }

        let open: OpenTag;
        let close: { start: number; end: number };
        if (pend !== null) {
          if (!atClose && !takesOver(pend, cand!)) {
            // Another mention before the close: part of the pending pair. Never
            // step past the close (an open tag's attributes may run over it).
            pend.seen.push(cand!);
            p = cand!.openEnd < pendClose ? cand!.openEnd : pendClose;
            continue;
          }
          // At the close the walk is in prose, so no fence can be open there; a
          // body-shaped open taking over is opaque from here on, like any block.
          open = atClose ? anchorOpen(pend.open, pendClose, pend.seen) : anchorOpen(cand!, pendClose);
          close = pend.close;
          pend = null;
        } else {
          const c = findCloseTag(lower, cand!.openEnd);
          if (c === null) return; // no close after this open → none can follow
          if (!opensBody(t, cand!, c.start)) {
            pend = { open: cand!, close: c, lastBrace: -2, seen: [] };
            p = cand!.openEnd < c.start ? cand!.openEnd : c.start;
            continue;
          }
          open = anchorOpen(cand!, c.start);
          close = c;
        }
        // A real block: its body is opaque, so scanning resumes after the close.
        out.push({ start: open.start, openEnd: open.openEnd, closeStart: close.start, end: close.end });
        const fence = atClose ? null : fenceAtClose(cand!.openEnd, close.start);
        if (fence !== null) {
          // The close sits inside a fence: resume on the line after it, still in
          // that fence (a fence closer must start its own line). The rest of the
          // close's line is the fence's content, or its info string.
          const cSegEnd = segEndOf(segIndexOf(close.start));
          if (close.end < cSegEnd) {
            const le = lineEndOf(t, close.end, cSegEnd);
            if (le + 1 < cSegEnd) {
              carryCh = fence.ch;
              carryLen = fence.len;
              pos = le + 1;
            } else pos = cSegEnd; // the fence runs to the segment's end
          } else pos = close.end; // the close tag itself crossed into a later segment
          continue outer;
        }
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

/** Where the code-aware scan starts when the tail window's cut lands inside a
 *  fenced code block: `pos` is the first line start (tail coordinates) at or
 *  after the cut that the fence state `ch`/`len` applies to. */
interface WindowResume {
  pos: number;
  ch: number;
  len: number;
}

/**
 * The fence state the tail window must start in. The window starts with a clean
 * Markdown state, but when its start sits inside a fenced block of the same
 * segment, the fence's closing line would read as an opener and hide the real
 * block after it. So this walks the cut-off text of that one segment — lines
 * only, fence open/close lines only, one pass — and reports the state in force
 * for the first line the window can read whole: `null` when nothing needs
 * seeding (the cut is at a segment start, or no fence is open around it), else
 * the carried fence and the line start (tail coordinates) to resume at.
 *
 * A cut that lands mid-line skips that partial line's remainder: it is a fence
 * line or fence content when a fence is open around it (never a place for a real
 * open tag), and its opener/closer status was decided on the whole line here.
 * Linear in the segment's text before the window; run once per call, only in
 * code-aware mode and only when the window cut anything off.
 */
function fenceStateAtWindow(text: string, segmentStarts: readonly number[] | undefined, base: number): WindowResume | null {
  let segStart = 0;
  let segEnd = text.length;
  if (segmentStarts !== undefined) {
    for (const s of segmentStarts) {
      if (s <= base) {
        if (s > segStart) segStart = s;
      } else if (s < segEnd) segEnd = s;
    }
  }
  let ch = 0;
  let len = 0;
  let i = segStart;
  while (i < base) {
    const le = lineEndOf(text, i, segEnd);
    const next = le < segEnd ? le + 1 : segEnd;
    const before = ch;
    if (ch !== 0) {
      if (isFenceCloser(text, i, le, ch, len)) ch = 0;
    } else {
      const f = fenceOpener(text, i, le);
      if (f !== null) {
        ch = f.ch;
        len = f.len;
      }
    }
    if (next > base) {
      // This line straddles the cut. A fence never outlives its segment.
      if (next >= segEnd) ch = 0;
      if (before === 0 && ch === 0) return null;
      return { pos: next - base, ch, len };
    }
    i = next;
  }
  // The cut is exactly at a line (or segment) start.
  return ch === 0 || i >= segEnd ? null : { pos: 0, ch, len };
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
 * handoff" take the last span. Code-aware mode only: an open tag whose body is
 * prose (not a `{` or a fence) is no block when that close lies in a fence or
 * an inline code span opened after it (and a close in prose anchors it only
 * at opens met in prose); a block whose close sits in a fence opened after
 * its open resumes the scan inside that fence; when further open tags
 * sit before that close, the span starts at the last one that begins its own
 * line, else at the first JSON-shaped mid-line one after a prose mention —
 * never at one past the block's last `{` (see `scanCodeAware`).
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
    const resume = base === 0 ? null : fenceStateAtWindow(text, opts?.segmentStarts, base);
    scanCodeAware(
      tail,
      lower,
      finder,
      tailSegmentStarts(opts?.segmentStarts, base, tail.length),
      out,
      resume ?? undefined,
    );
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

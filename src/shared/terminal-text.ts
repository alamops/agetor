/**
 * Text safety shared by the agetor bundle and every CLI/TUI surface that
 * prints stored or third-party text to a terminal: which control and
 * invisible characters are refused (and stripped on export), how they are
 * escaped for display, and surrogate-safe cutting. Pure — no I/O, and no
 * runtime imports from `src/bun` or `src/mainview`. `./bundle.ts`
 * re-exports the public helpers for its existing importers.
 */
import { LONE_SURROGATE_RE } from "./pipeline.ts";

/**
 * Terminal escape sequences, removed whole so a colored name exports as
 * "Rev", not as "Rev[31m":
 * - CSI `ESC [ params intermediates final` (SGR colors, cursor moves);
 * - OSC `ESC ] … BEL` / `ESC ] … ESC \` and the DCS/SOS/PM/APC strings
 *   `ESC P|X|^|_ … ESC \` — only with their terminator, and only within one
 *   line: an unterminated one (or one whose body would cross a line break)
 *   is not a sequence, so the text after it stays (only the ESC goes, with
 *   the other control characters). ECMA-48 allows a line break inside a
 *   string, but taking it would drop whole lines of a user's instructions,
 *   which is worse than a little `]0;title` residue;
 * - `ESC intermediates final` (`ESC ( B`), whose first intermediate isn't a
 *   space, and the parameterless forms `ESC 0-?` (`ESC 7`, `ESC =`) and
 *   `ESC c` — but not `ESC` + any letter, nor `ESC` + space + letter, so a
 *   stray ESC never eats the word after it (`ESC SP F` leaves " F").
 * Each string body stops at the next ESC or line break, so matching stays
 * linear.
 */
export const ANSI_ESCAPE_G =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b\n\r]*(?:\u0007|\u001b\\)|[PX^_][^\u001b\n\r]*\u001b\\|[!-/][ -/]*[0-~]|[0-?c])/g;
/** Control characters import refuses in a single-line field. */
const SINGLE_LINE_CONTROL_CHARS_G = /[\u0000-\u001f\u007f]/g;
/** Control characters import refuses in multi-line text (all but tab, LF, CR). */
const MULTILINE_CONTROL_CHARS_G = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Invisible characters import refuses. They render as nothing, so no preview
 * can show them: Unicode tag characters (U+E0000–E007F) can spell out a whole
 * hidden instruction a model still reads, variation selectors — a run after
 * one emoji, or one interleaved after every letter — can carry arbitrary
 * bytes, bidi overrides and isolates reorder what the reader sees, and a
 * zero-width character makes "Reviewer\u200b" look exactly like a local
 * "Reviewer".
 *
 * The refused set is every `Default_Ignorable_Code_Point` (which covers the
 * zero-width characters, the soft hyphen, word joiners and invisible
 * operators, the deprecated format characters U+206A–206F, bidi controls and
 * marks, the BOM, Hangul fillers, Mongolian and standard variation selectors,
 * the musical-symbol and shorthand format controls, and the whole
 * U+E0000–E0FFF tag and variation-selector-supplement block) plus C1
 * controls, interlinear annotations and — single-line only — the
 * line/paragraph separators. A few are allowed back, each only in the one
 * context real text needs it, right after a visible character (so never two
 * in a row) — which leaves no free position to hide bits in outside the
 * scripts that use them:
 * - U+FE0E/FE0F (text/emoji presentation) after an emoji, or after 0-9, #
 *   or * that a keycap U+20E3 follows;
 * - a Mongolian free variation selector (U+180B–180D, U+180F) after a
 *   Mongolian letter;
 * - ZWJ between an emoji (or its modifier or U+FE0F) and the emoji it joins;
 * - multi-line text (instructions, descriptions) only: ZWJ and ZWNJ between
 *   two letters or marks of a script that shapes with them (Arabic-family
 *   joining scripts and the Indic scripts — the Persian half-space, a
 *   half-form), and the combining grapheme joiner between a letter or mark
 *   and the combining mark it holds apart, plus the line/paragraph
 *   separators, which are visible line breaks.
 * The soft hyphen, the bidi marks LRM/RLM/ALM and the variation selectors
 * U+FE00–FE0D and U+E0100–E01EF are refused: a model reads the same text
 * without them, and one after any space, letter or ideograph would be a
 * channel (240 supplement selectors after each ideograph carry a byte a
 * character). Emoji subdivision flags (tag sequences), ideographic variation
 * sequences (a glyph variant of a CJK character) and the standardized
 * variation sequences of math symbols are the accepted casualties.
 */
const INVISIBLE_CANDIDATE_G =
  /[\p{Default_Ignorable_Code_Point}\u0080-\u009f\ufff9-\ufffb\u2028\u2029]/gu;
const ZWJ = 0x200d;
const ZWNJ = 0x200c;
const CGJ = 0x034f;
const PICTOGRAPH_RE = /^\p{Extended_Pictographic}$/u;
/** What a ZWJ in an emoji sequence follows: the emoji, its skin-tone
 *  modifier, or its U+FE0F (judged on its own). */
const EMOJI_BEFORE_ZWJ_RE = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\ufe0f]$/u;
const KEYCAP_BASE_RE = /^[0-9#*]$/;
const MONGOLIAN_LETTER_RE = /^(?=\p{L})\p{Script=Mongolian}$/u;
const LETTER_OR_MARK_RE = /^[\p{L}\p{M}]$/u;
const MARK_RE = /^\p{M}$/u;
/** Not visible: the variation selectors, CGJ and Mongolian selectors are
 *  combining marks and the Hangul fillers are letters, so every "letter",
 *  "mark" or "script" test below also requires a visible character. */
const IGNORABLE_OR_SPACE_RE = /^[\p{Default_Ignorable_Code_Point}\p{White_Space}\p{Cc}]$/u;
/** Letters and marks of the scripts that shape with ZWJ/ZWNJ (by script
 *  extension, so a shared virama or harakat counts). */
const JOINING_SCRIPT_RE =
  /^[\p{scx=Arabic}\p{scx=Syriac}\p{scx=Nko}\p{scx=Mongolian}\p{scx=Adlam}\p{scx=Hanifi_Rohingya}\p{scx=Devanagari}\p{scx=Bengali}\p{scx=Gurmukhi}\p{scx=Gujarati}\p{scx=Oriya}\p{scx=Tamil}\p{scx=Telugu}\p{scx=Kannada}\p{scx=Malayalam}\p{scx=Sinhala}\p{scx=Myanmar}\p{scx=Khmer}\p{scx=Tibetan}]$/u;

/** The code point that ends just before UTF-16 offset `index`, or "". */
function charBefore(value: string, index: number): string {
  if (index <= 0) return "";
  const lo = value.charCodeAt(index - 1);
  if (index >= 2 && lo >= 0xdc00 && lo <= 0xdfff) {
    const hi = value.charCodeAt(index - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return value.slice(index - 2, index);
  }
  return value.slice(index - 1, index);
}

/** The code point that starts at UTF-16 offset `index`, or "". */
function charAt(value: string, index: number): string {
  const cp = value.codePointAt(index);
  return cp === undefined ? "" : String.fromCodePoint(cp);
}

const visible = (ch: string): boolean => ch !== "" && !IGNORABLE_OR_SPACE_RE.test(ch);

/** ZWJ/ZWNJ between two visible letters or marks of a joining script. */
function inJoiningScript(before: string, after: string): boolean {
  return (
    visible(before) &&
    visible(after) &&
    LETTER_OR_MARK_RE.test(before) &&
    LETTER_OR_MARK_RE.test(after) &&
    JOINING_SCRIPT_RE.test(before) &&
    JOINING_SCRIPT_RE.test(after)
  );
}

/** Whether the candidate `ch` found at `index` in `value` is refused. */
function isRefusedInvisible(ch: string, value: string, index: number, multiline: boolean): boolean {
  const cp = ch.codePointAt(0)!;
  if (cp === 0x2028 || cp === 0x2029) return !multiline;
  const before = charBefore(value, index);
  if (!before) return true;
  const after = charAt(value, index + ch.length);
  if (cp === 0xfe0e || cp === 0xfe0f) {
    return !(PICTOGRAPH_RE.test(before) || (KEYCAP_BASE_RE.test(before) && after === "\u20e3"));
  }
  if ((cp >= 0x180b && cp <= 0x180d) || cp === 0x180f) return !MONGOLIAN_LETTER_RE.test(before);
  if (cp === ZWJ) {
    if (EMOJI_BEFORE_ZWJ_RE.test(before) && PICTOGRAPH_RE.test(after)) return false;
    return !(multiline && inJoiningScript(before, after));
  }
  if (cp === ZWNJ) return !(multiline && inJoiningScript(before, after));
  if (cp === CGJ) {
    return !(multiline && visible(before) && visible(after) && LETTER_OR_MARK_RE.test(before) && MARK_RE.test(after));
  }
  return true;
}

/** "U+200B" for a single character (a code point, astral ones included). */
function codePointLabel(ch: string): string {
  return `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * The first invisible character import refuses in `value`, as "U+200B", or
 * null. `multiline` picks the rule for multi-line text over the stricter
 * single-line one. The planner uses it for names the user types.
 */
export function findInvisibleChar(value: string, multiline = false): string | null {
  for (const m of value.matchAll(INVISIBLE_CANDIDATE_G)) {
    if (isRefusedInvisible(m[0], value, m.index!, multiline)) return codePointLabel(m[0]);
  }
  return null;
}

/** `value` without the invisible characters import refuses. A character is
 *  judged against the text it sits in, so of a run of variation selectors
 *  only the first one survives; removing one can leave its neighbour out of
 *  context (a ZWJ after a refused U+FE0F), so it repeats until nothing more
 *  goes — each pass only removes, so it ends. */
export function stripInvisible(value: string, multiline: boolean): string {
  let current = value;
  for (;;) {
    const text = current;
    const next = text.replace(INVISIBLE_CANDIDATE_G, (ch: string, index: number) =>
      isRefusedInvisible(ch, text, index, multiline) ? "" : ch,
    );
    if (next === text) return next;
    current = next;
  }
}

/** `value` without lone surrogates, escape sequences, the control
 *  characters and the invisible characters import refuses. A lone surrogate
 *  reaches a stored value through a JSON column or route (`"\ud800"`), and
 *  the parser refuses it in every field. */
export function stripControls(value: string, multiline: boolean): string {
  return stripInvisible(
    value
      .replace(LONE_SURROGATE_G, "")
      .replace(ANSI_ESCAPE_G, "")
      .replace(multiline ? MULTILINE_CONTROL_CHARS_G : SINGLE_LINE_CONTROL_CHARS_G, ""),
    multiline,
  );
}

/** At most `max` UTF-16 code units, never ending on half a surrogate pair. */
export function cutTo(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Candidates for escaping in an error message: C0 controls, DEL, and every
 *  invisible-character candidate (judged by the single-line rule). */
const UNSAFE_MESSAGE_CANDIDATE_G =
  /[\u0000-\u001f\u007f\p{Default_Ignorable_Code_Point}\u0080-\u009f\ufff9-\ufffb\u2028\u2029\u{d800}-\u{dfff}]/gu;

// An unpaired UTF-16 surrogate (defined beside the graph validator, which
// refuses one in ids and Agent references): the parser refuses it in every
// text field, and export removes it.
export const LONE_SURROGATE_G = new RegExp(LONE_SURROGATE_RE.source, "g");

/**
 * `text` with every control character, bidi override and invisible
 * character the field refuses written as a visible `\uXXXX` (or
 * `\u{XXXXX}`) escape. Parser errors quote file text, and `agetor import`
 * prints them to a terminal: a raw ESC there would be a terminal escape
 * sequence the file author controls, and an invisible character would hide
 * what the text says. `multiline` judges invisible characters by the rule
 * for multi-line text (instructions), which keeps the joiners Arabic-family
 * and Indic scripts need; control characters are escaped either way, so a
 * caller printing multi-line text splits it into lines first.
 */
export function escapeControlChars(text: string, multiline = false): string {
  return text.replace(UNSAFE_MESSAGE_CANDIDATE_G, (ch: string, index: number) => {
    const cp = ch.codePointAt(0)!;
    const loneSurrogate = cp >= 0xd800 && cp <= 0xdfff;
    if (cp > 0x1f && cp !== 0x7f && !loneSurrogate && !isRefusedInvisible(ch, text, index, multiline)) return ch;
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, "0")}`;
  });
}

/** Free text a person typed (a task title, a pipeline block message, an
 *  error) for ONE terminal line: line breaks and tabs folded to a space, then
 *  escaped under the multi-line rule, so the ZWNJ/ZWJ a Persian or Hindi
 *  title needs prints as text rather than `\u200c`. Identifiers (Agent and
 *  Pipeline names, step names, harness ids) keep the strict single-line rule
 *  of plain `escapeControlChars`. */
export function escapeFreeText(text: string): string {
  return escapeControlChars(text.replace(/[\t\n\r\u0085\u2028\u2029]+/g, " "), true);
}

/** `escapeControlChars(text)` in at most `max` characters, ending in `…` when
 *  cut. The RAW text is cut, never the escaped form, so a `\uXXXX` escape is
 *  never split in half: a binary search finds the longest raw prefix whose
 *  escaped form fits in `max - 1` (escaping only ever lengthens text, so a
 *  prefix longer than `max - 1` never fits). */
export function escapeCapped(text: string, max: number): string {
  const escaped = escapeControlChars(text);
  if (escaped.length <= max) return escaped;
  const budget = max - 1;
  let lo = 0;
  let hi = Math.min(text.length, budget);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (escapeControlChars(cutTo(text, mid)).length <= budget) lo = mid;
    else hi = mid - 1;
  }
  return `${escapeControlChars(cutTo(text, lo))}…`;
}

/** `text` cut to at most `max` UTF-16 code units for display, ending in `…`
 *  when cut. Never ends on half a surrogate pair (an emoji at the cut is
 *  dropped whole, not left as a lone surrogate that escapes to `\ud83d`),
 *  and drops the invisible characters the cut leaves trailing (a ZWJ whose
 *  emoji, or a ZWNJ whose next letter, was cut off), which would otherwise
 *  print as `\u200d` beside the ellipsis. Cut first, escape after: callers
 *  pass the result to `escapeFreeText`/`escapeControlChars`. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = cutTo(text, Math.max(0, max - 1)).replace(TRAILING_INVISIBLE_G, "");
  return `${cut}…`;
}
const TRAILING_INVISIBLE_G = /\p{Default_Ignorable_Code_Point}+$/u;

/**
 * Plain-text preview of a task prompt for the board card.
 *
 * A prompt is often a pasted spec: a heading, a table, a code block, then the
 * actual ask. Showing the first two raw lines gave `# Spec — X | Field | Value`
 * on the card. This keeps the first prose paragraph instead, with markdown
 * syntax stripped. It is a rendering-only transform: the stored prompt stays
 * raw, and the result is plain text (React escapes it; it never becomes HTML).
 *
 * Rules, in order:
 *  1. Drop front matter (a leading `---` … `---` block).
 *  2. Drop code fences (a run of three or more ` or ~, through the closing
 *     fence: the same character, a run at least as long, nothing after it; an
 *     unclosed fence drops the rest), HTML comments, headings, horizontal
 *     rules and tables (`|`-led lines).
 *  3. Split what is left on blank lines; the first block is the paragraph.
 *     List items count as prose with their markers stripped.
 *  4. Strip inline syntax (emphasis, inline code, links → text, images → alt,
 *     `>` quote markers), collapse whitespace, cap at `maxChars`.
 *  5. If no prose block exists, fall back to the whole prompt with the same
 *     syntax stripped; if that is empty too, return `""` (the card omits the
 *     line).
 */
export function promptPreview(prompt: string, maxChars = 280): string {
  const text = prompt.replace(/\r\n?/g, "\n");
  if (text.trim() === "") return "";

  const withoutComments = dropHtmlComments(text);
  const lines = dropFrontMatter(withoutComments.split("\n"));

  const prose = firstProseBlock(lines);
  if (prose) return cap(stripBounded(prose, maxChars), maxChars);

  // Nothing but headings, tables and fences: show what the prompt does say.
  const fallback = withoutFences(lines)
    .filter((l) => !isRule(l))
    .map(stripLinePrefix)
    .map((l) => l.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/^\s*\|/, "").replace(/\|\s*$/, "").replace(/\s*\|\s*/g, " "))
    .join(" ");
  return cap(stripBounded(fallback, maxChars), maxChars);
}

/** `stripInline` on a prefix of `s`. The emphasis pattern is quadratic on a
 *  long unbroken paragraph (a 400 KB paste took 17 s), and only the first
 *  `maxChars` of the result are shown. Inline syntax only shrinks text, so a
 *  prefix of 8x the cap nearly always leaves enough; when it does not (a
 *  paragraph of long links), the prefix grows until it does or `s` is whole.
 *  The cut never lands inside a link, image or code span (`closeOpenSpan`),
 *  or the half-cut syntax would show up raw. */
function stripBounded(s: string, maxChars: number): string {
  let limit = Math.max(maxChars, 1) * 8;
  for (;;) {
    const end = s.length <= limit ? s.length : closeOpenSpan(s, limit);
    const part = end === s.length ? s : s.slice(0, end);
    const out = stripInline(part);
    if (part.length === s.length || out.length > maxChars) return out;
    limit *= 4;
  }
}

/** How far past the cut to look for the end of a span the cut fell inside. A
 *  presigned URL is a few KB; past this the span is not worth the work (and
 *  stripInline is quadratic), so the cut stays where it was. */
const SPAN_LOOKAHEAD = 8192;

/** `end`, moved forward to the close of the link, image or code span that `end`
 *  falls inside: the `)` of `[text](url)` or the closing backtick run. Each
 *  step either finds its closer within `SPAN_LOOKAHEAD` or leaves `end` alone. */
function closeOpenSpan(s: string, end: number): number {
  const reach = (from: number, needle: string, width: number): number => {
    const at = s.indexOf(needle, from);
    return at === -1 || at - end > SPAN_LOOKAHEAD ? end : at + width;
  };
  // Link text open (`[text` cut before its `]`), then the destination.
  for (let i = 0; i < 4; i++) {
    const head = s.slice(0, end);
    const open = head.lastIndexOf("[");
    if (open > head.lastIndexOf("]")) {
      const next = reach(end, "]", 1);
      if (next === end) break;
      end = next;
      continue;
    }
    // Destination open: `](` with no `)` after it, or the cut just after `]`
    // with `(` next.
    const dest = head.lastIndexOf("](");
    const destOpen = dest !== -1 && head.indexOf(")", dest) === -1;
    if (destOpen || (head.endsWith("]") && s[end] === "(")) {
      const next = reach(end, ")", 1);
      if (next === end) break;
      end = next;
      continue;
    }
    break;
  }
  // An odd run count of backticks means a code span is open.
  const ticks = (s.slice(0, end).match(/`+/g) ?? []).length;
  if (ticks % 2 === 1) {
    const close = s.indexOf("`", end);
    if (close !== -1 && close - end <= SPAN_LOOKAHEAD) {
      let stop = close;
      while (s[stop] === "`") stop++;
      end = stop;
    }
  }
  return end;
}

/** Each complete `<!-- … -->` becomes a newline; an opener with no closer
 *  leaves the rest as it is. One forward scan: a lazy regex retried from every
 *  opener is quadratic on a paste full of unclosed `<!--`. */
function dropHtmlComments(text: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = text.indexOf("<!--", from);
    if (open === -1) break;
    const close = text.indexOf("-->", open + 4);
    // No closer after this opener means none after any later one either.
    if (close === -1) break;
    out += text.slice(from, open) + "\n";
    from = close + 3;
  }
  return out + text.slice(from);
}

/** A fence opener's marker character and run length (``` or ~~~, three or
 *  more), or null. */
function fenceOpen(line: string): { ch: string; len: number } | null {
  const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
  return m ? { ch: m[1]![0]!, len: m[1]!.length } : null;
}

/** A closing fence: the opener's character, a run at least as long, and
 *  nothing but whitespace after it. */
function closesFence(line: string, fence: { ch: string; len: number }): boolean {
  const m = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return !!m && m[1]![0] === fence.ch && m[1]!.length >= fence.len;
}

function dropFrontMatter(lines: string[]): string[] {
  if (lines[0]?.trim() !== "---") return lines;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") return lines.slice(i + 1);
  }
  return lines;
}

/** Lines outside code fences; an unclosed fence swallows the rest. */
function withoutFences(lines: string[]): string[] {
  const out: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  for (const line of lines) {
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const open = fenceOpen(line);
    if (open) fence = open;
    else out.push(line);
  }
  return out;
}

const isRule = (l: string) => /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l);
const isHeading = (l: string) => /^\s{0,3}#{1,6}(\s|$)/.test(l);
const isTableLine = (l: string) => /^\s*\|/.test(l) || /^\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(l);

function firstProseBlock(lines: string[]): string {
  let fence: { ch: string; len: number } | null = null;
  let block: string[] = [];
  for (const line of lines) {
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const open = fenceOpen(line);
    if (open) {
      if (block.length > 0) break;
      fence = open;
      continue;
    }
    if (line.trim() === "") {
      if (block.length > 0) break;
      continue;
    }
    if (isHeading(line) || isRule(line) || isTableLine(line)) {
      if (block.length > 0) break;
      continue;
    }
    block.push(stripLinePrefix(line));
  }
  return block.join(" ");
}

/** Quote and list markers belong to a line's start, so strip them per line
 *  (a hyphen inside a sentence must survive). */
function stripLinePrefix(line: string): string {
  return line.replace(/^\s*(?:>\s?)+/, "").replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
}

function stripInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])([*_])(\S(?:.*?\S)?)\2(?=$|[\s).,;:!?])/g, "$1$3")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function cap(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  let end = Math.max(0, maxChars - 1);
  // Never split a surrogate pair: half an emoji renders as U+FFFD.
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${s.slice(0, end).trimEnd()}…`;
}

// Turn a text selection from the run panel's messages list into a markdown
// blockquote appended to the composer. Pure formatting/join logic only — no
// React, no DOM — mirroring the split that `diff-selection.ts` uses for the
// diff-compose feature: selection/DOM handling stays in the component,
// string arithmetic lives here where it can be unit tested directly.

/** Normalize `selected` (CRLF -> LF, strip leading/trailing blank lines) and
 *  prefix every remaining line with `"> "` (a bare `">"` for an empty inner
 *  line, so the blockquote doesn't gain trailing whitespace per line).
 *  Whitespace-only or empty input returns `""` — callers use that as the
 *  "nothing to quote" signal instead of a separate boolean. */
export function formatQuote(selected: string): string {
  const normalized = selected.replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return "";

  const lines = normalized.split("\n");
  // Strip leading/trailing blank lines (selections often pick up a stray
  // newline at either edge from the containing block elements) without
  // touching blank lines *inside* the selection.
  let start = 0;
  let end = lines.length - 1;
  while (start <= end && lines[start]!.trim() === "") start++;
  while (end >= start && lines[end]!.trim() === "") end--;

  return lines
    .slice(start, end + 1)
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");
}

/** Append `quoted` (already formatted by `formatQuote`) to the composer's
 *  `existing` text, one blank line below any existing content, with a
 *  trailing blank line after the quote — and report where the caret should
 *  land.
 *
 *  The trailing blank line is deliberate, not cosmetic: markdown's lazy
 *  continuation rule means a line typed immediately after a blockquote (no
 *  blank line between) is treated as part of that blockquote. Landing the
 *  caret right after the quote text would silently swallow whatever the user
 *  types next into the quoted block. The blank line both visually separates
 *  the quote and gives the caret a paragraph of its own, outside the quote,
 *  to type into.
 *
 *  `quoted === ""` (nothing survived `formatQuote`, e.g. a whitespace-only
 *  selection) is a no-op: `existing` is returned unchanged with the caret at
 *  its end. */
export function appendQuote(existing: string, quoted: string): { text: string; caret: number } {
  if (!quoted) return { text: existing, caret: existing.length };

  const trimmed = existing.replace(/\s+$/, "");
  const text = trimmed ? `${trimmed}\n\n${quoted}\n\n` : `${quoted}\n\n`;
  return { text, caret: text.length };
}

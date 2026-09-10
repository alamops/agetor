// Pure text/URL splitter shared by the webview's `renderLinkified`
// (`src/mainview/lib/linkify.tsx`) and its unit tests — no React import here
// so bun-side code (and a jsdom-free test runner) can exercise the splitting
// logic directly. This is deliberately NOT a markdown-link parser: the
// surfaces that use it (fx recovery notices, plain transcript `status`
// lines) are always plain text, never markdown, so the only job here is
// finding bare `http(s)://` runs and handing back a clean split.

export interface LinkSegment {
  type: "text" | "link";
  value: string;
}

/** Characters a URL run is scanned over: everything except whitespace and
 *  the delimiters most likely to actually be surrounding punctuation rather
 *  than part of the URL itself (`<>"'` and a backtick, in case this text
 *  ever ends up inside a code-ish context). */
const URL_SCAN_RE = /https?:\/\/[^\s<>"'`]+/g;

/** Trailing characters stripped off a matched URL unconditionally — common
 *  sentence punctuation that's almost never intentionally part of a URL. */
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?"]);

/** Closing bracket → its opener, for the "unmatched closer" trim rule
 *  below. */
const CLOSER_TO_OPENER: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

/**
 * Trim trailing punctuation off a matched URL, one character at a time from
 * the end: `.,;:!?` are always stripped, and a trailing `)]}` is stripped
 * only when it's "unmatched" — i.e. the URL text before it doesn't contain
 * more of the matching opener than it does of that closer (so
 * `.../wiki/Foo_(bar)` keeps its balanced `)`, but a `)` that merely closes
 * surrounding prose like `(see https://x.com)` gets moved back to text).
 * Stops at the first character that's neither, which is always reachable
 * since the match always begins with the `https?://` scheme itself.
 */
function trimTrailingPunctuation(url: string): { url: string; trailing: string } {
  let end = url.length;
  for (;;) {
    if (end === 0) break;
    const ch = url[end - 1]!;
    if (TRAILING_PUNCTUATION.has(ch)) {
      end -= 1;
      continue;
    }
    const opener = CLOSER_TO_OPENER[ch];
    if (opener) {
      const prefix = url.slice(0, end - 1);
      if (countChar(prefix, opener) > countChar(prefix, ch)) break; // matched — keep it
      end -= 1;
      continue;
    }
    break;
  }
  return { url: url.slice(0, end), trailing: url.slice(end) };
}

function mergeAdjacentText(segments: LinkSegment[]): LinkSegment[] {
  const out: LinkSegment[] = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    if (prev && prev.type === "text" && seg.type === "text") {
      prev.value += seg.value;
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

/**
 * Split `text` into alternating `text`/`link` segments on bare
 * `https?://` runs. A run of non-whitespace, non-`<>"'\`` characters counts
 * as a candidate URL; trailing sentence punctuation and an unmatched
 * closing bracket are trimmed back into the following text segment (see
 * {@link trimTrailingPunctuation}), and adjacent `text` segments are merged
 * into one. Returns `[]` for `""`, and `[{type: "text", value: text}]`
 * (the input unchanged, as a single segment) when no URL is found — so a
 * caller that special-cases "no link" can fall back to rendering `text`
 * verbatim.
 */
export function splitLinks(text: string): LinkSegment[] {
  if (text.length === 0) return [];

  const segments: LinkSegment[] = [];
  let pos = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(URL_SCAN_RE);
  while ((match = re.exec(text)) !== null) {
    const raw = match[0];
    const { url } = trimTrailingPunctuation(raw);
    const start = match.index;
    if (start > pos) segments.push({ type: "text", value: text.slice(pos, start) });
    segments.push({ type: "link", value: url });
    pos = start + url.length; // any trimmed trailing chars fall through into the next text segment
  }
  if (pos < text.length) segments.push({ type: "text", value: text.slice(pos) });

  return mergeAdjacentText(segments);
}

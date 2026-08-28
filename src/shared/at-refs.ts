// Shared by both processes — must stay free of runtime imports from either
// side (same rule refs.ts documents). This is the single source of truth for
// the `@`-token grammar used to reference files/folders inline in a prompt:
// the webview uses `findAtTokens`/`findActiveAtQuery` to highlight tokens in
// the composer and drive the reference-picker popover, and the Bun server
// uses `findAtTokens`/`expandAtTokens` at send-time to resolve each token
// against the task's workdir before the prompt reaches the agent. Keeping
// the grammar in one pure module is what keeps "what counts as a token" from
// drifting between the two.
//
// Grammar, in brief (see the two forms below):
//   - Quoted:  @"path with spaces.md"   — anything but `"`/newline inside.
//   - Bare:    @src/bun/db.ts           — a run of non-whitespace, then
//              trailing sentence punctuation/closers are stripped off (but
//              a trailing `/`, the directory marker, is always kept).
// Both forms require the leading `@` to be at the start of the text or
// immediately preceded by whitespace — the same guard `SlashAutocomplete
// .tsx`'s `findActiveQuery` uses for `/` — so `user@host` and `a@b` never
// match. Tokens never span a line; a bare `\r` counts as whitespace so CRLF
// input behaves like LF.

/** A recognized `@`-token in some text. `raw` is exactly `text.slice(start,
 *  end)` — including the leading `@` and, for a quoted token, both quotes —
 *  so callers can splice it back out (or use it as a stable key) without
 *  recomputing the span. */
export interface AtToken {
  start: number;
  end: number;
  raw: string;
  path: string;
  quoted: boolean;
  isDirectory: boolean;
}

/** Bare/quoted paths longer than this are ignored entirely (not a token) —
 *  a defensive cap against a pathological line of non-whitespace text. */
export const AT_TOKEN_MAX_LEN = 4096;

/** Hard cap on how many paths the server's `listProjectFiles` (`GET
 *  /files/index`) will return for a single scope, and the number the
 *  client-side `@` popover footer reports when a listing was truncated at
 *  it. Defined here (rather than in `src/bun/project-files.ts` or a
 *  mainview-only module) so both processes — and `at-file-filter.ts`'s
 *  perf test, which sizes its synthetic fixture off it — read the same
 *  constant instead of two numbers that could drift apart. */
export const MAX_PROJECT_FILES = 20_000;

const WHITESPACE_RE = /\s/;

/** Trailing chars stripped off the end of a *bare* token's raw run, one at a
 *  time, until none remain — sentence punctuation and closing brackets that
 *  are almost always prose, not part of the path. A trailing `/` is never in
 *  this set, so a directory reference always survives untouched. */
const TRAILING_STRIP_CHARS = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", ">", "'", '"']);

function isWhitespaceChar(ch: string | undefined): boolean {
  return ch !== undefined && WHITESPACE_RE.test(ch);
}

/** True when position `i` in `text` is a valid `@`-trigger position: start
 *  of the text, or immediately preceded by whitespace. */
function hasTriggerGuard(text: string, i: number): boolean {
  return i === 0 || isWhitespaceChar(text[i - 1]);
}

/**
 * Scan `text` left to right for non-overlapping `@`-tokens. Returns them in
 * order of appearance. A candidate `@` that doesn't resolve to a valid token
 * (bad guard, unterminated quote, empty/oversized path) is simply skipped —
 * scanning resumes right after it, so a later `@` on the same line can still
 * match.
 */
export function findAtTokens(text: string): AtToken[] {
  const tokens: AtToken[] = [];
  const len = text.length;
  let i = 0;

  while (i < len) {
    const ch = text[i];
    if (ch !== "@") {
      i++;
      continue;
    }
    if (!hasTriggerGuard(text, i)) {
      i++;
      continue;
    }

    if (text[i + 1] === '"') {
      // Quoted form: scan for a closing `"` before any newline.
      let j = i + 2;
      let closing = -1;
      while (j < len) {
        const c = text[j];
        if (c === "\n" || c === "\r") break;
        if (c === '"') {
          closing = j;
          break;
        }
        j++;
      }
      if (closing === -1) {
        i++;
        continue;
      }
      const path = text.slice(i + 2, closing);
      if (path.length === 0 || path.length > AT_TOKEN_MAX_LEN) {
        i++;
        continue;
      }
      tokens.push({
        start: i,
        end: closing + 1,
        raw: text.slice(i, closing + 1),
        path,
        quoted: true,
        isDirectory: path.endsWith("/"),
      });
      i = closing + 1;
      continue;
    }

    // Bare form: a run of non-whitespace, then strip trailing punctuation.
    let j = i + 1;
    while (j < len && !isWhitespaceChar(text[j])) j++;
    let pathEnd = j;
    while (pathEnd > i + 1 && TRAILING_STRIP_CHARS.has(text[pathEnd - 1]!)) {
      pathEnd--;
    }
    const path = text.slice(i + 1, pathEnd);
    if (path.length === 0 || path.length > AT_TOKEN_MAX_LEN) {
      i++;
      continue;
    }
    tokens.push({
      start: i,
      end: pathEnd,
      raw: text.slice(i, pathEnd),
      path,
      quoted: false,
      isDirectory: path.endsWith("/"),
    });
    i = pathEnd;
  }

  return tokens;
}

/** Render a path back into `@`-token text so that, for any path not
 *  containing a `"`, `findAtTokens(formatAtToken(p))[0]?.path === p` — i.e.
 *  it round-trips through the grammar above. Quoting is required whenever a
 *  *bare* token would parse back to something other than `path`:
 *    - `path` contains whitespace — a bare token's run stops at the first
 *      whitespace char, so anything after it would be lost.
 *    - `path` ends in one of `TRAILING_STRIP_CHARS` (`. , ; : ! ? ) ] } > '`)
 *      — a bare token strips those off the end, so e.g. `README.md.` would
 *      come back as `README.md`.
 *  A path containing a `"` is the one case this function cannot represent
 *  faithfully either way: quoting it would just relocate the problem, since
 *  the quoted form's own scanner stops at the first unescaped `"` (there is
 *  no escape syntax), splitting the path early on re-parse. Bare form is
 *  emitted instead — still lossy, but at least doesn't silently misparse a
 *  `"` as the token's closing quote. */
export function formatAtToken(path: string): string {
  if (path.includes('"')) return `@${path}`;
  const lastChar = path.charAt(path.length - 1);
  const needsQuoting = WHITESPACE_RE.test(path) || TRAILING_STRIP_CHARS.has(lastChar);
  return needsQuoting ? `@"${path}"` : `@${path}`;
}

/**
 * The popover-trigger query: walk back from `caret` to the nearest `@` that
 * satisfies the trigger guard, and return the in-progress query text after
 * it (not yet a complete token — that's what makes this "active"). Returns
 * null when there's no such `@`, when the nearest one fails the guard, or
 * when the caret has moved past a token that's already finished (a closing
 * `"` for the quoted form, or whitespace for the bare form).
 */
export function findActiveAtQuery(
  text: string,
  caret: number,
): { start: number; end: number; query: string; quoted: boolean } | null {
  if (caret <= 0) return null;

  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === "@") {
      if (!hasTriggerGuard(text, i)) return null;

      if (text[i + 1] === '"') {
        const inner = text.slice(i + 2, caret);
        if (/[\n\r"]/.test(inner)) return null;
        return { start: i, end: caret, query: inner, quoted: true };
      }

      const query = text.slice(i + 1, caret);
      if (WHITESPACE_RE.test(query)) return null;
      return { start: i, end: caret, query, quoted: false };
    }
    if (ch === "\n" || ch === "\r") return null;
    i--;
  }
  return null;
}

/**
 * Expand every `@`-token in `text` via `resolve(path, isDirectory)`. A
 * non-null return replaces the token's `raw` text in place; a null return
 * leaves that token untouched (e.g. an unresolvable path — the user still
 * sees what they typed). Processes right to left so earlier tokens' indices
 * stay valid as later replacements change the string's length. Text with no
 * `@` at all is returned as the same string instance (fast path).
 */
export function expandAtTokens(
  text: string,
  resolve: (path: string, isDirectory: boolean) => string | null,
): string {
  if (!text.includes("@")) return text;

  const tokens = findAtTokens(text);
  let result = text;
  for (let k = tokens.length - 1; k >= 0; k--) {
    const token = tokens[k]!;
    const replacement = resolve(token.path, token.isDirectory);
    if (replacement === null) continue;
    result = result.slice(0, token.start) + replacement + result.slice(token.end);
  }
  return result;
}

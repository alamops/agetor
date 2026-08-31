// Pure segmenting logic for `AtHighlightBackdrop` — turns a textarea's raw
// value into alternating plain/marked runs so the DOM layer can render
// `<mark>` boxes behind the native text without doing any of the token
// grammar or validity-decision work itself. Kept DOM-free (no React here) so
// it's unit-testable in isolation, mirroring at-file-filter.ts in spirit.

import { findAtTokens, type AtToken } from "../../shared/at-refs.ts";

/** One run of `text`, in order — concatenating every segment's `text`
 *  reconstructs the original string exactly (no segment trims, transforms,
 *  or drops any character). `mark: true` means this run is a validated
 *  `@`-token and should render as a highlight box; `mark: false` covers
 *  everything else, including an `@`-shaped token that failed validation
 *  (a typo, a non-existent path, an `@name` extension mention). */
export interface HighlightSegment {
  text: string;
  mark: boolean;
}

/**
 * Splits `text` into `HighlightSegment`s for the backdrop to render: every
 * `@`-token `findAtTokens` recognizes is checked via `isValid(path,
 * isDirectory)`; a `true` result becomes its own marked segment (holding the
 * token's full `raw` text — leading `@`, quotes if any), a `false` result
 * folds back into plain text. Gaps between tokens, and any token that failed
 * validation, are merged into a single plain segment when they're adjacent —
 * callers never see two consecutive `mark: false` segments. Empty input
 * returns `[]`.
 */
export function computeAtHighlights(
  text: string,
  isValid: (path: string, isDirectory: boolean) => boolean,
): HighlightSegment[] {
  if (text.length === 0) return [];

  const segments: HighlightSegment[] = [];

  const pushPlain = (slice: string) => {
    if (slice.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && !last.mark) {
      last.text += slice;
    } else {
      segments.push({ text: slice, mark: false });
    }
  };

  let cursor = 0;
  for (const token of findAtTokens(text)) {
    if (token.start > cursor) pushPlain(text.slice(cursor, token.start));
    if (isValid(token.path, token.isDirectory)) {
      segments.push({ text: token.raw, mark: true });
    } else {
      pushPlain(token.raw);
    }
    cursor = token.end;
  }
  if (cursor < text.length) pushPlain(text.slice(cursor));

  return segments;
}

/**
 * Whether `path` counts as "listed" for highlight purposes: an exact hit in
 * `validPaths`, or — when the token itself wasn't typed as a directory (no
 * trailing "/") — the same path with a trailing "/" appended. This is what
 * lets a hand-typed `@src/bun` highlight when `src/bun/` is a listed
 * directory (every directory entry `buildFileEntries` produces carries the
 * trailing slash, but a user typing a token by hand has no reason to know
 * that). A token already typed *with* a trailing slash (`isDirectory:
 * true`) must match `validPaths` on its own — appending a second slash would
 * never hit.
 */
export function isListedPath(validPaths: Set<string>, path: string, isDirectory: boolean): boolean {
  return validPaths.has(path) || (!isDirectory && validPaths.has(`${path}/`));
}

/** Tokens in `text` that do NOT pass {@link isListedPath} against
 *  `validPaths` — the candidate set for the composer's "won't resolve"
 *  warning. This helper only knows the listing oracle; the caller layers its
 *  own exemptions on top (known `@name` extension mentions, the live-scope
 *  on-disk stat check for gitignored-but-present files). */
export function unresolvedAtTokens(text: string, validPaths: Set<string>): AtToken[] {
  if (!text.includes("@")) return [];
  return findAtTokens(text).filter((t) => !isListedPath(validPaths, t.path, t.isDirectory));
}

/** Client-side mirror of the server's `isSafeRelPath` (worktree.ts): a
 *  repo-relative path that is non-empty, not absolute, NUL-free, and never
 *  escapes upward. Used to decide which unlisted tokens are even worth the
 *  live-scope `/refs/resolve` stat check — a token the server-side
 *  `resolveAtPath` would reject anyway (`@../x`, `@/abs`) must keep its
 *  warning rather than being "rescued" by a stat of a file outside the
 *  project. */
export function isSafeClientRelPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\0")) return false;
  return !path.split("/").some((seg) => seg === "..");
}

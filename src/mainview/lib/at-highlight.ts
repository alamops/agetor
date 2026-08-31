// Pure segmenting logic for `AtHighlightBackdrop` — turns a textarea's raw
// value into alternating plain/marked runs so the DOM layer can render
// `<mark>` boxes behind the native text without doing any of the token
// grammar or validity-decision work itself. Kept DOM-free (no React here) so
// it's unit-testable in isolation, mirroring at-file-filter.ts in spirit.

import { findAtTokens } from "../../shared/at-refs.ts";

// `isListedPath` and `unresolvedAtTokens` live in the shared module now (the
// CLI needs them too) — re-exported here so this module's existing consumers
// (PromptComposer.tsx, at-highlight.test.ts) keep working unchanged.
export { isListedPath, unresolvedAtTokens } from "../../shared/at-refs.ts";

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

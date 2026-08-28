// Turns a project's flat file listing into `@`-autocomplete popover entries
// and fuzzy-filters them as the user types. Pure and DOM-free by design (no
// React here) so the matching/ranking logic can be unit-tested in isolation
// from the popover component that renders it — mirrors prompt-picker.ts and
// diff-selection.ts in spirit.

/** One row the `@` popover can render. Directories carry a trailing "/" on
 *  `path` (e.g. "src/", "src/bun/") so callers can distinguish "src/" (the
 *  directory) from a same-named file without a separate lookup. */
export interface FileEntry {
  path: string;
  isDirectory: boolean;
}

/** Char-code (not locale) comparison — deterministic across environments and
 *  what makes a directory's path sort immediately before its own contents:
 *  "src/" is a strict prefix of "src/bun.ts", and a prefix always sorts
 *  before any string it's a prefix of under plain lexicographic order. */
function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `files` as given (isDirectory: false) plus one entry per distinct
 *  directory prefix implied by those files (isDirectory: true, trailing
 *  "/"), sorted by path. A file whose own path happens to equal another
 *  file's directory prefix (e.g. a file literally named "src/bun" alongside
 *  "src/bun/db.ts") is kept as-is; the two coexist as distinct entries. */
export function buildFileEntries(files: string[]): FileEntry[] {
  const filePaths = new Set(files);
  const dirPaths = new Set<string>();
  for (const file of files) {
    const segments = file.split("/");
    segments.pop(); // last segment is the file's own basename, not a directory
    let prefix = "";
    for (const segment of segments) {
      prefix += `${segment}/`;
      dirPaths.add(prefix);
    }
  }

  const entries: FileEntry[] = [
    ...[...filePaths].map((path) => ({ path, isDirectory: false })),
    ...[...dirPaths].map((path) => ({ path, isDirectory: true })),
  ];
  entries.sort((a, b) => comparePaths(a.path, b.path));
  return entries;
}

/** A successful fuzzy match: `score` for ranking (higher is better) and
 *  `indices` — the positions in `path` (original string, original case)
 *  that matched a query character, in ascending order, for a caller to bold
 *  in the rendered row. */
export interface FuzzyMatch {
  score: number;
  indices: number[];
}

const BOUNDARY_CHARS = new Set(["/", ".", "-", "_"]);

/** Whether `path[index]` immediately follows a "word boundary" — a path
 *  separator/punctuation char, or a lowercase→uppercase camelCase transition
 *  — so a match landing there can earn the boundary bonus. Uses the
 *  *original* (not lowercased) string since camelCase detection needs real
 *  case. */
function isBoundary(path: string, index: number): boolean {
  if (index <= 0) return false;
  const prev = path.charAt(index - 1);
  if (BOUNDARY_CHARS.has(prev)) return true;
  const curr = path.charAt(index);
  return prev >= "a" && prev <= "z" && curr >= "A" && curr <= "Z";
}

/** Cheap O(path.length) existence check, used to bail out of the full DP
 *  scorer immediately for the (common, at 20k+ entries) case where `query`
 *  isn't a subsequence of `path` at all. Both strings are expected
 *  pre-lowercased. */
function isSubsequence(query: string, path: string): boolean {
  let qi = 0;
  for (let pi = 0; pi < path.length && qi < query.length; pi++) {
    if (path.charAt(pi) === query.charAt(qi)) qi++;
  }
  return qi === query.length;
}

const START_BONUS = 20;
const BOUNDARY_BONUS = 12;
const CONSECUTIVE_BONUS = 15;
const GAP_PENALTY = 3;
const BASE_CHAR_SCORE = 1;

/** Case-insensitive fuzzy subsequence match of `query` against `path`, in
 *  the spirit of the scoring `command-score` (vendored by cmdk) uses —
 *  hand-rolled here since the repo has no fuzzy-match dependency. Returns
 *  `null` when `query` isn't a subsequence of `path` (every query char must
 *  appear, in order, case-insensitively); otherwise the *highest-scoring*
 *  alignment via a small dynamic program over (query index, path index),
 *  not just the leftmost/greedy one.
 *
 *  Scoring: +1 per matched char, +20 for a match at path[0], +12 for a
 *  match right after a "/", ".", "-", "_" or a lowercase→uppercase camel
 *  boundary, +15 for two matches in a row, and -3 per skipped char between
 *  two matches (including before the first match). Shorter paths are NOT
 *  preferred here — that tie-break belongs to callers ranking multiple
 *  matches (see filterFileEntries). */
export function fuzzyPathMatch(query: string, path: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, indices: [] };
  if (query.length > path.length) return null;

  const lowerQuery = query.toLowerCase();
  const lowerPath = path.toLowerCase();
  if (!isSubsequence(lowerQuery, lowerPath)) return null;

  const n = lowerQuery.length;
  const m = lowerPath.length;
  const NEG = Number.NEGATIVE_INFINITY;

  const dp: Float64Array[] = [];
  const parent: Int32Array[] = [];
  for (let i = 0; i < n; i++) {
    dp.push(new Float64Array(m).fill(NEG));
    parent.push(new Int32Array(m).fill(-2)); // -2 = unreachable, -1 = virtual root (row 0's predecessor)
  }

  function charBonus(j: number): number {
    if (j === 0) return BASE_CHAR_SCORE + START_BONUS;
    if (isBoundary(path, j)) return BASE_CHAR_SCORE + BOUNDARY_BONUS;
    return BASE_CHAR_SCORE;
  }

  // Row 0: only predecessor is the virtual root at index -1, so every
  // unmatched leading char is a "gap" of size j.
  const dpRow0 = dp[0]!;
  const parentRow0 = parent[0]!;
  for (let j = 0; j < m; j++) {
    if (lowerPath.charAt(j) !== lowerQuery.charAt(0)) continue;
    dpRow0[j] = charBonus(j) - GAP_PENALTY * j;
    parentRow0[j] = -1;
  }

  for (let i = 1; i < n; i++) {
    const prevDp = dp[i - 1]!;
    const curDp = dp[i]!;
    const curParent = parent[i]!;
    const qc = lowerQuery.charAt(i);

    // Running max of (prevDp[j'] + GAP_PENALTY * j') over j' <= j - 2 — the
    // "non-adjacent predecessor" candidates, folded incrementally so the
    // whole row stays O(m) instead of O(m^2). j' = j - 1 (consecutive) is
    // handled separately below since it scores differently (a bonus, not a
    // gap-proportional penalty).
    let maxAdjusted = NEG;
    let maxAdjustedIdx = -1;

    for (let j = 0; j < m; j++) {
      if (j >= 2) {
        const cand = j - 2;
        const val = prevDp[cand]!;
        if (val !== NEG) {
          const adjusted = val + GAP_PENALTY * cand;
          if (adjusted > maxAdjusted) {
            maxAdjusted = adjusted;
            maxAdjustedIdx = cand;
          }
        }
      }

      if (lowerPath.charAt(j) !== qc) continue;

      let best = NEG;
      let bestParent = -2;

      if (j >= 1 && prevDp[j - 1] !== NEG) {
        const candidate = prevDp[j - 1]! + CONSECUTIVE_BONUS;
        if (candidate > best) {
          best = candidate;
          bestParent = j - 1;
        }
      }
      if (maxAdjusted !== NEG) {
        const candidate = maxAdjusted + GAP_PENALTY - GAP_PENALTY * j;
        if (candidate > best) {
          best = candidate;
          bestParent = maxAdjustedIdx;
        }
      }

      if (best === NEG) continue; // no valid predecessor reaches this cell
      curDp[j] = best + charBonus(j);
      curParent[j] = bestParent;
    }
  }

  const lastRow = dp[n - 1]!;
  let bestJ = -1;
  let bestScore = NEG;
  for (let j = 0; j < m; j++) {
    const s = lastRow[j]!;
    if (s !== NEG && s > bestScore) {
      bestScore = s;
      bestJ = j;
    }
  }
  if (bestJ === -1) return null; // unreachable given the isSubsequence pre-check, but keep it safe

  const indices: number[] = [];
  let curI = n - 1;
  let curJ = bestJ;
  for (;;) {
    indices.push(curJ);
    if (curI === 0) break;
    curJ = parent[curI]![curJ]!;
    curI -= 1;
  }
  indices.reverse();

  return { score: bestScore, indices };
}

/** Number of ancestor directories an entry sits under — a directory's own
 *  trailing "/" is stripped before counting, so "src/" (depth 0) ties with
 *  a root file like "readme.md" (depth 0) rather than reading as "one level
 *  deeper" than it. */
function depthOf(entry: FileEntry): number {
  const p = entry.isDirectory ? entry.path.slice(0, -1) : entry.path;
  if (p.length === 0) return 0;
  return p.split("/").length - 1;
}

/** Listing order for a set of entries with no active query: shallowest
 *  first, directories before files at the same depth, otherwise stable
 *  (preserves the input's relative order — which for a buildFileEntries
 *  output is already alphabetical with directories immediately preceding
 *  their contents). */
function sortListingOrder(entries: FileEntry[]): FileEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const depthDiff = depthOf(a.entry) - depthOf(b.entry);
      if (depthDiff !== 0) return depthDiff;
      if (a.entry.isDirectory !== b.entry.isDirectory) return a.entry.isDirectory ? -1 : 1;
      return a.index - b.index;
    })
    .map((x) => x.entry);
}

/** Whether `path` is a direct child of the directory `dirQuery` names
 *  (`dirQuery` must end in "/"): starts with `dirQuery`, isn't `dirQuery`
 *  itself, and has no further "/" once `dirQuery` and (for a subdirectory
 *  entry) its own trailing "/" are stripped off. */
function isDirectChild(dirQuery: string, path: string): boolean {
  if (path === dirQuery || !path.startsWith(dirQuery)) return false;
  const remainder = path.slice(dirQuery.length);
  const stripped = remainder.endsWith("/") ? remainder.slice(0, -1) : remainder;
  return stripped.length > 0 && !stripped.includes("/");
}

function rankByFuzzy(entries: FileEntry[], query: string): FileEntry[] {
  const scored: { entry: FileEntry; match: FuzzyMatch }[] = [];
  for (const entry of entries) {
    const match = fuzzyPathMatch(query, entry.path);
    if (match) scored.push({ entry, match });
  }
  scored.sort((a, b) => {
    if (b.match.score !== a.match.score) return b.match.score - a.match.score;
    if (a.entry.path.length !== b.entry.path.length) return a.entry.path.length - b.entry.path.length;
    return comparePaths(a.entry.path, b.entry.path);
  });
  return scored.map((x) => x.entry);
}

/** Filters + ranks `entries` for the `@` popover.
 *
 *  - Blank query (after trim): `sortListingOrder` capped at `limit` — no
 *    fuzzy scoring involved.
 *  - Query ending in "/" (the shape `descendInto` produces after Tab on a
 *    directory row): that directory's direct children first (in listing
 *    order), then everything else ranked by fuzzy score against the full
 *    query — which naturally surfaces deeper descendants, since the query
 *    is a literal consecutive prefix of their paths.
 *  - Otherwise: every entry ranked by `fuzzyPathMatch`, non-matches
 *    dropped, ties broken by shorter path then by path string. */
export function filterFileEntries(entries: FileEntry[], query: string, limit = 50): FileEntry[] {
  const trimmed = query.trim();

  if (trimmed === "") {
    return sortListingOrder(entries).slice(0, limit);
  }

  if (trimmed.endsWith("/")) {
    const rest = entries.filter((e) => e.path !== trimmed);
    const directChildren = rest.filter((e) => isDirectChild(trimmed, e.path));
    const deeper = rest.filter((e) => !isDirectChild(trimmed, e.path));
    return [...sortListingOrder(directChildren), ...rankByFuzzy(deeper, trimmed)].slice(0, limit);
  }

  return rankByFuzzy(entries, trimmed).slice(0, limit);
}

/** What Tab on a directory row turns the query into: `dirPath` with every
 *  trailing "/" collapsed to exactly one, so descending twice (or into a
 *  path that already ends in "/") doesn't pile up slashes. */
export function descendInto(dirPath: string): string {
  return `${dirPath.replace(/\/+$/, "")}/`;
}

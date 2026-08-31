// Turns a project's flat file listing into `@`-autocomplete popover entries
// and fuzzy-filters them as the user types. Pure and DOM-free by design (no
// React here) so the matching/ranking logic can be unit-tested in isolation
// from the popover component that renders it — mirrors prompt-picker.ts and
// diff-selection.ts in spirit.
//
// ── Two-stage ranking (why `filterFileEntries` isn't just "score everything
// with the exact matcher") ──────────────────────────────────────────────────
// `fuzzyPathMatch`'s dynamic program is O(query.length × path.length) and
// allocates two typed arrays per call. Run over every entry in a large repo
// (`MAX_PROJECT_FILES` = 20,000, see at-refs.ts) on every keystroke, that
// scorer alone cost 20–43ms — most of it spent exact-ranking thousands of
// entries the user will never scroll to. `rankByFuzzy` instead runs three
// passes, each an order of magnitude cheaper than the last:
//   1. `isSubsequence` — cheap O(path.length) reject, no allocation. Throws
//      out entries that couldn't possibly match at all (the overwhelming
//      majority once a query has a couple of characters).
//   2. `greedyPathScore` — the same start/boundary/consecutive/gap bonus
//      scheme as `fuzzyPathMatch`, but a single greedy left-to-right pass
//      (no allocation, no backtracking) instead of the full DP. Not
//      optimal — it can't trade off a later boundary bonus against an
//      earlier gap the way the DP can — but it's a good-enough proxy for
//      "is this entry in the ballpark", which is all a pre-filter needs.
//      `TopCandidates` keeps only the top `TOP_N_FOR_EXACT_RANKING` (300) by
//      this score — a partial selection, not a full sort of the listing.
//   3. `fuzzyPathMatch` — the exact DP, run only on those ≤300 finalists,
//      producing the real score and `indices` used for final ordering and
//      for bolding matched characters in the popover row.
// Below the 300-candidate threshold (true for every fixture in this file's
// non-performance tests) stage 2 keeps every survivor, so the exact DP still
// ranks the whole candidate set and the output is identical to a naive
// single-stage implementation — the approximation only kicks in at the
// scale where per-keystroke exactness across the whole listing was already
// too slow to matter.

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

// Module-level scratch buffers for `fuzzyPathMatch`'s DP, grown on demand
// and reused across calls instead of allocating two typed arrays (a
// Float64Array + an Int32Array per query-length row) every time. Safe under
// JS's single-threaded, non-reentrant execution model — nothing here awaits
// or otherwise yields mid-computation, so no two calls ever interleave their
// use of these buffers. Rows only ever grow, never shrink, so a later call
// with a shorter query/path than a previous one just uses a prefix of an
// already-sized buffer.
let dpScratchRows: Float64Array[] = [];
let parentScratchRows: Int32Array[] = [];

/** Ensure the scratch pool has at least `rows` rows, each at least `cols`
 *  wide, reallocating only the rows that are missing or too small. */
function ensureScratchCapacity(rows: number, cols: number): void {
  for (let i = 0; i < rows; i++) {
    if (i >= dpScratchRows.length) {
      dpScratchRows.push(new Float64Array(cols));
      parentScratchRows.push(new Int32Array(cols));
      continue;
    }
    if (dpScratchRows[i]!.length < cols) {
      dpScratchRows[i] = new Float64Array(cols);
      parentScratchRows[i] = new Int32Array(cols);
    }
  }
}

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

  // -2 = unreachable, -1 = virtual root (row 0's predecessor). Scratch rows
  // may be wider than `m` (left over from a larger previous call) — every
  // fill/read below is explicitly bounded to `[0, m)`, so leftover data past
  // `m` in a reused row is never touched.
  ensureScratchCapacity(n, m);
  const dp = dpScratchRows;
  const parent = parentScratchRows;

  function charBonus(j: number): number {
    if (j === 0) return BASE_CHAR_SCORE + START_BONUS;
    if (isBoundary(path, j)) return BASE_CHAR_SCORE + BOUNDARY_BONUS;
    return BASE_CHAR_SCORE;
  }

  // Row 0: only predecessor is the virtual root at index -1, so every
  // unmatched leading char is a "gap" of size j.
  const dpRow0 = dp[0]!;
  dpRow0.fill(NEG, 0, m);
  const parentRow0 = parent[0]!;
  parentRow0.fill(-2, 0, m);
  for (let j = 0; j < m; j++) {
    if (lowerPath.charAt(j) !== lowerQuery.charAt(0)) continue;
    dpRow0[j] = charBonus(j) - GAP_PENALTY * j;
    parentRow0[j] = -1;
  }

  for (let i = 1; i < n; i++) {
    const prevDp = dp[i - 1]!;
    const curDp = dp[i]!;
    curDp.fill(NEG, 0, m);
    const curParent = parent[i]!;
    curParent.fill(-2, 0, m);
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

  // `indices` are positions computed against `lowerPath` but are meant to be
  // read as positions in `path` (the original, real-case string a caller
  // bolds characters in). That's safe as long as the two strings are the
  // same length — true for virtually all input — but `toLowerCase()` can
  // change a string's length for a handful of Unicode code points (e.g.
  // U+0130 LATIN CAPITAL LETTER I WITH DOT ABOVE lowercases to two UTF-16
  // code units). When lengths differ, indices computed on `lowerPath` no
  // longer line up with `path` and would highlight the wrong character (or
  // one past the end). Rather than attempt a codepoint-aware realignment for
  // this rare case, drop the indices — the match itself (and its score) is
  // still correct and returned.
  if (lowerPath.length !== path.length) {
    return { score: bestScore, indices: [] };
  }

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

/** How many greedy-scored survivors get promoted to the exact DP stage — see
 *  the "Two-stage ranking" note at the top of this file. */
const TOP_N_FOR_EXACT_RANKING = 300;

/** A cheap, non-optimal proxy for `fuzzyPathMatch`'s score: one greedy,
 *  leftmost left-to-right pass (no backtracking, no allocation) using the
 *  same start/boundary/consecutive/gap bonus scheme (see `fuzzyPathMatch`'s
 *  doc comment) — `gap` there is generalized to "chars since the previous
 *  match (or since the start)", which collapses to the same formula whether
 *  or not there's been a previous match yet. Assumes `lowerQuery` is already
 *  known to be a subsequence of `lowerPath` (callers check `isSubsequence`
 *  first), so every query char is guaranteed to find a match and the loop
 *  never has to signal "no match".
 *
 *  This is deliberately *not* the exact score: by always taking the first
 *  available occurrence of each query char, it can undervalue a path where
 *  waiting for a later occurrence would score higher (e.g. trading a small
 *  gap now for a boundary bonus a few characters on) — precisely the
 *  tradeoff `fuzzyPathMatch`'s DP searches for. It only needs to be a
 *  reasonable proxy for "is this entry in the ballpark", since it's used
 *  solely to pick which survivors get promoted to the exact stage. */
function greedyPathScore(lowerQuery: string, lowerPath: string, path: string): number {
  const n = lowerQuery.length;
  const m = lowerPath.length;
  let score = 0;
  let qi = 0;
  let lastMatchIndex = -1; // -1 = no match yet (the DP's "virtual root")
  for (let pi = 0; pi < m && qi < n; pi++) {
    if (lowerPath.charCodeAt(pi) !== lowerQuery.charCodeAt(qi)) continue;
    const gap = pi - lastMatchIndex - 1;
    let bonus = BASE_CHAR_SCORE;
    if (pi === 0) bonus += START_BONUS;
    else if (isBoundary(path, pi)) bonus += BOUNDARY_BONUS;
    if (gap === 0 && lastMatchIndex !== -1) bonus += CONSECUTIVE_BONUS;
    score += bonus - GAP_PENALTY * gap;
    lastMatchIndex = pi;
    qi++;
  }
  return score;
}

/** Keeps the top `cap` `consider()`-ed items ranked by score, without ever
 *  holding more than `cap` at once — a partial selection, not a full sort of
 *  everything that's been considered. Internally ascending (index 0 is the
 *  weakest kept item), so admitting a new candidate once full is a single
 *  comparison against the current floor, and evicting it is an O(cap)
 *  bubble-into-place. That's the right tradeoff at `cap =
 *  TOP_N_FOR_EXACT_RANKING`: O(entries × cap) total instead of O(entries log
 *  entries) to fully sort a listing whose vast majority will be discarded
 *  anyway. */
class TopCandidates<T> {
  private readonly items: { value: T; score: number }[] = [];
  constructor(private readonly cap: number) {}

  consider(value: T, score: number): void {
    if (this.items.length < this.cap) {
      let i = this.items.length;
      this.items.push({ value, score });
      while (i > 0 && this.items[i - 1]!.score > score) {
        this.items[i] = this.items[i - 1]!;
        i--;
      }
      this.items[i] = { value, score };
      return;
    }
    if (score <= this.items[0]!.score) return; // wouldn't displace the weakest kept item
    let i = 0;
    while (i + 1 < this.items.length && this.items[i + 1]!.score < score) {
      this.items[i] = this.items[i + 1]!;
      i++;
    }
    this.items[i] = { value, score };
  }

  values(): T[] {
    return this.items.map((x) => x.value);
  }
}

function rankByFuzzy(entries: FileEntry[], query: string): FileEntry[] {
  const lowerQuery = query.toLowerCase();

  // Stage 1 + 2: cheap reject, then cheap greedy score, keeping only the top
  // TOP_N_FOR_EXACT_RANKING survivors. Below that cap this is a no-op filter
  // — every survivor is kept — so the exact stage below still ranks the
  // whole candidate set and output matches a naive single-stage
  // implementation exactly.
  const finalists = new TopCandidates<FileEntry>(TOP_N_FOR_EXACT_RANKING);
  for (const entry of entries) {
    if (lowerQuery.length > entry.path.length) continue;
    const lowerPath = entry.path.toLowerCase();
    if (!isSubsequence(lowerQuery, lowerPath)) continue;
    finalists.consider(entry, greedyPathScore(lowerQuery, lowerPath, entry.path));
  }

  // Stage 3: exact DP, only over the ≤300 finalists.
  const scored: { entry: FileEntry; match: FuzzyMatch }[] = [];
  for (const entry of finalists.values()) {
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

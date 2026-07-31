import type { GitHubPullMergeability, GitProvider } from "../../shared/types.ts";

/** Result of successfully parsing a PR/MR URL: which forge it came from and
 *  the item's number. */
export interface ParsedPrUrl {
  provider: GitProvider;
  number: number;
}

/**
 * Path-shape patterns that identify a pull/merge request URL per provider.
 * Matched against `URL.pathname` only — query string and fragment are already
 * stripped by `URL`, and a trailing path segment after the number (or nothing
 * at all) is allowed. Hostname is deliberately not checked: self-hosted
 * GitLab/Bitbucket/GitHub Enterprise instances use the same path shapes on
 * arbitrary domains.
 */
const PR_URL_PATTERNS: { provider: GitProvider; re: RegExp }[] = [
  // GitLab first — its path contains "merge_requests", which never collides
  // with the other two providers' patterns, but checking it before the
  // narrower "pull"/"pull-requests" patterns keeps intent obvious.
  { provider: "gitlab", re: /\/-\/merge_requests\/(\d+)(?:[/?#]|$)/ },
  { provider: "bitbucket", re: /\/pull-requests\/(\d+)(?:[/?#]|$)/ },
  { provider: "github", re: /\/pull\/(\d+)(?:[/?#]|$)/ },
];

/**
 * Detect which git forge a PR/MR html URL belongs to and extract its number,
 * by matching the URL's *path shape* rather than its hostname (self-hosted
 * instances exist on arbitrary domains). Returns null for an unparseable
 * URL, a URL that doesn't match any known PR/MR path shape, or a matched
 * number that isn't a positive integer.
 */
export function parsePrUrl(url: string | null | undefined): ParsedPrUrl | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  for (const { provider, re } of PR_URL_PATTERNS) {
    const match = re.exec(parsed.pathname);
    if (!match) continue;
    const number = Number(match[1]);
    if (!Number.isInteger(number) || number <= 0) return null;
    return { provider, number };
  }
  return null;
}

/**
 * Whether the "Resolve Conflicts" button should be offered: the task's
 * `prUrl` parsed to a recognized PR/MR, its mergeability was fetched, and
 * that mergeability describes an open, same-repo PR that's actually
 * conflicted (`mergeableState === "dirty"`), with non-empty head/base refs.
 * Mirrors the "Resolve with Agetor" gating already applied to `crossRepo` in
 * `ResolveConflictsDialog`. The `state === "open"` check guards against a
 * stale/closed PR still reporting a conflicted `mergeableState`; the ref
 * checks guard against building a resolve-conflicts prompt from an empty
 * `origin/` ref (a malformed or partially-normalized mergeability payload).
 */
export function canOfferResolveConflicts(
  parsed: ReturnType<typeof parsePrUrl>,
  m: GitHubPullMergeability | null,
): boolean {
  return parsed != null && m != null && m.mergeableState === "dirty" && !m.merged && !m.crossRepo
    && m.state === "open" && m.headRef !== "" && m.baseRef !== "";
}

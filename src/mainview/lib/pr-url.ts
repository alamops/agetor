/**
 * Parses the pull/merge-request number out of a provider web URL. Lets the
 * "View PR" affordance in RunPanel decide whether it can open the in-app
 * detail subpage (needs a number to fetch by) or must fall back to the
 * plain external link. Pure — no React, no network — kept DOM-free like its
 * sibling `commit-push.ts` so it's unit-testable on its own.
 *
 * Supports the URL shape each provider uses for a single PR/MR:
 *   - GitHub:    .../pull/<n>
 *   - GitLab:    .../merge_requests/<n>      (optionally nested under /-/)
 *   - Bitbucket: .../pull-requests/<n>
 *
 * Tolerates a trailing slash, query string, fragment, and extra tail
 * segments (e.g. GitHub's ".../pull/12/files"). Returns null — never
 * throws — for anything else, including a malformed URL.
 */
export function parsePullNumber(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Only web URLs qualify — a non-http(s) scheme must keep taking the
  // ExternalLink branch, where its whitelist applies.
  if (!/^https?:$/.test(parsed.protocol)) return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  const markers = new Set(["pull", "merge_requests", "pull-requests"]);
  for (let i = 0; i < segments.length - 1; i++) {
    const marker = segments[i];
    const next = segments[i + 1];
    if (marker === undefined || next === undefined || !markers.has(marker)) continue;
    // Canonical decimal only — Number() would also admit "1e3"/"0x10"/"12.0".
    if (!/^\d+$/.test(next)) continue;
    const n = Number(next);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

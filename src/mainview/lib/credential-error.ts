import { GIT_HOST_TOKENS_SECTION } from "../../shared/types.ts";

/**
 * Detects whether a git-provider error string is a credential error — i.e.
 * one of the enriched hints built server-side by `bitbucketAccessHint` /
 * `bitbucketViewerAccessHint` (src/bun/bitbucket.ts), `privateRepoHint`
 * (src/bun/github.ts), or `authHint` (src/bun/gitlab.ts). All three append
 * the same marker phrase, `Settings → ${GIT_HOST_TOKENS_SECTION}`, so
 * matching it here (rather than a status code we don't have at this layer)
 * is what lets `GitHubDialog` swap the bare error row for an actionable
 * explainer panel while every other list-load failure keeps the plain row.
 * `null` (no error) is not a credential error. This is a heuristic, not a
 * structured signal — a false negative just degrades to the plain error row.
 */
export function isCredentialError(error: string | null): boolean {
  return !!error && error.includes(`Settings → ${GIT_HOST_TOKENS_SECTION}`);
}

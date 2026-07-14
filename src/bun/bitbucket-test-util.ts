// Test-only helpers for exercising `src/bun/bitbucket.ts` (TT3).
//
// Unlike github.ts, every bitbucket.ts function takes an already-resolved
// `ProviderRepoInfo` directly (the facade resolves it once via
// `providerRepoForDir` before dispatching) — this module does no local git
// work of its own, so there's no throwaway-repo builder to write here, unlike
// github-test-util.ts's `makeGitHubRepo`. `makeBitbucketRepo` below just
// constructs that plain object.
//
// The fetch-mock harness itself (`mockGitHubFetch`) is host-agnostic — it
// stubs `globalThis.fetch` against an ordered route table keyed on
// method + URL substring/regex, with no GitHub-specific assumptions baked in
// — so it's reused as-is rather than forked.
import type { GitProvider, ProviderRepoInfo } from "../shared/types.ts";

export { mockGitHubFetch } from "./github-test-util.ts";
export type { MockRoute, FetchMock, FetchCall } from "./github-test-util.ts";

/**
 * A resolved Bitbucket Cloud repo, matching the shape `providerRepoForDir`
 * would produce for `git@bitbucket.org:acme/app.git` (or an ssh-alias host
 * like `git@bitbucket-work.com:acme/app.git`, when `remoteHost` is overridden
 * to something other than the canonical `bitbucket.org`). `host` is always
 * the canonical API host `bitbucket.org` — that's what `repoBasePath`/
 * `fetchBitbucket` resolve against; `remoteHost` is the raw pre-
 * canonicalization host, which is what `bitbucketCreds` keys credential
 * lookup on.
 */
export function makeBitbucketRepo(
  owner = "acme",
  name = "app",
  remoteHost = "bitbucket.org",
): ProviderRepoInfo {
  const provider: GitProvider = "bitbucket";
  return {
    provider,
    host: "bitbucket.org",
    remoteHost,
    owner,
    name,
  };
}

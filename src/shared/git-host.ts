// The one rule that maps a git remote's host to its provider's canonical cloud
// host. Shared so the Bun side (`parseGitRemote`, `providerRepoForDir`) and the
// webview (`linkMatchesRepo` in `src/mainview/lib/pr-link.ts`) cannot drift:
// `GET /github/provider-info` reports the canonical host, while a PR link an
// agent writes carries the real one (a self-hosted GitLab, an ssh alias).

/** Map a remote's host to its canonical provider host. Users pin per-identity
 *  SSH keys via `~/.ssh/config` host aliases (`github-work.com`, `bitbucket-x.org`,
 *  …), and self-hosted forges live at hosts like `gitlab.corp.example`, so the
 *  host in a remote or link is often not the provider's real hostname. Any host
 *  containing the provider's name resolves to that provider. */
export function canonicalGitHost(host: string): string {
  const lower = host.toLowerCase();
  if (lower.includes("github")) return "github.com";
  if (lower.includes("gitlab")) return "gitlab.com";
  if (lower.includes("bitbucket")) return "bitbucket.org";
  return lower;
}

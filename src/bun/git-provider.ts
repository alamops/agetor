import { existsSync } from "node:fs";
import type { GitProvider, ProviderRepoInfo } from "../shared/types.ts";
import { canonicalGitHost, parseGitRemote, run } from "./github.ts";
import { tokenForHost } from "./github-tokens.ts";

/**
 * Multi-provider git-forge detection + auth resolution
 * (docs/plans/multi-provider-git-modal.md, docs/plans/github-multi-identity-tokens.md).
 *
 * This module is the provider-agnostic counterpart to `repoForDir`/`githubToken`
 * in `github.ts`: it resolves *which* provider (GitHub/GitLab/Bitbucket) a
 * project directory's git remote points at, and how to authenticate against
 * it, without hard-gating to `github.com` the way `parseGitHubRemote` does.
 *
 * Raw-host-is-identity convention: a user pins per-identity SSH keys via
 * `~/.ssh/config` host aliases (`git@gitlab-work.io:group/app.git`), so the
 * host in a remote URL is often not the provider's real hostname.
 * `canonicalGitHost` (github.ts) maps any such alias to the provider's cloud
 * hostname (`gitlab.com`, `bitbucket.org`, …) for API-base-URL purposes, but
 * the RAW pre-canonicalization host is what identifies this specific
 * account/workspace — that's the key the token store (`github-tokens.ts`) is
 * keyed by, and it's already host-keyed with zero schema change needed to
 * hold gitlab/bitbucket alias hosts alongside github ones.
 *
 * Leaf module: does not import `db.ts` or `server.ts`. May import from
 * `github-tokens.ts`, `../shared/types.ts`, and `github.ts` (only the
 * provider-agnostic exports: `parseGitRemote`, `canonicalGitHost`, `run`).
 */

const GITLAB_FETCH_TIMEOUT_MS = 5_000;

/** Map a canonical provider host (as produced by `canonicalGitHost`) to the
 *  `GitProvider` it identifies, or null when it's none of the three supported
 *  cloud forges (self-hosted GitLab/Bitbucket Server, or an unrelated host —
 *  both out of scope per the plan). */
export function providerForHost(canonicalHost: string): GitProvider | null {
  switch (canonicalHost) {
    case "github.com":
      return "github";
    case "gitlab.com":
      return "gitlab";
    case "bitbucket.org":
      return "bitbucket";
    default:
      return null;
  }
}

/**
 * Resolve the provider + repo identity for a project directory by walking its
 * git remotes, mirroring `repoForDir`'s iteration order (`origin` first, then
 * the rest in whatever order `git remote` lists them; first parseable +
 * supported-provider remote wins). Returns null when the dir isn't a git repo,
 * has no remotes, or its remotes all resolve to an unsupported host.
 */
export async function providerRepoForDir(dir: string): Promise<ProviderRepoInfo | null> {
  if (!existsSync(dir)) return null;
  const remotes = await run(["git", "remote"], dir);
  if (!remotes.ok) return null;
  const names = remotes.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const ordered = ["origin", ...names.filter((n) => n !== "origin")];
  for (const name of ordered) {
    const url = await run(["git", "remote", "get-url", name], dir);
    if (!url.ok) continue;
    const parsed = parseGitRemote(url.stdout);
    if (!parsed) continue;
    const provider = providerForHost(parsed.host);
    if (!provider) continue;
    return {
      provider,
      host: parsed.host,
      remoteHost: parsed.rawHost,
      owner: parsed.owner,
      name: parsed.name,
    };
  }
  return null;
}

/**
 * Resolve the token to authenticate a GitLab request with, for a repo whose
 * raw remote host is `remoteHost` (null when there's no repo in scope).
 * Resolution order mirrors `githubToken` in github.ts:
 *   1. A stored token for `remoteHost` (the raw-host-keyed store in
 *      `github-tokens.ts` — works for a gitlab alias host as-is, no schema
 *      change; falls back to a `gitlab.com`-labeled entry the same way
 *      `tokenForHost` falls back to `github.com` for GitHub).
 *   2. `GITLAB_TOKEN` env.
 *   3. Best-effort `glab config get token --host gitlab.com` shellout
 *      (5s timeout; any failure — missing binary, non-zero exit, timeout —
 *      swallowed to null, same as `githubToken`'s `gh auth token` fallback).
 */
export async function gitlabToken(remoteHost: string | null): Promise<string | null> {
  const stored = tokenForHost(remoteHost, "gitlab.com");
  if (stored) return stored;
  const envToken = process.env.GITLAB_TOKEN;
  if (envToken) return envToken;
  const glab = await run(["glab", "config", "get", "token", "--host", "gitlab.com"], undefined, GITLAB_FETCH_TIMEOUT_MS);
  return glab.ok && glab.stdout ? glab.stdout : null;
}

/**
 * Bitbucket Cloud credential shapes. Bitbucket's REST API accepts either:
 *  - Basic auth: account email + API token (the current recommended method —
 *    app passwords were retired 2026-06-09).
 *  - Bearer auth: a workspace or repository access token.
 * The caller (the Bitbucket adapter, T3) picks the `Authorization` header
 * shape from which variant `bitbucketCreds` resolves.
 */
export type BitbucketCreds =
  | { kind: "basic"; username: string; password: string }
  | { kind: "bearer"; token: string };

/**
 * Resolve Bitbucket Cloud credentials for a repo whose raw remote host is
 * `remoteHost` (null when there's no repo in scope). Resolution order:
 *   1. A stored credential string for `remoteHost` (the raw-host-keyed store
 *      in `github-tokens.ts`, falling back to a `bitbucket.org`-labeled
 *      entry the same way `tokenForHost` falls back to `github.com`).
 *   2. `BITBUCKET_TOKEN` env (+ optional `BITBUCKET_EMAIL`).
 *
 * Convention for turning a single credential string into a typed credential:
 * a value containing `:` splits on the FIRST `:` into `email:api_token` and
 * is treated as Basic auth (the colon can't appear in an email's local part
 * before the `@`, so splitting on the first `:` is unambiguous even if the
 * API token itself happens to contain `:`). A value with no `:` is treated as
 * a Bearer token (a workspace/repo access token). When `BITBUCKET_EMAIL` is
 * set and `BITBUCKET_TOKEN` has no `:`, the two are combined into Basic auth
 * (`email:token`) rather than requiring the caller to pre-join them.
 */
export async function bitbucketCreds(remoteHost: string | null): Promise<BitbucketCreds | null> {
  const stored = tokenForHost(remoteHost, "bitbucket.org");
  if (stored) return parseBitbucketCredential(stored);
  const envToken = process.env.BITBUCKET_TOKEN;
  if (envToken) {
    const email = process.env.BITBUCKET_EMAIL;
    if (email && !envToken.includes(":")) {
      return { kind: "basic", username: email, password: envToken };
    }
    return parseBitbucketCredential(envToken);
  }
  return null;
}

function parseBitbucketCredential(raw: string): BitbucketCreds {
  const idx = raw.indexOf(":");
  if (idx === -1) return { kind: "bearer", token: raw };
  return { kind: "basic", username: raw.slice(0, idx), password: raw.slice(idx + 1) };
}

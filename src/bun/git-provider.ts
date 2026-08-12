import { spawnSync } from "node:child_process";
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
 *
 * `remoteHostsForDirs` (docs/plans/consolidate-git-host-discovery.md) lives
 * here rather than in `github.ts` for the same reason the rest of this file
 * does: it needs to be provider-generic over `providerRepoForDir`, and
 * `github.ts` can't import this module (this module imports `github.ts` for
 * `parseGitRemote`/`canonicalGitHost`/`run` — the reverse edge would cycle).
 * It used to live in github.ts with its own duplicated
 * supported-provider-hosts set and inline remote-walk for exactly that
 * reason; moving it here instead of duplicating deletes the duplication.
 */

const GITLAB_FETCH_TIMEOUT_MS = 5_000;
const SSH_RESOLVE_TIMEOUT_MS = 4_000;

/** Module-level cache for `apiHostForRemote`, keyed by the raw (as-given)
 *  `remoteHost` argument — no TTL, unlike `remoteHostsCache` above.
 *  `remoteHostsCache` is TTL'd because its *source* (a project dir's git
 *  remotes) can change mid-session; `~/.ssh/config` for a fixed host
 *  effectively can't, so there's nothing to expire — a user hand-editing
 *  their ssh config mid-session and expecting agetor to notice without a
 *  restart isn't a supported flow. */
const apiHostCache = new Map<string, string>();

/** Test-only escape hatch: clears `apiHostForRemote`'s cache, mirroring
 *  `__clearRemoteHostsCacheForTest` below for the same reason (deterministic,
 *  order-independent tests). */
export function __clearApiHostCacheForTest(): void {
  apiHostCache.clear();
}

/**
 * Resolve the hostname API calls to a git-forge remote should target, given
 * that remote's RAW host (`ProviderRepoInfo.remoteHost` /
 * `parseGitRemote(...).rawHost` — see the module doc comment above).
 *
 * WHY this exists: a raw remote host is ambiguous. It's either a genuine
 * self-hosted domain (`gitlab.mycompany.com`, used verbatim as the API host)
 * or an `~/.ssh/config` multi-identity alias
 * (docs/plans/github-remote-host-aliases.md) whose `HostName` is the
 * provider's real cloud domain — e.g. `Host gitlab-work` / `HostName
 * gitlab.com`, so the remote URL says `gitlab-work` but the API lives at
 * `gitlab.com/api/v4`, not the nonexistent `gitlab-work/api/v4`. Nothing in
 * the remote URL itself distinguishes the two cases: `ssh -G <host>` is the
 * only local authority that can, because it performs the exact same
 * Include/Match/Host-pattern resolution a real `ssh` invocation for that
 * remote would, without opening a network connection (`-G` just prints the
 * fully-resolved client configuration and exits).
 *
 * Parses the `hostname <value>` line `ssh -G` always emits: for an alias
 * this is the resolved `HostName` (e.g. `gitlab.com`); for a plain domain
 * with no matching config entry, ssh's default behavior is to echo the
 * input back (lowercased — ssh lowercases hostnames during config
 * resolution, which is harmless here since DNS/HTTP hostnames are
 * case-insensitive).
 *
 * Never throws and never blocks longer than `SSH_RESOLVE_TIMEOUT_MS`: any
 * failure (missing `ssh` binary, non-zero exit, timeout, unparseable
 * output, empty resolved hostname) falls back to returning `remoteHost`
 * unchanged — today's behavior. Synchronous and cached (see `apiHostCache`
 * above) because this feeds `gitlabApiBase` (H2, gitlab.ts), which is called
 * inline from ~25 template-literal call sites that have no reason to become
 * async just for this.
 *
 * Binary overridable via `AGETOR_SSH_BIN` (house pattern — `AGETOR_TMUX_BIN`
 * in tmux-resolution.ts, `AGETOR_CLAUDE_BIN`/`AGETOR_CODEX_BIN`/… in
 * agents.ts) so tests can point at a stub script instead of the real `ssh`.
 */
export function apiHostForRemote(remoteHost: string): string {
  const cached = apiHostCache.get(remoteHost);
  if (cached !== undefined) return cached;

  const normalized = remoteHost.trim().toLowerCase();
  // Guard rather than spawn: an empty host is nothing to resolve, and a
  // leading "-" could otherwise be misread by ssh as an option. The `--`
  // passed to ssh below is belt-and-suspenders for every other input; this
  // guard is the cheap first line of defense that also sidesteps ever
  // spawning a process for garbage input.
  if (!normalized || normalized.startsWith("-")) {
    apiHostCache.set(remoteHost, remoteHost);
    return remoteHost;
  }

  const sshBin = process.env.AGETOR_SSH_BIN || "ssh";
  let resolved = remoteHost;
  try {
    // No shell involved (argv array, not a command string) and `--` marks
    // the end of options, so `normalized` can't be reinterpreted as an ssh
    // flag even if the leading-dash guard above were somehow bypassed.
    const res = spawnSync(sshBin, ["-G", "--", normalized], {
      encoding: "utf8",
      timeout: SSH_RESOLVE_TIMEOUT_MS,
    });
    if (res.status === 0 && typeof res.stdout === "string") {
      const match = res.stdout.match(/^hostname\s+(\S+)\s*$/m);
      if (match && match[1]) resolved = match[1];
    }
  } catch {
    // Missing binary, spawn error, etc. — resolved stays remoteHost.
  }

  apiHostCache.set(remoteHost, resolved);
  return resolved;
}

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

const REMOTE_HOSTS_POOL_SIZE = 6;
const REMOTE_HOSTS_CACHE_TTL_MS = 10_000;

/** Single-slot promise cache for `remoteHostsForDirs`. Production only ever
 *  has one live key at a time (the current registered-project list), so a
 *  one-entry slot replaces what would otherwise be a never-pruned `Map` —
 *  there's nothing to sweep because a new key simply overwrites the slot.
 *
 *  `expiresAt` is anchored at *settle*, not at call start: while `promise` is
 *  in flight it's set to `Infinity` (always share, never re-scan), and only
 *  once the scan resolves does it get stamped to `Date.now() + TTL`. This is
 *  what makes a slow scan always shared — a second caller arriving mid-scan
 *  reuses the same in-flight promise instead of kicking off a duplicate one —
 *  and it means freshness is measured from when the data actually landed,
 *  not from when the scan happened to start. The Settings page's GET-then-PUT
 *  `/github/tokens` round trip is the motivating case: both handlers call
 *  `remoteHostsForDirs` with the same project list back-to-back, and this
 *  design guarantees they share one scan no matter how long that scan takes. */
let remoteHostsCache: { key: string; expiresAt: number; promise: Promise<string[]> } | null = null;

/** Test-only escape hatch: forces the next `remoteHostsForDirs` call (for any
 *  key) to re-scan instead of reusing a cached promise. Exported rather than
 *  threading a `{ fresh: true }` option through the production signature,
 *  since the only caller that ever needs to bypass the cache is a test
 *  proving the TTL actually expires/cache actually reuses. */
export function __clearRemoteHostsCacheForTest(): void {
  remoteHostsCache = null;
}

async function scanRemoteHosts(dirs: string[]): Promise<string[]> {
  const hosts = new Set<string>();
  // Bounded concurrency: each dir costs one `git remote` + up to one `git
  // remote get-url` per remote (via providerRepoForDir), and the Settings
  // page can list dozens of projects — an unbounded Promise.all over all of
  // them would burst that many subprocesses at once. Same pool-worker shape
  // as listGitHubItemsAcrossRepos (github.ts) / listItemsAcrossRepos
  // (git-host.ts): a shared `next` cursor, workers pull the next index until
  // exhausted, order doesn't matter since results only feed a Set.
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= dirs.length) return;
      const dir = dirs[i]!;
      const info = await providerRepoForDir(dir);
      if (info) hosts.add(info.remoteHost);
    }
  };
  await Promise.all(Array.from({ length: Math.min(REMOTE_HOSTS_POOL_SIZE, dirs.length) }, worker));
  return Array.from(hosts).sort();
}

/**
 * Distinct raw remote hosts (the ssh-alias identity, or the provider's own
 * domain for a plain remote) across the given project dirs, sorted — drives
 * the Settings "detected hosts" suggestion list so a user's real aliases are
 * one click away instead of hand-typed. Provider-generic via
 * `providerRepoForDir`: considers every dir whose remotes — walked
 * origin-first, same order `providerRepoForDir` tries them in — yield a
 * supported provider (github.com, gitlab.com, or bitbucket.org) anywhere in
 * that walk, not just via its first remote. Dirs with no supported-provider
 * remote (or that aren't a repo at all) are tolerated silently, same as
 * `providerRepoForDir` itself returning null.
 *
 * `dirs` is normalized (deduped via `Set`, then sorted) before it's used both
 * as the cache key and as the input to the scan, mirroring the sibling pools
 * (`listGitHubItemsAcrossRepos` in github.ts, `listItemsAcrossRepos` in
 * git-host.ts) — this also means a caller passing the same dir twice doesn't
 * pay for scanning it twice.
 *
 * Result is cached (10s TTL, single-slot — see `remoteHostsCache` above) per
 * distinct normalized-dirs key: the Settings "/github/tokens" GET and PUT
 * handlers both call this with the same project list back-to-back (GET on
 * page load, PUT immediately after on every token save), so without a cache
 * a single Settings save always re-runs the whole scan twice. A cache miss
 * beyond the TTL just re-scans; staleness cost is a newly-added project's
 * host not appearing in the detected list for up to 10s, which self-heals on
 * the next Settings open (see docs/plans/consolidate-git-host-discovery.md
 * §7).
 */
export async function remoteHostsForDirs(dirs: string[]): Promise<string[]> {
  const normalizedDirs = Array.from(new Set(dirs.filter((d) => d.trim()))).sort();
  const key = normalizedDirs.join("\0");
  const now = Date.now();
  if (remoteHostsCache && remoteHostsCache.key === key && remoteHostsCache.expiresAt > now) {
    return remoteHostsCache.promise;
  }
  const promise = scanRemoteHosts(normalizedDirs);
  const slot = { key, expiresAt: Infinity, promise };
  remoteHostsCache = slot;
  // Don't cache rejections: on failure, clear the slot (only if it's still
  // the one we just set — a later call may have already replaced it) so the
  // next call retries instead of replaying a stale error. On success, anchor
  // the TTL here at settle time rather than at call start.
  promise.then(
    () => {
      if (remoteHostsCache === slot) slot.expiresAt = Date.now() + REMOTE_HOSTS_CACHE_TTL_MS;
    },
    () => {
      if (remoteHostsCache === slot) remoteHostsCache = null;
    },
  );
  return promise;
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

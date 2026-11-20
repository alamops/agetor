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
 * `canonicalGitHost` (`src/shared/git-host.ts`) maps any such alias to the provider's cloud
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
// The ssh -G fallback is correct-by-default (worst case: today's raw-host
// behavior). An ssh config that takes longer than this to resolve isn't
// worth waiting on — every host-dependent request queues behind it, so this
// budget is deliberately tight rather than generous.
const SSH_RESOLVE_TIMEOUT_MS = 750;

/** The three cloud-forge hostnames `resolveApiHost` short-circuits on
 *  before ever spawning `ssh -G` — see the WHY block in `resolveApiHost`
 *  above its cloud-host guard. */
const CLOUD_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);

/** Maps an ssh-transport-only hostname (a vendor-documented "connect over
 *  443 via ssh" endpoint — `altssh.gitlab.com`, `ssh.github.com`,
 *  `altssh.bitbucket.org`, …) to the real cloud API host it's a transport
 *  stand-in for. These are SSH transport overrides, not API hosts — none of
 *  the three cloud forges serve a REST API from them. Built generically as
 *  `altssh.<cloud>` and `ssh.<cloud>` for each cloud host rather than
 *  hardcoding only the one pattern each vendor happens to document today, so
 *  a raw host that RESOLVES (via `ssh -G`) to one of these still ends up at
 *  the real cloud API host instead of a dead one. */
const SSH_TRANSPORT_ALIASES = new Map<string, string>(
  Array.from(CLOUD_HOSTS).flatMap((cloud) => [
    [`altssh.${cloud}`, cloud],
    [`ssh.${cloud}`, cloud],
  ]),
);

/** Legal hostname charset, checked post-lowercase. Anything outside this
 *  (embedded whitespace, control characters, a newline smuggling a second
 *  "line" into the string, …) can't be a real hostname; guarding on it
 *  before ever building a URL out of the value protects downstream `new
 *  URL(...)` calls (gitlab.ts's `gitlabApiBase`, primarily) from malformed
 *  input rather than letting them throw or silently misparse. */
const HOSTNAME_CHARSET_RE = /^[a-z0-9.-]+$/;

/** Module-level cache for `resolveApiHost`, keyed by the NORMALIZED
 *  (trimmed + lowercased) `remoteHost` argument (NTH-6 — this is what makes
 *  two different-cased spellings of the same host share one resolution) —
 *  no TTL, unlike `remoteHostsCache` above. `remoteHostsCache` is TTL'd
 *  because its *source* (a project dir's git remotes) can change
 *  mid-session; `~/.ssh/config` for a fixed host effectively can't, so
 *  there's nothing to expire — a user hand-editing their ssh config
 *  mid-session and expecting agetor to notice without a restart isn't a
 *  supported flow. */
const apiHostCache = new Map<string, string>();

/** Upper bound on `apiHostCache`: hosts come from remotes the user (or an
 *  agent-planted repo) names, so the map must not grow without limit. Past the
 *  cap the oldest entry is evicted (Map insertion order); an evicted host is
 *  simply resolved again on its next use. */
const API_HOST_CACHE_MAX = 256;

/** In-flight async resolutions by normalized host, so concurrent callers for
 *  one host share a single `ssh -G`. */
const apiHostInflight = new Map<string, Promise<string>>();

function rememberApiHost(normalized: string, resolved: string): string {
  if (!apiHostCache.has(normalized) && apiHostCache.size >= API_HOST_CACHE_MAX) {
    const oldest = apiHostCache.keys().next().value;
    if (oldest !== undefined) apiHostCache.delete(oldest);
  }
  apiHostCache.set(normalized, resolved);
  return resolved;
}

/** Pull the `hostname <value>` line out of `ssh -G` output, or null. */
function parseSshHostname(stdout: string): string | null {
  const match = stdout.match(/^hostname\s+(\S+)\s*$/m);
  return match && match[1] ? match[1] : null;
}

/** The hosts that never need an `ssh -G` spawn: the three cloud domains, and
 *  anything that is not a legal hostname (empty, leading "-", bad charset).
 *  Returns the answer, or null when ssh has to be asked. */
function resolveWithoutSsh(normalized: string): string | null {
  if (CLOUD_HOSTS.has(normalized)) return normalized;
  if (!normalized || normalized.startsWith("-") || !HOSTNAME_CHARSET_RE.test(normalized)) {
    return normalized;
  }
  return null;
}

/** Test-only escape hatch: clears `resolveApiHost`'s cache, mirroring
 *  `__clearRemoteHostsCacheForTest` below for the same reason (deterministic,
 *  order-independent tests). */
export function __clearApiHostCacheForTest(): void {
  apiHostCache.clear();
  apiHostInflight.clear();
}

/** Test-only: how many hosts the cache holds (bound check). */
export function __apiHostCacheSizeForTest(): number {
  return apiHostCache.size;
}

/**
 * Resolve the hostname API calls to a git-forge remote should target, given
 * that remote's RAW host (`ProviderRepoInfo.remoteHost` /
 * `parseGitRemote(...).rawHost`).
 *
 * WHY: a raw remote host is ambiguous. It's either a genuine self-hosted
 * domain (`gitlab.mycompany.com`, used verbatim as the API host) or an
 * `~/.ssh/config` multi-identity alias (docs/plans/github-remote-host-aliases.md)
 * whose `HostName` is the provider's real cloud domain, e.g. `Host gitlab-work`
 * / `HostName gitlab.com`. `ssh -G <host>` is the only local authority that can
 * tell: it performs the same Include/Match/Host-pattern resolution a real ssh
 * would, without a network connection. The `hostname <value>` line is parsed;
 * a plain domain with no config entry is echoed back lowercased.
 *
 * Cloud short-circuit, BEFORE any ssh spawn: a host that already is one of the
 * three cloud domains is unambiguous. Resolving it through a config that
 * carries the vendor-documented ssh-over-443 workaround (`altssh.gitlab.com`,
 * `ssh.github.com`) would redirect API calls to a host with no REST API, so a
 * resolved SSH transport alias is also mapped back to its cloud domain.
 * Empty hosts, a leading "-" and any charset violation are returned
 * normalized without spawning (the `--` passed to ssh is belt and braces).
 *
 * `ssh -G` runs through the async `run` (so through `coreSpawn`, because it
 * evaluates `Match exec` clauses an agent can plant) and never holds the main
 * thread. Resolves once per host for the process lifetime (bounded cache,
 * concurrent callers share one spawn), never rejects, and falls back to the
 * normalized input on any failure (missing binary, non-zero exit, timeout,
 * unparseable output). Binary overridable via `AGETOR_SSH_BIN`.
 */
export async function resolveApiHost(remoteHost: string): Promise<string> {
  const normalized = remoteHost.trim().toLowerCase();
  const cached = apiHostCache.get(normalized);
  if (cached !== undefined) return cached;
  const direct = resolveWithoutSsh(normalized);
  if (direct !== null) return rememberApiHost(normalized, direct);
  const pending = apiHostInflight.get(normalized);
  if (pending) return pending;
  const task = (async () => {
    let resolved = normalized;
    try {
      const res = await run(
        [process.env.AGETOR_SSH_BIN || "ssh", "-G", "--", normalized],
        undefined,
        SSH_RESOLVE_TIMEOUT_MS,
      );
      if (res.ok) resolved = parseSshHostname(res.stdout) ?? resolved;
    } catch {
      // Missing binary, spawn error, etc. — resolved stays normalized.
    }
    resolved = SSH_TRANSPORT_ALIASES.get(resolved) ?? resolved;
    return rememberApiHost(normalized, resolved);
  })();
  apiHostInflight.set(normalized, task);
  try {
    return await task;
  } finally {
    apiHostInflight.delete(normalized);
  }
}

/** Map a canonical provider host (as produced by `canonicalGitHost`) to the
 *  `GitProvider` it identifies, or null for an unrelated host. Because
 *  `canonicalGitHost` collapses ANY host containing "gitlab" to `gitlab.com`,
 *  a self-hosted GitLab (`gitlab.mycompany.com`) classifies as `gitlab` here
 *  too and is fully supported — its real API host is resolved separately
 *  from `ProviderRepoInfo.remoteHost` via `resolveApiHost` (see
 *  `gitlabApiBase` in gitlab.ts). Bitbucket Server / Data Center likewise
 *  classifies as `bitbucket` and is then rejected by `bitbucketServerError`
 *  (bitbucket.ts), since its REST API has a different shape. */
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
  return (await providerRemoteForDir(dir))?.info ?? null;
}

/**
 * {@link providerRepoForDir} that also names the git remote the identity came
 * from (`origin`, or the first parseable remote). Create-all-PRs needs it to
 * read `<remote>/HEAD` and to strip a `<remote>/` prefix from an agent's base.
 */
export async function providerRemoteForDir(
  dir: string,
): Promise<{ info: ProviderRepoInfo; remote: string } | null> {
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
    // Prime the per-host cache off the main thread so the sync
    // `resolveApiHost` readers downstream (gitlab.ts, bitbucket.ts) hit it.
    await resolveApiHost(parsed.rawHost);
    return {
      remote: name,
      info: {
        provider,
        host: parsed.host,
        remoteHost: parsed.rawHost,
        owner: parsed.owner,
        name: parsed.name,
      },
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
 *
 * Credential resolution is scoped to the **resolved** API host
 * (`resolveApiHost(remoteHost)`), not the raw host, and the two cases get
 * different tiers:
 *
 *   - **Cloud** (`resolved === "gitlab.com"`, or `remoteHost === null` —
 *     treated as cloud since that's `glab`'s own default `--host`): today's
 *     three-tier order, unchanged — see `gitlabCloudToken` below.
 *   - **Self-hosted** (`resolved` is anything else): exact host-keyed store
 *     entry ONLY — see `gitlabSelfHostedToken` below for why the cloud
 *     tiers (gitlab.com store fallback, `GITLAB_TOKEN` env, glab-cloud) must
 *     NOT apply here.
 *
 * WHY the scoping matters (review finding, fix wave): before per-host API
 * bases, every GitLab call's URL was hardcoded to `gitlab.com`, so a stored
 * `gitlab.com` token (or `GITLAB_TOKEN`, or `glab`'s own cloud account)
 * could only ever be sent to `gitlab.com` — falling back to it for an
 * unrecognized host was harmless. Now that the API base is resolved
 * per-host, the same fallback would transmit a `gitlab.com` personal-access
 * token to an arbitrary third-party host whose name merely happens to
 * contain "gitlab" — a credential-disclosure bug, not a convenience.
 */
export async function gitlabToken(remoteHost: string | null): Promise<string | null> {
  if (remoteHost === null) return gitlabCloudToken(null);
  const resolved = await resolveApiHost(remoteHost);
  if (resolved === "gitlab.com") return gitlabCloudToken(remoteHost);
  return gitlabSelfHostedToken(remoteHost, resolved);
}

/** Cloud (gitlab.com) resolution order, unchanged from before per-host API
 *  bases: stored token for `remoteHost` (falling back to a `gitlab.com`
 *  -labeled store entry) → `GITLAB_TOKEN` env → best-effort `glab config get
 *  token --host gitlab.com` shellout (5s timeout; any failure — missing
 *  binary, non-zero exit, timeout — swallowed to null, same as
 *  `githubToken`'s `gh auth token` fallback in github.ts). */
async function gitlabCloudToken(remoteHost: string | null): Promise<string | null> {
  const stored = tokenForHost(remoteHost, "gitlab.com");
  if (stored) return stored;
  const envToken = process.env.GITLAB_TOKEN;
  if (envToken) return envToken;
  const glab = await run(["glab", "config", "get", "token", "--host", "gitlab.com"], undefined, GITLAB_FETCH_TIMEOUT_MS);
  return glab.ok && glab.stdout ? glab.stdout : null;
}

/**
 * Self-hosted resolution order — deliberately narrower than the cloud path
 * (see the credential-disclosure WHY on `gitlabToken` above): only an EXACT
 * host-keyed store entry, tried under both the raw remote host and (if it
 * differs, e.g. an ssh alias resolving to a self-hosted domain) the resolved
 * host. `tokenForHost(host, host)` — passing the host itself as the
 * fallback — is how an exact-only lookup is expressed against a helper
 * whose second parameter is normally a cross-host fallback: the exact-match
 * branch already covers `host`, so the "fallback" branch degenerates to a
 * no-op default-store leak. No `gitlab.com` store fallback, no
 * `GITLAB_TOKEN` env, no glab-cloud-account shellout — none of those are
 * scoped to this self-hosted target. As a last, still host-scoped tier,
 * `glab config get token --host <resolved>` is attempted (glab supports
 * `--host` for self-managed GitLab instances the same way it does for
 * gitlab.com).
 */
async function gitlabSelfHostedToken(remoteHost: string, resolved: string): Promise<string | null> {
  const byRemoteHost = tokenForHost(remoteHost, remoteHost);
  if (byRemoteHost) return byRemoteHost;
  if (resolved !== remoteHost) {
    const byResolvedHost = tokenForHost(resolved, resolved);
    if (byResolvedHost) return byResolvedHost;
  }
  const glab = await run(["glab", "config", "get", "token", "--host", resolved], undefined, GITLAB_FETCH_TIMEOUT_MS);
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

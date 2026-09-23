import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CloneProgressPhase, GitProvider } from "../shared/types.ts";
import {
  CLONE_CLOUD_HOST,
  CLONE_SUPPORTED_HINT,
  cloneProviderForHost,
  isValidCloneHost,
  parseCloneInput,
} from "../shared/clone-input.ts";
import { apiHostForRemote, bitbucketCreds, gitlabToken } from "./git-provider.ts";
import { githubToken, run } from "./github.ts";
import { bitbucketServerError } from "./bitbucket.ts";

/**
 * Clone-repository support for the Projects sidebar
 * (docs/plans/clone-repository-all-providers.md).
 *
 * `POST /projects/clone` (server.ts) is the consumer: turn whatever the user
 * pasted into a canonical, provider-correct clone URL (`resolveCloneRepo`),
 * clone it (`cloneRepo`), and register the destination as a project. The
 * syntactic parsing (which shape was pasted, what host/path it names) lives
 * in the shared, host-resolution-free `../shared/clone-input.ts` — this
 * module is the layer on top that applies the Git integration's REAL host
 * rules (`ssh -G` alias resolution via `apiHostForRemote`, Bitbucket
 * Server/Data Center rejection via `bitbucketServerError`, per-provider
 * credential resolution) on top of that syntax, because none of that can run
 * in the webview. Everything here is deterministic and unit-tested. The
 * ELI5 explainer task's text lives in `../shared/clone-eli5.ts` instead (it's
 * imported by the webview too); the LLM part itself lives in the agetor task
 * the route creates, never in an API call from here.
 *
 * Addendum A (progress streaming + cancel): `cloneRepo` also parses git's
 * `--progress` stderr into `CloneProgress` events (`parseCloneProgress`),
 * forwards them (rate-limited) through `CloneOptions.onProgress`, and lets
 * a caller kill the in-flight git process for one clone via `cancelClone` —
 * `server.ts` is the consumer that turns `onProgress` calls into
 * `clone_progress` `AppEvent`s broadcast over `GET /app/events` and wires
 * `DELETE /projects/clone/:cloneId` to `cancelClone`.
 */

/**
 * A clone input, fully resolved against the Git integration's host rules —
 * what `resolveCloneRepo` hands back on success.
 */
export interface ResolvedCloneRepo {
  provider: GitProvider;
  transport: "https" | "ssh";
  /** The token-store key / per-identity host: for a shorthand input, the
   *  provider's cloud host; otherwise the raw host as pasted (pre-`ssh -G`
   *  resolution) — mirrors `ProviderRepoInfo.remoteHost`'s convention. */
  rawHost: string;
  /** Last path segment — also the default destination folder name. */
  repo: string;
  /** `owner/…/repo`, exactly as `parseCloneInput` trimmed/validated it. */
  fullPath: string;
  /** The canonical URL handed to `git clone`. */
  cloneUrl: string;
  /** `"https://host[:port]/"` when `cloneUrl` is an https URL AND a stored
   *  credential may legitimately apply to it — `null` for every ssh clone
   *  and for a plain `http://` self-hosted GitLab clone (a credential must
   *  never be sent over a scheme that transmits it in the clear). */
  authOrigin: string | null;
}

export type ResolveCloneResult = { ok: true; repo: ResolvedCloneRepo } | { ok: false; error: string };

/** `"<rawHost>" looks like an SSH alias — paste the SSH URL instead
 *  (git@<rawHost>:<fullPath>.git)"` — the shared rejection text for every
 *  "this host can't be reached over https" case below (a dotless,
 *  unresolved `~/.ssh/config` alias for GitHub/GitLab/Bitbucket, pasted as an
 *  `https://` URL instead of an SSH one). */
function sshAliasHint(rawHost: string, fullPath: string): string {
  return `"${rawHost}" looks like an SSH alias — paste the SSH URL instead (git@${rawHost}:${fullPath}.git)`;
}

/**
 * Guards the port on an https-form input that resolves to one of the three
 * CLOUD hosts (`github.com`, `gitlab.com`, `bitbucket.org`) — self-hosted
 * GitLab is exempt and keeps whatever port was pasted (see the self-hosted
 * branch below). None of the three clouds serve from a non-default port, so
 * a pasted port is only ever noise from the scheme's own default (`443` for
 * `https`, `80` for `http`), silently dropped from the canonical URL; any
 * other value names a real, different endpoint and is rejected outright
 * rather than silently cloning from the wrong place. Returns the rejection
 * error string, or `null` when there's nothing to reject.
 */
function rejectedCloudPort(
  port: string | null,
  scheme: "https" | "http" | null,
  cloudHost: string,
): string | null {
  if (!port) return null;
  const defaultPort = (scheme ?? "https") === "http" ? "80" : "443";
  if (port === defaultPort) return null;
  return `unexpected port :${port} for ${cloudHost}`;
}

/**
 * Layers the Git integration's real host-resolution rules
 * (docs/plans/clone-repository-all-providers.md §3 D2/D3) on top of the
 * shared syntactic parser (`parseCloneInput`). `shorthandProvider` is only
 * consulted for bare `owner/repo` shorthand (which carries no host of its
 * own) — see `parseCloneInput`'s own doc comment.
 *
 * Per-provider https rules mirror the Git integration's own resolvers
 * exactly, so "what clones" and "what the Git integration dialog already
 * talks to" never drift:
 *  - **GitHub**: `apiHostForRemote` must resolve to `github.com` — GitHub
 *    Enterprise Server has no https support here (the integration doesn't
 *    support it either), and a dotless unresolved alias gets the SSH hint
 *    instead (nothing to reject-with-detail, since ssh told us nothing).
 *  - **GitLab**: cloud (`gitlab.com`) clones as usual; a genuinely
 *    self-hosted instance (a dotted, non-`gitlab.com` resolution) keeps
 *    whatever scheme/port was pasted, but the HOST component is rewritten to
 *    `ssh -G`'s resolution whenever that actively resolved an `~/.ssh/config`
 *    alias to a different dotted host — mirroring the GitHub/Bitbucket
 *    cloud-host rewrite above, since an alias like `gitlab-work` is never
 *    itself a reachable https endpoint. `rawHost` (the token-store key)
 *    always stays the host as pasted, so a stored per-alias credential still
 *    resolves — self-hosted GitLab is first-class in the integration
 *    (`gitlabApiBase`), unlike GHES.
 *  - **Bitbucket**: `bitbucketServerError` (the same guard every Bitbucket
 *    adapter call runs) rejects a genuine Server/Data Center domain up
 *    front; what's left after that guard passes is either `bitbucket.org`
 *    itself or a dotless alias, which gets the SSH hint (Bitbucket Cloud is
 *    the only https target this module knows how to build).
 *
 * A pasted port is only ever meaningful for self-hosted GitLab — every https
 * clone that resolves to one of the three CLOUD hosts rejects any port other
 * than the scheme's own default (`rejectedCloudPort`), since none of them
 * serve from a non-default port and silently accepting one would clone from
 * an endpoint the user didn't actually name.
 *
 * SSH-transport inputs (`scp`/`ssh-url` forms) skip host resolution
 * entirely for GitHub/GitLab (the integration has no ssh-side guard either —
 * an unresolved alias simply fails at the `ssh` layer, not here) and are
 * canonicalized preserving exactly what was pasted (alias host, user, port).
 * Bitbucket is the one exception: even over ssh, a Server/DC alias is
 * rejected up front via the same `bitbucketServerError` guard, since Server/DC
 * speaks neither this module's REST adapter nor (obviously) this clone flow.
 */
export function resolveCloneRepo(
  input: string,
  shorthandProvider: GitProvider = "github",
): ResolveCloneResult {
  const parsed = parseCloneInput(input, shorthandProvider);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const v = parsed.value;

  if (v.form === "shorthand") {
    const cloudHost = CLONE_CLOUD_HOST[v.provider];
    return {
      ok: true,
      repo: {
        provider: v.provider,
        transport: "https",
        rawHost: cloudHost,
        repo: v.repo,
        fullPath: v.fullPath,
        cloneUrl: `https://${cloudHost}/${v.fullPath}.git`,
        authOrigin: `https://${cloudHost}/`,
      },
    };
  }

  if (v.transport === "ssh") {
    const rawHost = v.rawHost!;
    if (v.provider === "bitbucket") {
      const serverError = bitbucketServerError({
        provider: "bitbucket",
        host: "bitbucket.org",
        remoteHost: rawHost,
        owner: v.segments[0]!,
        name: v.segments[1]!,
      });
      if (serverError) return { ok: false, error: serverError };
    }
    const cloneUrl =
      v.form === "scp"
        ? `${v.user ? `${v.user}@` : ""}${rawHost}:${v.fullPath}.git`
        : `ssh://${v.user ? `${v.user}@` : ""}${rawHost}${v.port ? `:${v.port}` : ""}/${v.fullPath}.git`;
    return {
      ok: true,
      repo: {
        provider: v.provider,
        transport: "ssh",
        rawHost,
        repo: v.repo,
        fullPath: v.fullPath,
        cloneUrl,
        authOrigin: null,
      },
    };
  }

  // https / http.
  const rawHost = v.rawHost!;
  const resolved = apiHostForRemote(rawHost);

  if (v.provider === "github") {
    if (resolved !== "github.com") {
      if (!resolved.includes(".")) return { ok: false, error: sshAliasHint(rawHost, v.fullPath) };
      return {
        ok: false,
        error: `GitHub Enterprise Server ("${resolved}") isn't supported over https — only github.com. ${CLONE_SUPPORTED_HINT}`,
      };
    }
    const githubPortError = rejectedCloudPort(v.port, v.scheme, "github.com");
    if (githubPortError) return { ok: false, error: githubPortError };
    return {
      ok: true,
      repo: {
        provider: "github",
        transport: "https",
        rawHost,
        repo: v.repo,
        fullPath: v.fullPath,
        cloneUrl: `https://github.com/${v.fullPath}.git`,
        authOrigin: "https://github.com/",
      },
    };
  }

  if (v.provider === "gitlab") {
    if (resolved === "gitlab.com") {
      const gitlabPortError = rejectedCloudPort(v.port, v.scheme, "gitlab.com");
      if (gitlabPortError) return { ok: false, error: gitlabPortError };
      return {
        ok: true,
        repo: {
          provider: "gitlab",
          transport: "https",
          rawHost,
          repo: v.repo,
          fullPath: v.fullPath,
          cloneUrl: `https://gitlab.com/${v.fullPath}.git`,
          authOrigin: "https://gitlab.com/",
        },
      };
    }
    if (!resolved.includes(".")) return { ok: false, error: sshAliasHint(rawHost, v.fullPath) };
    // `resolved` is `ssh -G`'s output for a HOST that reached this point
    // because it merely *contains* "gitlab" (`cloneProviderForHost`'s cheap
    // substring heuristic) — an `~/.ssh/config` alias can resolve its
    // `HostName` to literally anything (a hand-edited config, or a stubbed
    // `AGETOR_SSH_BIN` in tests). Unlike `rawHost` (already validated by
    // `parseCloneInput`'s own host charset check), `resolved` has never been
    // validated before this point, and it's about to be spliced directly
    // into both `cloneUrl` and `authOrigin` below — so two things must hold
    // before that happens: it must be a syntactically valid host at all
    // (`isValidCloneHost`, imported from the shared parser so the two rules
    // can't drift — a malformed resolution like `evil.example.com/x?tok=1`
    // would otherwise smuggle an extra path/query segment into the URL), and
    // it must not itself resolve to a github/bitbucket-shaped host
    // (`cloneProviderForHost(resolved)` must be `"gitlab"` or `null` —
    // "unrelated, no substring match" is fine, but a gitlab-named alias
    // resolving to `github.com` must NOT clone from `github.com` carrying a
    // GitLab credential origin). Neither check ever fires for the common
    // case (no alias, or an alias resolving to a real dotted GitLab host).
    const resolvedProvider = cloneProviderForHost(resolved);
    if (!isValidCloneHost(resolved) || (resolvedProvider !== null && resolvedProvider !== "gitlab")) {
      return {
        ok: false,
        error: `"${rawHost}" resolves to "${resolved}", which isn't a valid GitLab host — paste the repository's real https URL or its SSH URL`,
      };
    }
    // Self-hosted GitLab: keep whatever scheme/port was pasted (never
    // guarded the way the three cloud hosts are above — a self-hosted
    // instance can legitimately run on any port). The HOST component,
    // though, is `resolved` rather than `rawHost` whenever `ssh -G` actively
    // rewrote it (an `~/.ssh/config` alias like `gitlab-work` resolving to
    // `gitlab.internal.example.com`) — `rawHost` itself is never a reachable
    // https endpoint in that case, exactly like the github/bitbucket
    // cloud-host rewrites above. When there was no alias to resolve,
    // `resolved === rawHost` (mod casing) and this is a no-op. `rawHost`
    // stays the token-store key regardless, so a credential stored for the
    // real host under `rawHost`'s alias still resolves. A plain `http://`
    // clone never gets a credential attached — sending a token over an
    // unencrypted origin would put it on the wire in the clear.
    const scheme = v.scheme ?? "https";
    const portSuffix = v.port ? `:${v.port}` : "";
    return {
      ok: true,
      repo: {
        provider: "gitlab",
        transport: "https",
        rawHost,
        repo: v.repo,
        fullPath: v.fullPath,
        cloneUrl: `${scheme}://${resolved}${portSuffix}/${v.fullPath}.git`,
        authOrigin: scheme === "https" ? `https://${resolved}${portSuffix}/` : null,
      },
    };
  }

  // Bitbucket.
  const serverError = bitbucketServerError({
    provider: "bitbucket",
    host: "bitbucket.org",
    remoteHost: rawHost,
    owner: v.segments[0]!,
    name: v.segments[1]!,
  });
  if (serverError) return { ok: false, error: serverError };
  if (resolved !== "bitbucket.org") {
    // `bitbucketServerError` already rejected every other dotted host above,
    // so the only way to land here is a dotless, unresolved alias.
    return { ok: false, error: sshAliasHint(rawHost, v.fullPath) };
  }
  const bitbucketPortError = rejectedCloudPort(v.port, v.scheme, "bitbucket.org");
  if (bitbucketPortError) return { ok: false, error: bitbucketPortError };
  return {
    ok: true,
    repo: {
      provider: "bitbucket",
      transport: "https",
      rawHost,
      repo: v.repo,
      fullPath: v.fullPath,
      cloneUrl: `https://bitbucket.org/${v.fullPath}.git`,
      authOrigin: "https://bitbucket.org/",
    },
  };
}

/** One `origin` + one already-formatted `Authorization` header line, as
 *  resolved by `cloneAuthHeader` and consumed by `cloneAuthEnv`. */
export type CloneAuth = { origin: string; header: string };

/**
 * Resolves the `Authorization` header line to retry a failed anonymous
 * clone with, for `provider`'s stored credential at `rawHost` (the
 * token-store key — see `ResolvedCloneRepo.rawHost`). Returns `null` when no
 * credential resolves for this host (the caller then leaves the clone
 * failure as-is, anonymous-only) — this function never throws and never
 * partially fails; a resolver call that itself throws propagates to the
 * caller, which already wraps `opts.auth()` in a `.catch(() => null)` (see
 * `cloneRepo`).
 *
 * Credential shape per provider (git smart-HTTP convention — the *username*
 * half of Basic auth is what tells each provider which auth style a PAT is,
 * the actual secret rides as the *password* half):
 *  - **GitHub**: `x-access-token:<token>` (the username is ignored for PATs;
 *    `Bearer` is rejected by git's own http transport, so Basic is the only
 *    shape that works here).
 *  - **GitLab**: `oauth2:<token>` (works for PATs and OAuth/glab tokens
 *    alike; any other username also happens to work for a PAT, but `oauth2`
 *    is the one spelling GitLab documents for every token kind).
 *  - **Bitbucket**: `bitbucketCreds` already distinguishes the two credential
 *    kinds Bitbucket Cloud accepts — a Basic (email + API token) credential
 *    is sent as `x-bitbucket-api-token-auth:<api_token>` (the stored
 *    username, the account's email, is Bitbucket's *REST* convention, not
 *    its *git* one — the email itself is never sent to git); a Bearer
 *    (workspace/repo access token) credential is sent as
 *    `x-token-auth:<token>`.
 *
 * Never logs, and never includes the resolved token in a thrown error or
 * return value beyond the header line itself — callers must not log this
 * return value either.
 */
export async function cloneAuthHeader(provider: GitProvider, rawHost: string): Promise<string | null> {
  let userpass: string | null = null;
  if (provider === "github") {
    const token = await githubToken(rawHost);
    if (token) userpass = `x-access-token:${token}`;
  } else if (provider === "gitlab") {
    const token = await gitlabToken(rawHost);
    if (token) userpass = `oauth2:${token}`;
  } else {
    const creds = await bitbucketCreds(rawHost);
    if (creds) {
      userpass =
        creds.kind === "basic"
          ? `x-bitbucket-api-token-auth:${creds.password}`
          : `x-token-auth:${creds.token}`;
    }
  }
  if (!userpass) return null;
  return `Authorization: Basic ${Buffer.from(userpass).toString("base64")}`;
}

/**
 * Builds the ADDITIVE `GIT_CONFIG_*` env entries that scope `auth.header` to
 * `auth.origin` for exactly one retried clone attempt — never persisted to
 * `.git/config`, never visible in `ps` (env, not argv), and never sent to any
 * origin but `auth.origin` itself (git's own `http.<url>.*` URL-scoping
 * rule). Pure: takes the base env to read any pre-existing
 * `GIT_CONFIG_COUNT` from and returns ONLY the new keys to merge on top —
 * callers spread `{ ...baseEnv, ...cloneAuthEnv(baseEnv, auth) }`.
 *
 * Appends after `baseEnv.GIT_CONFIG_COUNT` (defaulting to 0 when absent or
 * not a non-negative integer) rather than starting at 0, so this composes
 * with any config a caller already injected via the same mechanism — spike-
 * verified (git 2.54, scratchpad `spikes/git-env-auth/`) that a higher
 * `GIT_CONFIG_COUNT` with intervening `GIT_CONFIG_KEY_n`/`VALUE_n` pairs is
 * exactly how git's own docs say to compose multiple env-sourced config
 * entries.
 *
 * `http.followRedirects=false` is appended alongside the auth header, not
 * optional: the same spike found that with git's default
 * `http.followRedirects=initial`, a 301 from the credentialed host silently
 * carries the `Authorization` header to the redirect TARGET's origin on the
 * follow-up `git-upload-pack` request(s) — this is the leak `authOrigin`'s
 * origin-scoping is supposed to prevent, and origin-scoping the header alone
 * doesn't close it. With `followRedirects=false` the clone instead fails
 * with `The requested URL returned error: 301` and the redirect target sees
 * zero requests — `explainCloneFailure` turns that into an actionable
 * "repository has moved" message when this was the token attempt.
 */
export function cloneAuthEnv(
  baseEnv: Record<string, string | undefined>,
  auth: CloneAuth,
): Record<string, string> {
  const existingCount = Number(baseEnv.GIT_CONFIG_COUNT);
  const n = Number.isInteger(existingCount) && existingCount >= 0 ? existingCount : 0;
  return {
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: `http.${auth.origin}.extraheader`,
    [`GIT_CONFIG_VALUE_${n}`]: auth.header,
    [`GIT_CONFIG_KEY_${n + 1}`]: "http.followRedirects",
    [`GIT_CONFIG_VALUE_${n + 1}`]: "false",
  };
}

/**
 * Whether a clone's FULL (sanitized, size-bounded — see `sanitizeCloneStderr`)
 * stderr text (matched under `LC_ALL=C`, so these patterns hold regardless of
 * the user's locale) *looks like* the clone failed for an
 * authentication/authorization reason, as opposed to a local or network
 * problem (bad local path, DNS failure, disk full, a genuinely missing
 * binary, …). This is the ONE gate that decides whether it's worth resolving
 * and retrying with a credential — used both by `cloneRepo` (to decide
 * whether to call `opts.auth()` at all) and by `explainCloneFailure` (to
 * decide which hint to show) so the two can never drift apart: a failure
 * `cloneRepo` didn't consider worth a token retry can never later be
 * explained as if a token retry happened, and vice versa. Pure, exported for
 * unit testing, never throws.
 *
 * Takes the whole stderr blob rather than a single line — a real git-over-ssh
 * failure always ends with a fixed multi-line epilogue (`fatal: Could not
 * read from remote repository.` / blank / `Please make sure you have the
 * correct access rights` / `and the repository exists.`), and the actual
 * reason (a permission rejection, an auth rejection, a 404) sits on an
 * EARLIER line that a last-line-only match would never see. `runGitClone`
 * still derives a separate `displayLine` (via `pickCloneDisplayLine`) for
 * user-facing text — this function only ever answers yes/no.
 *
 * Every pattern below is written to stay linear-time on an arbitrarily long,
 * attacker-influenced line (a malicious remote controls its own `remote: …`
 * text) — no `.*`/`.+` is left unbounded between two literals, since that
 * turns a non-matching multi-megabyte line into a quadratic-time scan (every
 * failed start position re-scans forward with no cap). See the timing
 * regression test in `clone.test.ts`.
 *
 * Patterns: git's own "no credential helper answered" lines (`could not read
 * Username`/`Password`, `terminal prompts disabled`), an explicit auth
 * rejection (`Authentication failed`, `access denied` — covers GitLab's `HTTP
 * Basic: Access denied` verbatim), a repository the credential in hand
 * can't see (`repository … not found` / `Repository not found` — providers
 * deliberately 404 a private repo to an unauthorized caller rather than
 * confirming it exists), and the raw HTTP status codes that mean the same
 * thing (`401`/`403`/`404`).
 */
export function isAuthShapedCloneFailure(stderrText: string): boolean {
  return (
    /could not read Username/i.test(stderrText) ||
    /could not read Password/i.test(stderrText) ||
    /Authentication failed/i.test(stderrText) ||
    /terminal prompts disabled/i.test(stderrText) ||
    // Covers both GitHub's `remote: Repository not found.` line and the
    // `fatal: repository '<url>' not found` line git itself prints (the
    // quoted URL sits between the two words, so a literal "repository not
    // found" substring match would miss it) — bounded to a same-line,
    // ≤300-char gap (`[^\n]{0,300}?`) rather than an unbounded `.*`, which is
    // what makes this linear-time on a long single line (see the doc comment
    // above).
    /repository\b[^\n]{0,300}?not found/i.test(stderrText) ||
    /returned error: (401|403|404)\b/.test(stderrText) ||
    // GitLab's own wording for an authenticated-but-unauthorized request;
    // `access denied` alone (case-insensitive) already matches it, kept as
    // one general pattern rather than two redundant ones.
    /access denied/i.test(stderrText)
  );
}

/**
 * Maps a clone failure to actionable, user-facing copy — always keeping
 * `displayLine` (see `pickCloneDisplayLine`) first, then a hint sentence.
 * Pure and exported for unit testing; never throws. Falls through to
 * `displayLine`, unchanged, for anything it doesn't recognize.
 *
 * `stderrText` (matched under `LC_ALL=C`, so these patterns hold regardless
 * of the user's locale) is the FULL sanitized stderr — used only for
 * MATCHING (the auth-shaped gate, the moved/host-key/publickey/DNS
 * patterns), never shown to the user directly. `displayLine` is the single
 * line `runGitClone` already picked out as the useful one, and is what
 * actually leads the returned message — this split is what lets a real
 * git-over-ssh failure (whose epilogue buries the actual reason a few lines
 * above the generic `fatal: Could not read from remote repository.` closer)
 * match correctly AND display the right line, instead of the two being
 * forced to agree on one string. For every existing single-line test fixture
 * `stderrText === displayLine`, so nothing about the single-line cases below
 * changes.
 *
 * `ctx.usedToken` distinguishes "no credential attempt ran at all" (no
 * resolver was given, or it resolved to nothing) from "the credential that
 * was tried got rejected too", so the hint always points at the right next
 * step. `ctx.transport` matters because the token hints are https-only — an
 * ssh clone never has a stored token to blame or offer (`resolveCloneRepo`
 * never hands out an `authOrigin` for ssh), so an auth-shaped ssh failure
 * gets an SSH-key hint instead, and the DNS-failure hint's phrasing/next-step
 * differs by transport too.
 */
export function explainCloneFailure(
  stderrText: string,
  displayLine: string,
  ctx: { transport: "https" | "ssh"; host: string; usedToken: boolean },
): string {
  const { host, usedToken, transport } = ctx;

  if (isAuthShapedCloneFailure(stderrText)) {
    if (transport === "ssh") {
      return `${displayLine} — Your SSH key doesn't have access to this repository on ${host}, or the path is wrong — check the key loaded in your agent (ssh-add -l) and the repository path.`;
    }
    const authHint = usedToken
      ? `The stored credential for ${host} was rejected or doesn't grant access to this repository — check it in Settings → Git host tokens, and check the repository path.`
      : `If this is a private repository, add a token for ${host} in Settings → Git host tokens, or paste the SSH URL.`;
    return `${displayLine} — ${authHint}`;
  }

  const movedMatch = stderrText.match(/returned error: (301|302|307|308)\b/);
  if (movedMatch) {
    return usedToken
      ? `${displayLine} — The repository has moved — paste its current URL.`
      : displayLine;
  }

  if (/Host key verification failed/i.test(stderrText)) {
    return `${displayLine} — Run "ssh -T git@${host}" once in a terminal to trust the host, then retry.`;
  }

  if (/Permission denied \(publickey/i.test(stderrText)) {
    return `${displayLine} — No SSH key was accepted for ${host} — load your key (ssh-add) or paste the https URL instead.`;
  }

  // Widened beyond ssh's own "Could not resolve hostname" to also cover
  // git's http backend, which reports a DNS failure as "Could not resolve
  // host: <name>" (curl's wording) instead.
  if (/Could not resolve host(name)?/i.test(stderrText)) {
    if (transport === "ssh") {
      return `${displayLine} — "${host}" didn't resolve — if it's an SSH alias, check ~/.ssh/config.`;
    }
    const dotless = host.length > 0 && !host.includes(".");
    return `${displayLine} — "${host}" didn't resolve — check the host name${
      dotless ? " (an SSH alias only works with the SSH URL)" : ""
    }.`;
  }

  return displayLine;
}

/**
 * Where a clone lands when the user doesn't pick a destination. Mirrors how
 * projects on this machine already live directly under $HOME (~/agetor).
 */
export function defaultCloneDest(repo: string): string {
  return path.join(homedir(), repo);
}

export interface CloneResult {
  ok: boolean;
  error?: string;
  /** `true` only when this result came from `cancelClone` killing the
   *  in-flight git process for this clone — never set alongside `ok: true`,
   *  and never for an ordinary (non-cancelled) failure or timeout. Absent
   *  (not `false`) in every other case, so `result.cancelled` can be used as
   *  a truthy check without also checking `!result.ok`.
   *
   *  This is a real invariant, not just a convention: a `cancelClone` call
   *  can race in AFTER the underlying `git` process has already exited 0 but
   *  BEFORE `runGitClone` has finished draining its stderr pipe (the two are
   *  awaited together, and pipe EOF can lag process exit) — `handle.kill()`
   *  would set its local `cancelled` flag regardless of the exit code that
   *  already happened. `runGitClone` clears that flag whenever
   *  `exitCode === 0` (a clone that actually completed is never "cancelled",
   *  no matter what raced in against it — the project it produced is
   *  already usable), and `cloneRepo` additionally checks `ok` before
   *  `cancelled` at every branch point as a second, defensive line against
   *  the same shape of bug. */
  cancelled?: true;
}

/** Clones are network-bound and can legitimately take minutes on big repos. */
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

/** Retry floor (docs/plans/clone-repository-all-providers.md §3 D4). Once
 *  less than this remains of the shared `timeoutMs` budget after attempt 1,
 *  there isn't enough time left for a meaningful attempt 2 (git needs at
 *  least long enough to open a connection and get a first response), so
 *  `cloneRepo` skips the retry outright — reporting attempt 1's OWN
 *  (non-timeout) failure, not a fabricated timeout, since attempt 1 itself
 *  never ran out of time (see `cloneRepo`'s doc comment). */
const RETRY_MIN_TIMEOUT_MS = 5_000;

/** Renders a `cloneRepo` timeout budget as seconds below a minute (`"5
 *  seconds"`) or whole minutes otherwise (`"10 minutes"`) — a sub-minute
 *  `timeoutMs` (common in tests) used to round down to a useless "clone
 *  timed out after 0 minutes". */
function formatCloneTimeoutDuration(ms: number): string {
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  const minutes = Math.round(ms / 60_000);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export interface CloneOptions {
  /** The TOTAL wall-time budget for `cloneRepo`, shared across BOTH the
   *  anonymous attempt and the token retry (default `CLONE_TIMEOUT_MS`, 10
   *  minutes) — not a per-attempt timeout. Attempt 2 (if it runs at all)
   *  gets whatever remains after attempt 1, floored by `RETRY_MIN_TIMEOUT_MS`
   *  below which the retry is skipped outright — WITHOUT reporting a
   *  timeout, since attempt 1 itself didn't time out (its own explained
   *  failure is reported instead; see `cloneRepo`'s doc comment).
   *  `cloneRepo`'s own wall time is therefore bounded by `timeoutMs` plus
   *  the (separately, already-bounded) time `opts.auth()` itself takes to
   *  resolve — callers with their own outer timeout (the CLI's 15-minute
   *  client timeout) must budget for both. */
  timeoutMs?: number;
  /** Resolves the header line to retry with after an anonymous clone fails
   *  for what looks like an auth/authorization reason (see
   *  `isAuthShapedCloneFailure`) — never called for any other failure
   *  shape, and never called on an anonymous SUCCESS. A rejection is
   *  swallowed (treated as "no credential available") — see `cloneRepo`'s
   *  call site. */
  auth?: () => Promise<CloneAuth | null>;
  /** Only used to build `explainCloneFailure`'s context on the final
   *  failure — has no effect on how the clone itself runs. */
  transport?: "https" | "ssh";
  host?: string;
  /** Receives every progress update for this clone — one call per parsed
   *  git `--progress` record that survives the streaming reader's rate
   *  limit AND its hard per-clone forward budget (`readCloneStderrStream`,
   *  `CLONE_PROGRESS_MAX_EVENTS` — a remote that keeps a phase pinned at
   *  100% or alternates phases every record can otherwise force a forward
   *  on every single record, which the time-based rate limit alone does
   *  NOT catch), plus `cloneRepo`'s own synthetic `starting` (before
   *  attempt 1, and again before a token retry) and terminal
   *  `done`/`failed`/`cancelled` events (never rate-limited or budgeted —
   *  see `cloneRepo`'s doc comment). A throwing callback is swallowed at
   *  every call site (`readCloneStderrStream`'s `forward`, and `cloneRepo`'s
   *  own `emitProgress`) — this option must never be able to abort the
   *  clone or orphan the git child. Never receives a credential: git's
   *  progress lines never carry one, and `cloneRepo`'s own synthetic lines
   *  are static, credential-free text; every line — including one built
   *  from a failure message — is capped and control-character-stripped via
   *  `sanitizeCloneProgressLine` before it ever reaches this callback. */
  onProgress?: (progress: CloneProgress) => void;
  /** Registry key for `cancelClone` — when omitted, this clone can never be
   *  cancelled (there is nothing for `cancelClone` to look up). Callers that
   *  want cancellation must mint a stable id themselves and pass the SAME
   *  one on any matching `cancelClone(cloneId)` call. `cancelClone` honors
   *  this id for the FULL lifetime of the matching `cloneRepo` call — not
   *  just while a git child process happens to be running — see
   *  `pendingCloneIds`/`cancelRequested`. */
  cloneId?: string;
}

/** C0 (`0x00`–`0x1F`) and C1 (`0x7F`, `0x80`–`0x9F`) control characters,
 *  except `\n` (`0x0A`) and `\t` (`0x09`) — stripped from a clone's stderr
 *  before it's ever matched against a pattern or shown to the user (fix for
 *  a review finding: a malicious remote controls its own `remote: …` text,
 *  which could otherwise carry a raw ANSI escape sequence — e.g. a color
 *  code, or a cursor-movement sequence aimed at whatever terminal/log viewer
 *  eventually renders it). Removing the ESC (`0x1B`) introducer is what
 *  neutralizes an escape sequence: its trailing printable bytes (`[31m`, …)
 *  survive as harmless literal text instead of a control sequence. */
const CLONE_STDERR_CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/** Per-line and total-size caps applied to a clone's stderr AFTER control-
 *  character stripping (see `CLONE_STDERR_CONTROL_CHARS_RE`) — belt-and-
 *  suspenders alongside making every pattern in `isAuthShapedCloneFailure`/
 *  `explainCloneFailure` linear-time (their own doc comments): a remote-
 *  controlled line could otherwise be arbitrarily long, and even a linear
 *  scan across several regexes on a multi-megabyte string isn't free.
 *  `CLONE_STDERR_MAX_TOTAL_CHARS` is applied by keeping the TAIL
 *  (`.slice(-N)`), since the actionable line is always near the end. */
const CLONE_STDERR_MAX_LINE_CHARS = 500;
const CLONE_STDERR_MAX_LINES = 50;
const CLONE_STDERR_MAX_TOTAL_CHARS = 16 * 1024;

/** Hard cap on how many bytes of NON-progress ("error-candidate") text
 *  `readCloneStderrStream` accumulates into its returned error text —
 *  independent of, and larger than, `CLONE_STDERR_MAX_TOTAL_CHARS` above
 *  (which trims the already-decoded, already-record-split text one more
 *  time, and is what actually produces the final ~16 KB tail). This cap is
 *  scoped to non-progress bytes ONLY (review finding #1's fix): a record
 *  that parses as progress (`parseCloneProgress`) is forwarded to
 *  `onProgress` and NEVER counted against it and never accumulated at all —
 *  so an arbitrarily long flood of progress-shaped lines can never crowd out
 *  a real, later failure line the way it could when this cap gated the raw
 *  stream-read loop itself (the old behavior: once ANY 1 MB of raw bytes had
 *  been read, decoding stopped outright, discarding whatever arrived after —
 *  including a trailing `fatal: …` that happened to land after a big enough
 *  progress flood). Every record — progress or not — is still classified
 *  (`parseCloneProgress`, cheap, O(1)) for as long as the stream has more
 *  data; only the ACCUMULATION of non-progress text into the returned
 *  string stops once this cap is reached, which is deliberately acceptable
 *  (“keep parsing to classify-and-drop” — O(records), not O(bytes) of
 *  decode-and-store). */
const CLONE_STDERR_READ_CAP_BYTES = 1 * 1024 * 1024;

/**
 * Sanitizes+bounds a clone's raw stderr exactly once, in `runGitClone`,
 * before the result is ever handed to `isAuthShapedCloneFailure`,
 * `explainCloneFailure`, or `pickCloneDisplayLine`: strips control
 * characters (`CLONE_STDERR_CONTROL_CHARS_RE`), then caps each line to
 * `CLONE_STDERR_MAX_LINE_CHARS` and the whole text to the last
 * `CLONE_STDERR_MAX_LINES` lines / `CLONE_STDERR_MAX_TOTAL_CHARS`
 * characters. Exported for the timing regression test only. Pure, never
 * throws.
 */
export function sanitizeCloneStderr(raw: string): string {
  const stripped = raw.replace(CLONE_STDERR_CONTROL_CHARS_RE, "");
  const lines = stripped
    .split("\n")
    .map((line) => (line.length > CLONE_STDERR_MAX_LINE_CHARS ? line.slice(0, CLONE_STDERR_MAX_LINE_CHARS) : line));
  const bounded = lines.length > CLONE_STDERR_MAX_LINES ? lines.slice(-CLONE_STDERR_MAX_LINES) : lines;
  const joined = bounded.join("\n");
  return joined.length > CLONE_STDERR_MAX_TOTAL_CHARS ? joined.slice(-CLONE_STDERR_MAX_TOTAL_CHARS) : joined;
}

// ---------------------------------------------------------------------------
// Clone progress parsing + streaming reader + cancel (Addendum A,
// docs/plans/clone-repository-all-providers.md).
// ---------------------------------------------------------------------------

/** One progress update for an in-flight `git clone --progress`, as parsed
 *  by `parseCloneProgress` from a single `\r`/`\n`-delimited stderr record —
 *  or as synthesized directly by `cloneRepo` for its own `starting` (before
 *  attempt 1, and again before a token retry) and terminal `done`/`failed`/
 *  `cancelled` events, which never go through a real stderr record at all.
 *  Deliberately has no `cloneId`/`ts` — those are `AppEvent`-level framing
 *  the CALLER (`server.ts`) adds; this module only ever knows about ONE
 *  clone at a time per `cloneRepo` call, so it has nothing to stamp an id
 *  with. */
export interface CloneProgress {
  phase: CloneProgressPhase;
  /** `null` whenever the record didn't carry a percentage at all (e.g.
   *  `remote: Enumerating objects: N, done.`, which reports a raw count, not
   *  a fraction) — never a guess. Always an integer 0–100 when present, even
   *  if a malformed/adversarial record's own digits were out of range
   *  (`clampCloneProgressPercent`). */
  percent: number | null;
  /** The record (or synthetic message) this update came from — control
   *  characters stripped, trimmed, and capped at
   *  `CLONE_PROGRESS_LINE_MAX_CHARS` — safe to show verbatim in a progress
   *  UI. Never carries a credential: it's either one of git's own
   *  `--progress` lines (which never do) or one of `cloneRepo`'s own static,
   *  credential-free synthetic strings. */
  line: string;
}

/** Cap on `CloneProgress.line`'s length — see `CloneProgress`'s own doc
 *  comment. Applied AFTER control-character stripping and trimming, and
 *  well past where any of the patterns below extract their percentage (all
 *  within the first ~40 characters of a real git progress line), so capping
 *  never loses the phase/percent this function already parsed out — it only
 *  ever trims trailing noise (a long object-count tail, or an adversarially
 *  padded line). */
const CLONE_PROGRESS_LINE_MAX_CHARS = 200;

/** `git clone --progress`'s own "beginning the transfer" line — e.g.
 *  `Cloning into 'dest'...`. Matched as a fixed prefix (no capture group —
 *  this phase never carries a percentage). */
const CLONE_PROGRESS_STARTING_RE = /^Cloning into /;

/** `remote: Enumerating objects: N[, done.]` — reports a raw object count,
 *  not a percentage (git only starts showing a percentage once it knows the
 *  total, which Enumerating is still discovering) — mapped to the same
 *  `"counting"` phase as `remote: Counting objects: NN%` below, per the
 *  plan's phase table. No capture group; `percent` is always `null` for a
 *  line this pattern matches. Anchored end-to-end (review finding #6, same
 *  reasoning as the percent patterns below) — a REAL `remote: …` line this
 *  otherwise resembles but whose tail carries something else entirely (an
 *  attacker-appended error) must fall through to the error text instead of
 *  being swallowed as progress. */
const CLONE_PROGRESS_ENUMERATING_RE = /^remote: Enumerating objects:\s*\d+(?:,\s*done\.?)?\s*$/;

/** The five percentage-carrying phases below all share one shape:
 *  `<fixed label>: NN% (a/b)[, <throughput>][, done.]` — a fixed literal
 *  prefix, optional run-of-spaces padding (git pads with spaces to erase a
 *  longer previous line when a terminal is attached; `--progress` without a
 *  tty still writes them), then 1–3 percent digits, an optional `(a/b)`
 *  object count, an optional throughput suffix (`Receiving objects` only —
 *  e.g. `, 2.67 MiB | 40.26 MiB/s`, real captures in `clone.test.ts`), and an
 *  optional `, done.` closer — anchored end-to-end with `$` (review finding
 *  #6): the OLD prefix-only patterns matched `remote: Counting objects:
 *  50% (1/2) error: repository is archived` just as happily as a real
 *  progress line, silently dropping the ` error: …` tail from the returned
 *  error text. Anchoring closes that: any trailing content that isn't one of
 *  the shapes git itself actually emits now falls through and the WHOLE
 *  record is treated as (potential) error text instead. Every pattern here
 *  still separates each literal/character-class boundary with only `\s*`
 *  or a single alternation — no unbounded `.*`/`.+`, and no two adjacent
 *  quantified groups that could backtrack against each other — so these
 *  stay linear-time regardless of how long an adversarial line is (see the
 *  ReDoS linearity test in `clone.test.ts`). */
const CLONE_PROGRESS_DONE_SUFFIX = String.raw`(?:,\s*done\.?)?\s*$`;
const CLONE_PROGRESS_COUNT_SUFFIX = String.raw`(?:\s*\(\d+\/\d+\))?`;
/** `, 2.67 MiB | 40.26 MiB/s` — the throughput suffix git appends only to
 *  `Receiving objects` (a raw byte/rate pair). Both halves take the same
 *  unit set — a `KMGT`-prefixed `iB` or plain `bytes` — because git's
 *  `strbuf_humanise_rate` prints a sub-KiB/s transfer as `NNN bytes/s`, not
 *  `0.xx KiB/s`, so a slow clone's records would otherwise fall through to
 *  the error text as "not progress". */
const CLONE_PROGRESS_THROUGHPUT_SUFFIX = String.raw`(?:,\s*[\d.]+\s*(?:[KMGT]iB|bytes)(?:\s*\|\s*[\d.]+\s*(?:[KMGT]iB|bytes)\/s)?)?`;
const CLONE_PROGRESS_COUNTING_RE = new RegExp(
  String.raw`^remote: Counting objects:\s*(\d{1,3})%${CLONE_PROGRESS_COUNT_SUFFIX}${CLONE_PROGRESS_DONE_SUFFIX}`,
);
const CLONE_PROGRESS_COMPRESSING_RE = new RegExp(
  String.raw`^remote: Compressing objects:\s*(\d{1,3})%${CLONE_PROGRESS_COUNT_SUFFIX}${CLONE_PROGRESS_DONE_SUFFIX}`,
);
const CLONE_PROGRESS_RECEIVING_RE = new RegExp(
  String.raw`^Receiving objects:\s*(\d{1,3})%${CLONE_PROGRESS_COUNT_SUFFIX}${CLONE_PROGRESS_THROUGHPUT_SUFFIX}${CLONE_PROGRESS_DONE_SUFFIX}`,
);
const CLONE_PROGRESS_RESOLVING_RE = new RegExp(
  String.raw`^Resolving deltas:\s*(\d{1,3})%${CLONE_PROGRESS_COUNT_SUFFIX}${CLONE_PROGRESS_DONE_SUFFIX}`,
);
const CLONE_PROGRESS_CHECKING_OUT_RE = new RegExp(
  String.raw`^Updating files:\s*(\d{1,3})%${CLONE_PROGRESS_COUNT_SUFFIX}${CLONE_PROGRESS_DONE_SUFFIX}`,
);

/** Clamps a percent-pattern capture group (always 1–3 ASCII digits per the
 *  regexes above, so always a finite, non-negative integer) to 0–100 — the
 *  `\d{1,3}` shape admits up to "999", which a malformed/adversarial record
 *  could in principle emit even though real git never does. */
function clampCloneProgressPercent(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/** Strips control characters (`CLONE_STDERR_CONTROL_CHARS_RE` — same rule
 *  `sanitizeCloneStderr` applies, so an ANSI-colored or otherwise
 *  control-character-laden record can't smuggle anything through either
 *  path) and trims git's own line-clearing space padding from both ends —
 *  deliberately WITHOUT capping length. `parseCloneProgress` matches its
 *  anchored (`$`-terminated) patterns against this UNCAPPED text on
 *  purpose: capping first, then anchor-matching the capped remainder, would
 *  make a genuinely well-formed but long record (git's own object counts
 *  are not bounded to any particular width) fail to match simply because
 *  its tail got truncated out from under the `$` anchor — the display cap
 *  belongs on the OUTPUT, not on what gets pattern-matched. */
function stripAndTrimProgressRecord(record: string): string {
  return record.replace(CLONE_STDERR_CONTROL_CHARS_RE, "").trim();
}

/** Caps a (already stripped/trimmed) line to `CLONE_PROGRESS_LINE_MAX_CHARS`
 *  — see `CloneProgress.line`'s own doc comment. Split out from
 *  `sanitizeCloneProgressLine` below so `parseCloneProgress` can apply it
 *  only to the OUTPUT, after matching against the uncapped text. */
function capProgressLineLength(line: string): string {
  return line.length > CLONE_PROGRESS_LINE_MAX_CHARS ? line.slice(0, CLONE_PROGRESS_LINE_MAX_CHARS) : line;
}

/** Strip + trim + cap in one call — for every caller that has no matching
 *  to do first (`cloneRepo`'s own synthetic/failure lines, which are never
 *  matched against a pattern, only ever displayed). `parseCloneProgress`
 *  does NOT use this — see `stripAndTrimProgressRecord`'s own doc comment
 *  for why matching needs the uncapped text. */
function sanitizeCloneProgressLine(record: string): string {
  return capProgressLineLength(stripAndTrimProgressRecord(record));
}

/**
 * Parses ONE `\r`- or `\n`-delimited record from a clone's stderr (as
 * `readCloneStderrStream` below splits it) into a `CloneProgress`, or
 * returns `null` when the record isn't one of the six phases git's
 * `--progress` output ever emits (docs/plans/clone-repository-all-
 * providers.md Addendum A's phase table) — most commonly `remote: Total …`
 * (a one-off summary line, not a percentage update) or a genuine error line,
 * neither of which is progress. Pure, exported for unit testing, never
 * throws.
 *
 * Order matters only in that every pattern is mutually exclusive by
 * construction (each has a distinct fixed literal prefix), so checking them
 * in any order yields the same result — listed here in the order git itself
 * emits them during a normal clone.
 *
 * Matches against the UNCAPPED, stripped/trimmed text
 * (`stripAndTrimProgressRecord`) — every pattern is anchored end-to-end
 * (review finding #6), so capping length BEFORE matching would make an
 * otherwise well-formed but long record (a huge repo's object counts have
 * no fixed width) fail to match purely because its closing `)`/`done.`/`$`
 * got truncated away. The returned `line` is capped separately
 * (`capProgressLineLength`), on the OUTPUT only, once a match is already
 * decided.
 */
export function parseCloneProgress(record: string): CloneProgress | null {
  const full = stripAndTrimProgressRecord(record);
  if (!full) return null;
  const line = capProgressLineLength(full);

  if (CLONE_PROGRESS_STARTING_RE.test(full)) return { phase: "starting", percent: null, line };
  if (CLONE_PROGRESS_ENUMERATING_RE.test(full)) return { phase: "counting", percent: null, line };

  const counting = full.match(CLONE_PROGRESS_COUNTING_RE);
  if (counting) return { phase: "counting", percent: clampCloneProgressPercent(counting[1]!), line };

  const compressing = full.match(CLONE_PROGRESS_COMPRESSING_RE);
  if (compressing) return { phase: "compressing", percent: clampCloneProgressPercent(compressing[1]!), line };

  const receiving = full.match(CLONE_PROGRESS_RECEIVING_RE);
  if (receiving) return { phase: "receiving", percent: clampCloneProgressPercent(receiving[1]!), line };

  const resolving = full.match(CLONE_PROGRESS_RESOLVING_RE);
  if (resolving) return { phase: "resolving", percent: clampCloneProgressPercent(resolving[1]!), line };

  const checkingOut = full.match(CLONE_PROGRESS_CHECKING_OUT_RE);
  if (checkingOut) return { phase: "checking-out", percent: clampCloneProgressPercent(checkingOut[1]!), line };

  return null;
}

/** Minimum interval between two forwarded progress events for the SAME
 *  phase, in `readCloneStderrStream`'s rate limiter below — see that
 *  function's doc comment for the two exceptions (a phase change, and
 *  `percent === 100`) that always forward immediately regardless of this
 *  interval. */
const CLONE_PROGRESS_MIN_INTERVAL_MS = 100;

/** Hard ceiling on how many progress events ONE `readCloneStderrStream` call
 *  (one clone attempt) will ever forward through `onProgress`, regardless of
 *  how the time-based rate limit above would otherwise decide (review
 *  finding #1). The time-based limiter alone is bypassable by a
 *  remote-controlled stream: a phase CHANGE and `percent === 100` are always
 *  forwarded immediately, with no interval check at all — so a remote that
 *  keeps alternating between two phases (`remote: Counting objects: 100%` /
 *  `remote: Compressing objects: 100%`, …) every record is a phase change on
 *  EVERY record, forwarding every single one no matter how fast they arrive
 *  (measured: 20,000 such records → 20,000 broadcasts). Past this budget,
 *  `readCloneStderrStream` forwards NOTHING further for the rest of this
 *  call — records keep being classified (cheap) and, if non-progress, still
 *  accumulate into the returned error text up to `CLONE_STDERR_READ_CAP_BYTES`
 *  — the only thing that stops is the `onProgress` broadcast. The one
 *  terminal event a caller is always guaranteed (`done`/`failed`/`cancelled`)
 *  is emitted directly by `cloneRepo` itself, not through this budget, so a
 *  caller never loses the ability to observe how the clone actually ended
 *  even after this ceiling is hit. */
export const CLONE_PROGRESS_MAX_EVENTS = 400;

/** A single pending (not-yet-`\r`/`\n`-terminated) record in
 *  `readCloneStderrStream` is force-flushed once it grows past this many
 *  characters, even with no separator in sight — otherwise a remote that
 *  never emits `\r`/`\n` at all (deliberately or not) could grow the
 *  reader's pending-record buffer without bound between separators, the
 *  same unbounded-buffer shape `CLONE_STDERR_READ_CAP_BYTES` guards against
 *  at the whole-stream level. Chosen well above any real git progress
 *  line's width (the longest observed real line, `Receiving objects: 100%
 *  (N/N), N.NN MiB | N.NN MiB/s, done.`, is under 80 characters). */
const CLONE_PROGRESS_MAX_PENDING_CHARS = 4096;

/**
 * Streaming replacement for the old whole-buffer `readBoundedCloneStderr`:
 * reads `stream` incrementally (never buffering the whole thing in memory
 * up front) and splits it on `\r`/`\n` into records, handing each complete
 * record to `parseCloneProgress`. A record that parses as progress is
 * forwarded to `onProgress` (rate-limited — see below) and is EXCLUDED from
 * this function's returned text — so a chatty progress stream can never
 * crowd a real error line out of the bounded 16 KB tail `sanitizeCloneStderr`
 * (run by the caller, `runGitClone`, exactly as it ran over
 * `readBoundedCloneStderr`'s return value before) keeps. A record that does
 * NOT parse as progress (a genuine error/info line, or the one-off `remote:
 * Total …` summary) is appended, one per line, to that returned text.
 *
 * Rate limiting is deliberately simple — no coalescing timer, nothing
 * queued: within one call, a phase CHANGE or `percent === 100` is always
 * forwarded immediately (so a phase's own start and its completion are
 * never dropped); every other record is forwarded only if at least
 * `CLONE_PROGRESS_MIN_INTERVAL_MS` has passed since the last one that WAS
 * forwarded — everything else in between is silently dropped, not
 * buffered. Two further guards close review finding #1's bypass, which the
 * time-based limiter alone does not catch: (1) a record whose `{phase,
 * percent}` is IDENTICAL to the immediately preceding record is never
 * forwarded, regardless of timing — a remote parked on `remote: Counting
 * objects: 100%` forever forwards it exactly once; (2) a hard ceiling,
 * `CLONE_PROGRESS_MAX_EVENTS`, on how many events this call will EVER
 * forward — closing the OTHER bypass: alternating between two DIFFERENT
 * phases every record, e.g. Counting/Compressing both pinned at 100%, is a
 * phase change on every single record and would otherwise forward all of
 * them unconditionally. State (`lastPhase`/`lastPercent`/`lastEmitAt`/
 * `forwardedCount`) is local to this one call (one attempt's stderr
 * stream), not shared across `cloneRepo`'s two attempts or with its own
 * synthetic events — see `cloneRepo`'s doc comment for why those are never
 * rate-limited or budgeted at all.
 *
 * Memory is bounded, but SCOPED to non-progress ("error-candidate") text
 * only (review finding #1's other half, `CLONE_STDERR_READ_CAP_BYTES`'s own
 * doc comment) — every chunk read off `stream` is always decoded and fed to
 * the record splitter for as long as the stream has data, so a long flood of
 * PROGRESS-shaped records preceding a real failure line can never prevent
 * that later line from being seen and classified; only the ACCUMULATION of
 * non-progress text into the returned string stops once that cap is
 * reached. `CLONE_PROGRESS_MAX_PENDING_CHARS` additionally force-flushes a
 * single record that never sees a `\r`/`\n` terminator at all, so one
 * enormous unterminated line can't grow the pending-record buffer without
 * bound either.
 *
 * Decodes with a single streaming `TextDecoder` across the whole read loop
 * (`{ stream: true }`, flushed once at EOF) rather than decoding each chunk
 * independently, so a multi-byte UTF-8 character split across two `read()`
 * chunks decodes correctly instead of producing replacement characters at
 * the boundary.
 *
 * A throwing `onProgress` callback is swallowed (review finding #7) — this
 * function's contract is to keep draining and classifying `stream` no
 * matter what the caller's own broadcast side-channel does.
 */
export async function readCloneStderrStream(
  stream: ReadableStream<Uint8Array>,
  onProgress?: (progress: CloneProgress) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  const errorLines: string[] = [];
  let pending = "";
  let errorTextBytes = 0;
  let lastPhase: CloneProgressPhase | null = null;
  let lastPercent: number | null = null;
  let lastEmitAt = 0;
  let forwardedCount = 0;

  const forward = (progress: CloneProgress) => {
    if (!onProgress) return;
    const isExactRepeat = progress.phase === lastPhase && progress.percent === lastPercent;
    const phaseChanged = progress.phase !== lastPhase;
    lastPhase = progress.phase;
    lastPercent = progress.percent;
    // Never forward an exact back-to-back repeat, regardless of timing —
    // closes the "parked at 100%" bypass (review finding #1).
    if (isExactRepeat) return;
    // Hard per-call ceiling — closes the "alternating phases" bypass, which
    // a phase-change-always-forwards rule alone cannot catch.
    if (forwardedCount >= CLONE_PROGRESS_MAX_EVENTS) return;
    const now = Date.now();
    if (phaseChanged || progress.percent === 100 || now - lastEmitAt >= CLONE_PROGRESS_MIN_INTERVAL_MS) {
      lastEmitAt = now;
      forwardedCount++;
      try {
        onProgress(progress);
      } catch {
        // A throwing onProgress must never abort stderr reading (review
        // finding #7) — see this function's own doc comment.
      }
    }
  };

  const flushRecord = (record: string) => {
    const progress = parseCloneProgress(record);
    if (progress) {
      forward(progress);
      return;
    }
    if (record.length === 0) return;
    // Scoped to NON-progress bytes only — see `CLONE_STDERR_READ_CAP_BYTES`'s
    // own doc comment (review finding #1). Past the cap, records are still
    // classified above (cheap, O(1)) but no longer accumulated here.
    if (errorTextBytes < CLONE_STDERR_READ_CAP_BYTES) {
      errorTextBytes += Buffer.byteLength(record, "utf8");
      errorLines.push(record);
    }
  };

  const feed = (text: string) => {
    for (const ch of text) {
      if (ch === "\r" || ch === "\n") {
        flushRecord(pending);
        pending = "";
      } else {
        pending += ch;
        if (pending.length > CLONE_PROGRESS_MAX_PENDING_CHARS) {
          flushRecord(pending);
          pending = "";
        }
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    feed(decoder.decode(value, { stream: true }));
  }
  feed(decoder.decode());
  if (pending.length > 0) flushRecord(pending);
  return errorLines.join("\n");
}

/** Kill handle for one in-flight `git clone` attempt, registered in
 *  `activeClones` under its `cloneId` for exactly the lifetime of that ONE
 *  attempt (`runGitClone`'s `finally`) — see `cancelClone`. */
interface ActiveCloneHandle {
  kill(): void;
}

/** `cloneId → ` the currently-running git attempt's kill handle, for every
 *  clone `cloneRepo` was given an `opts.cloneId` for. An entry exists ONLY
 *  while a `git clone` child process is actually running for that id —
 *  `runGitClone` registers it right after spawning and removes it in a
 *  `finally` right before returning. There IS a real window BETWEEN
 *  `cloneRepo`'s two attempts (and before attempt 1 ever spawns, and while
 *  `opts.auth()` itself is resolving — a `gh auth token` shellout can take
 *  hundreds of ms) where this map alone has nothing to kill — but that
 *  window is no longer a `cancelClone` no-op (review finding #2): see
 *  `pendingCloneIds`/`cancelRequested` below, which is what makes
 *  `cancelClone` correct for exactly that gap instead of merely documenting
 *  it away. */
const activeClones = new Map<string, ActiveCloneHandle>();

/** `cloneId → ` announced, for the FULL lifetime of one `cloneRepo` call
 *  that was given that id — from `beginClone` (the very first line of the
 *  function body) to `endClone` in its `finally` (the very last thing that
 *  runs before the call settles), regardless of whether a git child process
 *  happens to be running at any given instant. This is what lets
 *  `cancelClone` answer `true` for a clone that's genuinely in flight but
 *  has no LIVE process yet — before attempt 1 spawns, between attempt 1 and
 *  a token retry, or while `opts.auth()` is still resolving (review finding
 *  #2) — distinct from `activeClones`, which only ever reflects a process
 *  that actually exists right now. */
const pendingCloneIds = new Set<string>();

/** `cloneId → ` a `cancelClone` call landed for this id while nothing in
 *  `activeClones` could act on it directly (see `pendingCloneIds` above).
 *  `cloneRepo` (and `runGitClone`, right after spawning) consume this via
 *  `consumeCancelRequest` at every point a cancellation could otherwise be
 *  lost: before attempt 1 ever calls `runGitClone`, right after `opts.auth()`
 *  resolves (before the retry's `runGitClone` call), and inside `runGitClone`
 *  itself immediately after `Bun.spawn` (covering the async GIT_SSH_COMMAND
 *  probe that can run before a process exists to kill directly). Entries are
 *  removed by `consumeCancelRequest` on the read that finds one, and
 *  defensively by `endClone` too, so a cancellation can never leak from one
 *  clone into a LATER call that happens to reuse the same id. */
const cancelRequested = new Set<string>();

/** Announces `cloneId` as in flight (see `pendingCloneIds`) for the
 *  duration of one `cloneRepo` call — a no-op when `cloneId` is omitted
 *  (that clone can never be cancelled at all, exactly as before). */
function beginClone(cloneId: string | undefined): void {
  if (cloneId) pendingCloneIds.add(cloneId);
}

/** The other half of `beginClone` — always run from `cloneRepo`'s `finally`,
 *  regardless of how the call settled, so neither set can ever leak past
 *  one clone's lifetime. */
function endClone(cloneId: string | undefined): void {
  if (!cloneId) return;
  pendingCloneIds.delete(cloneId);
  cancelRequested.delete(cloneId);
}

/** Consumes (deletes) a pending cancellation latch for `cloneId` set by
 *  `cancelClone`, returning whether one was set. See `cancelRequested`'s own
 *  doc comment for the exact points `cloneRepo`/`runGitClone` call this. */
function consumeCancelRequest(cloneId: string | undefined): boolean {
  if (!cloneId) return false;
  return cancelRequested.delete(cloneId);
}

/**
 * Stops the clone registered under `cloneId` and returns `true` — or
 * returns `false`, doing nothing, when `cloneId` names no in-flight clone at
 * all: an unknown id, or one whose `cloneRepo` call has already settled.
 * Never throws.
 *
 * Two cases, both `true`:
 *  - A git child process is CURRENTLY running for this id (`activeClones`)
 *    — killed directly, exactly as before.
 *  - No process is running yet/right now, but a `cloneRepo` call for this
 *    id is still in flight (`pendingCloneIds`) — before attempt 1 spawns,
 *    between attempt 1 and a token retry, or while `opts.auth()` is
 *    resolving. The cancellation is LATCHED (`cancelRequested`) and honored
 *    the moment `cloneRepo`/`runGitClone` next check for it (review finding
 *    #2 — this is what closes the old "brief gap" no-op).
 *
 * Idempotent in the sense that matters: once a clone's `cloneRepo` call has
 * settled, `endClone` has removed both the pending and the requested entry,
 * so a SECOND `cancelClone(cloneId)` call after that point correctly returns
 * `false` — there is nothing left to cancel.
 */
export function cancelClone(cloneId: string): boolean {
  const handle = activeClones.get(cloneId);
  if (handle) {
    handle.kill();
    return true;
  }
  if (pendingCloneIds.has(cloneId)) {
    cancelRequested.add(cloneId);
    return true;
  }
  return false;
}

/** The fixed epilogue line git's ssh/git-shell backend always closes a
 *  failed fetch with — see `pickCloneDisplayLine`'s doc comment. Matched as
 *  an exact (trimmed) line, never as a substring, so a DIFFERENT, more
 *  specific `fatal:`-prefixed line (e.g. `fatal: repository '<url>' not
 *  found`) is never mistaken for this generic one. */
const CLONE_GENERIC_NO_REMOTE_FATAL = "fatal: Could not read from remote repository.";

/** Git's own noise wrapper lines around the actual failure reason — see
 *  `pickCloneDisplayLine`. Matched against an already-trimmed line.
 *
 *  The `"Cloning into '"` branch is dead in production as of Addendum A:
 *  `readCloneStderrStream` now recognizes that exact line as a `starting`
 *  progress record (`CLONE_PROGRESS_STARTING_RE`) and excludes it from the
 *  text this function ever sees at all. It's kept (a) so a direct unit-test
 *  call to `pickCloneDisplayLine`/`isNoiseCloneStderrLine` with a raw,
 *  hand-built stderr string — bypassing the streaming reader entirely, as
 *  several existing fixtures in `clone.test.ts` do — still behaves exactly
 *  as documented, and (b) as a defensive no-op should some future caller
 *  ever feed this function un-stripped stderr again. */
function isNoiseCloneStderrLine(line: string): boolean {
  return (
    line === "Please make sure you have the correct access rights" ||
    line === "and the repository exists." ||
    line.startsWith("Cloning into '") ||
    /^warning:/i.test(line)
  );
}

/**
 * Picks the single most useful line out of a clone's (already sanitized —
 * see `sanitizeCloneStderr`) stderr for DISPLAY. Every git-over-ssh failure
 * ends with a FIXED multi-line epilogue: `fatal: Could not read from remote
 * repository.` / blank / `Please make sure you have the correct access
 * rights` / `and the repository exists.` — so naively keeping "the last
 * non-empty line" (the old behavior) always surfaces `and the repository
 * exists.`, no matter what actually failed, and leaves every ssh-specific
 * branch of `explainCloneFailure` (the auth hint, `Host key verification
 * failed`, `Permission denied (publickey`, `Could not resolve hostname`)
 * dead code.
 *
 * Scans non-empty (trimmed) lines from the END, skipping git's own noise
 * wrapper lines (`isNoiseCloneStderrLine`); the generic
 * `CLONE_GENERIC_NO_REMOTE_FATAL` closer is ALSO skipped, but only when a
 * more specific, earlier (i.e. still-surviving after the noise skip) line
 * remains underneath it — that earlier line is the actual reason the
 * epilogue is wrapping (`Host key verification failed.` / `git@host:
 * Permission denied (publickey).` / `ssh: Could not resolve hostname …` /
 * `ERROR: Repository not found.`, …). When nothing more specific survives
 * (the generic line is genuinely the only substantive one), it's returned
 * as-is — better than nothing. Falls back to the whole trimmed text when
 * every line was noise (defensive; a real failure always has at least one
 * substantive line).
 *
 * Verified against two REAL captures (git 2.51, macOS, `GIT_SSH_COMMAND="ssh
 * -o BatchMode=yes"`, no network required — see `clone.test.ts`): `git clone
 * ssh://git@127.0.0.1:2/does/not/exist.git` (connection refused) and a
 * clone against an unresolvable hostname, both of which print exactly this
 * epilogue shape around the real ssh-layer error line.
 */
export function pickCloneDisplayLine(stderrText: string): string {
  const lines = stderrText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const substantive = lines.filter((line) => !isNoiseCloneStderrLine(line));
  if (substantive.length === 0) return stderrText.trim();

  let end = substantive.length;
  while (end > 1 && substantive[end - 1] === CLONE_GENERIC_NO_REMOTE_FATAL) {
    end--;
  }
  return substantive[end - 1]!;
}

/** One `git clone -- <url> <dest>` attempt. Shared by both the anonymous and
 *  the token-retry attempt in `cloneRepo` below — the only difference between
 *  them is `extraEnv`. Sets `GIT_TERMINAL_PROMPT=0` plus an empty
 *  `GIT_ASKPASS` (never hang on a credential prompt agetor can't answer —
 *  neither the tty one nor a configured askpass helper) and `LC_ALL=C` (so
 *  `explainCloneFailure`'s patterns match regardless of the user's locale).
 *  When neither `GIT_SSH_COMMAND` (env) nor `core.sshCommand` (git config,
 *  `--global`/`--system` scope only — see below) is already set, also sets
 *  `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` so an ssh clone can't hang on a
 *  host-key or passphrase prompt either — a user who already configured
 *  their own ssh command is left alone.
 *
 *  Returns BOTH the full sanitized+bounded stderr (`stderr`, for
 *  `isAuthShapedCloneFailure`/`explainCloneFailure`'s pattern matching) and a
 *  single `displayLine` (`pickCloneDisplayLine`, for the leading sentence of
 *  a user-facing message) — see those functions' doc comments for why the
 *  two are no longer the same string.
 *
 *  Passes `--progress` (so git emits its progress records even though
 *  stderr is a pipe, not a tty) and reads that stderr through
 *  `readCloneStderrStream`, forwarding parsed progress to `opts.onProgress`
 *  and excluding it from the returned `stderr`/`displayLine` — see that
 *  function's doc comment. When `opts.cloneId` is given, registers a kill
 *  handle in `activeClones` for the exact lifetime of THIS ONE attempt's
 *  child process (removed in the `finally` below, unconditionally, before
 *  returning) — `cancelClone(cloneId)` calls that handle's `kill`, which
 *  sets `cancelled` (read back below, alongside `timedOut`) before actually
 *  killing the process, so a cancelled attempt is distinguishable from an
 *  ordinary failure or a timeout even though both end in a non-zero exit
 *  code from `proc.kill()`. */
async function runGitClone(
  source: string,
  dest: string,
  extraEnv: Record<string, string>,
  timeoutMs: number,
  opts: { cloneId?: string; onProgress?: (progress: CloneProgress) => void } = {},
): Promise<{ ok: boolean; stderr: string; displayLine: string; timedOut: boolean; cancelled: boolean }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    // `GIT_TERMINAL_PROMPT=0` only silences the tty prompt. A configured
    // askpass helper — `GIT_ASKPASS`, `core.askPass`, or `SSH_ASKPASS` — is
    // consulted BEFORE the terminal and would still fire (a GUI credential
    // dialog, or a helper that blocks). An EMPTY `GIT_ASKPASS` short-circuits
    // that whole lookup in git (`credential.c`: a set-but-empty value wins
    // over `core.askPass`/`SSH_ASKPASS` and disables the prompt), so the
    // anonymous attempt fails fast and the token retry path stays the only
    // way a credential ever reaches the clone.
    GIT_ASKPASS: "",
    LC_ALL: "C",
    ...extraEnv,
  };
  if (!process.env.GIT_SSH_COMMAND) {
    // Deliberately `--global`/`--system` only, NOT the scopeless `git config
    // --get` this used to run: unscoped resolution also reads `--local`
    // config off whatever repo happens to be at the daemon's cwd — a repo
    // that has nothing to do with the one being cloned into `dest` (which
    // doesn't exist as a git repo yet anyway). A user's own ssh setup lives
    // at the global/system scope; probed concurrently since they're
    // independent reads, each bounded by its own timeout exactly as before.
    const [globalSshCommand, systemSshCommand] = await Promise.all([
      run(["git", "config", "--global", "--get", "core.sshCommand"], undefined, 2_000),
      run(["git", "config", "--system", "--get", "core.sshCommand"], undefined, 2_000),
    ]);
    const hasConfiguredSshCommand =
      (globalSshCommand.ok && !!globalSshCommand.stdout) ||
      (systemSshCommand.ok && !!systemSshCommand.stdout);
    if (!hasConfiguredSshCommand) {
      env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
    }
  }

  const proc = Bun.spawn(["git", "clone", "--progress", "--", source, dest], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  let timedOut = false;
  let cancelled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  let handle: ActiveCloneHandle | undefined;
  if (opts.cloneId) {
    handle = {
      kill: () => {
        cancelled = true;
        proc.kill("SIGTERM");
      },
    };
    activeClones.set(opts.cloneId, handle);
    // A cancellation could have been REQUESTED (review finding #2) any time
    // between `cloneRepo` announcing this id and this exact line — most
    // notably during the async GIT_SSH_COMMAND probe above, which has
    // nothing in `activeClones` to kill while it runs. Consume that latch
    // now that a real process exists to act on.
    if (consumeCancelRequest(opts.cloneId)) handle.kill();
  }
  try {
    const [rawStderr, exitCode] = await Promise.all([
      readCloneStderrStream(proc.stderr, opts.onProgress),
      proc.exited,
    ]);
    const stderr = sanitizeCloneStderr(rawStderr);
    const displayLine = stderr.trim() ? pickCloneDisplayLine(stderr) : `git exited ${exitCode}`;
    // A `cancelClone` call can race in AFTER `proc.exited` has already
    // resolved 0 but BEFORE this `Promise.all` itself resolves (stderr EOF
    // can lag process exit) — `handle.kill()` would have set `cancelled`
    // regardless. A clone that actually completed is never "cancelled",
    // no matter what raced in against it (review finding #5).
    const reportedCancelled = cancelled && exitCode !== 0;
    return { ok: exitCode === 0, stderr, displayLine, timedOut, cancelled: reportedCancelled };
  } finally {
    clearTimeout(timer);
    // Only remove OUR OWN registration — a fresh attempt (the retry) may
    // already have overwritten this cloneId's entry with its own handle by
    // the time this `finally` runs (it can't in practice, since `cloneRepo`
    // never starts attempt 2 before attempt 1's `runGitClone` promise has
    // settled, but the identity check costs nothing and documents the
    // invariant rather than assuming it).
    if (opts.cloneId && activeClones.get(opts.cloneId) === handle) {
      activeClones.delete(opts.cloneId);
    }
  }
}

/** Refuses an existing non-empty destination (git would too, but this gives
 *  a clean message instead of git's stderr); creates the destination's
 *  parent directory otherwise. Shared by `cloneRepo`'s pre-attempt-1 check
 *  and its pre-attempt-2 recheck (docs/plans/clone-repository-all-providers.md
 *  §3 D4) — the second call is a no-op in the common case (git already left
 *  `dest` exactly as this function would), and only matters when something
 *  external changed `dest` between the two attempts. */
function checkCloneDestination(dest: string): CloneResult {
  if (existsSync(dest)) {
    let empty = false;
    try {
      empty = readdirSync(dest).length === 0;
    } catch {
      return { ok: false, error: `destination is not a readable directory: ${dest}` };
    }
    if (!empty) return { ok: false, error: `destination already exists and is not empty: ${dest}` };
    return { ok: true };
  }
  try {
    mkdirSync(path.dirname(dest), { recursive: true });
  } catch (err) {
    return { ok: false, error: `cannot create parent directory: ${String(err)}` };
  }
  return { ok: true };
}

/**
 * Restores `dest` to the "either absent or an empty directory" state
 * `cloneRepo` promises after a CANCELLED attempt. Git's own clean-up (which
 * `cloneRepo`'s doc comment already relies on between an ordinary failed
 * attempt 1 and a retry) does NOT apply here — verified empirically (git
 * 2.54, `SIGTERM` sent ~300ms into a real clone, both against a fresh `dest`
 * and a pre-existing EMPTY one): a killed `git clone` leaves whatever it had
 * already written — a partial `.git/` plus however many working-tree files
 * it had checked out — sitting in `dest` untouched, in both cases.
 *
 * `preExisted` is `dest`'s state from BEFORE `cloneRepo` ever ran (captured
 * once, at the very top of `cloneRepo`, before `checkCloneDestination`'s own
 * side-effecting `mkdirSync`); `startedAt` is that same call's own
 * `Date.now()`, captured just before attempt 1 ever spawns:
 *  - When `dest` did NOT pre-exist, this call (directly, or via
 *    `runGitClone`'s `git clone`) is what created it — but ONLY if it's
 *    still, right now, a real directory and not a symlink (review finding
 *    #3): something else could have swapped `dest` out from under a
 *    long-running clone between `checkCloneDestination` and this point, and
 *    blindly recursing through whatever now sits at that path — possibly a
 *    symlink to somewhere that has nothing to do with this clone — would be
 *    a TOCTOU deletion of arbitrary attacker-chosen content. `lstatSync`
 *    (never `statSync`) is what makes the check about `dest`'s OWN identity
 *    rather than whatever it might point to. When the guard passes, `dest`
 *    ends up ABSENT, as if the clone had never been attempted.
 *  - When `dest` DID pre-exist, the directory ENTRY itself is left alone —
 *    never removed or recreated, since it may be a deliberately chosen
 *    mount point, a symlink, or simply the user's own folder. Its CONTENTS
 *    are pruned back toward the empty state `checkCloneDestination` observed
 *    there before this call started, but — review finding #3's TOCTOU fix —
 *    only entries this clone attempt could plausibly have written are
 *    removed: `.git` unconditionally (git always names it exactly that,
 *    every time), and any OTHER entry only when its own `lstatSync` (never
 *    followed through a symlink) birth time — `ctime` as the fallback on a
 *    platform/filesystem that doesn't report `birthtime`, e.g. most Linux
 *    filesystems — is at or after `startedAt`. An entry that was already
 *    sitting in `dest` before this attempt ever started (impossible via the
 *    up-front emptiness check, but reachable if something else populated
 *    `dest` mid-clone with an OLD file, e.g. by moving one in from
 *    elsewhere) survives untouched.
 *
 *    Residual risk, documented rather than silently assumed away: the age
 *    check is a PROXY for "git wrote this," not a real identity check —
 *    this module has no way to enumerate exactly which top-level entries a
 *    checkout wrote. Something else that writes a NEW file into `dest`
 *    during the narrow window this clone attempt is actually running will
 *    still be swept up by the age check, exactly as it always was before
 *    this fix. What changed is narrower and still real: a file that was
 *    already there — the case the old code deleted unconditionally and
 *    silently — now survives.
 *
 * Best-effort: a removal (or a stat) that itself throws (a permissions
 * quirk, a file that vanished between the listing and the removal) is
 * swallowed rather than surfaced — cancellation must not itself fail the
 * caller.
 */
function cleanupCancelledCloneDest(dest: string, preExisted: boolean, startedAt: number): void {
  if (!preExisted) {
    try {
      const st = lstatSync(dest);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        rmSync(dest, { recursive: true, force: true });
      }
    } catch {
      // Best-effort — see doc comment above (also covers `dest` never
      // having existed at all, e.g. a cancellation before git ever wrote
      // anything).
    }
    return;
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(dest);
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(dest, entry);
    try {
      if (entry === ".git") {
        rmSync(entryPath, { recursive: true, force: true });
        continue;
      }
      const st = lstatSync(entryPath);
      const createdAt = st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs;
      if (createdAt >= startedAt) {
        rmSync(entryPath, { recursive: true, force: true });
      }
    } catch {
      // Best-effort — see doc comment above.
    }
  }
}

/**
 * `git clone -- <url> <dest>`, with an anonymous-first / token-on-failure
 * retry (docs/plans/clone-repository-all-providers.md §3 D4). Never throws —
 * callers inspect `ok`/`error`.
 *
 * Refuses an existing non-empty destination up-front via
 * `checkCloneDestination` (git would too, but this gives a clean message
 * instead of git's stderr).
 *
 * Attempt 1 runs anonymously, exactly like a plain `git clone`, against the
 * FULL `timeoutMs` budget. If it fails and did NOT time out, the retry only
 * happens when BOTH `opts.auth` is given AND the failure actually LOOKS
 * auth-shaped (`isAuthShapedCloneFailure` on attempt 1's FULL stderr text) —
 * a non-auth failure (bad local path, DNS failure, disk full, …) never calls
 * `opts.auth` and never shells out to whatever credential helper it uses
 * (`gh`/`glab`/…). When the gate passes: `timeoutMs` is a budget SHARED by
 * both attempts, not per-attempt — attempt 2 gets only what's left after
 * attempt 1 (`Date.now()`-measured), floored by `RETRY_MIN_TIMEOUT_MS`; below
 * that floor there isn't enough time left for a meaningful second attempt,
 * so the retry is skipped entirely (no `opts.auth()` call either) — WITHOUT
 * reporting a timeout, since attempt 1 itself never ran out of time; its own
 * explained failure is reported instead, exactly as the destination-recheck
 * branch immediately below already does. `checkCloneDestination` is
 * re-run first (in case attempt 1, or something external, left `dest` in a
 * state a second `git clone` shouldn't run into — see below); if that fails,
 * attempt 1's own failure is what gets reported (via `explainCloneFailure`,
 * `usedToken: false` — no token attempt actually ran), not a destination
 * error, since attempt 1's failure is the more useful thing to tell the
 * user about. Only once both checks pass is `opts.auth()` awaited
 * (rejections swallowed to `null` — a credential-resolution hiccup should
 * degrade to "no credential", not blow up the clone); if it yields a
 * `CloneAuth`, attempt 2 re-runs with `cloneAuthEnv`'s additive
 * `GIT_CONFIG_*` env layered on top, budgeted with whatever time remained.
 * The anonymous-success path never calls `opts.auth` at all — a token must
 * never be sent for a clone that already worked without one (a public repo,
 * or a private one already trusted via the user's ambient git credential
 * helper).
 *
 * `cloneRepo`'s own wall time is therefore bounded by `opts.timeoutMs` (or
 * `CLONE_TIMEOUT_MS`, 10 minutes, by default) plus whatever `opts.auth()`
 * itself takes to resolve (already independently bounded by its own
 * resolver) — a caller with its own outer deadline (the CLI's 15-minute
 * client timeout) must budget for both.
 *
 * Git itself cleans up between attempts: on a failed clone it removes any
 * destination directory IT created, and leaves a pre-existing empty
 * destination directory (the retry's `dest`) empty rather than partially
 * populated — verified locally against a failing clone (git 2.54) — which is
 * why the pre-attempt-2 recheck above is normally a no-op and only earns its
 * keep against something external changing `dest` mid-clone.
 *
 * The final error always reflects the LAST attempt's stderr, run through
 * `explainCloneFailure` with `usedToken` set from whether a retry actually
 * ran (`ctx.transport`/`ctx.host` come from `opts`, for its ssh-vs-https and
 * hostname-specific copy). When the shared budget runs out BEFORE a retry
 * ever starts (the `RETRY_MIN_TIMEOUT_MS` floor above), the error still
 * reflects attempt 1's own (non-timeout) failure, never a fabricated
 * timeout — attempt 1 itself didn't time out, so reporting one would be
 * misleading; a genuine timeout is only ever reported when `runGitClone`
 * itself says `timedOut: true` for the attempt that actually ran out of
 * time. `formatCloneTimeoutDuration` renders that message in seconds below
 * a minute (`"5 seconds"`) rather than rounding down to a useless "0
 * minutes".
 *
 * Addendum A (progress + cancel): emits a synthetic `starting` progress
 * event (`opts.onProgress`, never rate-limited or budgeted — there are at
 * most four of these for the whole call) before attempt 1 begins, and again
 * right before a token retry actually starts (i.e. only once `opts.auth()`
 * has resolved a real credential — never for a retry that doesn't happen).
 * Every git `--progress` record parsed out of either attempt's stderr is
 * forwarded too, through `runGitClone`/`readCloneStderrStream`. Exactly one
 * terminal `done`/`failed`/`cancelled` event is emitted for every possible
 * return — the `finish` wrapper below is what guarantees this regardless of
 * which branch produced the result, so a caller (`server.ts`) never has to
 * guess whether more progress is coming. A `failed` event's line is built
 * from the last attempt's own (short, git-produced) `displayLine` rather
 * than the full user-facing `error` text (review finding #4 — that text can
 * carry a hint sentence plus up to ~500 chars of remote-controlled prose),
 * and every synthetic line here — `starting`/`done`/`failed`/`cancelled`
 * alike — is run through the same `sanitizeCloneProgressLine` cap git's own
 * progress lines get, via the `emitProgress` helper below, which also
 * swallows a throwing `onProgress` (review finding #7) so a broadcaster bug
 * can never abort the clone or orphan the git child.
 *
 * When `opts.cloneId` is given, this id is announced as in flight
 * (`beginClone`/`endClone`, review finding #2) for the WHOLE duration of
 * this call, not just while a git child process happens to exist — so
 * `cancelClone(opts.cloneId)` is honored even before attempt 1 spawns, in
 * the gap between attempt 1 and a token retry, and while `opts.auth()`
 * itself is resolving (a `gh auth token` shellout can take hundreds of ms).
 * `cloneRepo` (and `runGitClone`, right after `Bun.spawn`) consume that
 * latch at every one of those points via `consumeCancelRequest`. A
 * cancelled attempt short-circuits — no retry, no `explainCloneFailure`
 * copy — straight to `{ ok: false, cancelled: true, error: "clone
 * cancelled" }`, after `cleanupCancelledCloneDest` restores `dest` to
 * absent-or-empty (git's own on-failure clean-up, relied on elsewhere in
 * this doc comment, does NOT apply to a `SIGTERM` — see that function's own
 * doc comment).
 */
export async function cloneRepo(
  cloneUrl: string,
  dest: string,
  opts: CloneOptions = {},
): Promise<CloneResult> {
  const { onProgress, cloneId } = opts;
  beginClone(cloneId);
  try {
    return await cloneRepoInner(cloneUrl, dest, opts, onProgress, cloneId);
  } finally {
    endClone(cloneId);
  }
}

/** The actual body of `cloneRepo`, split out only so `beginClone`/`endClone`
 *  can wrap it unconditionally via `try`/`finally` regardless of which
 *  branch below returns. See `cloneRepo`'s own doc comment for the full
 *  design. */
async function cloneRepoInner(
  cloneUrl: string,
  dest: string,
  opts: CloneOptions,
  onProgress: ((progress: CloneProgress) => void) | undefined,
  cloneId: string | undefined,
): Promise<CloneResult> {
  const destPreExisted = existsSync(dest);

  /** Never lets a throwing `onProgress` escape `cloneRepo` (review finding
   *  #7) — the git child (if any) has already been spawned or killed by the
   *  time this fires either way, so swallowing here only ever loses one
   *  broadcast, never the clone itself. */
  const emitProgress = (progress: CloneProgress): void => {
    if (!onProgress) return;
    try {
      onProgress(progress);
    } catch {
      // See doc comment above.
    }
  };

  /** Wraps every return value below to also emit the ONE terminal progress
   *  event (`done`/`failed`/`cancelled`) a caller is guaranteed to see
   *  regardless of which branch produced the result. `displayLine`, when
   *  given, is the last attempt's own short git-produced line — preferred
   *  over the full `result.error` text for a `failed` event (review finding
   *  #4); both are sanitized/capped regardless. `ok` is checked first
   *  (review finding #5) as a second, defensive line against `result` ever
   *  carrying both `ok: true` and `cancelled: true` (the actual fix is in
   *  `runGitClone`; this ordering costs nothing and documents the same
   *  invariant here too). */
  const finish = (result: CloneResult, displayLine?: string): CloneResult => {
    if (result.ok) {
      emitProgress({ phase: "done", percent: 100, line: sanitizeCloneProgressLine("clone complete") });
    } else if (result.cancelled) {
      emitProgress({
        phase: "cancelled",
        percent: null,
        line: sanitizeCloneProgressLine(result.error ?? "clone cancelled"),
      });
    } else {
      const failLine = displayLine ? `clone failed: ${displayLine}` : result.error ?? "clone failed";
      emitProgress({ phase: "failed", percent: null, line: sanitizeCloneProgressLine(failLine) });
    }
    return result;
  };

  const destCheck1 = checkCloneDestination(dest);
  if (!destCheck1.ok) return finish(destCheck1);

  // Never rate-limited or budgeted — see this function's own doc comment
  // above. Sanitized/capped like every other synthetic line here (review
  // finding #4), though this particular constant string never needs it.
  // Deliberately emitted AFTER `checkCloneDestination`, not before it: a
  // caller never sees "starting" for an attempt that immediately refuses on
  // a bad destination, and — just as importantly for `startedAt` below —
  // this is the ONE hook a caller has to observe (and act on, e.g. via
  // `cancelClone`) the exact instant `checkCloneDestination` finished
  // validating `dest`, before this attempt has done anything else at all.
  emitProgress({ phase: "starting", percent: null, line: sanitizeCloneProgressLine("Cloning …") });

  // Test seam, same philosophy as AGETOR_CLAUDE_BIN=/bin/echo elsewhere:
  // endpoint tests point this at a local fixture repo so the /projects/clone
  // route is exercised end to end without the network. Never set in production.
  const source = process.env.AGETOR_CLONE_SOURCE_OVERRIDE || cloneUrl;
  const timeoutMs = opts.timeoutMs ?? CLONE_TIMEOUT_MS;
  const host = opts.host ?? "";
  const transport = opts.transport ?? "https";
  // Captured AFTER the `starting` emit above (review finding #3): anything
  // a caller's `onProgress` callback did synchronously in response to that
  // event — including `cleanupCancelledCloneDest`'s TOCTOU guard's exact
  // scenario, a file dropped into `dest` right then — necessarily predates
  // this timestamp, so `cleanupCancelledCloneDest` can tell it apart from
  // anything THIS attempt (git, or a retry) goes on to create afterward.
  const startedAt = Date.now();
  const timedOutResult = (): CloneResult => ({
    ok: false,
    error: `clone timed out after ${formatCloneTimeoutDuration(timeoutMs)}`,
  });
  const cancelledResult = (): CloneResult => {
    cleanupCancelledCloneDest(dest, destPreExisted, startedAt);
    return { ok: false, cancelled: true, error: "clone cancelled" };
  };

  // Review finding #2: a cancellation requested before attempt 1 ever
  // spawns (this clone was already announced as pending by `cloneRepo`
  // above) is honored right here — no git child is spawned at all.
  if (consumeCancelRequest(cloneId)) return finish(cancelledResult());

  const attempt1 = await runGitClone(source, dest, {}, timeoutMs, { cloneId, onProgress });
  if (attempt1.ok) return finish({ ok: true });
  if (attempt1.cancelled) return finish(cancelledResult());
  if (attempt1.timedOut) return finish(timedOutResult());
  // Attempt 1's own (non-timeout) failure, run through `explainCloneFailure`
  // with `usedToken: false` — reused by both early-return branches below
  // (not enough budget left for a retry; `dest` no longer safe to retry
  // into), since attempt 1's failure is the more useful thing to tell the
  // user about than a destination error, and — per the fix below — a
  // fabricated timeout is never useful when nothing actually timed out.
  const attempt1FailureResult: CloneResult = {
    ok: false,
    error: `clone failed: ${explainCloneFailure(attempt1.stderr, attempt1.displayLine, { transport, host, usedToken: false })}`,
  };

  let usedToken = false;
  let last: { ok: boolean; stderr: string; displayLine: string; timedOut: boolean; cancelled: boolean } = attempt1;
  if (opts.auth && isAuthShapedCloneFailure(attempt1.stderr)) {
    // Review finding #2: a cancellation that arrived any time during
    // attempt 1 but after attempt 1 itself already settled (non-cancelled)
    // is honored here, before doing any more work toward a retry.
    if (consumeCancelRequest(cloneId)) return finish(cancelledResult());

    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs < RETRY_MIN_TIMEOUT_MS) {
      // Attempt 1 itself did NOT time out (checked above) — there's simply
      // not enough of the SHARED budget left for a meaningful retry. This
      // used to report a timeout here regardless, which was wrong: nothing
      // timed out, so surface attempt 1's own explained failure instead,
      // exactly like the no-retry-attempted path below already does.
      return finish(attempt1FailureResult, attempt1.displayLine);
    }

    const destCheck2 = checkCloneDestination(dest);
    if (!destCheck2.ok) {
      return finish(attempt1FailureResult, attempt1.displayLine);
    }

    const auth = await opts.auth().catch(() => null);
    // Review finding #2: `opts.auth()` can itself take hundreds of ms (a
    // `gh auth token` shellout) — a cancellation that arrived while it was
    // resolving is honored here, before the retry's `runGitClone` call,
    // regardless of whether a credential actually came back.
    if (consumeCancelRequest(cloneId)) return finish(cancelledResult());
    if (auth) {
      usedToken = true;
      // Only emitted once a real credential resolved — never for a retry
      // that, per the gates above, isn't actually about to run.
      emitProgress({
        phase: "starting",
        percent: null,
        line: sanitizeCloneProgressLine("Retrying with stored credentials…"),
      });
      const extraEnv = cloneAuthEnv(process.env as Record<string, string | undefined>, auth);
      last = await runGitClone(source, dest, extraEnv, remainingMs, { cloneId, onProgress });
      if (last.ok) return finish({ ok: true });
      if (last.cancelled) return finish(cancelledResult());
      if (last.timedOut) return finish(timedOutResult());
    }
  }

  return finish(
    {
      ok: false,
      error: `clone failed: ${explainCloneFailure(last.stderr, last.displayLine, { transport, host, usedToken })}`,
    },
    last.displayLine,
  );
}

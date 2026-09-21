import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { GitProvider } from "../shared/types.ts";
import { CLONE_CLOUD_HOST, CLONE_SUPPORTED_HINT, parseCloneInput } from "../shared/clone-input.ts";
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
 *    whatever scheme/host/port was pasted — self-hosted GitLab is
 *    first-class in the integration (`gitlabApiBase`), unlike GHES.
 *  - **Bitbucket**: `bitbucketServerError` (the same guard every Bitbucket
 *    adapter call runs) rejects a genuine Server/Data Center domain up
 *    front; what's left after that guard passes is either `bitbucket.org`
 *    itself or a dotless alias, which gets the SSH hint (Bitbucket Cloud is
 *    the only https target this module knows how to build).
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
    // Self-hosted GitLab: keep whatever scheme/host/port was pasted. A
    // plain `http://` clone never gets a credential attached — sending a
    // token over an unencrypted origin would put it on the wire in the
    // clear.
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
        cloneUrl: `${scheme}://${rawHost}${portSuffix}/${v.fullPath}.git`,
        authOrigin: scheme === "https" ? `https://${rawHost}${portSuffix}/` : null,
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
 * Maps git/ssh's LAST stderr line (matched under `LC_ALL=C`, so these
 * patterns hold regardless of the user's locale) to actionable, user-facing
 * copy — always keeping the original line first, then a hint sentence.
 * `ctx.usedToken`/`ctx.tokenAvailable` distinguish "no credential exists for
 * this host" from "the credential that exists was rejected", so the hint
 * always points at the right next step. Pure and exported for unit testing;
 * never throws. Falls through to the original line, unchanged, for anything
 * it doesn't recognize.
 */
export function explainCloneFailure(
  stderrLine: string,
  ctx: { transport: "https" | "ssh"; host: string; usedToken: boolean; tokenAvailable: boolean },
): string {
  const { host, usedToken, tokenAvailable } = ctx;

  const authHint = (): string =>
    tokenAvailable
      ? `The stored token for ${host} was rejected — check it in Settings → Git host tokens.`
      : `If this is a private repository, add a token for ${host} in Settings → Git host tokens, or paste the SSH URL.`;

  if (
    /could not read Username/i.test(stderrLine) ||
    /Authentication failed/i.test(stderrLine) ||
    /terminal prompts disabled/i.test(stderrLine) ||
    // Covers both GitHub's `remote: Repository not found.` line and the
    // `fatal: repository '<url>' not found` line git itself prints last (the
    // one `runGitClone` actually keeps) — the quoted URL sits between the two
    // words, so a literal "repository not found" substring match would miss
    // the fatal line.
    /repository.*not found/i.test(stderrLine) ||
    /returned error: (401|403)\b/.test(stderrLine)
  ) {
    return `${stderrLine} — ${authHint()}`;
  }

  const movedMatch = stderrLine.match(/returned error: (301|302|307|308)\b/);
  if (movedMatch) {
    return usedToken
      ? `${stderrLine} — The repository has moved — paste its current URL.`
      : stderrLine;
  }

  if (/Host key verification failed/i.test(stderrLine)) {
    return `${stderrLine} — Run "ssh -T git@${host}" once in a terminal to trust the host, then retry.`;
  }

  if (/Permission denied \(publickey/i.test(stderrLine)) {
    return `${stderrLine} — No SSH key was accepted for ${host} — load your key (ssh-add) or paste the https URL instead.`;
  }

  if (/Could not resolve hostname/i.test(stderrLine)) {
    return `${stderrLine} — "${host}" didn't resolve — if it's an SSH alias, check ~/.ssh/config.`;
  }

  return stderrLine;
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
}

/** Clones are network-bound and can legitimately take minutes on big repos. */
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

export interface CloneOptions {
  timeoutMs?: number;
  /** Resolves the header line to retry with after an anonymous clone fails.
   *  Never called on an anonymous SUCCESS. A rejection is swallowed (treated
   *  as "no credential available") — see `cloneRepo`'s call site. */
  auth?: () => Promise<CloneAuth | null>;
  /** Only used to build `explainCloneFailure`'s context on the final
   *  failure — has no effect on how the clone itself runs. */
  transport?: "https" | "ssh";
  host?: string;
}

/** One `git clone -- <url> <dest>` attempt. Shared by both the anonymous and
 *  the token-retry attempt in `cloneRepo` below — the only difference between
 *  them is `extraEnv`. Sets `GIT_TERMINAL_PROMPT=0` (never hang on a
 *  credential prompt agetor can't answer) and `LC_ALL=C` (so
 *  `explainCloneFailure`'s patterns match regardless of the user's locale).
 *  When neither `GIT_SSH_COMMAND` (env) nor `core.sshCommand` (git config) is
 *  already set, also sets `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` so an ssh
 *  clone can't hang on a host-key or passphrase prompt either — a user who
 *  already configured their own ssh command is left alone. */
async function runGitClone(
  source: string,
  dest: string,
  extraEnv: Record<string, string>,
  timeoutMs: number,
): Promise<{ ok: boolean; stderrLine: string; timedOut: boolean }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...extraEnv,
  };
  if (!process.env.GIT_SSH_COMMAND) {
    const coreSshCommand = await run(["git", "config", "--get", "core.sshCommand"], undefined, 2_000);
    if (!coreSshCommand.ok || !coreSshCommand.stdout) {
      env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
    }
  }

  const proc = Bun.spawn(["git", "clone", "--", source, dest], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    const stderrLine = stderr.trim().split("\n").filter(Boolean).pop() ?? `git exited ${exitCode}`;
    return { ok: exitCode === 0, stderrLine, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `git clone -- <url> <dest>`, with an anonymous-first / token-on-failure
 * retry (docs/plans/clone-repository-all-providers.md §3 D4). Never throws —
 * callers inspect `ok`/`error`.
 *
 * Refuses an existing non-empty destination up-front (git would too, but this
 * gives a clean message instead of git's stderr).
 *
 * Attempt 1 runs anonymously, exactly like a plain `git clone`. If it fails,
 * did NOT time out, and `opts.auth` is given, `opts.auth()` is awaited
 * (rejections swallowed to `null` — a credential-resolution hiccup should
 * degrade to "no credential", not blow up the clone) and, if it yields a
 * `CloneAuth`, attempt 2 re-runs with `cloneAuthEnv`'s additive
 * `GIT_CONFIG_*` env layered on top. The anonymous-success path never calls
 * `opts.auth` at all — a token must never be sent for a clone that already
 * worked without one (a public repo, or a private one already trusted via
 * the user's ambient git credential helper).
 *
 * Git itself cleans up between attempts: on a failed clone it removes any
 * destination directory IT created, and leaves a pre-existing empty
 * destination directory (the retry's `dest`) empty rather than partially
 * populated — verified locally against a failing clone (git 2.54) — so no
 * cleanup step is needed between attempt 1 and attempt 2 here.
 *
 * The final error always reflects the LAST attempt's stderr, run through
 * `explainCloneFailure` with `usedToken`/`tokenAvailable` set from whether a
 * retry actually happened.
 */
export async function cloneRepo(
  cloneUrl: string,
  dest: string,
  opts: CloneOptions = {},
): Promise<CloneResult> {
  if (existsSync(dest)) {
    let empty = false;
    try {
      empty = readdirSync(dest).length === 0;
    } catch {
      return { ok: false, error: `destination is not a readable directory: ${dest}` };
    }
    if (!empty) return { ok: false, error: `destination already exists and is not empty: ${dest}` };
  } else {
    try {
      mkdirSync(path.dirname(dest), { recursive: true });
    } catch (err) {
      return { ok: false, error: `cannot create parent directory: ${String(err)}` };
    }
  }

  // Test seam, same philosophy as AGETOR_CLAUDE_BIN=/bin/echo elsewhere:
  // endpoint tests point this at a local fixture repo so the /projects/clone
  // route is exercised end to end without the network. Never set in production.
  const source = process.env.AGETOR_CLONE_SOURCE_OVERRIDE || cloneUrl;
  const timeoutMs = opts.timeoutMs ?? CLONE_TIMEOUT_MS;

  const attempt1 = await runGitClone(source, dest, {}, timeoutMs);
  if (attempt1.ok) return { ok: true };

  const host = opts.host ?? "";
  const transport = opts.transport ?? "https";

  if (attempt1.timedOut) {
    return { ok: false, error: `clone timed out after ${Math.round(timeoutMs / 60_000)} minutes` };
  }

  let usedToken = false;
  let tokenAvailable = false;
  let last = attempt1;
  if (opts.auth) {
    const auth = await opts.auth().catch(() => null);
    if (auth) {
      tokenAvailable = true;
      usedToken = true;
      const extraEnv = cloneAuthEnv(process.env as Record<string, string | undefined>, auth);
      last = await runGitClone(source, dest, extraEnv, timeoutMs);
      if (last.ok) return { ok: true };
      if (last.timedOut) {
        return { ok: false, error: `clone timed out after ${Math.round(timeoutMs / 60_000)} minutes` };
      }
    }
  }

  return {
    ok: false,
    error: `clone failed: ${explainCloneFailure(last.stderrLine, { transport, host, usedToken, tokenAvailable })}`,
  };
}

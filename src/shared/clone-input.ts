// Shared by both processes — must stay free of runtime imports from either
// side (same rule at-refs.ts / issue-task.ts document; the only import here
// is a type-only one, erased at compile time). This is the syntactic parser
// for whatever a user pastes into the "Clone repository" dialog
// (`https://…`, `git@host:owner/repo.git`, `ssh://…`, or bare `owner/repo`
// shorthand): the webview needs it to lock the provider picker and derive
// the default destination folder name as the user types, and the server
// needs it to build the canonical clone URL. Splitting it into its own
// module — rather than letting the dialog carry a hand-rolled "mirror" regex
// — is exactly the shared-module convention `at-refs.ts`/`issue-task.ts`
// exist to enforce: one grammar, so "what counts as a valid clone input"
// can't drift between the two processes.
//
// This module is deliberately *syntactic only*. It never resolves a host —
// no DNS, no `ssh -G`, no network of any kind — because the webview can't do
// that and because the same alias can mean different things to different
// users' `~/.ssh/config`. Provider classification here is the same cheap
// substring heuristic already used elsewhere in the shared layer
// (`canonicalGitHost` in `src/bun/github.ts`, mirrored inline in
// `issue-task.ts`): a lowercased host that merely *contains* "github" /
// "gitlab" / "bitbucket" counts. The server's `resolveCloneRepo` (see
// `docs/plans/clone-repository-all-providers.md` §3 D2) layers the git
// integration's real host-resolution rules (`ssh -G` alias resolution,
// Bitbucket Server rejection, exact per-host GitLab token scoping) on top of
// what this module parses — this module is the syntax, not the authority.

import type { GitProvider } from "./types.ts";

/** The three git forges Agetor's git integration (and this clone flow)
 *  supports. Order is display order, not priority — provider detection from
 *  a host string always checks GitHub, then GitLab, then Bitbucket. */
export const CLONE_PROVIDERS: readonly GitProvider[] = ["github", "gitlab", "bitbucket"];

/** Runtime type guard for `GitProvider` — used to validate a `provider`
 *  value coming from outside the type system (a route body, a CLI flag). */
export function isGitProvider(v: unknown): v is GitProvider {
  return typeof v === "string" && (CLONE_PROVIDERS as readonly string[]).includes(v);
}

/** Each provider's cloud host, for building a canonical clone URL from a
 *  parsed shorthand/scp input. Self-hosted GitLab keeps whatever host was
 *  actually pasted (see `rawHost`) — this map only names the *cloud*
 *  default. */
export const CLONE_CLOUD_HOST: Record<GitProvider, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
};

/** Which syntactic shape the user pasted. `"shorthand"` is bare
 *  `owner/repo` (or, for GitLab, a nested `group/sub/project`); `"https"` is
 *  `http(s)://…`; `"scp"` is the traditional `[user@]host:path` git-over-ssh
 *  shorthand (`git@github.com:owner/repo.git`); `"ssh-url"` is the explicit
 *  `ssh://[user@]host[:port]/path` form. */
export type CloneInputForm = "shorthand" | "https" | "scp" | "ssh-url";

/** The result of successfully parsing a clone input. `segments` is the
 *  owner…repo path *after* deep-link trimming and `.git`-suffix stripping —
 *  it's always at least 2 entries long. */
export interface ParsedCloneInput {
  /** Detected (full-URL forms) or picker-selected (`"shorthand"`) provider. */
  provider: GitProvider;
  /** Which syntactic shape matched. */
  form: CloneInputForm;
  /** The clone transport implied by `form`: `"shorthand"` and `"https"`
   *  clone over https; `"scp"` and `"ssh-url"` clone over ssh. */
  transport: "https" | "ssh";
  /** The scheme as pasted — only set for `form === "https"` (distinguishes
   *  a plain `http://` paste from `https://`); `null` otherwise. */
  scheme: "https" | "http" | null;
  /** Lowercased host as pasted, with one trailing FQDN `"."` stripped (any
   *  form) and a leading `"www."` stripped for `form === "https"` only.
   *  `null` for `form === "shorthand"`, which carries no host at all. */
  rawHost: string | null;
  /** Port digits as pasted (`"https"` or `"ssh-url"` forms only), else
   *  `null`. Never present on `"scp"` or `"shorthand"` — neither syntax has
   *  a place for one. */
  port: string | null;
  /** The ssh user as pasted (e.g. `"git"`), case preserved. `null` when
   *  absent, or when `form` isn't `"scp"`/`"ssh-url"`. A pasted
   *  `user:password@host` userinfo has its password half silently dropped
   *  here (see `splitSshUserinfo`) — ssh/git ignore a URL-embedded password
   *  anyway (real auth is key-based), and keeping it around would be one
   *  more place a secret could later get echoed or logged. Only the user
   *  half is validated against `SSH_USER_RE` and kept. */
  user: string | null;
  /** Path segments (owner, …, repo) after deep-link trimming and `.git`
   *  stripping — always at least 2 entries. */
  segments: string[];
  /** `segments.join("/")`. */
  fullPath: string;
  /** The last segment — the default destination folder name for the
   *  clone. */
  repo: string;
}

/** Machine-readable failure reason, alongside the human-facing `error`
 *  string — so a caller (the clone dialog) can branch on *why* parsing
 *  failed without string-matching `error`. `"empty"`: blank/whitespace-only
 *  input. `"unrecognized"`: the input matches none of the four supported
 *  shapes at all. `"unsupported-host"`: a full URL parsed structurally fine,
 *  but its host doesn't name any of the three supported providers.
 *  `"invalid"`: everything else — a malformed path/host/port/ssh-user, input
 *  over `CLONE_INPUT_MAX_LEN`, an ambiguous/overlong shorthand or scp/ssh-url
 *  path, etc. */
export type CloneInputErrorCode = "empty" | "unrecognized" | "unsupported-host" | "invalid";

/** `parseCloneInput`'s result: either a successfully parsed input, or a
 *  short, user-facing (lowercase-first, no leaked credentials) error string
 *  explaining why it wasn't, plus a `code` classifying the failure (see
 *  `CloneInputErrorCode`). */
export type ParseCloneInputResult =
  | { ok: true; value: ParsedCloneInput }
  | { ok: false; error: string; code: CloneInputErrorCode };

/** One sentence naming every input shape this parser accepts, appended to
 *  the unsupported-host / unparseable-input error messages so the user
 *  knows what to paste instead. */
export const CLONE_SUPPORTED_HINT =
  "use a GitHub, GitLab or Bitbucket Cloud URL (https://…, git@host:owner/repo.git, ssh://…) or owner/repo";

/** Hard cap on the trimmed input length `parseCloneInput`/`detectCloneProvider`
 *  will even attempt to parse. Defense in depth alongside the regex fixes
 *  below: no legitimate paste (URL or shorthand) approaches this, and it
 *  keeps any future regex regression from becoming a pathological-input
 *  hang regardless. Input longer than this is rejected outright — code
 *  `"invalid"` from `parseCloneInput`, `null` from `detectCloneProvider`. */
export const CLONE_INPUT_MAX_LEN = 2048;

/** Host charset: lowercase letters, digits, dot, hyphen — never a leading
 *  `-` or `.`, and never a trailing `.` either (checked separately below,
 *  since the charset alone allows any of those positions; the trailing-dot
 *  exclusion is what makes a *double* trailing dot invalid after
 *  `normalizeHost` has already peeled off one legal FQDN-terminating dot). */
const HOST_RE = /^[a-z0-9.-]+$/;
/** 1–5 decimal digits, as pasted after a `:` in an https or ssh:// input —
 *  the syntactic pre-filter `isValidPort` runs before its numeric
 *  1–65535-range + no-leading-zero check. */
const PORT_RE = /^\d{1,5}$/;
/** An ssh user: must start with a letter, digit or underscore, then any run
 *  of those plus dot/hyphen. Applied only to the user half of a captured
 *  userinfo — see `splitSshUserinfo` — so a `user:password` form's password
 *  half is never checked against (or expected to match) this. */
const SSH_USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
/** Every path segment (owner, group, repo, …): letters, digits, `_`, `.`,
 *  `-` — `.`/`..` and a leading `-` are rejected separately below. */
const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
/** GitHub's stricter owner-name rule (mirrors `src/bun/clone.ts`'s
 *  `OWNER_RE`): must start and end with an alphanumeric, with only
 *  alphanumerics and hyphens in between. */
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
/** Bare `owner/repo` (or `group/.../project`) shorthand: one or more
 *  `/`-separated segments, none containing whitespace, `:`, `@` (which
 *  would make it a host:path or url-ish form instead) or, critically, `/`
 *  itself within a segment — excluding `/` from the segment charset (unlike
 *  the pre-fix version, whose `[^\s:@]` let a segment swallow `/` too) is
 *  what makes each `/`-split point unique: with overlapping segment/
 *  separator charsets, a pathological input like `"a/".repeat(30_000) +
 *  "a@"` (no closer match, so the engine must try every possible way of
 *  partitioning the run before giving up) cost the old pattern ~470ms per
 *  call, and the dialog calls this parser twice per keystroke. With
 *  disjoint charsets there is exactly one way to split on `/`, so matching
 *  (or failing to match) is linear in input length regardless of shape. */
const SHORTHAND_RE = /^[^\s:@/]+(?:\/[^\s:@/]+)+$/;
/** The traditional `[userinfo@]host:path` scp-like git-over-ssh shorthand,
 *  where `userinfo` is `user` or `user:password`. The userinfo group
 *  excludes `@`, whitespace and `/` but — unlike the host group — *does*
 *  allow `:`, so a URL-embedded password (`oauth2:token@host:path`) is
 *  captured as part of userinfo rather than misread as the host:path
 *  delimiter; `splitSshUserinfo` strips the password half back off before
 *  anything inspects `user`. The host group excludes `@`, whitespace, `/`
 *  and `:` — a `/` or `:` there would mean this isn't actually host:path.
 *  Because the userinfo group is optional and gated behind a literal `@`
 *  that must still occur before the first disallowed character, and the
 *  host group's charset is disjoint from its own terminator (`:`), neither
 *  group's backtracking depends on the other's length — still linear, not
 *  quadratic, in input length. */
const SCP_RE = /^(?:([^@\s/]+)@)?([^@\s/:]+):(.*)$/;
/** Splits a captured ssh userinfo string (`user` or `user:password`) on its
 *  first `:` and returns only the user half — a URL-embedded password is
 *  discarded outright: ssh/git never authenticate off it (real auth is
 *  key-based), and dropping it here, before it's validated or could ever
 *  reach an error message, is what keeps a rejected `user:password` from
 *  leaking the password (see `parseCloneInput`'s doc comment). A userinfo
 *  with no `:` is returned unchanged. */
function splitSshUserinfo(userinfo: string): string {
  const colonIdx = userinfo.indexOf(":");
  return colonIdx === -1 ? userinfo : userinfo.slice(0, colonIdx);
}
/** GitLab reserved project-page names that can never be a real project at
 *  path index ≥ 2 (`/group/project/tree/main` etc.) — a deep link into one
 *  of these views is cut at the first occurrence, same as GitHub/Bitbucket's
 *  2-segment cut. */
const GITLAB_RESERVED_WORDS = new Set(["tree", "blob", "raw", "commits", "blame", "wikis"]);
/** Bare scheme-like words that could otherwise be mistaken for an scp host
 *  when there's no `//` after the colon to prove it's a URL (e.g.
 *  `mailto:someone@example.com` must never parse as scp host `"mailto"`). */
const SCP_SCHEME_LIKE_HOSTS = new Set([
  "http", "https", "ssh", "ftp", "ftps", "file", "mailto", "git", "ws", "wss", "ntp", "ldap",
]);

/** Structural result of `parseFormStructure` for the three host-bearing
 *  forms. `scheme` is only ever non-null for `form === "https"`. */
interface HostFormStructure {
  form: "https" | "ssh-url" | "scp";
  scheme: "https" | "http" | null;
  host: string;
  port: string | null;
  user: string | null;
  rawPath: string;
}

type FormStructure = HostFormStructure | { form: "shorthand"; rawPath: string };

/**
 * Splits the authority portion of an `https://` or `ssh://` input (whatever
 * follows the `scheme://`) into `{ host, port, user, rawPath }`. Userinfo is
 * always cut off the authority before deriving `host`/`port`; `user` is only
 * populated when `captureUser` is true (ssh cares who's connecting, https
 * discards userinfo entirely — a pasted `user:pass@` must never round-trip
 * anywhere in the result). Query strings and fragments are stripped from
 * `rawPath`. Returns `null` when there's no authority at all (e.g. bare
 * `"https://"`), when the authority carries more than one `:` outside
 * userinfo (an unparseable host:port), or when a stray second `@` survives
 * into `hostport` (e.g. `ssh://a@b@c/x` — `captureUser`'s single-split-on-
 * first-`@` leaves `"b@c"` as `hostport`, which is not a valid host[:port]
 * shape) — that last check is what keeps a malformed multi-`@` authority
 * from being misattributed into the `port`/`host` fields instead of being
 * rejected outright, which would otherwise risk echoing attacker-controlled
 * text (that a user might have intended as more userinfo) back through the
 * `invalid port "…"` / `invalid host "…"` error messages below.
 */
function parseAuthorityAndPath(
  rest: string,
  captureUser: boolean,
): { host: string; port: string | null; user: string | null; rawPath: string } | null {
  const stopMatch = rest.match(/[/?#]/);
  const authority = stopMatch ? rest.slice(0, stopMatch.index!) : rest;
  let rawPath = "";
  if (stopMatch) {
    const remainder = rest.slice(stopMatch.index!);
    const qIdx = remainder.search(/[?#]/);
    rawPath = qIdx === -1 ? remainder : remainder.slice(0, qIdx);
  }
  if (!authority) return null;

  let user: string | null = null;
  let hostport = authority;
  const atIdx = captureUser ? authority.indexOf("@") : authority.lastIndexOf("@");
  if (atIdx !== -1) {
    if (captureUser) user = authority.slice(0, atIdx);
    hostport = authority.slice(atIdx + 1);
  }
  if (!hostport || hostport.includes("@")) return null;

  let host = hostport;
  let port: string | null = null;
  const colonIdx = hostport.indexOf(":");
  if (colonIdx !== -1) {
    host = hostport.slice(0, colonIdx);
    port = hostport.slice(colonIdx + 1);
    if (!host || hostport.indexOf(":", colonIdx + 1) !== -1) return null;
  }

  return { host: host.toLowerCase(), port, user, rawPath };
}

/**
 * Classifies `raw` (already trimmed by the caller) into one of the four
 * input shapes, in the order the plan specifies: `https?://` first, then
 * `ssh://`, then the scp-like `[user@]host:path` shorthand, then bare
 * `owner/repo` shorthand. Returns `null` when none match — an unparseable
 * or unrecognized-shape input.
 */
function parseFormStructure(raw: string): FormStructure | null {
  const httpsMatch = raw.match(/^(https?):\/\/(.*)$/i);
  if (httpsMatch) {
    const authority = parseAuthorityAndPath(httpsMatch[2] ?? "", false);
    if (!authority) return null;
    return {
      form: "https",
      scheme: httpsMatch[1]!.toLowerCase() as "https" | "http",
      host: authority.host,
      port: authority.port,
      user: null,
      rawPath: authority.rawPath,
    };
  }

  const sshMatch = raw.match(/^ssh:\/\/(.*)$/i);
  if (sshMatch) {
    const authority = parseAuthorityAndPath(sshMatch[1] ?? "", true);
    if (!authority) return null;
    return {
      form: "ssh-url",
      scheme: null,
      host: authority.host,
      port: authority.port,
      user: authority.user,
      rawPath: authority.rawPath,
    };
  }

  const scpMatch = raw.match(SCP_RE);
  if (scpMatch) {
    const host = scpMatch[2]!;
    let rawPath = scpMatch[3] ?? "";
    // A single leading `/` after the colon is the traditional scp
    // absolute-path form (`git@gitlab.com:/group/proj.git` — an absolute
    // path on the remote, vs. the relative `git@gitlab.com:group/proj.git`)
    // and is legal; strip it before treating the rest as path segments. A
    // *double* leading `/` (`host://…`) is what a real `scheme://` URL looks
    // like once split on the first `:` — `https://…`/`ssh://…` never reach
    // this branch (they're matched earlier above), but an arbitrary
    // `scheme://…` string would, so `//` still disqualifies the scp
    // interpretation and falls through below.
    const looksLikeUrl = rawPath.startsWith("//");
    if (!looksLikeUrl && !SCP_SCHEME_LIKE_HOSTS.has(host.toLowerCase())) {
      if (rawPath.startsWith("/")) rawPath = rawPath.slice(1);
      return {
        form: "scp",
        scheme: null,
        host,
        port: null,
        user: scpMatch[1] ?? null,
        rawPath,
      };
    }
    // Looks like `scheme:` or `scheme://…` rather than an scp host:path —
    // fall through to the shorthand check below, which will reject it too
    // (a colon disqualifies the shorthand grammar), landing on the generic
    // "not a repository URL" error.
  }

  if (SHORTHAND_RE.test(raw)) {
    return { form: "shorthand", rawPath: raw };
  }

  return null;
}

/** Provider from a (lowercased) host by substring, mirroring the same cheap
 *  heuristic `canonicalGitHost` (`src/bun/github.ts`) and `issue-task.ts`
 *  already use elsewhere in this codebase: a host merely *containing* the
 *  provider's name counts, since users pin per-identity ssh aliases
 *  (`gitlab-work`, `github-personal`, …) that don't literally equal the
 *  cloud domain. Checked in this order — GitHub, then GitLab, then
 *  Bitbucket — so a (nonsensical) host matching more than one substring
 *  still resolves deterministically. Exported so `src/bun/clone.ts`'s
 *  server-side host resolution can reuse the exact same classifier this
 *  module already applies during parsing, instead of re-implementing the
 *  substring check and risking drift. `host` need not be pre-normalized —
 *  this lowercases its own copy. */
export function cloneProviderForHost(host: string): GitProvider | null {
  const lower = host.toLowerCase();
  if (lower.includes("github")) return "github";
  if (lower.includes("gitlab")) return "gitlab";
  if (lower.includes("bitbucket")) return "bitbucket";
  return null;
}

/** True for a syntactically valid host: `HOST_RE`'s charset (lowercase
 *  letters, digits, `.`, `-`), never starting with `-` or `.`, never ending
 *  with `.`. Callers pass an already-lowercased host — this performs no
 *  normalization of its own (compare `cloneProviderForHost`, which does).
 *  Exported for the same drift-avoidance reason as `cloneProviderForHost`:
 *  a server-side caller validating a resolved host should apply this exact
 *  rule, not a hand-rolled copy of it. */
export function isValidCloneHost(host: string): boolean {
  return (
    HOST_RE.test(host) &&
    !host.startsWith("-") &&
    !host.startsWith(".") &&
    !host.endsWith(".")
  );
}

/** True for a port string that's syntactically 1–5 decimal digits (per
 *  `PORT_RE`), carries no leading zero unless it's the single digit `"0"`
 *  (itself rejected below by the range check — `"0"`, `"00"`, `"007"` all
 *  fail), and falls numerically within the valid TCP port range 1–65535
 *  (`"0"` and `"99999"` both fail the upper/lower bound). */
function isValidPort(port: string): boolean {
  if (!PORT_RE.test(port)) return false;
  if (port.length > 1 && port.startsWith("0")) return false;
  const n = Number(port);
  return n >= 1 && n <= 65535;
}

/** Strips exactly one trailing `.` off a host. `github.com.` is a legal
 *  FQDN (the trailing dot marks it as already-absolute in DNS) that some
 *  users paste; peeling off exactly one dot lets it parse identically to
 *  `github.com`. Anything past a single trailing dot — `github.com..`, or a
 *  bare `"."` — is deliberately left with a dangling `.` (or empty string)
 *  for `isValidCloneHost` to reject; this function never loops. */
function stripTrailingDot(host: string): string {
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

/** The one host-normalization pipeline shared by `parseCloneInput` and
 *  `detectCloneProvider`, so the two can't drift: lowercase, strip one
 *  trailing FQDN dot (see `stripTrailingDot`), then — `form === "https"`
 *  only, mirroring the pre-existing behavior — drop a leading `"www."`. */
function normalizeHost(rawHost: string, form: CloneInputForm): string {
  let host = stripTrailingDot(rawHost.toLowerCase());
  if (form === "https" && host.startsWith("www.")) host = host.slice(4);
  return host;
}

function splitSegments(rawPath: string): string[] {
  return rawPath.split("/").filter((s) => s.length > 0);
}

/**
 * Applies the deep-link-trimming and segment-validation rules (plan §3 D3)
 * to a path's raw segments, returning either the final trimmed+validated
 * segments or a user-facing error. `rawSegments` (pre-trim) is what error
 * messages quote, so the user sees the path they actually pasted.
 *
 * All the deep-link-trimming rules below are **`form === "https"` only** —
 * `scp`/`ssh-url` paths have no URL deep-link structure (no `/tree/main`,
 * no `/-/`, no `/scm/` prefix) to trim, so more than two path segments there
 * is just ambiguous/wrong rather than something to truncate, and a GitLab
 * scp/ssh-url path is taken verbatim, nested groups included. `shorthand`
 * gets the same "reject, don't truncate" treatment for GitHub/Bitbucket, and
 * — since it likewise carries no URL structure — is never cut for GitLab
 * either.
 *
 * - Bitbucket Server-shaped `/scm/proj/repo` **https** paths (real Bitbucket
 *   Server web URLs look like this) have the leading `"scm"` marker dropped
 *   first, so the generic 2-segment cut below lands on `<proj>/<repo>`
 *   instead of `<scm>/<proj>`. This module doesn't otherwise special-case
 *   Bitbucket Server — the server layer rejects it by resolved host; this
 *   only keeps the *parse* honest for a URL shaped that way. (A Bitbucket
 *   Server *ssh* URL, e.g. `ssh://git@host:7999/proj/repo.git`, has no
 *   `scm` segment to begin with, so this never applies there anyway.)
 * - GitHub/Bitbucket: in `https` form, keep exactly the first two segments
 *   (a deep link like `owner/repo/tree/main/src` still resolves to the
 *   repo). In every other form (`shorthand`, `scp`, `ssh-url`), more than
 *   two segments is rejected outright — code `"invalid"` — rather than
 *   truncated (a bare `a/b/c`, or `git@github.com:2222/owner/repo`, is
 *   ambiguous with no URL structure to disambiguate it; silently truncating
 *   the latter used to resolve to the wrong repo, `2222/owner`).
 * - GitLab: in `https` form only, keeps nested groups but cuts at the first
 *   `-` segment (its `/-/` separator) or the first GitLab-reserved
 *   project-page word (`tree`/`blob`/`raw`/`commits`/`blame`/`wikis`) at
 *   index ≥ 2 — never a real project name there. In `shorthand`/`scp`/
 *   `ssh-url` form, the path is kept exactly as pasted (after `.git`
 *   stripping below) — e.g. `git@gitlab.com:group/tree/project.git` keeps
 *   its literal `tree` segment rather than being cut.
 * - A trailing `.git` (case-insensitive) is stripped from the last segment
 *   only, after the above trimming.
 * - Every segment must match `SEGMENT_RE`, never be `.`/`..`, and never
 *   start with `-`; GitHub additionally requires the owner (segment 0) to
 *   match the stricter `GITHUB_OWNER_RE`.
 */
function trimAndValidateSegments(
  rawSegments: string[],
  provider: GitProvider,
  form: CloneInputForm,
): { ok: true; segments: string[] } | { ok: false; error: string; code: CloneInputErrorCode } {
  const invalidPath = (): { ok: false; error: string; code: CloneInputErrorCode } => ({
    ok: false,
    error: `invalid repository path "${rawSegments.join("/")}"`,
    code: "invalid",
  });

  let segments = rawSegments;
  const isHttps = form === "https";

  if (provider === "bitbucket" && isHttps && segments[0] === "scm" && segments.length >= 3) {
    segments = segments.slice(1);
  }

  if (provider === "github" || provider === "bitbucket") {
    if (isHttps) {
      segments = segments.slice(0, 2);
    } else if (segments.length > 2) {
      return invalidPath();
    }
  } else if (isHttps) {
    // GitLab, https form only — see the doc comment above.
    let cut = segments.length;
    const dashIdx = segments.indexOf("-");
    if (dashIdx !== -1) cut = Math.min(cut, dashIdx);
    for (let i = 2; i < segments.length; i++) {
      if (GITLAB_RESERVED_WORDS.has(segments[i]!)) {
        cut = Math.min(cut, i);
        break;
      }
    }
    segments = segments.slice(0, cut);
  }

  if (segments.length < 2) return invalidPath();

  const last = segments[segments.length - 1]!;
  const stripped = last.replace(/\.git$/i, "");
  if (stripped.length === 0) return invalidPath();
  segments = [...segments.slice(0, -1), stripped];

  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg) || seg === "." || seg === ".." || seg.startsWith("-")) {
      return invalidPath();
    }
  }

  if (provider === "github" && !GITHUB_OWNER_RE.test(segments[0]!)) return invalidPath();

  return { ok: true, segments };
}

/**
 * Parses whatever a user pasted into the clone dialog. `shorthandProvider`
 * (default `"github"`) only matters for bare `owner/repo` shorthand, which
 * carries no host of its own — a full URL's own host always wins,
 * regardless of what's selected in the picker.
 *
 * Never throws; every failure path returns `{ ok: false; error; code }` —
 * `error` a short, lowercase-first, user-facing message that never echoes
 * back any userinfo/password from the input: https userinfo is discarded
 * before it's ever inspected, let alone stored (`captureUser: false` in
 * `parseAuthorityAndPath`), and an ssh-form (`scp`/`ssh-url`) userinfo's
 * `user:password` shape has its password half discarded by
 * `splitSshUserinfo` before the user half is ever validated or echoed — an
 * invalid ssh user is reported as `"invalid ssh user in the URL"`, with no
 * value interpolated, precisely so a rejected `user:password` can't leak the
 * password through the error string. `code` a `CloneInputErrorCode`
 * classifying *why* (e.g. so the dialog can special-case
 * `"unsupported-host"` without string-matching `error`). Input longer than
 * `CLONE_INPUT_MAX_LEN` is rejected outright, before any parsing, as
 * `code: "invalid"`.
 */
export function parseCloneInput(
  input: string,
  shorthandProvider: GitProvider = "github",
): ParseCloneInputResult {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "repository required", code: "empty" };
  if (raw.length > CLONE_INPUT_MAX_LEN) {
    return { ok: false, error: "repository URL is too long", code: "invalid" };
  }

  const structure = parseFormStructure(raw);
  if (!structure) {
    return { ok: false, error: `not a repository URL — ${CLONE_SUPPORTED_HINT}`, code: "unrecognized" };
  }

  if (structure.form === "shorthand") {
    const rawSegments = splitSegments(structure.rawPath);
    const trimmed = trimAndValidateSegments(rawSegments, shorthandProvider, "shorthand");
    if (!trimmed.ok) return trimmed;
    const segments = trimmed.segments;
    return {
      ok: true,
      value: {
        provider: shorthandProvider,
        form: "shorthand",
        transport: "https",
        scheme: null,
        rawHost: null,
        port: null,
        user: null,
        segments,
        fullPath: segments.join("/"),
        repo: segments[segments.length - 1]!,
      },
    };
  }

  const host = normalizeHost(structure.host, structure.form);
  if (!isValidCloneHost(host)) return { ok: false, error: `invalid host "${host}"`, code: "invalid" };

  // No path segment has been typed at all yet — `https://gith`,
  // `https://example.com`, `https://example.com/`, `git@example.com:` all
  // land here. This is a mid-paste (or just-picked-a-host) state, not a
  // wrong host, so it must resolve the same neutral "invalid" way regardless
  // of whether `host` happens to name a supported provider — hence this runs
  // *before* the provider check below, not after. Reported identically for
  // every host-bearing form (https/ssh-url/scp); `shorthand` can't reach
  // this branch (it never carries a host) and has its own "no `/` at all"
  // rejection via `SHORTHAND_RE` (→ `code: "unrecognized"`).
  const rawSegments = splitSegments(structure.rawPath);
  if (rawSegments.length === 0) {
    return { ok: false, error: "repository path required", code: "invalid" };
  }

  const provider = cloneProviderForHost(host);
  if (!provider) {
    return {
      ok: false,
      error: `unsupported host "${host}" — ${CLONE_SUPPORTED_HINT}`,
      code: "unsupported-host",
    };
  }

  if (structure.port !== null && !isValidPort(structure.port)) {
    return { ok: false, error: `invalid port "${structure.port}"`, code: "invalid" };
  }
  // A `user:password` userinfo has its password half dropped *before* the
  // remaining user half is validated — an invalid user is reported with no
  // value interpolated, so a rejected password can never round-trip through
  // this error (see the doc comments on `splitSshUserinfo` and this
  // function's own doc comment above).
  const user = structure.user !== null ? splitSshUserinfo(structure.user) : null;
  if (user !== null && !SSH_USER_RE.test(user)) {
    return { ok: false, error: "invalid ssh user in the URL", code: "invalid" };
  }

  const trimmed = trimAndValidateSegments(rawSegments, provider, structure.form);
  if (!trimmed.ok) return trimmed;
  const segments = trimmed.segments;

  const transport: "https" | "ssh" = structure.form === "https" ? "https" : "ssh";
  return {
    ok: true,
    value: {
      provider,
      form: structure.form,
      transport,
      scheme: structure.form === "https" ? structure.scheme : null,
      rawHost: host,
      port: structure.port,
      user,
      segments,
      fullPath: segments.join("/"),
      repo: segments[segments.length - 1]!,
    },
  };
}

/**
 * Cheap, tolerant provider detection for a *full-URL* input (https/scp/
 * ssh-url) — meant to run on every keystroke to drive the dialog's "detected
 * from URL" picker lock, so it only needs the host, not a fully valid path.
 * Returns the provider as soon as the host names one, even mid-paste with an
 * empty or incomplete path (`"https://gitlab.com/"`, `"git@bitbucket.org:"`
 * both resolve). Returns `null` for shorthand (no host to detect from),
 * empty input, input over `CLONE_INPUT_MAX_LEN`, an unparseable input, or a
 * host that names none of the three supported providers.
 */
export function detectCloneProvider(input: string): GitProvider | null {
  const raw = input.trim();
  if (!raw || raw.length > CLONE_INPUT_MAX_LEN) return null;

  const structure = parseFormStructure(raw);
  if (!structure || structure.form === "shorthand") return null;

  const host = normalizeHost(structure.host, structure.form);
  return cloneProviderForHost(host);
}

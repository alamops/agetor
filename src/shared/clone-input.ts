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
  /** Lowercased host as pasted, with a leading `"www."` stripped for
   *  `form === "https"` only. `null` for `form === "shorthand"`, which
   *  carries no host at all. */
  rawHost: string | null;
  /** Port digits as pasted (`"https"` or `"ssh-url"` forms only), else
   *  `null`. Never present on `"scp"` or `"shorthand"` — neither syntax has
   *  a place for one. */
  port: string | null;
  /** The ssh user as pasted (e.g. `"git"`), case preserved. `null` when
   *  absent, or when `form` isn't `"scp"`/`"ssh-url"`. */
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

/** `parseCloneInput`'s result: either a successfully parsed input, or a
 *  short, user-facing (lowercase-first, no leaked credentials) error
 *  string explaining why it wasn't. */
export type ParseCloneInputResult =
  | { ok: true; value: ParsedCloneInput }
  | { ok: false; error: string };

/** One sentence naming every input shape this parser accepts, appended to
 *  the unsupported-host / unparseable-input error messages so the user
 *  knows what to paste instead. */
export const CLONE_SUPPORTED_HINT =
  "use a GitHub, GitLab or Bitbucket Cloud URL (https://…, git@host:owner/repo.git, ssh://…) or owner/repo";

/** Host charset: lowercase letters, digits, dot, hyphen — never a leading
 *  `-` or `.` (checked separately below, since the charset alone allows
 *  either at the start). */
const HOST_RE = /^[a-z0-9.-]+$/;
/** 1–5 decimal digits, as pasted after a `:` in an https or ssh:// input. */
const PORT_RE = /^\d{1,5}$/;
/** An ssh user: must start with a letter, digit or underscore, then any run
 *  of those plus dot/hyphen. */
const SSH_USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
/** Every path segment (owner, group, repo, …): letters, digits, `_`, `.`,
 *  `-` — `.`/`..` and a leading `-` are rejected separately below. */
const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
/** GitHub's stricter owner-name rule (mirrors `src/bun/clone.ts`'s
 *  `OWNER_RE`): must start and end with an alphanumeric, with only
 *  alphanumerics and hyphens in between. */
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
/** Bare `owner/repo` (or `group/.../project`) shorthand: one or more
 *  `/`-separated segments, none containing whitespace, `:` or `@` (which
 *  would make it a host:path or url-ish form instead). */
const SHORTHAND_RE = /^[^\s:@]+(\/[^\s:@]+)+$/;
/** The traditional `[user@]host:path` scp-like git-over-ssh shorthand. Host
 *  and user both exclude `@`, whitespace, `/` and `:` — a `/` or `:` there
 *  would mean this isn't actually host:path. */
const SCP_RE = /^(?:([^@\s/:]+)@)?([^@\s/:]+):(.*)$/;
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
 * `"https://"`) or when the authority carries more than one `:` outside
 * userinfo (an unparseable host:port).
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
  if (!hostport) return null;

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
    const rawPath = scpMatch[3] ?? "";
    if (!rawPath.startsWith("/") && !SCP_SCHEME_LIKE_HOSTS.has(host.toLowerCase())) {
      return {
        form: "scp",
        scheme: null,
        host,
        port: null,
        user: scpMatch[1] ?? null,
        rawPath,
      };
    }
    // Looks like `scheme:` (or `scheme://…`, already excluded above by the
    // leading-`/` check) rather than an scp host:path — fall through to the
    // shorthand check below, which will reject it too (a colon disqualifies
    // the shorthand grammar), landing on the generic "not a repository URL"
    // error.
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
 *  still resolves deterministically. */
function detectProviderFromHost(host: string): GitProvider | null {
  const lower = host.toLowerCase();
  if (lower.includes("github")) return "github";
  if (lower.includes("gitlab")) return "gitlab";
  if (lower.includes("bitbucket")) return "bitbucket";
  return null;
}

function isValidHost(host: string): boolean {
  return HOST_RE.test(host) && !host.startsWith("-") && !host.startsWith(".");
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
 * - Bitbucket Server-shaped `/scm/proj/repo` paths (real Bitbucket Server
 *   URLs look like this) have the leading `"scm"` marker dropped first, so
 *   the generic 2-segment cut below lands on `<proj>/<repo>` instead of
 *   `<scm>/<proj>`. This module doesn't otherwise special-case Bitbucket
 *   Server — the server layer rejects it by resolved host; this only keeps
 *   the *parse* honest for a URL shaped that way.
 * - GitHub/Bitbucket keep exactly the first two segments (a deep link like
 *   `owner/repo/tree/main/src` still resolves to the repo) — except in
 *   shorthand form, where more than two segments is rejected outright (a
 *   bare `a/b/c` is ambiguous with no URL structure to disambiguate it).
 * - GitLab keeps nested groups, cutting only at the first `-` segment (its
 *   `/-/` separator) or the first GitLab-reserved project-page word
 *   (`tree`/`blob`/`raw`/`commits`/`blame`/`wikis`) at index ≥ 2 — never a
 *   real project name there.
 * - A trailing `.git` (case-insensitive) is stripped from the last segment
 *   only, after trimming.
 * - Every segment must match `SEGMENT_RE`, never be `.`/`..`, and never
 *   start with `-`; GitHub additionally requires the owner (segment 0) to
 *   match the stricter `GITHUB_OWNER_RE`.
 */
function trimAndValidateSegments(
  rawSegments: string[],
  provider: GitProvider,
  form: CloneInputForm,
): { ok: true; segments: string[] } | { ok: false; error: string } {
  const invalidPath = (): { ok: false; error: string } => ({
    ok: false,
    error: `invalid repository path "${rawSegments.join("/")}"`,
  });

  let segments = rawSegments;

  if (provider === "bitbucket" && segments[0] === "scm" && segments.length >= 3) {
    segments = segments.slice(1);
  }

  if (provider === "github" || provider === "bitbucket") {
    if (form === "shorthand" && segments.length > 2) return invalidPath();
    segments = segments.slice(0, 2);
  } else {
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
 * Never throws; every failure path returns `{ ok: false; error }` with a
 * short, lowercase-first, user-facing message that never echoes back any
 * userinfo/password from the input (https userinfo is discarded before it's
 * ever inspected, let alone stored).
 */
export function parseCloneInput(
  input: string,
  shorthandProvider: GitProvider = "github",
): ParseCloneInputResult {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "repository required" };

  const structure = parseFormStructure(raw);
  if (!structure) return { ok: false, error: `not a repository URL — ${CLONE_SUPPORTED_HINT}` };

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

  let host = structure.host.toLowerCase();
  if (structure.form === "https" && host.startsWith("www.")) host = host.slice(4);
  if (!isValidHost(host)) return { ok: false, error: `invalid host "${host}"` };

  const provider = detectProviderFromHost(host);
  if (!provider) return { ok: false, error: `unsupported host "${host}" — ${CLONE_SUPPORTED_HINT}` };

  if (structure.port !== null && !PORT_RE.test(structure.port)) {
    return { ok: false, error: `invalid port "${structure.port}"` };
  }
  if (structure.user !== null && !SSH_USER_RE.test(structure.user)) {
    return { ok: false, error: `invalid ssh user "${structure.user}"` };
  }

  const rawSegments = splitSegments(structure.rawPath);
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
      user: structure.user,
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
 * empty input, an unparseable input, or a host that names none of the three
 * supported providers.
 */
export function detectCloneProvider(input: string): GitProvider | null {
  const raw = input.trim();
  if (!raw) return null;

  const structure = parseFormStructure(raw);
  if (!structure || structure.form === "shorthand") return null;

  let host = structure.host.toLowerCase();
  if (structure.form === "https" && host.startsWith("www.")) host = host.slice(4);
  return detectProviderFromHost(host);
}

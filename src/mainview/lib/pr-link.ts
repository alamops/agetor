// Parses the "open a pull request" links the Commit & push prompt asks the
// agent for (`commitPushPrompt`, src/shared/types.ts) into the repository,
// head and base they name, so Create all PRs can attribute a proposal to a
// repository by its link instead of guessing. Pure and DOM-free; never throws.
// Contract: docs/architecture/multi-repo-tasks.md.

import { canonicalGitHost } from "../../shared/git-host.ts";

export type ForgeKind = "github" | "gitlab" | "bitbucket";

export interface PrLink {
  forge: ForgeKind;
  /** Lowercased hostname of the link. */
  host: string;
  /** The namespace: the owner, or the whole group path for a nested GitLab project. */
  owner: string;
  repo: string;
  /** The source branch, or null when the link doesn't name one or names a fork's. */
  head: string | null;
  /** The target branch, or null when the link doesn't name one. */
  base: string | null;
}

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** A branch name read from a link, or null when empty or a fork's `owner:branch`. */
function branchName(decoded: string | null | undefined): string | null {
  const name = decoded?.trim();
  if (!name || name.includes(":")) return null;
  return name;
}

function splitPath(pathname: string): string[] | null {
  const out: string[] = [];
  for (const seg of pathname.split("/")) {
    if (!seg) continue;
    const d = decode(seg);
    if (d === null) return null;
    out.push(d);
  }
  return out;
}

function stripGit(name: string): string {
  return name.replace(/\.git$/i, "");
}

function parseGitLab(host: string, segs: string[], params: URLSearchParams): PrLink | null {
  // `/<namespace…>/<project>/-/merge_requests/new` (the `-/` is absent on old instances).
  const mrIdx = segs.indexOf("merge_requests");
  if (mrIdx < 2 || segs[mrIdx + 1] !== "new" || segs.length !== mrIdx + 2) return null;
  const projectSegs = segs.slice(0, segs[mrIdx - 1] === "-" ? mrIdx - 1 : mrIdx);
  if (projectSegs.length < 2) return null;
  const repo = stripGit(projectSegs[projectSegs.length - 1]!);
  const owner = projectSegs.slice(0, -1).join("/");
  return {
    forge: "gitlab",
    host,
    owner,
    repo,
    head: branchName(params.get("merge_request[source_branch]")),
    base: branchName(params.get("merge_request[target_branch]")),
  };
}

function parseBitbucket(host: string, segs: string[], params: URLSearchParams): PrLink | null {
  if (segs.length !== 4 || segs[2] !== "pull-requests" || segs[3] !== "new") return null;
  return {
    forge: "bitbucket",
    host,
    owner: segs[0]!,
    repo: stripGit(segs[1]!),
    head: branchName(params.get("source")),
    base: branchName(params.get("dest")),
  };
}

function parseGitHub(host: string, segs: string[]): PrLink | null {
  if (segs.length < 4) return null;
  const owner = segs[0]!;
  const repo = stripGit(segs[1]!);
  if (segs[2] === "pull" && segs[3] === "new" && segs.length >= 5) {
    // Legacy `pull/new/<head>`: the head only (it may contain slashes).
    return { forge: "github", host, owner, repo, head: branchName(segs.slice(4).join("/")), base: null };
  }
  if (segs[2] !== "compare") return null;
  const spec = segs.slice(3).join("/");
  const dots = spec.indexOf("...");
  if (dots >= 0) {
    const base = spec.slice(0, dots);
    const head = spec.slice(dots + 3);
    return {
      forge: "github",
      host,
      owner,
      repo,
      head: branchName(head),
      base: branchName(base),
    };
  }
  // `compare/<head>` (GitHub compares against the default branch).
  return { forge: "github", host, owner, repo, head: branchName(spec), base: null };
}

/**
 * Read a pull-request-opening link (GitHub `compare/<base>...<head>` or the
 * legacy `pull/new/<head>`, GitLab `merge_requests/new?merge_request[…]`,
 * Bitbucket `pull-requests/new?source=&dest=`). Returns null for any other URL,
 * a PR page, or garbage. Names are percent-decoded; a fork head
 * (`owner:branch`) reads as `head: null`.
 */
export function parsePrLink(url: string): PrLink | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.toLowerCase();
    const segs = splitPath(u.pathname);
    if (!segs) return null;
    if (segs.includes("merge_requests")) return parseGitLab(host, segs, u.searchParams);
    if (segs[2] === "pull-requests") return parseBitbucket(host, segs, u.searchParams);
    return parseGitHub(host, segs);
  } catch {
    return null;
  }
}

/** The provider identity of a repository, as `providerRepoForDir` reports it. */
export interface RepoIdentity {
  host: string;
  owner: string;
  name: string;
}

function fullPath(owner: string, name: string): string {
  return `${owner}/${name}`.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").toLowerCase();
}

/**
 * Whether a link points at `id`'s repository. Compares the canonical host and
 * the full slash-joined `owner/name` path, case-insensitively with `.git`
 * ignored. Both hosts go through `canonicalGitHost`: `providerRepoForDir`
 * reports the canonical host (`gitlab.com` for a self-hosted
 * `gitlab.corp.example`) while the agent's link carries the real one, so a raw
 * comparison never matches there. A GitLab nested project splits as
 * `{owner:"group", name:"sub/project"}` in the
 * remote parser but `{owner:"group/sub", repo:"project"}` here, so a per-field
 * comparison would never match.
 */
export function linkMatchesRepo(link: PrLink, id: RepoIdentity): boolean {
  return (
    canonicalGitHost(link.host) === canonicalGitHost(id.host) &&
    fullPath(link.owner, link.repo) === fullPath(id.owner, id.name)
  );
}

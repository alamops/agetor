import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Clone-repository support for the Projects sidebar.
 *
 * `POST /projects/clone` (server.ts) is the consumer: parse the user's input
 * into a canonical clone URL, clone it, and register the destination as a
 * project. Everything here is deterministic and unit-tested. The ELI5
 * explainer task's text lives in `../shared/clone-eli5.ts` instead (it's
 * imported by the webview too); the LLM part itself lives in the agetor task
 * the route creates, never in an API call from here.
 */

export interface ParsedRepo {
  owner: string;
  repo: string;
  /** Canonical https clone URL, e.g. "https://github.com/owner/repo.git". */
  cloneUrl: string;
}

/** GitHub owner: alphanumerics and hyphens, no leading hyphen (also keeps a
 *  crafted "-flag" out of argv — we additionally pass `--` to git clone). */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
/** Repo names also allow "." and "_" — but never "." / ".." themselves. */
const REPO_RE = /^[A-Za-z0-9_.-]+$/;

const validPair = (owner: string, repo: string): boolean =>
  OWNER_RE.test(owner) &&
  REPO_RE.test(repo) &&
  repo !== "." &&
  repo !== ".." &&
  !repo.startsWith("-");

/**
 * Accepts the forms people actually paste and normalizes them to one https
 * clone URL:
 *
 *   https://github.com/owner/repo(.git)(/)   (also http://, www., extra path
 *                                             segments like /tree/main are cut)
 *   git@github.com:owner/repo(.git)
 *   ssh://git@github.com/owner/repo(.git)
 *   owner/repo                                (shorthand)
 *
 * Returns null for anything else — including non-GitHub hosts. Cloning an
 * arbitrary URL pasted into this field would happily fetch from any host with
 * the user's ambient git credentials, so the surface is deliberately GitHub-only.
 */
export function parseGitHubRepo(input: string): ParsedRepo | null {
  const raw = input.trim();
  if (!raw) return null;

  let ownerRepo: string | null = null;

  const scp = raw.match(/^git@github\.com:(.+)$/i);
  const ssh = raw.match(/^ssh:\/\/git@github\.com\/(.+)$/i);
  const https = raw.match(/^https?:\/\/(?:www\.)?github\.com\/(.+)$/i);
  if (scp) ownerRepo = scp[1] ?? null;
  else if (ssh) ownerRepo = ssh[1] ?? null;
  else if (https) ownerRepo = https[1] ?? null;
  else if (/^[^/\s:@]+\/[^/\s:@]+$/.test(raw)) ownerRepo = raw; // owner/repo shorthand

  if (!ownerRepo) return null;

  // Keep only the first two path segments — a pasted deep link like
  // "owner/repo/tree/main/src" still resolves to the repo.
  const segments = ownerRepo.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[0]!;
  let repo = segments[1]!;
  repo = repo.replace(/\.git$/i, "");
  if (!validPair(owner, repo)) return null;

  return { owner, repo, cloneUrl: `https://github.com/${owner}/${repo}.git` };
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

/**
 * `git clone -- <url> <dest>`. Never throws — callers inspect `ok`/`error`.
 *
 * Refuses an existing non-empty destination up-front (git would too, but this
 * gives a clean message instead of git's stderr). `GIT_TERMINAL_PROMPT=0`
 * turns a private/nonexistent repo into a fast failure instead of a clone
 * hung on a credential prompt agetor can't answer.
 */
export async function cloneRepo(
  cloneUrl: string,
  dest: string,
  timeoutMs = CLONE_TIMEOUT_MS,
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

  const proc = Bun.spawn(["git", "clone", "--", source, dest], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      const detail = stderr.trim().split("\n").filter(Boolean).pop() ?? `git exited ${exitCode}`;
      return { ok: false, error: `clone failed: ${detail}` };
    }
    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

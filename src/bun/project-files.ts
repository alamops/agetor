// Bun-side helpers for the `@`-mention file picker: listing a project's files
// the way an agent will actually see them (tracked + untracked, or the files
// at a specific ref for a not-yet-created worktree), and resolving a picked
// repo-relative path back to an absolute path under a task's cwd.
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isSafeRelPath } from "./worktree.ts";

export const MAX_PROJECT_FILES = 20_000;

export interface FileScope {
  /** Absolute path to an existing directory — either a task's live cwd (a
   *  worktree root, or an isolation=none workdir/subdirectory), or the
   *  source repo root when previewing files at a ref for a worktree that
   *  hasn't been created yet. */
  dir: string;
  /** When set (non-empty), list the tracked files at this ref instead of the
   *  live working tree — used to preview a not-yet-created worktree. */
  ref?: string | null;
}

export type ProjectFilesResult = { files: string[]; truncated: boolean } | { error: string };

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

const GIT_TIMEOUT_MS = 30_000;

/**
 * Run `git` against a working directory. Never throws — callers inspect `ok`.
 * Deliberately a local duplicate of worktree.ts's `git()` helper rather than
 * an import from it — this repo keeps such small process-spawning helpers
 * local to each file (see worktree.ts's own comment on the same helper)
 * instead of growing a shared "git utils" module every file depends on.
 */
async function git(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  } finally {
    clearTimeout(timer);
  }
}

/** Split a `-z`-terminated git listing on NUL and drop empty entries — the
 *  `-z` flag is what lets filenames containing spaces/unicode round-trip
 *  intact instead of being newline-mangled. */
function splitNulTerminated(out: string): string[] {
  return out.split("\0").filter((s) => s.length > 0);
}

/** Dedupe, sort with a plain code-unit comparison (locale-independent, so
 *  results are stable across machines/locales), and cap at
 *  `MAX_PROJECT_FILES`. */
function finalize(files: Iterable<string>): ProjectFilesResult {
  const sorted = Array.from(new Set(files)).sort((a, b) => (a < b ? -1 : 1));
  const truncated = sorted.length > MAX_PROJECT_FILES;
  return { files: sorted.slice(0, MAX_PROJECT_FILES), truncated };
}

/**
 * List a project's files the way an agent will see them: either the live
 * working tree (tracked + untracked-not-ignored, minus tracked-but-deleted),
 * or the tracked files at a specific ref (for previewing a worktree that
 * hasn't been materialized yet — agetor worktrees are always rooted at the
 * repo root, so a ref listing is repo-root-relative, matching that shape).
 *
 * `dir` must be an absolute path to an existing directory inside a git repo,
 * else `{ error }`. Never throws.
 */
export async function listProjectFiles(scope: FileScope): Promise<ProjectFilesResult> {
  const { dir, ref } = scope;

  if (!path.isAbsolute(dir)) return { error: "dir must be an absolute path" };
  let st;
  try {
    st = statSync(dir);
  } catch {
    return { error: "directory does not exist" };
  }
  if (!st.isDirectory()) return { error: "directory does not exist" };

  const inside = await git(["rev-parse", "--is-inside-work-tree"], dir);
  if (!inside.ok || inside.stdout !== "true") return { error: "not a git repository" };

  if (ref) {
    // Defense-in-depth: a "-"-leading ref would otherwise be read as a git
    // flag rather than a revision — mirrors the leading-dash guards
    // throughout worktree.ts (gitPull/gitPush/getAheadCount).
    if (ref.startsWith("-")) return { error: `unknown ref: ${ref}` };

    const lsTree = (r: string) => git(["ls-tree", "-r", "--name-only", "--full-tree", "-z", r], dir);
    let res = await lsTree(ref);
    if (!res.ok && !ref.startsWith("refs/") && !ref.startsWith("origin/")) {
      // PR head branches (and other refs never checked out locally) often
      // exist only as a remote-tracking ref — retry once against that shape
      // before giving up.
      res = await lsTree(`refs/remotes/origin/${ref}`);
    }
    if (!res.ok) return { error: `unknown ref: ${ref}` };
    return finalize(splitNulTerminated(res.stdout));
  }

  const [listed, deleted] = await Promise.all([
    git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], dir),
    git(["ls-files", "-z", "--deleted"], dir),
  ]);
  if (!listed.ok) return { error: "git ls-files failed" };
  // A tracked file deleted from the working tree (but not yet committed as a
  // deletion) still shows up in --cached; it must not be offered as a file
  // the agent can reference.
  const deletedSet = new Set(deleted.ok ? splitNulTerminated(deleted.stdout) : []);
  const files = splitNulTerminated(listed.stdout).filter((f) => !deletedSet.has(f));
  return finalize(files);
}

/**
 * Resolve a repo-relative `@`-mention path (as picked from `listProjectFiles`,
 * or typed by hand) to an absolute path under `cwd`. Returns null — never
 * throws — for anything unsafe or that doesn't check out:
 *
 *  - empty (after stripping trailing slashes)
 *  - unsafe per `isSafeRelPath` (absolute, `..`-escaping, NUL byte)
 *  - doesn't exist on disk
 *  - `isDirectory: true` requested but the target isn't a directory
 *  - resolves (after following symlinks) to somewhere outside `cwd` — the
 *    symlink-escape guard, since this app has no sandbox and a mention must
 *    not be a way to read arbitrary files elsewhere on disk
 *
 * A trailing slash is re-appended on a directory result, matching
 * `formatReferences`' directory convention (src/shared/refs.ts).
 */
export function resolveAtPath(cwd: string, relPath: string, isDirectory: boolean): string | null {
  let rel = relPath;
  while (rel.endsWith("/")) rel = rel.slice(0, -1);
  if (!rel) return null;
  if (!isSafeRelPath(rel)) return null;

  const abs = path.resolve(cwd, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return null;
  }
  if (isDirectory && !st.isDirectory()) return null;

  try {
    const realAbs = realpathSync(abs);
    const realCwd = realpathSync(cwd);
    const withinCwd = realAbs === realCwd || realAbs.startsWith(realCwd + path.sep);
    if (!withinCwd) return null;
  } catch {
    return null;
  }

  return isDirectory ? `${abs}/` : abs;
}

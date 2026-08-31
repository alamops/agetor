// Bun-side helpers for the `@`-mention file picker: listing a project's files
// the way an agent will actually see them (tracked + untracked, or the files
// at a specific ref for a not-yet-created worktree), and resolving a picked
// repo-relative path back to an absolute path under a task's cwd.
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isSafeRelPath } from "./worktree.ts";
import { expandAtTokens, MAX_PROJECT_FILES } from "../shared/at-refs.ts";

// The cap lives in the shared module so the webview's truncation footer and
// this listing can never disagree about the number; re-exported here for the
// existing server-side importers/tests.
export { MAX_PROJECT_FILES };

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
    // `stdout` is returned RAW — deliberately not `.trim()`ed. Every `-z`
    // caller below (`ls-tree -z`, `ls-files -z`) NUL-terminates every entry,
    // and a filename can legitimately start (or end) with a space (e.g.
    // " leading-space.txt"); a whole-string `.trim()` would silently eat
    // that leading space off the FIRST entry, corrupting the round-tripped
    // name (R15, code review). The one caller that needs a trimmed scalar
    // (the `rev-parse --is-inside-work-tree` probe, to strip its trailing
    // newline) trims at the call site instead.
    return { ok: exitCode === 0, stdout, stderr: stderr.trim(), exitCode };
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
  if (!inside.ok || inside.stdout.trim() !== "true") return { error: "not a git repository" };

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
 * A trailing slash is re-appended on a directory result — driven by what the
 * resolved path ACTUALLY is on disk (`st.isDirectory()`), not by whether the
 * caller's `isDirectory` flag was set: a bare, no-trailing-slash mention like
 * `@src` (`isDirectory: false`, since `expandAtTokens` derives the flag from
 * whether the TYPED token ended in `/`) that resolves to a directory still
 * gets the trailing slash (R10, code review) — matching `formatReferences`'
 * directory convention (src/shared/refs.ts) regardless of how it was typed.
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

  return st.isDirectory() ? `${abs}/` : abs;
}

/**
 * The single send-time `@`-token expansion point: `startTask` and
 * `sendInput` (orchestrator.ts) both call this, exactly once, right after
 * they learn the agent's real cwd (a worktree root once `prepareWorkdir` has
 * materialized it, or the raw workdir on isolation "none"/fallback) — no
 * earlier point in either path knows that cwd. Every resolvable token
 * (`@src/x.ts`, `@src/`) is replaced in place with the absolute path
 * `resolveAtPath` resolves against `cwd`; everything unresolvable — a typo,
 * a file that doesn't exist in this cwd, or an `@name` extension mention
 * like `@github` — is left verbatim, exactly as the user typed it. `text`
 * itself (typically `task.prompt`) is never mutated by the caller: only the
 * returned string carries the expansion, so a stored prompt keeps its
 * `@tokens` and re-resolves them against whatever cwd a later run/edit gets.
 *
 * A resolved path containing whitespace is wrapped in double quotes before
 * being spliced back in (R9, code review): the `@`-token grammar only forces
 * the user to quote a TYPED token that itself has a space (`@"my notes/a.md"`),
 * but the EXPANDED absolute path can carry whitespace the typed token never
 * did — a short unquoted bare mention like `@notes` can resolve to an
 * absolute path with a space in it once joined with `cwd`. Without a
 * delimiter, that expansion would read to the agent as two separate words
 * instead of one path — exactly the ambiguity the user's own `@"..."`
 * quoting (when present) was there to prevent.
 */
export function expandAtReferences(text: string, cwd: string): string {
  return expandAtReferencesDetailed(text, cwd).text;
}

/**
 * Same expansion as {@link expandAtReferences}, plus the RAW form (`token.raw`
 * — e.g. `@nope.md`, `@"my file.md"`) of every token that didn't resolve,
 * deduped, in document order. This is what lets a caller (orchestrator's
 * `startTask`/`sendInput`) report facts about the send back to the UI/CLI
 * ("these tokens were left verbatim") instead of the server silently
 * swallowing the distinction between "no @ tokens" and "some didn't
 * resolve" — a typo, a file not in this cwd's tree, or a `@name` extension
 * mention (`@github`) are all indistinguishable to this function; it's the
 * caller's job to decide what's noise.
 */
export function expandAtReferencesDetailed(text: string, cwd: string): { text: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const expanded = expandAtTokens(
    text,
    (p, isDir) => {
      const resolved = resolveAtPath(cwd, p, isDir);
      if (resolved === null) return null;
      return /\s/.test(resolved) ? `"${resolved}"` : resolved;
    },
    (token) => {
      if (seen.has(token.raw)) return;
      seen.add(token.raw);
      unresolved.push(token.raw);
    },
  );
  return { text: expanded, unresolved };
}

// A tiny virtual-filesystem seam that lets `commands.ts` walk either the live
// disk (today's behavior) or a git ref's committed tree (branch-scoped
// capability discovery) through the exact same `list`/`read` calls. Callers
// that need "what will actually be in the worktree" pass a ref; callers that
// read machine-local, untracked state (user config, plugin installs) keep
// using `diskProjectTree` directly, bypassing refs entirely.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface ProjectTreeEntry {
  name: string;
  isDir: boolean;
}

export interface ProjectTree {
  /** Immediate children of a root-relative dir ("" = root). [] when absent. */
  list(relDir: string): ProjectTreeEntry[];
  /** UTF-8 text of a root-relative file, or null when absent/unreadable/not fetched. */
  read(relFile: string): string | null;
}

/** Strip any leading/trailing slashes so "", "/", "a/b/", "/a/b" all key consistently. */
function normalizeRel(rel: string): string {
  return rel.replace(/^\/+|\/+$/g, "");
}

/**
 * Live-disk implementation — today's `readdirSync`/`statSync`/`readFileSync`
 * behavior, just behind the `ProjectTree` interface. `root` must be absolute.
 * Every failure (missing dir/file, permission error, not-a-directory) maps to
 * `[]`/`null` rather than throwing, matching the old `safeListDir`/
 * `safeReadFile` helpers this replaces.
 */
export function diskProjectTree(root: string): ProjectTree {
  return {
    list(relDir: string): ProjectTreeEntry[] {
      const dir = path.join(root, normalizeRel(relDir));
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const out: ProjectTreeEntry[] = [];
      for (const entry of entries) {
        // statSync (not `entry.isDirectory()`) so a symlinked directory
        // still counts as a directory — `readdirSync`'s Dirent does not
        // follow symlinks, but the old `statSync`-per-entry walk did.
        let isDir: boolean;
        try {
          isDir = statSync(path.join(dir, entry.name)).isDirectory();
        } catch {
          continue;
        }
        out.push({ name: entry.name, isDir });
      }
      return out;
    },
    read(relFile: string): string | null {
      try {
        return readFileSync(path.join(root, normalizeRel(relFile)), "utf8");
      } catch {
        return null;
      }
    },
  };
}

/** Always-empty tree — used when there's no root to read from at all (e.g. a
 *  null workdir) or when a git ref fails to resolve (unknown ref, not a repo). */
export function emptyProjectTree(): ProjectTree {
  return {
    list: () => [],
    read: () => null,
  };
}

/**
 * Build a `ProjectTree` from a flat map of root-relative paths → content.
 * Directories are derived purely from path prefixes (there's no separate
 * "directory" entry in a git listing — `a/b/c.md` implies both `a` and
 * `a/b` are directories). A path present in the map with a `null` value is
 * a file that was *listed* but not fetched (or fetched and found missing) —
 * it still appears in `list()`, `read()` just returns null for it.
 */
export function refProjectTree(files: Map<string, string | null>): ProjectTree {
  // dir (root-relative, "" = root) -> name -> isDir
  const childrenByDir = new Map<string, Map<string, boolean>>();
  const ensureDir = (dir: string): Map<string, boolean> => {
    let m = childrenByDir.get(dir);
    if (!m) {
      m = new Map();
      childrenByDir.set(dir, m);
    }
    return m;
  };
  ensureDir("");

  for (const filePath of files.keys()) {
    const parts = normalizeRel(filePath).split("/").filter(Boolean);
    let curDir = "";
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      const isLast = i === parts.length - 1;
      const dirMap = ensureDir(curDir);
      if (isLast) {
        // A file leaf — only record as a file if this name hasn't already
        // been established as a directory by another path (can't happen in
        // a real tree, but don't clobber it if it somehow did).
        if (!dirMap.has(name)) dirMap.set(name, false);
      } else {
        dirMap.set(name, true);
        curDir = curDir ? `${curDir}/${name}` : name;
        ensureDir(curDir);
      }
    }
  }

  return {
    list(relDir: string): ProjectTreeEntry[] {
      const m = childrenByDir.get(normalizeRel(relDir));
      if (!m) return [];
      return [...m.entries()].map(([name, isDir]) => ({ name, isDir }));
    },
    read(relFile: string): string | null {
      const key = normalizeRel(relFile);
      return files.has(key) ? (files.get(key) ?? null) : null;
    },
  };
}

// ---------------------------------------------------------------------------
// git-backed loading
// ---------------------------------------------------------------------------

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

// This path serves an interactive `/`/`@`-autocomplete whose fallback (no
// project-level rows) is a perfectly fine degraded state — unlike
// `worktree.ts`'s 30s (where the operation being timed out actually matters
// to the task), so this budget is deliberately tighter. Requests here can
// chain up to 3 deep (an unresolvable ref retried against
// `refs/remotes/origin/<ref>`, then a `cat-file --batch`), and a slow/hung
// git process shouldn't stall a keystroke-driven UI for tens of seconds.
const GIT_TIMEOUT_MS = 8_000;

/**
 * Run `git` against a working directory. Never throws — callers inspect
 * `ok`. Deliberately a local duplicate of `project-files.ts`'s (and
 * `worktree.ts`'s) `git()` helper rather than a shared import — this repo
 * keeps such small process-spawning helpers local to each file instead of
 * growing a shared "git utils" module every file depends on.
 */
async function git(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    proc = Bun.spawn(["git", ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc!.kill(), timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      // Raw, un-trimmed stdout — the `-z` output below is NUL-terminated and
      // a filename can legitimately start with a space (mirrors
      // project-files.ts's same rationale).
      return { ok: exitCode === 0, stdout, stderr: stderr.trim(), exitCode };
    } finally {
      clearTimeout(timer);
      // A throw between spawn and here (e.g. the `Promise.all` above
      // rejecting for a reason other than a normal exit) would otherwise
      // leave this child running forever — nothing else ever calls
      // `.kill()` on it once we've left this function.
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    }
  } catch {
    return { ok: false, stdout: "", stderr: "spawn failed", exitCode: -1 };
  }
}

/** Split a `-z`-terminated git listing on NUL and drop empty entries. */
function splitNulTerminated(out: string): string[] {
  return out.split("\0").filter((s) => s.length > 0);
}

/**
 * Run `git cat-file --batch` for a list of `<ref>:<path>` requests in one
 * spawn, returning raw stdout bytes (a `Buffer`) or `null` on any failure
 * (spawn error, non-zero exit). Byte-level (not `.text()`) because the batch
 * protocol's `<size>` is a byte count and a file's content can itself
 * contain arbitrary bytes — decoding early would make offset arithmetic
 * wrong for non-ASCII content that spans the header/body boundary oddly.
 */
async function runCatFileBatch(cwd: string, requestText: string, timeoutMs = GIT_TIMEOUT_MS): Promise<Buffer | null> {
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  try {
    proc = Bun.spawn(["git", "cat-file", "--batch"], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc!.kill(), timeoutMs);
    try {
      // `.write()`/`.end()` on a Bun `FileSink` can return promises (e.g.
      // under backpressure); if the child dies mid-write those reject as an
      // unhandled rejection outside this try/catch unless we chain and
      // swallow them here.
      const writeDone = Promise.resolve(proc.stdin.write(requestText))
        .then(() => proc!.stdin.end())
        .catch(() => {});
      const [stdoutBuf, , exitCode] = await Promise.all([
        new Response(proc.stdout).arrayBuffer(),
        new Response(proc.stderr).text(),
        proc.exited,
        writeDone,
      ]);
      if (exitCode !== 0) return null;
      return Buffer.from(stdoutBuf);
    } finally {
      clearTimeout(timer);
      // Same leak guard as `git()` above — a throw after spawn must not
      // leave a `git cat-file --batch` blocked on stdin forever.
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    }
  } catch {
    return null;
  }
}

/**
 * Parse a `git cat-file --batch` response into `path -> content|null`, in
 * the same order the requests were written (batch preserves input order in
 * its output, and — critically for the "missing" case — a missing object's
 * echoed name is the raw `<ref>:<path>` request string, not the bare path,
 * so order is the only reliable correlation for both branches).
 *
 * Record shapes on the wire:
 *   `<oid> <type> <size>\n<size bytes of content>\n`   — object found
 *   `<object> missing\n`                                — object not found
 */
function parseCatFileBatch(buf: Buffer, paths: string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  let cursor = 0;
  for (const p of paths) {
    const nl = buf.indexOf(0x0a, cursor);
    if (nl === -1) {
      // Truncated/malformed stream — treat this and everything after as
      // unread rather than guessing at partial content.
      out.set(p, null);
      continue;
    }
    const header = buf.toString("utf8", cursor, nl);
    cursor = nl + 1;
    if (header.endsWith(" missing")) {
      out.set(p, null);
      continue;
    }
    const m = /^[0-9a-f]+ \S+ (\d+)$/.exec(header);
    if (!m) {
      out.set(p, null);
      continue;
    }
    const size = parseInt(m[1]!, 10);
    const body = buf.toString("utf8", cursor, cursor + size);
    cursor += size;
    if (buf[cursor] === 0x0a) cursor += 1; // trailing newline after the body
    out.set(p, body);
  }
  return out;
}

/** Fetch content for `paths` at `ref` via one `git cat-file --batch` spawn.
 *  Every path is present in the result; a failed spawn maps every path to
 *  `null` rather than throwing. */
async function batchCatFile(cwd: string, ref: string, paths: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (paths.length === 0) return out;
  const requestText = paths.map((p) => `${ref}:${p}\n`).join("");
  const buf = await runCatFileBatch(cwd, requestText);
  if (!buf) {
    for (const p of paths) out.set(p, null);
    return out;
  }
  return parseCatFileBatch(buf, paths);
}

const DEFAULT_PATHSPECS = [".claude", ".codex", ".mcp.json"];

/**
 * Load a `ProjectTree` view of `ref`'s committed tree in the repo at `dir`,
 * scoped to `pathspecs` (default: the three trees/files capability discovery
 * ever reads). Two git spawns total regardless of entry count: one
 * `ls-tree` to enumerate, one `cat-file --batch` to fetch the content of
 * whichever listed paths `shouldRead` accepts (default: all of them).
 *
 * Returns `null` when the ref can't be resolved at all (unknown ref, `dir`
 * not a git repo, leading-`-` ref rejected as a would-be flag) — callers
 * that want "no project entries" rather than a thrown error should catch
 * that and substitute `emptyProjectTree()`.
 *
 * Ref-resolution mirrors `project-files.ts`'s `rawListing`: a bare ref that
 * `ls-tree` can't resolve locally is retried once as
 * `refs/remotes/origin/<ref>` (PR head branches and other refs that only
 * exist as remote-tracking refs) before giving up. `--full-tree` makes the
 * pathspecs (and the resulting listing) root-relative regardless of `dir`
 * being a repo subdirectory. `-z` output is NUL-split, never trimmed —
 * filenames may start with whitespace.
 */
export async function loadRefProjectTree(
  dir: string,
  ref: string,
  opts?: { pathspecs?: string[]; shouldRead?: (relPath: string) => boolean },
): Promise<ProjectTree | null> {
  // A "-"-leading ref would be parsed as a git flag rather than a revision —
  // same guard `project-files.ts`'s `rawListing` uses.
  if (ref.startsWith("-")) return null;
  // `ref` is caller-controlled (an HTTP query param), and a `\n`/`\r`/`\0`
  // would land inside a `cat-file --batch` request line (`${ref}:${p}\n`)
  // and desync the request/record correlation the same way a `\n` in `p`
  // does below — a real git ref name can never contain a control character,
  // so this can only be a hostile or malformed caller, never a legitimate ref.
  if (/[\n\r\0]/.test(ref)) return null;

  const pathspecs = opts?.pathspecs ?? DEFAULT_PATHSPECS;
  const shouldRead = opts?.shouldRead ?? (() => true);

  const lsTree = (r: string) => git(["ls-tree", "-r", "--name-only", "--full-tree", "-z", r, "--", ...pathspecs], dir);

  let resolvedRef = ref;
  let res = await lsTree(ref);
  if (!res.ok && !ref.startsWith("refs/") && !ref.startsWith("origin/")) {
    resolvedRef = `refs/remotes/origin/${ref}`;
    res = await lsTree(resolvedRef);
  }
  if (!res.ok) return null;

  const paths = Array.from(new Set(splitNulTerminated(res.stdout)));
  const files = new Map<string, string | null>();
  for (const p of paths) files.set(p, null);

  // `batchCatFile` writes one `${ref}:${p}\n` request line per path and
  // correlates responses back to paths purely by order — a path containing
  // `\n` (git filenames may legitimately contain one; `ls-tree -z` emits it
  // raw) would split into two request lines, shifting every subsequent
  // record onto the wrong path. A `\0` would corrupt the line the same way
  // if it ever appeared (it can't survive `splitNulTerminated` above, but
  // the guard costs nothing and states the invariant explicitly). Excluding
  // such a path from `toRead` keeps it LISTED with `read() -> null` — the
  // documented "listed but not fetched" contract — rather than risking a
  // cross-attribution bug.
  const toRead = paths.filter((p) => shouldRead(p) && !/[\n\0]/.test(p));
  if (toRead.length > 0) {
    const contents = await batchCatFile(dir, resolvedRef, toRead);
    for (const [p, content] of contents) files.set(p, content);
  }

  return refProjectTree(files);
}

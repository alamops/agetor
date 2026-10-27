// Filesystem access for agent discovery (`commands.ts`), with two
// implementations behind one seam.
//
// The problem. Agents run as the same macOS user, unsandboxed, and can plant
// symlinks in any path the core later reads in its OWN process: a user skills
// dir, a plugin's `installPath` (recorded in `installed_plugins.json`, itself
// agent-writable), a project's `.claude/skills`. A symlink into ~/Documents,
// ~/Desktop or another app's ~/Library/Application Support turns the core's
// `open`/`readdir` into a read made under Agetor.app's TCC identity: macOS
// prompts, or silently grants, access that belongs to Agetor, not to the agent
// that planted the link. (`stat(2)` alone does not prompt; `open`/`read`/
// `readdir` do.)
//
// The fix (docs/plans/master-token-agent-read.md, D24/D25). While the disclaim
// switch is effectively on (`disclaimEnabled()`), every read discovery does runs
// in a DISCLAIMED CHILD of Apple system tools (`/bin/sh`, `/usr/bin/find`,
// `/usr/bin/tar`, `/usr/bin/stat`, `/bin/cat`) spawned through `coreSpawn`: a
// disclaimed child is TCC-responsible for itself, so it has exactly the access
// any self-responsible process of this user already has — nothing of Agetor's is
// lent. Symlinks are followed (`find -L`, `tar -L`) INSIDE that child. When the
// switch is off (or the helper is missing / the platform is not macOS) the
// in-process implementation runs and behaves exactly as it always did.
//
// Shape. Discovery needs a bounded, known set of files: the `*.md` under a
// commands dir, `SKILL.md` one level under a skills dir, and a handful of named
// json/toml files. A caller describes them as `DiscoverySelector`s (absolute
// path + max depth + file-name glob); `load()` runs ONE child for all of them —
// `find -L` per selector piped to one `tar` — and returns a `DiscoveryReader`
// over the in-memory result. So one discovery stage costs one child no matter
// how many roots or plugins are involved, and only files discovery parses are
// ever archived (a skill folder's big assets are never read). Absolute paths go
// to the child as argv, never into script text; tar's leading-`/` strip is
// undone when the archive is mapped back to absolute keys.
//
// The one file that is large and re-read often, `~/.claude.json`, keeps a
// stat-keyed cache in both modes: the disclaimed child reports `mtime size`
// first and only sends the content when the key differs from the cached one.

import { lstatSync, readFileSync, statSync } from "node:fs";
import { readTextNoFollow } from "./no-follow.ts";
import path from "node:path";
import { disclaimEnabled } from "./disclaim.ts";
import { readCapped, PROJECT_TREE_TAR_MAX_BYTES } from "./caller-fs.ts";
import { childEnv, coreSpawn } from "./core-spawn.ts";
import { diskProjectTree, refProjectTree, type ProjectTree } from "./ref-tree.ts";
import { parseTar } from "./tar-read.ts";

/** One thing discovery wants read: `path` itself when it is a file, else the
 *  files below it. `maxDepth` counts from `path` (0 = `path` only, 2 =
 *  `path/x/SKILL.md`); `name` is a `find -name` glob (default every file). */
export interface DiscoverySelector {
  path: string;
  maxDepth?: number;
  name?: string;
}

/** Read-only view over what `DiscoveryFs.load` fetched. */
export interface DiscoveryReader {
  /** A tree rooted at `root` (absolute). In disclaimed mode it holds only the
   *  files the selectors matched; in-process it is the live disk. */
  tree(root: string): ProjectTree;
  /** UTF-8 text of an absolute file, or null when absent/unreadable/not selected. */
  text(abs: string): string | null;
  /** `text` parsed as JSON, or null. `cached` uses the stat-keyed cache when
   *  reading from disk in-process (disclaimed files are already in memory). */
  json(abs: string, opts?: { cached?: boolean }): any;
}

export interface DiscoveryFs {
  /** True when reads run in a disclaimed child. */
  readonly disclaimed: boolean;
  /** Fetch every selected file (one child in disclaimed mode, nothing to do
   *  in-process). Never rejects: a failed child yields an empty reader. */
  load(selectors: readonly DiscoverySelector[]): Promise<DiscoveryReader>;
  /** Parsed JSON of a large, re-read file (`~/.claude.json`), stat-keyed cached. */
  readJsonCached(abs: string): Promise<any>;
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function safeReadFile(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** Parse text already in hand; null on empty/invalid. */
export function safeParseJson(text: string | null): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Read and parse an absolute disk path in this process; null on any failure. */
export function safeReadJson(p: string): any {
  return safeParseJson(safeReadFile(p) || null);
}

/**
 * Stat-keyed cache for JSON files that are large and re-read often.
 * `~/.claude.json` grows with per-project history and can reach multiple MB;
 * discovery re-runs on every (agent, workdir, branch) change, so it is not
 * re-parsed while unchanged. The key combines mtime *and* size so a
 * same-millisecond rewrite still invalidates when the byte count differs. A
 * changed key invalidates the entry; an unreadable/missing file caches `null`.
 * In-process only (the disclaimed reader has its own string-keyed cache).
 */
const jsonStatCache = new Map<string, { mtimeMs: number; size: number; value: any }>();
export function safeReadJsonCached(p: string, opts: { noFollow?: boolean } = {}): any {
  let mtimeMs: number, size: number;
  try {
    const st = opts.noFollow ? lstatSync(p) : statSync(p);
    // No-follow: a symlink planted at `p` is never opened in-process (it could
    // point into a protected folder, read under Agetor's TCC identity).
    if (opts.noFollow && !st.isFile()) throw new Error("not a regular file");
    ({ mtimeMs, size } = st);
  } catch {
    jsonStatCache.delete(p);
    return null;
  }
  const key = opts.noFollow ? `nofollow\0${p}` : p;
  const hit = jsonStatCache.get(key);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.value;
  let value: any = null;
  if (opts.noFollow) {
    try {
      value = safeParseJson(readTextNoFollow(p) || null);
    } catch {
      value = null;
    }
  } else {
    value = safeReadJson(p);
  }
  jsonStatCache.set(key, { mtimeMs, size, value });
  return value;
}

// ---------------------------------------------------------------------------
// selector helpers (callers build their read lists with these)
// ---------------------------------------------------------------------------

/** Every `*.md` below `dir`, at any depth (a commands / prompts dir). */
export function markdownTree(dir: string): DiscoverySelector {
  return { path: dir, maxDepth: 32, name: "*.md" };
}

/** `dir/<name>/SKILL.md` — one skill folder level (a skills dir). */
export function skillsDir(dir: string): DiscoverySelector {
  return { path: dir, maxDepth: 2, name: "SKILL.md" };
}

/** Exactly the file `file`. */
export function singleFile(file: string): DiscoverySelector {
  return { path: file, maxDepth: 0 };
}

// ---------------------------------------------------------------------------
// in-process implementation (disclaim switch off): today's behavior
// ---------------------------------------------------------------------------

const inProcessReader: DiscoveryReader = {
  tree: (root) => diskProjectTree(root),
  text: (abs) => {
    try {
      return readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  },
  json: (abs, opts) => (opts?.cached ? safeReadJsonCached(abs) : safeReadJson(abs)),
};

export const inProcessDiscoveryFs: DiscoveryFs = {
  disclaimed: false,
  load: async () => inProcessReader,
  readJsonCached: async (abs) => safeReadJsonCached(abs),
};

// ---------------------------------------------------------------------------
// disclaimed implementation
// ---------------------------------------------------------------------------

/** Absolute tool paths only: nothing here may be redirected through PATH. */
const SH = "/bin/sh";
const FIND = "/usr/bin/find";
const TAR = "/usr/bin/tar";
const STAT = "/usr/bin/stat";
const CAT = "/bin/cat";

const LOAD_TIMEOUT_MS = 15_000;
/** `~/.claude.json` has no tighter bound than "multi-MB"; past this the file is
 *  treated as unreadable (a truncated JSON would not parse anyway). */
const JSON_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 32;

/**
 * argv: sh -c SCRIPT sh <path> <maxdepth> <name> [<path> <maxdepth> <name> …].
 * One `find -L` per triple (`.git` / `node_modules` pruned, regular files only —
 * `-type f` follows a symlink to a file), NUL-separated, piped into a single
 * `tar` that follows links and writes a pax archive to stdout. A missing start
 * point just prints nothing. Paths are positional parameters, never script text.
 */
const LOAD_SCRIPT = `
while [ "$#" -ge 3 ]; do
  p=$1; d=$2; n=$3; shift 3
  ${FIND} -L "$p" -maxdepth "$d" \\( -name .git -o -name node_modules \\) -prune -o -type f -name "$n" -print0 2>/dev/null
done | ${TAR} -c -f - --format=pax -L --null -T - 2>/dev/null
`;

/**
 * argv: sh -c SCRIPT sh <path> <known-key>. First line: `mtime size` of the
 * file (nothing at all when it can't be stat'ed). The content follows only when
 * that key differs from the caller's cached one.
 */
const JSON_SCRIPT = `
k=$(${STAT} -L -f '%Fm %z' -- "$1" 2>/dev/null) || exit 0
echo "$k"
[ "$k" = "$2" ] && exit 0
exec ${CAT} -- "$1" 2>/dev/null
`;

const childOptions = () =>
  ({
    // COPYFILE_DISABLE: without it bsdtar adds an AppleDouble `._name` sibling
    // for every file carrying an xattr (macOS stamps `com.apple.provenance`).
    env: { ...childEnv(), LC_ALL: "C", COPYFILE_DISABLE: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  }) as const;

/** Run a child, read at most `maxBytes` of stdout, kill it at the timeout or the
 *  cap. Never throws: a spawn failure yields no bytes. */
async function runCapped(
  argv: string[],
  maxBytes: number,
  timeoutMs = LOAD_TIMEOUT_MS,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  let proc: ReturnType<typeof coreSpawn>;
  try {
    proc = coreSpawn(argv, childOptions());
  } catch {
    return { bytes: new Uint8Array(0), truncated: false };
  }
  const kill = () => {
    try {
      proc.kill();
    } catch {
      // already gone
    }
  };
  const timer = setTimeout(kill, timeoutMs);
  let result: { bytes: Uint8Array; truncated: boolean } = { bytes: new Uint8Array(0), truncated: false };
  try {
    result = await readCapped(proc.stdout as ReadableStream<Uint8Array>, maxBytes);
    if (result.truncated) kill();
    await proc.exited;
  } catch {
    // use whatever was read
  } finally {
    clearTimeout(timer);
  }
  return result;
}

function normalizeSelectors(selectors: readonly DiscoverySelector[]): Array<Required<DiscoverySelector>> {
  const seen = new Set<string>();
  const out: Array<Required<DiscoverySelector>> = [];
  for (const s of selectors) {
    // A NUL cannot travel in argv, and no real path has one.
    if (s.path.includes("\0") || (s.name ?? "").includes("\0")) continue;
    // Absolute (so a `-`-leading value can never be read as a `find` operand)
    // and lexically normalized, which is also what keys the result map.
    const item = { path: path.resolve(s.path), maxDepth: s.maxDepth ?? DEFAULT_MAX_DEPTH, name: s.name ?? "*" };
    const key = `${item.path}\0${item.maxDepth}\0${item.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function memoryReader(files: ReadonlyMap<string, string>): DiscoveryReader {
  const trees = new Map<string, ProjectTree>();
  return {
    tree(root: string): ProjectTree {
      const abs = path.resolve(root);
      let t = trees.get(abs);
      if (!t) {
        const prefix = abs === "/" ? "/" : `${abs}/`;
        const sub = new Map<string, string | null>();
        for (const [k, v] of files) if (k.startsWith(prefix)) sub.set(k.slice(prefix.length), v);
        t = refProjectTree(sub);
        trees.set(abs, t);
      }
      return t;
    },
    text: (abs) => files.get(path.resolve(abs)) ?? null,
    json: (abs) => safeParseJson(files.get(path.resolve(abs)) ?? null),
  };
}

const emptyReader = memoryReader(new Map());

/** Stat-key → parsed value for the disclaimed `readJsonCached`. */
const disclaimedJsonCache = new Map<string, { key: string; value: any }>();

export const disclaimedDiscoveryFs: DiscoveryFs = {
  disclaimed: true,

  async load(selectors) {
    const items = normalizeSelectors(selectors);
    if (items.length === 0) return emptyReader;
    const argv = [SH, "-c", LOAD_SCRIPT, "sh"];
    for (const it of items) argv.push(it.path, String(it.maxDepth), it.name);
    const { bytes, truncated } = await runCapped(argv, PROJECT_TREE_TAR_MAX_BYTES);
    if (truncated) {
      console.warn(
        `[agetor] capability discovery hit the ${PROJECT_TREE_TAR_MAX_BYTES / (1024 * 1024)} MB read cap while reading ${items[0]!.path} (+${items.length - 1} more); some skills/commands may be missing`,
      );
    }
    const files = new Map<string, string>();
    for (const entry of parseTar(bytes)) {
      // tar strips the leading `/` from absolute member names; put it back.
      // `Buffer.toString("utf8")` keeps a leading BOM, like `readFileSync(…, "utf8")`.
      files.set(path.resolve("/", entry.path), Buffer.from(entry.data).toString("utf8"));
    }
    return memoryReader(files);
  },

  async readJsonCached(abs) {
    if (abs.includes("\0")) return null;
    const file = path.resolve(abs);
    const hit = disclaimedJsonCache.get(file);
    const { bytes } = await runCapped([SH, "-c", JSON_SCRIPT, "sh", file, hit?.key ?? ""], JSON_MAX_BYTES);
    const nl = bytes.indexOf(0x0a);
    if (nl < 0) {
      // Not stat-able (missing / denied / timed out): same as the in-process
      // path, which drops the entry and answers null.
      disclaimedJsonCache.delete(file);
      return null;
    }
    const key = Buffer.from(bytes.subarray(0, nl)).toString("utf8");
    if (hit && hit.key === key && nl === bytes.length - 1) return hit.value;
    const value = safeParseJson(Buffer.from(bytes.subarray(nl + 1)).toString("utf8") || null);
    disclaimedJsonCache.set(file, { key, value });
    return value;
  },
};

/** Which implementation applies right now: disclaimed iff the one disclaim
 *  switch is effectively on (darwin && switch && helper present). */
export function discoveryFs(): DiscoveryFs {
  return disclaimEnabled() ? disclaimedDiscoveryFs : inProcessDiscoveryFs;
}

/** Test seam: forget the disclaimed `readJsonCached` entries. */
export function __clearDisclaimedJsonCacheForTest(): void {
  disclaimedJsonCache.clear();
}

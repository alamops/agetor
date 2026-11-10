/**
 * The safe file-transfer engine used by the harness mirror and the provider
 * session transfer (docs/architecture/harness-stacks.md, plan T04).
 *
 * Everything it touches lives in an agent-writable harness home, so the rules
 * are deliberately narrow:
 * - reads are opened `O_NOFOLLOW`/non-blocking and must be regular files;
 * - every directory walk `lstat`s each entry and skips symlinks, FIFOs and
 *   devices rather than following them; a source path is also refused when any
 *   component *between* the account root and the entry is a symlink, so a
 *   linked intermediate directory cannot redirect a read outside the account;
 * - writes go to a sibling temp file, are fsynced, then renamed — so a reader
 *   never sees a half-written credential or session;
 * - a temp file an interrupted write left behind is removed, once it is an
 *   hour old, the next time a write lands in its folder
 *   (`sweepStaleTempFiles`);
 * - the mirror's tree copy preserves each file's mtime and skips a destination
 *   that already has the same size and mtime, so a repeat mirror rewrites only
 *   what changed;
 * - an account root that resolves (through a symlink planted after the
 *   account was saved) into a macOS TCC-protected home folder its stored path
 *   did not name is refused before anything is read or written
 *   (`rootRedirectRefusal`, resolved with `lstat`/`readlink` only, never a
 *   stat inside the target);
 * - cleanup unlinks only regular files whose path has a handoff shape
 *   (`isHandoffCopyShape`, tied to the recorded session id), never recurses, and prunes only empty folders
 *   inside that shape;
 * - every file is created 0600, every directory 0700;
 * - sizes and entry counts are capped, and both the walk and each individual
 *   read/write are chunked and asynchronous so a large copy cannot freeze the
 *   shared Bun main thread (all tasks run on it).
 */
import {
  lstatSync,
  mkdirSync,
  constants,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import {
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { READ_NOFOLLOW } from "./no-follow.ts";
import {
  isHandoffCopyShape,
  isHandoffPrunableDir,
  isNeverCopyPath,
  isNeverCopySegment,
  tccProtectedFolderOf,
} from "../shared/harness-mirror.ts";
import type { HarnessStackKind } from "../shared/types.ts";

/** 64 MB per file/tree and 5,000 entries per tree (plan T04 size caps). */
export const TRANSFER_MAX_BYTES = 64 * 1024 * 1024;
export const TRANSFER_MAX_ENTRIES = 5_000;
/** Yield to the shared event loop at least this often during a walk. */
const YIELD_EVERY_MS = 20;
const YIELD_EVERY_FILES = 32;

export interface TransferLimits {
  maxBytes?: number;
  maxEntries?: number;
}

export interface TreeCopyResult {
  /** Files written by this copy (relative to the source dir). */
  copied: string[];
  /** The subset of `copied` whose destination did not exist before the copy.
   *  A session handoff records only these for cleanup, so a file the
   *  destination account already had (e.g. its own original after an A→B→A
   *  wrap) is never put on the delete allowlist (contract C5). */
  created: string[];
  /** Files left alone because the destination already matched (size + mtime;
   *  only with `skipUnchanged`). */
  unchanged: string[];
  skipped: string[];
  /** True when a byte or entry budget stopped the walk before every regular
   *  file was copied (or an individual file was larger than the remaining
   *  budget). The mirror uses this to avoid rewriting a plugin registry that
   *  would then point at payload files which were never copied (review S3). */
  truncated: boolean;
}

/** A relative path that stays inside its root: non-empty, not absolute, no
 *  `..` segment. Throws otherwise. */
export function assertSafeRelPath(rel: string): void {
  if (typeof rel !== "string" || rel.length === 0) throw new Error("empty path");
  if (path.isAbsolute(rel)) throw new Error(`absolute path refused: ${rel}`);
  const parts = rel.split(/[\\/]+/);
  if (parts.some((p) => p === "..")) throw new Error(`parent traversal refused: ${rel}`);
  if (rel.includes("\0")) throw new Error("nul byte in path");
}

/** Defense in depth: refuse a never-copy path before it is read. */
export function assertNotCredentialPath(rel: string, kind: HarnessStackKind): void {
  assertSafeRelPath(rel);
  if (isNeverCopyPath(kind, rel)) throw new Error(`refusing to copy a credential/session path: ${rel}`);
}

/**
 * The canonical form of a config root: `realpath` of the path, or — when it does
 * not exist yet — `realpath` of its nearest existing ancestor joined with the
 * missing tail. Falls back to `path.resolve` when nothing resolves. Two
 * accounts whose roots alias each other through a symlink (`/a/link -> /b`)
 * compare equal here, which `path.resolve` alone cannot see.
 */
export function canonicalRoot(p: string): string {
  const resolved = path.resolve(p);
  let cur = resolved;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return resolved;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** True when two config roots are the same directory after resolving
 *  symlinks ({@link canonicalRoot}). Mirroring or transferring between them
 *  would copy an account onto itself, and cleanup would then delete the
 *  source's own files, so every caller refuses. Callers run
 *  {@link rootRedirectRefusal} first: `realpath` would otherwise stat inside a
 *  protected folder a root was redirected into. */
export function sameConfigRoot(a: string, b: string): boolean {
  return canonicalRoot(a) === canonicalRoot(b);
}

/** Symlinks followed by {@link resolvePathLexically} before it gives up (the
 *  macOS kernel's own MAXSYMLINKS). */
const MAX_LEXICAL_LINKS = 32;

/** Test seam: the home whose TCC-protected folders are checked. */
let tccHomeOverride: string | null = null;

/** Point the TCC-protected-folder checks at a fake home (null restores the
 *  real one). Tests only — `bun test` shares one process, so restore it. */
export function setTccHomeForTests(home: string | null): void {
  tccHomeOverride = home;
}

/** The home as spelled and its realpath (the home itself is never a protected
 *  folder, so resolving it is safe). */
function tccHomes(): string[] {
  const home = tccHomeOverride ?? homedir();
  const homes = [path.resolve(home)];
  try {
    const real = realpathSync(home);
    if (!homes.includes(real)) homes.push(real);
  } catch {
    // A missing home has no protected folders to resolve into.
  }
  return homes;
}

export interface LexicalResolution {
  /** Absolute path with every symlink the walk could see followed. */
  path: string;
  /** A component did not exist (or was not a directory); the remainder was
   *  joined on lexically. */
  missing: boolean;
  /** The protected home-folder entry (e.g. `"Documents"`) the path reached, or
   *  null (see `MACOS_TCC_PROTECTED_HOME_FOLDERS` in src/shared/harness-mirror.ts).
   *  The walk stops at such a folder: nothing below it is stat'ed and
   *  the remainder is joined on lexically. */
  protectedFolder: string | null;
  /** Too many links, or a component that could not be inspected. */
  error: string | null;
}

/**
 * Resolve `p` like `realpath`, but one component at a time with `lstat` +
 * `readlink`, so the core never stats INSIDE a macOS TCC-protected home folder
 * (docs/architecture/security.md, D24): the walk lstat's a protected folder's
 * own entry in the home (allowed) and stops there, and nothing below it is
 * touched. `..` is applied to the already-resolved prefix (POSIX semantics,
 * as `realpath` does), links are spliced in place, and more than
 * {@link MAX_LEXICAL_LINKS} links is an error. A missing component ends the
 * walk with the rest joined lexically. Synchronous and bounded: at most one
 * `lstat`/`readlink` per component and link.
 */
export function resolvePathLexically(p: string): LexicalResolution {
  const homes = tccHomes();
  // Not `path.resolve`: it would apply `..` lexically before the links that
  // precede it are followed.
  const absolute = path.isAbsolute(p) ? p : `${process.cwd()}${path.sep}${p}`;
  let pending = absolute.split(path.sep).filter(Boolean);
  let cur: string = path.sep;
  let links = 0;
  const finish = (resolved: string, extra: Partial<LexicalResolution>): LexicalResolution => {
    const normalized = path.resolve(resolved);
    return {
      path: normalized,
      missing: false,
      protectedFolder: tccProtectedFolderOf(normalized, homes),
      error: null,
      ...extra,
    };
  };
  while (pending.length > 0) {
    const part = pending.shift()!;
    if (part === ".") continue;
    if (part === "..") {
      cur = path.dirname(cur);
      continue;
    }
    // Inside a protected folder: never lstat below it. The folder is reported
    // even if the unresolved remainder's `..` would lexically climb back out:
    // what a component inside it links to is unknown.
    const inside = tccProtectedFolderOf(cur, homes);
    if (inside) return finish(path.join(cur, part, ...pending), { protectedFolder: inside });
    const next = path.join(cur, part);
    let st;
    try {
      st = lstatSync(next);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") return finish(path.join(next, ...pending), { missing: true });
      return finish(path.join(next, ...pending), { error: `${code ?? "error"} inspecting a path component` });
    }
    if (!st.isSymbolicLink()) {
      cur = next;
      continue;
    }
    if (++links > MAX_LEXICAL_LINKS) {
      return finish(path.join(next, ...pending), { error: "too many levels of symbolic links" });
    }
    let target: string;
    try {
      target = readlinkSync(next);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      return finish(path.join(next, ...pending), { error: `${code ?? "error"} reading a symbolic link` });
    }
    if (path.isAbsolute(target)) cur = path.sep;
    pending = [...target.split(path.sep).filter(Boolean), ...pending];
  }
  return finish(cur, {});
}

/**
 * Contract CR4 (docs/architecture/harness-stacks.md): the reason to refuse a
 * mirror or session transfer into or out of the account root `root`, or null
 * when it is safe. Roots are gated when an account is saved, but an agent can
 * later replace a root (or one of its parents) with a symlink into a
 * TCC-protected home folder, and the core would then read and write there in
 * its own process. The root is resolved lexically ({@link resolvePathLexically},
 * no stat inside the target) and refused when it lands in a protected folder
 * the stored path itself did not name, or when it cannot be resolved. A root
 * the user deliberately saved under a protected folder is unchanged (it was
 * gated as such), and ordinary system links (`/tmp` → `/private/tmp`, `/var`
 * → `/private/var`) never land in a protected folder.
 */
export function rootRedirectRefusal(root: string, what: string): string | null {
  const homes = tccHomes();
  const named = tccProtectedFolderOf(path.resolve(root), homes);
  const resolved = resolvePathLexically(root);
  if (resolved.error) return `${what} could not be resolved safely (${resolved.error})`;
  const landed = resolved.protectedFolder;
  if (landed && landed.toLowerCase() !== named?.toLowerCase()) {
    return `${what} now resolves into the macOS-protected folder ~/${landed} through a symbolic link — refused`;
  }
  return null;
}

/** {@link rootRedirectRefusal} for several roots: the first refusal, or null. */
export function rootsRedirectRefusal(roots: ReadonlyArray<readonly [root: string, what: string]>): string | null {
  for (const [root, what] of roots) {
    const reason = rootRedirectRefusal(root, what);
    if (reason) return reason;
  }
  return null;
}

/** True when `p` is a regular file that is NOT a symlink. */
export function isRegularFileNoFollow(p: string): boolean {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}

/** True when `p` is a plain directory (not a symlink). */
export function isPlainDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Create `dir` (and any missing ancestors) below `root`, refusing to walk
 * through a symlink or a non-directory. `root` itself is trusted: it is the
 * account's own config root, which a user may legitimately symlink — the
 * mirror and session transfer first refuse a root that now resolves into a
 * macOS-protected folder ({@link rootRedirectRefusal}, contract CR4). Every
 * component Agetor creates or descends into below it must be a real
 * directory, so an agent-writable home cannot redirect the mirror's writes
 * into a protected folder.
 *
 * A component swapped for a symlink between this check and the write is the
 * same accepted timing-race residual `isPlainDirBelow` documents.
 */
export function ensurePlainDirUnder(root: string, dir: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedDir = path.resolve(dir);
  const rel = path.relative(resolvedRoot, resolvedDir);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`destination escapes its root: ${dir}`);
  }
  if (rel === "") {
    mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
    return;
  }
  // The root itself is trusted and may not exist yet (a fresh alias home).
  mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
  let cur = resolvedRoot;
  for (const part of rel.split(path.sep)) {
    if (!part) continue;
    cur = path.join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      mkdirSync(cur, { mode: 0o700 });
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`refusing to write through a non-directory: ${cur}`);
    }
  }
}

/** A temp file this much older than now (by its last data OR inode change, so
 *  a copy that just stamped the source's old mtime onto its temp file still
 *  reads as fresh) was left by an interrupted write: no live write keeps a
 *  temp file anywhere near this long. */
const STALE_TEMP_MS = 60 * 60 * 1000;
/** One sweep per directory per this interval; a tree copy writes many files
 *  into one folder. */
const TEMP_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const TEMP_SWEEP_MEMO_MAX = 10_000;
/** Exactly the names {@link atomicWriteFile}, {@link copyRegularFileDetailed}
 *  and the mirror's link swaps create: `.agetor-tmp-<uuid>`. */
const TEMP_NAME_RE = /^\.agetor-tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sweptDirs = new Map<string, number>();
let staleTempAgeMs = STALE_TEMP_MS;

/**
 * Remove the `.agetor-tmp-*` leftovers of interrupted writes from `dir`. A crash
 * (or a kill) between a temp file's creation and its rename leaves it behind,
 * now of any size, and nothing else ever looks at it. Called wherever a write
 * is about to land in a folder (so every mirror and session transfer sweeps
 * the folders it writes into) and by the mirror for the destination folders it
 * visits. Only a direct entry with the exact temp-name shape that is a regular
 * file or a symlink (a link swap's temp) is removed, after an `lstat`: nothing
 * is followed, `unlink` of a link removes the link itself, and a folder is
 * never entered. `dir` must already be verified by the caller (a plain
 * directory below its trusted root). Best effort, never throws; at most one
 * sweep per folder per {@link TEMP_SWEEP_INTERVAL_MS}. Returns how many it
 * removed.
 */
export function sweepStaleTempFiles(dir: string): number {
  const key = path.resolve(dir);
  const now = Date.now();
  const last = sweptDirs.get(key);
  if (last !== undefined && now - last < TEMP_SWEEP_INTERVAL_MS) return 0;
  if (sweptDirs.size >= TEMP_SWEEP_MEMO_MAX) {
    for (const [d, at] of sweptDirs) if (now - at >= TEMP_SWEEP_INTERVAL_MS) sweptDirs.delete(d);
    if (sweptDirs.size >= TEMP_SWEEP_MEMO_MAX) sweptDirs.clear();
  }
  sweptDirs.set(key, now);
  let names: string[];
  try {
    if (!lstatSync(key).isDirectory()) return 0;
    names = readdirSync(key);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!TEMP_NAME_RE.test(name)) continue;
    const p = path.join(key, name);
    try {
      const st = lstatSync(p);
      if (!st.isFile() && !st.isSymbolicLink()) continue;
      if (now - Math.max(st.mtimeMs, st.ctimeMs) < staleTempAgeMs) continue;
      unlinkSync(p);
      removed++;
    } catch {
      // Gone already, or not ours to remove: leave it.
    }
  }
  return removed;
}

/** Tests only: treat temp files older than `ms` as stale (null restores the
 *  default) and forget which folders were swept. `bun test` shares one
 *  process, so restore it. */
export function setStaleTempAgeForTests(ms: number | null): void {
  staleTempAgeMs = ms ?? STALE_TEMP_MS;
  sweptDirs.clear();
}

/**
 * Chunk size for reads and writes. Every task shares Bun's main thread, so a
 * 64 MB session copy must yield between chunks instead of issuing one
 * multi-megabyte synchronous `readSync`/`writeSync` pair that freezes the app.
 */
const IO_CHUNK_BYTES = 1024 * 1024;

/**
 * Atomically write `data` to `p`: a sibling temp file gets the bytes, an
 * fsync, then a rename. A symlink at `p` is replaced by the rename, never
 * followed. The file ends 0600 (and the caller's parent dir is created 0700).
 * The bytes are written in asynchronous chunks so a large mirror file cannot
 * block the shared event loop.
 */
export async function atomicWriteFile(
  p: string,
  data: string | Uint8Array,
  opts: { mode?: number; root?: string } = {},
): Promise<void> {
  const dir = path.dirname(p);
  // With a root, only real directories below it may be traversed. Without one
  // (a caller that already owns the path, e.g. a temp dir in a test) the
  // historical recursive mkdir is fine.
  if (opts.root) ensurePlainDirUnder(opts.root, dir);
  else mkdirSync(dir, { recursive: true, mode: 0o700 });
  sweepStaleTempFiles(dir);
  const tmp = path.join(dir, `.agetor-tmp-${randomUUID()}`);
  try {
    const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
      let written = 0;
      while (written < buf.length) {
        const { bytesWritten } = await handle.write(buf, written, buf.length - written);
        if (bytesWritten <= 0) throw new Error(`short write to ${tmp}`);
        written += bytesWritten;
      }
      // On the open descriptor, never by path: the temp name sits in an
      // agent-writable folder, and a link swapped in at it would be followed.
      await handle.chmod(opts.mode ?? 0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, p);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      // Temp file never created or already renamed — nothing to clean.
    }
    throw err;
  }
}

export interface CopyFileOptions {
  maxBytes?: number;
  root?: string;
  /** Mirror mode: preserve the source's mtime on the copy, and leave a
   *  destination alone when it is already a regular file (not a symlink) with
   *  the source's size and mtime. Because every mirror write preserves the
   *  mtime, an unchanged file matches on the next mirror; a file the backup's
   *  CLI (or the user) edited gets a new mtime and is copied again. */
  skipUnchanged?: boolean;
}

export interface CopyFileResult {
  bytes: number;
  /** The destination did not exist (lstat ENOENT) before this copy. */
  created: boolean;
  /** `skipUnchanged` matched: nothing was written. */
  unchanged: boolean;
}

/** mtimes compared to the millisecond: `utimes` takes float seconds, so the
 *  stored value can differ from the source's by a rounding of under 1 ms. */
function sameMtime(a: number, b: number): boolean {
  return Math.abs(a - b) < 1;
}

/**
 * Copy one regular file, refusing a symlink/FIFO at the source and a size
 * over `maxBytes`. Writes atomically and 0600. The source is read in
 * asynchronous chunks (from an already-open, no-follow descriptor) so a large
 * session transcript does not block every other task on Bun's main thread.
 * Returns the byte count.
 */
export async function copyRegularFile(
  src: string,
  dest: string,
  opts: CopyFileOptions = {},
): Promise<number> {
  return (await copyRegularFileDetailed(src, dest, opts)).bytes;
}

/** {@link copyRegularFile} that also reports whether the destination was new
 *  and whether an unchanged destination was skipped. */
export async function copyRegularFileDetailed(
  src: string,
  dest: string,
  opts: CopyFileOptions = {},
): Promise<CopyFileResult> {
  const maxBytes = opts.maxBytes ?? TRANSFER_MAX_BYTES;
  // `lstat` only gives an early, friendly error; the authoritative type and
  // size come from the already-open, no-follow descriptor so a file swapped
  // between the check and the open cannot change what is copied.
  const pre = lstatSync(src);
  if (pre.isSymbolicLink()) throw new Error(`symlink refused: ${src}`);
  if (!pre.isFile()) throw new Error(`not a regular file: ${src}`);
  const source = await open(src, READ_NOFOLLOW);
  try {
    const st = await source.stat();
    if (!st.isFile()) throw new Error(`not a regular file: ${src}`);
    if (st.size > maxBytes) throw new Error(`file too large: ${src}`);
    const dir = path.dirname(dest);
    if (opts.root) ensurePlainDirUnder(opts.root, dir);
    else mkdirSync(dir, { recursive: true, mode: 0o700 });
    sweepStaleTempFiles(dir);
    let created = false;
    try {
      const existing = lstatSync(dest);
      if (
        opts.skipUnchanged
        && existing.isFile()
        && existing.size === st.size
        && sameMtime(existing.mtimeMs, st.mtimeMs)
      ) {
        return { bytes: st.size, created: false, unchanged: true };
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") created = true;
      else throw err;
    }
    const tmp = path.join(dir, `.agetor-tmp-${randomUUID()}`);
    const chunk = Buffer.allocUnsafe(Math.min(IO_CHUNK_BYTES, Math.max(1, st.size)));
    let total = 0;
    try {
      const target = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        while (total < st.size) {
          const want = Math.min(chunk.length, st.size - total);
          const { bytesRead } = await source.read(chunk, 0, want, total);
          if (bytesRead <= 0) break;
          let written = 0;
          while (written < bytesRead) {
            const { bytesWritten } = await target.write(chunk, written, bytesRead - written);
            if (bytesWritten <= 0) throw new Error(`short write to ${tmp}`);
            written += bytesWritten;
          }
          total += bytesRead;
        }
        // The rename below keeps the inode's times, so the mirror's
        // unchanged-file check sees the source's mtime on the next run.
        if (opts.skipUnchanged) await target.utimes(st.atime, st.mtime);
        // By descriptor, like the write itself (see `atomicWriteFile`).
        await target.chmod(0o600);
        await target.sync();
      } finally {
        await target.close();
      }
      await rename(tmp, dest);
    } catch (err) {
      try {
        await unlink(tmp);
      } catch {
        // Temp file never created or already renamed — nothing to clean.
      }
      throw err;
    }
    return { bytes: total, created, unchanged: false };
  } finally {
    await source.close();
  }
}

/**
 * Merge a directory tree into the destination without following symlinks.
 *
 * A stack mirror must be additive: the destination account may have its own
 * skills, plugins or prompts that the primary does not, and deleting a whole
 * destination directory on every mirror would silently destroy them. So this
 * walks the source and copies each regular file atomically **over** the same
 * relative path, leaving destination-only files and directories untouched.
 * Each file is all-or-nothing; a crash can leave a mix of old and new files
 * (there is no safe whole-tree rename that also preserves destination-only
 * entries).
 *
 * The walk skips anything that is not a regular file or a plain directory,
 * any `.git` entry at any depth (a clone's config can carry a remote token),
 * entries for which `skip` returns true, and — with `root` — any destination
 * path that would traverse a symlink. Returns the relative paths copied (and
 * which of those were new at the destination), left unchanged (with
 * `skipUnchanged`) and skipped, plus whether a size/entry cap truncated the
 * tree (the mirror uses the flag to keep a plugin registry from pointing at a
 * partial copy).
 */
export async function copyTreeCooperative(
  srcDir: string,
  destDir: string,
  opts: TransferLimits & {
    skip?: (rel: string, entry: "file" | "dir") => boolean;
    /** Trusted destination root; every path below it must be a real dir. */
    root?: string;
    /** See {@link CopyFileOptions.skipUnchanged}. */
    skipUnchanged?: boolean;
  } = {},
): Promise<TreeCopyResult> {
  const maxBytes = opts.maxBytes ?? TRANSFER_MAX_BYTES;
  const maxEntries = opts.maxEntries ?? TRANSFER_MAX_ENTRIES;
  const copied: string[] = [];
  const created: string[] = [];
  const unchanged: string[] = [];
  const skipped: string[] = [];
  let truncated = false;
  if (!isPlainDir(srcDir)) return { copied, created, unchanged, skipped, truncated };

  const ensureDestDir = (target: string): boolean => {
    try {
      if (opts.root) ensurePlainDirUnder(opts.root, target);
      else mkdirSync(target, { recursive: true, mode: 0o700 });
    } catch {
      return false;
    }
    return isPlainDir(target);
  };

  if (!ensureDestDir(destDir)) {
    throw new Error(`destination is not a plain directory: ${destDir}`);
  }

  let bytes = 0;
  let entries = 0;
  let lastYield = Date.now();
  const maybeYield = async () => {
    if (entries % YIELD_EVERY_FILES === 0 || Date.now() - lastYield >= YIELD_EVERY_MS) {
      lastYield = Date.now();
      await Bun.sleep(0);
    }
  };

  const walk = async (rel: string): Promise<void> => {
    // Each visited entry costs exactly one slot. The tree root itself is not an
    // entry, so a tree of N files fits an N-entry budget. The count used to be
    // bumped once by the parent loop AND again when the file was copied, which
    // halved the effective budget and truncated plugin payloads early
    // (R17-S1).
    if (rel && entries >= maxEntries) {
      truncated = true;
      skipped.push(rel);
      return;
    }
    if (rel) {
      entries++;
      await maybeYield();
    }
    // Defense in depth for every caller (the mirror passes its own allowlist
    // skip, but session sidecars do not): a `.git` at any depth can carry a
    // clone's remote URL/token and is never conversation or config payload.
    if (rel && rel.split(/[\\/]+/).some((segment) => isNeverCopySegment(segment))) {
      skipped.push(rel);
      return;
    }
    const abs = path.join(srcDir, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch (err) {
      // The entry vanished between `readdir` and this `lstat` (an agent
      // rotating its own cache, a concurrent delete). Skip it; one orphan
      // must not abort the whole tree copy. Any other failure is a real I/O
      // problem and must still surface as the mirror's warning.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      skipped.push(rel);
      return;
    }
    if (st.isSymbolicLink()) {
      skipped.push(rel);
      return;
    }
    if (st.isDirectory()) {
      if (rel && opts.skip?.(rel, "dir") === true) {
        skipped.push(rel);
        return;
      }
      const target = path.join(destDir, rel);
      if (rel && !ensureDestDir(target)) {
        skipped.push(rel);
        return;
      }
      const names = requireSortedNames(abs);
      for (const name of names) {
        const childRel = rel ? path.join(rel, name) : name;
        await walk(childRel);
      }
      // Deliberately do NOT record the directory in `copied`. The merge is
      // additive, so the destination dir may hold files Agetor never wrote;
      // the handoff cleanup allowlist must only name the files it copied.
      return;
    }
    if (!st.isFile()) {
      skipped.push(rel);
      return;
    }
    if (rel && opts.skip?.(rel, "file") === true) {
      skipped.push(rel);
      return;
    }
    if (bytes + st.size > maxBytes) {
      truncated = true;
      skipped.push(rel);
      return;
    }
    const target = path.join(destDir, rel);
    let result: CopyFileResult;
    try {
      result = await copyRegularFileDetailed(abs, target, {
        maxBytes: Math.max(1, maxBytes - bytes),
        root: opts.root,
        skipUnchanged: opts.skipUnchanged,
      });
      // An unchanged file still counts toward the budget: the budget bounds
      // the payload's size, and `truncated` must mean the same thing on every
      // run.
      bytes += result.bytes;
    } catch (err) {
      // Skip the per-file refusals (a vanished/rotated file, a symlink or FIFO
      // the walk could not see through, an oversized file) so the rest of the
      // tree still mirrors. A real destination failure (permissions, disk)
      // must still reach the caller as a warning.
      const message = err instanceof Error ? err.message : String(err);
      const benign = !isRegularFileNoFollow(abs)
        || message.startsWith("symlink refused")
        || message.startsWith("not a regular file")
        || message.startsWith("file too large");
      if (!benign) throw err;
      // A file that no longer fits the remaining per-tree budget is the same
      // incomplete-tree signal as the pre-check above.
      if (message.startsWith("file too large")) truncated = true;
      skipped.push(rel);
      return;
    }
    if (result.unchanged) {
      unchanged.push(rel);
      return;
    }
    copied.push(rel);
    if (result.created) created.push(rel);
  };

  await walk("");
  return { copied, created, unchanged, skipped, truncated };
}

/**
 * Whether `dest` (below the trusted `root`) is absent, present or unsafe to ask
 * about. `lstat` refuses to follow only the LAST component; the kernel still
 * follows a symlinked parent, which would stat inside a macOS-protected folder
 * under Agetor's identity. So this walks from `root` one component at a time:
 * a missing component means absent, a symlink or non-directory parent means
 * unsafe, and only the leaf of a verified plain chain is `lstat`ed.
 */
export function destinationState(root: string, dest: string): "absent" | "present" | "unsafe" {
  const resolvedRoot = path.resolve(root);
  const rel = path.relative(resolvedRoot, path.resolve(dest));
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return "unsafe";
  const parts = rel.split(path.sep).filter(Boolean);
  let cur = resolvedRoot;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]!);
    let st;
    try {
      st = lstatSync(cur);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unsafe";
    }
    if (i === parts.length - 1) return "present";
    if (st.isSymbolicLink() || !st.isDirectory()) return "unsafe";
  }
  return "present";
}

/**
 * The destination files a {@link copyTreeCooperative} of `srcDir` into
 * `destDir` would CREATE: every regular file the copy would visit whose
 * destination does not exist yet (`lstat` ENOENT). A session handoff records
 * these BEFORE copying, so a crash between the copy and the handoff row never
 * leaves files nothing can clean up. It mirrors the copy's walk (same order,
 * same entry budget, no symlinks, never-copy segments skipped) and is
 * cooperative; every destination stat goes through {@link destinationState}
 * (`opts.root` is the trusted destination account root). A destination path that is recorded but never created is
 * harmless: cleanup skips a missing file.
 */
export async function planTreeDestinations(
  srcDir: string,
  destDir: string,
  opts: { maxEntries?: number; root: string },
): Promise<string[]> {
  const maxEntries = opts.maxEntries ?? TRANSFER_MAX_ENTRIES;
  const planned: string[] = [];
  if (!isPlainDir(srcDir)) return planned;
  let entries = 0;
  let lastYield = Date.now();
  const walk = async (rel: string): Promise<void> => {
    if (rel) {
      if (entries >= maxEntries) return;
      entries++;
      if (entries % YIELD_EVERY_FILES === 0 || Date.now() - lastYield >= YIELD_EVERY_MS) {
        lastYield = Date.now();
        await Bun.sleep(0);
      }
      if (rel.split(/[\\/]+/).some((segment) => isNeverCopySegment(segment))) return;
    }
    const abs = path.join(srcDir, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const name of requireSortedNames(abs)) await walk(rel ? path.join(rel, name) : name);
      return;
    }
    if (!st.isFile()) return;
    const target = path.join(destDir, rel);
    // Only a destination provably absent behind a plain chain is intended.
    if (destinationState(opts.root, target) === "absent") planned.push(target);
  };
  await walk("");
  return planned;
}

function requireSortedNames(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch (err) {
    // A directory deleted mid-walk contributes nothing; the caller records
    // the skipped entry. Any other failure is surfaced as a mirror warning.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    return [];
  }
}

/**
 * True when every component of `p` **between** `root` and its final component
 * is a real, non-symlink directory. `root` itself is trusted (a user may
 * legitimately symlink `~/.claude`), matching {@link ensurePlainDirUnder}.
 *
 * The final component is deliberately not inspected: callers combine this
 * with `isPlainDir` / `isRegularFileNoFollow`, which reject a symlink or
 * special file at the leaf. Applied to a mirror/session **source**, this is
 * what stops a linked intermediate directory (`~/.claude/plugins` →
 * somewhere outside the account) from redirecting the read: an `lstat` of the
 * leaf would happily report the linked target's regular file.
 */
export function isPlainAncestorPathUnder(root: string, p: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(p);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  let cur = resolvedRoot;
  const parts = rel.split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    cur = path.join(cur, parts[i]!);
    let st;
    try {
      st = lstatSync(cur);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // A missing ancestor (or one that is not a directory) means the leaf
      // cannot be read either — leave the decision to the leaf's own
      // lstat/open so an absent optional directory stays a silent no-op.
      // Any other failure is surfaced as unsafe.
      return code === "ENOENT" || code === "ENOTDIR";
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
  }
  return true;
}

/**
 * True when every component of `p` below `root` exists, is not a symlink, and
 * every ancestor is a real directory. `root` itself is trusted (it may be a
 * user-created symlink), matching {@link ensurePlainDirUnder}. Used by the
 * cleanup path: a symlinked parent inside an agent-writable home could
 * otherwise redirect a recorded copy path to a file outside the account.
 */
export function isPlainPathUnder(root: string, p: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(p);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  let cur = resolvedRoot;
  const parts = rel.split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]!);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return false;
    }
    if (st.isSymbolicLink()) return false;
    if (i < parts.length - 1 && !st.isDirectory()) return false;
  }
  return true;
}

/** How {@link removeCopiedPathsDetailed} classified every recorded path. */
export interface RemoveCopiesResult {
  /** Files unlinked by this call. */
  removed: string[];
  /** Recorded paths that no longer exist (nothing left to remove). */
  gone: string[];
  /** Paths NOT touched that may still be ours to remove later: outside the
   *  current root (the account's root changed), the root is refused, or the
   *  unlink failed. A caller keeps its handoff row while this is non-empty. */
  retained: string[];
  /** Paths never ours to touch: garbage, wrong shape, a different session id,
   *  a symlinked component, or not a regular file. Dropped from the row. */
  rejected: string[];
}

/**
 * Remove recorded handoff copies. A path is unlinked only when ALL of these
 * hold, and nothing is ever removed recursively:
 * - it resolves strictly inside `root`;
 * - its root-relative shape is one a session handoff writes for `kind` AND the
 *   recorded `sessionId` (`isHandoffCopyShape`): Claude
 *   `projects/<enc>/<sid>.jsonl`, a file in that session's
 *   `subagents`/`tool-results`/`mcp-tasks` folder or `file-history/<sid>/`,
 *   Codex `sessions/YYYY/MM/DD/rollout-*-<sid>.jsonl`;
 * - `root` itself does not resolve into a protected folder it was not saved
 *   under ({@link rootRedirectRefusal}; otherwise nothing is removed);
 * - every component below `root` is a real, non-symlink path
 *   ({@link isPlainPathUnder}) and the leaf is a regular file (a directory, a
 *   symlink or a special file at a recorded path is left alone).
 * The paths come from SQLite, which an agent can write, so the shape rule tied
 * to the session id is what keeps a planted row from deleting anything else in
 * the account (another session's transcript included).
 *
 * After each unlink the now-empty folders inside the shape are pruned
 * (`isHandoffPrunableDir`): the session folder and its sidecar folders,
 * `file-history/<sid>`, or Codex's date folders. Only plain, empty directories
 * are removed, so a folder still holding the backup's own files stays, and
 * `projects/<enc>`, `projects`, `file-history` and `sessions` are never pruned.
 *
 * Cooperative: it yields to the shared event loop every ~20 ms, because a
 * handoff with large sidecars can record thousands of files. `shouldStop` is
 * asked before the first file and after every yield; once it says yes, the
 * rest are `retained`. Never throws.
 */
export async function removeCopiedPathsDetailed(
  paths: readonly string[],
  root: string,
  kind: HarnessStackKind,
  sessionId: string,
  opts: { shouldStop?: () => boolean } = {},
): Promise<RemoveCopiesResult> {
  const resolvedRoot = path.resolve(root);
  const out: RemoveCopiesResult = { removed: [], gone: [], retained: [], rejected: [] };
  const valid = paths.filter((p): p is string => typeof p === "string" && p !== "" && !p.includes("\0"));
  const validSet = new Set(valid);
  for (const p of paths) if (!validSet.has(p)) out.rejected.push(String(p));
  // Contract CR4: a root redirected into a protected folder is never touched.
  if (rootRedirectRefusal(resolvedRoot, "the account's config directory")) {
    out.retained.push(...valid);
    return out;
  }
  let lastYield = Date.now();
  // Nothing else runs between two yields, so `shouldStop` is asked before the
  // first file and again after every yield: its answer cannot change in
  // between, and each unlink follows a check with no await in between.
  let mustCheck = true;
  for (let i = 0; i < valid.length; i++) {
    const p = valid[i]!;
    if (Date.now() - lastYield >= YIELD_EVERY_MS) {
      await Bun.sleep(0);
      lastYield = Date.now();
      mustCheck = true;
    }
    if (mustCheck && opts.shouldStop?.()) {
      out.retained.push(...valid.slice(i));
      break;
    }
    mustCheck = false;
    const resolved = path.resolve(p);
    const rel = path.relative(resolvedRoot, resolved);
    if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      // Not under the CURRENT root: the account's root may have been changed
      // after the copy, so the file is still out there. Keep the record.
      out.retained.push(p);
      continue;
    }
    if (!isHandoffCopyShape(kind, rel.split(path.sep).join("/"), sessionId)) {
      out.rejected.push(p);
      continue;
    }
    // A symlinked directory anywhere between the root and the recorded file
    // resolves outside the root. `path.resolve` cannot see that, so walk and
    // `lstat` every component before touching the target.
    if (!isPlainPathUnder(resolvedRoot, resolved)) {
      // A missing component is "already gone"; a symlinked one is not ours.
      if (!existsLexically(resolvedRoot, resolved)) out.gone.push(p);
      else out.rejected.push(p);
      continue;
    }
    try {
      if (!lstatSync(resolved).isFile()) {
        out.rejected.push(p);
        continue;
      }
      unlinkSync(resolved);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") out.gone.push(p);
      else out.retained.push(p);
      continue;
    }
    out.removed.push(resolved);
    pruneEmptyShapeDirs(resolvedRoot, path.dirname(resolved), kind, sessionId);
  }
  return out;
}

/** True when every component of `p` below `root` exists as an `lstat` entry
 *  (symlinks are not followed). Used only to tell "already gone" from "behind a
 *  symlink" after {@link isPlainPathUnder} refused a path. */
function existsLexically(root: string, p: string): boolean {
  let cur = root;
  for (const part of path.relative(root, p).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    try {
      const st = lstatSync(cur);
      if (st.isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return true;
}

/** {@link removeCopiedPathsDetailed} reduced to the unlinked files. */
export async function removeCopiedPaths(
  paths: readonly string[],
  root: string,
  kind: HarnessStackKind,
  sessionId: string,
): Promise<string[]> {
  return (await removeCopiedPathsDetailed(paths, root, kind, sessionId)).removed;
}

/** Remove empty plain directories from `start` upwards while they are inside
 *  a handoff shape (`isHandoffPrunableDir`). Stops at the first non-empty,
 *  non-directory, symlinked or out-of-shape component, so a backup's own
 *  content and the account's own folders are never pruned. */
function pruneEmptyShapeDirs(root: string, start: string, kind: HarnessStackKind, sessionId: string): void {
  let cur = path.resolve(start);
  for (;;) {
    const rel = path.relative(root, cur);
    if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return;
    if (!isHandoffPrunableDir(kind, rel.split(path.sep).join("/"), sessionId)) return;
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return;
    let names: string[];
    try {
      names = readdirSync(cur);
    } catch {
      return;
    }
    if (names.length > 0) return;
    try {
      rmdirSync(cur);
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
}

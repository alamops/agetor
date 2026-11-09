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
 * - the mirror's tree copy preserves each file's mtime and skips a destination
 *   that already has the same size and mtime, so a repeat mirror rewrites only
 *   what changed;
 * - cleanup unlinks only regular files whose path has a handoff shape
 *   (`isHandoffCopyShape`), never recurses, and prunes only empty folders
 *   inside that shape;
 * - every file is created 0600, every directory 0700;
 * - sizes and entry counts are capped, and both the walk and each individual
 *   read/write are chunked and asynchronous so a large copy cannot freeze the
 *   shared Bun main thread (all tasks run on it).
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  constants,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import {
  chmod,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { READ_NOFOLLOW } from "./no-follow.ts";
import {
  isHandoffCopyShape,
  isHandoffPrunableDir,
  isNeverCopyPath,
  isNeverCopySegment,
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
 *  source's own files, so every caller refuses. */
export function sameConfigRoot(a: string, b: string): boolean {
  return canonicalRoot(a) === canonicalRoot(b);
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
 * account's own config root, which a user may legitimately symlink. Every
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
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(tmp, opts.mode ?? 0o600);
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
        await target.sync();
      } finally {
        await target.close();
      }
      await chmod(tmp, 0o600);
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
      const benign = !existsSync(abs)
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

/**
 * Remove recorded handoff copies. A path is unlinked only when ALL of these
 * hold, and nothing is ever removed recursively:
 * - it resolves strictly inside `root`;
 * - its root-relative shape is one a session handoff writes for `kind`
 *   (`isHandoffCopyShape`): Claude `projects/<enc>/<sid>.jsonl` or a file in
 *   that session's `subagents`/`tool-results`/`mcp-tasks` folder, Codex
 *   `sessions/YYYY/MM/DD/rollout-*.jsonl`;
 * - every component below `root` is a real, non-symlink path
 *   ({@link isPlainPathUnder}) and the leaf is a regular file (a directory, a
 *   symlink or a special file at a recorded path is left alone).
 * The paths come from SQLite, which an agent can write, so the shape rule is
 * what keeps a planted row from deleting anything else in the account.
 *
 * After each unlink the now-empty folders inside the shape are pruned
 * (`isHandoffPrunableDir`): a Claude session folder and its sidecar folders, or
 * Codex's date folders. Only plain, empty directories are removed, so a folder
 * still holding the backup's own files stays, and `projects/<enc>`,
 * `projects` and `sessions` are never pruned.
 *
 * Cooperative: it yields to the shared event loop every ~20 ms, because a
 * handoff with large sidecars can record thousands of files. Never throws.
 */
export async function removeCopiedPaths(
  paths: readonly string[],
  root: string,
  kind: HarnessStackKind,
): Promise<string[]> {
  const resolvedRoot = path.resolve(root);
  const removed: string[] = [];
  let lastYield = Date.now();
  for (const p of paths) {
    if (Date.now() - lastYield >= YIELD_EVERY_MS) {
      await Bun.sleep(0);
      lastYield = Date.now();
    }
    if (typeof p !== "string" || !p || p.includes("\0")) continue;
    const resolved = path.resolve(p);
    const rel = path.relative(resolvedRoot, resolved);
    if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
    if (!isHandoffCopyShape(kind, rel.split(path.sep).join("/"))) continue;
    // A symlinked directory anywhere between the root and the recorded file
    // resolves outside the root. `path.resolve` cannot see that, so walk and
    // `lstat` every component before touching the target.
    if (!isPlainPathUnder(resolvedRoot, resolved)) continue;
    try {
      if (!lstatSync(resolved).isFile()) continue;
      unlinkSync(resolved);
    } catch {
      continue;
    }
    removed.push(resolved);
    pruneEmptyShapeDirs(resolvedRoot, path.dirname(resolved), kind);
  }
  return removed;
}

/** Remove empty plain directories from `start` upwards while they are inside
 *  a handoff shape (`isHandoffPrunableDir`). Stops at the first non-empty,
 *  non-directory, symlinked or out-of-shape component, so a backup's own
 *  content and the account's own folders are never pruned. */
function pruneEmptyShapeDirs(root: string, start: string, kind: HarnessStackKind): void {
  let cur = path.resolve(start);
  for (;;) {
    const rel = path.relative(root, cur);
    if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return;
    if (!isHandoffPrunableDir(kind, rel.split(path.sep).join("/"))) return;
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

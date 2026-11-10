/**
 * Originals saved before a mirror run overwrites or removes something a backup
 * account already had (docs/architecture/harness-stacks.md, plan D9).
 *
 * Layout under `<dataDir>/mirror-backups/<harnessId>/`:
 * - `files/<rel>`: a whole file, byte for byte;
 * - `links/<rel>`: a symlink's target, as text;
 * - `keys/<encoded file>.json`: one JSON object per merged file, key path ->
 *   the original value (a string of block text for TOML).
 *
 * The directory lives in the data dir, never inside an account root (an agent
 * writes those). Directories are 0700, files 0600, every write is atomic, and
 * an item that is already backed up is never backed up again, so the backup
 * always holds the TRUE original, not a value an earlier mirror wrote. Backups
 * can hold secrets (an env value the mirror replaced), which is why they are
 * 0600 and are removed with the account.
 *
 * Nothing here trusts a provenance row: refs are recomputed from the harness id
 * and the relative path, never taken from a row's text. Nor does it trust the
 * directory tree: the data dir is agent-writable, so every access resolves its
 * ref through {@link resolveBackupPath}, which lstats each component from
 * `mirror-backups/` down and treats a symlink or non-directory parent as
 * missing (it never follows one). Reads open no-follow handles and are
 * asynchronous; removal walks the tree cooperatively without following links.
 */
import { lstatSync, mkdirSync } from "node:fs";
import { lstat, open, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { assertSafeRelPath, atomicWriteFile, copyRegularFileDetailed } from "./harness-file-transfer.ts";
import { dataDir } from "./db.ts";
import { READ_NOFOLLOW } from "./no-follow.ts";
import { isSafePathSegment } from "../shared/harness-mirror.ts";

/** Largest file a backup will hold (matches the mirror's own merged-file cap
 *  scaled up for a skill's bundled assets). */
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

function backupsRoot(): string {
  return path.join(dataDir, "mirror-backups");
}

function assertSafeId(harnessId: string): void {
  if (!isSafePathSegment(harnessId)) throw new Error("invalid account id for a mirror backup");
}

function harnessDir(harnessId: string): string {
  assertSafeId(harnessId);
  return path.join(backupsRoot(), harnessId);
}

/** Create `dir` and every missing ancestor below the data dir as 0700, refusing
 *  a symlinked or non-directory component. */
function ensureBackupDir(dir: string): void {
  const rel = path.relative(dataDir, dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("backup path escapes the data directory");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let cur = dataDir;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      mkdirSync(cur, { mode: 0o700 });
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("refusing a backup path through a non-directory");
  }
}

/** The ref (relative to the mirror-backups directory) of a file original. */
export function fileBackupRef(harnessId: string, rel: string): string {
  assertSafeId(harnessId);
  assertSafeRelPath(rel);
  return `${harnessId}/files/${rel}`;
}

function linkBackupRef(harnessId: string, rel: string): string {
  assertSafeId(harnessId);
  assertSafeRelPath(rel);
  return `${harnessId}/links/${rel}`;
}

function keyBackupRef(harnessId: string, file: string): string {
  assertSafeId(harnessId);
  assertSafeRelPath(file);
  return `${harnessId}/keys/${encodeURIComponent(file)}.json`;
}

function modeRef(harnessId: string, rel: string): string {
  assertSafeId(harnessId);
  assertSafeRelPath(rel);
  return `${harnessId}/modes/${rel}`;
}

function absForRef(ref: string): string {
  const abs = path.resolve(backupsRoot(), ref);
  const rel = path.relative(backupsRoot(), abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("backup ref escapes the backups directory");
  return abs;
}

/**
 * Resolve a ref to an absolute path AND verify the chain from the data dir is
 * plain: `mirror-backups/` and every parent directory of the leaf must be a
 * real directory (a missing one is fine: nothing is there). Returns null, with
 * a warning, when a component is a symlink or not a directory. The leaf itself
 * is the caller's business (reads open it no-follow; an unlink or atomic
 * rename only ever touches the link, never its target). Throws on a ref that
 * escapes the store.
 */
function resolveBackupPath(ref: string): string | null {
  const abs = absForRef(ref);
  const rel = path.relative(backupsRoot(), abs);
  const parts = rel.split(path.sep).filter(Boolean);
  let cur = backupsRoot();
  const chain = [cur];
  for (const part of parts.slice(0, -1)) {
    cur = path.join(cur, part);
    chain.push(cur);
  }
  for (const dir of chain) {
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      return abs;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      console.warn(`[harness-mirror] a mirror backup path goes through a non-directory (${path.basename(dir)}) — treated as missing`);
      return null;
    }
  }
  return abs;
}

/** Like {@link resolveBackupPath}, but a write needs a usable path. */
function resolveForWrite(ref: string): string {
  const abs = resolveBackupPath(ref);
  if (abs === null) throw new Error("refusing a backup path through a symlink or non-directory");
  return abs;
}

function exists(p: string | null): boolean {
  if (p === null) return false;
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

async function readBounded(p: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(p, READ_NOFOLLOW);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Error(`not a regular file: ${p}`);
    if (st.size > maxBytes) throw new Error("file too large");
    const buf = Buffer.allocUnsafe(st.size);
    let read = 0;
    while (read < buf.length) {
      const { bytesRead } = await handle.read(buf, read, buf.length - read, read);
      if (bytesRead <= 0) break;
      read += bytesRead;
    }
    return buf.subarray(0, read);
  } finally {
    await handle.close();
  }
}

/**
 * Save the regular file at `src` as the original of `rel`, plus its permission
 * bits. Without `force`, an original that is already saved is kept (the true
 * original is never replaced). A caller passes `force` when no provenance row
 * references the saved entry (an orphan from a dropped row or an earlier
 * Restore) or when the account's own edit must become the original; the
 * caller writes its intent row first, so a crash stays recoverable. The copy is
 * chunked and asynchronous, from a no-follow descriptor. Returns the ref.
 */
export async function backupFileOriginal(
  harnessId: string,
  rel: string,
  src: string,
  opts: { force?: boolean } = {},
): Promise<string> {
  const ref = fileBackupRef(harnessId, rel);
  const dest = resolveForWrite(ref);
  if (!opts.force && exists(dest)) return ref;
  const st = lstatSync(src);
  if (!st.isFile()) throw new Error(`not a regular file: ${src}`);
  ensureBackupDir(path.dirname(dest));
  await copyRegularFileDetailed(src, dest, { root: dataDir, maxBytes: MAX_BACKUP_BYTES });
  const modePath = resolveForWrite(modeRef(harnessId, rel));
  ensureBackupDir(path.dirname(modePath));
  // Permission bits only: never a setuid/setgid/sticky bit.
  await atomicWriteFile(modePath, (st.mode & 0o777).toString(8), { mode: 0o600 });
  return ref;
}

/** The saved permission bits of a file original, or null. */
export async function readBackupMode(harnessId: string, rel: string): Promise<number | null> {
  try {
    const abs = resolveBackupPath(modeRef(harnessId, rel));
    if (abs === null) return null;
    const text = (await readBounded(abs, 16)).toString("utf8").trim();
    return /^[0-7]{1,4}$/.test(text) ? parseInt(text, 8) & 0o777 : null;
  } catch {
    return null;
  }
}

/** Save a symlink's target as the original of the link at `rel` (see
 *  {@link backupFileOriginal} for `force`). */
export async function backupLinkOriginal(
  harnessId: string,
  rel: string,
  target: string,
  opts: { force?: boolean } = {},
): Promise<string> {
  const ref = linkBackupRef(harnessId, rel);
  const dest = resolveForWrite(ref);
  if (!opts.force && exists(dest)) return ref;
  ensureBackupDir(path.dirname(dest));
  await atomicWriteFile(dest, target, { mode: 0o600 });
  return ref;
}

/**
 * Save `value` as the original of `keyPath` in the merged file `file`. The key
 * file is a JSON object merged by key path; without `force` a key that is
 * already in it keeps its first value (see {@link backupFileOriginal}).
 * Returns the ref of the key file.
 */
export async function backupKeyOriginal(
  harnessId: string,
  file: string,
  keyPath: string,
  value: unknown,
  opts: { force?: boolean } = {},
): Promise<string> {
  const ref = keyBackupRef(harnessId, file);
  const dest = resolveForWrite(ref);
  const existing = await readKeyFile(dest);
  if (!opts.force && Object.prototype.hasOwnProperty.call(existing, keyPath)) return ref;
  const next: Record<string, unknown> = { ...existing };
  Object.defineProperty(next, keyPath, { value, enumerable: true, writable: true, configurable: true });
  ensureBackupDir(path.dirname(dest));
  await atomicWriteFile(dest, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return ref;
}

async function readKeyFile(dest: string | null): Promise<Record<string, unknown>> {
  if (dest === null || !exists(dest)) return {};
  try {
    const parsed = JSON.parse((await readBounded(dest, MAX_BACKUP_BYTES)).toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function unlinkSafe(ref: string): Promise<void> {
  const abs = resolveBackupPath(ref);
  if (abs === null) return;
  try {
    await unlink(abs);
  } catch {
    // Not there.
  }
}

/**
 * Delete the saved original behind a provenance row that is being dropped, so
 * no orphan can shadow a later original. Never throws.
 */
export async function removeBackupEntry(harnessId: string, scope: "file" | "key" | "link", p: string, key: string): Promise<void> {
  try {
    if (scope === "file") {
      await unlinkSafe(fileBackupRef(harnessId, p));
      await unlinkSafe(modeRef(harnessId, p));
    } else if (scope === "link") {
      await unlinkSafe(linkBackupRef(harnessId, p));
    } else {
      const dest = resolveBackupPath(keyBackupRef(harnessId, p));
      if (dest === null) return;
      const existing = await readKeyFile(dest);
      if (!Object.prototype.hasOwnProperty.call(existing, key)) return;
      const next = { ...existing };
      delete next[key];
      if (Object.keys(next).length === 0) await unlink(dest);
      else await atomicWriteFile(dest, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    }
  } catch {
    // Best effort: an orphan is overwritten by the next forced backup.
  }
}

/** The bytes of a file or link backup, or null when it does not exist or its
 *  path is not a plain chain. */
export async function readBackup(ref: string): Promise<Buffer | null> {
  try {
    const abs = resolveBackupPath(ref);
    if (abs === null) return null;
    return await readBounded(abs, MAX_BACKUP_BYTES);
  } catch {
    return null;
  }
}

/** The saved original of one key, or `{ found: false }`. */
export async function readKeyBackup(harnessId: string, file: string, keyPath: string): Promise<{ found: true; value: unknown } | { found: false }> {
  let dest: string | null;
  try {
    dest = resolveBackupPath(keyBackupRef(harnessId, file));
  } catch {
    return { found: false };
  }
  const all = await readKeyFile(dest);
  if (!Object.prototype.hasOwnProperty.call(all, keyPath)) return { found: false };
  return { found: true, value: all[keyPath] };
}

/** The ref a link original is stored under (a row's `backupRef` for a link). */
export function linkRef(harnessId: string, rel: string): string {
  return linkBackupRef(harnessId, rel);
}

/** Remove every saved original of one account (account delete, or a clean
 *  Restore). Refuses a symlinked `mirror-backups/` or `<id>`, never follows a
 *  link inside the tree (fd-relative removal), runs off the main thread and
 *  never throws. */
export async function removeMirrorBackups(harnessId: string): Promise<void> {
  let dir: string;
  try {
    dir = harnessDir(harnessId);
    for (const p of [backupsRoot(), dir]) {
      const st = await lstat(p);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        console.warn("[harness-mirror] mirror backup directory is a symlink or not a directory — not removed");
        return;
      }
    }
  } catch {
    return;
  }
  try {
    // Bun's recursive `rm` is the fd-relative walker (Zig `deleteTree`): every
    // folder is opened relative to its parent's descriptor with `O_NOFOLLOW`
    // and every entry is unlinked relative to its folder's descriptor, so an
    // agent that swaps a folder for a link mid-delete cannot redirect it out of
    // the store. A path-based walk (ours before, `/bin/rm -rf`, `find -delete`)
    // can be redirected; a spike lost outside files with all three
    // (docs/architecture/harness-stacks.md). It runs off the main thread.
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover backup is inert (nothing reads it without a row).
  }
}

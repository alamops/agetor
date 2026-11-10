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
 * and the relative path, never taken from a row's text.
 */
import { closeSync, fstatSync, lstatSync, mkdirSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertSafeRelPath, atomicWriteFile, copyRegularFileDetailed } from "./harness-file-transfer.ts";
import { dataDir } from "./db.ts";
import { openReadNoFollow } from "./no-follow.ts";
import { isSafePathSegment } from "../shared/harness-mirror.ts";

/** Largest file a backup will hold (matches the mirror's own merged-file cap
 *  scaled up for a skill's bundled assets). */
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

function backupsRoot(): string {
  return path.join(dataDir, "mirror-backups");
}

function harnessDir(harnessId: string): string {
  if (!isSafePathSegment(harnessId)) throw new Error("invalid account id for a mirror backup");
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

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** The ref (relative to the mirror-backups directory) of a file original. */
export function fileBackupRef(harnessId: string, rel: string): string {
  assertSafeRelPath(rel);
  return `${harnessId}/files/${rel}`;
}

function linkBackupRef(harnessId: string, rel: string): string {
  assertSafeRelPath(rel);
  return `${harnessId}/links/${rel}`;
}

function keyBackupRef(harnessId: string, file: string): string {
  assertSafeRelPath(file);
  return `${harnessId}/keys/${encodeURIComponent(file)}.json`;
}

function absForRef(ref: string): string {
  const abs = path.resolve(backupsRoot(), ref);
  const rel = path.relative(backupsRoot(), abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("backup ref escapes the backups directory");
  return abs;
}

function readBounded(p: string, maxBytes: number): Buffer {
  const fd = openReadNoFollow(p, { maxBytes });
  try {
    const size = Math.min(fstatSync(fd).size, maxBytes);
    const buf = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function modeRef(harnessId: string, rel: string): string {
  assertSafeRelPath(rel);
  return `${harnessId}/modes/${rel}`;
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
  const dest = absForRef(ref);
  if (!opts.force && exists(dest)) return ref;
  const st = lstatSync(src);
  if (!st.isFile()) throw new Error(`not a regular file: ${src}`);
  ensureBackupDir(path.dirname(dest));
  await copyRegularFileDetailed(src, dest, { root: dataDir, maxBytes: MAX_BACKUP_BYTES });
  const modePath = absForRef(modeRef(harnessId, rel));
  ensureBackupDir(path.dirname(modePath));
  // Permission bits only: never a setuid/setgid/sticky bit.
  await atomicWriteFile(modePath, (st.mode & 0o777).toString(8), { mode: 0o600 });
  return ref;
}

/** The saved permission bits of a file original, or null. */
export function readBackupMode(harnessId: string, rel: string): number | null {
  try {
    const text = readBounded(absForRef(modeRef(harnessId, rel)), 16).toString("utf8").trim();
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
  const dest = absForRef(ref);
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
  const dest = absForRef(ref);
  const existing = readKeyFile(dest);
  if (!opts.force && Object.prototype.hasOwnProperty.call(existing, keyPath)) return ref;
  const next: Record<string, unknown> = { ...existing };
  Object.defineProperty(next, keyPath, { value, enumerable: true, writable: true, configurable: true });
  ensureBackupDir(path.dirname(dest));
  await atomicWriteFile(dest, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return ref;
}

function readKeyFile(dest: string): Record<string, unknown> {
  if (!exists(dest)) return {};
  try {
    const parsed = JSON.parse(readBounded(dest, MAX_BACKUP_BYTES).toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Delete the saved original behind a provenance row that is being dropped, so
 * no orphan can shadow a later original. Never throws.
 */
export function removeBackupEntry(harnessId: string, scope: "file" | "key" | "link", p: string, key: string): void {
  try {
    if (scope === "file") {
      for (const ref of [fileBackupRef(harnessId, p), modeRef(harnessId, p)]) {
        try {
          unlinkSync(absForRef(ref));
        } catch {
          // Not there.
        }
      }
    } else if (scope === "link") {
      try {
        unlinkSync(absForRef(linkBackupRef(harnessId, p)));
      } catch {
        // Not there.
      }
    } else {
      const dest = absForRef(keyBackupRef(harnessId, p));
      const existing = readKeyFile(dest);
      if (!Object.prototype.hasOwnProperty.call(existing, key)) return;
      const next = { ...existing };
      delete next[key];
      if (Object.keys(next).length === 0) unlinkSync(dest);
      else rewriteSync(dest, next);
    }
  } catch {
    // Best effort: an orphan is overwritten by the next forced backup.
  }
}

function rewriteSync(dest: string, value: Record<string, unknown>): void {
  const tmp = `${dest}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, dest);
}

/** The bytes of a file or link backup, or null when it does not exist. */
export function readBackup(ref: string): Buffer | null {
  let abs: string;
  try {
    abs = absForRef(ref);
  } catch {
    return null;
  }
  try {
    return readBounded(abs, MAX_BACKUP_BYTES);
  } catch {
    return null;
  }
}

/** The saved original of one key, or `{ found: false }`. */
export function readKeyBackup(harnessId: string, file: string, keyPath: string): { found: true; value: unknown } | { found: false } {
  let dest: string;
  try {
    dest = absForRef(keyBackupRef(harnessId, file));
  } catch {
    return { found: false };
  }
  const all = readKeyFile(dest);
  if (!Object.prototype.hasOwnProperty.call(all, keyPath)) return { found: false };
  return { found: true, value: all[keyPath] };
}

/** The ref a link original is stored under (a row's `backupRef` for a link). */
export function linkRef(harnessId: string, rel: string): string {
  return linkBackupRef(harnessId, rel);
}

/** Remove every saved original of one account (account delete, or a clean
 *  Restore). Refuses a symlinked directory; never throws. */
export function removeMirrorBackups(harnessId: string): void {
  let dir: string;
  try {
    dir = harnessDir(harnessId);
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return;
  } catch {
    return;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover backup is inert (nothing reads it without a row).
  }
}

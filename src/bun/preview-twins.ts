// Path-keyed preview twins (docs/plans/picked-image-preview-tcc.md, grill D1).
//
// Why they exist. `GET /files/preview` reads through a disclaimed `/bin/sh` +
// `cat` child (core-file-read.ts), which macOS TCC denies inside a protected
// folder (~/Desktop, ~/Documents, …) without a prompt, so an image the user
// attached from there had no thumbnail (docs/architecture/security.md, D26(j)).
// The core must not read such a path in its own process on an agent's say-so,
// but it MAY copy a file the *user* just named: the Files Picker panel, a
// Finder drop and a paste run in Agetor's own process, which holds the user's
// intent grant (`com.apple.macl`) for exactly that file. At that moment the
// core copies the image into `<dataDir>/previews/<sha256(path)>.<ext>`, a
// folder it owns, and `/files/preview` falls back to that copy ONLY when the
// original read is denied.
//
// Rules this module enforces (each is pinned by preview-twins.test.ts):
//   - The twin key is the exact `TaskReference.path` string, hashed as UTF-8 —
//     nothing is normalized (U+202F in a macOS screenshot name stays distinct
//     from a space), so the chip's `/files/preview?path=…` finds it. The prompt
//     keeps the original path; there is no stored mapping.
//   - The original is opened `O_NOFOLLOW | O_NONBLOCK` and must be a regular
//     file of at most `PREVIEW_TWIN_MAX_BYTES` (a symlink, a FIFO, a device or
//     a huge file yields no twin). Async I/O only: the Bun main thread is shared.
//   - Nothing is written through a redirected `previews/`: `isPlainDirBelow`
//     runs before every write and every sweep. The bytes go to a `wx` temp file
//     and are `rename`d over the final name, which replaces a planted symlink
//     at the destination instead of writing through it.
//   - The cache stays at or under `PREVIEW_TWIN_CACHE_MAX_BYTES`, evicting the
//     oldest write time first; sweeps coalesce (one runs, at most one queues).
//   - Everything here is best effort and never throws: a twin that can't be
//     written degrades to the honest, still-openable chip.
//
// CALLERS. `writePreviewTwin*` may be called only from the three user-gesture
// handlers in server.ts (`/refs/pick`, `/refs/drag`, `/refs/resolve` with an app
// caller and `previewTwins: true`). Calling it for a path an agent chose would
// make the core read an agent-named protected file in-process. The call-site
// allowlist in preview-twins-callers.test.ts pins that.
//
// This module takes `dataDir` as an argument and imports nothing from db.ts, so
// its unit tests need no database.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readdir, lstat, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isImagePath } from "../shared/attachments.ts";
import type { TaskReference } from "../shared/types.ts";
import { isPlainDirBelow, READ_NOFOLLOW } from "./no-follow.ts";

/** The folder under the data dir that holds the twins. */
export const PREVIEW_TWIN_DIR = "previews";
/** Largest original that gets a twin (grill D4; the same cap as `/screenshots`). */
export const PREVIEW_TWIN_MAX_BYTES = 25 * 1024 * 1024;
/** Total size the twin cache is trimmed to (grill D6). */
export const PREVIEW_TWIN_CACHE_MAX_BYTES = 500 * 1024 * 1024;
/** An interrupted write leaves a `.tmp` file; the sweep removes it after this. */
const STALE_TMP_MS = 60 * 60 * 1000;

export type PreviewTwinSkipReason =
  | "not-image"
  | "missing"
  | "symlink"
  | "not-regular"
  | "too-large"
  | "unreadable"
  | "unsafe-dir"
  | "error";

export type PreviewTwinWrite =
  | { kind: "written"; twinPath: string; bytes: number }
  | { kind: "skipped"; reason: PreviewTwinSkipReason };

function twinDir(dataDir: string): string {
  return path.join(dataDir, PREVIEW_TWIN_DIR);
}

/**
 * Where the twin of `originalPath` lives, or `null` for a path that is not an
 * image (only images are ever twinned). Deterministic: the SHA-256 of the exact
 * path string plus its lowercased extension, so `/files/preview` can find it
 * from the same string the chip fetches.
 */
export function previewTwinPath(dataDir: string, originalPath: string): string | null {
  if (!isImagePath(originalPath)) return null;
  const ext = path.extname(originalPath).toLowerCase();
  const hex = createHash("sha256").update(originalPath, "utf8").digest("hex");
  return path.join(twinDir(dataDir), `${hex}${ext}`);
}

// One warning per skip reason per process: a folder of 500 unreadable images
// must not flood the log.
const warnedReasons = new Set<PreviewTwinSkipReason>();

function skipped(reason: PreviewTwinSkipReason, originalPath: string, detail?: unknown): PreviewTwinWrite {
  if (reason !== "not-image" && !warnedReasons.has(reason)) {
    warnedReasons.add(reason);
    const extra = detail instanceof Error ? ` (${detail.message})` : "";
    console.warn(`[agetor] preview twin skipped (${reason}): ${JSON.stringify(originalPath)}${extra}`);
  }
  return { kind: "skipped", reason };
}

/** Make sure `<dataDir>/previews` exists as a real directory below `dataDir`
 *  (not a symlink, not a file). False means: write nothing. */
async function ensureTwinDir(dataDir: string): Promise<boolean> {
  const dir = twinDir(dataDir);
  try {
    // Not `recursive`: `dataDir` exists, and a recursive mkdir would happily
    // walk through a symlinked component.
    await mkdir(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
  }
  return isPlainDirBelow(dataDir, dir);
}

/**
 * Copy `originalPath` (an image the user just picked, dropped or pasted) into
 * the twin cache. Never throws; the result says why nothing was written.
 */
export async function writePreviewTwin(dataDir: string, originalPath: string): Promise<PreviewTwinWrite> {
  const twin = previewTwinPath(dataDir, originalPath);
  if (twin === null) return skipped("not-image", originalPath);

  let bytes: Buffer;
  try {
    const fh = await open(originalPath, READ_NOFOLLOW);
    try {
      const st = await fh.stat();
      if (!st.isFile()) return skipped("not-regular", originalPath);
      if (st.size > PREVIEW_TWIN_MAX_BYTES) return skipped("too-large", originalPath);
      bytes = await fh.readFile();
    } finally {
      await fh.close().catch(() => {});
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return skipped("symlink", originalPath, e);
    if (code === "ENOENT" || code === "ENOTDIR") return skipped("missing", originalPath, e);
    if (code === "EACCES" || code === "EPERM") return skipped("unreadable", originalPath, e);
    return skipped("error", originalPath, e);
  }
  // The file can grow between the size check and the read.
  if (bytes.length > PREVIEW_TWIN_MAX_BYTES) return skipped("too-large", originalPath);

  if (!(await ensureTwinDir(dataDir))) return skipped("unsafe-dir", originalPath);

  const tmp = path.join(twinDir(dataDir), `.${path.basename(twin, path.extname(twin))}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, bytes, { flag: "wx", mode: 0o600 });
    // `rename` replaces whatever sits at the destination — including a planted
    // symlink, which it swaps out instead of writing through.
    await rename(tmp, twin);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    return skipped("error", originalPath, e);
  }
  requestPreviewTwinSweep(dataDir);
  return { kind: "written", twinPath: twin, bytes: bytes.length };
}

/**
 * Twin every file reference that is an image and passes `accept` (default: all
 * of them), one at a time so a multi-image pick doesn't hold many 25 MB buffers
 * at once. Directories are skipped. Never throws.
 */
export async function writePreviewTwinsForRefs(
  dataDir: string,
  refs: readonly TaskReference[],
  accept?: (ref: TaskReference) => boolean,
): Promise<void> {
  for (const ref of refs) {
    if (ref.isDirectory || !isImagePath(ref.path)) continue;
    if (accept && !accept(ref)) continue;
    await writePreviewTwin(dataDir, ref.path);
  }
}

/**
 * Trim the cache to `capBytes`, oldest write time first. Along the way: a
 * symlink or special file planted in `previews/` is unlinked (never followed),
 * and a `.tmp` file older than an hour is removed. A `previews/` that is itself
 * a symlink (or a file) is left alone entirely. Never throws.
 */
export async function sweepPreviewTwins(
  dataDir: string,
  capBytes: number = PREVIEW_TWIN_CACHE_MAX_BYTES,
): Promise<{ kept: number; evicted: number; removedOther: number }> {
  const result = { kept: 0, evicted: 0, removedOther: 0 };
  const dir = twinDir(dataDir);
  try {
    if (!isPlainDirBelow(dataDir, dir)) return result;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return result; // no cache yet
    }
    const twins: Array<{ file: string; size: number; mtimeMs: number; ino: number }> = [];
    const now = Date.now();
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const st = await lstat(file);
        if (st.isDirectory()) continue; // never recurse; nothing here makes one
        if (st.isSymbolicLink() || !st.isFile()) {
          await unlink(file); // unlink removes the link itself, never its target
          result.removedOther++;
          continue;
        }
        if (name.endsWith(".tmp")) {
          if (now - st.mtimeMs > STALE_TMP_MS) {
            await unlink(file);
            result.removedOther++;
          }
          continue;
        }
        twins.push({ file, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino });
      } catch {
        // Raced with another removal or unreadable: leave it for the next pass.
      }
    }
    let total = twins.reduce((sum, t) => sum + t.size, 0);
    twins.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let i = 0;
    for (; i < twins.length && total > capBytes; i++) {
      const victim = twins[i]!;
      try {
        // A re-pick may have renamed a fresh twin over this name since the
        // listing; evicting it would drop the newest twin, not the oldest.
        const cur = await lstat(victim.file);
        if (cur.ino !== victim.ino || cur.mtimeMs !== victim.mtimeMs) continue;
        await unlink(victim.file);
        total -= victim.size;
        result.evicted++;
      } catch {
        // Couldn't remove it; it still counts against the cap this pass.
      }
    }
    result.kept = twins.length - result.evicted;
  } catch (e) {
    console.warn(`[agetor] preview twin sweep failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Coalesced sweeps. A pick of N images asks for N sweeps in a row; one runs at
// a time and at most one more waits behind it.
// ---------------------------------------------------------------------------

let sweepRunning = false;
let sweepQueuedFor: string | null = null;
let sweepChain: Promise<void> = Promise.resolve();
let sweepPasses = 0;

function runSweepLoop(firstDataDir: string): void {
  sweepRunning = true;
  sweepChain = (async () => {
    let next: string | null = firstDataDir;
    try {
      while (next !== null) {
        sweepPasses++;
        await sweepPreviewTwins(next);
        next = sweepQueuedFor;
        sweepQueuedFor = null;
      }
    } finally {
      sweepRunning = false;
    }
  })();
}

/**
 * Ask for a cache trim and return at once (fire-and-forget). Requests that
 * arrive while a sweep runs collapse into a single follow-up pass.
 */
export function requestPreviewTwinSweep(dataDir: string): void {
  if (sweepRunning) {
    sweepQueuedFor = dataDir;
    return;
  }
  runSweepLoop(dataDir);
}

export const __forTest = {
  /** Resolves once no sweep is running or queued. */
  async idle(): Promise<void> {
    await sweepChain;
  },
  /** Passes started since the last `reset`. */
  passes(): number {
    return sweepPasses;
  },
  reset(): void {
    sweepRunning = false;
    sweepQueuedFor = null;
    sweepChain = Promise.resolve();
    sweepPasses = 0;
    warnedReasons.clear();
  },
};

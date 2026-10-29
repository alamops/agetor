// Reading agent-writable files in the core without following a planted symlink
// (docs/plans/master-token-agent-read.md, D26).
//
// The core tails and scans files an agent can rewrite: Claude Code session
// transcripts and their subagent files under a config dir's `projects/`, the
// `sessions/` registry, the codex/cursor/gemini/antigravity run logs and exit
// files under the data dir, and the usage poller's account files (codex
// rollouts; `.claude.json`, `.credentials.json` and codex `auth.json` through
// `readAccountFileText`, which follows a user's own symlinked dotfile only
// while the disclaim switch is off). Agents run as the same user, so one can replace
// such a file with a symlink into a macOS-protected folder (~/Documents, another
// app's ~/Library/Application Support). The core would then open it in its own
// process, under Agetor's TCC identity — exactly what disclaiming every spawn
// is meant to prevent. Every one of those files is written as a regular file
// by the CLI or by Agetor, so the final path component is opened with
// O_NOFOLLOW: a symlink there fails with ELOOP, which every caller already
// treats as "unreadable".
//
// Scope: the final component only. A symlinked parent directory is still
// followed (a user's own `~/.claude` → dotfiles link keeps working); the
// directory walks that list agent-writable dirs check their own chain with
// `isPlainDirBelow` (or skip symlinked entries with `lstat`) themselves.
//
// Special files. The open is non-blocking and the opened descriptor must be a
// regular file: a named pipe swapped in for a transcript or log would
// otherwise block `open(2)`/`read(2)` — and with them the core's main thread —
// until some writer showed up. (O_NONBLOCK has no effect on a regular file's
// reads.) Code that opens with `READ_NOFOLLOW` directly gets the non-blocking
// open; `openReadNoFollow` / `readTextNoFollow` also refuse a non-regular file.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { disclaimEnabled } from "./disclaim.ts";

/** `open(2)` flags for reading a file whose final component must not be a
 *  symlink, without blocking on a FIFO. */
export const READ_NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function errnoError(code: string, message: string, p: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: ${message}, open '${p}'`) as NodeJS.ErrnoException;
  err.code = code;
  err.syscall = "open";
  err.path = p;
  return err;
}

/** `open(2)` flags for reading a file through symlinks, without blocking on a
 *  FIFO. */
const READ_NONBLOCK = constants.O_RDONLY | constants.O_NONBLOCK;

/** `openSync(p, "r")`, refusing a symlink at `p` (ELOOP), a non-regular file
 *  (EINVAL) and — with `maxBytes` — a file larger than that (EFBIG). */
export function openReadNoFollow(p: string, opts: { maxBytes?: number } = {}): number {
  return openRegular(p, READ_NOFOLLOW, opts);
}

function openRegular(p: string, flags: number, opts: { maxBytes?: number }): number {
  const fd = openSync(p, flags);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw errnoError("EINVAL", "not a regular file", p);
    if (opts.maxBytes !== undefined && st.size > opts.maxBytes) throw errnoError("EFBIG", "file too large", p);
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return fd;
}

/** `readFileSync(p, "utf8")` through symlinks, but never blocking on a FIFO:
 *  refuses a non-regular file (EINVAL) and — with `maxBytes` — a file larger
 *  than that (EFBIG). For agent-writable files read while Agetor's identity is
 *  not at stake (the disclaim switch is off), where only the hang matters. */
export function readTextNonBlocking(p: string, opts: { maxBytes?: number } = {}): string {
  const fd = openRegular(p, READ_NONBLOCK, opts);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** `readFileSync(p, "utf8")`, with `openReadNoFollow`'s refusals. Throws like
 *  `readFileSync` on any other failure. */
export function readTextNoFollow(p: string, opts: { maxBytes?: number } = {}): string {
  const fd = openReadNoFollow(p, opts);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Read a user-owned config or credential file that an agent can also rewrite
 * — a harness home's `.claude.json` or `.credentials.json`, codex's
 * `auth.json` — as text. While Agetor disclaims its spawns the final component
 * is opened no-follow, so a file swapped for a symlink into a protected folder
 * is refused (ELOOP) instead of being read under Agetor's identity; with the
 * switch off a user's own symlinked dotfile keeps working, the same rule
 * `readClaudeAccount` applies. Either way the open never blocks on a FIFO and
 * the file must be a regular one of at most `maxBytes`.
 */
export function readAccountFileText(p: string, maxBytes: number): string {
  const fd = openRegular(p, disclaimEnabled() ? READ_NOFOLLOW : READ_NONBLOCK, { maxBytes });
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * True when `dir` is `base` itself or lies lexically below it and every path
 * component from `base` (exclusive) down to `dir` (inclusive) is a real
 * directory — not a symlink, not missing. `base` is trusted as-is (it may be a
 * user's own symlink). Use before listing or watching an agent-writable folder
 * in-process, so a folder linked into a protected location is never read under
 * Agetor's identity. A component swapped for a symlink between this check and
 * the read is an accepted timing-race residual.
 */
export function isPlainDirBelow(base: string, dir: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(dir));
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  let cur = path.resolve(base);
  for (const part of rel.split(path.sep)) {
    cur = path.join(cur, part);
    try {
      if (!lstatSync(cur).isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

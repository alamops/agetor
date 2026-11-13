// Test helper: where tests put fake CLI binaries (fake tmux, …) that are
// written as Bun scripts (`#!${process.execPath}`).
//
// Never under `os.tmpdir()`. Bun reads the ancestor directories of every
// script it starts, and on a developer Mac `$TMPDIR` collects every temp
// directory a test ever leaked: one machine had ~248,000 entries there
// (2026-11-12), and each Bun-script fake under it took ~1.2 s to start
// instead of ~0.08 s under `/tmp`. Tests that make a handful of fake-tmux
// calls then blew through bun's 5 s per-test timeout on `main`
// (claude-tmux-askdrive, -local-command, -queue, -slow-launch).
//
// The root stays small even when a test forgets its own cleanup: the first
// `fakeBinDir` call in each process removes entries older than
// `STALE_FAKE_BIN_MS`. (An exit hook can't do it: `bun test` fires neither
// `exit` nor `beforeExit` listeners.) The age bar keeps a concurrently running
// test process's fresh fakes out of reach.

import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

/** Shared root for fake-binary directories. `/tmp` (not `$TMPDIR`): see above. */
export const FAKE_BIN_ROOT = "/tmp/agetor-fake-bins";

/** Fake-bin directories older than this are swept on first use. */
export const STALE_FAKE_BIN_MS = 60 * 60 * 1000;

let swept = false;

function sweepStale(now: number): void {
  let names: string[];
  try {
    names = readdirSync(FAKE_BIN_ROOT);
  } catch {
    return;
  }
  for (const name of names) {
    const p = path.join(FAKE_BIN_ROOT, name);
    try {
      if (now - lstatSync(p).mtimeMs > STALE_FAKE_BIN_MS) rmSync(p, { recursive: true, force: true });
    } catch {
      /* raced with another process's sweep, or not ours to remove — skip */
    }
  }
}

/** A fresh, empty directory for a fake binary, named `<prefix><random>`
 *  (pass a prefix ending in `-`, as with `mkdtempSync`). */
export function fakeBinDir(prefix: string): string {
  mkdirSync(FAKE_BIN_ROOT, { recursive: true });
  if (!swept) {
    swept = true;
    sweepStale(Date.now());
  }
  return mkdtempSync(path.join(FAKE_BIN_ROOT, prefix));
}

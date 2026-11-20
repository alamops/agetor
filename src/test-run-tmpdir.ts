import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * One temp root per test run, removed when the run ends.
 *
 * Hundreds of unit tests and e2e specs `mkdtemp` a fixture directory and
 * leave it behind; over months that piled up to 100k+ `agetor-*` directories
 * (tens of GB) under `/tmp` and `$TMPDIR`. Rather than chase every test, the
 * bun preload (`src/test-preload.ts`) and the Playwright config point
 * `TMPDIR` at a run root made here, so every `os.tmpdir()`-based fixture lands
 * inside it, and delete the root when the run's process exits. A run killed
 * before its exit hook (Ctrl-C twice, a crash) leaves its root behind; the
 * next run sweeps any root whose owning pid is gone. A root whose pid is
 * alive (a concurrent run, or a reused pid) is never touched.
 *
 * Directory name: `<prefix><pid>-XXXXXX`, so the owner is readable from it.
 */

/** Whether `pid` names a live process. EPERM means it exists but isn't ours. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const SUFFIX_RE = /^(\d+)-[A-Za-z0-9]{6}$/;

/** The owning pid encoded in a run-root name, or null when `name` isn't one. */
export function runTmpdirPid(name: string, prefix: string): number | null {
  if (!name.startsWith(prefix)) return null;
  const m = SUFFIX_RE.exec(name.slice(prefix.length));
  return m ? Number(m[1]) : null;
}

/** Removes every `<prefix><pid>-XXXXXX` directory under `base` whose pid is
 *  dead. Returns the removed paths. Never throws: a sweep must not fail a run. */
export function sweepStaleRunTmpdirs(
  base: string,
  prefix: string,
  isAlive: (pid: number) => boolean = pidAlive,
): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return removed;
  }
  for (const name of names) {
    const pid = runTmpdirPid(name, prefix);
    if (pid === null || pid === process.pid || isAlive(pid)) continue;
    const dir = path.join(base, name);
    try {
      // Bun's / Node's recursive rmSync does not follow a symlink swapped in
      // mid-delete (unlike `rm -rf`).
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      /* best effort */
    }
  }
  return removed;
}

/** Creates this process's run root under `base` (after sweeping dead runs'
 *  roots) and returns its path. */
export function createRunTmpdir(base: string, prefix: string): string {
  sweepStaleRunTmpdirs(base, prefix);
  return mkdtempSync(path.join(base, `${prefix}${process.pid}-`));
}

/** Removes a run root. Never throws. */
export function removeRunTmpdir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort: the next run's sweep retries */
  }
}

// Test-only helper (imported only from *.test.ts; tree-shaken out of the bundle like github-test-util.ts).
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

/** Remove a per-test-file AGETOR_DATA_DIR — unless it holds the live sqlite. `bun test` runs every
 *  file in ONE process with a shared module cache, so `db.ts` opens `agetor.sqlite` exactly once, in
 *  whichever file's AGETOR_DATA_DIR was set at first import; a later file that rm -rf's that dir yanks
 *  the database out from under every remaining test file (opaque SQLITE_IOERR_VNODE). Returns true
 *  when the dir was removed, false when it was kept because `agetor.sqlite` lives there. */
export function rmTestDataDir(dir: string): boolean {
  if (existsSync(path.join(dir, "agetor.sqlite"))) return false;
  // db-path.ts freezes the data dir at first import, before db.ts opens the
  // sqlite. A file that only loaded db-path (via any module needing `dataDir`)
  // must not delete that dir: a later db.ts import would fail SQLITE_CANTOPEN.
  const pinned = (globalThis as { __agetorPinnedDataDir?: string }).__agetorPinnedDataDir;
  if (pinned && pinned === path.resolve(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

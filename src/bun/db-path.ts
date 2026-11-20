import { homedir, tmpdir } from "node:os";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { coreCredsPath } from "./core-creds.ts";

// Pure data-dir and database-path resolution, split out of `db.ts` so the main
// thread (and a worker) can compute the path without opening a connection.
// Importing this module has two side effects, carried over from `db.ts`: the
// NODE_ENV=test auto-allocation below and creating the data directory.

// Hard guard against test fixtures silently leaking into the user's real
// SQLite db. `bun test` runs every *.test.ts file in one process, so the
// first import of db.ts wins — any test file that sets AGETOR_DATA_DIR in
// `beforeAll` (instead of at top level) loses the race and writes to
// ~/.agetor/agetor.sqlite. We discovered this the painful way: 10 fixture
// tasks + dozens of phantom projects polluted the production kanban.
// Under NODE_ENV=test, if no AGETOR_DATA_DIR was set we auto-allocate a
// throwaway dir — guarantees we never touch ~/.agetor under tests even if
// some test file forgot the top-level setup. Logged so the gap is visible
// in CI output.
if (process.env.NODE_ENV === "test" && !process.env.AGETOR_DATA_DIR) {
  process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-test-auto-"));
  console.warn(
    `[agetor:db] NODE_ENV=test with no AGETOR_DATA_DIR — auto-allocated `
    + `${process.env.AGETOR_DATA_DIR}. Set it at the TOP of the test file `
    + `(not in beforeAll) to silence this warning.`,
  );
}
const DATA_DIR = process.env.AGETOR_DATA_DIR
  ?? path.join(homedir(), ".agetor");
mkdirSync(DATA_DIR, { recursive: true });

export const dataDir = DATA_DIR;

/** Pidfile path. Written at boot by `index.ts`, read by `wipe-dev.ts` for
 *  liveness checks. Single source of truth so a future rename doesn't
 *  leave silent stragglers. */
export const pidFilePath = path.join(DATA_DIR, "agetor.pid");

/** Core credentials file (port + per-launch API token + owner pid/kind),
 *  written after the API server binds and read by the CLI/daemon to discover
 *  and authenticate to the running core. See `core-creds.ts`. */
export const credsFilePath = coreCredsPath(DATA_DIR);

/** The SQLite file the core opens. */
export function resolveDbPath(): string {
  return path.join(DATA_DIR, "agetor.sqlite");
}

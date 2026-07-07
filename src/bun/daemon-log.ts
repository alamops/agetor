import { appendFileSync, statSync, truncateSync } from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./core-creds.ts";

/**
 * Tiny append-only logger for the headless CLI daemon, which has no console a
 * user can see. Writes timestamped lines to `$AGETOR_DATA_DIR/daemon.log`.
 *
 * Imports only `core-creds` (a leaf), never `db.ts`, so the CLI's `daemon
 * status` command can read {@link daemonLogPath} without opening the database.
 */
export const daemonLogPath = path.join(resolveDataDir(), "daemon.log");

const MAX_BYTES = 5 * 1024 * 1024;
let truncatedThisRun = false;

function rotateOnce(): void {
  if (truncatedThisRun) return;
  truncatedThisRun = true;
  try {
    if (statSync(daemonLogPath).size > MAX_BYTES) truncateSync(daemonLogPath, 0);
  } catch {
    /* no file yet — nothing to rotate */
  }
}

/** Append a timestamped line to the daemon log. Best-effort; never throws. */
export function daemonLog(message: string): void {
  rotateOnce();
  try {
    appendFileSync(daemonLogPath, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    /* best-effort */
  }
}

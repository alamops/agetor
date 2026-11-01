import { appendFileSync, copyFileSync, renameSync, rmSync, statSync, truncateSync } from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./core-creds.ts";

/**
 * Tiny append-only logger for the headless daemon and the login-item
 * supervisor, which have no console a user can see. Writes timestamped lines
 * to `$AGETOR_DATA_DIR/daemon.log`.
 *
 * Imports only `core-creds` (a leaf), never `db.ts`, so the CLI's `daemon
 * status` command can read {@link daemonLogPath} without opening the database.
 *
 * Size-based rotation: when the file passes {@link DAEMON_LOG_MAX_BYTES} it is
 * COPIED to `daemon.log.1` (older generations shift to `.2`, the oldest is
 * dropped) and then truncated in place. Copy-truncate rather than rename on
 * purpose: the supervisor and `spawnDaemon` point the core child's
 * stdout/stderr at this file by an `O_APPEND` descriptor, and a rename would
 * leave that descriptor writing into the renamed generation forever, growing
 * it without bound. An `O_APPEND` writer keeps appending at the new (zero)
 * end after a truncate, so the child's console output follows the rotation.
 * The price is that a line written between the copy and the truncate is lost,
 * which is acceptable for a diagnostics log.
 *
 * The size check is throttled (at most one `stat` per {@link CHECK_EVERY_MS}),
 * and everything is best-effort: logging never throws.
 */
export const daemonLogPath = path.join(resolveDataDir(), "daemon.log");

export const DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Rotated generations kept besides the live file (`daemon.log.1`, `.2`). */
export const DAEMON_LOG_KEEP = 2;
const CHECK_EVERY_MS = 30_000;

export interface DaemonLogOptions {
  path?: string;
  maxBytes?: number;
  keep?: number;
  checkEveryMs?: number;
  now?: () => number;
}

export interface DaemonLogger {
  (message: string): void;
  /** Rotate now if the file is over the limit (ignores the check throttle). */
  rotateIfNeeded(): boolean;
}

export function createDaemonLogger(opts: DaemonLogOptions = {}): DaemonLogger {
  const file = opts.path ?? daemonLogPath;
  const maxBytes = opts.maxBytes ?? DAEMON_LOG_MAX_BYTES;
  const keep = Math.max(1, opts.keep ?? DAEMON_LOG_KEEP);
  const checkEveryMs = opts.checkEveryMs ?? CHECK_EVERY_MS;
  const now = opts.now ?? Date.now;
  let lastCheck = Number.NEGATIVE_INFINITY;

  const rotateIfNeeded = (): boolean => {
    lastCheck = now();
    try {
      if (statSync(file).size <= maxBytes) return false;
    } catch {
      return false; // no file yet — nothing to rotate
    }
    try {
      rmSync(`${file}.${keep}`, { force: true });
      for (let i = keep - 1; i >= 1; i--) {
        try {
          renameSync(`${file}.${i}`, `${file}.${i + 1}`);
        } catch {
          /* that generation doesn't exist yet */
        }
      }
      copyFileSync(file, `${file}.1`);
      truncateSync(file, 0);
      return true;
    } catch {
      return false;
    }
  };

  const log = ((message: string): void => {
    if (now() - lastCheck >= checkEveryMs) rotateIfNeeded();
    try {
      appendFileSync(file, `[${new Date(now()).toISOString()}] ${message}\n`);
    } catch {
      /* best-effort */
    }
  }) as DaemonLogger;
  log.rotateIfNeeded = rotateIfNeeded;
  return log;
}

const shared = createDaemonLogger();

/** Append a timestamped line to the daemon log. Best-effort; never throws. */
export function daemonLog(message: string): void {
  shared(message);
}

/**
 * Rotate the shared log now if it is over the limit. A long-lived process whose
 * child writes to the file by descriptor (the supervisor) can call this on a
 * slow timer, since the child's own console output never goes through
 * {@link daemonLog}.
 */
export function rotateDaemonLogIfNeeded(): boolean {
  return shared.rotateIfNeeded();
}

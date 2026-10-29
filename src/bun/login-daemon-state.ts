import path from "node:path";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isPidAlive, resolveDataDir } from "./core-creds.ts";

/**
 * Files the login-item supervisor and the app/CLI use to talk to each other
 * without HTTP (the supervisor may be parked, with no core and no port open):
 *
 *  - `login-daemon.json`          — the supervisor's own state (who it is, what
 *                                   it is doing, which core child it runs)
 *  - `login-daemon-control.json`  — a one-shot "stop" request to the supervisor
 *  - `login-daemon-handback.json` — "the app is going away for an update, take
 *                                   the port back soon" marker
 *
 * LEAF MODULE: imports `core-creds.ts` (itself a leaf: no `db.ts`) and `node:*`
 * only. The supervisor runs with no database; if this file ever reached
 * `db.ts` the supervisor would create and migrate `agetor.sqlite` just by
 * importing its own state helpers. The data dir is resolved at call time via
 * `resolveDataDir()` (same rule as the creds file), never at module load.
 *
 * Every write is atomic (unique tmp sibling + rename, mode 0600) so a reader
 * never sees a torn file. Every read tolerates a missing or corrupt file and
 * validates the shape, because these files are agent-writable like the creds
 * file and a stale one from a crash must never throw.
 */

export interface LoginDaemonState {
  /** Supervisor pid (the launchd job's process). */
  pid: number;
  /** parked = no core child, by design; waiting = between children (backoff /
   *  grace); running = a core child is up; stopped = clean shutdown record. */
  state: "parked" | "waiting" | "running" | "stopped";
  /** Pid of the core child while `running`, else null. */
  corePid: number | null;
  /** The app bundle the supervisor was launched from. */
  bundlePath: string;
  /** App version of that bundle. */
  version: string;
  /** launchd label of this job. */
  label: string;
  /** Unix ms the supervisor started. */
  startedAt: number;
  /** Unix ms of the last state write. */
  updatedAt: number;
  /** Why the previous core child / supervisor ended, when it did. */
  lastExit?: "stop" | "sigterm" | "bundle-changed" | "crash";
}

const STATE_FILE = "login-daemon.json";
const CONTROL_FILE = "login-daemon-control.json";
const HANDBACK_FILE = "login-daemon-handback.json";

const STATES = new Set(["parked", "waiting", "running", "stopped"]);
const LAST_EXITS = new Set(["stop", "sigterm", "bundle-changed", "crash"]);

function filePath(name: string, dataDir?: string): string {
  return path.join(dataDir ?? resolveDataDir(), name);
}

/** Atomic 0600 JSON write: unique tmp sibling, rename over the target, tmp
 *  removed on failure. Creates the data dir if the supervisor runs before any
 *  core ever has. */
function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* may not exist */
    }
    throw e;
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best-effort — umask or an existing looser file */
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null; // missing or corrupt
  }
}

function removeFile(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}

function isPosInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseState(v: unknown): LoginDaemonState | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (!isPosInt(r.pid)) return null;
  if (typeof r.state !== "string" || !STATES.has(r.state)) return null;
  if (r.corePid !== null && !isPosInt(r.corePid)) return null;
  if (typeof r.bundlePath !== "string") return null;
  if (typeof r.version !== "string") return null;
  if (typeof r.label !== "string") return null;
  if (!isFiniteNum(r.startedAt) || !isFiniteNum(r.updatedAt)) return null;
  if (r.lastExit !== undefined && (typeof r.lastExit !== "string" || !LAST_EXITS.has(r.lastExit))) {
    return null;
  }
  const out: LoginDaemonState = {
    pid: r.pid,
    state: r.state as LoginDaemonState["state"],
    corePid: r.corePid as number | null,
    bundlePath: r.bundlePath,
    version: r.version,
    label: r.label,
    startedAt: r.startedAt,
    updatedAt: r.updatedAt,
  };
  if (r.lastExit !== undefined) out.lastExit = r.lastExit as LoginDaemonState["lastExit"];
  return out;
}

export function readLoginDaemonState(dataDir?: string): LoginDaemonState | null {
  return parseState(readJson(filePath(STATE_FILE, dataDir)));
}

export function writeLoginDaemonState(s: LoginDaemonState, dataDir?: string): void {
  writeJsonAtomic(filePath(STATE_FILE, dataDir), s);
}

/** The supervisor recorded in the state file, if its process is still alive and
 *  it hasn't recorded a clean stop. A leftover file from a crash or a reused
 *  pid-less stop reads as null. */
export function liveSupervisor(dataDir?: string): LoginDaemonState | null {
  const s = readLoginDaemonState(dataDir);
  if (!s || s.state === "stopped") return null;
  return isPidAlive(s.pid) ? s : null;
}

/** Ask the supervisor to stop (exit 0 → launchd keeps it down until next
 *  login). A file, not a signal, so it works while the supervisor is parked
 *  and from a process that doesn't know its pid. */
export function requestSupervisorStop(dataDir?: string): void {
  writeJsonAtomic(filePath(CONTROL_FILE, dataDir), { action: "stop", at: Date.now() });
}

/** Consume a stop request. True only for a well-formed `{action:"stop"}`; the
 *  file is removed whenever it exists, so a malformed one can't linger. */
export function takeSupervisorStop(dataDir?: string): boolean {
  const file = filePath(CONTROL_FILE, dataDir);
  const v = readJson(file);
  removeFile(file);
  return !!v && typeof v === "object" && (v as { action?: unknown }).action === "stop";
}

/** Marker the app writes when it quits for an update, so the supervisor takes
 *  the port back (and waits for the relaunch) instead of treating the app's
 *  disappearance as a crash. */
export function writeHandbackMarker(reason: "update", dataDir?: string): void {
  writeJsonAtomic(filePath(HANDBACK_FILE, dataDir), { reason, at: Date.now() });
}

/** Consume the handback marker. Removed whether or not it is fresh; null when
 *  missing, malformed, or older than `maxAgeMs`. */
export function takeHandbackMarker(
  maxAgeMs: number,
  dataDir?: string,
): { reason: "update"; at: number } | null {
  const file = filePath(HANDBACK_FILE, dataDir);
  const v = readJson(file);
  removeFile(file);
  if (!v || typeof v !== "object") return null;
  const r = v as { reason?: unknown; at?: unknown };
  if (r.reason !== "update" || !isFiniteNum(r.at)) return null;
  if (Date.now() - r.at > maxAgeMs) return null;
  return { reason: "update", at: r.at };
}

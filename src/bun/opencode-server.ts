import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { dataDir } from "./db.ts";
import { resolveTmuxBin, tmuxSocketArgs, spawnTmuxNewSession } from "./tmux-resolution.ts";
import { SCRUBBED_ENV_KEYS, childEnv, coreSpawn } from "./core-spawn.ts";
import { openReadNoFollow } from "./no-follow.ts";
import { killSessionByName, sessionExistsByName } from "./claude-tmux.ts";
import { escapeFreeText } from "../shared/terminal-text.ts";

/**
 * Agetor-owned `opencode serve` manager (docs/plans/opencode-server-driver.md
 * §2, D2, D6, D8, D13, invariants I2/I3/I4/I7).
 *
 * One OpenCode v2 server per harness, hosted in a detached tmux session on the
 * instance socket so it outlives this core (a crashed or restarted core adopts
 * it again at boot). Started on demand with a single start in flight per
 * harness, probed with an authenticated `GET /api/info`, stopped by the idle
 * sweep (30 minutes with no running turn and no open card — `isBusy` is the
 * only gate) or on a real quit when idle.
 *
 * Secrets. The password is 32 random bytes generated here and handed to the
 * server as `OPENCODE_PASSWORD`, so `serve` never prints one. It must not show
 * up in any process's argv. `tmux new-session -e K=V` puts the pair in tmux's
 * own argv (visible in `ps`) and the existing opencode-tmux launcher does
 * exactly that for its non-secret env, so this module does NOT: it writes the
 * server's whole env to a 0600 env file in the 0700 server dir, and the inner
 * `sh` redirects its output to the log, sources the file, deletes it and
 * `exec`s the server. The only things in argv are the env file's PATH, the log
 * path and the server command. The password is in the env file (briefly), the
 * 0600 state file, the server's environment and the Authorization header —
 * never a log, an argv, a URL or an error message.
 *
 * Test seam (D13): `AGETOR_OPENCODE_SERVER_HOST=direct` hosts the server as a
 * `coreSpawn` child of this core instead of a tmux session (stdout and stderr
 * to the same log file). It exists for unit and e2e tests that must not need
 * tmux; it is not a user setting and nothing in a release flow sets it.
 */

/** Idle window before the sweep may stop a server (D6). */
export const OPENCODE_SERVER_IDLE_MS = 30 * 60_000;

/** Budget for launch → listening line → authenticated info (plan §4 T3). */
const DEFAULT_START_BUDGET_MS = 15_000;
/** How long a successful health check is trusted before the next one. */
const DEFAULT_HEALTH_CACHE_MS = 5_000;
const HEALTH_TIMEOUT_MS = 2_000;
const POLL_MS = 100;
/** Every Nth poll also asks the host whether the server died. */
const LIVENESS_EVERY_POLLS = 10;
/** How long `stop` waits for the server to go away before escalating. */
const STOP_GRACE_MS = 2_000;
const LOG_READ_BYTES = 64 * 1024;
const STATE_MAX_BYTES = 16 * 1024;
const TAIL_LINES = 12;

let idleMs = OPENCODE_SERVER_IDLE_MS;
let startBudgetMs = DEFAULT_START_BUDGET_MS;
let healthCacheMs = DEFAULT_HEALTH_CACHE_MS;

export interface OpencodeServerHandle {
  harnessId: string;
  /** `http://127.0.0.1:<port>`, from the server's own listening line. */
  url: string;
  password: string;
  /** The tmux session hosting the server, or null for the `direct` test host. */
  tmuxSession: string | null;
  startedAt: number;
  version?: string;
}

export interface OpencodeServerSpec {
  harnessId: string;
  bin: string;
  /** `harnessEnv(harness)`: plain values, not a `process.env` copy. */
  env: Record<string, string>;
  /** The harness home, or `$HOME`. */
  cwd: string;
}

interface ServerRecord {
  handle: OpencodeServerHandle;
  /** `/api/info` pid; lets stop prove a survivor is still our server. */
  pid?: number;
  /** Set only for the `direct` test host started by this process. */
  proc?: ReturnType<typeof coreSpawn>;
  lastActivity: number;
  healthyAt: number;
}

interface StateFile {
  harnessId: string;
  url: string;
  password: string;
  tmuxSession: string | null;
  startedAt: number;
  version?: string;
  pid?: number;
}

const servers = new Map<string, ServerRecord>();
const starting = new Map<string, Promise<OpencodeServerHandle>>();
const stopping = new Map<string, Promise<void>>();

/* ────────────────────────────────────────────────────────────────────────── *
 * Paths and names
 * ────────────────────────────────────────────────────────────────────────── */

/** `[A-Za-z0-9_-]` only, so the id is safe in a filename and a tmux session
 *  name. An id that needed rewriting gets a hash suffix so two different ids
 *  never share a file. */
function safeId(harnessId: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(harnessId)) return harnessId;
  const hash = createHash("sha256").update(harnessId).digest("hex").slice(0, 8);
  const cleaned = harnessId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "h";
  return `${cleaned}-${hash}`;
}

function serverDir(): string {
  return path.join(dataDir, "opencode-servers");
}
const statePath = (id: string): string => path.join(serverDir(), `${safeId(id)}.json`);
const logPath = (id: string): string => path.join(serverDir(), `${safeId(id)}.log`);
const envPath = (id: string): string => path.join(serverDir(), `${safeId(id)}.env`);
const sessionNameFor = (id: string): string => `agetor-ocsrv-${safeId(id)}`;

/** Create (or re-check) the 0700 server dir. A symlink, a non-directory or a
 *  directory owned by someone else is refused: it would hold the password. */
function ensureServerDir(): string {
  const dir = serverDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("opencode server directory is not a plain directory");
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error("opencode server directory is not owned by the current user");
  }
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  return dir;
}

function removeFile(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    /* absent */
  }
}

function removeFiles(id: string, opts: { log: boolean }): void {
  removeFile(statePath(id));
  removeFile(envPath(id));
  if (opts.log) removeFile(logPath(id));
}

/** Write `data` to `target` as a new 0600 file, atomically (tmp + rename). */
function writePrivateFile(target: string, data: string): void {
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, target);
  } catch (e) {
    removeFile(tmp);
    throw e;
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * State file (read back no-follow; anything off is treated as absent)
 * ────────────────────────────────────────────────────────────────────────── */

function isLoopbackUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:") return false;
    if (u.username || u.password) return false;
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  } catch {
    return false;
  }
}

/** The state at `file`, or null when it is absent, a symlink, not a regular
 *  file, not ours, broader than 0600, oversized or malformed. A rejected file
 *  is deleted by the caller. */
function readStateFile(file: string): StateFile | null {
  let fd: number;
  try {
    fd = openReadNoFollow(file, { maxBytes: STATE_MAX_BYTES });
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return null;
    if ((st.mode & 0o077) !== 0) return null;
    const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o.harnessId !== "string" || o.harnessId === "") return null;
    if (typeof o.password !== "string" || o.password === "") return null;
    if (typeof o.url !== "string") return null;
    if (o.url !== "" && !isLoopbackUrl(o.url)) return null;
    if (o.tmuxSession !== null && typeof o.tmuxSession !== "string") return null;
    if (typeof o.tmuxSession === "string" && o.tmuxSession !== sessionNameFor(o.harnessId)) return null;
    if (typeof o.startedAt !== "number" || !Number.isFinite(o.startedAt)) return null;
    return {
      harnessId: o.harnessId,
      url: o.url,
      password: o.password,
      tmuxSession: o.tmuxSession,
      startedAt: o.startedAt,
      version: typeof o.version === "string" ? o.version : undefined,
      pid: typeof o.pid === "number" && Number.isInteger(o.pid) && o.pid > 0 ? o.pid : undefined,
    };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function writeState(rec: ServerRecord): void {
  const h = rec.handle;
  const state: StateFile = {
    harnessId: h.harnessId,
    url: h.url,
    password: h.password,
    tmuxSession: h.tmuxSession,
    startedAt: h.startedAt,
    version: h.version,
    pid: rec.pid,
  };
  writePrivateFile(statePath(h.harnessId), JSON.stringify(state));
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Health
 * ────────────────────────────────────────────────────────────────────────── */

interface ProbeResult {
  ok: boolean;
  /** HTTP status when the server answered. */
  status?: number;
  timedOut?: boolean;
  version?: string;
  pid?: number;
}

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

async function probe(url: string, password: string, timeoutMs: number): Promise<ProbeResult> {
  // The password only ever goes to a loopback origin.
  if (!isLoopbackUrl(url)) return { ok: false };
  try {
    const res = await fetch(`${url}/api/info`, {
      headers: { Authorization: basicAuth(password), Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, status: res.status };
    }
    let version: string | undefined;
    let pid: number | undefined;
    try {
      const body = (await res.json()) as { version?: unknown; pid?: unknown };
      if (typeof body.version === "string") version = body.version;
      if (typeof body.pid === "number" && Number.isInteger(body.pid) && body.pid > 0) pid = body.pid;
    } catch {
      /* a 200 with an odd body still proves the authenticated server */
    }
    return { ok: true, status: 200, version, pid };
  } catch (e) {
    const name = (e as { name?: string }).name;
    return { ok: false, timedOut: name === "TimeoutError" || name === "AbortError" };
  }
}

/** Authenticated `GET /api/info` against `h`. */
export async function checkOpencodeServerHealth(h: OpencodeServerHandle, timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
  return (await probe(h.url, h.password, timeoutMs)).ok;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Hosting (tmux, or the `direct` test seam)
 * ────────────────────────────────────────────────────────────────────────── */

function hostIsDirect(): boolean {
  return process.env.AGETOR_OPENCODE_SERVER_HOST === "direct";
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The server's whole environment, as plain values. A spec value wins over the
 *  `OPENCODE_DISABLE_AUTOUPDATE` default (like discovery); the password is
 *  always agetor's. */
function serverEnv(spec: OpencodeServerSpec, password: string): Record<string, string> {
  const env: Record<string, string> = { OPENCODE_DISABLE_AUTOUPDATE: "1" };
  for (const [k, v] of Object.entries(spec.env)) {
    if (typeof v === "string" && ENV_KEY_RE.test(k) && !SCRUBBED_ENV_KEYS.includes(k)) env[k] = v;
  }
  if (env.PATH === undefined && process.env.PATH) env.PATH = process.env.PATH;
  env.OPENCODE_PASSWORD = password;
  return env;
}

/** The inner `sh -c` script: output to the log first (so a bad env file is
 *  visible), then source the env file, delete it, exec the server. `$1` env
 *  file, `$2` log, the rest is the server command. */
const TMUX_INNER_SCRIPT = 'exec >"$2" 2>&1; . "$1" || exit 1; rm -f -- "$1"; shift 2; exec "$@"';

async function launchInTmux(spec: OpencodeServerSpec, password: string): Promise<string> {
  const name = sessionNameFor(spec.harnessId);
  const env = serverEnv(spec, password);
  const lines = Object.keys(env)
    .sort()
    .map((k) => `export ${k}=${shellQuote(env[k]!)}`);
  writePrivateFile(envPath(spec.harnessId), `${lines.join("\n")}\n`);
  const res = await spawnTmuxNewSession(resolveTmuxBin(), [
    ...tmuxSocketArgs(),
    "new-session", "-d", "-s", name,
    "-x", "200", "-y", "50",
    "-c", spec.cwd,
    "--", "sh", "-c", TMUX_INNER_SCRIPT, "sh",
    envPath(spec.harnessId), logPath(spec.harnessId),
    spec.bin, "serve", "--hostname", "127.0.0.1", "--port", "0",
  ]);
  if (res.status !== 0) {
    removeFile(envPath(spec.harnessId));
    throw new Error(`could not start the OpenCode server session: ${redact(res.stderr || "tmux new-session failed", password)}`);
  }
  return name;
}

function launchDirect(spec: OpencodeServerSpec, password: string): ReturnType<typeof coreSpawn> {
  const fd = openSync(logPath(spec.harnessId), "w", 0o600);
  try {
    const proc = coreSpawn([spec.bin, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: spec.cwd,
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
      env: childEnv(serverEnv(spec, password)),
    });
    proc.unref();
    return proc;
  } finally {
    closeSync(fd);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether the host still runs the server (a tmux session, the direct child,
 *  or — for an adopted direct server — its pid). */
async function hostAlive(rec: { tmuxSession: string | null; proc?: ServerRecord["proc"]; pid?: number }): Promise<boolean> {
  if (rec.tmuxSession) return sessionExistsByName(rec.tmuxSession);
  if (rec.proc) return rec.proc.exitCode === null && !rec.proc.killed;
  if (rec.pid) return pidAlive(rec.pid);
  return false;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Log reading and redaction
 * ────────────────────────────────────────────────────────────────────────── */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function redact(text: string, password?: string): string {
  let out = text;
  if (password) out = out.split(password).join("[redacted]");
  return out
    .replace(/(password[=:\s]+)\S+/gi, "$1[redacted]")
    .replace(/(authorization:?\s*(?:basic|bearer)\s+)\S+/gi, "$1[redacted]")
    .replace(/OPENCODE_PASSWORD=\S+/g, "OPENCODE_PASSWORD=[redacted]");
}

/** The head of the log, bounded. The listening line is the server's first
 *  output; a log grown past the cap is never read whole. */
function readLogHead(id: string): string {
  let fd: number;
  try {
    fd = openReadNoFollow(logPath(id));
  } catch {
    return "";
  }
  try {
    const buf = Buffer.alloc(LOG_READ_BYTES);
    const n = readSync(fd, buf, 0, LOG_READ_BYTES, 0);
    return buf.subarray(0, n).toString("utf8").replace(ANSI_RE, "");
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

function logTail(id: string, password: string): string {
  const lines = readLogHead(id)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return lines
    .slice(-TAIL_LINES)
    .map((l) => escapeFreeText(redact(l, password)))
    .join("\n");
}

function parseListeningUrl(log: string): string | null {
  const m = /server listening on (https?:\/\/\S+)/.exec(log);
  if (!m) return null;
  try {
    const u = new URL(m[1]!);
    return isLoopbackUrl(u.origin) ? u.origin : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ────────────────────────────────────────────────────────────────────────── *
 * Start
 * ────────────────────────────────────────────────────────────────────────── */

async function startServer(spec: OpencodeServerSpec): Promise<ServerRecord> {
  const id = spec.harnessId;
  ensureServerDir();
  // A leftover session or file from a crashed start must not collide.
  await killSessionByName(sessionNameFor(id));
  removeFiles(id, { log: true });

  const password = randomBytes(32).toString("base64url");
  const direct = hostIsDirect();
  const tmuxSession = direct ? null : sessionNameFor(id);
  const startedAt = Date.now();
  const rec: ServerRecord = {
    handle: { harnessId: id, url: "", password, tmuxSession, startedAt },
    lastActivity: startedAt,
    healthyAt: 0,
  };
  // The state file exists BEFORE the server does, so a core that dies between
  // launch and the final write leaves something the next boot can clean up
  // (an empty url means "never became healthy").
  writeState(rec);
  // Pre-create the log 0600 (the shell's `>` keeps the mode).
  closeSync(openSync(logPath(id), "w", 0o600));

  const fail = async (reason: string): Promise<never> => {
    const tail = logTail(id, password);
    await terminate(rec);
    removeFile(statePath(id));
    removeFile(envPath(id));
    throw new Error(`OpenCode server failed to start: ${redact(reason, password)}${tail ? `\n${tail}` : ""}`);
  };

  try {
    if (direct) rec.proc = launchDirect(spec, password);
    else await launchInTmux(spec, password);
  } catch (e) {
    return fail((e as Error).message);
  }

  const deadline = Date.now() + startBudgetMs;
  let url: string | null = null;
  for (let poll = 0; Date.now() < deadline; poll++) {
    url = parseListeningUrl(readLogHead(id));
    if (url) break;
    if (poll > 0 && poll % LIVENESS_EVERY_POLLS === 0 && !(await hostAlive({ tmuxSession, proc: rec.proc }))) {
      return fail("the server exited before it started listening");
    }
    await sleep(POLL_MS);
  }
  if (!url) return fail("the server did not report a listening address in time");

  rec.handle.url = url;
  let last: ProbeResult = { ok: false };
  while (Date.now() < deadline) {
    last = await probe(url, password, HEALTH_TIMEOUT_MS);
    if (last.ok) break;
    if (rec.proc && rec.proc.exitCode !== null) return fail("the server exited before it answered");
    await sleep(POLL_MS);
  }
  if (!last.ok) return fail(`the server did not answer an authenticated info request${last.status ? ` (HTTP ${last.status})` : ""}`);

  rec.handle.version = last.version;
  rec.pid = last.pid;
  rec.healthyAt = Date.now();
  writeState(rec);
  return rec;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Stop
 * ────────────────────────────────────────────────────────────────────────── */

/** Kill the host and wait (bounded) for the server to go; a survivor that is
 *  still answering as our server is signalled by pid. Never throws. */
async function terminate(rec: ServerRecord | StateFile): Promise<void> {
  const isRec = "handle" in rec;
  const tmuxSession = isRec ? rec.handle.tmuxSession : rec.tmuxSession;
  const proc = isRec ? rec.proc : undefined;
  const pid = rec.pid;
  const url = isRec ? rec.handle.url : rec.url;
  const password = isRec ? rec.handle.password : rec.password;
  try {
    if (tmuxSession) await killSessionByName(tmuxSession);
    if (proc) proc.kill("SIGTERM");
    else if (!tmuxSession && pid && pidAlive(pid)) process.kill(pid, "SIGTERM");

    const gone = async (): Promise<boolean> => {
      if (proc) return proc.exitCode !== null || proc.killed;
      if (pid) return !pidAlive(pid);
      if (url) return !(await probe(url, password, 500)).ok;
      return true;
    };
    const until = Date.now() + STOP_GRACE_MS;
    while (Date.now() < until && !(await gone())) await sleep(POLL_MS);
    if (await gone()) return;
    // Still there. Signal by pid only while it still answers as our server.
    if (pid && url && (await probe(url, password, 500)).ok) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* gone */
      }
      const until2 = Date.now() + STOP_GRACE_MS;
      while (Date.now() < until2 && !(await gone())) await sleep(POLL_MS);
      if (!(await gone()) && (await probe(url, password, 500)).ok) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    } else if (proc && proc.exitCode === null) {
      proc.kill("SIGKILL");
    }
  } catch {
    /* best-effort: stop never throws */
  }
}

/** Stop the harness's server: kill the session, remove state and log, drop it
 *  from the map. Idempotent; concurrent calls share one stop. */
export function stopOpencodeServer(harnessId: string): Promise<void> {
  const existing = stopping.get(harnessId);
  if (existing) return existing;
  const inflight = starting.get(harnessId);
  const p = (async () => {
    // A start still in flight finishes (or fails) first, so its server is
    // registered before it is stopped.
    await inflight?.catch(() => {});
    const rec = servers.get(harnessId);
    servers.delete(harnessId);
    if (rec) {
      await terminate(rec);
    } else {
      // Nothing in memory: a state file may still describe a server (not yet
      // adopted, or left by a crashed start). Kill by its recorded host.
      const state = readStateFile(statePath(harnessId));
      if (state) await terminate(state);
      else await killSessionByName(sessionNameFor(harnessId));
    }
    removeFiles(harnessId, { log: true });
  })().finally(() => {
    stopping.delete(harnessId);
  });
  stopping.set(harnessId, p);
  return p;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Ensure / adopt
 * ────────────────────────────────────────────────────────────────────────── */

async function healthy(rec: ServerRecord): Promise<"ok" | "dead" | "unresponsive"> {
  if (Date.now() - rec.healthyAt < healthCacheMs) return "ok";
  let res = await probe(rec.handle.url, rec.handle.password, HEALTH_TIMEOUT_MS);
  if (res.timedOut) res = await probe(rec.handle.url, rec.handle.password, HEALTH_TIMEOUT_MS * 2);
  if (res.ok) {
    rec.healthyAt = Date.now();
    if (res.version) rec.handle.version = res.version;
    return "ok";
  }
  // A server that is alive but slow may be mid-turn: never replace it (I3).
  if (res.timedOut && (await hostAlive({ tmuxSession: rec.handle.tmuxSession, proc: rec.proc, pid: rec.pid }))) {
    return "unresponsive";
  }
  return "dead";
}

function recordFromState(state: StateFile, probeResult: ProbeResult): ServerRecord {
  return {
    handle: {
      harnessId: state.harnessId,
      url: state.url,
      password: state.password,
      tmuxSession: state.tmuxSession,
      startedAt: state.startedAt,
      version: probeResult.version ?? state.version,
    },
    pid: probeResult.pid ?? state.pid,
    lastActivity: Date.now(),
    healthyAt: Date.now(),
  };
}

/** Adopt the server a state file describes if its host and an authenticated
 *  info request both check out; otherwise clean it up. */
async function adoptState(file: string, only?: string): Promise<ServerRecord | null> {
  const state = readStateFile(file);
  // Boot adoption must not touch a server this process is starting or holds.
  if (state && only === undefined && (starting.has(state.harnessId) || servers.has(state.harnessId))) return null;
  if (!state || statePath(state.harnessId) !== file || (only !== undefined && state.harnessId !== only)) {
    // Unreadable, a symlink, wrong owner/mode, or filed under the wrong name.
    const stem = path.basename(file, ".json");
    removeFile(file);
    removeFile(path.join(serverDir(), `${stem}.env`));
    return null;
  }
  const dead = async (): Promise<null> => {
    await terminate(state);
    removeFiles(state.harnessId, { log: true });
    return null;
  };
  if (state.url === "") return dead();
  if (!(await hostAlive({ tmuxSession: state.tmuxSession, pid: state.pid }))) return dead();
  const res = await probe(state.url, state.password, HEALTH_TIMEOUT_MS);
  if (!res.ok) return dead();
  return recordFromState(state, res);
}

async function ensureInner(spec: OpencodeServerSpec): Promise<OpencodeServerHandle> {
  const id = spec.harnessId;
  await stopping.get(id);
  let rec = servers.get(id);
  if (rec) {
    const state = await healthy(rec);
    if (state === "ok") {
      rec.lastActivity = Date.now();
      return rec.handle;
    }
    if (state === "unresponsive") throw new Error("The OpenCode server is not responding.");
    servers.delete(id);
    await terminate(rec);
    removeFiles(id, { log: true });
  } else {
    // Not in memory (boot adoption not run, or it ran before this harness
    // existed): a healthy server from an earlier core is reused.
    ensureServerDir();
    const adopted = await adoptState(statePath(id), id);
    if (adopted) {
      servers.set(id, adopted);
      return adopted.handle;
    }
  }
  rec = await startServer(spec);
  servers.set(id, rec);
  return rec.handle;
}

/** The harness's server, started if needed. One start per harness at a time:
 *  concurrent callers share the in-flight promise (I2). */
export function ensureOpencodeServer(spec: OpencodeServerSpec): Promise<OpencodeServerHandle> {
  const inflight = starting.get(spec.harnessId);
  if (inflight) return inflight;
  const p = ensureInner(spec).finally(() => {
    starting.delete(spec.harnessId);
  });
  starting.set(spec.harnessId, p);
  return p;
}

/** Boot: keep the servers a previous core left running and healthy, clean up
 *  every other state file and its session. */
export async function adoptOpencodeServers(): Promise<OpencodeServerHandle[]> {
  let names: string[];
  try {
    ensureServerDir();
    names = readdirSync(serverDir()).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const adopted: OpencodeServerHandle[] = [];
  for (const name of names) {
    const file = path.join(serverDir(), name);
    try {
      const rec = await adoptState(file);
      if (!rec) continue;
      if (servers.has(rec.handle.harnessId)) continue;
      servers.set(rec.handle.harnessId, rec);
      adopted.push(rec.handle);
    } catch {
      /* one bad entry must not stop the rest */
    }
  }
  return adopted;
}

export function getOpencodeServer(harnessId: string): OpencodeServerHandle | null {
  return servers.get(harnessId)?.handle ?? null;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Idle
 * ────────────────────────────────────────────────────────────────────────── */

export function noteOpencodeActivity(harnessId: string, now: number = Date.now()): void {
  const rec = servers.get(harnessId);
  if (rec) rec.lastActivity = now;
}

function busy(isBusy: (harnessId: string) => boolean, id: string): boolean {
  try {
    return isBusy(id);
  } catch {
    return true; // an unanswerable gate never lets a stop through (I3)
  }
}

/** Stop every server idle for at least the idle window whose `isBusy` is false.
 *  Returns the stopped ids. */
export async function opencodeIdleSweep(now: number, isBusy: (harnessId: string) => boolean): Promise<string[]> {
  const stopped: string[] = [];
  for (const [id, rec] of [...servers]) {
    if (now - rec.lastActivity < idleMs) continue;
    if (starting.has(id) || busy(isBusy, id)) continue;
    await stopOpencodeServer(id);
    stopped.push(id);
  }
  return stopped;
}

/** A real quit: stop every server that is not busy. */
export async function stopIdleOpencodeServersOnQuit(isBusy: (harnessId: string) => boolean): Promise<void> {
  const ids = [...servers.keys()].filter((id) => !starting.has(id) && !busy(isBusy, id));
  await Promise.allSettled(ids.map((id) => stopOpencodeServer(id)));
}

/** Test-only helpers; production code never calls these. */
export const __forTest = {
  /** Forget every in-memory server (their hosts are left alone). */
  forget(): void {
    servers.clear();
    starting.clear();
    stopping.clear();
  },
  setIdleMs(ms: number): void {
    idleMs = ms;
  },
  setStartBudgetMs(ms: number): void {
    startBudgetMs = ms;
  },
  setHealthCacheMs(ms: number): void {
    healthCacheMs = ms;
  },
  restoreDefaults(): void {
    idleMs = OPENCODE_SERVER_IDLE_MS;
    startBudgetMs = DEFAULT_START_BUDGET_MS;
    healthCacheMs = DEFAULT_HEALTH_CACHE_MS;
  },
  statePath,
  logPath,
  envPath,
  sessionNameFor,
  serverDir,
  safeId,
  redact,
};

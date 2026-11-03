import {
  chmodSync,
  closeSync,
  constants,
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
import { SCRUBBED_ENV_KEYS, childEnv, coreSpawn, coreSpawnSync } from "./core-spawn.ts";
import { openReadNoFollow } from "./no-follow.ts";
import { isLoopbackOpencodeUrl, opencodeAuthHeader } from "./opencode-http.ts";
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
 * `exec`s the server. The only things in argv are the env file's path, the log
 * path and the server command. The password is in the env file (briefly), the
 * 0600 state file, the server's environment and the Authorization header —
 * never a log, an argv, a URL or an error message.
 *
 * Signals. A state file is data an agent could have planted, so no pid read
 * from it (or reported by the server about itself) is ever signalled. A pid is
 * signalled only when it is (a) a live child this core spawned for the `direct`
 * test host, or (b) the pid of the harness's own tmux pane (the `exec` above
 * makes that the server itself) or a descendant of it, and never this process
 * or one of its ancestors. Stopping a tmux-hosted server is `kill-session` on
 * the exact session name first; signals are only the escalation.
 *
 * Removal needs positive proof. Adoption and `ensure` delete a server's state
 * only when it is provably gone: tmux answered "no such session", the direct
 * child is dead, the connection was refused, or the server rejected our
 * password. A probe that merely times out, or a tmux call that failed, leaves a
 * live (maybe busy) server and its state alone (I3).
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
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
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
let healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS;
let serverDirOverride: string | null = null;
/** Overall budget for boot adoption: a server still undecided at the end is
 *  kept (as unhealthy), never killed. */
const DEFAULT_ADOPT_BUDGET_MS = 5_000;
let adoptBudgetMs = DEFAULT_ADOPT_BUDGET_MS;
/** Bounded wait for each synchronous tmux call on a quit. */
const SYNC_TMUX_TIMEOUT_MS = 2_000;
let fetchImpl: typeof fetch | null = null;

export interface OpencodeServerHandle {
  harnessId: string;
  /** `http://127.0.0.1:<port>`, from the server's own listening line. */
  url: string;
  password: string;
  /** The tmux session hosting the server, or null for the `direct` test host. */
  tmuxSession: string | null;
  startedAt: number;
  version?: string;
  /** Set on the handle `ensure` returns when the running server was started
   *  with a different bin/env/cwd than the spec asks for but is busy, so it
   *  was kept: the caller may post a status line. */
  stale?: boolean;
}

export interface OpencodeServerSpec {
  harnessId: string;
  bin: string;
  /** `harnessEnv(harness)`: plain values, not a `process.env` copy. */
  env: Record<string, string>;
  /** The harness home, or `$HOME`. */
  cwd: string;
  /** Whether a turn or an open card is using this harness's server right now.
   *  Consulted only when the running server's launch fingerprint differs from
   *  this spec: idle → restart on the new settings, busy → keep it and return
   *  a `stale` handle. Default: not busy. */
  isBusy?: () => boolean;
}

interface ServerRecord {
  handle: OpencodeServerHandle;
  /** Pid of the child this core spawned (`direct` host only). */
  hostPid?: number;
  fingerprint?: string;
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
  hostPid?: number;
  fingerprint?: string;
}

interface TerminateTarget {
  tmuxSession: string | null;
  hostPid?: number;
}

const servers = new Map<string, ServerRecord>();
const starting = new Map<string, Promise<OpencodeServerHandle>>();
const stopping = new Map<string, Promise<void>>();
/** Live `direct`-host children this process spawned, by pid: the only pids
 *  outside a tmux pane tree that may ever be signalled. */
const directProcs = new Map<number, ReturnType<typeof coreSpawn>>();

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
  return serverDirOverride ?? path.join(dataDir, "opencode-servers");
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

/** A fresh 0600 log, opened for writing without following a symlink. */
function createPrivateLog(id: string): number {
  removeFile(logPath(id));
  return openSync(logPath(id), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Launch fingerprint
 * ────────────────────────────────────────────────────────────────────────── */

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function specEnvEntries(spec: OpencodeServerSpec): Array<[string, string]> {
  return Object.entries(spec.env)
    .filter(([k, v]) => typeof v === "string" && ENV_KEY_RE.test(k) && !SCRUBBED_ENV_KEYS.includes(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** sha256 of what a launch is made of (bin, cwd, the harness env). Only the
 *  digest is stored; the env values themselves are not. */
function fingerprintOf(spec: OpencodeServerSpec): string {
  return createHash("sha256").update(JSON.stringify([spec.bin, spec.cwd, specEnvEntries(spec)])).digest("hex");
}

/* ────────────────────────────────────────────────────────────────────────── *
 * State file (read back no-follow; anything off is treated as absent)
 * ────────────────────────────────────────────────────────────────────────── */

function hostIsDirect(): boolean {
  return process.env.AGETOR_OPENCODE_SERVER_HOST === "direct";
}

function posInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
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
    if (o.url !== "" && !isLoopbackOpencodeUrl(o.url)) return null;
    // A null session means the direct test host; any other build only writes
    // a tmux session name, so a null in a release flow is a planted file.
    if (o.tmuxSession === null) {
      if (!hostIsDirect()) return null;
    } else if (typeof o.tmuxSession !== "string" || o.tmuxSession !== sessionNameFor(o.harnessId)) {
      return null;
    }
    if (typeof o.startedAt !== "number" || !Number.isFinite(o.startedAt)) return null;
    return {
      harnessId: o.harnessId,
      url: o.url,
      password: o.password,
      tmuxSession: o.tmuxSession,
      startedAt: o.startedAt,
      version: typeof o.version === "string" ? o.version : undefined,
      hostPid: posInt(o.hostPid),
      fingerprint: typeof o.fingerprint === "string" && /^[0-9a-f]{64}$/.test(o.fingerprint) ? o.fingerprint : undefined,
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
    hostPid: rec.hostPid,
    fingerprint: rec.fingerprint,
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
  /** The connection was refused: nothing listens there. The only transport
   *  error that proves the server is gone (a reset or a closed keep-alive
   *  socket says nothing about a busy server). */
  refused?: boolean;
  version?: string;
}

async function probe(url: string, password: string, timeoutMs: number): Promise<ProbeResult> {
  // The password only ever goes to a loopback origin.
  if (!isLoopbackOpencodeUrl(url)) return { ok: false };
  try {
    const res = await (fetchImpl ?? fetch)(`${url}/api/info`, {
      headers: { Authorization: opencodeAuthHeader(password), Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, status: res.status };
    }
    let version: string | undefined;
    try {
      const body = (await res.json()) as { version?: unknown };
      if (typeof body.version === "string") version = body.version;
    } catch {
      /* a 200 with an odd body still proves the authenticated server */
    }
    return { ok: true, status: 200, version };
  } catch (e) {
    const err = e as { name?: string; code?: string };
    return {
      ok: false,
      timedOut: err.name === "TimeoutError" || err.name === "AbortError",
      refused: err.code === "ConnectionRefused" || err.code === "ECONNREFUSED",
    };
  }
}

/** Authenticated `GET /api/info` against `h`. */
async function checkOpencodeServerHealth(h: OpencodeServerHandle, timeoutMs: number = healthTimeoutMs): Promise<boolean> {
  return (await probe(h.url, h.password, timeoutMs)).ok;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * tmux, process table and pid authority
 * ────────────────────────────────────────────────────────────────────────── */

async function tmuxQuery(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  try {
    const proc = coreSpawn([resolveTmuxBin(), ...tmuxSocketArgs(), ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv(),
    }) as Bun.Subprocess<"ignore", "pipe", "pipe">;
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    return { code: null, stdout: "", stderr: (e as Error).message };
  }
}

type HostState = "alive" | "gone" | "unknown";

const TMUX_GONE_RE = /can't find session|no server running|error connecting to/i;

/** `has-session` on the exact name. "gone" only when tmux itself said so; a
 *  failed tmux call is "unknown" and never counts as proof. */
async function tmuxHasSession(name: string): Promise<HostState> {
  const res = await tmuxQuery(["has-session", "-t", `=${name}:`]);
  if (res.code === 0) return "alive";
  if (res.code === 1 && TMUX_GONE_RE.test(res.stderr)) return "gone";
  return "unknown";
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isAlive(pid: number): boolean {
  const child = directProcs.get(pid);
  return child ? child.exitCode === null : pidAlive(pid);
}

function hostState(t: TerminateTarget): Promise<HostState> | HostState {
  if (t.tmuxSession) return tmuxHasSession(t.tmuxSession);
  if (t.hostPid === undefined) return "unknown";
  return isAlive(t.hostPid) ? "alive" : "gone";
}

/** pid → ppid for every process. Empty on failure (callers then signal nothing). */
async function processTable(): Promise<Map<number, number>> {
  const table = new Map<number, number>();
  try {
    const proc = coreSpawn(["/bin/ps", "-axo", "pid=,ppid="], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: childEnv(),
    }) as Bun.Subprocess<"ignore", "pipe", "ignore">;
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of text.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (m) table.set(Number(m[1]), Number(m[2]));
    }
  } catch {
    table.clear();
  }
  return table;
}

/** This process and its ancestors: never signalled. */
function protectedPids(table: Map<number, number>): Set<number> {
  const out = new Set<number>([process.pid]);
  let cur = process.pid;
  for (let i = 0; i < 64; i++) {
    const parent = table.get(cur);
    if (parent === undefined || parent <= 1 || out.has(parent)) break;
    out.add(parent);
    cur = parent;
  }
  return out;
}

/** The pids `terminate` may signal for this target (see the file header). */
async function authorizedPids(t: TerminateTarget): Promise<number[]> {
  if (!t.tmuxSession) {
    const child = t.hostPid === undefined ? undefined : directProcs.get(t.hostPid);
    if (!child || child.exitCode !== null || child.pid === process.pid) return [];
    return [child.pid];
  }
  const panes = await tmuxQuery(["list-panes", "-t", `=${t.tmuxSession}:`, "-F", "#{pane_pid}"]);
  if (panes.code !== 0) return [];
  const roots = panes.stdout.split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 1);
  if (roots.length === 0) return [];
  const table = await processTable();
  if (table.size === 0) return [];
  const keep = new Set<number>(roots);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, ppid] of table) if (keep.has(ppid) && !keep.has(pid)) { keep.add(pid); grew = true; }
  }
  const never = protectedPids(table);
  return [...keep].filter((pid) => pid > 1 && !never.has(pid));
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    /* gone */
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() >= until) return false;
    await sleep(POLL_MS);
  }
}

/** Stop the host: `kill-session` on the exact name (tmux) or a signal to the
 *  child this core spawned (direct), then wait a bounded time and escalate to
 *  the pids `authorizedPids` named before the session was killed. Never throws. */
async function terminate(t: TerminateTarget): Promise<void> {
  try {
    const auth = await authorizedPids(t);
    if (t.tmuxSession) await tmuxQuery(["kill-session", "-t", `=${t.tmuxSession}:`]);
    else for (const pid of auth) signal(pid, "SIGTERM");
    const settled = async (): Promise<boolean> => {
      if (auth.some(isAlive)) return false;
      return t.tmuxSession ? (await tmuxHasSession(t.tmuxSession)) !== "alive" : true;
    };
    if (await waitUntil(settled, STOP_GRACE_MS)) return;
    for (const pid of auth) if (isAlive(pid)) signal(pid, "SIGTERM");
    if (await waitUntil(settled, STOP_GRACE_MS)) return;
    for (const pid of auth) if (isAlive(pid)) signal(pid, "SIGKILL");
  } catch {
    /* best-effort: stop never throws */
  }
}

const targetOf = (rec: ServerRecord): TerminateTarget => ({ tmuxSession: rec.handle.tmuxSession, hostPid: rec.hostPid });

/* ────────────────────────────────────────────────────────────────────────── *
 * Hosting (tmux, or the `direct` test seam)
 * ────────────────────────────────────────────────────────────────────────── */

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The server's whole environment, as plain values. A spec value wins over the
 *  `OPENCODE_DISABLE_AUTOUPDATE` default (like discovery); the password is
 *  always agetor's. */
function serverEnv(spec: OpencodeServerSpec, password: string): Record<string, string> {
  const env: Record<string, string> = { OPENCODE_DISABLE_AUTOUPDATE: "1" };
  for (const [k, v] of specEnvEntries(spec)) env[k] = v;
  if (env.PATH === undefined && process.env.PATH) env.PATH = process.env.PATH;
  env.OPENCODE_PASSWORD = password;
  return env;
}

/** The inner `sh -c` script: output to the log first (so a bad env file is
 *  visible), then source the env file, delete it, exec the server — so the
 *  pane's pid IS the server. `$1` env file, `$2` log, the rest is the command. */
const TMUX_INNER_SCRIPT = 'exec >"$2" 2>&1; . "$1" || exit 1; rm -f -- "$1"; shift 2; exec "$@"';

async function launchInTmux(spec: OpencodeServerSpec, password: string): Promise<void> {
  const env = serverEnv(spec, password);
  const lines = Object.keys(env)
    .sort()
    .map((k) => `export ${k}=${shellQuote(env[k]!)}`);
  writePrivateFile(envPath(spec.harnessId), `${lines.join("\n")}\n`);
  const res = await spawnTmuxNewSession(resolveTmuxBin(), [
    ...tmuxSocketArgs(),
    "new-session", "-d", "-s", sessionNameFor(spec.harnessId),
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
}

function launchDirect(spec: OpencodeServerSpec, password: string, logFd: number): ReturnType<typeof coreSpawn> {
  const proc = coreSpawn([spec.bin, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: spec.cwd,
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
    env: childEnv(serverEnv(spec, password)),
  });
  proc.unref();
  directProcs.set(proc.pid, proc);
  void proc.exited.then(() => directProcs.delete(proc.pid)).catch(() => {});
  return proc;
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
    return isLoopbackOpencodeUrl(u.origin) ? u.origin : null;
  } catch {
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Start
 * ────────────────────────────────────────────────────────────────────────── */

async function startServer(spec: OpencodeServerSpec, fingerprint: string): Promise<ServerRecord> {
  const id = spec.harnessId;
  ensureServerDir();
  // A leftover session or file from a crashed start must not collide.
  await terminate({ tmuxSession: sessionNameFor(id) });
  removeFiles(id, { log: true });

  const password = randomBytes(32).toString("base64url");
  const direct = hostIsDirect();
  const tmuxSession = direct ? null : sessionNameFor(id);
  const startedAt = Date.now();
  const rec: ServerRecord = {
    handle: { harnessId: id, url: "", password, tmuxSession, startedAt },
    fingerprint,
    lastActivity: startedAt,
    healthyAt: 0,
  };
  // The state file exists BEFORE the server does, so a core that dies between
  // launch and the final write leaves something the next boot can clean up
  // (an empty url means "never became healthy").
  writeState(rec);
  const logFd = createPrivateLog(id);

  const fail = async (reason: string): Promise<never> => {
    const tail = logTail(id, password);
    await terminate(targetOf(rec));
    removeFile(statePath(id));
    removeFile(envPath(id));
    throw new Error(`OpenCode server failed to start: ${redact(reason, password)}${tail ? `\n${tail}` : ""}`);
  };

  let child: ReturnType<typeof coreSpawn> | undefined;
  try {
    if (direct) {
      child = launchDirect(spec, password, logFd);
      rec.hostPid = child.pid;
    } else {
      await launchInTmux(spec, password);
    }
  } catch (e) {
    return fail((e as Error).message);
  } finally {
    closeSync(logFd);
  }

  const exited = (): boolean => child !== undefined && child.exitCode !== null;
  const deadline = Date.now() + startBudgetMs;
  let url: string | null = null;
  for (let poll = 0; Date.now() < deadline; poll++) {
    url = parseListeningUrl(readLogHead(id));
    if (url) break;
    if (exited()) return fail("the server exited before it started listening");
    if (tmuxSession && poll > 0 && poll % LIVENESS_EVERY_POLLS === 0 && (await tmuxHasSession(tmuxSession)) === "gone") {
      return fail("the server exited before it started listening");
    }
    await sleep(POLL_MS);
  }
  if (!url) return fail("the server did not report a listening address in time");

  rec.handle.url = url;
  let last: ProbeResult = { ok: false };
  while (Date.now() < deadline) {
    last = await probe(url, password, healthTimeoutMs);
    if (last.ok) break;
    if (exited()) return fail("the server exited before it answered");
    await sleep(POLL_MS);
  }
  if (!last.ok) return fail(`the server did not answer an authenticated info request${last.status ? ` (HTTP ${last.status})` : ""}`);

  rec.handle.version = last.version;
  rec.healthyAt = Date.now();
  writeState(rec);
  return rec;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Stop
 * ────────────────────────────────────────────────────────────────────────── */

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
      await terminate(targetOf(rec));
    } else {
      // Nothing in memory: a state file may still describe a server (not yet
      // adopted, or left by a crashed start). Stop its recorded host.
      // Only a state file that really is this harness's (same checks as
      // adoption: filed under its own name, naming its own session) may name
      // what to kill; anything else is a planted file and is just removed.
      const state = readStateFile(statePath(harnessId));
      const own = state !== null && state.harnessId === harnessId && statePath(state.harnessId) === statePath(harnessId);
      await terminate(own ? { tmuxSession: state.tmuxSession, hostPid: state.hostPid } : { tmuxSession: hostIsDirect() ? null : sessionNameFor(harnessId) });
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

type Verdict = "ok" | "dead" | "unresponsive";

/** Decide a server's fate. "dead" needs positive proof (host gone, connection
 *  refused, or our password rejected twice); any other failure from a host that
 *  is still there (timeout, reset, odd status) is "unresponsive": it may be
 *  busy, so it is kept (I3). */
async function classify(url: string, password: string, host: TerminateTarget): Promise<{ verdict: Verdict; version?: string }> {
  if ((await hostState(host)) === "gone") return { verdict: "dead" };
  let res = await probe(url, password, healthTimeoutMs);
  if (res.timedOut) res = await probe(url, password, healthTimeoutMs * 2);
  if (res.ok) return { verdict: "ok", version: res.version };
  if (res.refused) return { verdict: "dead" };
  if (res.status === 401) {
    // One more look: only a 401 that persists means "not our server".
    const again = await probe(url, password, healthTimeoutMs);
    if (again.ok) return { verdict: "ok", version: again.version };
    if (again.status === 401 || again.refused) return { verdict: "dead" };
    res = again;
  }
  // A reset, a closed socket, a timeout or an odd status: the host decides.
  if ((await hostState(host)) === "gone") return { verdict: "dead" };
  return { verdict: "unresponsive" };
}

async function healthy(rec: ServerRecord): Promise<Verdict> {
  if (Date.now() - rec.healthyAt < healthCacheMs) return "ok";
  const res = await classify(rec.handle.url, rec.handle.password, targetOf(rec));
  if (res.verdict === "ok") {
    rec.healthyAt = Date.now();
    if (res.version) rec.handle.version = res.version;
  }
  return res.verdict;
}

/** What decides, mid-flight, whether adoption may still destroy anything. */
interface AdoptCtx {
  /** Boot adoption's budget ran out: the server was kept as unhealthy, so a
   *  late "dead" verdict must not clean it up. */
  expired?: boolean;
  /** The caller's busy gate (ensure): a busy server is never cleaned up while
   *  its host is still there. */
  busy?: () => boolean;
}

function recordFromState(state: StateFile, healthyAt: number, version?: string): ServerRecord {
  return {
    handle: {
      harnessId: state.harnessId,
      url: state.url,
      password: state.password,
      tmuxSession: state.tmuxSession,
      startedAt: state.startedAt,
      version: version ?? state.version,
    },
    hostPid: state.hostPid,
    fingerprint: state.fingerprint,
    lastActivity: Date.now(),
    healthyAt,
  };
}

/** Adopt the server a state file describes. A server that answers is adopted;
 *  one that is only slow is adopted too, marked unhealthy (`healthyAt: 0`), so
 *  the next `ensure` re-probes it instead of replacing it; one provably gone,
 *  or a file that cannot be trusted, is cleaned up. */
async function adoptState(file: string, only?: string, ctx: AdoptCtx = {}): Promise<ServerRecord | null> {
  const state = readStateFile(file);
  // Boot adoption must not touch a server this process is starting or holds.
  if (state && only === undefined && (starting.has(state.harnessId) || servers.has(state.harnessId))) return null;
  if (!state || statePath(state.harnessId) !== file || (only !== undefined && state.harnessId !== only)) {
    // Unreadable, a symlink, wrong owner/mode, planted, or filed under the wrong name.
    const stem = path.basename(file, ".json");
    removeFile(file);
    removeFile(path.join(serverDir(), `${stem}.env`));
    return null;
  }
  const target: TerminateTarget = { tmuxSession: state.tmuxSession, hostPid: state.hostPid };
  const gone = async (): Promise<null> => {
    if (ctx.expired) return null;
    await terminate(target);
    removeFiles(state.harnessId, { log: true });
    return null;
  };
  if (state.url === "") return gone();
  const res = await classify(state.url, state.password, target);
  if (res.verdict === "dead") {
    let busy = false;
    try {
      busy = ctx.busy?.() ?? false;
    } catch {
      busy = true;
    }
    if (busy && (await hostState(target)) !== "gone") return recordFromState(state, 0);
    return gone();
  }
  return recordFromState(state, res.verdict === "ok" ? Date.now() : 0, res.version);
}

function specBusy(spec: OpencodeServerSpec): boolean {
  if (!spec.isBusy) return false;
  try {
    return spec.isBusy();
  } catch {
    return true; // an unanswerable gate never lets a restart through (I3)
  }
}

async function ensureInner(spec: OpencodeServerSpec): Promise<OpencodeServerHandle> {
  const id = spec.harnessId;
  await stopping.get(id);
  const fingerprint = fingerprintOf(spec);
  let rec = servers.get(id);
  if (!rec) {
    // Not in memory (boot adoption not run, or it ran before this harness
    // existed): a server from an earlier core is reused.
    ensureServerDir();
    const adopted = await adoptState(statePath(id), id, { busy: spec.isBusy ? () => specBusy(spec) : undefined });
    if (adopted) {
      servers.set(id, adopted);
      rec = adopted;
    }
  }
  if (rec) {
    const verdict = await healthy(rec);
    if (verdict === "unresponsive") throw new Error("The OpenCode server is not responding.");
    if (verdict === "ok") {
      rec.lastActivity = Date.now();
      if (rec.fingerprint === fingerprint) return rec.handle;
      // Started with other settings (bin, env or cwd changed since).
      if (specBusy(spec)) return { ...rec.handle, stale: true };
    }
    if (verdict === "dead") {
      // Re-check the host right before destroying anything: a refused
      // connection or a persistent 401 from a host that is still there, with a
      // turn running, is not a licence to restart (I3).
      if ((await hostState(targetOf(rec))) !== "gone" && specBusy(spec)) {
        throw new Error("The OpenCode server is not responding.");
      }
    }
    servers.delete(id);
    await terminate(targetOf(rec));
    removeFiles(id, { log: true });
  }
  rec = await startServer(spec, fingerprint);
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

/** Boot: keep the servers a previous core left running, clean up the ones that
 *  are provably gone. Servers are judged in parallel under one overall budget;
 *  a server still undecided when it runs out is kept as unhealthy (the next
 *  `ensure` re-probes it), never killed. A server that is only slow is kept. */
export async function adoptOpencodeServers(): Promise<OpencodeServerHandle[]> {
  let names: string[];
  try {
    ensureServerDir();
    names = readdirSync(serverDir()).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const adopted: OpencodeServerHandle[] = [];
  const ctx: AdoptCtx = {};
  const undecided = new Map<string, ServerRecord>(); // file → fallback record
  const register = (rec: ServerRecord): void => {
    if (servers.has(rec.handle.harnessId)) return;
    servers.set(rec.handle.harnessId, rec);
    adopted.push(rec.handle);
  };
  const tasks = names.map(async (name) => {
    const file = path.join(serverDir(), name);
    try {
      const state = readStateFile(file);
      if (state && state.url !== "" && statePath(state.harnessId) === file) undecided.set(file, recordFromState(state, 0));
      const rec = await adoptState(file, undefined, ctx);
      undecided.delete(file);
      if (rec && !ctx.expired) register(rec);
      else if (rec && ctx.expired && servers.get(rec.handle.harnessId)?.healthyAt === 0 && rec.healthyAt !== 0) {
        // Decided healthy after the budget: upgrade the fallback entry.
        servers.get(rec.handle.harnessId)!.healthyAt = rec.healthyAt;
      }
    } catch {
      undecided.delete(file);
      /* one bad entry must not stop the rest */
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<"budget">((resolve) => {
    timer = setTimeout(() => resolve("budget"), adoptBudgetMs);
  });
  const outcome = await Promise.race([Promise.allSettled(tasks).then(() => "done" as const), budget]);
  if (timer) clearTimeout(timer);
  if (outcome === "budget") {
    ctx.expired = true;
    for (const rec of undecided.values()) register(rec);
    undecided.clear();
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

/**
 * A real quit that cannot await (Electrobun's `quit()` runs synchronous FFI
 * right after the before-quit event): stop every in-memory server that is not
 * busy, fully synchronously. tmux: `kill-session` on the exact name on the
 * instance socket through `coreSpawnSync` (each call bounded); the direct test
 * host: signal the child this core spawned. State, env and log files go too.
 * Never throws; returns the stopped ids. No escalation and no waiting — the
 * session's SIGHUP is the whole stop.
 */
export function stopIdleOpencodeServersSync(isBusy: (harnessId: string) => boolean): string[] {
  const stopped: string[] = [];
  for (const [id, rec] of [...servers]) {
    try {
      if (starting.has(id) || busy(isBusy, id)) continue;
      servers.delete(id);
      const session = rec.handle.tmuxSession;
      if (session) {
        coreSpawnSync(resolveTmuxBin(), [...tmuxSocketArgs(), "kill-session", "-t", `=${session}:`], {
          stdio: "ignore",
          env: childEnv(),
          timeout: SYNC_TMUX_TIMEOUT_MS,
        });
      } else {
        const child = rec.hostPid === undefined ? undefined : directProcs.get(rec.hostPid);
        if (child && child.exitCode === null && child.pid !== process.pid) child.kill("SIGTERM");
      }
      removeFiles(id, { log: true });
      stopped.push(id);
    } catch {
      /* best-effort: a quit never throws */
    }
  }
  return stopped;
}

/** Test-only helpers; production code never calls these. */
export const __forTest = {
  /** Authenticated `/api/info` probe (production uses it internally through `healthy`). */
  checkHealth: checkOpencodeServerHealth,
  /** Forget every in-memory server (their hosts are left alone). */
  forget(): void {
    servers.clear();
    starting.clear();
    stopping.clear();
  },
  /** SIGKILL every direct-host child this process still holds. */
  reapDirect(): void {
    for (const child of directProcs.values()) child.kill("SIGKILL");
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
  setHealthTimeoutMs(ms: number): void {
    healthTimeoutMs = ms;
  },
  setAdoptBudgetMs(ms: number): void {
    adoptBudgetMs = ms;
  },
  /** Replace `fetch` for health probes (null restores it). */
  setFetchImpl(f: typeof fetch | null): void {
    fetchImpl = f;
  },
  /** Point the manager at a private directory (one per test). */
  setServerDir(dir: string | null): void {
    serverDirOverride = dir;
  },
  restoreDefaults(): void {
    idleMs = OPENCODE_SERVER_IDLE_MS;
    startBudgetMs = DEFAULT_START_BUDGET_MS;
    healthCacheMs = DEFAULT_HEALTH_CACHE_MS;
    healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS;
    adoptBudgetMs = DEFAULT_ADOPT_BUDGET_MS;
    fetchImpl = null;
    serverDirOverride = null;
  },
  statePath,
  logPath,
  envPath,
  sessionNameFor,
  serverDir,
  safeId,
  redact,
  tmuxHasSession,
};

// Repeatable core-responsiveness benchmark (docs/plans/non-blocking-core.md §1
// criterion 2, task T4).
//
// Boots a headless core (`bun src/bun/headless.ts`, fake claude driver) on a
// throwaway data dir under ~/.agetor-dev/bench-<timestamp>/, drives a realistic
// heavy load against it, and reports how responsive it stayed:
//   - GET /health probed every 50 ms: p50/p95/p99/max and the count of probes
//     over 1 s and over 3 s (a probe that never answers within 10 s counts as 10 s);
//   - the board poll (GET /tasks?archived=exclude every 2 s, as the webview does);
//   - transcript replay (GET /tasks/:id/events of a task whose fake run wrote
//     many large subagent transcripts, re-opened every few seconds);
//   - the stalls the core's own event-loop-lag monitor logged
//     ("core was unresponsive for N.N s during <label>"), read from
//     <dataDir>/logs/core.log when the core writes one, else from its output.
// Run it on any checkout, before and after a change, and diff the two reports.
//
// Usage:
//   bun scripts/measure-core-responsiveness.ts [--source <path-to-agetor.sqlite>]
//       [--duration-s 60] [--port 4399] [--label before|after] [--json <out>]
//       [--tasks 500] [--files 39] [--kb 5000] [--calibrate] [--cleanup]
//       [--data-dir <dir>]
//
//   --source     copy this DB (SQLite online backup, read-only on the source)
//                instead of seeding a synthetic one
//   --tasks      synthetic seed size (default 500, ~80% archived); ignored with --source
//   --files/--kb transcript size of the replay task (`__agetor_fake_claude_real_watcher__:<files>x<kb>`)
//   --calibrate  start the core with AGETOR_TEST_BLOCK_ROUTE=1 and block its
//                event loop for 1.5 s once mid-run: max /health latency must
//                then be at least 1.4 s, which proves the probe sees a stall
//   --cleanup    delete the bench dir afterwards (default keeps it)
//   --data-dir   override the bench dir (must not exist or be empty; never under, over or equal to ~/.agetor, $HOME or ~/.agetor-dev)
//
// Safety: nothing under the real ~/.agetor is ever read or written, and the
// script never deletes or seeds anything it did not create. Every refusal below
// happens before the first write and exits 2:
//   - the target is inside, equal to, or CONTAINS ~/.agetor;
//   - the target is $HOME (or an ancestor of it), ~/.agetor-dev itself, or an
//     ancestor of it;
//   - --data-dir points at an existing non-empty directory (or a file).
// --cleanup removes only what this run created: the whole bench dir when the
// script created it, otherwise just the children it added to a pre-existing
// EMPTY --data-dir. The source DB is only opened read-only, through
// `sqlite3 -readonly … .backup`, never `cp` (which would break WAL consistency).
// A Ctrl-C mid-run still stops the child core.
//
// Isolation (the benchmark core must not touch the machine it runs on):
//   - HOME is a sandbox dir inside the bench dir (<bench>/home), TMPDIR and the
//     agent config homes (CLAUDE_CONFIG_DIR, CODEX_HOME, COPILOT_HOME, XDG_*)
//     live there too, so no real credentials, OAuth tokens or sessions exist;
//   - PATH is only <bench>/fakebin, bun's own directory, /usr/bin and /bin.
//     fakebin holds a `security` stub (the Claude usage poller reads its OAuth
//     token with `security find-generic-password`; the stub always fails, and
//     the sandbox HOME has no keychain either), a `tmux` stub (has-session
//     always fails, so nothing reattaches) and one stub per agent kind;
//   - AGETOR_<KIND>_DRIVER=fake and AGETOR_<KIND>_BIN=<stub> for every kind,
//     AGETOR_HARNESS_AUTO_ENABLE=0, AGETOR_COPILOT_ACP_PROBE=0;
//   - with --source the COPY (never the source) is sanitized before boot:
//     `running` runs become `orphaned` (tmux_session cleared, ended_at set),
//     tasks in column `running` move to `ready`, non-builtin harnesses are
//     disabled. The summary prints the row counts changed.
// No production seam exists to switch the pollers off; the sandbox HOME, the
// `security` stub and the stubbed/fake agents are what contain them.

import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";

// ── Arguments ────────────────────────────────────────────────────────────────

interface Options {
  source: string | null;
  durationS: number;
  port: number;
  label: string;
  json: string | null;
  tasks: number;
  files: number;
  kb: number;
  calibrate: boolean;
  cleanup: boolean;
  dataDir: string | null;
}

function fail(message: string, code = 2): never {
  console.error(`[measure-core] ${message}`);
  process.exit(code);
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    source: null,
    durationS: 60,
    port: 4399,
    label: "run",
    json: null,
    tasks: 500,
    files: 39,
    kb: 5000,
    calibrate: false,
    cleanup: false,
    dataDir: null,
  };
  const intArg = (name: string, v: string | undefined, min: number, max: number): number => {
    const n = Number(v);
    if (v === undefined || !Number.isInteger(n) || n < min || n > max) {
      fail(`${name} needs an integer in ${min}..${max}`);
    }
    return n;
  };
  const strArg = (name: string, v: string | undefined): string => {
    if (v === undefined || v === "" || v.startsWith("--")) fail(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--source": o.source = strArg(a, argv[++i]); break;
      case "--duration-s": o.durationS = intArg(a, argv[++i], 5, 3600); break;
      case "--port": o.port = intArg(a, argv[++i], 1024, 65535); break;
      case "--label": o.label = strArg(a, argv[++i]); break;
      case "--json": o.json = strArg(a, argv[++i]); break;
      case "--tasks": o.tasks = intArg(a, argv[++i], 1, 20000); break;
      case "--files": o.files = intArg(a, argv[++i], 1, 500); break;
      case "--kb": o.kb = intArg(a, argv[++i], 1, 8192); break;
      case "--data-dir": o.dataDir = strArg(a, argv[++i]); break;
      case "--calibrate": o.calibrate = true; break;
      case "--cleanup": o.cleanup = true; break;
      case "--help":
      case "-h":
        console.log("usage: bun scripts/measure-core-responsiveness.ts [--source <agetor.sqlite>] [--duration-s 60] [--port 4399] [--label before|after] [--json <out>] [--tasks 500] [--files 39] [--kb 5000] [--calibrate] [--cleanup] [--data-dir <dir>]");
        process.exit(0);
      default:
        fail(`unknown argument ${a}`);
    }
  }
  return o;
}

// ── Safety: never touch the real data dir ────────────────────────────────────

/** True when `candidate` equals `root` or lies inside it (segment compare, so
 *  `~/.agetor-dev` is not mistaken for being inside `~/.agetor`). */
function isInsideOrEqual(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** realpath of the deepest existing ancestor, with the rest appended, so a
 *  not-yet-created dir behind a symlink is still resolved. */
function realpathLoose(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  let base = cur;
  try { base = realpathSync(cur); } catch { /* keep as is */ }
  return path.join(base, ...rest);
}

const opts = parseArgs(process.argv.slice(2));
// HOME env wins so a test can stand in a temp dir for the real home.
const HOME = realpathLoose(process.env.HOME || homedir());
const REAL_DIR = realpathLoose(path.join(HOME, ".agetor"));
const BENCH_BASE = realpathLoose(path.join(HOME, ".agetor-dev"));
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const targetDir = realpathLoose(opts.dataDir ?? path.join(BENCH_BASE, `bench-${stamp}`));

if (isInsideOrEqual(REAL_DIR, targetDir)) {
  fail(`refusing: ${targetDir} is inside the real data dir ${REAL_DIR}`);
}
if (isInsideOrEqual(targetDir, REAL_DIR)) {
  fail(`refusing: ${targetDir} contains the real data dir ${REAL_DIR}`);
}
if (isInsideOrEqual(targetDir, HOME)) {
  fail(`refusing: ${targetDir} is the home directory or an ancestor of it`);
}
if (isInsideOrEqual(targetDir, BENCH_BASE)) {
  fail(`refusing: ${targetDir} is the bench base dir ${BENCH_BASE} or an ancestor of it`);
}
/** True when the script itself creates the target dir (it did not exist). */
let createdTarget = true;
if (existsSync(targetDir)) {
  const st = statSync(targetDir);
  if (!st.isDirectory()) fail(`refusing: ${targetDir} exists and is not a directory`);
  if (readdirSync(targetDir).length > 0) fail(`refusing: ${targetDir} already exists and is not empty`);
  createdTarget = false;
}
if (/'/.test(targetDir)) fail("refusing: the data dir path contains a single quote");
let sourcePath: string | null = null;
if (opts.source) {
  if (!existsSync(opts.source)) fail(`--source ${opts.source} does not exist`);
  sourcePath = realpathLoose(opts.source);
  if (isInsideOrEqual(targetDir, sourcePath)) {
    fail(`refusing: --source ${sourcePath} is inside the target dir ${targetDir}`);
  }
  if (/'/.test(sourcePath)) fail("refusing: the --source path contains a single quote");
}

// ── Child core lifecycle ─────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const TOKEN = crypto.randomUUID() + crypto.randomUUID();
const BASE = `http://127.0.0.1:${opts.port}`;
const SANDBOX_HOME = path.join(targetDir, "home");
const FAKE_BIN = path.join(targetDir, "fakebin");
const AGENT_KINDS = ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY", "COPILOT", "OPENCODE"] as const;
const AUTH = { Authorization: `Bearer ${TOKEN}` };

interface Core {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  output: string[];
}
let core: Core | null = null;
let tearingDown = false;

/** Stub agent CLI: answers --version/--help well enough to pass every identity
 *  gate (copilot wants "GitHub Copilot CLI", fx wants "coding agent"), refuses
 *  everything else, so no model list, login probe or prompt ever succeeds. */
const STUB_AGENT = `#!/bin/sh
case "$1" in
  --version|-v|version) echo "99.0.0 GitHub Copilot CLI (agetor-bench stub)"; exit 0 ;;
  --help|-h|help) echo "agetor-bench stub: coding agent"; exit 0 ;;
esac
exit 1
`;
const STUB_TMUX = `#!/bin/sh
# agetor-bench stub: every session lookup fails, so nothing is ever reattached.
case "$1" in -V) echo "tmux 3.4"; exit 0 ;; esac
exit 1
`;
const STUB_SECURITY = `#!/bin/sh
# agetor-bench stub: no keychain item is ever found (exit 44 = item not found).
exit 44
`;

function writeStub(name: string, body: string): string {
  const f = path.join(FAKE_BIN, name);
  writeFileSync(f, body);
  chmodSync(f, 0o755);
  return f;
}

function sandboxEnv(): Record<string, string> {
  mkdirSync(SANDBOX_HOME, { recursive: true });
  mkdirSync(path.join(targetDir, "tmp"), { recursive: true });
  mkdirSync(FAKE_BIN, { recursive: true });
  const env: Record<string, string> = {
    PATH: [FAKE_BIN, path.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: SANDBOX_HOME,
    TMPDIR: path.join(targetDir, "tmp"),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    CLAUDE_CONFIG_DIR: path.join(SANDBOX_HOME, ".claude"),
    CODEX_HOME: path.join(SANDBOX_HOME, ".codex"),
    COPILOT_HOME: path.join(SANDBOX_HOME, ".copilot"),
    XDG_CONFIG_HOME: path.join(SANDBOX_HOME, ".config"),
    XDG_DATA_HOME: path.join(SANDBOX_HOME, ".local", "share"),
    XDG_CACHE_HOME: path.join(SANDBOX_HOME, ".cache"),
    AGETOR_COPILOT_ACP_PROBE: "0",
    AGETOR_TMUX_BIN: writeStub("tmux", STUB_TMUX),
  };
  writeStub("security", STUB_SECURITY);
  const agentStub = writeStub("agent-stub", STUB_AGENT);
  for (const k of AGENT_KINDS) {
    env[`AGETOR_${k}_DRIVER`] = "fake";
    env[`AGETOR_${k}_BIN`] = agentStub;
    env[`AGETOR_${k}_ARGS`] = "";
  }
  return env;
}

function startCore(): Core {
  // An explicit env: nothing of the caller's AGETOR_* (the real master token
  // included) leaks in, and the token below is random and used for this run only.
  const env: Record<string, string> = {
    ...sandboxEnv(),
    AGETOR_DATA_DIR: targetDir,
    AGETOR_API_PORT: String(opts.port),
    AGETOR_API_TOKEN: TOKEN,
    AGETOR_DAEMON_IDLE_MS: "0",
    AGETOR_HEADLESS_NOTIFICATIONS: "0",
    AGETOR_HARNESS_AUTO_ENABLE: "0",
    AGETOR_LAG_MONITOR: "1",
    AGETOR_CORE_LOG: "1",
    ...(opts.calibrate ? { AGETOR_TEST_BLOCK_ROUTE: "1" } : {}),
  };
  const proc = Bun.spawn([process.execPath, "src/bun/headless.ts"], {
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const output: string[] = [];
  for (const stream of [proc.stdout, proc.stderr]) {
    void (async () => {
      const dec = new TextDecoder();
      let carry = "";
      try {
        for await (const chunk of stream) {
          carry += dec.decode(chunk, { stream: true });
          const lines = carry.split("\n");
          carry = lines.pop() ?? "";
          for (const l of lines) output.push(l);
        }
      } catch { /* stream closed */ }
      if (carry) output.push(carry);
    })();
  }
  return { proc, output };
}

async function stopCore(c: Core | null): Promise<void> {
  if (!c || c.proc.exitCode !== null) return;
  try { c.proc.kill("SIGTERM"); } catch { /* already gone */ }
  const exited = await Promise.race([
    c.proc.exited.then(() => true),
    Bun.sleep(5000).then(() => false),
  ]);
  if (!exited) {
    try { c.proc.kill("SIGKILL"); } catch { /* already gone */ }
    await c.proc.exited;
  }
}

async function teardownAndExit(code: number): Promise<never> {
  if (!tearingDown) {
    tearingDown = true;
    await stopCore(core);
  }
  process.exit(code);
}

// Ctrl-C / kill mid-run must not leave an orphaned core behind.
process.on("SIGINT", () => { console.error("\n[measure-core] interrupted, stopping the core"); void teardownAndExit(130); });
process.on("SIGTERM", () => { void teardownAndExit(143); });
// Last resort for a synchronous exit path: no awaiting is possible here.
process.on("exit", () => {
  if (core && core.proc.exitCode === null) {
    try { core.proc.kill("SIGKILL"); } catch { /* already gone */ }
  }
});

async function waitReady(c: Core, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (c.proc.exitCode !== null) {
      fail(`core exited early (code ${c.proc.exitCode}); last output:\n${c.output.slice(-15).join("\n")}`, 1);
    }
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  fail(`core not ready on ${BASE} within ${timeoutMs / 1000}s; last output:\n${c.output.slice(-15).join("\n")}`, 1);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function api(method: string, route: string, body?: unknown, timeoutMs = 60_000): Promise<Response> {
  return fetch(`${BASE}${route}`, {
    method,
    headers: { ...AUTH, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function apiOk<T>(method: string, route: string, body?: unknown): Promise<T> {
  const r = await api(method, route, body);
  if (!r.ok) throw new Error(`${method} ${route} -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return (await r.json()) as T;
}

async function pool<T>(items: T[], width: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  }));
}

// ── Stats ────────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

interface Summary { count: number; p50: number; p95: number; p99: number; max: number; over1s: number; over3s: number }
function summarize(samples: number[]): Summary {
  const s = [...samples].sort((a, b) => a - b);
  return {
    count: s.length,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s.length ? s[s.length - 1]! : NaN,
    over1s: s.filter((v) => v > 1000).length,
    over3s: s.filter((v) => v > 3000).length,
  };
}

const ms = (n: number) => (Number.isFinite(n) ? `${n.toFixed(1)} ms` : "n/a");

// ── Stall log parsing ────────────────────────────────────────────────────────

interface Stall { seconds: number; label: string }
const STALL_RE = /core was unresponsive for ([\d.]+)\s?s during (.+?)\s*$/;

function parseStalls(lines: string[]): Stall[] {
  const out: Stall[] = [];
  for (const l of lines) {
    const m = STALL_RE.exec(l);
    // The orchestrator's line may carry a trailing JSON context object; the label is what precedes it.
    if (m) out.push({ seconds: Number(m[1]), label: m[2]!.replace(/\s+\{.*\}$/, "") });
  }
  return out;
}

async function readStalls(c: Core, dir: string, outputFrom: number, coreLogFrom: number): Promise<{ stalls: Stall[]; source: string }> {
  const logFile = path.join(dir, "logs", "core.log");
  if (existsSync(logFile)) {
    const buf = Buffer.from(await Bun.file(logFile).arrayBuffer());
    const text = buf.subarray(Math.min(coreLogFrom, buf.length)).toString("utf8");
    const stalls = parseStalls(text.split("\n"));
    if (stalls.length > 0) return { stalls, source: "logs/core.log" };
  }
  return { stalls: parseStalls(c.output.slice(outputFrom)), source: "core output (stderr)" };
}

// ── Setup: data dir and seeding ──────────────────────────────────────────────

function sqlite(args: string[]): string {
  const r = Bun.spawnSync(["sqlite3", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`sqlite3 ${args.join(" ")} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

function copySource(src: string, dest: string): void {
  // Online backup: consistent with the source's WAL, and the source is opened read-only.
  sqlite(["-readonly", src, `.backup '${dest}'`]);
}

/** Sanitize the COPY so booting it cannot touch the user's live work: running
 *  runs become orphaned (no tmux session to reattach), their tasks go back to
 *  ready, user-defined harnesses are disabled. Plain SQL on the copy only. */
function sanitizeCopy(dbFile: string): string[] {
  const cols = (table: string): string[] => {
    // The copy is ours and may be in WAL mode, so no -readonly here; an error
    // must surface, not read as "no such table" (a missing table just yields no rows).
    return sqlite([dbFile, `select name from pragma_table_info('${table}')`]).split("\n").filter(Boolean);
  };
  const runs = cols("runs");
  const tasks = cols("tasks");
  const harnesses = cols("harnesses");
  const stmts: { what: string; count: string; update: string }[] = [];
  if (runs.includes("status")) {
    const sets = ["status = 'orphaned'"];
    if (runs.includes("ended_at")) sets.push("ended_at = COALESCE(ended_at, CAST(strftime('%s','now') AS INTEGER) * 1000)");
    if (runs.includes("tmux_session")) sets.push("tmux_session = NULL");
    stmts.push({ what: "running runs marked orphaned", count: "select count(*) from runs where status = 'running'", update: `update runs set ${sets.join(", ")} where status = 'running'` });
  }
  if (tasks.includes("column")) {
    stmts.push({ what: "running tasks moved to ready", count: `select count(*) from tasks where "column" = 'running'`, update: `update tasks set "column" = 'ready' where "column" = 'running'` });
  }
  if (harnesses.includes("enabled") && harnesses.includes("is_builtin")) {
    stmts.push({ what: "non-builtin harnesses disabled", count: "select count(*) from harnesses where is_builtin = 0 and enabled = 1", update: "update harnesses set enabled = 0 where is_builtin = 0" });
  }
  const lines: string[] = [];
  for (const s of stmts) {
    const n = Number(sqlite([dbFile, s.count]));
    sqlite([dbFile, s.update]);
    lines.push(`${s.what}: ${n}`);
  }
  return lines;
}

function countTasks(dbFile: string): number | null {
  try { return Number(sqlite(["-readonly", dbFile, "select count(*) from tasks"])); } catch { return null; }
}

async function seedSynthetic(workdir: string, n: number): Promise<void> {
  const ids: string[] = [];
  console.log(`[measure-core] seeding ${n} tasks through the API…`);
  await pool(Array.from({ length: n }, (_, i) => i), 8, async (i) => {
    const t = await apiOk<{ id: string }>("POST", "/tasks", {
      title: `bench task ${i}`,
      prompt: `bench prompt ${i}`,
      workdir,
      isolation: "none",
      agent: "claude-code",
    });
    ids.push(t.id);
  });
  const toArchive = ids.slice(0, Math.floor(ids.length * 0.8));
  console.log(`[measure-core] archiving ${toArchive.length} of them…`);
  await pool(toArchive, 8, async (id) => {
    await apiOk("PATCH", `/tasks/${id}`, { column: "done" });
    await apiOk("POST", `/tasks/${id}/archive`, {});
  });
}

// ── Load ─────────────────────────────────────────────────────────────────────

interface ReplayRun { ms: number; bytes: number }

/** Open the task's event stream, read the replay until it goes quiet, close. */
async function replayOnce(taskId: string): Promise<ReplayRun> {
  const t0 = performance.now();
  const ctl = new AbortController();
  const res = await fetch(`${BASE}/tasks/${taskId}/events`, { headers: AUTH, signal: ctl.signal });
  if (!res.ok || !res.body) throw new Error(`events -> ${res.status}`);
  const reader = res.body.getReader();
  let bytes = 0;
  let lastByteAt = performance.now();
  try {
    for (;;) {
      const r = await Promise.race([
        reader.read(),
        Bun.sleep(1000).then(() => "idle" as const),
      ]);
      if (r === "idle") break; // a full second with nothing: the replay is over
      if (r.done) break;
      bytes += r.value.byteLength;
      lastByteAt = performance.now();
    }
  } finally {
    ctl.abort();
    try { await reader.cancel(); } catch { /* aborted */ }
  }
  return { ms: lastByteAt - t0, bytes };
}

async function settleReplayTask(taskId: string): Promise<boolean> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const t = await apiOk<{ column: string }>("GET", `/tasks/${taskId}`);
    if (t.column !== "running" && t.column !== "backlog") return true;
    await Bun.sleep(500);
  }
  return false;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Only now, after every safety check, is anything created.
  mkdirSync(targetDir, { recursive: true });
  const workdir = path.join(targetDir, "workdir");
  mkdirSync(workdir, { recursive: true });
  const dbFile = path.join(targetDir, "agetor.sqlite");

  try {
    const alive = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
    if (alive) fail(`something already answers on ${BASE}; pick another --port`);

    let sourceBytes: number | null = null;
    let sanitizeLines: string[] = [];
    if (sourcePath) {
      console.log(`[measure-core] copying ${sourcePath} with SQLite's online backup…`);
      sourceBytes = statSync(sourcePath).size;
      copySource(sourcePath, dbFile);
      sanitizeLines = sanitizeCopy(dbFile);
    }
    console.log("[measure-core] isolation:");
    console.log(`  HOME           ${SANDBOX_HOME} (sandbox; real HOME not passed)`);
    console.log(`  PATH           ${FAKE_BIN}:${path.dirname(process.execPath)}:/usr/bin:/bin`);
    console.log(`  agents         AGETOR_<KIND>_DRIVER=fake and AGETOR_<KIND>_BIN=stub for ${AGENT_KINDS.join(", ")}`);
    console.log("  keychain       `security` stub (exit 44); usage poller finds no credentials");
    console.log("  tmux           stub (has-session always fails)");
    console.log("  switches       AGETOR_HARNESS_AUTO_ENABLE=0 AGETOR_COPILOT_ACP_PROBE=0");
    console.log(sourcePath
      ? `  source DB      copy sanitized (source untouched): ${sanitizeLines.join("; ") || "nothing to change"}`
      : "  source DB      synthetic");

    core = startCore();
    await waitReady(core, 90_000);

    if (!sourcePath) {
      await seedSynthetic(workdir, opts.tasks);
      // Measure a freshly started core, not one that just did 700 writes.
      await stopCore(core);
      core = startCore();
      await waitReady(core, 90_000);
    }

    // Replay task: a fake run that writes many large subagent transcripts and
    // attaches the real watcher.
    console.log(`[measure-core] starting the replay task (${opts.files} files x ${opts.kb} KB)…`);
    const replayTask = await apiOk<{ id: string }>("POST", "/tasks", {
      title: "bench replay",
      prompt: `__agetor_fake_claude_real_watcher__:${opts.files}x${opts.kb}`,
      workdir,
      isolation: "none",
      agent: "claude-code",
    });
    await apiOk("POST", `/tasks/${replayTask.id}/start`, {});
    const settled = await settleReplayTask(replayTask.id);
    if (!settled) console.warn("[measure-core] replay task did not settle in 180 s; replaying what exists");

    // The measured window starts here; earlier stalls (seed, replay-task run) do not count.
    const outputFrom = core.output.length;
    const coreLogPath = path.join(targetDir, "logs", "core.log");
    const coreLogFrom = existsSync(coreLogPath) ? statSync(coreLogPath).size : 0;

    const health: number[] = [];
    let healthTimeouts = 0;
    const board: number[] = [];
    let boardBytes = 0;
    const replays: ReplayRun[] = [];
    const errors: string[] = [];
    let running = true;
    const endAt = Date.now() + opts.durationS * 1000;
    const startedAt = Date.now();

    const probe = (async () => {
      while (running) {
        const t0 = performance.now();
        try {
          const r = await fetch(`${BASE}/health`, { headers: AUTH, signal: AbortSignal.timeout(10_000) });
          await r.arrayBuffer();
          health.push(performance.now() - t0);
        } catch {
          healthTimeouts++;
          health.push(performance.now() - t0);
        }
        await Bun.sleep(50);
      }
    })();

    const boardPoll = (async () => {
      while (running) {
        const t0 = performance.now();
        try {
          const r = await fetch(`${BASE}/tasks?archived=exclude`, { headers: AUTH, signal: AbortSignal.timeout(60_000) });
          const buf = await r.arrayBuffer();
          if (!r.ok) errors.push(`board poll -> ${r.status}`);
          else { board.push(performance.now() - t0); boardBytes = buf.byteLength; }
        } catch (e) {
          errors.push(`board poll: ${e instanceof Error ? e.message : e}`);
        }
        const wait = 2000 - (performance.now() - t0);
        if (wait > 0) await Bun.sleep(wait);
      }
    })();

    const replayLoop = (async () => {
      while (running) {
        try { replays.push(await replayOnce(replayTask.id)); }
        catch (e) { errors.push(`replay: ${e instanceof Error ? e.message : e}`); }
        await Bun.sleep(3000);
      }
    })();

    let calibrateResult: { injectedMs: number; ok: boolean } | null = null;
    const calibrate = (async () => {
      if (!opts.calibrate) return;
      await Bun.sleep(Math.max(2000, opts.durationS * 400));
      if (!running) return;
      try {
        const r = await api("POST", "/test/block-event-loop", { ms: 1500 }, 30_000);
        if (!r.ok) errors.push(`block-event-loop -> ${r.status}`);
        calibrateResult = { injectedMs: 1500, ok: r.ok };
      } catch (e) {
        errors.push(`block-event-loop: ${e instanceof Error ? e.message : e}`);
      }
    })();

    console.log(`[measure-core] measuring for ${opts.durationS} s…`);
    while (Date.now() < endAt && core.proc.exitCode === null) await Bun.sleep(250);
    running = false;
    await Promise.all([probe, boardPoll, replayLoop, calibrate]);
    const elapsedS = (Date.now() - startedAt) / 1000;
    if (core.proc.exitCode !== null) errors.push(`core exited during the run (code ${core.proc.exitCode})`);

    // Give the lag monitor's last line a moment to flush before reading it.
    await Bun.sleep(500);
    const { stalls, source: stallSource } = await readStalls(core, targetDir, outputFrom, coreLogFrom);

    const taskCount = await apiOk<unknown[]>("GET", "/tasks").then((t) => t.length, () => null);
    const gitSha = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim();
    const dirty = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: REPO_ROOT }).stdout.toString().trim() !== "";

    const healthS = summarize(health);
    const boardS = summarize(board);
    const replayMs = summarize(replays.map((r) => r.ms));
    const byLabel = new Map<string, { count: number; maxS: number }>();
    for (const s of stalls) {
      const e = byLabel.get(s.label) ?? { count: 0, maxS: 0 };
      e.count++;
      e.maxS = Math.max(e.maxS, s.seconds);
      byLabel.set(s.label, e);
    }
    const topLabels = [...byLabel.entries()]
      .sort((a, b) => b[1].maxS - a[1].maxS)
      .slice(0, 8)
      .map(([label, v]) => ({ label, count: v.count, maxS: v.maxS }));
    const maxStallS = stalls.reduce((m, s) => Math.max(m, s.seconds), 0);

    const cal = calibrateResult as { injectedMs: number; ok: boolean } | null;
    const calibration = opts.calibrate
      ? {
          injectedMs: cal?.injectedMs ?? 1500,
          delivered: cal?.ok ?? false,
          detected: (cal?.ok ?? false) && healthS.max >= 1400,
        }
      : null;

    const report = {
      label: opts.label,
      gitSha: dirty ? `${gitSha}+dirty` : gitSha,
      bun: Bun.version,
      dataDir: targetDir,
      source: sourcePath,
      sourceDbBytes: sourceBytes,
      tasksInDb: taskCount ?? countTasks(dbFile),
      durationS: Number(elapsedS.toFixed(1)),
      health: { ...healthS, timeouts: healthTimeouts },
      boardPoll: { ...boardS, bytes: boardBytes },
      replay: { runs: replays.length, p50Ms: replayMs.p50, p95Ms: replayMs.p95, maxMs: replayMs.max, bytes: replays.at(-1)?.bytes ?? 0 },
      stalls: { count: stalls.length, maxS: maxStallS, source: stallSource, topLabels },
      calibration,
      errors,
    };

    printReport(report);
    if (opts.json) {
      await Bun.write(opts.json, JSON.stringify(report, null, 2) + "\n");
      console.log(`[measure-core] wrote ${opts.json}`);
    }
    if (calibration && !calibration.detected) {
      console.error(`[measure-core] CALIBRATION FAILED: injected a 1.5 s block but max /health was ${ms(healthS.max)}`);
      process.exitCode = 1;
    }
  } finally {
    tearingDown = true;
    await stopCore(core);
    if (opts.cleanup) {
      // Only what this run created: the dir itself if the script made it,
      // else just the children added to the pre-existing empty dir.
      try {
        if (createdTarget) rmSync(targetDir, { recursive: true, force: true });
        else for (const name of readdirSync(targetDir)) rmSync(path.join(targetDir, name), { recursive: true, force: true });
        console.log(`[measure-core] removed ${createdTarget ? targetDir : `the contents of ${targetDir}`}`);
      }
      catch (e) { console.warn(`[measure-core] cleanup failed: ${e instanceof Error ? e.message : e}`); }
    } else {
      console.log(`[measure-core] bench dir kept: ${targetDir}`);
    }
  }
}

function printReport(r: {
  label: string; gitSha: string; bun: string; source: string | null; sourceDbBytes: number | null;
  tasksInDb: number | null; durationS: number;
  health: Summary & { timeouts: number };
  boardPoll: Summary & { bytes: number };
  replay: { runs: number; p50Ms: number; p95Ms: number; maxMs: number; bytes: number };
  stalls: { count: number; maxS: number; source: string; topLabels: { label: string; count: number; maxS: number }[] };
  calibration: { injectedMs: number; delivered: boolean; detected: boolean } | null;
  errors: string[];
}): void {
  const rows: [string, string][] = [
    ["label", r.label],
    ["git sha", r.gitSha],
    ["bun", r.bun],
    ["source DB", r.source ? `${r.source} (${(r.sourceDbBytes! / 1048576).toFixed(1)} MB)` : "synthetic"],
    ["tasks in DB", r.tasksInDb === null ? "n/a" : String(r.tasksInDb)],
    ["measured for", `${r.durationS} s`],
    ["", ""],
    ["/health probes", String(r.health.count)],
    ["/health p50", ms(r.health.p50)],
    ["/health p95", ms(r.health.p95)],
    ["/health p99", ms(r.health.p99)],
    ["/health max", ms(r.health.max)],
    ["/health > 1 s", String(r.health.over1s)],
    ["/health > 3 s", String(r.health.over3s)],
    ["/health timeouts", String(r.health.timeouts)],
    ["", ""],
    ["board poll n", String(r.boardPoll.count)],
    ["board poll p50", ms(r.boardPoll.p50)],
    ["board poll p95", ms(r.boardPoll.p95)],
    ["board poll bytes", `${r.boardPoll.bytes} (${(r.boardPoll.bytes / 1024).toFixed(1)} KB)`],
    ["", ""],
    ["replay runs", String(r.replay.runs)],
    ["replay p50 / p95", `${ms(r.replay.p50Ms)} / ${ms(r.replay.p95Ms)}`],
    ["replay bytes", `${r.replay.bytes} (${(r.replay.bytes / 1048576).toFixed(2)} MB)`],
    ["", ""],
    ["stalls logged", `${r.stalls.count} (max ${r.stalls.maxS.toFixed(1)} s; from ${r.stalls.source})`],
    ...r.stalls.topLabels.map((t): [string, string] => ["  stall label", `${t.label}: ${t.count}x, max ${t.maxS.toFixed(1)} s`]),
  ];
  if (r.calibration) {
    rows.push(["", ""], [
      "calibration",
      `${r.calibration.injectedMs} ms block ${r.calibration.delivered ? "delivered" : "NOT delivered"}, ${r.calibration.detected ? "DETECTED (max >= 1.4 s)" : "NOT detected"}`,
    ]);
  }
  if (r.errors.length) {
    rows.push(["", ""], ["errors", `${r.errors.length} (first: ${r.errors[0]})`]);
  }
  const w = Math.max(...rows.map(([k]) => k.length));
  console.log("\n=== core responsiveness ===");
  for (const [k, v] of rows) console.log(k === "" && v === "" ? "" : `${k.padEnd(w)}  ${v}`);
  console.log("");
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  async (e) => {
    console.error(`[measure-core] failed: ${e instanceof Error ? e.stack ?? e.message : e}`);
    await teardownAndExit(1);
  },
);

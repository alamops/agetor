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
//   --data-dir   override the bench dir (must not be under ~/.agetor)
//
// Safety: nothing under the real ~/.agetor is ever read or written. The target
// dir is checked before anything is created. The source DB is only opened
// read-only, through `sqlite3 -readonly … .backup`, never `cp` (which would
// break WAL consistency). A Ctrl-C mid-run still stops the child core.

import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
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
const HOME = homedir();
const REAL_DIR = realpathLoose(path.join(HOME, ".agetor"));
const BENCH_BASE = path.join(HOME, ".agetor-dev");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const targetDir = realpathLoose(opts.dataDir ?? path.join(BENCH_BASE, `bench-${stamp}`));

if (isInsideOrEqual(REAL_DIR, targetDir)) {
  fail(`refusing: ${targetDir} is inside the real data dir ${REAL_DIR}`);
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
const AUTH = { Authorization: `Bearer ${TOKEN}` };

interface Core {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  output: string[];
}
let core: Core | null = null;
let tearingDown = false;

function startCore(): Core {
  // An explicit env: nothing of the caller's AGETOR_* (the real master token
  // included) leaks in, and the token below is random and used for this run only.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    AGETOR_DATA_DIR: targetDir,
    AGETOR_API_PORT: String(opts.port),
    AGETOR_API_TOKEN: TOKEN,
    AGETOR_DAEMON_IDLE_MS: "0",
    AGETOR_HEADLESS_NOTIFICATIONS: "0",
    AGETOR_HARNESS_AUTO_ENABLE: "0",
    AGETOR_CLAUDE_DRIVER: "fake",
    AGETOR_CLAUDE_BIN: "/bin/echo",
    AGETOR_CLAUDE_ARGS: "",
    AGETOR_TMUX_BIN: "/bin/echo",
    AGETOR_LAG_MONITOR: "1",
    AGETOR_CORE_LOG: "1",
    ...(opts.calibrate ? { AGETOR_TEST_BLOCK_ROUTE: "1" } : {}),
  };
  const proc = Bun.spawn(["bun", "src/bun/headless.ts"], {
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
  if (existsSync(targetDir) && statSync(targetDir).isDirectory() && !opts.dataDir) {
    fail(`${targetDir} already exists`);
  }
  mkdirSync(targetDir, { recursive: true });
  const workdir = path.join(targetDir, "workdir");
  mkdirSync(workdir, { recursive: true });
  const dbFile = path.join(targetDir, "agetor.sqlite");

  try {
    const alive = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
    if (alive) fail(`something already answers on ${BASE}; pick another --port`);

    let sourceBytes: number | null = null;
    if (sourcePath) {
      console.log(`[measure-core] copying ${sourcePath} with SQLite's online backup…`);
      sourceBytes = statSync(sourcePath).size;
      copySource(sourcePath, dbFile);
    }

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
      try { rmSync(targetDir, { recursive: true, force: true }); console.log(`[measure-core] removed ${targetDir}`); }
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

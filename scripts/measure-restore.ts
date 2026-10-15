// Real-data measurement for the non-blocking session restore work
// (docs/plans/non-blocking-session-restore.md, task T14 / decision J).
//
// Attaches the REAL subagent watcher (timer mode, exactly as the claude spawn /
// reattach path does) to a task of a COPY of the production database, with a
// 5 ms event-loop sampler running, and reports how long the main thread was
// blocked, how long `ready` / `settled` took, what the seed queries cost, what
// the first archived-history retention pass costs, and how long VACUUM takes.
// The numbers go into §10 of the plan. claude is never launched and nothing
// under ~/.agetor is read or written: the copy lives in ~/.agetor-dev.
//
// ── Procedure (run by hand) ─────────────────────────────────────────────────
//   1. Quit any dev app / headless core using ~/.agetor-dev (the script refuses
//      nothing about that, but a live core would fight over the copy).
//   2. Move the dev DB aside and take a consistent copy of the production DB
//      (`.backup` is read-only on the source and WAL-safe):
//        mv ~/.agetor-dev/agetor.sqlite ~/.agetor-dev/agetor.sqlite.pre-measure
//        mv ~/.agetor-dev/agetor.sqlite-wal ~/.agetor-dev/agetor.sqlite-wal.pre-measure   # if present
//        mv ~/.agetor-dev/agetor.sqlite-shm ~/.agetor-dev/agetor.sqlite-shm.pre-measure   # if present
//        sqlite3 ~/.agetor/agetor.sqlite ".backup ~/.agetor-dev/agetor.sqlite"
//   3. Find the tasks worth measuring (top 10 by subagent count):
//        AGETOR_DATA_DIR=~/.agetor-dev bun scripts/measure-restore.ts --list-heavy
//      then run once per task (the retention pass and VACUUM mutate the copy,
//      so measure the tasks FIRST with `--no-retention`, then do one full run):
//        AGETOR_DATA_DIR=$HOME/.agetor-dev bun scripts/measure-restore.ts <208-subagent-task> --no-retention
//        AGETOR_DATA_DIR=$HOME/.agetor-dev bun scripts/measure-restore.ts <96-subagent-task>  --no-retention
//        AGETOR_DATA_DIR=$HOME/.agetor-dev bun scripts/measure-restore.ts <208-subagent-task> --vacuum
//      (`--retention-days N` overrides the default 30; `--json` prints a
//      machine-readable object on stdout and moves the human table to stderr.)
//   4. Restore the dev DB (delete the copy and its sidecars first):
//        rm -f ~/.agetor-dev/agetor.sqlite ~/.agetor-dev/agetor.sqlite-wal ~/.agetor-dev/agetor.sqlite-shm
//        mv ~/.agetor-dev/agetor.sqlite.pre-measure ~/.agetor-dev/agetor.sqlite
//        mv ~/.agetor-dev/agetor.sqlite-wal.pre-measure ~/.agetor-dev/agetor.sqlite-wal   # if it existed
//        mv ~/.agetor-dev/agetor.sqlite-shm.pre-measure ~/.agetor-dev/agetor.sqlite-shm   # if it existed
//
// Usage:
//   AGETOR_DATA_DIR=<dir> bun scripts/measure-restore.ts <taskId> [<taskId>…]
//       [--retention-days N] [--no-retention] [--vacuum] [--json]
//   AGETOR_DATA_DIR=<dir> bun scripts/measure-restore.ts --list-heavy
//
// Side effects on the COPY (by design): the watcher in timer mode INSERTs run
// events for transcript lines that were never persisted (reported as "rows
// added"), the retention pass trims tool_result payloads of long-archived
// tasks, and `--vacuum` rewrites the file. A task id may be a unique prefix.
//
// The safety checks below run BEFORE anything imports `db.ts` (which opens —
// and migrates — whatever AGETOR_DATA_DIR points at on module load).

import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// ── Safety: refuse the production data dir ───────────────────────────────────

/** True when `candidate` equals `root` or lies inside it. Compares path
 *  SEGMENTS via `path.relative`, never string prefixes, so `~/.agetor-dev` is
 *  not mistaken for being inside `~/.agetor`. */
function isInsideOrEqual(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function refuse(message: string): never {
  console.error(`[measure-restore] refusing: ${message}`);
  process.exit(2);
}

const rawDataDir = process.env.AGETOR_DATA_DIR;
if (!rawDataDir || rawDataDir.trim() === "") {
  refuse(
    "AGETOR_DATA_DIR is required (point it at ~/.agetor-dev holding a `.backup` copy of the production DB — see the header of this file)",
  );
}
const prodLexical = path.resolve(homedir(), ".agetor");
const prodReal = realpathOr(prodLexical);
const dataLexical = path.resolve(rawDataDir);
const dataReal = realpathOr(dataLexical);
for (const prod of new Set([prodLexical, prodReal])) {
  for (const cand of new Set([dataLexical, dataReal])) {
    if (isInsideOrEqual(prod, cand)) {
      refuse(`AGETOR_DATA_DIR (${rawDataDir}) is or is inside the production data dir ${prodLexical}`);
    }
  }
}
const sqlitePath = path.join(dataReal, "agetor.sqlite");
if (!existsSync(sqlitePath)) {
  refuse(`no agetor.sqlite in ${dataReal} — restore the .backup copy there first (see the header of this file)`);
}
// A symlinked agetor.sqlite could still lead into the production dir.
const sqliteReal = realpathOr(sqlitePath);
for (const prod of new Set([prodLexical, prodReal])) {
  if (isInsideOrEqual(prod, sqliteReal)) {
    refuse(`${sqlitePath} resolves into the production data dir (${sqliteReal})`);
  }
}
// Normalise so db.ts opens exactly the directory we verified.
process.env.AGETOR_DATA_DIR = dataReal;

// Measure production defaults: the watcher must be on (the repo's test seams
// set these to "0"), and this script runs its own sampler so the built-in lag
// monitor stays off.
for (const k of [
  "AGETOR_TRACK_SUBAGENTS",
  "AGETOR_TRACK_WORKFLOWS",
  "AGETOR_TRACK_BG_SHELLS",
  "AGETOR_TRACK_MONITORS",
]) {
  if (process.env[k] === "0") delete process.env[k];
}
process.env.AGETOR_LAG_MONITOR = "0";

// ── Args ─────────────────────────────────────────────────────────────────────

interface Args {
  taskIds: string[];
  listHeavy: boolean;
  retention: boolean;
  retentionDays: number;
  vacuum: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { taskIds: [], listHeavy: false, retention: true, retentionDays: 30, vacuum: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--list-heavy") out.listHeavy = true;
    else if (a === "--no-retention") out.retention = false;
    else if (a === "--vacuum") out.vacuum = true;
    else if (a === "--json") out.json = true;
    else if (a === "--retention-days" || a.startsWith("--retention-days=")) {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
      const n = Number(v);
      if (v === undefined || v.trim() === "" || !Number.isFinite(n) || n < 0) {
        refuse(`--retention-days needs a non-negative number (got ${JSON.stringify(v)})`);
      }
      out.retentionDays = n;
    } else if (a.startsWith("-")) refuse(`unknown flag ${a}`);
    else out.taskIds.push(a);
  }
  if (!out.listHeavy && out.taskIds.length === 0) {
    refuse("usage: bun scripts/measure-restore.ts <taskId> [<taskId>…] [--retention-days N] [--no-retention] [--vacuum] [--json]  |  --list-heavy");
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// ── Now it is safe to open the database ──────────────────────────────────────

const { db, dataDir, tasks, runs, subagents, harnesses } = await import("../src/bun/db.ts");
const { attachSubagentWatcher, detachWatcherFor } = await import("../src/bun/claude-subagents.ts");
const { jsonlPathFor } = await import("../src/bun/claude-tmux.ts");
const { runArchivedHistoryRetentionPass, dbStats, compactDatabase, stopRetentionTimers } = await import(
  "../src/bun/retention.ts"
);
const { DB_COMPACT_SEC_PER_GB, RETENTION_TRIM_BYTES } = await import("../src/shared/types.ts");

/** Mirrors `FAST_POLL_MS` in src/bun/claude-subagents.ts (module-private): the
 *  production watcher pauses this long between `ready` and its first cycle, so
 *  the first pass duration is `settled − (ready + beat)`. */
const FAST_POLL_MS = 600;
const DAY_MS = 86_400_000;
const SAMPLE_MS = 5;

// ── Output plumbing ──────────────────────────────────────────────────────────

/** Human output goes to stdout, or to stderr under --json so stdout stays one
 *  parseable document. */
const say = (line = ""): void => {
  (args.json ? console.error : console.log)(line);
};
const progress = (line: string): void => {
  console.error(`[measure-restore] ${line}`);
};
const r1 = (n: number): number => Math.round(n * 10) / 10;
const mb = (bytes: number): string => (bytes / 1e6).toFixed(1);
function printable(s: string, max = 60): string {
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// ── Event-loop sampler ───────────────────────────────────────────────────────

const GAP_BUCKETS: Array<{ label: string; min: number }> = [
  { label: "50-100ms", min: 50 },
  { label: "100-250ms", min: 100 },
  { label: "250-500ms", min: 250 },
  { label: "500-1000ms", min: 500 },
  { label: "1-2.5s", min: 1000 },
  { label: ">2.5s", min: 2500 },
];

interface SamplerResult {
  maxGapMs: number;
  histogram: Record<string, number>;
}

class Sampler {
  private last = performance.now();
  private max = 0;
  private lapMax = 0;
  private hist: number[] = GAP_BUCKETS.map(() => 0);
  private timer: ReturnType<typeof setInterval>;

  constructor() {
    this.timer = setInterval(() => this.tick(), SAMPLE_MS);
  }

  private record(gap: number): void {
    if (gap > this.max) this.max = gap;
    if (gap > this.lapMax) this.lapMax = gap;
    if (gap > 50) {
      let idx = 0;
      for (let i = 0; i < GAP_BUCKETS.length; i++) if (gap >= GAP_BUCKETS[i]!.min) idx = i;
      this.hist[idx]!++;
    }
  }

  private tick(): void {
    const now = performance.now();
    this.record(now - this.last);
    this.last = now;
  }

  /** Max gap since the previous `lap()` (or construction). Counts the still
   *  open interval since the last tick, so a block that ends exactly as the
   *  caller resumes is not lost. */
  lap(): number {
    const open = performance.now() - this.last;
    if (open > this.lapMax) this.lapMax = open;
    const v = this.lapMax;
    this.lapMax = 0;
    return v;
  }

  stop(): SamplerResult {
    clearInterval(this.timer);
    const now = performance.now();
    this.record(now - this.last);
    const histogram: Record<string, number> = {};
    GAP_BUCKETS.forEach((b, i) => (histogram[b.label] = this.hist[i]!));
    return { maxGapMs: this.max, histogram };
  }
}

function histLine(h: Record<string, number>): string {
  const parts = Object.entries(h).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`);
  return parts.length > 0 ? parts.join("  ") : "(no gaps > 50 ms)";
}

// ── --list-heavy ─────────────────────────────────────────────────────────────

if (args.listHeavy) {
  const rows = db
    .query<{ task_id: string; n: number; title: string | null; archived_at: number | null }, []>(
      `SELECT s.task_id AS task_id, COUNT(*) AS n, t.title AS title, t.archived_at AS archived_at
       FROM subagents s JOIN tasks t ON t.id = s.task_id
       GROUP BY s.task_id ORDER BY n DESC, s.task_id LIMIT 10`,
    )
    .all();
  console.log(`data dir: ${dataDir}`);
  console.log("subagents  archived  task id                               title");
  for (const r of rows) {
    console.log(
      `${String(r.n).padStart(9)}  ${(r.archived_at !== null ? "yes" : "no").padEnd(8)}  ${r.task_id}  ${printable(r.title ?? "")}`,
    );
  }
  if (rows.length === 0) console.log("(no subagent rows in this database)");
  process.exit(0);
}

// ── Per-task measurement ─────────────────────────────────────────────────────

interface TaskMeasurement {
  taskId: string;
  title: string;
  archived: boolean;
  runId: string | null;
  claudeSessionId: string | null;
  cwd: string;
  jsonlPath: string | null;
  jsonlExists: boolean;
  jsonlMB: number;
  subagentRows: number;
  rowsByKind: Record<string, number>;
  transcriptFiles: number;
  transcriptMB: number;
  seedQueries: { totalMs: number; worstRowMs: number; worstRowId: string | null; rows: number };
  attach: {
    readyMs: number;
    settledMs: number;
    firstPassMs: number;
    seedMaxBlockMs: number;
    firstPassMaxBlockMs: number;
    maxBlockMs: number;
    histogram: Record<string, number>;
  };
  eventRowsAdded: number;
  notes: string[];
}

function resolveTaskId(input: string): string {
  const exact = tasks.get(input);
  if (exact) return exact.id;
  const matches = db
    .query<{ id: string }, [string]>(`SELECT id FROM tasks WHERE id LIKE ? ESCAPE '\\' LIMIT 5`)
    .all(`${input.replace(/[\\%_]/g, "\\$&")}%`);
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) refuse(`no task with id/prefix ${JSON.stringify(input)}`);
  refuse(`ambiguous task prefix ${JSON.stringify(input)}: ${matches.map((m) => m.id).join(", ")}`);
}

function maxEventId(): number {
  return db.query<{ m: number | null }, []>(`SELECT MAX(id) AS m FROM run_events`).get()?.m ?? 0;
}

async function measureTask(rawId: string): Promise<TaskMeasurement> {
  const taskId = resolveTaskId(rawId);
  const task = tasks.get(taskId)!;
  const notes: string[] = [];
  const cwd = task.worktreePath ?? task.workdir;

  // Latest claude run that recorded a session id (runs are newest first).
  const run = runs.listForTask(taskId).find((r) => r.claudeSessionId) ?? null;
  const harness = harnesses.getByIdOrKind(task.agent);
  let jsonlPath: string | null = null;
  let jsonlExists = false;
  let jsonlBytes = 0;
  if (run?.claudeSessionId) {
    // Same derivation the orchestrator's reattach paths use (`jsonlPathFor` in
    // claude-tmux.ts, configDir = the harness `home`).
    jsonlPath = jsonlPathFor(cwd, run.claudeSessionId, harness?.home ?? null);
    try {
      jsonlBytes = statSync(jsonlPath).size;
      jsonlExists = true;
    } catch {
      notes.push(`session JSONL missing on disk (${jsonlPath}) — the watcher tolerates this; main-JSONL scan work is skipped`);
    }
  } else {
    notes.push("task has no run with a claude_session_id — nothing to attach to");
  }

  const rows = subagents.listForTask(taskId);
  const rowsByKind: Record<string, number> = {};
  let transcriptFiles = 0;
  let transcriptBytes = 0;
  for (const s of rows) {
    rowsByKind[s.parentKind] = (rowsByKind[s.parentKind] ?? 0) + 1;
    try {
      const st = statSync(s.sourcePath);
      if (st.isFile()) {
        transcriptFiles++;
        transcriptBytes += st.size;
      }
    } catch {
      // A missing transcript is normal (monitors/bg shells have none; old
      // subagents may have been cleaned up by claude).
    }
  }

  // Phase A — the seed queries the watcher runs per row, timed directly. This is
  // the cost the OLD synchronous attach paid in one block; it runs before the
  // attach below so the attach sees a warm page cache (like a second restore).
  let seedTotalMs = 0;
  let worstMs = 0;
  let worstId: string | null = null;
  for (const s of rows) {
    const t0 = performance.now();
    runs.seenLineUuidsForSubagent(taskId, s.id);
    if (s.parentKind === "monitor") runs.hasLineUuidPrefixForSubagent(taskId, s.id, `monitor:${s.id}:terminal:`);
    const dt = performance.now() - t0;
    seedTotalMs += dt;
    if (dt > worstMs) {
      worstMs = dt;
      worstId = s.id;
    }
  }

  // Phase B — the real watcher, timer mode, under the 5 ms sampler.
  const before = maxEventId();
  let attach: TaskMeasurement["attach"] = {
    readyMs: 0, settledMs: 0, firstPassMs: 0, seedMaxBlockMs: 0, firstPassMaxBlockMs: 0, maxBlockMs: 0, histogram: {},
  };
  if (jsonlPath && run) {
    const sampler = new Sampler();
    const t0 = performance.now();
    const handle = attachSubagentWatcher({ taskId, runId: run.id, jsonlPath });
    const afterSyncAttach = sampler.lap(); // the synchronous part of attach itself
    await handle.ready;
    const readyAt = performance.now();
    const seedMax = Math.max(afterSyncAttach, sampler.lap());
    await handle.settled;
    const settledAt = performance.now();
    const firstPassMax = sampler.lap();
    handle.detach();
    detachWatcherFor(taskId);
    const result = sampler.stop();
    const readyMs = readyAt - t0;
    const settledMs = settledAt - t0;
    attach = {
      readyMs: r1(readyMs),
      settledMs: r1(settledMs),
      firstPassMs: r1(Math.max(0, settledMs - (readyMs + FAST_POLL_MS))),
      seedMaxBlockMs: r1(seedMax),
      firstPassMaxBlockMs: r1(firstPassMax),
      maxBlockMs: r1(result.maxGapMs),
      histogram: result.histogram,
    };
  }

  return {
    taskId,
    title: task.title,
    archived: task.archivedAt != null,
    runId: run?.id ?? null,
    claudeSessionId: run?.claudeSessionId ?? null,
    cwd,
    jsonlPath,
    jsonlExists,
    jsonlMB: r1(jsonlBytes / 1e6),
    subagentRows: rows.length,
    rowsByKind,
    transcriptFiles,
    transcriptMB: r1(transcriptBytes / 1e6),
    seedQueries: { totalMs: r1(seedTotalMs), worstRowMs: r1(worstMs), worstRowId: worstId, rows: rows.length },
    attach,
    eventRowsAdded: Math.max(0, maxEventId() - before),
    notes,
  };
}

function printTask(m: TaskMeasurement): void {
  say(`── task ${m.taskId}  ${printable(m.title)}${m.archived ? "  [archived]" : ""}`);
  say(`   cwd            ${m.cwd}`);
  say(`   session jsonl  ${m.jsonlPath ?? "(none)"}  ${m.jsonlExists ? `${m.jsonlMB} MB` : "(missing)"}`);
  const kinds = Object.entries(m.rowsByKind).map(([k, n]) => `${k}:${n}`).join(" ");
  say(`   subagent rows  ${m.subagentRows}  (${kinds || "none"})   transcript files ${m.transcriptFiles}  ${m.transcriptMB} MB`);
  say(`   Seed (direct queries)          total ${m.seedQueries.totalMs} ms / worst row ${m.seedQueries.worstRowMs} ms${m.seedQueries.worstRowId ? ` (${m.seedQueries.worstRowId})` : ""}`);
  if (m.jsonlPath) {
    say(`   ready latency after attach     ${m.attach.readyMs} ms   (max block during seed ${m.attach.seedMaxBlockMs} ms)`);
    say(`   First-pass replay              ${m.attach.firstPassMs} ms  [settled ${m.attach.settledMs} ms raw − (ready + ${FAST_POLL_MS} ms beat)] / max block ${m.attach.firstPassMaxBlockMs} ms`);
    say(`   Max main-thread block (attach) ${m.attach.maxBlockMs} ms   gaps: ${histLine(m.attach.histogram)}`);
    say(`   event rows added to the copy   ${m.eventRowsAdded}`);
  }
  for (const n of m.notes) say(`   note: ${n}`);
  say();
}

// ── Retention ────────────────────────────────────────────────────────────────

interface RetentionMeasurement {
  days: number;
  candidateTasks: number;
  candidateRuns: number;
  candidateRows: number;
  candidateMB: number;
  maxLengthData: number;
  scanMs: number;
  pass: {
    trimmedRows: number;
    freedMB: number;
    durationMs: number;
    maxBlockMs: number;
    histogram: Record<string, number>;
    scannedTasks: number;
    scannedRuns: number;
    aborted: boolean;
  };
}

async function measureRetention(days: number): Promise<RetentionMeasurement> {
  const cutoff = Date.now() - days * DAY_MS;
  const archived = tasks.archivedBefore(cutoff);
  progress(`retention: ${archived.length} task(s) archived ≥ ${days} d — scanning their tool_result rows (may take a while on a large DB)…`);
  const agg = db.query<{ n: number; bytes: number; maxb: number }, [string, number]>(
    // Same predicates as TOOL_RESULT_TRIM_SQL (db.ts), aggregated per run so the
    // scan walks the idx_run_events_run prefix like the pass itself does.
    `SELECT COUNT(*) AS n,
            IFNULL(SUM(LENGTH(CAST(data AS BLOB))), 0) AS bytes,
            IFNULL(MAX(LENGTH(CAST(data AS BLOB))), 0) AS maxb
     FROM run_events
     WHERE run_id = ? AND stream = 'tool_result' AND LENGTH(CAST(data AS BLOB)) > ?
       AND substr(data, 1, 13) != '{"retention":'`,
  );
  let candRuns = 0;
  let candRows = 0;
  let candBytes = 0;
  let maxLen = 0;
  const scanStart = performance.now();
  let i = 0;
  for (const t of archived) {
    i++;
    for (const runId of runs.runIdsForTask(t.id)) {
      candRuns++;
      const r = agg.get(runId, RETENTION_TRIM_BYTES);
      if (!r) continue;
      candRows += r.n;
      candBytes += r.bytes;
      if (r.maxb > maxLen) maxLen = r.maxb;
    }
    if (i % 25 === 0 || i === archived.length) {
      progress(`retention scan: ${i}/${archived.length} tasks, ${candRows} candidate rows so far (${mb(candBytes)} MB)`);
    }
  }
  const scanMs = performance.now() - scanStart;

  progress(`retention: running runArchivedHistoryRetentionPass({ days: ${days} }) under the 5 ms sampler…`);
  const sampler = new Sampler();
  const result = await runArchivedHistoryRetentionPass({ days });
  const s = sampler.stop();
  return {
    days,
    candidateTasks: archived.length,
    candidateRuns: candRuns,
    candidateRows: candRows,
    candidateMB: r1(candBytes / 1e6),
    maxLengthData: maxLen,
    scanMs: Math.round(scanMs),
    pass: {
      trimmedRows: result.trimmedRows,
      freedMB: r1(result.freedBytes / 1e6),
      durationMs: result.durationMs,
      maxBlockMs: r1(s.maxGapMs),
      histogram: s.histogram,
      scannedTasks: result.scannedTasks,
      scannedRuns: result.scannedRuns,
      aborted: result.aborted,
    },
  };
}

function printRetention(m: RetentionMeasurement): void {
  say(`── first retention pass (${m.days} d)`);
  say(`   candidates      ${m.candidateRows} rows / ${m.candidateMB} MB across ${m.candidateTasks} archived task(s), ${m.candidateRuns} run(s)  (scan ${m.scanMs} ms)`);
  say(`   MAX(LENGTH(data)) among candidates  ${m.maxLengthData} bytes (${mb(m.maxLengthData)} MB) — the single-row JSON.parse residual block`);
  say(`   pass            ${m.pass.trimmedRows} rows / ${m.pass.freedMB} MB freed / ${m.pass.durationMs} ms / max block ${m.pass.maxBlockMs} ms${m.pass.aborted ? "  [ABORTED]" : ""}`);
  say(`   gaps            ${histLine(m.pass.histogram)}`);
  say();
}

// ── Page stats / VACUUM ──────────────────────────────────────────────────────

function pragma(name: string): number {
  const row = db.query<Record<string, number>, []>(`PRAGMA ${name}`).get();
  return row ? Number(Object.values(row)[0] ?? 0) : 0;
}

interface PageStats {
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  liveBytes: number;
  fileBytes: number;
  compactEstimateSec: number;
}

function pageStats(): PageStats {
  const pageSize = pragma("page_size");
  const pageCount = pragma("page_count");
  const freelistCount = pragma("freelist_count");
  const stats = dbStats(0);
  return {
    pageSize,
    pageCount,
    freelistCount,
    liveBytes: Math.max(0, pageCount - freelistCount) * pageSize,
    fileBytes: stats.fileBytes,
    compactEstimateSec: stats.compactEstimateSec,
  };
}

interface CompactMeasurement {
  beforeBytes: number;
  afterBytes: number;
  durationMs: number;
  liveGB: number;
  measuredSecPerGB: number;
  configuredSecPerGB: number;
  deviationPct: number;
}

function measureCompact(before: PageStats): CompactMeasurement {
  progress("vacuum: running compactDatabase() — the process blocks until it finishes…");
  const r = compactDatabase();
  const liveGB = before.liveBytes / 1e9;
  const measured = liveGB > 0 ? r.durationMs / 1000 / liveGB : 0;
  return {
    beforeBytes: r.beforeBytes,
    afterBytes: r.afterBytes,
    durationMs: r.durationMs,
    liveGB: Math.round(liveGB * 1000) / 1000,
    measuredSecPerGB: Math.round(measured * 100) / 100,
    configuredSecPerGB: DB_COMPACT_SEC_PER_GB,
    deviationPct: DB_COMPACT_SEC_PER_GB > 0 ? Math.round(((measured - DB_COMPACT_SEC_PER_GB) / DB_COMPACT_SEC_PER_GB) * 1000) / 10 : 0,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

say(`data dir: ${dataDir}`);
say();
const taskResults: TaskMeasurement[] = [];
for (const id of args.taskIds) {
  progress(`measuring task ${id}…`);
  const m = await measureTask(id);
  taskResults.push(m);
  printTask(m);
}

let retention: RetentionMeasurement | null = null;
if (args.retention) {
  retention = await measureRetention(args.retentionDays);
  printRetention(retention);
}

const pagesBefore = pageStats();
say("── database pages");
say(
  `   page_size ${pagesBefore.pageSize}  page_count ${pagesBefore.pageCount}  freelist_count ${pagesBefore.freelistCount}` +
    `  file ${mb(pagesBefore.fileBytes)} MB  live ${mb(pagesBefore.liveBytes)} MB`,
);
say(`   dbStats(0).compactEstimateSec ${pagesBefore.compactEstimateSec} s  (DB_COMPACT_SEC_PER_GB = ${DB_COMPACT_SEC_PER_GB})`);

let compact: CompactMeasurement | null = null;
let pagesAfter: PageStats | null = null;
if (args.vacuum) {
  compact = measureCompact(pagesBefore);
  pagesAfter = pageStats();
  say(
    `   VACUUM measured ${(compact.durationMs / 1000).toFixed(1)} s over ${compact.liveGB} GB live = ${compact.measuredSecPerGB} s/GB` +
      ` vs ${compact.configuredSecPerGB} s/GB configured (${compact.deviationPct >= 0 ? "+" : ""}${compact.deviationPct} %)` +
      `${compact.liveGB < 0.1 ? "  (database too small to calibrate against)" : Math.abs(compact.deviationPct) > 25 ? "  → re-calibrate DB_COMPACT_SEC_PER_GB (> 25 % off)" : ""}`,
  );
  say(`   size ${mb(compact.beforeBytes)} MB → ${mb(compact.afterBytes)} MB (file + wal)   page_count ${pagesAfter.pageCount}  freelist_count ${pagesAfter.freelistCount}`);
} else {
  say("   (pass --vacuum to time compactDatabase())");
}
say();

if (args.json) {
  console.log(
    JSON.stringify(
      {
        dataDir,
        sampleMs: SAMPLE_MS,
        firstCycleBeatMs: FAST_POLL_MS,
        tasks: taskResults,
        retention,
        pages: pagesBefore,
        compact,
        pagesAfterCompact: pagesAfter,
      },
      null,
      2,
    ),
  );
}

stopRetentionTimers();
process.exit(0);

/**
 * Archived-history retention: the trim pass, its scheduler, the database
 * stats behind Settings → General, and the manual "Compact database" action
 * (docs/plans/non-blocking-session-restore.md, decisions F/G/H, §2.6, §8
 * A3/A9).
 *
 * ## What is trimmed
 *
 * On a long-lived database `tool_result` events are ~76 % of
 * `run_events.data` (multi-MB file reads, command output, base64 images) and
 * almost all of it is dead weight once a task has been archived for a month.
 * A pass therefore walks every task archived at least N days ago (the
 * `archivedHistoryRetentionDays` preference, default 30, `"off"` disables;
 * `AGETOR_ARCHIVED_HISTORY_RETENTION=0` is the env kill switch), oldest first,
 * and rewrites each of its `stream = 'tool_result'` rows whose payload is
 * larger than {@link RETENTION_TRIM_BYTES} (4 KB) in place with
 * `trimToolResultData` (`src/shared/tool-result-trim.ts`). Live tasks, recently
 * archived tasks and every other stream (`tool_use`, `assistant`, `user`, …)
 * are never touched. Subagent transcripts are included: they are rows of the
 * same table under the same run id.
 *
 * ## Payload shape, idempotency, crash resume
 *
 * A trimmed payload stays valid JSON in the same envelope with a `retention`
 * marker as its FIRST key (`{"retention":{"trimmed":true,"originalBytes":N,
 * "trimmedAt":ms},"toolUseId":…,"content":<trimmed>,…}`). The candidate query
 * ({@link TOOL_RESULT_TRIM_SQL}) carries a `substr(data, 1, 13) !=
 * '{"retention":'` prefilter, so already-trimmed rows are skipped by SQLite
 * without being read or parsed. That one predicate is the whole idempotency
 * and crash-resume argument: a pass killed mid-way (or aborted by shutdown)
 * leaves every committed chunk trimmed and every other row untouched, and the
 * next pass simply finds the remainder. A row the prefilter cannot exclude
 * but `trimToolResultData` declines (not JSON, content already within budget
 * though the envelope is large) is re-read by every pass — accepted; the loop
 * still advances through the keyset (`id > afterId`) so it always terminates.
 *
 * The trim is ONE-WAY: the dropped bytes exist nowhere else (Claude's session
 * JSONL may still hold them, which is what "Rebuild from session JSONL"
 * re-derives, but 83 % of archived transcripts are already gone from disk).
 * `id`, `ts`, `stream`, `line_uuid`, `run_id` and `subagent_id` are never
 * modified, so the `(run_id, IFNULL(subagent_id,''), line_uuid)` dedup index
 * still recognises every row and unarchive + resume never re-imports one;
 * `toolUseId`/`isError`/`attachments` survive, so the sent-files and TODO
 * parsers keep working.
 *
 * ## Cooperative scheduling
 *
 * bun:sqlite is synchronous, so a pass must not hog the event loop. Work runs
 * in slices of at most `sliceMs` (20 ms): the slice clock is checked after
 * every row parse and every chunk write, and when it has run out the pass
 * yields with `setImmediate`. Each slice is wrapped in
 * `beginLagLabel("archived-history retention")` (disposed before yielding) so
 * the lag monitor attributes any stall. Chunks are keyed by id per run, hold
 * at most 200 rows and flush a write transaction every ~2 MB of input data;
 * the number of rows fetched per query shrinks automatically when rows are
 * huge. A single row's `JSON.parse` cannot be interrupted — that residual is
 * what plan §8 A3 / §10 measure. Because the pass yields, a task can be
 * unarchived (a message sent to it, the Unarchive button) while it is
 * mid-way through that task: every chunk's write transaction therefore
 * re-reads the task's `archived_at` INSIDE the same synchronous transaction
 * and drops the chunk — and moves on to the next task — when the task is no
 * longer archived past the cutoff, so a task that came back to life is never
 * trimmed after the fact.
 *
 * ## Compact
 *
 * {@link compactDatabase} runs `VACUUM` + `wal_checkpoint(TRUNCATE)` on the
 * shared connection. VACUUM is a single synchronous call that blocks the whole
 * core (every request, every SSE stream) for its full duration — roughly
 * {@link DB_COMPACT_SEC_PER_GB} s per GB of live data. That is owner-accepted
 * (plan §2.6); the route that calls it refuses while any run is active and the
 * UI shows a blocking modal with the estimate.
 *
 * ## SQL covered by the plan guard
 *
 * Every statement against `run_events` that this module issues goes through a
 * `runs.*` helper in `db.ts`; the one that is an exported constant is
 * {@link TOOL_RESULT_TRIM_SQL}, listed in {@link RETENTION_SQL}. The remaining
 * helpers (`runs.replaceEventData` — a primary-key UPDATE;
 * `runs.runIdsForTask`, `tasks.archivedBefore` — `runs`/`tasks` only) are
 * inline in `db.ts` and are covered by the plan-guard test's method sweep.
 *
 * This module must not import `orchestrator.ts` (circularity): the server
 * passes `activeRunCount` into {@link dbStats}.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  ARCHIVED_HISTORY_RETENTION_PREF,
  DB_COMPACT_SEC_PER_GB,
  RETENTION_TRIM_BYTES,
  parseArchivedHistoryRetentionDays,
  type DbStats,
  type RetentionPassResult,
} from "../shared/types";
import { trimToolResultData, utf8Length } from "../shared/tool-result-trim";
import { TOOL_RESULT_TRIM_SQL, dataDir, db, preferences, runs, tasks } from "./db";
import { beginLagLabel } from "./event-loop-lag";

/** Every SQL text this module itself runs against `run_events` (see the
 *  "SQL covered by the plan guard" note above for the rest). */
export const RETENTION_SQL: readonly string[] = [TOOL_RESULT_TRIM_SQL];

const DAY_MS = 86_400_000;
/** Rows fetched per keyset page — the upper bound. */
const CHUNK_ROWS = 200;
/** Rows in the pass's FIRST page fetch, before any row size is known. */
const INITIAL_PAGE_ROWS = 8;
/** A write transaction is flushed once this much input data has been
 *  accumulated (~2 MB of characters). */
const CHUNK_INPUT_BYTES = 2 * 1024 * 1024;
/** Characters a single page fetch aims to materialize. `.all()` reads every
 *  row of a page in one synchronous call, so the page — not the per-row
 *  parse — is the biggest indivisible unit of work: measured on the owner's
 *  4.5 GB copy, a fixed 200-row page of multi-hundred-KB tool results held
 *  the thread for 130 ms. The next page's row count is sized from the
 *  average row of the previous one (carried across runs and tasks, since
 *  archived tool output tends to stay the same size), clamped to
 *  1..{@link CHUNK_ROWS}. */
const TARGET_PAGE_CHARS = 2 * 1024 * 1024;

const DEFAULT_BOOT_DELAY_MS = 90_000;
const DEFAULT_INTERVAL_MS = DAY_MS;
const DEFAULT_DEBOUNCE_MS = 5_000;

/** Bytes per GB used by {@link dbStats}'s Compact estimate. Decimal (1e9) to
 *  match how the plan measured ≈ 7.3 s/GB for the 4.2 GB production copy. */
const BYTES_PER_GB = 1e9;

const PREF_LAST_RUN_AT = "retention:lastRunAt";
const PREF_LAST_FREED_BYTES = "retention:lastFreedBytes";
const PREF_LAST_TRIMMED_ROWS = "retention:lastTrimmedRows";

let running = false;
let abortRequested = false;
let bootTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let scheduled = false;
/** A debounced request fired while a pass was running: re-run once after it. */
let rerunQueued = false;

/** Whether a retention pass is running right now. Callers that need
 *  "exactly one pass" semantics (the manual-run route, Compact) check this
 *  before calling; a second concurrent {@link runArchivedHistoryRetentionPass}
 *  is itself a no-op returning a zero result. */
export function isRetentionRunning(): boolean {
  return running;
}

/** The effective retention age in days, or `null` when trimming is off —
 *  either `AGETOR_ARCHIVED_HISTORY_RETENTION=0` or the preference is `"off"`. */
export function configuredRetentionDays(): number | null {
  if (process.env.AGETOR_ARCHIVED_HISTORY_RETENTION === "0") return null;
  return parseArchivedHistoryRetentionDays(preferences.get(ARCHIVED_HISTORY_RETENTION_PREF));
}

function emptyResult(): RetentionPassResult {
  return { scannedTasks: 0, scannedRuns: 0, trimmedRows: 0, freedBytes: 0, durationMs: 0, aborted: false };
}

/** True while `taskId` still exists and is archived at or before `cutoff`.
 *  A direct single-column read (not `tasks.get`, which also folds pipeline
 *  step aggregates) — it runs once per written chunk. */
function stillEligible(taskId: string, cutoff: number): boolean {
  const row = db
    .query<{ archived_at: number | null }, [string]>(`SELECT archived_at FROM tasks WHERE id = ?`)
    .get(taskId);
  return row !== null && row.archived_at !== null && row.archived_at <= cutoff;
}

/**
 * Run one archived-history retention pass and resolve with its totals.
 *
 * `days === null` is an immediate no-op. Single-flight: while a pass is
 * running, a second call returns a zero result (`aborted: false`) without
 * doing anything — callers that must tell "ran, trimmed nothing" from "did not
 * run" check {@link isRetentionRunning} first. `stopRetentionTimers()` aborts
 * a running pass between chunks (`aborted: true`); trimmed rows stay trimmed
 * and the next pass resumes via the marker prefilter.
 *
 * On completion (not on abort) the three `retention:*` bookkeeping
 * preferences are written and one summary line is logged.
 */
export async function runArchivedHistoryRetentionPass(opts: {
  now?: number;
  days: number | null;
  sliceMs?: number;
  maxBytes?: number;
}): Promise<RetentionPassResult> {
  const { days } = opts;
  if (days === null) return emptyResult();
  if (running) return emptyResult();
  const now = opts.now ?? Date.now();
  const sliceMs = opts.sliceMs ?? 20;
  const maxBytes = opts.maxBytes ?? RETENTION_TRIM_BYTES;

  running = true;
  abortRequested = false;
  const startedAt = performance.now();
  const result = emptyResult();

  // Slice bookkeeping: the lag label is live only while we are actually
  // working, and is disposed before every yield.
  let disposeLabel: (() => void) | null = beginLagLabel("archived-history retention");
  let sliceStart = performance.now();
  const yieldIfSliceSpent = async (): Promise<void> => {
    if (performance.now() - sliceStart < sliceMs) return;
    disposeLabel?.();
    disposeLabel = null;
    await new Promise<void>((resolve) => setImmediate(resolve));
    disposeLabel = beginLagLabel("archived-history retention");
    sliceStart = performance.now();
  };

  try {
    const cutoff = now - days * DAY_MS;
    const candidates = tasks.archivedBefore(cutoff);
    let pageLimit = INITIAL_PAGE_ROWS;
    taskLoop: for (const candidate of candidates) {
      if (abortRequested) {
        result.aborted = true;
        break;
      }
      result.scannedTasks++;
      for (const runId of runs.runIdsForTask(candidate.id)) {
        result.scannedRuns++;
        let afterId = 0;
        for (;;) {
          const limit = pageLimit;
          if (abortRequested) {
            result.aborted = true;
            break taskLoop;
          }
          const rows = runs.toolResultRowsForTrim(runId, maxBytes, afterId, limit);
          if (rows.length === 0) break;
          await yieldIfSliceSpent();

          let pageChars = 0;
          for (const row of rows) pageChars += row.data.length;

          let pending: Array<{ id: number; data: string }> = [];
          let pendingChars = 0;
          let pendingFreed = 0;
          /** Writes the gathered rewrites in one transaction — but only while
           *  the task is still archived past the cutoff, checked inside that
           *  same transaction (no yield can land between check and write).
           *  Returns false when the task was unarchived meanwhile. */
          const flush = (): boolean => {
            const batch = pending;
            const freed = pendingFreed;
            pending = [];
            pendingChars = 0;
            pendingFreed = 0;
            if (batch.length === 0) return stillEligible(candidate.id, cutoff);
            return db.transaction((): boolean => {
              if (!stillEligible(candidate.id, cutoff)) return false;
              for (const r of batch) runs.replaceEventData(r.id, r.data);
              result.trimmedRows += batch.length;
              result.freedBytes += freed;
              return true;
            })();
          };

          for (const row of rows) {
            afterId = row.id;
            const trimmed = trimToolResultData(row.data, maxBytes, now);
            pendingChars += row.data.length;
            if (trimmed) {
              const newBytes = utf8Length(trimmed.data);
              // Only keep a rewrite that actually shrinks the row.
              if (newBytes < trimmed.originalBytes) {
                pending.push({ id: row.id, data: trimmed.data });
                pendingFreed += trimmed.originalBytes - newBytes;
              }
            }
            if (pendingChars >= CHUNK_INPUT_BYTES && !flush()) continue taskLoop;
            await yieldIfSliceSpent();
            if (abortRequested) break;
          }
          if (!flush()) continue taskLoop;
          await yieldIfSliceSpent();

          // Size the next fetch from this page's average row (see
          // TARGET_PAGE_CHARS).
          const avgChars = pageChars / rows.length;
          pageLimit = Math.max(1, Math.min(CHUNK_ROWS, Math.floor(TARGET_PAGE_CHARS / Math.max(1, avgChars))));
          if (rows.length < limit) break;
        }
      }
    }
    if (abortRequested) result.aborted = true;
  } finally {
    disposeLabel?.();
    result.durationMs = Math.round(performance.now() - startedAt);
    running = false;
    abortRequested = false;
  }

  if (!result.aborted) {
    try {
      preferences.set(PREF_LAST_RUN_AT, String(Date.now()));
      preferences.set(PREF_LAST_FREED_BYTES, String(result.freedBytes));
      preferences.set(PREF_LAST_TRIMMED_ROWS, String(result.trimmedRows));
    } catch (err) {
      console.warn("[agetor] retention: could not record bookkeeping:", err);
    }
  }
  console.log(
    `[agetor] retention: trimmed ${result.trimmedRows} rows, freed ${(result.freedBytes / (1024 * 1024)).toFixed(1)} MB across ${result.scannedTasks} tasks in ${(result.durationMs / 1000).toFixed(1)} s${result.aborted ? " (aborted)" : ""}`,
  );
  return result;
}

/** Valid non-negative integer env override, else `fallback`. */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fallback;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? n : fallback;
}

/** Fire one scheduled/requested pass if retention is currently enabled, then
 *  chase a queued re-run. Never throws. */
function startPass(): void {
  const days = configuredRetentionDays();
  if (days === null) {
    rerunQueued = false;
    return;
  }
  if (running) {
    rerunQueued = true;
    return;
  }
  void runArchivedHistoryRetentionPass({ days })
    .catch((err) => console.warn("[agetor] retention pass failed:", err))
    .finally(() => {
      if (rerunQueued) {
        rerunQueued = false;
        startPass();
      }
    });
}

/**
 * Arm the periodic retention schedule: one pass `bootDelayMs` after the call
 * (default 90 s — after the API is up and the restore/seed work has settled),
 * then every `intervalMs` (default 24 h). Each fire reads the preference
 * fresh, so turning retention off takes effect without a restart, and skips
 * when it is off. Env seams: `AGETOR_RETENTION_BOOT_DELAY_MS`,
 * `AGETOR_RETENTION_INTERVAL_MS` (valid non-negative integers) override the
 * defaults; `AGETOR_ARCHIVED_HISTORY_RETENTION=0` disables scheduling
 * entirely. All timers are `.unref()`'d. Idempotent: a second call while armed
 * is a no-op.
 */
export function scheduleRetention(opts: { bootDelayMs?: number; intervalMs?: number } = {}): void {
  if (process.env.AGETOR_ARCHIVED_HISTORY_RETENTION === "0") return;
  if (scheduled) return;
  scheduled = true;
  const bootDelayMs = envMs("AGETOR_RETENTION_BOOT_DELAY_MS", opts.bootDelayMs ?? DEFAULT_BOOT_DELAY_MS);
  const intervalMs = envMs("AGETOR_RETENTION_INTERVAL_MS", opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  bootTimer = setTimeout(() => {
    bootTimer = null;
    startPass();
    if (!scheduled) return;
    // setInterval rejects 0 (it would spin); clamp to 1 ms for the test seam.
    intervalTimer = setInterval(startPass, Math.max(1, intervalMs));
    intervalTimer.unref?.();
  }, bootDelayMs);
  bootTimer.unref?.();
}

/**
 * Ask for a pass soon (the preference-change path): debounced by 5 s
 * (`AGETOR_RETENTION_DEBOUNCE_MS` overrides, a test seam), each call restarting
 * the window. When the window elapses and a pass is already running exactly one
 * re-run is queued for after it finishes. Works whether or not
 * {@link scheduleRetention} was called; a no-op when retention is off at fire
 * time. The timer is `.unref()`'d.
 */
export function requestRetentionPass(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    startPass();
  }, envMs("AGETOR_RETENTION_DEBOUNCE_MS", DEFAULT_DEBOUNCE_MS));
  debounceTimer.unref?.();
}

/** Clear every timer, drop any queued re-run and abort a running pass (it
 *  resolves `aborted: true` at its next chunk boundary). Safe to call when
 *  nothing is armed; {@link scheduleRetention} can be called again afterwards. */
export function stopRetentionTimers(): void {
  if (bootTimer) clearTimeout(bootTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
  bootTimer = null;
  intervalTimer = null;
  debounceTimer = null;
  scheduled = false;
  rerunQueued = false;
  if (running) abortRequested = true;
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function dbFileBytes(): { fileBytes: number; walBytes: number } {
  const main = join(dataDir, "agetor.sqlite");
  return { fileBytes: fileBytes(main), walBytes: fileBytes(`${main}-wal`) };
}

function pragmaNumber(name: string): number {
  const row = db.query<Record<string, number>, []>(`PRAGMA ${name}`).get();
  const v = row ? Object.values(row)[0] : 0;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function numberPref(key: string): number | null {
  const raw = preferences.get(key);
  if (raw === null) return null;
  const n = Number(raw);
  return raw.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Database size/free-space snapshot for `GET /db/stats`. `activeRunCount` is
 * supplied by the caller (this module cannot import the orchestrator).
 * `compactEstimateSec` = live bytes (`(page_count − freelist_count) ×
 * page_size`) / 1e9 × {@link DB_COMPACT_SEC_PER_GB}, at least 1.
 */
export function dbStats(activeRunCount: number): DbStats {
  const sizes = dbFileBytes();
  const pageSize = pragmaNumber("page_size");
  const pageCount = pragmaNumber("page_count");
  const freelistCount = pragmaNumber("freelist_count");
  const liveBytes = Math.max(0, pageCount - freelistCount) * pageSize;
  return {
    fileBytes: sizes.fileBytes,
    walBytes: sizes.walBytes,
    pageSize,
    pageCount,
    freelistCount,
    reclaimableBytes: freelistCount * pageSize,
    compactEstimateSec: Math.max(1, Math.round((liveBytes / BYTES_PER_GB) * DB_COMPACT_SEC_PER_GB)),
    activeRunCount,
    retention: {
      days: configuredRetentionDays(),
      lastRunAt: numberPref(PREF_LAST_RUN_AT),
      lastFreedBytes: numberPref(PREF_LAST_FREED_BYTES),
      lastTrimmedRows: numberPref(PREF_LAST_TRIMMED_ROWS),
      running,
    },
  };
}

/**
 * `VACUUM` the database and truncate the WAL. Synchronous and blocking by
 * nature (see the module doc) — the caller enforces the "no run active" 409
 * gate. Throws when a retention pass is running (the pass is mid-yield and its
 * writes would interleave with the rebuild).
 */
export function compactDatabase(): { beforeBytes: number; afterBytes: number; durationMs: number } {
  if (running) throw new Error("a retention pass is running — try again when it finishes");
  const before = dbFileBytes();
  const beforeBytes = before.fileBytes + before.walBytes;
  const startedAt = performance.now();
  const dispose = beginLagLabel("compact database");
  try {
    db.exec("VACUUM");
    db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } finally {
    dispose();
  }
  const durationMs = Math.round(performance.now() - startedAt);
  const after = dbFileBytes();
  return { beforeBytes, afterBytes: after.fileBytes + after.walBytes, durationMs };
}

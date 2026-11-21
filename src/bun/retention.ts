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
 * though the envelope is large) would be re-read by every daily pass forever,
 * so a task whose sweep COMPLETED is recorded in the `retention_swept_tasks`
 * table (`retentionSweeps`, `db-core/preferences.ts`) under a key of everything that could make a re-sweep find new
 * work — its `archived_at` (a re-archive moves it), the size threshold, and
 * its newest event id (a JSONL rebuild of an archived task appends rows) — and
 * skipped while that key still matches. A task cut short by an abort or an
 * unarchive is never recorded; rows for tasks that are no longer
 * candidates are dropped on every pass (and a deleted task's row cascades),
 * so the table stays bounded by the archived-task count.
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
 * The pass pages rows through the async database API (in production every
 * query runs on the database worker) and trims them on the main thread, so it
 * must not hog the event loop. Work runs
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
 * mid-way through that task: every chunk's write is therefore one named op,
 * `retention.writeChunk` (`db-core/ops/retention-ops.ts`), that re-reads the
 * task's `archived_at` INSIDE its own transaction on the worker and drops the
 * chunk — and moves on to the next task — when the task is no
 * longer archived past the cutoff, so a task that came back to life is never
 * trimmed after the fact.
 *
 * ## Compact
 *
 * {@link compactDatabase} runs `VACUUM` + `wal_checkpoint(TRUNCATE)` as one
 * op, `retention.compact`, on the database worker's connection. VACUUM is a
 * single synchronous call: the main thread keeps serving, but every database
 * call (so nearly every request) waits behind it for its full duration —
 * roughly {@link DB_COMPACT_SEC_PER_GB} s per GB of live data. That is
 * owner-accepted (plan §2.6); the route that calls it refuses while any run is
 * active and the UI shows a blocking modal with the estimate.
 *
 * ## SQL covered by the plan guard
 *
 * Every statement against `run_events` that this module issues goes through a
 * `runs.*` helper in `db-core/runs.ts` (directly, or inside a `retention.*`
 * op); the one that is an exported constant is {@link TOOL_RESULT_TRIM_SQL},
 * listed in {@link RETENTION_SQL}. The remaining helpers
 * (`runs.replaceEventData` — a primary-key UPDATE; `runs.maxEventIdForRun`;
 * `runs.runIdsForTask`, `tasks.archivedBefore` — `runs`/`tasks` only) are
 * covered by the plan-guard test's method sweep.
 *
 * This module must not import `orchestrator.ts` (circularity): the server
 * passes `activeRunCount` into {@link dbStats}.
 */
import {
  ARCHIVED_HISTORY_RETENTION_PREF,
  DB_COMPACT_SEC_PER_GB,
  RETENTION_TRIM_BYTES,
  parseArchivedHistoryRetentionDays,
  type DbStats,
  type RetentionPassResult,
} from "../shared/types";
import { trimToolResultData, utf8Length } from "../shared/tool-result-trim";
import { TOOL_RESULT_TRIM_SQL, op, preferences, retentionSweeps, runs, tasks } from "./db-async.ts";
import type { RetentionRewrite } from "./db-core/ops/retention-ops.ts";
import { getDbRpc } from "./db-rpc.ts";
import { beginLagLabel } from "./event-loop-lag";
import { cleanupHarnessSessionCopies } from "./harness-session-transfer";

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
/** What a completed sweep saw; unchanged → nothing new to trim. `maxEventId`
 *  is the newest event id across the task's runs. */
function sweepKey(archivedAt: number, maxBytes: number, maxEventId: number): string {
  return `${archivedAt}:${maxBytes}:${maxEventId}`;
}

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
export async function configuredRetentionDays(): Promise<number | null> {
  if (process.env.AGETOR_ARCHIVED_HISTORY_RETENTION === "0") return null;
  return parseArchivedHistoryRetentionDays(await preferences.get(ARCHIVED_HISTORY_RETENTION_PREF));
}

function emptyResult(): RetentionPassResult {
  return { scannedTasks: 0, scannedRuns: 0, trimmedRows: 0, freedBytes: 0, durationMs: 0, aborted: false };
}

/** True while `taskId` still exists and is archived at or before `cutoff`
 *  (`retention.stillEligible`, a single-column read). */
function stillEligible(taskId: string, cutoff: number): Promise<boolean> {
  return op("retention.stillEligible", [taskId, cutoff]);
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
  // In worker mode a database call is a wait for the worker, not work on this
  // thread: the label is down while it is in flight, so a stall elsewhere in
  // that window is not blamed on retention. In-process mode (tests,
  // `AGETOR_DB_MODE=inprocess`) runs the query on this thread, so it stays up.
  const dbOnThisThread = getDbRpc().mode === "inprocess";
  const dbHop = async <T,>(call: () => Promise<T>): Promise<T> => {
    if (dbOnThisThread) return call();
    disposeLabel?.();
    disposeLabel = null;
    try {
      return await call();
    } finally {
      disposeLabel = beginLagLabel("archived-history retention");
    }
  };

  try {
    const cutoff = now - days * DAY_MS;
    const candidates = await tasks.archivedBefore(cutoff);
    // A task that was unarchived (or fell out of the age window) since drops
    // out of the record here; a deleted one already went with its row.
    await retentionSweeps.pruneNotArchivedBefore(cutoff);
    const sweptTasks = await retentionSweeps.all();
    let pageLimit = INITIAL_PAGE_ROWS;
    taskLoop: for (const candidate of candidates) {
      // Every iteration — including the swept-task skip below, which is the
      // steady state of a daily pass — must reach the slice check, or a pass
      // over a thousand already-swept tasks is one synchronous loop.
      await yieldIfSliceSpent();
      if (abortRequested) {
        result.aborted = true;
        break;
      }
      const { runIds: taskRunIds, maxEventId } = await dbHop(() => op("retention.taskSweepInputs", [candidate.id]));
      const key = sweepKey(candidate.archivedAt, maxBytes, maxEventId);
      if (sweptTasks.get(candidate.id) === key) continue;
      // Harness-stack copies (docs/architecture/harness-stacks.md): an
      // archived task's transferred provider sessions are removed with the
      // same age threshold, so an unarchive before it keeps them and one
      // after it starts fresh. Best-effort — a failed removal leaves the
      // handoff row and is retried on the next pass. Re-check eligibility
      // here: the candidate list is a snapshot and the pass yields, so the
      // user can unarchive this task between that read and this cleanup.
      if (!(await dbHop(() => stillEligible(candidate.id, cutoff)))) continue;
      try {
        await cleanupHarnessSessionCopies(candidate.id);
      } catch (err) {
        console.warn(`[agetor] could not remove copied harness sessions for ${candidate.id}:`, err);
      }
      // The stored key (if any) stays stale until this sweep runs to
      // completion, so an abort or unarchive mid-sweep is re-swept next time.
      result.scannedTasks++;
      for (const runId of taskRunIds) {
        result.scannedRuns++;
        let afterId = 0;
        for (;;) {
          const limit = pageLimit;
          if (abortRequested) {
            result.aborted = true;
            break taskLoop;
          }
          const rows = await dbHop(() => runs.toolResultRowsForTrim(runId, maxBytes, afterId, limit));
          if (rows.length === 0) break;
          await yieldIfSliceSpent();

          let pageChars = 0;
          for (const row of rows) pageChars += row.data.length;

          let pending: RetentionRewrite[] = [];
          let pendingChars = 0;
          let pendingFreed = 0;
          /** Writes the gathered rewrites in one transaction — but only while
           *  the task is still archived past the cutoff, checked inside that
           *  same transaction on the worker (`retention.writeChunk`), so no
           *  other write can land between check and write. Resolves false
           *  when the task was unarchived meanwhile. */
          const flush = async (): Promise<boolean> => {
            const batch = pending;
            const freed = pendingFreed;
            pending = [];
            pendingChars = 0;
            pendingFreed = 0;
            if (batch.length === 0) return dbHop(() => stillEligible(candidate.id, cutoff));
            const written = await dbHop(() => op("retention.writeChunk", [candidate.id, cutoff, batch]));
            if (written) {
              result.trimmedRows += batch.length;
              result.freedBytes += freed;
            }
            return written;
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
            if (pendingChars >= CHUNK_INPUT_BYTES && !(await flush())) continue taskLoop;
            await yieldIfSliceSpent();
            if (abortRequested) break;
          }
          if (!(await flush())) continue taskLoop;
          await yieldIfSliceSpent();

          // Size the next fetch from this page's average row (see
          // TARGET_PAGE_CHARS).
          const avgChars = pageChars / rows.length;
          pageLimit = Math.max(1, Math.min(CHUNK_ROWS, Math.floor(TARGET_PAGE_CHARS / Math.max(1, avgChars))));
          if (rows.length < limit) break;
        }
      }
      // An abort that landed inside the last run's rows broke only the row
      // loop: this sweep did not complete, so it must not be recorded.
      if (abortRequested) {
        result.aborted = true;
        break;
      }
      try {
        await dbHop(() => retentionSweeps.set(candidate.id, key));
      } catch (err) {
        // Worst case one extra sweep of this task next pass, never a skipped one.
        console.warn("[agetor] retention: could not record swept task:", err);
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
      await preferences.set(PREF_LAST_RUN_AT, String(Date.now()));
      await preferences.set(PREF_LAST_FREED_BYTES, String(result.freedBytes));
      await preferences.set(PREF_LAST_TRIMMED_ROWS, String(result.trimmedRows));
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
 *  chase a queued re-run. Never throws: a failed preference read or pass is
 *  logged. */
function startPass(): void {
  void (async () => {
    const days = await configuredRetentionDays();
    if (days === null) {
      rerunQueued = false;
      return;
    }
    // Checked after the read: `runArchivedHistoryRetentionPass` sets `running`
    // synchronously when called, so of two starts racing the read, the second
    // queues a re-run instead of being a silent no-op.
    if (running) {
      rerunQueued = true;
      return;
    }
    try {
      await runArchivedHistoryRetentionPass({ days });
    } finally {
      if (rerunQueued) {
        rerunQueued = false;
        startPass();
      }
    }
  })().catch((err) => console.warn("[agetor] retention pass failed:", err));
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

function numberPref(raw: string | null): number | null {
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
export async function dbStats(activeRunCount: number): Promise<DbStats> {
  const { fileBytes, walBytes, pageSize, pageCount, freelistCount } = await op("retention.fileStats", []);
  const liveBytes = Math.max(0, pageCount - freelistCount) * pageSize;
  const days = await configuredRetentionDays();
  const lastRunAt = numberPref(await preferences.get(PREF_LAST_RUN_AT));
  const lastFreedBytes = numberPref(await preferences.get(PREF_LAST_FREED_BYTES));
  const lastTrimmedRows = numberPref(await preferences.get(PREF_LAST_TRIMMED_ROWS));
  return {
    fileBytes,
    walBytes,
    pageSize,
    pageCount,
    freelistCount,
    reclaimableBytes: freelistCount * pageSize,
    compactEstimateSec: Math.max(1, Math.round((liveBytes / BYTES_PER_GB) * DB_COMPACT_SEC_PER_GB)),
    activeRunCount,
    retention: {
      days,
      lastRunAt,
      lastFreedBytes,
      lastTrimmedRows,
      running,
    },
  };
}

/**
 * `VACUUM` the database and truncate the WAL, as one op on the database
 * worker (`retention.compact`; see the module doc). The caller enforces the
 * "no run active" 409 gate. Rejects when a retention pass is running (the pass
 * is mid-yield and its writes would interleave with the rebuild); that check
 * is synchronous, before anything is sent to the worker.
 */
export async function compactDatabase(): Promise<{ beforeBytes: number; afterBytes: number; durationMs: number }> {
  if (running) throw new Error("a retention pass is running — try again when it finishes");
  // The lag label names what blocks the main thread. Only in-process mode
  // (tests, `AGETOR_DB_MODE=inprocess`) runs VACUUM on this thread; in worker
  // mode a main-thread stall during Compact is someone else's.
  const dispose = getDbRpc().mode === "inprocess" ? beginLagLabel("compact database") : null;
  try {
    return await op("retention.compact", []);
  } finally {
    dispose?.();
  }
}

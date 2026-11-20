import type { Database } from "bun:sqlite";
import { type Run, type RunEventStream, HARNESS_STACK_CONTINUATION_TAG } from "../../shared/types.ts";
import { isHarnessStackContinuation } from "../../shared/harness-stack.ts";
import { normalizeDeliveredUserText, type CleanRetryRow } from "../../shared/user-message.ts";
import { decideForwardResume, type ForwardResumeSnapshotReason } from "../event-resume.ts";

export type RunRow = {
  id: string; task_id: string; agent: string; status: string;
  started_at: number; ended_at: number | null; exit_code: number | null;
  tmux_session: string | null;
  claude_session_id: string | null;
  codex_session_id: string | null;
  cursor_session_id: string | null;
  gemini_session_id: string | null;
  fx_session_id: string | null;
  antigravity_session_id: string | null;
  // OpenCode's own session id (`ses_…`, migration 078), discovered from the
  // first NDJSON line that carries a `sessionID` and replayed via `-s`.
  opencode_session_id: string | null;
  copilot_session_id: string | null;
  origin: string | null;
};

/** Every per-kind session-id column on `runs` — the closed whitelist
 *  `runs.sessionIdsForTask` interpolates into its SQL. */
export const SESSION_ID_COLUMNS = [
  "claude_session_id",
  "codex_session_id",
  "cursor_session_id",
  "gemini_session_id",
  "antigravity_session_id",
  "fx_session_id",
  "opencode_session_id",
  "copilot_session_id",
] as const;

export type SessionIdColumn = (typeof SESSION_ID_COLUMNS)[number];

/** One `run_events` row as the task-level event reads return it
 *  (`runs.eventsForTask`, `runs.eventsForTaskAfter`). */
export type TaskEventRow = {
  id: number;
  runId: string;
  stream: string;
  data: string;
  ts: number;
  subagentId: string | null;
};

/** What `runs.appendEvent` stored: the row id and the timestamp written to
 *  it — callers broadcast this exact pair so a live frame and its replayed
 *  twin agree on `id` and `ts`. */
export interface AppendedEvent {
  id: number;
  ts: number;
}

/** Answer of `runs.eventsForTaskAfter`: the rows after the cursor, or a
 *  refusal telling the client to take a fresh window. */
export type ForwardResumeResult =
  | { kind: "resume"; rows: TaskEventRow[] }
  | { kind: "snapshot"; reason: ForwardResumeSnapshotReason };

/**
 * Given rows in DESC (newest-first) id order — each carrying its `data`
 * column's `LENGTH()` as `len` — finds the id of the oldest row to keep
 * under a byte budget, walking newest → oldest and accumulating `len`.
 * Always keeps at least `minEvents` rows before the budget can cut anything
 * off (the `MIN_REPLAY_EVENTS` floor — see
 * `docs/plans/task-details-blank-while-session-restores.md` §3.3), and
 * always keeps at least ONE row regardless of `minEvents`, so a caller can
 * never get back an empty window from a non-empty input. `len` is the
 * UTF-8 byte length of each event's `data` — `eventsForTask` selects
 * `LENGTH(CAST(data AS BLOB))` (bytes; plain `LENGTH()` on TEXT would count
 * characters) and the rebuild route uses `Buffer.byteLength`, so the
 * budgets count what actually goes over the wire. Returns `null` only when
 * `rowsDesc` is empty. Pure and
 * DB-free so it's unit-testable on its own.
 */
export function clampWindowByBytes(
  rowsDesc: Array<{ id: number; len: number }>,
  maxBytes: number,
  minEvents: number,
): number | null {
  if (rowsDesc.length === 0) return null;
  let accumulated = 0;
  let count = 0;
  for (const row of rowsDesc) {
    if (count >= minEvents && accumulated + row.len > maxBytes) break;
    accumulated += row.len;
    count++;
  }
  if (count === 0) count = 1;
  return rowsDesc[count - 1]!.id;
}

/** Page size for `runs.lastUserEventId`'s newest-first walk. */
export const LAST_USER_ANCHOR_PAGE = 8;

export const CONTINUATION_OPEN_TAG = `<${HARNESS_STACK_CONTINUATION_TAG}>`;

/**
 * True when a stored `user` event is a harness-stack continuation that every
 * renderer hides: the exact wrapper, either as sent (the live echo) or after
 * claude's `<pasted_content>` delivery wrapper is peeled (its JSONL twin).
 * The same two checks the renderers run (`userMessageLines`,
 * `cleanMessageText`), so the first-load anchor never lands on a row the
 * transcript does not show.
 */
export function isHiddenContinuationUserText(raw: string): boolean {
  if (!raw.includes(CONTINUATION_OPEN_TAG)) return false;
  const text = raw.replace(/\r\n?/g, "\n");
  return isHarnessStackContinuation(text) || isHarnessStackContinuation(normalizeDeliveredUserText(text));
}

/**
 * Decides whether a first-load window should be extended back to an anchor
 * event (the newest main-stream `user` event) — see
 * `docs/plans/first-load-reaches-last-user-message.md` §3. The extension is
 * ALL-OR-NOTHING: either the whole span `[anchorId, beforeId)` fits under
 * both ceilings and `anchorId` becomes the new floor, or the caller's
 * existing `minId` (the default count/byte-budgeted window) stands unchanged
 * — there is no partial extension.
 *
 * - `anchorId == null` (no user event at all, e.g. a task with only status
 *   breadcrumbs) → `minId` unchanged.
 * - `anchorId >= minId` — the anchor already sits inside (or exactly at the
 *   edge of) the default window → `minId` unchanged; nothing to extend.
 * - Otherwise `spanRowsDesc` — the DESC (newest-first) `{id, len}` rows of
 *   the span `id >= anchorId` (and `id < beforeId` when the caller has one),
 *   capped by the CALLER at `maxEvents + 1` rows — decides it:
 *   - `spanRowsDesc.length > maxEvents` → the span holds MORE than
 *     `maxEvents` events (the `+1` the caller fetched proves it, without
 *     this function ever seeing an unbounded row set) → `minId` unchanged.
 *   - else sum every row's `len`; `> maxBytes` → `minId` unchanged;
 *     otherwise → `anchorId` (the window now starts at the anchor).
 *
 * Both callers (the SSE replay route via `eventsForTask`'s `opts.anchor`,
 * and the `?limit=` rebuild-snapshot route directly, over its in-memory
 * mapped events with `id` = array index) share this one rule and its unit
 * tests, so "does the span fit" can't drift between the two surfaces. Pure
 * and DB-free, like `clampWindowByBytes`.
 */
export function resolveAnchoredMinId(args: {
  minId: number;
  anchorId: number | null;
  spanRowsDesc: Array<{ id: number; len: number }>;
  maxEvents: number;
  maxBytes: number;
}): number {
  const { minId, anchorId, spanRowsDesc, maxEvents, maxBytes } = args;
  if (anchorId == null || anchorId >= minId) return minId;
  if (spanRowsDesc.length > maxEvents) return minId;
  let total = 0;
  for (const row of spanRowsDesc) total += row.len;
  if (total > maxBytes) return minId;
  return anchorId;
}

export const toRun = (r: RunRow): Run => ({
  id: r.id,
  taskId: r.task_id,
  agent: r.agent as Run["agent"],
  status: r.status as Run["status"],
  startedAt: r.started_at,
  endedAt: r.ended_at,
  exitCode: r.exit_code,
  tmuxSession: r.tmux_session,
  claudeSessionId: r.claude_session_id,
  codexSessionId: r.codex_session_id,
  cursorSessionId: r.cursor_session_id,
  geminiSessionId: r.gemini_session_id,
  fxSessionId: r.fx_session_id,
  antigravitySessionId: r.antigravity_session_id,
  opencodeSessionId: r.opencode_session_id,
  copilotSessionId: r.copilot_session_id,
  origin: (r.origin as Run["origin"]) ?? null,
});

/**
 * The retention trim's candidate query (see `runs.toolResultRowsForTrim`).
 * Exported so the `EXPLAIN QUERY PLAN` guard test can assert it SEARCHes
 * `idx_run_events_run` with no temp b-tree sort.
 */
export const TOOL_RESULT_TRIM_SQL = `SELECT id, data FROM run_events
  WHERE run_id = ? AND stream = 'tool_result' AND LENGTH(CAST(data AS BLOB)) > ?
    AND substr(data, 1, 13) != '{"retention":' AND id > ?
  ORDER BY id LIMIT ?`;

export function makeRuns(conn: Database) {
  const runs = {
    listForTask(taskId: string): Run[] {
      return conn.query<RunRow, [string]>(
        `SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC`,
      ).all(taskId).map(toRun);
    },
    /** The newest run of a task (any status), or null: `listForTask(taskId)[0]`
     *  without materializing the rest. Ties on `started_at` go to the later
     *  insert. */
    latestForTask(taskId: string): Run | null {
      const row = conn.query<RunRow, [string]>(
        `SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      ).get(taskId);
      return row ? toRun(row) : null;
    },
    /**
     * Total run count for a task, across every status — the "has this task
     * ever run" test `effectiveAgentProfile` (docs/plans/agent-profiles.md D2)
     * uses to decide whether a bound agent profile is still "live" (follows
     * edits) or frozen to its captured snapshot. A plain `COUNT(*)` rather
     * than `listForTask(...).length` so the caller isn't paying to materialize
     * every run row just to check the count.
     */
    countForTask(taskId: string): number {
      const row = conn.query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM runs WHERE task_id = ?`,
      ).get(taskId);
      return row?.n ?? 0;
    },
    get(id: string): Run | null {
      const row = conn.query<RunRow, [string]>(`SELECT * FROM runs WHERE id = ?`).get(id);
      return row ? toRun(row) : null;
    },
    /** `r.origin` is optional on the `Run` type (most callers don't set it —
     *  only the continuation-run factory does) so `?? null` keeps a
     *  user-initiated run's row explicitly NULL rather than the JS `undefined`
     *  bun:sqlite would otherwise bind. */
    insert(r: Run): Run {
      conn.run(
        `INSERT INTO runs (id, task_id, agent, status, started_at, ended_at, exit_code, tmux_session, claude_session_id, codex_session_id, cursor_session_id, gemini_session_id, fx_session_id, antigravity_session_id, opencode_session_id, copilot_session_id, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.id, r.taskId, r.agent, r.status, r.startedAt, r.endedAt, r.exitCode, r.tmuxSession, r.claudeSessionId, r.codexSessionId, r.cursorSessionId, r.geminiSessionId, r.fxSessionId ?? null, r.antigravitySessionId ?? null, r.opencodeSessionId ?? null, r.copilotSessionId ?? null, r.origin ?? null],
      );
      return { ...r, origin: r.origin ?? null };
    },
    /**
     * The last run (any status) of every non-archived task that ever recorded
     * an OpenCode session, when that last run has one: what the server driver's
     * wake watch is computed from. One pass over those tasks' runs, ranked per
     * task (no per-row subquery). The task set comes through the partial
     * `runs_opencode_session_id_idx` (079), pinned: unpinned, the planner walks
     * all of `idx_runs_task` and reads every run row to test the column. The
     * runs then come through `idx_runs_task`.
     *
     * `archivedSinceMs` also returns the tasks archived at or after that
     * epoch-ms, flagged `archived: true`, so the watch can keep interrupting
     * what such a task's session still starts for a bounded time. Without it
     * every row is a live task (`archived: false`). A deleted task has no runs,
     * so it is never returned.
     */
    lastOpencodeSessionRunPerTask(opts: { archivedSinceMs?: number } = {}): {
      runId: string;
      taskId: string;
      agent: string;
      sessionId: string;
      archived: boolean;
    }[] {
      const since = typeof opts.archivedSinceMs === "number" && Number.isFinite(opts.archivedSinceMs) ? opts.archivedSinceMs : null;
      return conn
        .query<{ runId: string; taskId: string; agent: string; sessionId: string; archived: number }, [number | null]>(
          `WITH oc AS (SELECT DISTINCT task_id FROM runs INDEXED BY runs_opencode_session_id_idx WHERE opencode_session_id IS NOT NULL),
              ranked AS (
                SELECT r.id AS run_id, r.task_id AS task_id, r.agent AS agent, r.opencode_session_id AS session_id,
                       ROW_NUMBER() OVER (PARTITION BY r.task_id ORDER BY r.started_at DESC, r.rowid DESC) AS rn
                  FROM runs r WHERE r.task_id IN (SELECT task_id FROM oc))
         SELECT ranked.run_id AS runId, ranked.task_id AS taskId, ranked.agent AS agent, ranked.session_id AS sessionId,
                (t.archived_at IS NOT NULL) AS archived
           FROM ranked JOIN tasks t ON t.id = ranked.task_id
          WHERE ranked.rn = 1 AND ranked.session_id IS NOT NULL
            AND (t.archived_at IS NULL OR (?1 IS NOT NULL AND t.archived_at >= ?1))`,
        )
        .all(since)
        .map((r) => ({ runId: r.runId, taskId: r.taskId, agent: r.agent, sessionId: r.sessionId, archived: r.archived === 1 }));
    },
    /** Set (or clear) the tmux session name a run is recorded under. `update`
     *  leaves the column alone; only an OpenCode follow-up whose transport
     *  turned out different from the one guessed at insert corrects it. */
    setTmuxSession(id: string, name: string | null): void {
      conn.run(`UPDATE runs SET tmux_session = ? WHERE id = ?`, [name, id]);
    },
    update(id: string, patch: Partial<Run>): Run | null {
      const row = conn.query<RunRow, [string]>(`SELECT * FROM runs WHERE id = ?`).get(id);
      if (!row) return null;
      const current = toRun(row);
      const next: Run = { ...current, ...patch, id };
      conn.run(
        `UPDATE runs SET status=?, ended_at=?, exit_code=?, claude_session_id=?, codex_session_id=?, cursor_session_id=?, gemini_session_id=?, fx_session_id=?, antigravity_session_id=?, opencode_session_id=?, copilot_session_id=? WHERE id=?`,
        [next.status, next.endedAt, next.exitCode, next.claudeSessionId, next.codexSessionId, next.cursorSessionId, next.geminiSessionId, next.fxSessionId, next.antigravitySessionId ?? null, next.opencodeSessionId ?? null, next.copilotSessionId ?? null, id],
      );
      return next;
    },
    /** Events for a single run, in event-id order. `runId` is the same as
     *  the argument — included on every row so the shape matches
     *  `eventsForTask`, keeping the two helpers interchangeable to a
     *  caller that just wants `{ runId, stream, data, ts }`. */
    events(runId: string) {
      return conn.query<
        { runId: string; stream: string; data: string; ts: number; subagentId: string | null },
        [string]
      >(
        `SELECT run_id as runId, stream, data, ts, subagent_id as subagentId
       FROM run_events
       WHERE run_id = ?
       ORDER BY id ASC`,
      ).all(runId);
    },
    /** The most recently persisted MAIN-stream event's raw `data` for a run
     *  (`subagent_id IS NULL`, like `seenLineUuidsForTask`), or `null` if the
     *  run has none yet.
     *
     *  Backs `reapIdleSessions`'s idempotence guard: a re-reap regression
     *  would try to append the identical hibernate breadcrumb to the same run
     *  again, and comparing against the last persisted event's exact text is
     *  enough to catch that without a full row fetch. The breadcrumb itself is
     *  a main-stream row, so a subagent row landing afterwards must not
     *  re-arm the guard — hence the filter. */
    lastEventData(runId: string): string | null {
      const row = conn.query<{ data: string }, [string]>(
        `SELECT data FROM run_events WHERE run_id = ? AND subagent_id IS NULL ORDER BY id DESC LIMIT 1`,
      ).get(runId);
      return row ? row.data : null;
    },
    /** The most recently persisted MAIN-stream `tool_use` event's raw `data`
     *  for a run (`subagent_id IS NULL`, same rationale as `lastEventData`: a
     *  subagent's tool call must not be mistaken for the main run's), or
     *  `null` if the run has none.
     *
     *  Backs `detectCursorPlan`'s "is the run's last tool call a
     *  `createPlanToolCall`?" check. That used to be a full `runs.events(runId)`
     *  scan keeping only the last `tool_use` row — correct, but O(run length)
     *  on every settlement of every cursor run, even long ones with no plan at
     *  all. This is the same lookup expressed as a targeted, indexed query.
     *
     *  `INDEXED BY idx_run_events_run` is load-bearing: without it the planner
     *  prefers the partial `idx_run_events_user_history (stream, id DESC)` (it
     *  satisfies `stream = 'tool_use'`, `subagent_id IS NULL` AND the
     *  `ORDER BY id DESC`) and walks EVERY run's `tool_use` rows newest-first
     *  until one belongs to `run_id` — a near-full scan of the table's biggest
     *  stream for an old run. Forcing the `(run_id, id)` index bounds the walk
     *  to this run's rows. */
    lastToolUseData(runId: string): string | null {
      const row = conn.query<{ data: string }, [string]>(
        `SELECT data FROM run_events INDEXED BY idx_run_events_run
       WHERE run_id = ? AND stream = 'tool_use' AND subagent_id IS NULL ORDER BY id DESC LIMIT 1`,
      ).get(runId);
      return row ? row.data : null;
    },
    /**
     * The newest session id `harnessId` ever recorded for a task in `column`,
     * with the run's start time so a caller can compare it against a session
     * handoff. Mirrors `sessionIdsForTask`'s ordering but scoped to one harness
     * in SQL (the existing helper intentionally resolves aliases in JS).
     *
     * A legacy row storing a bare kind is matched through `resolveHarness` by
     * `findLastSessionIdForHarness`; this is the handoff-comparison half, where
     * only exact harness ids matter because a handoff is always written with
     * the destination's real id.
     */
    newestSessionForHarness(
      taskId: string,
      column: SessionIdColumn,
      harnessId: string,
    ): { sessionId: string; startedAt: number } | null {
      const col = SESSION_ID_COLUMNS.find((c) => c === column);
      if (!col) return null;
      const row = conn
        .query<{ sessionId: string | null; startedAt: number }, [string, string]>(
          `SELECT ${col} AS sessionId, started_at AS startedAt
           FROM runs
          WHERE task_id = ? AND agent = ? AND ${col} IS NOT NULL
          ORDER BY started_at DESC, rowid DESC
          LIMIT 1`,
        )
        .get(taskId, harnessId);
      return row?.sessionId ? { sessionId: row.sessionId, startedAt: row.startedAt } : null;
    },
    /**
     * Every MAIN-stream `user` event for a run, oldest first
     * (`subagent_id IS NULL`, like `lastEventData`). Used by a harness-stack
     * clean retry: when the old account hit its limit before any tool call, the
     * successor rebuilds the unanswered request from the whole ordered set —
     * not just the newest row — because a send can be recorded twice (the live
     * echo + the CLI's JSONL twin) and a REPL follow-up folds into the same run.
     * `composeCleanRetryText` (shared/user-message.ts) does the normalization
     * and de-duplication.
     */
    // `twin` is set on a row that carries a `line_uuid` (the Claude JSONL twin
    // of a live echo, which has none); `cleanRetryParts` pairs each echo with
    // at most one twin.
    mainUserRows(runId: string): CleanRetryRow[] {
      return conn
        .query<{ data: string; line_uuid: string | null }, [string]>(
          `SELECT data, line_uuid FROM run_events INDEXED BY idx_run_events_run
         WHERE run_id = ? AND stream = 'user' AND subagent_id IS NULL ORDER BY id ASC`,
        )
        .all(runId)
        .map((row) => ({ data: row.data, twin: row.line_uuid != null }));
    },
    /**
     * Whether a run recorded ANY tool call (main stream or a subagent's — a
     * subagent's side effects are real too). This is the "did the model do
     * anything with side effects?" gate: no tool call → a clean retry of the
     * original prompt on a fresh session; any tool call → transfer + resume.
     */
    hasToolUse(runId: string): boolean {
      return (
        conn
          .query<{ n: number }, [string]>(
            `SELECT 1 AS n FROM run_events INDEXED BY idx_run_events_run
           WHERE run_id = ? AND stream = 'tool_use' LIMIT 1`,
          )
          .get(runId) !== null
      );
    },
    /** Whether a task has a genuinely `running` run row. A held run (row
     *  `succeeded`, background agents still live) is not "live". */
    hasRunning(taskId: string): boolean {
      return (
        conn
          .query<{ n: number }, [string]>(
            `SELECT 1 AS n FROM runs WHERE task_id = ? AND status = 'running' LIMIT 1`,
          )
          .get(taskId) !== null
      );
    },
    /**
     * Find a run's persisted `tool_use` event by its `id` (claude-tmux's
     * `{ id, name, input, serverSide }` shape — see the `case "tool_use"`
     * branch in `claude-tmux.ts`). Backs the sent-files map-miss fallback in
     * the orchestrator (plan §3, decision 4): the in-memory
     * `toolUseId → SentFilesRequest` map is per-run and non-persistent, so an
     * agetor restart mid-flight or a reattach replay can miss it, and this is
     * how the confirming `tool_result` re-derives the original request.
     *
     * There is no index on `(run_id, stream)` — only `idx_run_events_run
     * (run_id, id)` and the partial `idx_run_events_user_history` exist — so
     * this scans the run's rows via `idx_run_events_run` and evaluates
     * `stream = 'tool_use'` plus the `LIKE '%"id":"<toolUseId>"%'` prefilter
     * against each row's `data` column-by-column; that's fine because this
     * fallback is rare (the in-memory map-hit path above almost always
     * resolves it first). The LIKE prefilter still avoids a `JSON.parse` of
     * every tool_use the run ever had, and the 5-row cap bounds the
     * pathological case of many tool_use rows sharing a substring match; each
     * candidate is then `JSON.parse`d and only the first whose parsed `id` field is an
     * EXACT match to `toolUseId` is returned — the LIKE pattern is a filter,
     * never the source of truth, so a substring collision (one id embedded in
     * another) can't misattribute a delivery.
     *
     * `toolUseId` is rejected (returns `null` without querying) when it
     * contains `"` or `\` — either would corrupt the crafted `"id":"…"` JSON
     * substring this pattern searches for, and no real claude tool_use id
     * (`toolu_<hex>`, e.g. `toolu_01AbC…`) ever contains either, so this only
     * ever declines a hostile/malformed id. `%` and `_` are SQL LIKE's own
     * wildcard characters and — unlike `"`/`\` — DO legitimately appear in
     * real ids (every claude tool_use id contains the underscore in its
     * `toolu_` prefix; a reject-on-any-of-four guard, the naive reading, would
     * make this prefilter a permanent no-op against every real id in
     * production) — so instead of rejecting on them, they're escaped with a
     * literal backslash (`ESCAPE '\'`) so LIKE matches them as ordinary
     * characters rather than wildcards. This only narrows the prefilter
     * either way: the loop below still requires an EXACT parsed-JSON `id`
     * match before returning anything, so an unescaped wildcard could only
     * ever widen the candidate set, never cause a wrong match.
     */
    findToolUseEvent(runId: string, toolUseId: string): { id: number; data: string } | null {
      if (/["\\]/.test(toolUseId)) return null;
      const likeSafe = toolUseId.replace(/[%_]/g, "\\$&");

      const rows = conn.query<{ id: number; data: string }, [string, string]>(
        `SELECT id, data FROM run_events
       WHERE run_id = ? AND stream = 'tool_use' AND data LIKE ? ESCAPE '\\'
       ORDER BY id DESC
       LIMIT 5`,
      ).all(runId, `%"id":"${likeSafe}"%`);

      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.data) as { id?: unknown };
          if (parsed && typeof parsed === "object" && parsed.id === toolUseId) {
            return { id: row.id, data: row.data };
          }
        } catch {
          // Malformed JSON on a LIKE-matched row — skip it, don't throw; the
          // next candidate (or the eventual `null`) is the right outcome.
        }
      }
      return null;
    },
    /** All events across every run of a task, in event-id order (which is
     *  chronological — id is autoincrement, ts can collide when bursts of
     *  events land in the same Date.now() ms). Used by the unified
     *  task-level stream so the panel shows the whole conversation as one
     *  scrollback instead of per-run silos.
     *
     *  With no `opts` (or no `opts.limit`), returns the full unbounded
     *  ascending history — the original behavior, kept for existing callers
     *  (tests, `rebuildEventsFromJsonl`-adjacent tooling) that want everything.
     *
     *  With `opts.limit` set, returns only the MOST RECENT `limit` events:
     *  filters `id < opts.beforeId` when given, orders by id DESC, takes
     *  `limit`, then re-sorts ascending. This is what powers the capped SSE
     *  replay window and the `/events/page` paging route — both want "the
     *  newest N (before some cursor)", not "the first N".
     *
     *  The limit path is a two-step query, not one. A single
     *  `SELECT … ORDER BY run_events.id DESC LIMIT ?` still has to sort every
     *  matching row before it can take the top N — `EXPLAIN QUERY PLAN` shows
     *  SQLite picks the covering index for the join+filter but then falls back
     *  to `USE TEMP B-TREE FOR ORDER BY`, and that b-tree materializes the full
     *  `data` payload (often the largest column by far) for EVERY event the
     *  task ever had, not just the `limit` returned. Measured 219.5ms on a
     *  production task with 18.5k events. Splitting it in two fixes that:
     *   1. Sort ids only (`SELECT run_events.id …`) — no `data` payload in the
     *      row, so the temp b-tree rides the covering index
     *      (`idx_run_events_run(run_id, id)`) instead of materializing text.
     *   2. Fetch the actual rows for that exact id range, ascending (no
     *      reverse needed) — a plain indexed range scan, not a sort.
     *  Measured 14.8ms + 3.9ms ≈ 19ms for the identical 800-row result on the
     *  same task — an ~11x improvement, no schema change.
     *
     *  Step 2 re-applies `beforeId` (not just the `id >= minId` floor coming
     *  out of step 1): without it, events newer than the cursor — i.e. events
     *  the caller has already seen, or that landed on a DIFFERENT run of the
     *  same task with an id inside `[minId, taskMax]` but still `>= beforeId`
     *  — would wrongly re-enter the page. `id >= minId` alone only bounds the
     *  page from below; `beforeId` is what bounds it from above, exactly as it
     *  did in the one-query version.
     *
     *  `opts.maxBytes` layers a BYTE budget on top of `opts.limit`'s event-count
     *  cap (see `EVENTS_REPLAY_MAX_BYTES` / `EVENTS_PAGE_MAX_BYTES` in
     *  `shared/types.ts`): step 1 additionally selects each row's
     *  `LENGTH(data)`, then `clampWindowByBytes` walks the DESC id rows
     *  newest → oldest accumulating that length and raises `minId` to stop
     *  once the budget would be exceeded — never below `opts.minEvents`
     *  (`MIN_REPLAY_EVENTS`) rows, so a task whose newest event alone exceeds
     *  the budget still returns something. Step 2 is otherwise unchanged: it
     *  just ends up scanning a narrower `[minId, taskMax]` range. When
     *  `opts.maxBytes` is omitted the byte walk never runs — this path is
     *  byte-identical to before it existed.
     *
     *  `opts.anchor` (additive, only meaningful together with `opts.limit`)
     *  extends the window's floor back to the newest main-stream `user` event
     *  when that fits under `anchor.maxEvents`/`anchor.maxBytes` — see
     *  `docs/plans/first-load-reaches-last-user-message.md` §3 and
     *  `resolveAnchoredMinId` above, which makes the actual fit/no-fit call.
     *  After the byte walk settles `minId`: look up the anchor id via
     *  `lastUserEventId(taskId, opts.beforeId)` (same cursor the rest of this
     *  call already respects); if it exists and sits BEFORE `minId` (i.e. the
     *  default window doesn't already reach it), assemble the DESC `{id, len}`
     *  rows of the whole span `[anchorId, beforeId)` — anchor to newest, since
     *  the ceilings must cover the entire resulting window, not just the part
     *  below the old floor — from step 1's own rows (`[minId, beforeId)`, already
     *  in memory) plus one bounded read of `[anchorId, minId)`, capped so the
     *  total never exceeds `anchor.maxEvents + 1` rows, and hand them to
     *  `resolveAnchoredMinId`. Its return either leaves `minId` alone (span
     *  too large in count or bytes) or lowers it to `anchorId`.
     *  Step 2's `LIMIT` becomes `max(opts.limit, opts.anchor.maxEvents)` in
     *  that case: the `[minId, beforeId)` range fetched by step 2 is already
     *  exact once `minId` is anchored, so `LIMIT` is only a defensive cap —
     *  leaving it at the plain `opts.limit` would truncate the NEWEST rows of
     *  a window that just grew past that count. Without `opts.anchor` this
     *  function is byte-identical to before the option existed, including
     *  step 2's `LIMIT opts.limit`. */
    eventsForTask(
      taskId: string,
      opts?: {
        beforeId?: number;
        limit?: number;
        maxBytes?: number;
        minEvents?: number;
        anchor?: { maxEvents: number; maxBytes: number };
      },
    ): TaskEventRow[] {
      type Row = TaskEventRow;
      if (opts?.limit) {
        const idConditions = ["runs.task_id = ?"];
        const idParams: Array<string | number> = [taskId];
        if (opts.beforeId != null) {
          idConditions.push("run_events.id < ?");
          idParams.push(opts.beforeId);
        }
        idParams.push(opts.limit);
        const idRows = conn.query<{ id: number; len: number }, Array<string | number>>(
          `SELECT run_events.id as id, LENGTH(CAST(run_events.data AS BLOB)) as len
         FROM run_events
         JOIN runs ON runs.id = run_events.run_id
         WHERE ${idConditions.join(" AND ")}
         ORDER BY run_events.id DESC
         LIMIT ?`,
        ).all(...idParams);
        if (idRows.length === 0) return [];
        // DESC order — the last row is the smallest id in the page.
        let minId = idRows[idRows.length - 1]!.id;
        if (opts.maxBytes != null) {
          const clampedId = clampWindowByBytes(idRows, opts.maxBytes, opts.minEvents ?? 1);
          if (clampedId != null) minId = clampedId;
        }

        if (opts.anchor) {
          const anchorId = runs.lastUserEventId(taskId, opts.beforeId);
          if (anchorId != null && anchorId < minId) {
            // The span `resolveAnchoredMinId` judges is `[anchorId, beforeId)`
            // — anchor to newest — but its upper part, `[minId, beforeId)`, is
            // exactly the default window step 1 already fetched (with `len`),
            // so only the part BELOW the current floor, `[anchorId, minId)`, is
            // read from the DB. Its LIMIT is the remaining room under the count
            // ceiling (+1, so a span that overflows it is detectable by length
            // alone) — the returned row count is bounded by that, though the
            // ORDER BY still sorts every task row in the range through a temp
            // b-tree (same plan shape as step 1, over a strict subset of its
            // rows). No room left means the window alone already exceeds the
            // ceiling: skip the read, `resolveAnchoredMinId` rejects on count.
            const windowRowsDesc = idRows.filter((r) => r.id >= minId);
            const room = opts.anchor.maxEvents + 1 - windowRowsDesc.length;
            let spanRowsDesc = windowRowsDesc;
            if (room > 0) {
              const belowRowsDesc = conn.query<{ id: number; len: number }, Array<string | number>>(
                `SELECT run_events.id as id, LENGTH(CAST(run_events.data AS BLOB)) as len
               FROM run_events
               JOIN runs ON runs.id = run_events.run_id
               WHERE runs.task_id = ? AND run_events.id >= ? AND run_events.id < ?
               ORDER BY run_events.id DESC
               LIMIT ?`,
              ).all(taskId, anchorId, minId, room);
              spanRowsDesc = windowRowsDesc.concat(belowRowsDesc);
            }
            minId = resolveAnchoredMinId({
              minId,
              anchorId,
              spanRowsDesc,
              maxEvents: opts.anchor.maxEvents,
              maxBytes: opts.anchor.maxBytes,
            });
          }
        }

        const rowConditions = ["runs.task_id = ?", "run_events.id >= ?"];
        const rowParams: Array<string | number> = [taskId, minId];
        if (opts.beforeId != null) {
          rowConditions.push("run_events.id < ?");
          rowParams.push(opts.beforeId);
        }
        // Once `opts.anchor` may have lowered `minId` past `opts.limit` events
        // back, the exact `[minId, beforeId)` range must not be truncated by a
        // `LIMIT` still pinned at the pre-anchor count — see the doc comment
        // above `eventsForTask`.
        rowParams.push(opts.anchor ? Math.max(opts.limit, opts.anchor.maxEvents) : opts.limit);
        return conn.query<Row, Array<string | number>>(
          `SELECT run_events.id as id, run_events.run_id as runId, stream, data, ts, run_events.subagent_id as subagentId
         FROM run_events
         JOIN runs ON runs.id = run_events.run_id
         WHERE ${rowConditions.join(" AND ")}
         ORDER BY run_events.id ASC
         LIMIT ?`,
        ).all(...rowParams);
      }
      return conn.query<Row, [string]>(
        `SELECT run_events.id as id, run_events.run_id as runId, stream, data, ts, run_events.subagent_id as subagentId
       FROM run_events
       JOIN runs ON runs.id = run_events.run_id
       WHERE runs.task_id = ?
       ORDER BY run_events.id ASC`,
      ).all(taskId);
    },
    /**
     * Forward resume for the per-task event stream (docs/plans/
     * event-stream-forward-resume.md P3): the task's rows with `id > afterId`,
     * ascending, subagent rows included — or a refusal when the gap is too big
     * or the cursor is foreign.
     *
     * Same two-step shape as `eventsForTask`, so a big gap never loads bodies:
     *  1. Read `sqlite_sequence.seq` for `run_events` (the AUTOINCREMENT
     *     high-water mark; 0 when the row is absent) and probe the IDS of the
     *     task's rows after the cursor, `LIMIT maxEvents + 1` — the +1 row
     *     proves "too many" without an unbounded read. Ids only, so
     *     `(run_id, id)` covers the probe and no row body is read. The
     *     temp-B-tree sort is bounded too: each run's index range yields ids
     *     in order, so SQLite stops a run's walk once the LIMIT sorter is full
     *     and holds a smaller id — measured ~1 ms at any cursor on a 1M-row
     *     task over 20 runs (a per-run LIMIT + JS merge was slower: 37 ms at
     *     300 runs).
     *  2. Only when the count fits, size the bounded range (`id > afterId AND
     *     id <= lastProbedId`, at most `maxEvents` rows) with
     *     `LENGTH(CAST(data AS BLOB))`. `decideForwardResume` (pure, shared
     *     with the future remote router) makes the call.
     *  3. On resume, fetch the full rows for that same range. Bounding by the
     *     last probed id keeps the steps consistent if an event lands in
     *     between (it reaches the client through the live stream instead).
     *
     *  Plans as `SEARCH runs USING INDEX idx_runs_task` + `SEARCH run_events
     *  USING INDEX idx_run_events_run (run_id=? AND id>?)`; `INDEXED BY` pins
     *  the index so SQLite can't pick the `stream`-first user-history one.
     */
    eventsForTaskAfter(
      taskId: string,
      afterId: number,
      opts: { maxEvents: number; maxBytes: number },
    ): ForwardResumeResult {
      const seqRow = conn
        .query<{ seq: number }, []>(`SELECT seq FROM sqlite_sequence WHERE name = 'run_events'`)
        .get();
      const highWater = seqRow?.seq ?? 0;
      const gapIdsAsc = conn
        .query<{ id: number }, [string, number, number]>(
          `SELECT run_events.id as id
         FROM run_events INDEXED BY idx_run_events_run
         JOIN runs ON runs.id = run_events.run_id
         WHERE runs.task_id = ? AND run_events.id > ?
         ORDER BY run_events.id ASC
         LIMIT ?`,
        )
        .all(taskId, afterId, opts.maxEvents + 1);
      // Over the count budget (or empty) the sizes can't change the answer —
      // `decideForwardResume` checks the count before the bytes — so skip the
      // body read and hand it zero lengths.
      const gapRowsAsc =
        gapIdsAsc.length === 0 || gapIdsAsc.length > opts.maxEvents
          ? gapIdsAsc.map((r) => ({ id: r.id, len: 0 }))
          : conn
              .query<{ id: number; len: number }, [string, number, number]>(
                `SELECT run_events.id as id, LENGTH(CAST(run_events.data AS BLOB)) as len
               FROM run_events INDEXED BY idx_run_events_run
               JOIN runs ON runs.id = run_events.run_id
               WHERE runs.task_id = ? AND run_events.id > ? AND run_events.id <= ?
               ORDER BY run_events.id ASC`,
              )
              .all(taskId, afterId, gapIdsAsc[gapIdsAsc.length - 1]!.id);
      const decision = decideForwardResume({
        afterId,
        highWater,
        gapRowsAsc,
        maxEvents: opts.maxEvents,
        maxBytes: opts.maxBytes,
      });
      if (decision.kind === "snapshot") return decision;
      if (gapRowsAsc.length === 0) return { kind: "resume", rows: [] };
      const lastProbedId = gapRowsAsc[gapRowsAsc.length - 1]!.id;
      const rows = conn
        .query<TaskEventRow, [string, number, number]>(
          `SELECT run_events.id as id, run_events.run_id as runId, stream, data, ts, run_events.subagent_id as subagentId
         FROM run_events INDEXED BY idx_run_events_run
         JOIN runs ON runs.id = run_events.run_id
         WHERE runs.task_id = ? AND run_events.id > ? AND run_events.id <= ?
         ORDER BY run_events.id ASC`,
        )
        .all(taskId, afterId, lastProbedId);
      return { kind: "resume", rows };
    },
    /** Past sent user messages (main-stream only, blank ones excluded) across
     *  every task, regardless of harness — used to build a cross-task "message
     *  history" picker shared by all tasks. Byte-identical texts are collapsed
     *  to their most recent occurrence via `GROUP BY data` + `MAX(id)`:
     *  SQLite's bare-column-with-single-MAX semantics
     *  (https://www.sqlite.org/lang_select.html#bareagg) guarantees the other
     *  selected columns come from that same max-id row. */
    userMessageHistory(
      limit: number,
    ): Array<{ id: number; data: string; ts: number; taskId: string; taskTitle: string; taskWorkdir: string; projectName: string | null; taskAgent: string }> {
      type Row = { id: number; data: string; ts: number; taskId: string; taskTitle: string; taskWorkdir: string; projectName: string | null; taskAgent: string };
      return conn.query<Row, [number]>(
        `SELECT MAX(run_events.id) as id, run_events.data as data, ts, tasks.id as taskId, tasks.title as taskTitle,
              tasks.workdir as taskWorkdir, projects.name as projectName, tasks.agent as taskAgent
       FROM run_events
       JOIN runs ON runs.id = run_events.run_id
       JOIN tasks ON tasks.id = runs.task_id
       LEFT JOIN projects ON projects.path = tasks.workdir
       WHERE run_events.stream = 'user'
         AND run_events.subagent_id IS NULL
         AND trim(run_events.data, char(32,9,10,13)) != ''
       GROUP BY run_events.data
       ORDER BY id DESC
       LIMIT ?`,
      ).all(limit);
    },
    /** Todo-family tool events for a task, across every run, in event-id
     *  (chronological) order — main-stream only (`subagent_id IS NULL`, same
     *  rationale as `lastEventData`/`lastToolUseData`: a background agent's own
     *  TodoWrite/TaskCreate/TaskUpdate calls track ITS todos, not the primary
     *  task's, and must not be mixed into the board summary).
     *
     *  Two different LIKE shapes for the two streams, deliberately NOT a
     *  single shared marker set (mirrors `isTodoFamilyChunk` in
     *  orchestrator.ts, same split for the same reason):
     *   - `tool_use` rows carry `"name":"<Tool>"` in their JSON envelope, so
     *     the filter matches that literal envelope form rather than a bare
     *     substring — a bare `LIKE '%TaskCreate%'` also matches an unrelated
     *     tool_result whose text happens to quote "TaskCreate" (this repo
     *     dogfoods itself, so that's a real false positive, not a theoretical
     *     one).
     *   - `tool_result` rows have NO tool name at all (`{toolUseId, content,
     *     isError}`) — only `TaskCreate`'s result is ever consulted by
     *     `deriveTodoProgress` (to resolve the "Task #N" number), and always
     *     via the fixed `"Task #N created successfully"` text Claude emits, so
     *     that's the cheapest-but-correct marker: cheaper than admitting every
     *     tool_result row for the task (most of which `deriveTodoProgress`
     *     would just discard by unmatched `toolUseId`), and correct because it
     *     targets the exact literal all TaskCreate results share.
     *  Backs the orchestrator chunk handler's board-summary update: rare
     *  chunks, so a full re-derive per call is cheap, and because the chunk
     *  handler always calls `runs.appendEvent` before running this query (see
     *  `makeChunkHandler`), the just-arrived chunk is already included — no
     *  separate "append the current chunk" step needed. */
    todoRelevantEventsForTask(taskId: string): Array<{ stream: string; data: string }> {
      return conn.query<{ stream: string; data: string }, [string]>(
        `SELECT stream, data
       FROM run_events
       JOIN runs ON runs.id = run_events.run_id
       WHERE runs.task_id = ?
         AND run_events.subagent_id IS NULL
         AND (
           (run_events.stream = 'tool_use' AND (
             data LIKE '%"name":"TodoWrite"%'
             OR data LIKE '%"name":"TaskCreate"%'
             OR data LIKE '%"name":"TaskUpdate"%'
           ))
           OR (run_events.stream = 'tool_result' AND data LIKE '%created successfully%')
         )
       ORDER BY run_events.id ASC`,
      ).all(taskId);
    },
    /** Cheap existence check — is there at least one persisted event for this
     *  task older than `beforeId`? Backs the `hasMore` flag on both the SSE
     *  `replay_meta` frame and the `/events/page` paging route, so the client
     *  knows whether to keep showing "Load earlier" without fetching (and
     *  counting) the whole remaining history. */
    hasEventsBefore(taskId: string, beforeId: number): boolean {
      const row = conn.query<{ 1: number }, [string, number]>(
        `SELECT 1 FROM run_events
       JOIN runs ON runs.id = run_events.run_id
       WHERE runs.task_id = ? AND run_events.id < ?
       LIMIT 1`,
      ).get(taskId, beforeId);
      return row !== null;
    },
    /**
     * The id of the newest MAIN-stream `user` event for a task — the "last
     * user sent message" anchor for the first-load window extension (see
     * `resolveAnchoredMinId` above and
     * `docs/plans/first-load-reaches-last-user-message.md`), or `null` when
     * the task has no such event (e.g. only status breadcrumbs so far).
     * `subagent_id IS NULL` (main-stream only) matches `lastEventData`'s
     * rationale — a background subagent's own `user` turns are its own
     * conversation, not the primary task's. `beforeId`, when given, excludes
     * events at or after that id, mirroring every other paging cursor in this
     * file. SQLite serves this from migration 039's partial index
     * `idx_run_events_user_history (stream, id DESC) WHERE subagent_id IS NULL`
     * (verified with EXPLAIN QUERY PLAN): it walks main-stream `user` rows
     * newest-first ACROSS EVERY TASK, probing `runs` by primary key on each
     * until one belongs to this task — the index carries no run/task column,
     * so the cost is bounded by how many user messages landed anywhere since
     * this task's last one, NOT by this task's own history length. User rows
     * are sparse (a few thousand across a multi-hundred-thousand-event DB) and
     * every started task has at least its prompt echo, so this is a few ms in
     * practice; a partial index on `(run_id, stream, id DESC)` would make it
     * terminate inside the task's own runs if that ever changes.
     *
     * A harness-stack continuation (agetor's own hidden send after an account
     * swap, docs/architecture/harness-stacks.md) is never the anchor: every
     * renderer hides it, so anchoring on it would cut the window just above an
     * invisible row and drop the user's real last message out of the first
     * load. The query reads the newest `LAST_USER_ANCHOR_PAGE` user rows with a
     * cheap `instr` flag for the tag, re-reads the full text of a flagged row by
     * primary key, and pages further back (same index, `id < last`) only when
     * every row on the page is a hidden continuation, which a task only has one
     * of per swap.
     */
    lastUserEventId(taskId: string, beforeId?: number): number | null {
      let cursor = beforeId;
      for (;;) {
        const conditions = ["runs.task_id = ?", "run_events.stream = 'user'", "run_events.subagent_id IS NULL"];
        const params: Array<string | number> = [CONTINUATION_OPEN_TAG, taskId];
        if (cursor != null) {
          conditions.push("run_events.id < ?");
          params.push(cursor);
        }
        const rows = conn.query<{ id: number; flagged: number }, Array<string | number>>(
          `SELECT run_events.id as id, instr(run_events.data, ?) > 0 as flagged
         FROM run_events
         JOIN runs ON runs.id = run_events.run_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY run_events.id DESC
         LIMIT ${LAST_USER_ANCHOR_PAGE}`,
        ).all(...params);
        for (const row of rows) {
          if (!row.flagged) return row.id;
          const data = conn
            .query<{ data: string }, [number]>(`SELECT data FROM run_events WHERE id = ?`)
            .get(row.id)?.data;
          if (data == null || !isHiddenContinuationUserText(data)) return row.id;
        }
        if (rows.length < LAST_USER_ANCHOR_PAGE) return null;
        cursor = rows[rows.length - 1]!.id;
      }
    },
    /**
     * Returns the stored `{ id, ts }`, or `null` when nothing was actually
     * inserted — i.e. the `INSERT OR IGNORE` dedup path hit an existing
     * `(run_id, line_uuid)` row. `null` means "already persisted earlier,
     * don't re-derive from it" (the unread-watermark detector in
     * `makeChunkHandler` relies on it) rather than misreading a stale
     * `lastInsertRowid` left over from some unrelated prior statement on this
     * connection. Callers send the returned pair live, so a streamed frame
     * carries the same `id` and `ts` as its replayed row (forward resume,
     * docs/plans/event-stream-forward-resume.md D11/P1). `ts` defaults to now;
     * a caller that already stamped the event passes it so both agree.
     */
    appendEvent(
      runId: string,
      stream: RunEventStream,
      data: string,
      lineUuid?: string | null,
      subagentId?: string | null,
      ts?: number,
    ): AppendedEvent | null {
      const stamp = ts ?? Date.now();
      // INSERT OR IGNORE only when a dedup key is provided. With NULL keys the
      // partial unique index (`WHERE line_uuid IS NOT NULL`) doesn't apply, so
      // non-JSONL events still insert unconditionally and we don't accidentally
      // suppress two genuinely distinct status/stderr rows that happen to share
      // (runId, NULL).
      if (lineUuid) {
        const result = conn.run(
          `INSERT OR IGNORE INTO run_events (run_id, stream, data, ts, line_uuid, subagent_id) VALUES (?, ?, ?, ?, ?, ?)`,
          [runId, stream, data, stamp, lineUuid, subagentId ?? null],
        );
        return result.changes > 0 ? { id: Number(result.lastInsertRowid), ts: stamp } : null;
      }
      const result = conn.run(
        `INSERT INTO run_events (run_id, stream, data, ts, subagent_id) VALUES (?, ?, ?, ?, ?)`,
        [runId, stream, data, stamp, subagentId ?? null],
      );
      return { id: Number(result.lastInsertRowid), ts: stamp };
    },
    /** Line uuids persisted on one run. Seeds `currentRunLineUuids` on
     *  reattach so a historical `end_turn` that lives on a different run
     *  (an imported seed run) dedups without staging. Uses the partial unique
     *  index `run_events_run_line_uuid (run_id, line_uuid) WHERE line_uuid IS
     *  NOT NULL`. Includes subagent-tagged rows: the running run's own
     *  `end_turn` uuids are what the gate cares about, and a subagent uuid
     *  in the set is harmless. */
    seenLineUuidsForRun(runId: string): Set<string> {
      const rows = conn.query<{ line_uuid: string }, [string]>(
        `SELECT line_uuid FROM run_events WHERE run_id = ? AND line_uuid IS NOT NULL`,
      ).all(runId);
      return new Set(rows.map((r) => r.line_uuid));
    },
    /** Every non-null `runs.claude_session_id`. One query, served by
     *  `runs_claude_session_id_idx`. The scanner hides the union of this set
     *  and the import claim column — see {@link hiddenClaudeSessionIds}. */
    claudeSessionIds(): Set<string> {
      const rows = conn.query<{ claude_session_id: string }, []>(
        `SELECT claude_session_id FROM runs WHERE claude_session_id IS NOT NULL`,
      ).all();
      return new Set(rows.map((r) => r.claude_session_id));
    },
    /** Every non-null `runs.opencode_session_id` — the OpenCode ids Agetor
     *  owns as runs. One query, served by `runs_opencode_session_id_idx`
     *  (migration 079). The scanner hides the union of this set and the import
     *  claim column — see {@link hiddenOpencodeSessionIds}. */
    opencodeSessionIdsOwned(): Set<string> {
      const rows = conn.query<{ opencode_session_id: string }, []>(
        `SELECT opencode_session_id FROM runs WHERE opencode_session_id IS NOT NULL`,
      ).all();
      return new Set(rows.map((r) => r.opencode_session_id));
    },
    /** True when any run already records this OpenCode session id. */
    hasOpencodeSessionId(sessionId: string): boolean {
      if (!sessionId) return false;
      const row = conn.query<{ one: number }, [string]>(
        `SELECT 1 AS one FROM runs WHERE opencode_session_id = ? LIMIT 1`,
      ).get(sessionId);
      return row != null;
    },
    /**
     * Every non-null session id recorded in `column` across a task's runs,
     * newest run first, each with the run's `agent` (the harness id that ran
     * it). The building block for harness-scoped resume
     * (`findLastSessionIdForHarness`, docs/plans/add-opencode-harness.md
     * D-15): a caller picks the newest row whose `agent` matches the task's
     * current harness, so a same-kind harness switch never resumes the other
     * account's session. `column` is a closed whitelist (it is interpolated
     * into the SQL); anything outside {@link SESSION_ID_COLUMNS} throws.
     * Reads `runs` only — never `run_events`.
     *
     * `opts.excludeRunId` drops that run's row. The harness-stack
     * "did a conversation exist BEFORE this turn?" check uses it so a limit in
     * the task's very first turn stays a clean retry, while a follow-up turn
     * that already has an earlier session keeps its history (R11-M1).
     */
    sessionIdsForTask(
      taskId: string,
      column: SessionIdColumn,
      opts: { excludeRunId?: string } = {},
    ): { sessionId: string; agent: string }[] {
      if (!SESSION_ID_COLUMNS.includes(column)) throw new Error(`unknown session id column: ${String(column)}`);
      const excludeRunId = opts.excludeRunId;
      if (excludeRunId) {
        return conn.query<{ sessionId: string; agent: string }, [string, string]>(
          `SELECT ${column} AS sessionId, agent FROM runs
           WHERE task_id = ? AND id <> ? AND ${column} IS NOT NULL
           ORDER BY started_at DESC, rowid DESC`,
        ).all(taskId, excludeRunId);
      }
      return conn.query<{ sessionId: string; agent: string }, [string]>(
        `SELECT ${column} AS sessionId, agent FROM runs
         WHERE task_id = ? AND ${column} IS NOT NULL
         ORDER BY started_at DESC, rowid DESC`,
      ).all(taskId);
    },
    /**
     * Every task with a run that recorded `sessionId` in `column`, of any agent.
     * The orphaned-copy sweep asks each one whether the session is still the one
     * it resumes on the swept account, so a planted orphan record naming a live
     * conversation never deletes its transcript. Both columns are indexed
     * (068's `runs_claude_session_id_idx`, 090's `runs_codex_session_id_idx`),
     * and the sweep runs it once per orphan group, not per file.
     */
    taskIdsWithSession(column: SessionIdColumn, sessionId: string): string[] {
      const col = SESSION_ID_COLUMNS.find((c) => c === column);
      if (!col || !sessionId) return [];
      return conn
        .query<{ task_id: string }, [string]>(`SELECT DISTINCT task_id FROM runs WHERE ${col} = ?`)
        .all(sessionId)
        .map((r) => r.task_id);
    },
    /** True when any run already records this Claude session id. Not a
     *  uniqueness check — several runs on one task share an id. */
    hasClaudeSessionId(sessionId: string): boolean {
      if (!sessionId) return false;
      const row = conn.query<{ one: number }, [string]>(
        `SELECT 1 AS one FROM runs WHERE claude_session_id = ? LIMIT 1`,
      ).get(sessionId);
      return row != null;
    },
    /** Return every JSONL line uuid already persisted across *every* run of
     *  this task. Used by `reattachSession` to seed the in-memory dedup set so
     *  re-tailing the per-session JSONL from offset 0 (after an agetor
     *  restart) skips events we already streamed in the previous process.
     *
     *  Scoped to the task (not just the reattached run) on purpose: one tmux
     *  session = one JSONL file = all of a task's turns. The replay from
     *  offset 0 will encounter end_turn lines from prior, already-`succeeded`
     *  run rows; without those uuids in the dedup set the dispatcher would
     *  re-emit them onto the reattached (still-`running`) run's chunk
     *  handler — corrupting its event history and, worse, firing
     *  `onEndOfTurn` on the wrong turn and prematurely resolving the
     *  current run.
     *
     *  `subagent_id IS NULL`: this seeds the MAIN session tailer's dedup set
     *  only — subagent transcripts live in separate sidechain files and are
     *  deduped independently via `seenLineUuidsForSubagent`, keyed by
     *  `(run_id, subagent_id, line_uuid)`. Mixing subagent uuids into this set
     *  is a no-op in practice (uuid namespaces don't collide) but is the wrong
     *  scope conceptually, and matches the same filter applied elsewhere for
     *  subagent-tagged rows. */
    seenLineUuidsForTask(taskId: string): Set<string> {
      const rows = conn.query<{ line_uuid: string }, [string]>(
        `SELECT e.line_uuid
       FROM run_events e
       JOIN runs r ON r.id = e.run_id
       WHERE r.task_id = ? AND e.line_uuid IS NOT NULL AND e.subagent_id IS NULL`,
      ).all(taskId);
      return new Set(rows.map((r) => r.line_uuid));
    },
    /** Line uuids already persisted for a single subagent's stream. Seeds the
     *  subagent tailer's in-memory dedup set on reattach so re-reading
     *  `agent-<id>.jsonl` from offset 0 doesn't double-insert/emit events the
     *  previous process already streamed.
     *
     *  TASK-SCOPED, and spelled to hit one specific index: the only index that
     *  mentions `subagent_id` is the partial unique
     *  `run_events_run_sub_line_uuid (run_id, IFNULL(subagent_id, ''), line_uuid)
     *  WHERE line_uuid IS NOT NULL` (migrations/022_subagents.sql). A bare
     *  `WHERE subagent_id = ?` cannot use it (the leading column is `run_id`),
     *  so the old query was `SCAN run_events USING INDEX …` — a full pass over
     *  a multi-GB table per subagent (~1.1 s each on a 4.5 GB DB, ~105 s for a
     *  96-subagent task, all on the Bun main thread). Joining through `runs` by
     *  `task_id` supplies the leading `run_id` equality, and
     *  `IFNULL(e.subagent_id, '') = ?` matches the index EXPRESSION exactly (the
     *  spelling is load-bearing: `e.subagent_id = ?` would not match the
     *  expression and falls back to a scan). SQLite then does a covering SEARCH
     *  per run of the task — `line_uuid` is in the index, so no table lookup.
     *
     *  Task scoping is a strict superset of run scoping: every subagent's events
     *  are written under its own task's runs (and `subagents.id` is a global
     *  primary key), so no event for `subagentId` can live under another task's
     *  runs. Pinned by the `EXPLAIN QUERY PLAN` guard test over every
     *  `run_events` query. */
    seenLineUuidsForSubagent(taskId: string, subagentId: string): Set<string> {
      const rows = conn.query<{ line_uuid: string }, [string, string]>(
        `SELECT e.line_uuid
       FROM runs r JOIN run_events e ON e.run_id = r.id
       WHERE r.task_id = ? AND IFNULL(e.subagent_id, '') = ? AND e.line_uuid IS NOT NULL`,
      ).all(taskId, subagentId);
      return new Set(rows.map((r) => r.line_uuid));
    },
    /** Whether ANY persisted event for `subagentId` carries a `line_uuid`
     *  starting with `prefix` — a targeted probe for a marker key such as
     *  claude-subagents.ts's `monitor:<id>:terminal:` (an authoritative Monitor
     *  receipt on record), cheaper than materialising every uuid via
     *  `seenLineUuidsForSubagent` just to scan a chatty stream for one prefix.
     *  Compared with `substr` rather than `LIKE` so a `%`/`_` in the prefix
     *  can't widen the match.
     *
     *  Same task-scoped, `IFNULL(e.subagent_id, '')` shape as
     *  `seenLineUuidsForSubagent` (see there for why both are load-bearing): a
     *  covering SEARCH of `run_events_run_sub_line_uuid` per run of the task,
     *  stopping at the first match. */
    hasLineUuidPrefixForSubagent(taskId: string, subagentId: string, prefix: string): boolean {
      const row = conn.query<{ one: number }, [string, string, string, string]>(
        `SELECT 1 as one
       FROM runs r JOIN run_events e ON e.run_id = r.id
       WHERE r.task_id = ? AND IFNULL(e.subagent_id, '') = ? AND e.line_uuid IS NOT NULL
         AND substr(e.line_uuid, 1, length(?)) = ?
       LIMIT 1`,
      ).get(taskId, subagentId, prefix, prefix);
      return row !== null;
    },
    /** Whether a run already has a persisted MAIN-stream api-error status line
     *  (`status` event whose data starts with `prefix`, i.e.
     *  `CLAUDE_API_ERROR_STATUS_PREFIX`). Lifted verbatim from the boot
     *  reattach path in the orchestrator, which pre-seeds `handle.apiError` from
     *  it: the reattach replay can't re-emit the status (its assistant-line uuid
     *  is already in the seen set), so without the seed `attachDoneHandler`
     *  would bounce a `blocked` column back to `review`.
     *
     *  `subagent_id IS NULL`: a subagent tailer's own transient api-error status
     *  row (since #81) must not seed the main run's flag. Run-scoped, so it
     *  walks `idx_run_events_run (run_id, id)`; `EXISTS` short-circuits on the
     *  first match. `prefix` is matched with `LIKE prefix%` exactly as before
     *  (the callers pass a fixed constant with no wildcard characters).
     *
     *  `INDEXED BY idx_run_events_run` for the same reason as `lastToolUseData`:
     *  with no `sqlite_stat1` the planner otherwise picks the partial
     *  `idx_run_events_user_history (stream=?)` and walks every `status` event
     *  in the database (with a table lookup each, `run_id` not being in that
     *  index) whenever the run has no api-error line — the common case. */
    hasPriorApiErrorStatus(runId: string, prefix: string): boolean {
      const row = conn.query<{ found: 0 | 1 }, [string, string]>(
        `SELECT EXISTS(
         SELECT 1 FROM run_events INDEXED BY idx_run_events_run
         WHERE run_id = ? AND stream = 'status' AND data LIKE ? AND subagent_id IS NULL
       ) AS found`,
      ).get(runId, `${prefix}%`);
      return (row?.found ?? 0) === 1;
    },
    /** `data` of the newest main-or-subagent `status` event on `runId` whose
     *  text starts with `prefix` (e.g. fx's `FX_RECOVERY_STATUS_PREFIX`
     *  sentinel), or null. Lifted from `orchestrator.ts`'s
     *  `latestResumableFxPause` so the run_events plan guard covers it; pinned
     *  to `idx_run_events_run` for the same reason as `hasPriorApiErrorStatus`
     *  — without `sqlite_stat1` the `stream = ?` term can steer SQLite onto
     *  `idx_run_events_user_history` and a walk of every status row in the
     *  database. `LIKE` is used only with a caller-supplied literal prefix. */
    lastStatusDataWithPrefix(runId: string, prefix: string): string | null {
      const row = conn.query<{ data: string }, [string, string]>(
        `SELECT data FROM run_events INDEXED BY idx_run_events_run
       WHERE run_id = ? AND stream = 'status' AND data LIKE ?
       ORDER BY id DESC LIMIT 1`,
      ).get(runId, `${prefix}%`);
      return row?.data ?? null;
    },
    /** One keyset page of a run's `tool_result` rows that archived-history
     *  retention may trim: payload over `minBytes` (UTF-8 bytes — `LENGTH` of a
     *  BLOB cast, since `LENGTH(text)` counts characters), not already carrying
     *  the retention marker, `id > afterId`, ascending, at most `limit` rows.
     *
     *  The marker prefilter is a SQL `substr` on the first 13 bytes
     *  (`{"retention":`) rather than a JSON parse: a trimmed row re-serializes
     *  with the `retention` key FIRST (see `trimToolResultData`), so already
     *  trimmed rows are skipped without being read, which makes the pass
     *  idempotent and crash-resumable. The query walks `idx_run_events_run
     *  (run_id, id)` in id order — `id > ?` is a range on the index's second
     *  column and `ORDER BY id` is satisfied by it, so there is no temp b-tree
     *  sort (pinned by `TOOL_RESULT_TRIM_SQL`'s plan-guard test). */
    toolResultRowsForTrim(
      runId: string,
      minBytes: number,
      afterId: number,
      limit: number,
    ): Array<{ id: number; data: string }> {
      return conn.query<{ id: number; data: string }, [string, number, number, number]>(
        TOOL_RESULT_TRIM_SQL,
      ).all(runId, minBytes, afterId, limit);
    },
    /** Replace ONE event's `data` payload in place — the retention trim's write.
     *  A targeted UPDATE of `data` only: `id`, `stream`, `ts`, `line_uuid` and
     *  `subagent_id` stay untouched, so the `(run_id, IFNULL(subagent_id,''),
     *  line_uuid)` dedup index still recognises the row and an unarchive +
     *  resume never re-imports what was trimmed. */
    replaceEventData(id: number, data: string): void {
      conn.query(`UPDATE run_events SET data = ? WHERE id = ?`).run(data, id);
    },
    /**
     * Replace the `data` of the main-stream event with this `line_uuid`.
     * No-op when that row is absent. Cursor ACP uses it to fill in a tool
     * call's `rawInput` as the partial call grows, without inserting a second
     * `tool_use` — a new row would become `lastToolUseData` and hide a plan.
     *
     * The lookup matches `run_events_run_sub_line_uuid`
     * `(run_id, IFNULL(subagent_id, ''), line_uuid)` exactly, main stream
     * only (`''`). The write is the same primary-key UPDATE as
     * `replaceEventData`.
     */
    replaceMainEventDataByLineUuid(runId: string, lineUuid: string, data: string): boolean {
      const row = conn.query<{ id: number }, [string, string]>(
        `SELECT id FROM run_events INDEXED BY run_events_run_sub_line_uuid
       WHERE run_id = ? AND IFNULL(subagent_id, '') = '' AND line_uuid = ?
       LIMIT 1`,
      ).get(runId, lineUuid);
      if (!row) return false;
      conn.query(`UPDATE run_events SET data = ? WHERE id = ?`).run(data, row.id);
      return true;
    },
    /** Newest `run_events.id` of one run, or 0 for a run with no events. The
     *  retention pass folds it into a task's sweep key so a task that gained
     *  events after it was swept (a JSONL rebuild of an archived task) is swept
     *  again. `MAX(id)` over the `(run_id, id)` prefix is a single index seek;
     *  pinned with `INDEXED BY` like the other run-scoped probes. */
    maxEventIdForRun(runId: string): number {
      const row = conn.query<{ m: number | null }, [string]>(
        `SELECT MAX(id) AS m FROM run_events INDEXED BY idx_run_events_run WHERE run_id = ?`,
      ).get(runId);
      return row?.m ?? 0;
    },
    /** Ids of every run belonging to a task (any status), oldest first.
     *  Retention walks a task's `run_events` per run (the `idx_run_events_run`
     *  prefix) rather than by task so each keyset page stays index-ordered. */
    runIdsForTask(taskId: string): string[] {
      return conn.query<{ id: string }, [string]>(
        `SELECT id FROM runs WHERE task_id = ? ORDER BY started_at ASC, id ASC`,
      ).all(taskId).map((r) => r.id);
    },
  };
  return runs;
}

export type Runs = ReturnType<typeof makeRuns>;

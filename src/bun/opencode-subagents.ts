import { OPENCODE_CHILD_SOURCE_PREFIX, opencodeStoppedChildren, runs, subagents } from "./db-async.ts";
import { appendAndEmit } from "./run-emit-queue.ts";
import { FX_USAGE_STATUS_PREFIX, type RunEvent, type RunEventStream, type Subagent, type SubagentEvent, type SubagentStatus } from "../shared/types.ts";
import type { OpencodeSubagentNotice } from "./opencode-tmux.ts";
import { exportOutcome, exportToEvents, runOpencodeExport, type OpencodeExport } from "./opencode-export.ts";
import { createOpencodeEventMapper, type OpencodeMappedChunk } from "./opencode-events.ts";
import { opencodeErrorMessage } from "./opencode-map-helpers.ts";
import { OpencodeHttpError, type OpencodeClient } from "./opencode-http.ts";
import {
  opencodeChildrenDieWithTurn,
  opencodeTurnBreadcrumbPrefix,
  parseOpencodeTurnBreadcrumb,
  type OpencodeTurnServer,
} from "../shared/opencode.ts";

/**
 * Subagent tabs for OpenCode tasks (`docs/plans/add-opencode-harness.md`
 * D-11, spike A6). `opencode run` streams only the main session, so a
 * `subagent` (v2) / `task` (v1) tool result that names a child session is
 * all agetor sees live: the driver reports it, `registerOpencodeSubagent`
 * inserts a `subagents` row (`parentKind: "opencode_subagent"`,
 * `sourcePath: "opencode-session:<child>"` — a pseudo path, never a file;
 * the Claude watcher skips these rows), and at every turn end the driver's
 * `beforeSettle` runs `refreshOpencodeSubagents({final: true})`, which reads
 * each child's `session export` and fills its tab.
 *
 * No row is left `running` past a final refresh — otherwise the
 * background-agent hold would park the task in `running`:
 *  - complete child → its events appended, `completed` (or `failed` when
 *    OpenCode recorded a failed outcome);
 *  - unfinished child on a Standalone (or v1) turn → `failed`: a Standalone
 *    child dies with the client (spike Q12), and v1 children are always
 *    foreground (agetor never sets `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`);
 *  - unfinished child on a v2 Shared turn → `orphaned`: OpenCode's service
 *    may still be running it, so later turn ends re-check orphaned rows (a
 *    re-check only settles one once its export reports an outcome; it never
 *    relabels it "stopped", whatever server mode the later turn ran in) —
 *    until {@link ORPHAN_RECHECK_MAX_AGE_MS} after it was orphaned, when a
 *    still-unfinished child is given up on (`failed`), so a child whose
 *    service died can't cost an export at every turn end forever.
 *
 * Two paths skip `beforeSettle` and are covered separately: a session
 * teardown (delete/archive/agent switch → `dropOpencodeSession`) and a boot
 * with no live tail to finish the turn; both call
 * `orphanRunningOpencodeSubagents`, which applies the same rule from the
 * dying turn's own recorded server mode ({@link opencodeTurnOfRun}). Every
 * settle fires the settle hook (the
 * orchestrator's held-task release), so a refresh that outlives the driver's
 * `beforeSettle` budget still lets a held task go when it finally lands.
 *
 * Turns carried by the agetor-owned OpenCode server (`server=agetor`,
 * `docs/plans/opencode-server-driver.md` T12) do not use any of the export
 * machinery: the driver registers each child session the moment its events
 * arrive ({@link registerOpencodeChildSession}), streams the child's mapped
 * chunks into its row ({@link ingestOpencodeChildChunks}), settles it on the
 * child's own terminal ({@link settleOpencodeChild}) and, after a resync,
 * reattach or server wake, catches the row up from the server
 * ({@link syncOpencodeChildFromServer}). The server outlives the turn, so a
 * child still running when its turn ends is NOT dead (`orphaned`, never
 * `failed`, in {@link orphanRunningOpencodeSubagents}), and
 * {@link refreshOpencodeSubagents} leaves such rows alone.
 */

let emitFn: ((e: RunEvent) => void) | null = null;

/** SSE sink, registered by the orchestrator next to `setSubagentEmitter`.
 *  Returns the previous sink (tests restore it). */
export function setOpencodeSubagentEmitter(fn: ((e: RunEvent) => void) | null): ((e: RunEvent) => void) | null {
  const prev = emitFn;
  emitFn = fn;
  return prev;
}

let settleFn: ((taskId: string) => void) | null = null;

/** Held-task release hook (the orchestrator registers `maybeReleaseHeldTask`,
 *  same as Claude's `setSubagentSettleHook`). Fired after a row leaves
 *  `running`. Returns the previous hook (tests restore it). */
export function setOpencodeSubagentSettleHook(fn: ((taskId: string) => void) | null): ((taskId: string) => void) | null {
  const prev = settleFn;
  settleFn = fn;
  return prev;
}

function fireSettle(taskId: string): void {
  try {
    settleFn?.(taskId);
  } catch (e) {
    console.error(`[opencode-subagents] settle hook failed for task ${taskId}:`, e);
  }
}

/**
 * Per-task write queue. The driver reports a child's life as a run of
 * synchronous calls (register, then chunks, then settle) and the database is
 * asynchronous, so each task's subagent-row work is chained here: a call starts
 * after every earlier call of the same task has finished, whatever order the
 * worker thread answers in. Reads that must see those writes go through it too.
 * Different tasks never wait on each other. A queued step that throws rejects
 * only its own caller (the exported functions catch their own errors); the
 * chain moves on, and its entry is dropped when idle. Work inside a queued step
 * calls the `…Raw` functions below, never an exported (queued) one: queuing
 * from inside the queue would wait on itself.
 */
const taskTails = new Map<string, Promise<void>>();

function serial<T>(taskId: string, step: () => Promise<T>): Promise<T> {
  const prev = taskTails.get(taskId) ?? Promise.resolve();
  const result = prev.then(step);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  taskTails.set(taskId, tail);
  void tail.then(() => {
    if (taskTails.get(taskId) === tail) taskTails.delete(taskId);
  });
  return result;
}

/** Resolves once every subagent-row call queued so far for the task has finished (tests, shutdown). */
export function flushOpencodeSubagentWrites(taskId: string): Promise<void> {
  return serial(taskId, () => Promise.resolve());
}

export const OPENCODE_SUBAGENT_SOURCE_PREFIX = OPENCODE_CHILD_SOURCE_PREFIX;

/** Deterministic row id for a child session (one row per child, ever). */
export function opencodeSubagentId(childSessionId: string): string {
  return `opencode-${childSessionId}`;
}

/** True for an OpenCode child-session row. Keyed on the parent kind and,
 *  defensively, on the pseudo `sourcePath` (a reader that doesn't know the
 *  kind yet maps it back to `"subagent"`). */
export function isOpencodeSubagentRow(row: Pick<Subagent, "parentKind" | "sourcePath">): boolean {
  return row.parentKind === "opencode_subagent" || row.sourcePath.startsWith(OPENCODE_SUBAGENT_SOURCE_PREFIX);
}

/** The child session id a row's `sourcePath` names, or null. */
export function opencodeChildSessionOf(row: Pick<Subagent, "sourcePath">): string | null {
  return row.sourcePath.startsWith(OPENCODE_SUBAGENT_SOURCE_PREFIX)
    ? row.sourcePath.slice(OPENCODE_SUBAGENT_SOURCE_PREFIX.length) || null
    : null;
}

function emitLifecycle(sub: Subagent, phase: SubagentEvent["phase"]): void {
  const payload: SubagentEvent = { phase, subagent: sub };
  try {
    emitFn?.({
      runId: sub.runId ?? sub.id,
      taskId: sub.taskId,
      stream: "subagent",
      data: JSON.stringify(payload),
      ts: Date.now(),
      subagentId: sub.id,
    });
  } catch (e) {
    console.error("[opencode-subagents] emit failed:", e);
  }
}

/** Insert the `running` row for a newly seen child session. Idempotent —
 *  a replayed tool line (reattach) re-reports the same child and is a no-op. */
export function registerOpencodeSubagent(a: { taskId: string; runId: string; notice: OpencodeSubagentNotice }): Promise<void> {
  return serial(a.taskId, () => registerOpencodeSubagentRaw(a));
}

async function registerOpencodeSubagentRaw(a: { taskId: string; runId: string; notice: OpencodeSubagentNotice }): Promise<void> {
  const id = opencodeSubagentId(a.notice.childSessionId);
  try {
    if (await subagents.get(id)) return;
    const row: Subagent = {
      id,
      taskId: a.taskId,
      runId: a.runId,
      parentKind: "opencode_subagent",
      agentType: a.notice.agentType,
      description: a.notice.description,
      spawnDepth: 1,
      sourcePath: `${OPENCODE_SUBAGENT_SOURCE_PREFIX}${a.notice.childSessionId}`,
      toolUseId: a.notice.toolUseId,
      status: "running",
      startedAt: Date.now(),
      endedAt: null,
    };
    await subagents.insertIfAbsent(row);
    emitLifecycle(row, "started");
  } catch (e) {
    console.error(`[opencode-subagents] failed to register ${id}:`, e);
  }
}

async function runIdFor(row: Subagent): Promise<string | null> {
  if (row.runId) return row.runId;
  try {
    return (await runs.listForTask(row.taskId))[0]?.id ?? null;
  } catch {
    return null;
  }
}

/** Persist one event of a child's tab and send it live, in id order with every
 *  other event of the run (`appendAndEmit`). Never throws. */
async function append(row: Subagent, runId: string, stream: RunEventStream, data: string, lineUuid: string, subagentId: string | null): Promise<void> {
  try {
    await appendAndEmit(
      runId,
      () => runs.appendEvent(runId, stream, data, lineUuid, subagentId),
      (inserted) => {
        if (inserted === null) return; // already persisted (re-check of an orphaned row)
        emitFn?.({ id: inserted.id, runId, taskId: row.taskId, stream, data, ts: inserted.ts, subagentId });
      },
    );
  } catch (e) {
    console.error(`[opencode-subagents] failed to persist an event for ${row.id}:`, e);
  }
}

/** The events of a child's `session export`, in one transaction (one hop, not one per row). Never throws. */
async function appendExportEvents(row: Subagent, runId: string, exp: OpencodeExport): Promise<void> {
  await appendBatch(row, runId, exportToEvents(exp).map((e) => ({ stream: e.stream, data: e.data, lineUuid: e.lineUuid })), row.id);
}

/** Persist a batch of one child's events in a single transaction and send each
 *  stored one live, in order (`appendAndEmit`). Deduped by line uuid. Never throws. */
async function appendBatch(
  row: Subagent,
  runId: string,
  items: ReadonlyArray<{ stream: RunEventStream; data: string; lineUuid: string }>,
  subagentId: string | null,
): Promise<void> {
  if (items.length === 0) return;
  try {
    await appendAndEmit(
      runId,
      () => runs.appendEvents(runId, items.map((it) => ({ stream: it.stream, data: it.data, lineUuid: it.lineUuid, subagentId }))),
      (stored) => {
        stored.forEach((inserted, i) => {
          if (inserted === null) return;
          const it = items[i]!;
          emitFn?.({ id: inserted.id, runId, taskId: row.taskId, stream: it.stream, data: it.data, ts: inserted.ts, subagentId });
        });
      },
    );
  } catch (e) {
    console.error(`[opencode-subagents] failed to persist events for ${row.id}:`, e);
  }
}

function label(row: Subagent): string {
  return row.description ?? row.agentType ?? "subagent";
}

/**
 * The CLI line and effective server mode the turn of `runId` ran with, read
 * from its D-19 opening status line — the durable record, since
 * `task.opencodeServer` may have changed since and a boot has no memory of
 * the launch. Null when the run has no such line (or the read fails).
 */
export async function opencodeTurnOfRun(runId: string | null): Promise<{ major: 1 | 2; server: OpencodeTurnServer | null } | null> {
  if (!runId) return null;
  try {
    // Per-major prefixes: `LIKE` is case-insensitive, and a bare `opencode `
    // prefix would also match this module's own `OpenCode subagent …` lines.
    for (const major of [2, 1] as const) {
      const turn = parseOpencodeTurnBreadcrumb(await runs.lastStatusDataWithPrefix(runId, opencodeTurnBreadcrumbPrefix(major)));
      if (turn) return turn;
    }
  } catch (e) {
    console.error(`[opencode-subagents] failed to read the turn breadcrumb of ${runId}:`, e);
  }
  return null;
}

/**
 * {@link opencodeTurnOfRun} for many runs in one database call (the wake watch
 * refresh looks at every task that ever had an OpenCode session). One entry per
 * run id, in the order given; null where the run has no turn line or the read
 * fails. Never throws.
 */
export async function opencodeTurnsOfRuns(
  runIds: readonly string[],
): Promise<Array<{ major: 1 | 2; server: OpencodeTurnServer | null } | null>> {
  if (runIds.length === 0) return [];
  try {
    // Per-major prefixes, newest major first, as `opencodeTurnOfRun` reads them.
    const lines = await runs.firstStatusDataWithPrefixes(runIds, [opencodeTurnBreadcrumbPrefix(2), opencodeTurnBreadcrumbPrefix(1)]);
    return lines.map((line) => parseOpencodeTurnBreadcrumb(line));
  } catch (e) {
    console.error("[opencode-subagents] failed to read the turn breadcrumbs:", e);
    return runIds.map(() => null);
  }
}

/** How long an `orphaned` row keeps being re-checked at turn ends. A
 *  background child that hasn't finished a day after its turn ended is
 *  dead (its Shared service restarted or was killed). */
export const ORPHAN_RECHECK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The OpenCode child sessions of a task that are still worth following: rows
 * `running`, plus rows `orphaned` within {@link ORPHAN_RECHECK_MAX_AGE_MS} of
 * being orphaned. An older orphan is dead weight (its server restarted, or it
 * predates this server): offering it to the driver's relist / catch-up / boot
 * linger would keep a linger and the server alive on every boot. Never throws.
 */
export function listOpenOpencodeChildSessions(taskId: string, now: number = Date.now()): Promise<string[]> {
  // Queued, so it sees every register / settle the driver already reported.
  return serial(taskId, () => listOpenOpencodeChildSessionsRaw(taskId, now));
}

async function listOpenOpencodeChildSessionsRaw(taskId: string, now: number): Promise<string[]> {
  const out: string[] = [];
  try {
    for (const row of await subagents.listForTask(taskId)) {
      if (!isOpencodeSubagentRow(row) || (row.status !== "running" && row.status !== "orphaned")) continue;
      if (row.status === "orphaned" && now - (row.endedAt ?? row.startedAt) >= ORPHAN_RECHECK_MAX_AGE_MS) continue;
      const id = opencodeChildSessionOf(row);
      if (id) out.push(id);
    }
  } catch (e) {
    console.error("[opencode-subagents] could not list open subagent rows:", e);
  }
  return out;
}

/**
 * The OpenCode child sessions of a task whose subagent row is done with:
 * settled, or orphaned for at least {@link ORPHAN_RECHECK_MAX_AGE_MS} — exactly
 * the rows {@link listOpenOpencodeChildSessions} leaves out. One
 * status-filtered, indexed query (`subagents.settledOpencodeChildSessionIds`),
 * not a load of every row of the task. Never throws.
 */
export function listSettledOpencodeChildSessions(taskId: string, now: number = Date.now()): Promise<string[]> {
  return serial(taskId, async () => {
    try {
      // Open while `now - orphanedAt < MAX`, so settled from `orphanedAt <= now - MAX`.
      return await subagents.settledOpencodeChildSessionIds(taskId, now - ORPHAN_RECHECK_MAX_AGE_MS + 1);
    } catch (e) {
      console.error("[opencode-subagents] could not list settled subagent rows:", e);
      return [];
    }
  });
}

/* ── children agetor itself stopped (decision R4) ─────────────────────────── */

/** How long a "stopped by agetor" note counts. The "subagent cancelled" wake it
 *  explains comes within seconds; the day covers a Stop followed by a quit and
 *  a later boot of the background core. */
export const OPENCODE_STOPPED_CHILD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Record, before the interrupt goes out, that agetor itself is interrupting
 * this child session, so the parent's "subagent cancelled" wake that follows
 * is recognized as the tail of agetor's Stop (decision R4). Durable: it is a
 * row in `opencode_stopped_children` (migration 082), so a core restart
 * between the Stop and the wake still knows. Recorded whether or not the
 * child's subagent row exists yet. Re-noting refreshes the time. Notes older
 * than {@link OPENCODE_STOPPED_CHILD_TTL_MS} are pruned on each write. Never
 * throws.
 */
export async function noteOpencodeChildStoppedByAgetor(a: { taskId: string; childSessionId: string }, now: number = Date.now()): Promise<void> {
  if (!a.childSessionId) return;
  try {
    await opencodeStoppedChildren.note(a.childSessionId, a.taskId, now, now - OPENCODE_STOPPED_CHILD_TTL_MS);
  } catch (e) {
    console.error(`[opencode-subagents] could not record that ${a.childSessionId} was stopped:`, e);
  }
}

/** Whether agetor noted this child session as stopped within the last
 *  {@link OPENCODE_STOPPED_CHILD_TTL_MS} (see {@link noteOpencodeChildStoppedByAgetor}).
 *  One primary-key lookup; false on any read error. */
export async function wasOpencodeChildStoppedByAgetor(childSessionId: string, now: number = Date.now()): Promise<boolean> {
  if (!childSessionId) return false;
  try {
    const at = await opencodeStoppedChildren.stoppedAt(childSessionId);
    return at !== null && now - at < OPENCODE_STOPPED_CHILD_TTL_MS;
  } catch (e) {
    console.error(`[opencode-subagents] could not read whether ${childSessionId} was stopped:`, e);
    return false;
  }
}

async function settleRow(row: Subagent, status: SubagentStatus): Promise<void> {
  const endedAt = Date.now();
  await subagents.setStatus(row.id, status, endedAt);
  emitLifecycle({ ...row, status, endedAt }, "finished");
  fireSettle(row.taskId);
}

type RefreshArgs = { bin: string; env: Record<string, string>; cwd: string; major: 1 | 2; standalone: boolean; final: boolean };

async function refreshRow(row: Subagent, a: RefreshArgs): Promise<void> {
  const child = opencodeChildSessionOf(row);
  let exp: OpencodeExport | null = null;
  if (child) {
    try {
      exp = await runOpencodeExport({
        sessionId: child,
        bin: a.bin,
        env: a.env,
        cwd: a.cwd,
        major: a.major,
        standalone: a.standalone,
        timeoutMs: REFRESH_EXPORT_TIMEOUT_MS,
      });
    } catch (e) {
      console.error(`[opencode-subagents] export of ${child} failed:`, e);
      exp = null;
    }
  }
  // The export read above is slow and unqueued; what it decided is written in order.
  await serial(row.taskId, () => finishRefreshRow(row, a, exp));
}

async function finishRefreshRow(row: Subagent, a: RefreshArgs, exp: OpencodeExport | null): Promise<void> {
  const runId = await runIdFor(row);
  const outcome = exp ? exportOutcome(exp) : "unfinished";

  if (outcome !== "unfinished") {
    if (runId && exp) await appendExportEvents(row, runId, exp);
    await settleRow(row, outcome === "succeeded" ? "completed" : "failed");
    return;
  }
  if (!a.final) return;
  // An orphaned row is a child an EARLIER Shared turn left running in the
  // service; only an export outcome (above) may settle it. This turn's own
  // server mode says nothing about it — a Standalone turn must not call it
  // "stopped" (or fail it) just because the export still reads unfinished.
  if (row.status === "orphaned") {
    const orphanedAt = row.endedAt ?? row.startedAt;
    if (Date.now() - orphanedAt < ORPHAN_RECHECK_MAX_AGE_MS) return;
    if (runId && exp) await appendExportEvents(row, runId, exp);
    if (runId) {
      await append(
        row,
        runId,
        "status",
        `OpenCode subagent "${label(row)}" never reported finishing — stopped checking on it`,
        `opencode:subagent:${row.id}:expired`,
        null,
      );
    }
    await settleRow(row, "failed");
    return;
  }

  if (a.standalone || a.major === 1) {
    // The child died with the turn's private server (A6a); show what it got done.
    if (runId && exp) await appendExportEvents(row, runId, exp);
    if (runId) {
      await append(row, runId, "status", `OpenCode subagent "${label(row)}" stopped when the turn ended`, `opencode:subagent:${row.id}:stopped`, null);
    }
    await settleRow(row, "failed");
    return;
  }
  if (runId) {
    await append(
      row,
      runId,
      "status",
      `OpenCode subagent "${label(row)}" is still running — its tab fills when a later turn finishes`,
      `opencode:subagent:${row.id}:orphaned`,
      null,
    );
  }
  await settleRow(row, "orphaned");
}

/**
 * Settle every still-`running` OpenCode subagent row of a task when nothing
 * will run a final refresh for it: the task's OpenCode session was torn down
 * (delete/archive/agent switch — `dropOpencodeSession` resolves the tail
 * without `beforeSettle`) or agetor booted with no live tail. Left `running`,
 * the row would hold the task's next turn (any harness) in `running` forever.
 * The row's own turn decides how (A6a, {@link opencodeTurnOfRun}): a v1 or
 * Standalone child died with that turn → `failed`; a v2 Shared child may
 * still be running in OpenCode's service → `orphaned`, which a later OpenCode
 * turn re-checks — as is a row whose turn mode isn't recorded. Fires the
 * settle hook once. Returns how many rows it settled; never throws.
 */
export function orphanRunningOpencodeSubagents(taskId: string, reason: string): Promise<number> {
  return serial(taskId, () => orphanRunningOpencodeSubagentsRaw(taskId, reason));
}

async function orphanRunningOpencodeSubagentsRaw(taskId: string, reason: string): Promise<number> {
  let rows: Subagent[];
  try {
    rows = (await subagents.listForTask(taskId)).filter((r) => isOpencodeSubagentRow(r) && r.status === "running");
  } catch (e) {
    console.error("[opencode-subagents] failed to list subagents:", e);
    return 0;
  }
  let flipped = 0;
  for (const row of rows) if (await orphanRow(row, reason)) flipped++;
  if (flipped > 0) fireSettle(taskId);
  return flipped;
}

/**
 * Flip one `running` OpenCode row the way {@link orphanRunningOpencodeSubagents}
 * does (the row's turn decides `failed` vs `orphaned`, with its status line).
 * Does not fire the settle hook. True when it flipped the row; never throws.
 */
async function orphanRow(row: Subagent, reason: string): Promise<boolean> {
  try {
    const runId = await runIdFor(row);
    const turn = await opencodeTurnOfRun(runId);
    const status: SubagentStatus = turn && opencodeChildrenDieWithTurn(turn) ? "failed" : "orphaned";
    const endedAt = Date.now();
    await subagents.setStatus(row.id, status, endedAt);
    emitLifecycle({ ...row, status, endedAt }, "finished");
    if (runId) {
      const text = status === "failed"
        ? `OpenCode subagent "${label(row)}" stopped — ${reason}`
        : `OpenCode subagent "${label(row)}" was left unfinished — ${reason}`;
      await append(row, runId, "status", text, `opencode:subagent:${row.id}:left`, null);
    }
    return true;
  } catch (e) {
    console.error(`[opencode-subagents] failed to orphan ${row.id}:`, e);
    return false;
  }
}

/**
 * The OpenCode server carrying a task's turn was lost (it crashed, or stopped
 * answering) and the turn ended because of it: the task's `running` OpenCode
 * child rows will hear nothing more from that stream. Parks them `orphaned`,
 * with the same rule and status line {@link orphanRunningOpencodeSubagents}
 * applies at boot, so they stop holding the task. A later sync against a
 * server that answers settles each one for good (404, or not active with no
 * idle tail) or revives it (listed active). Returns how many rows it flipped;
 * never throws.
 */
export function orphanRunningOpencodeChildrenOfTask(taskId: string): Promise<number> {
  return orphanRunningOpencodeSubagents(taskId, "the OpenCode server stopped");
}

/**
 * One child of a task whose execution was cut off: the server positively lists
 * it as not executing, and its row is still `running` (a crash's leftover a new
 * turn adopted). Parks that one row exactly as
 * {@link orphanRunningOpencodeChildrenOfTask} parks each of a task's rows (same
 * rule, same status line), leaving the task's other rows alone, so a live
 * sibling keeps its row. The sync that follows then settles it for good, or
 * revives it if the server lists it again. Fires the settle hook when it
 * flipped the row. Idempotent: a row that is not `running` (or not this task's,
 * or not an OpenCode row) is left as it is and false returned. Never throws.
 */
export function orphanOpencodeChild(taskId: string, childSessionId: string): Promise<boolean> {
  return serial(taskId, async () => {
    let row: Subagent | null | undefined;
    try {
      row = await subagents.get(opencodeSubagentId(childSessionId));
    } catch (e) {
      console.error("[opencode-subagents] failed to read a subagent row:", e);
      return false;
    }
    if (!row || row.taskId !== taskId || !isOpencodeSubagentRow(row) || row.status !== "running") return false;
    if (!(await orphanRow(row, "the OpenCode server stopped"))) return false;
    fireSettle(taskId);
    return true;
  });
}

const REFRESH_EXPORT_TIMEOUT_MS = 10_000;
const REFRESH_CONCURRENCY = 2;

/**
 * Re-read every `running` / `orphaned` OpenCode subagent of a task (D-11).
 * `standalone` / `major` describe the turn that just ended (A6a); `final`
 * marks a turn end, after which no row may still be `running`. Never throws.
 */
export async function refreshOpencodeSubagents(a: {
  taskId: string;
  bin: string;
  env: Record<string, string>;
  cwd: string;
  major: 1 | 2;
  standalone: boolean;
  final: boolean;
}): Promise<void> {
  let rows: Subagent[];
  try {
    const open = (await serial(a.taskId, () => subagents.listForTask(a.taskId)))
      .filter((r) => isOpencodeSubagentRow(r) && (r.status === "running" || r.status === "orphaned"));
    // A child of a turn the agetor-owned server carried is filled live and
    // settled on its own terminal (see the header): there is no `session
    // export` to run for it, and no turn end may decide its fate.
    rows = [];
    for (const r of open) if ((await opencodeTurnOfRun(await runIdFor(r)))?.server !== "agetor") rows.push(r);
  } catch (e) {
    console.error("[opencode-subagents] failed to list subagents:", e);
    return;
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < rows.length) {
      const row = rows[next++]!;
      try {
        await refreshRow(row, a);
      } catch (e) {
        console.error(`[opencode-subagents] refresh of ${row.id} failed:`, e);
        if (a.final && row.status === "running") {
          // Never leave a row `running` past a final refresh (A6).
          try { await serial(row.taskId, () => settleRow(row, a.standalone || a.major === 1 ? "failed" : "orphaned")); } catch { /* noop */ }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, rows.length) }, () => worker()));
}

/* ── OpenCode v2 server turns (`server=agetor`): live child sessions ───────── */

const CHILD_TERMINAL: ReadonlySet<SubagentStatus> = new Set<SubagentStatus>(["completed", "failed", "cancelled"]);

/** Longest the main thread is held while ingesting a batch of chunks. */
const INGEST_SLICE_MS = 20;
/** `GET …/message` page size, and the most pages one catch-up reads (newest first). */
const SYNC_PAGE_LIMIT = 100;
const SYNC_MAX_PAGES = 25;
/** Longest error text copied into a child's tab. */
const MAX_CHILD_ERROR_CHARS = 1000;

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Create the `running` row for a child session the agetor-owned server
 * reported (the driver calls this when the child's first event arrives).
 * Same row shape as {@link registerOpencodeSubagent} (`parentKind
 * "opencode_subagent"`, pseudo `sourcePath`), so the tab strip, the held-task
 * rule and the Claude watcher's skip treat it alike. Idempotent: a row that
 * exists, in any state, is left exactly as it is. `background` is accepted for
 * the caller's bookkeeping; the row does not store it, because what keeps a
 * background child's row `running` is that nothing settles it before its own
 * terminal.
 */
export function registerOpencodeChildSession(a: {
  taskId: string;
  runId: string;
  parentSessionId: string;
  childSessionId: string;
  title?: string;
  agent?: string;
  depth: number;
  background?: boolean;
}): Promise<void> {
  return serial(a.taskId, () => registerOpencodeChildSessionRaw(a));
}

async function registerOpencodeChildSessionRaw(a: {
  taskId: string;
  runId: string;
  parentSessionId: string;
  childSessionId: string;
  title?: string;
  agent?: string;
  depth: number;
  background?: boolean;
}): Promise<void> {
  const id = opencodeSubagentId(a.childSessionId);
  try {
    if (await subagents.get(id)) return;
    const row: Subagent = {
      id,
      taskId: a.taskId,
      runId: a.runId,
      parentKind: "opencode_subagent",
      agentType: a.agent ?? null,
      description: a.title ?? null,
      spawnDepth: Math.max(1, Math.floor(a.depth) || 1),
      sourcePath: `${OPENCODE_SUBAGENT_SOURCE_PREFIX}${a.childSessionId}`,
      toolUseId: null,
      status: "running",
      startedAt: Date.now(),
      endedAt: null,
    };
    await subagents.insertIfAbsent(row);
    emitLifecycle(row, "started");
  } catch (e) {
    console.error(`[opencode-subagents] failed to register ${id}:`, e);
  }
}

/** A child the server is evidently still running, but whose row an earlier
 *  teardown or boot sweep parked as `orphaned`, is `running` again. */
async function reviveIfOrphaned(row: Subagent): Promise<Subagent> {
  if (row.status !== "orphaned") return row;
  try {
    await subagents.setStatus(row.id, "running", null);
    const revived: Subagent = { ...row, status: "running", endedAt: null };
    emitLifecycle(revived, "started");
    return revived;
  } catch (e) {
    console.error(`[opencode-subagents] failed to revive ${row.id}:`, e);
    return row;
  }
}

/**
 * Overwrite the stored data of a child's `tool_use` event: the mapper learned
 * a tool's real name after it had emitted the generic one (`replace: true`,
 * `src/bun/opencode-events.ts`). The row is found by the tool call id inside
 * the event (`runs.findToolUseEvent`; call ids are unique per call, so the hit
 * is the child's own row) and rewritten in place, keeping its id, then
 * re-broadcast under that id. Best effort: false when the row isn't there.
 *
 * Remainder for db.ts (nobody owned it in this wave): a
 * `runs.replaceSubagentEventDataByLineUuid(runId, subagentId, lineUuid, data):
 * { id: number; ts: number } | null` shaped like `replaceMainEventDataByLineUuid`
 * (`IFNULL(subagent_id,'') = ?` against `run_events_run_sub_line_uuid`) would
 * replace this lookup and keep the original `ts`.
 */
async function replaceChildEventData(row: Subagent, runId: string, chunk: OpencodeMappedChunk): Promise<boolean> {
  if (chunk.stream !== "tool_use") return false;
  try {
    const callId = (JSON.parse(chunk.data) as { id?: unknown }).id;
    if (typeof callId !== "string") return false;
    // Through the run's emit queue: the rewrite's live send keeps its place among the run's appends.
    const hit = await appendAndEmit(
      runId,
      async () => {
        const found = await runs.findToolUseEvent(runId, callId);
        if (found && found.data !== chunk.data) await runs.replaceEventData(found.id, chunk.data);
        return found && found.data !== chunk.data ? { id: found.id, changed: true } : found ? { id: found.id, changed: false } : null;
      },
      (res) => {
        if (res?.changed) emitFn?.({ id: res.id, runId, taskId: row.taskId, stream: chunk.stream, data: chunk.data, ts: Date.now(), subagentId: row.id });
      },
    );
    return hit !== null;
  } catch (e) {
    console.error(`[opencode-subagents] failed to replace an event of ${row.id}:`, e);
    return false;
  }
}

/** Store a list of mapped chunks in order. Plain chunks go to the database a
 *  batch at a time (one transaction per run of consecutive plain chunks, not one
 *  per chunk); a `replace` chunk is flushed behind the batch before it, so the
 *  order is exactly the chunks' order. */
async function ingestChunks(row: Subagent, runId: string, chunks: readonly OpencodeMappedChunk[]): Promise<void> {
  let pending: Array<{ stream: RunEventStream; data: string; lineUuid: string }> = [];
  const flush = async (): Promise<void> => {
    const batch = pending;
    pending = [];
    await appendBatch(row, runId, batch, row.id);
  };
  for (const chunk of chunks) {
    // A child's usage line is not the task's: the run-level readers of the
    // `fx-usage` status line know nothing of subagent ids (the export path
    // never wrote one either).
    if (chunk.stream === "status" && chunk.data.startsWith(FX_USAGE_STATUS_PREFIX)) continue;
    if (chunk.replace) {
      await flush();
      if (await replaceChildEventData(row, runId, chunk)) continue;
    }
    pending.push({ stream: chunk.stream, data: chunk.data, lineUuid: chunk.lineUuid });
  }
  await flush();
}

/**
 * Append a child session's mapped chunks to its row's tab and broadcast each
 * one. Deduped by `lineUuid` (a replayed snapshot or a resync never doubles a
 * line); `replace: true` rewrites that line's stored data instead. A row
 * parked `orphaned` comes back to `running` — events arriving prove the child
 * is alive. A settled row still takes new lines (a late tool result), but its
 * status is never reopened. Unknown child or a row of another task: dropped.
 * Queued per task (see `serial`), one transaction per batch; a caller with a
 * big batch uses {@link syncOpencodeChildFromServer}, which yields between
 * slices. Never throws.
 */
export function ingestOpencodeChildChunks(a: { taskId: string; childSessionId: string; chunks: OpencodeMappedChunk[] }): Promise<void> {
  return serial(a.taskId, () => ingestChildChunks(a, true));
}

/** `revive: false` is for a catch-up replaying history, which proves nothing about the child being alive now. */
async function ingestChildChunks(a: { taskId: string; childSessionId: string; chunks: OpencodeMappedChunk[] }, revive: boolean): Promise<void> {
  if (a.chunks.length === 0) return;
  try {
    const found = await subagents.get(opencodeSubagentId(a.childSessionId));
    if (!found || found.taskId !== a.taskId) return;
    const runId = await runIdFor(found);
    if (!runId) return;
    const row = revive ? await reviveIfOrphaned(found) : found;
    await ingestChunks(row, runId, a.chunks);
  } catch (e) {
    console.error(`[opencode-subagents] failed to ingest chunks of ${a.childSessionId}:`, e);
  }
}

function flatErrorText(text: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length > MAX_CHILD_ERROR_CHARS ? `${flat.slice(0, MAX_CHILD_ERROR_CHARS)}...` : flat;
}

/**
 * Settle a child on its own terminal (`session.execution.succeeded | failed |
 * interrupted` of the child, or the trailing `idle` message a catch-up reads):
 * `completed` → `completed`, `failed` → `failed`, `interrupted` → `cancelled`
 * (the closest {@link SubagentStatus}; the child was stopped, it did not
 * crash). A `failed` outcome's `error` becomes an `opencode: …` line in the
 * child's tab unless the mapper already wrote one. Only a `running` or
 * `orphaned` row settles — a row already `completed` / `failed` / `cancelled`
 * keeps its status and does not fire the settle hook again. Every settle fires
 * the hook (the orchestrator's held-task release). Never throws.
 */
export function settleOpencodeChild(a: {
  taskId: string;
  childSessionId: string;
  outcome: "completed" | "failed" | "interrupted";
  error?: string;
}): Promise<void> {
  return serial(a.taskId, () => settleOpencodeChildRaw(a));
}

async function settleOpencodeChildRaw(a: {
  taskId: string;
  childSessionId: string;
  outcome: "completed" | "failed" | "interrupted";
  error?: string;
}): Promise<void> {
  try {
    const row = await subagents.get(opencodeSubagentId(a.childSessionId));
    if (!row || row.taskId !== a.taskId || CHILD_TERMINAL.has(row.status)) return;
    const runId = await runIdFor(row);
    if (runId && a.outcome === "failed" && a.error) {
      const text = flatErrorText(a.error);
      if (text && !(await runs.hasLineUuidPrefixForSubagent(row.taskId, row.id, `opencode:${a.childSessionId}:error:`))) {
        await append(row, runId, "status", `opencode: ${text}`, `opencode:${a.childSessionId}:error:settle`, row.id);
      }
    }
    await settleRow(row, a.outcome === "completed" ? "completed" : a.outcome === "failed" ? "failed" : "cancelled");
  } catch (e) {
    console.error(`[opencode-subagents] failed to settle ${a.childSessionId}:`, e);
  }
}

function idleOutcomeOf(msg: unknown): { outcome: "completed" | "failed" | "interrupted"; error?: string } | null {
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as { type?: unknown; outcome?: unknown; error?: unknown };
  if (m.type !== "idle") return null;
  if (m.outcome === "succeeded") return { outcome: "completed" };
  if (m.outcome === "interrupted") return { outcome: "interrupted" };
  if (m.outcome === "failed") return { outcome: "failed", error: m.error === undefined ? undefined : opencodeErrorMessage(m.error) };
  return null;
}

async function ingestSliced(a: { taskId: string; childSessionId: string; chunks: OpencodeMappedChunk[] }): Promise<void> {
  let from = 0;
  while (from < a.chunks.length) {
    const deadline = performance.now() + INGEST_SLICE_MS;
    let to = from;
    while (to < a.chunks.length && (to === from || performance.now() < deadline)) to++;
    await serial(a.taskId, () => ingestChildChunks({ taskId: a.taskId, childSessionId: a.childSessionId, chunks: a.chunks.slice(from, to) }, false));
    from = to;
    if (from < a.chunks.length) await yieldToLoop();
  }
}

const inFlightSyncs = new Map<string, Promise<void>>();

/**
 * Catch a child session's row up from the server: after a stream resync, a
 * reattach on boot, or a server wake. Reads the child's messages (newest page
 * first, at most {@link SYNC_MAX_PAGES} pages), maps them oldest → newest with
 * the event mapper's seed anchored on the child's first user message (when the
 * whole history was read), ingests what the tab doesn't have yet, and settles
 * the row from the trailing `idle` message's outcome. A child without an
 * `idle` tail may still be running: an `orphaned` row comes back to `running`
 * only when the server lists the child among its active sessions (history
 * proves nothing about now), is settled for good when the server's listing
 * positively leaves it out, and stays orphaned while that listing can't be
 * read ({@link settleOrReviveOrphan}). For an `orphaned` row that listing is
 * read before the messages, never after ({@link syncChildPass}). A child the server answers 404 for is
 * settled for good ({@link settleGoneChild}).
 * Creates the row when missing (title and agent from `getSession`; none when
 * the server has no such session). Yields to the event loop between pages and
 * between slices of a page. Calls for the same child share one run. Never throws.
 */
export function syncOpencodeChildFromServer(a: {
  taskId: string;
  runId: string;
  client: OpencodeClient;
  childSessionId: string;
}): Promise<void> {
  const key = opencodeSubagentId(a.childSessionId);
  const running = inFlightSyncs.get(key);
  if (running) return running;
  const p = syncChild(a)
    .catch((e) => {
      console.error(`[opencode-subagents] sync of ${a.childSessionId} failed:`, e);
    })
    .finally(() => {
      inFlightSyncs.delete(key);
    });
  inFlightSyncs.set(key, p);
  return p;
}

async function syncChild(a: { taskId: string; runId: string; client: OpencodeClient; childSessionId: string }): Promise<void> {
  // A row that turns `orphaned` while the pass runs had no activity read
  // ahead of its messages, so it gets one more pass that has one.
  const first = await serial(a.taskId, () => subagents.get(opencodeSubagentId(a.childSessionId)));
  if ((await syncChildPass(a, first?.status === "orphaned")) === "again") {
    await syncChildPass(a, true);
  }
}

/**
 * One sync pass. With `activityFirst`, the server's active list is read BEFORE
 * the messages: OpenCode records a child's `idle` message and drops it from the
 * active list at the same instant, so a child the list leaves out has its
 * `idle` tail in the messages read after it, and a missing tail then proves the
 * child dead. (Read the other way round, a child that finished between the
 * two reads would be settled `failed` for good, its last output never read.)
 * "again" asks for one more pass, with the list read first.
 */
async function syncChildPass(
  a: { taskId: string; runId: string; client: OpencodeClient; childSessionId: string },
  activityFirst: boolean,
): Promise<"done" | "again"> {
  const id = opencodeSubagentId(a.childSessionId);
  const activity = activityFirst ? await childActivity(a.client, a.childSessionId) : null;
  if (!(await serial(a.taskId, () => subagents.get(id)))) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session: any = await a.client.getSession(a.childSessionId);
    if (!session) return "done"; // the server no longer has it: nothing to show
    await registerOpencodeChildSession({
      taskId: a.taskId,
      runId: a.runId,
      parentSessionId: typeof session.parentID === "string" ? session.parentID : "",
      childSessionId: a.childSessionId,
      title: typeof session.title === "string" && session.title ? session.title : undefined,
      agent: typeof session.agent === "string" && session.agent ? session.agent : undefined,
      depth: 1,
    });
  }

  // Newest page first; `cursor.next` reaches back in time.
  const pages: unknown[][] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let n = 0; ; n++) {
    if (n >= SYNC_MAX_PAGES) {
      truncated = true;
      break;
    }
    let res: Awaited<ReturnType<OpencodeClient["listMessages"]>>;
    try {
      res = await a.client.listMessages(a.childSessionId, { limit: SYNC_PAGE_LIMIT, ...(cursor ? { cursor } : { order: "desc" as const }) });
    } catch (e) {
      if (e instanceof OpencodeHttpError && e.status === 404) {
        await serial(a.taskId, async () => {
          const gone = await subagents.get(id);
          if (gone) await settleGoneChild(gone);
        });
        return "done";
      }
      throw e;
    }
    if (res.data.length > 0) pages.push(res.data);
    const next = res.cursor?.next;
    if (res.data.length === 0 || !next || next === cursor) break;
    cursor = next;
    await yieldToLoop();
  }
  if (pages.length === 0) {
    // No messages yet: a `running` child exists but hasn't started, so it is
    // left as it is; an `orphaned` one is alive only if the server lists it.
    return serial(a.taskId, () => settleOrReviveOrphan(id, activity));
  }
  // Ascending pages, each ascending.
  const asc = pages.reverse().map((p) => p.slice().reverse());
  const flat = asc.flat();
  const tail = idleOutcomeOf(flat[flat.length - 1]);

  const firstUser = truncated
    ? undefined
    : flat.find((m): m is { id: string } => typeof m === "object" && m !== null && (m as { type?: unknown }).type === "user" && typeof (m as { id?: unknown }).id === "string");
  const seed = createOpencodeEventMapper({ sessionId: a.childSessionId }).beginSeed(firstUser ? { afterUserMessageId: firstUser.id } : undefined);
  for (const page of asc) {
    await ingestSliced({ taskId: a.taskId, childSessionId: a.childSessionId, chunks: seed.push(page) });
  }
  seed.end();

  if (tail) {
    await settleOpencodeChild({ taskId: a.taskId, childSessionId: a.childSessionId, outcome: tail.outcome, error: tail.error });
    return "done";
  }
  return serial(a.taskId, () => settleOrReviveOrphan(id, activity));
}

/**
 * An `orphaned` row whose child has no `idle` tail: the server's active list,
 * read before the messages ({@link syncChildPass}), decides. Listed → `running`
 * again. Positively not listed → the child is dead (its execution was cut off,
 * by a crash or a restart, and nothing will finish it), so the row is settled
 * for good ({@link settleDeadChild}) instead of being offered to every relist
 * and boot linger for {@link ORPHAN_RECHECK_MAX_AGE_MS}. The listing failing
 * says nothing: the row stays `orphaned` for a later sync. A `running` row is
 * left alone (the live stream owns it). A row that became `orphaned` during a
 * pass that read no activity asks for another pass ("again").
 */
async function settleOrReviveOrphan(id: string, activity: "active" | "inactive" | "unknown" | null): Promise<"done" | "again"> {
  // Re-read: a live event may have revived or settled the row during the pass.
  const row = await subagents.get(id);
  if (!row || row.status !== "orphaned") return "done";
  if (activity === null) return "again";
  if (activity === "active") await reviveIfOrphaned(row);
  else if (activity === "inactive") await settleDeadChild(row, "is no longer running on the OpenCode server", "dead");
  return "done";
}

/** Whether the server lists the session as active. `unknown` when the listing can't be read. */
async function childActivity(client: OpencodeClient, childSessionId: string): Promise<"active" | "inactive" | "unknown"> {
  try {
    const active = await client.activeSessions();
    if (typeof active !== "object" || active === null) return "unknown";
    return active[childSessionId] !== undefined ? "active" : "inactive";
  } catch (e) {
    console.error(`[opencode-subagents] could not check whether ${childSessionId} is active:`, e);
    return "unknown";
  }
}

/**
 * The server answered 404 for this child: it will never run again here (a 1.x
 * era child, a wiped or replaced server). A `running` or `orphaned` row is
 * settled for good ({@link settleDeadChild}); a terminal row is untouched.
 */
async function settleGoneChild(row: Subagent): Promise<void> {
  if (row.status !== "running" && row.status !== "orphaned") return;
  await settleDeadChild(row, "is no longer known to the OpenCode server", "gone");
}

/**
 * Settle a child the server positively reports as not running, with a status
 * line in the run: `cancelled` when agetor itself stopped it
 * ({@link wasOpencodeChildStoppedByAgetor}), else `failed`. Fires the settle
 * hook (the held-task release). Never revived later: a sync only revives an
 * `orphaned` row.
 */
async function settleDeadChild(row: Subagent, what: string, tag: "gone" | "dead"): Promise<void> {
  const child = opencodeChildSessionOf(row);
  const runId = await runIdFor(row);
  if (runId) {
    await append(row, runId, "status", `OpenCode subagent "${label(row)}" ${what}`, `opencode:subagent:${row.id}:${tag}`, null);
  }
  await settleRow(row, child && (await wasOpencodeChildStoppedByAgetor(child)) ? "cancelled" : "failed");
}

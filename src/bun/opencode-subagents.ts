import { runs, subagents } from "./db.ts";
import type { RunEvent, RunEventStream, Subagent, SubagentEvent, SubagentStatus } from "../shared/types.ts";
import type { OpencodeSubagentNotice } from "./opencode-tmux.ts";
import { exportOutcome, exportToEvents, runOpencodeExport, type OpencodeExport } from "./opencode-export.ts";

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
 *    relabels it "stopped", whatever server mode the later turn ran in).
 *
 * Two paths skip `beforeSettle` and are covered separately: a session
 * teardown (delete/archive/agent switch → `dropOpencodeSession`) and a boot
 * with no live tail to finish the turn; both call
 * `orphanRunningOpencodeSubagents`. Every settle fires the settle hook (the
 * orchestrator's held-task release), so a refresh that outlives the driver's
 * `beforeSettle` budget still lets a held task go when it finally lands.
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

export const OPENCODE_SUBAGENT_SOURCE_PREFIX = "opencode-session:";

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
export function registerOpencodeSubagent(a: { taskId: string; runId: string; notice: OpencodeSubagentNotice }): void {
  const id = opencodeSubagentId(a.notice.childSessionId);
  try {
    if (subagents.get(id)) return;
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
    subagents.insertIfAbsent(row);
    emitLifecycle(row, "started");
  } catch (e) {
    console.error(`[opencode-subagents] failed to register ${id}:`, e);
  }
}

function runIdFor(row: Subagent): string | null {
  if (row.runId) return row.runId;
  try {
    return runs.listForTask(row.taskId)[0]?.id ?? null;
  } catch {
    return null;
  }
}

function append(row: Subagent, runId: string, stream: RunEventStream, data: string, lineUuid: string, subagentId: string | null): void {
  let inserted: number | null;
  try {
    inserted = runs.appendEvent(runId, stream, data, lineUuid, subagentId);
  } catch (e) {
    console.error(`[opencode-subagents] failed to persist an event for ${row.id}:`, e);
    return;
  }
  if (inserted === null) return; // already persisted (re-check of an orphaned row)
  try {
    emitFn?.({ runId, taskId: row.taskId, stream, data, ts: Date.now(), subagentId });
  } catch (e) {
    console.error("[opencode-subagents] emit failed:", e);
  }
}

function appendExportEvents(row: Subagent, runId: string, exp: OpencodeExport): void {
  for (const e of exportToEvents(exp)) append(row, runId, e.stream, e.data, e.lineUuid, row.id);
}

function label(row: Subagent): string {
  return row.description ?? row.agentType ?? "subagent";
}

function settleRow(row: Subagent, status: SubagentStatus): void {
  const endedAt = Date.now();
  subagents.setStatus(row.id, status, endedAt);
  emitLifecycle({ ...row, status, endedAt }, "finished");
  fireSettle(row.taskId);
}

async function refreshRow(
  row: Subagent,
  a: { bin: string; env: Record<string, string>; cwd: string; major: 1 | 2; standalone: boolean; final: boolean },
): Promise<void> {
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
  const runId = runIdFor(row);
  const outcome = exp ? exportOutcome(exp) : "unfinished";

  if (outcome !== "unfinished") {
    if (runId && exp) appendExportEvents(row, runId, exp);
    settleRow(row, outcome === "succeeded" ? "completed" : "failed");
    return;
  }
  if (!a.final) return;
  // An orphaned row is a child an EARLIER Shared turn left running in the
  // service; only an export outcome (above) may settle it. This turn's own
  // server mode says nothing about it — a Standalone turn must not call it
  // "stopped" (or fail it) just because the export still reads unfinished.
  if (row.status === "orphaned") return;

  if (a.standalone || a.major === 1) {
    // The child died with the turn's private server (A6a); show what it got done.
    if (runId && exp) appendExportEvents(row, runId, exp);
    if (runId) {
      append(row, runId, "status", `OpenCode subagent "${label(row)}" stopped when the turn ended`, `opencode:subagent:${row.id}:stopped`, null);
    }
    settleRow(row, "failed");
    return;
  }
  if (runId) {
    append(
      row,
      runId,
      "status",
      `OpenCode subagent "${label(row)}" is still running — its tab fills when a later turn finishes`,
      `opencode:subagent:${row.id}:orphaned`,
      null,
    );
  }
  settleRow(row, "orphaned");
}

/**
 * Flip every still-`running` OpenCode subagent row of a task to `orphaned`
 * when nothing will run a final refresh for it: the task's OpenCode session
 * was torn down (delete/archive/agent switch — `dropOpencodeSession` resolves
 * the tail without `beforeSettle`) or agetor booted with no live tail. Left
 * `running`, the row would hold the task's next turn (any harness) in
 * `running` forever. `orphaned`, not `failed`: a v2 Shared child may still be
 * running in OpenCode's service, and a later OpenCode turn re-checks it.
 * Fires the settle hook once. Returns how many rows it flipped; never throws.
 */
export function orphanRunningOpencodeSubagents(taskId: string, reason: string): number {
  let rows: Subagent[];
  try {
    rows = subagents
      .listForTask(taskId)
      .filter((r) => isOpencodeSubagentRow(r) && r.status === "running");
  } catch (e) {
    console.error("[opencode-subagents] failed to list subagents:", e);
    return 0;
  }
  let flipped = 0;
  for (const row of rows) {
    try {
      const endedAt = Date.now();
      subagents.setStatus(row.id, "orphaned", endedAt);
      emitLifecycle({ ...row, status: "orphaned", endedAt }, "finished");
      flipped++;
      const runId = runIdFor(row);
      if (runId) {
        append(row, runId, "status", `OpenCode subagent "${label(row)}" was left unfinished — ${reason}`, `opencode:subagent:${row.id}:left`, null);
      }
    } catch (e) {
      console.error(`[opencode-subagents] failed to orphan ${row.id}:`, e);
    }
  }
  if (flipped > 0) fireSettle(taskId);
  return flipped;
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
    rows = subagents
      .listForTask(a.taskId)
      .filter((r) => isOpencodeSubagentRow(r) && (r.status === "running" || r.status === "orphaned"));
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
          try { settleRow(row, a.standalone || a.major === 1 ? "failed" : "orphaned"); } catch { /* noop */ }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, rows.length) }, () => worker()));
}

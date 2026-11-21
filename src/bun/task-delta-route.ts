import type { Task, TaskDecorations, TaskDelta, TaskListArchived } from "../shared/types.ts";
import { op } from "./db-async.ts";
import { foldPipelineStepCounts } from "./db-core/task-decoration.ts";
import { pendingCountsByTask, pipelineParentPairs } from "./interactions.ts";
import { stalledSince } from "./stall-registry.ts";
import { BOOT_ID, currentDecorationRev, decorationChangedSince } from "./task-decoration-rev.ts";
import { terminalCountsByTask } from "./terminals.ts";

// `GET /tasks?delta=1[&since=<cursor>]` (docs/plans/non-blocking-core.md, T12;
// docs/architecture/core-responsiveness.md "Delta and push").
//
// The cursor is opaque to clients: `<dbEpoch>-<bootId>:<rev>:<decRev>`.
//   - dbEpoch  `task_rev_meta.epoch`: another database (wiped data dir) never matches.
//   - bootId   this process (`task-decoration-rev.ts`): the in-memory decorations
//              restart with it, so a cursor from before a restart snapshots.
//   - rev      `task_rev_meta.rev`: the database half, read in the same read
//              transaction as the rows (`tasks.changedSince`).
//   - decRev   the main-thread decoration counter, captured BEFORE the database
//              read: a decoration change landing meanwhile has a higher rev and
//              rides the next delta again (redundant, never lost).
// A cursor that does not parse, or names another epoch/boot, or is ahead of the
// server's state, or is older than the decoration history reaches, is answered
// with a snapshot (never an error).

const CURSOR_RE = /^([0-9a-f]+)-([0-9a-f]+):(\d+):(\d+)$/;

interface ParsedCursor {
  dbEpoch: string;
  boot: string;
  rev: number;
  dec: number;
}

export function parseTaskDeltaCursor(raw: string | null | undefined): ParsedCursor | null {
  const m = raw ? CURSOR_RE.exec(raw) : null;
  if (!m) return null;
  const rev = Number(m[3]);
  const dec = Number(m[4]);
  if (!Number.isSafeInteger(rev) || !Number.isSafeInteger(dec)) return null;
  return { dbEpoch: m[1]!, boot: m[2]!, rev, dec };
}

export function formatTaskDeltaCursor(dbEpoch: string, rev: number, dec: number): string {
  return `${dbEpoch}-${BOOT_ID}:${rev}:${dec}`;
}

/** The database epoch, cached after the first read (it never changes while the
 *  process holds the database). */
let cachedEpoch: Promise<string> | null = null;

/** Resolve (and cache) the database epoch. Boot primes it so the push emitter
 *  never reads the database per emit. A failed read is not cached. */
export function primeTaskDeltaEpoch(): Promise<string> {
  if (!cachedEpoch) {
    const p = op("tasks.deltaMeta", []).then((m) => m.epoch);
    cachedEpoch = p;
    p.catch(() => { if (cachedEpoch === p) cachedEpoch = null; });
  }
  return cachedEpoch;
}

/** Test hook: forget the cached epoch (a test swaps databases). */
export function __resetTaskDeltaEpochForTests(): void {
  cachedEpoch = null;
}

/** The cursor describing the server's state right now, from the worker reply
 *  piggyback `rev` (no database read) and the cached epoch. */
export async function currentTaskDeltaCursor(currentRev: number): Promise<string> {
  return formatTaskDeltaCursor(await primeTaskDeltaEpoch(), currentRev, currentDecorationRev());
}

/** Live badge counts for a set of rows: pending interactions (a pipeline
 *  parent's folds in its steps', from the known step -> parent pairs plus the
 *  rows' own `pipelineParentId`) and open terminals. */
function liveCounts(rows: readonly Task[]): { pending: Map<string, number>; terminals: Map<string, number> } {
  const parents = new Map<string, string>(pipelineParentPairs());
  for (const r of rows) if (r.pipelineParentId) parents.set(r.id, r.pipelineParentId);
  const pending = foldPipelineStepCounts(
    pendingCountsByTask(),
    [...parents].map(([id, pipelineParentId]) => ({ id, pipelineParentId })),
  );
  return { pending, terminals: terminalCountsByTask() };
}

export interface BuildTaskDeltaOptions {
  since: string | null;
  archived: TaskListArchived;
  keepIds: readonly string[];
  /** The `GET /tasks` row projection (trimmed `pipelineRun`, `runningSubagents`,
   *  `stalledSince`), shared with the legacy list so the two cannot drift. */
  toListRow: (task: Task, runningSubagents: number) => Task;
}

export async function buildTaskDelta(opts: BuildTaskDeltaOptions): Promise<TaskDelta> {
  // Decoration half first and synchronously: see the cursor note above.
  const decNow = currentDecorationRev();
  const parsed = parseTaskDeltaCursor(opts.since);
  let dbSince: { epoch: string; rev: number } | null = null;
  let decIds: string[] = [];
  if (parsed && parsed.boot === BOOT_ID && parsed.dec <= decNow) {
    const ids = decorationChangedSince(parsed.dec);
    if (ids) {
      dbSince = { epoch: parsed.dbEpoch, rev: parsed.rev };
      decIds = ids;
    }
  }
  const r = await op("tasks.changedSince", [dbSince, opts.archived, [...opts.keepIds]]);
  const { pending, terminals } = liveCounts(r.tasks);
  const tasks = r.tasks.map((t) =>
    opts.toListRow(
      {
        ...t,
        pendingInteractionCount: pending.get(t.id) ?? 0,
        openTerminalCount: terminals.get(t.id) ?? 0,
      },
      r.running[t.id] ?? 0,
    ),
  );
  const decorations: Record<string, TaskDecorations> = {};
  if (r.snapshot) {
    // Every task with a non-default decoration (the rows already carry them; the
    // map keeps the two paths speaking one vocabulary).
    for (const t of tasks) {
      const d: TaskDecorations = {};
      if (t.pendingInteractionCount > 0) d.pendingInteractions = t.pendingInteractionCount;
      if (t.openTerminalCount > 0) d.openTerminals = t.openTerminalCount;
      if ((t.runningSubagents ?? 0) > 0) d.runningSubagents = t.runningSubagents;
      if (t.stalledSince != null) d.stalledSince = t.stalledSince;
      if (Object.keys(d).length > 0) decorations[t.id] = d;
    }
  } else {
    for (const id of decIds) {
      decorations[id] = {
        pendingInteractions: pending.get(id) ?? 0,
        openTerminals: terminals.get(id) ?? 0,
        stalledSince: stalledSince(id),
      };
    }
  }
  cachedEpoch ??= Promise.resolve(r.epoch);
  return {
    format: "delta",
    cursor: formatTaskDeltaCursor(r.epoch, r.rev, decNow),
    snapshot: r.snapshot,
    tasks,
    removedIds: r.removedIds,
    decorations,
  };
}

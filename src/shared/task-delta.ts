import { TASK_LIST_KEEP_MAX, type Task, type TaskDecorations, type TaskDelta, type TaskListOptions } from "./types.ts";

// The one client-side implementation of the board's delta refresh (docs/plans/
// non-blocking-core.md, T12/T13/T14; docs/architecture/core-responsiveness.md
// "Delta and push"). The webview (`App.tsx`, through its task-delta client) and
// the TUI (`useTasks`) both merge `GET /tasks?delta=1` envelopes through
// `applyTaskDelta`; neither re-implements it. Pure: no I/O, no clock, no
// imports from either process.
//
// CONTRACT
//
//   applyTaskDelta(prev, delta, opts?) -> Task[]
//
//   - Never mutates `prev`, `delta` or any task in them.
//   - Identity: a task whose merged value is deep-equal to its `prev` entry keeps
//     the `prev` OBJECT (so memoized cards skip rendering). When nothing changed
//     at all (same ids, same order, every object identical) the `prev` ARRAY
//     itself is returned, so a `setState` bails out. Equality is a plain
//     `JSON.stringify` compare, the same rule as the webview's `reconcileById`;
//     `opts.cache` may share that function's memo (`{obj, json}` per id).
//   - `delta.snapshot === true`: the result is exactly `delta.tasks`, in the
//     server's order (rows absent from it are gone), still keeping the identity
//     of deep-equal rows. `removedIds` is empty on a snapshot.
//   - Otherwise: each task in `delta.tasks` replaces its row in place (or is
//     inserted at its `createdAt`-descending position when new; ties go after
//     the existing row), every id in `removedIds` is dropped, and the rest of
//     `prev` keeps its order and identity.
//   - Decorations: for each `[id, d]` in `delta.decorations`, `d` is overlaid on
//     that task: `pendingInteractions` -> `pendingInteractionCount`,
//     `openTerminals` -> `openTerminalCount`, `runningSubagents`,
//     `stalledSince`. A key absent from `d` leaves the field alone. An id with
//     no row in the merged list is ignored.
//
// WHAT THE CALLER OWES
//   - Keep `delta.cursor` and send it back as `since`. It is opaque.
//   - The cursor describes ONE filter (`archived` + `keep`). Forget it (fetch
//     without `since`) whenever the filter changes: a different view, a changed
//     `keep` set. A cursor from another server boot, another database or a
//     history too old is answered by the server with a snapshot, not an error.
//   - A response that is a bare array (an older core ignoring `delta=1`) is not a
//     delta: `isTaskDelta` tells them apart; treat an array as a full list.

export interface ApplyTaskDeltaOptions {
  /** Memo of each entry's serialized form, shared with `reconcileById` (optional). */
  cache?: Map<string, { obj: Task; json: string }>;
}

/** True for a `GET /tasks?delta=1` envelope; false for a legacy bare array. */
export function isTaskDelta(body: unknown): body is TaskDelta {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    && (body as { format?: unknown }).format === "delta"
    && Array.isArray((body as { tasks?: unknown }).tasks)
    && Array.isArray((body as { removedIds?: unknown }).removedIds)
    && typeof (body as { cursor?: unknown }).cursor === "string";
}

/** The `GET /tasks` path for a delta fetch: `taskListPath`'s query plus
 *  `delta=1` and, when there is a cursor, `since`. */
export function taskDeltaPath(opts: TaskListOptions = {}, since?: string | null): string {
  const params = new URLSearchParams();
  if (opts.archived && opts.archived !== "include") params.set("archived", opts.archived);
  const keep = [...new Set((opts.keep ?? []).filter((id) => id.length > 0))].slice(0, TASK_LIST_KEEP_MAX);
  if (params.has("archived") && keep.length > 0) params.set("keep", keep.join(","));
  params.set("delta", "1");
  if (since) params.set("since", since);
  return `/tasks?${params.toString()}`;
}

/** `task` with `d` overlaid, or `task` itself when no field would change. */
function overlay(task: Task, d: TaskDecorations | undefined): Task {
  if (!d) return task;
  const patch: Partial<Task> = {};
  if (d.pendingInteractions !== undefined && d.pendingInteractions !== task.pendingInteractionCount) {
    patch.pendingInteractionCount = d.pendingInteractions;
  }
  if (d.openTerminals !== undefined && d.openTerminals !== task.openTerminalCount) {
    patch.openTerminalCount = d.openTerminals;
  }
  if (d.runningSubagents !== undefined && d.runningSubagents !== task.runningSubagents) {
    patch.runningSubagents = d.runningSubagents;
  }
  if (d.stalledSince !== undefined && d.stalledSince !== (task.stalledSince ?? null)) {
    patch.stalledSince = d.stalledSince;
  }
  return Object.keys(patch).length > 0 ? { ...task, ...patch } : task;
}

export function applyTaskDelta(prev: Task[], delta: TaskDelta, opts: ApplyTaskDeltaOptions = {}): Task[] {
  const cache = opts.cache;
  const jsonOf = (t: Task): string => {
    const c = cache?.get(t.id);
    return c && c.obj === t ? c.json : JSON.stringify(t);
  };
  const prevById = new Map(prev.map((t) => [t.id, t] as const));
  /** Keep the `prev` object when the candidate is deep-equal to it. */
  const settle = (cand: Task): Task => {
    const old = prevById.get(cand.id);
    if (old === undefined) return cand;
    return old === cand || jsonOf(old) === JSON.stringify(cand) ? old : cand;
  };

  let next: Task[];
  if (delta.snapshot) {
    next = delta.tasks.map((t) => settle(overlay(t, delta.decorations[t.id])));
  } else {
    const removed = new Set(delta.removedIds);
    const changed = new Map<string, Task>();
    for (const t of delta.tasks) changed.set(t.id, settle(overlay(t, delta.decorations[t.id])));
    next = [];
    for (const t of prev) {
      if (removed.has(t.id)) continue;
      const c = changed.get(t.id);
      next.push(overlay(c ?? t, c ? undefined : delta.decorations[t.id]));
    }
    // A task both removed and changed in one delta cannot happen (a row is either
    // live or tombstoned); a removal wins if a server ever sends both.
    const added = [...changed.values()]
      .filter((t) => !prevById.has(t.id) && !removed.has(t.id))
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const t of added) {
      const at = next.findIndex((x) => x.createdAt < t.createdAt);
      const placed = overlay(t, undefined);
      if (at === -1) next.push(placed);
      else next.splice(at, 0, placed);
    }
  }

  if (cache) {
    for (const t of next) cache.set(t.id, { obj: t, json: cache.get(t.id)?.obj === t ? cache.get(t.id)!.json : JSON.stringify(t) });
    const keep = new Set(next.map((t) => t.id));
    for (const id of cache.keys()) if (!keep.has(id)) cache.delete(id);
  }
  return next.length === prev.length && next.every((t, i) => t === prev[i]) ? prev : next;
}

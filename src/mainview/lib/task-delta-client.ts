import { applyTaskDelta, isTaskDelta } from "../../shared/task-delta.ts";
import { TASK_LIST_KEEP_MAX, type Task, type TaskDelta, type TaskListOptions } from "../../shared/types.ts";
import { reconcileById } from "./reconcile.ts";

// The webview's board refresh controller (docs/plans/non-blocking-core.md, T13;
// docs/architecture/core-responsiveness.md "Delta and push"). It owns the
// delta cursor, the filter the cursor belongs to, the held server-truth list and
// the one-in-flight rule, so `App.tsx` stays a thin caller:
//
//   - `refresh()`  fetch now. A call during a fetch schedules exactly ONE
//                  follow-up fetch (N calls -> one follow-up, all sharing its
//                  promise), never a parallel request. The follow-up starts after
//                  the call, so a caller that awaits it after a mutation sees it.
//   - `notify(cursor)`  a `tasks-changed` push: skipped when `cursor` equals the
//                  held one, else `refresh()`.
//   - `poll()`     the safety poll tick: skipped while a fetch is in flight and
//                  until the interval has elapsed (15 s with the global stream
//                  connected, 2 s without).
//   - The cursor is forgotten whenever the filter (`archived` + `keep` set)
//     changes, and an answer fetched under a stale filter is discarded and
//     re-fetched. An older core's bare array is merged as a full list.
//
// The held list is the server's truth merged through `applyTaskDelta` (identity
// preserving, shared with the TUI); `commit` hands it to React on EVERY applied
// fetch, so an explicit `refresh()` after a failed optimistic patch restores the
// server row even though a delta carries no change for it.

export const TASK_POLL_CONNECTED_MS = 15_000;
export const TASK_POLL_DISCONNECTED_MS = 2_000;
/** A held cursor older than this is dropped at the next fetch, so a full
 *  snapshot heals any revision or decoration the delta path missed. */
export const TASK_FULL_RESYNC_MS = 5 * 60_000;
/** Timer jitter allowance: a 2 s interval tick may land a few ms early. */
const POLL_SLACK_MS = 250;

export interface TaskDeltaApplied {
  /** Ids the list now holds (what the toast sweep compares against). */
  ids: ReadonlySet<string>;
  /** Ids the previous successful fetch listed that this one no longer does
   *  (empty on the first fetch: a task never polled is never swept). */
  vanishedIds: readonly string[];
  /** Every archived row the list now holds (the whole held list, not just
   *  this fetch's rows, so the toast sweep matches the old per-poll one). */
  archivedIds: readonly string[];
  /** The filter this answer was fetched under. */
  opts: TaskListOptions;
}

export interface TaskDeltaClientDeps {
  fetch(opts: TaskListOptions, since: string | null): Promise<TaskDelta | Task[]>;
  getOpts(): TaskListOptions;
  /** Hand the merged list to state. */
  commit(list: Task[]): void;
  onApplied?(info: TaskDeltaApplied): void;
  /** Memo shared with `reconcileById`/`applyTaskDelta`. */
  cache?: Map<string, { obj: Task; json: string }>;
  now?: () => number;
}

/** Stable identity of what a cursor is valid for. `keep` only matters when the
 *  request carries it (`taskDeltaPath` drops it for `include`). */
export function taskFilterKey(opts: TaskListOptions, held?: ReadonlyMap<string, Task>): string {
  const archived = opts.archived ?? "include";
  if (archived === "include") return "include";
  let keep = [...new Set((opts.keep ?? []).filter((id) => id.length > 0))].slice(0, TASK_LIST_KEEP_MAX).sort();
  // With the held list known, a kept id only changes the answer when it needs
  // keeping: archived (an `exclude` view would drop it) or not held at all. An
  // active task is already in an `exclude` view's results, so opening, closing
  // or right-clicking it must not drop the cursor.
  if (held && archived === "exclude") {
    keep = keep.filter((id) => {
      const t = held.get(id);
      return !t || t.archivedAt != null;
    });
  }
  return `${archived}:${keep.join(",")}`;
}

export interface TaskDeltaClient {
  refresh(): Promise<Task[] | null>;
  notify(cursor: string): void;
  poll(): void;
  setConnected(connected: boolean): void;
  readonly connected: boolean;
  readonly cursor: string | null;
  readonly list: Task[];
}

export function createTaskDeltaClient(deps: TaskDeltaClientDeps): TaskDeltaClient {
  const now = deps.now ?? (() => Date.now());
  let list: Task[] = [];
  let held = new Map<string, Task>();
  let snapshotAt = Number.NEGATIVE_INFINITY;
  const keyOf = (): string => taskFilterKey(deps.getOpts(), held);
  let cursor: string | null = null;
  let cursorKey: string | null = null;
  let prevIds: Set<string> | null = null;
  let connected = false;
  let lastStart = Number.NEGATIVE_INFINITY;
  let current: Promise<Task[] | null> | null = null;
  let queued: Promise<Task[] | null> | null = null;

  async function fetchOnce(): Promise<Task[] | null> {
    const opts = deps.getOpts();
    const key = taskFilterKey(opts, held);
    if (cursorKey !== key) cursor = null;
    if (cursor !== null && now() - snapshotAt >= TASK_FULL_RESYNC_MS) cursor = null;
    const since = cursor;
    lastStart = now();
    let body: TaskDelta | Task[];
    try {
      body = await deps.fetch(opts, since);
    } catch {
      return null; // keep the last good list; the next trigger retries
    }
    // The view changed what the board carries while this was in flight: this
    // answer is for another filter. Drop it and ask again under the new one.
    if (keyOf() !== key) return fetchOnce();

    if (isTaskDelta(body)) {
      list = applyTaskDelta(list, body, { cache: deps.cache });
      cursor = body.cursor;
      if (body.snapshot) snapshotAt = now();
    } else if (Array.isArray(body)) {
      // An older core ignoring `delta=1`: a full list, no cursor to hold.
      list = reconcileById(list, body, (t) => t.id, deps.cache);
      cursor = null;
      cursorKey = null;
    } else {
      return null;
    }
    held = new Map(list.map((t) => [t.id, t]));
    // Stored against the post-apply held list, so the next fetch's key matches.
    if (cursor !== null) cursorKey = taskFilterKey(opts, held);
    const nextIds = new Set(held.keys());
    const archivedIds = list.filter((t) => t.archivedAt != null).map((t) => t.id);
    const vanishedIds = prevIds ? [...prevIds].filter((id) => !nextIds.has(id)) : [];
    prevIds = nextIds;
    deps.commit(list);
    deps.onApplied?.({ ids: nextIds, vanishedIds, archivedIds, opts });
    return list;
  }

  function start(): Promise<Task[] | null> {
    const p: Promise<Task[] | null> = fetchOnce().finally(() => {
      if (current === p) current = null;
    });
    current = p;
    return p;
  }

  function refresh(): Promise<Task[] | null> {
    if (!current) return start();
    if (!queued) {
      // `finally` semantics: a rejected in-flight fetch must never leave
      // `queued` set, or every later refresh() would share a dead promise.
      const run = (): Promise<Task[] | null> => {
        queued = null;
        return start();
      };
      queued = current.then(run, run);
    }
    return queued;
  }

  return {
    refresh,
    notify(c) {
      if (cursor !== null && c === cursor && cursorKey === keyOf()) return;
      void refresh();
    },
    poll() {
      if (current) return;
      const interval = connected ? TASK_POLL_CONNECTED_MS : TASK_POLL_DISCONNECTED_MS;
      if (now() - lastStart < interval - POLL_SLACK_MS) return;
      void refresh();
    },
    setConnected(c) { connected = c; },
    get connected() { return connected; },
    get cursor() { return cursor; },
    get list() { return list; },
  };
}

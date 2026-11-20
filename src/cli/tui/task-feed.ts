import { applyTaskDelta, isTaskDelta } from "../../shared/task-delta.ts";
import type { Task, TaskDelta, TaskListOptions } from "../../shared/types.ts";

/**
 * The TUI board's task list, fetched through the delta API (docs/plans/
 * non-blocking-core.md T14; docs/architecture/core-responsiveness.md "Delta and
 * push"). Pure of React so the rules are testable: `useTasks` is a thin shell.
 *
 *  - First fetch has no cursor and returns a snapshot; later fetches send the
 *    last `cursor` as `since` and merge through `applyTaskDelta`, which keeps the
 *    identity of unchanged rows (and the whole array when nothing changed).
 *  - A cursor describes ONE filter: `setFilter` drops it (and discards any fetch
 *    still in flight for the old filter).
 *  - A bare array (a core that ignores `delta=1`) is a legacy full list: merged
 *    as a snapshot, no cursor kept, so every later fetch is a full list too.
 *  - Never two fetches at once: a poll tick during a fetch is skipped; a
 *    `tasks-changed` push during a fetch re-runs it once when it ends.
 */
export interface TaskFeedOptions {
  fetch: (filter: TaskListOptions, since: string | null) => Promise<TaskDelta | Task[]>;
  filter: TaskListOptions;
  onChange: (tasks: Task[]) => void;
  /** Injected clock (ms), for the full-resync interval. */
  now?: () => number;
}

/** A held cursor older than this is dropped at the next fetch, so a full
 *  snapshot heals any revision or decoration the delta path missed. */
export const TASK_FEED_FULL_RESYNC_MS = 5 * 60_000;

export interface TaskFeed {
  /** Poll tick: fetch unless one is already in flight. */
  poll(): Promise<void>;
  /** `tasks-changed` push: fetch now unless `cursor` is the one already held;
   *  a fetch in flight is followed by exactly one more. */
  notify(cursor: string): Promise<void>;
  setFilter(filter: TaskListOptions): void;
  current(): Task[];
  /** Stop: no further `onChange` calls. */
  stop(): void;
}

export function createTaskFeed(opts: TaskFeedOptions): TaskFeed {
  let filter = opts.filter;
  let tasks: Task[] = [];
  let cursor: string | null = null;
  const now = opts.now ?? (() => Date.now());
  let snapshotAt = 0;
  let generation = 0;
  let inflight: Promise<void> | null = null;
  let rerun = false;
  let stopped = false;
  const cache = new Map<string, { obj: Task; json: string }>();

  async function fetchOnce(): Promise<void> {
    const gen = generation;
    try {
      if (cursor !== null && now() - snapshotAt >= TASK_FEED_FULL_RESYNC_MS) cursor = null;
      const body = await opts.fetch(filter, cursor);
      if (stopped || gen !== generation) return;
      let delta: TaskDelta;
      if (isTaskDelta(body)) {
        delta = body;
        cursor = body.cursor;
        if (body.snapshot) snapshotAt = now();
      } else if (Array.isArray(body)) {
        cursor = null;
        delta = { format: "delta", cursor: "", snapshot: true, tasks: body, removedIds: [], decorations: {} };
      } else {
        return;
      }
      const next = applyTaskDelta(tasks, delta, { cache });
      if (next !== tasks) {
        tasks = next;
        opts.onChange(tasks);
      }
    } catch {
      /* transient: keep the last good list and cursor */
    }
  }

  function run(): Promise<void> {
    if (inflight) return inflight;
    const p = (async () => {
      try {
        do {
          rerun = false;
          await fetchOnce();
        } while (rerun && !stopped);
      } finally {
        inflight = null;
      }
    })();
    inflight = p;
    return p;
  }

  return {
    poll: () => (inflight ? inflight : run()),
    notify(c) {
      if (stopped || c === cursor) return Promise.resolve();
      if (inflight) {
        rerun = true;
        return inflight;
      }
      return run();
    },
    setFilter(f) {
      filter = f;
      cursor = null;
      generation++;
      // A fetch for the old filter is discarded when it lands; the loop then
      // runs once more (never an overlapping fetch) with the new filter.
      if (inflight) rerun = true;
    },
    current: () => tasks,
    stop() {
      stopped = true;
    },
  };
}

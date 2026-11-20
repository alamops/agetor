// The tasks with a running run, kept in memory for the desktop app's quit
// prompt (index.ts's `before-quit` handler).
//
// Electrobun's `before-quit` hook is synchronous: it must decide (veto, ask,
// or allow) before it returns, so it cannot await a database read. This
// snapshot answers it instead. It is re-read whenever a database reply moves
// the task revision (`onRevChanged`, db-rpc.ts): migration 093's triggers bump
// it on every run insert and run status change, so a run that starts or ends
// is seen within one read. Reads are single-flight and spaced at least
// `minIntervalMs` apart, so a burst of task writes costs one read, not one
// per write. A failed read keeps the last snapshot and is logged once per
// failure streak.

export interface RunningTask {
  taskId: string;
  title: string;
}

export interface RunningTasksSnapshotDeps {
  /** One read of the running tasks (`runs.runningTasks`). */
  read: () => Promise<RunningTask[]>;
  /** Subscribe to task revision changes; returns the unsubscribe. */
  onChange: (cb: () => void) => () => void;
  /** Least time between two reads. */
  minIntervalMs: number;
  log: (msg: string) => void;
  now?: () => number;
}

export interface RunningTasksSnapshot {
  /** Subscribe and take the first read. Idempotent. */
  start(): void;
  /** Unsubscribe and drop a scheduled read. */
  stop(): void;
  /** The last snapshot read (empty before the first read lands). */
  current(): readonly RunningTask[];
}

export function createRunningTasksSnapshot(deps: RunningTasksSnapshotDeps): RunningTasksSnapshot {
  const now = deps.now ?? Date.now;
  let snapshot: readonly RunningTask[] = [];
  let unsubscribe: (() => void) | null = null;
  let inFlight: Promise<void> | null = null;
  /** A change arrived while a read was in flight: read again after it. */
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastReadAt = Number.NEGATIVE_INFINITY;
  let failing = false;

  async function readOnce(): Promise<void> {
    lastReadAt = now();
    try {
      snapshot = await deps.read();
      failing = false;
    } catch (err) {
      if (!failing) deps.log(`[agetor] reading the running tasks failed: ${err instanceof Error ? err.message : String(err)}`);
      failing = true;
    }
  }

  function runRead(): void {
    if (inFlight) {
      dirty = true;
      return;
    }
    dirty = false;
    inFlight = readOnce().finally(() => {
      inFlight = null;
      if (dirty && unsubscribe) schedule();
    });
  }

  function schedule(): void {
    if (timer || !unsubscribe) return;
    if (inFlight) {
      dirty = true;
      return;
    }
    const wait = Math.max(0, lastReadAt + deps.minIntervalMs - now());
    timer = setTimeout(() => {
      timer = null;
      runRead();
    }, wait);
    timer.unref?.();
  }

  return {
    start() {
      if (unsubscribe) return;
      unsubscribe = deps.onChange(schedule);
      runRead();
    },
    stop() {
      unsubscribe?.();
      unsubscribe = null;
      if (timer) clearTimeout(timer);
      timer = null;
      dirty = false;
    },
    current: () => snapshot,
  };
}

/**
 * What the quit prompt names: every task in the database snapshot, plus every
 * task this process has a live or starting run for (`liveTaskIds`, the
 * orchestrator's synchronous `liveRunTaskIds`) that the snapshot does not hold
 * yet, because the snapshot can trail a start by a read. Each task once,
 * snapshot order first. A task with no known title is named by its id, so a
 * missing title never drops it from the warning.
 */
export function quitRunningTasks(
  snapshot: readonly RunningTask[],
  liveTaskIds: readonly string[],
): RunningTask[] {
  const out: RunningTask[] = [];
  const seen = new Set<string>();
  const add = (taskId: string, title: string) => {
    if (seen.has(taskId)) return;
    seen.add(taskId);
    out.push({ taskId, title: title || taskId });
  };
  for (const t of snapshot) add(t.taskId, t.title);
  for (const id of liveTaskIds) add(id, "");
  return out;
}

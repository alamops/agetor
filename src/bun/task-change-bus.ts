// A tiny in-process pub/sub for "some task changed". The database client calls
// `markTasksChanged("rev")` when the task revision counter moves; a later
// emitter subscribes, throttles, and tells the board. No throttling here.

type Listener = (reason: string | undefined) => void;

const listeners = new Set<Listener>();

/** Announce that at least one task changed. A throwing listener is logged and
 *  never stops the others. */
export function markTasksChanged(reason?: string): void {
  for (const cb of [...listeners]) {
    try {
      cb(reason);
    } catch (e) {
      console.error("[agetor:task-change-bus] listener threw:", e instanceof Error ? e.message : e);
    }
  }
}

/** Subscribe; returns the unsubscribe function. */
export function onTasksChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

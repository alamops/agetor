/**
 * Persisted collapse state for the layout chrome (today: the New Task
 * sidebar).
 *
 * localStorage rather than the server-side preferences API on purpose: this
 * is pure webview chrome with no bearing on task state, and it has to resolve
 * *synchronously during the first render* — an async preference fetch would
 * paint the panel expanded and then snap it shut a frame later.
 *
 * Every access is wrapped: `globalThis.localStorage` throws (not returns
 * null) under some privacy/sandbox settings, and `setItem` throws on quota.
 * A storage failure must never take the panel down with it, so the reader
 * falls back to "expanded" and the writer is best-effort.
 */

/** Storage key for the New Task sidebar's collapsed flag. */
export const NEW_TASK_PANEL_COLLAPSED_KEY = "agetor:newTaskPanelCollapsed";

/** The slice of the Web Storage API we actually use — keeps tests to a
 *  two-method fake instead of a full `Storage` stub. */
export type PanelStorage = Pick<Storage, "getItem" | "setItem">;

/** Sentinel written for "collapsed". Anything else (including a missing key,
 *  `"false"`, or junk left by an older build) reads as expanded. */
const COLLAPSED = "1";
const EXPANDED = "0";

function defaultStorage(): PanelStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Read a persisted collapse flag. Defaults to `false` (expanded) whenever
 *  storage is unavailable, empty, or holds an unrecognized value. */
export function readCollapsed(
  key: string,
  storage: PanelStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(key) === COLLAPSED;
  } catch {
    return false;
  }
}

/** Persist a collapse flag. Best-effort — a throwing/full storage is
 *  swallowed, the panel just won't remember its state next launch. */
export function writeCollapsed(
  key: string,
  collapsed: boolean,
  storage: PanelStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(key, collapsed ? COLLAPSED : EXPANDED);
  } catch {
    /* quota / disabled storage — state simply doesn't persist */
  }
}

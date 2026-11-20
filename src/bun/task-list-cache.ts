/**
 * The `GET /tasks` answer cache (docs/architecture/core-responsiveness.md).
 *
 * The board polls the list every 2 s and the TUI every 1.5 s. Building it reads
 * every listed row from SQLite and serializes it, all on the one core thread,
 * so on a large board each poll held the thread for hundreds of milliseconds
 * even when nothing had changed. The route now keys its answer by a version
 * string that changes whenever anything the list is built from changes (rows of
 * `tasks`/`runs`/`subagents`, plus the in-memory pending-interaction, open
 * terminal, running-subagent and stall maps) and reuses the serialized body
 * while the version holds. Each body carries an `ETag`; a client that sends it
 * back in `If-None-Match` gets an empty 304.
 *
 * `maxAgeMs` bounds how long an answer is reused even with an unchanged
 * version: if an input were ever missed, the list would be at most that stale.
 */

export const TASK_LIST_CACHE_MAX_AGE_MS = 10_000;
export const TASK_LIST_CACHE_MAX_ENTRIES = 8;

export interface TaskListAnswer {
  body: string;
  etag: string;
}

/** A strong ETag for a serialized body. */
export function etagFor(body: string): string {
  return `"${Bun.hash(body).toString(36)}"`;
}

/** Whether an `If-None-Match` header names `etag` (a list, `W/` prefixes and
 *  `*` included, per RFC 9110's weak comparison for this header). */
export function ifNoneMatchMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const want = etag.replace(/^W\//, "");
  return header.split(",").some((raw) => {
    const t = raw.trim();
    return t === "*" || t.replace(/^W\//, "") === want;
  });
}

/** A stable string for per-task count maps: equal maps give equal strings. */
export function countsFingerprint(maps: readonly ReadonlyMap<string, number>[]): string {
  return maps
    .map((m) => [...m.entries()].filter(([, n]) => n !== 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, n]) => `${k}=${n}`).join(","))
    .join(";");
}

export function createTaskListCache(opts: { maxAgeMs?: number; maxEntries?: number; now?: () => number } = {}) {
  const maxAgeMs = opts.maxAgeMs ?? TASK_LIST_CACHE_MAX_AGE_MS;
  const maxEntries = Math.max(1, opts.maxEntries ?? TASK_LIST_CACHE_MAX_ENTRIES);
  const now = opts.now ?? Date.now;
  // Insertion order is recency: a hit or a rebuild re-inserts its key.
  const entries = new Map<string, { version: string; answer: TaskListAnswer; builtAt: number }>();
  return {
    /** The answer for `key` (the query: archive filter and kept ids) at
     *  `version`, reusing the last one built while both still hold. */
    get(key: string, version: string, build: () => string): TaskListAnswer {
      const t = now();
      const hit = entries.get(key);
      entries.delete(key);
      if (hit && hit.version === version && t - hit.builtAt < maxAgeMs) {
        entries.set(key, hit);
        return hit.answer;
      }
      const body = build();
      const answer = { body, etag: etagFor(body) };
      entries.set(key, { version, answer, builtAt: t });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return answer;
    },
    clear(): void {
      entries.clear();
    },
    size(): number {
      return entries.size;
    },
  };
}

/**
 * Pure rules behind the handoff artifact chips (`docs/plans/formatted-handoff.md`
 * D6/D7/K8): which absolute paths a set of artifacts needs stat'ed, whether a
 * path artifact is PROVEN missing, which candidate to try first on Open, and
 * the cached, de-duplicated `/refs/resolve` loader `useArtifactStats` wraps.
 * No React, no DOM, no `api` import — so it is unit-testable under bun (this
 * repo has no jsdom); the hook injects the real fetcher.
 */
import type { HandoffArtifact } from "./handoff-artifacts.ts";

/** What a stat says about one absolute path. `/refs/resolve` drops a path
 *  that doesn't exist, so every requested path gets an entry once a stat has
 *  landed: `exists: false` for one the server left out. */
export interface ArtifactPathStat {
  exists: boolean;
  isDirectory: boolean;
}

/** Stats for one stat'ed path set — `null` while unknown (not fetched yet,
 *  or the fetch failed). Unknown is never "missing" (the `SentFilesCard`
 *  rule). */
export type ArtifactStatsMap = ReadonlyMap<string, ArtifactPathStat> | null;

type PathArtifact = Extract<HandoffArtifact, { kind: "path" }>;

/** Every absolute candidate path of the `path` artifacts in `artifacts`,
 *  unique and sorted — the exact set one `/refs/resolve` call stats. */
export function artifactCandidatePaths(artifacts: readonly HandoffArtifact[]): string[] {
  const set = new Set<string>();
  for (const a of artifacts) {
    if (a.kind !== "path") continue;
    for (const c of a.candidates) if (c.startsWith("/")) set.add(c);
  }
  return [...set].sort();
}

/** The cache key for a stat'ed path set: its unique absolute paths, sorted,
 *  newline-joined (a path can't contain `\n` in practice, and if one did the
 *  key would only merge two sets that stat the same files anyway). `""` for
 *  a set with nothing to stat. */
export function artifactStatsKey(paths: readonly string[]): string {
  return [...new Set(paths.filter((p) => p.startsWith("/")))].sort().join("\n");
}

export interface PathArtifactStatus {
  /** Every candidate was stat'ed and none exists. Never true while the
   *  stats are unknown, or for an artifact with no absolute candidate (a
   *  relative path with no roots — the server may still resolve it). */
  missing: boolean;
  /** The first existing candidate is a directory (folder icon). */
  isDirectory: boolean;
  /** The first candidate the stat confirmed exists, else `null`. */
  confirmed: string | null;
}

/** Status of one path artifact under `stats`. */
export function pathArtifactStatus(a: PathArtifact, stats: ArtifactStatsMap): PathArtifactStatus {
  const absolute = a.candidates.filter((c) => c.startsWith("/"));
  if (stats === null || absolute.length === 0) {
    return { missing: false, isDirectory: a.display.endsWith("/"), confirmed: null };
  }
  let allKnownMissing = true;
  for (const c of absolute) {
    const s = stats.get(c);
    if (s === undefined) {
      allKnownMissing = false;
      continue;
    }
    if (s.exists) return { missing: false, isDirectory: s.isDirectory, confirmed: c };
  }
  return { missing: allKnownMissing, isDirectory: a.display.endsWith("/"), confirmed: null };
}

/** The paths to try, in order, when a path artifact is opened or revealed:
 *  the stat-confirmed candidate first, then the other candidates in their
 *  root order. An artifact with no candidates (a relative path with no
 *  roots) falls back to its display path — the caller sends it with the
 *  `taskId`, so the server resolves it against the task's cwd. */
export function artifactOpenOrder(a: PathArtifact, stats: ArtifactStatsMap): string[] {
  if (a.candidates.length === 0) return [a.display];
  const { confirmed } = pathArtifactStatus(a, stats);
  if (confirmed === null) return [...a.candidates];
  return [confirmed, ...a.candidates.filter((c) => c !== confirmed)];
}

/** The path a dialog or Copy path shows for a path artifact: the confirmed
 *  candidate, else the first candidate, else the display path. */
export function artifactPrimaryPath(a: PathArtifact, stats: ArtifactStatsMap): string {
  return pathArtifactStatus(a, stats).confirmed ?? a.candidates[0] ?? a.display;
}

/** How long a landed stat is reused before a fresh mount stats again. */
export const ARTIFACT_STATS_TTL_MS = 30_000;

export interface ArtifactStatsCache {
  /** The fresh stats for `key`, or `undefined` when none (never fetched,
   *  expired, or the last fetch failed). */
  peek(key: string): ReadonlyMap<string, ArtifactPathStat> | undefined;
  /** Stat `paths` (whose {@link artifactStatsKey} is `key`). Resolves from a
   *  fresh cache entry, joins an in-flight request for the same key, or
   *  starts one. A failure rejects and is NOT cached, so the next call
   *  retries. */
  load(key: string, paths: readonly string[]): Promise<ReadonlyMap<string, ArtifactPathStat>>;
  /** Drop the cached entry for `key`, so the next `load` stats again (a click
   *  whose outcome contradicted the stat). An in-flight load is kept. */
  invalidate(key: string): void;
  /** Call `listener` whenever a load for `key` lands a new entry — so every
   *  mounted view of one path set picks up a re-stat another view (or a
   *  forced re-check) triggered, instead of keeping the value it last saw.
   *  Returns the unsubscribe function. */
  subscribe(key: string, listener: () => void): () => void;
  /** Drop every cached entry (tests). */
  clear(): void;
}

/**
 * A module-level stat cache over `fetcher` (`api.resolveRefs` in the app):
 * one request per unique sorted path set, entries kept for `ttlMs`, at most
 * `maxEntries` sets (oldest dropped first), concurrent loads of one key
 * de-duplicated, failures never cached.
 */
export function createArtifactStatsCache(
  fetcher: (paths: string[]) => Promise<ReadonlyArray<{ path: string; isDirectory: boolean }>>,
  opts?: { ttlMs?: number; now?: () => number; maxEntries?: number },
): ArtifactStatsCache {
  const ttl = opts?.ttlMs ?? ARTIFACT_STATS_TTL_MS;
  const now = opts?.now ?? (() => Date.now());
  const maxEntries = opts?.maxEntries ?? 256;
  const entries = new Map<string, { at: number; value: ReadonlyMap<string, ArtifactPathStat> }>();
  const inflight = new Map<string, Promise<ReadonlyMap<string, ArtifactPathStat>>>();
  const listeners = new Map<string, Set<() => void>>();

  const notify = (key: string) => {
    const set = listeners.get(key);
    if (set === undefined) return;
    // Copy: a listener may unsubscribe (or subscribe) while we iterate.
    for (const fn of [...set]) {
      try {
        fn();
      } catch {
        // One view's failure must not keep the others stale.
      }
    }
  };

  const peek = (key: string) => {
    const hit = entries.get(key);
    if (hit === undefined) return undefined;
    if (now() - hit.at > ttl) {
      entries.delete(key);
      return undefined;
    }
    return hit.value;
  };

  const load = (key: string, paths: readonly string[]) => {
    const fresh = peek(key);
    if (fresh !== undefined) return Promise.resolve(fresh);
    const pending = inflight.get(key);
    if (pending !== undefined) return pending;
    const requested = [...new Set(paths.filter((p) => p.startsWith("/")))].sort();
    const p = fetcher(requested)
      .then((refs) => {
        const found = new Map(refs.map((r) => [r.path, r.isDirectory] as const));
        const value = new Map<string, ArtifactPathStat>();
        for (const path of requested) {
          const isDirectory = found.get(path);
          value.set(path, { exists: isDirectory !== undefined, isDirectory: isDirectory === true });
        }
        entries.set(key, { at: now(), value });
        while (entries.size > maxEntries) {
          const oldest = entries.keys().next();
          if (oldest.done) break;
          entries.delete(oldest.value);
        }
        notify(key);
        return value as ReadonlyMap<string, ArtifactPathStat>;
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, p);
    return p;
  };

  return {
    peek,
    load,
    invalidate: (key: string) => {
      entries.delete(key);
    },
    subscribe: (key: string, listener: () => void) => {
      let set = listeners.get(key);
      if (set === undefined) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      return () => {
        const current = listeners.get(key);
        if (current === undefined) return;
        current.delete(listener);
        if (current.size === 0) listeners.delete(key);
      };
    },
    clear: () => {
      entries.clear();
      inflight.clear();
    },
  };
}

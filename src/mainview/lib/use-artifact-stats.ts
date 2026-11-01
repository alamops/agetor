import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { api } from "./api";
import {
  artifactStatsKey,
  createArtifactStatsCache,
  type ArtifactPathStat,
} from "./handoff-artifact-status";

/** One cache for every handoff card in the webview (K8): the same artifact
 *  set rendered by the transcript card, the run-view history card and a
 *  re-mount after a scroll shares one `/refs/resolve`. */
const artifactStatsCache = createArtifactStatsCache((paths) => api.resolveRefs(paths));

export interface ArtifactStatsResult {
  /** True once a stat for exactly this path set has landed. While false,
   *  `stats` is empty and nothing may be treated as missing. */
  known: boolean;
  /** One entry per requested absolute path once `known`. */
  stats: ReadonlyMap<string, ArtifactPathStat>;
  /** Stat the set again: when `force`, always (a click outcome contradicted
   *  the stat); otherwise only when the cached entry has expired — cheap to
   *  call on hover/focus, so a mounted card re-checks past the TTL without
   *  polling. Stable for an unchanged path set. */
  recheck: (force?: boolean) => void;
}

const EMPTY_STATS: ReadonlyMap<string, ArtifactPathStat> = new Map();

/**
 * Existence and directory-ness of `candidatePaths` (absolute paths; anything
 * else is ignored) via one batched `/refs/resolve` per unique sorted set —
 * module-cached for 30 s, de-duplicated while in flight, failures never
 * cached ("unknown is never missing", the `SentFilesCard` rule). The result
 * is stable for an unchanged path set, so it is safe in memo deps.
 */
export function useArtifactStats(candidatePaths: readonly string[]): ArtifactStatsResult {
  const key = useMemo(() => artifactStatsKey(candidatePaths), [candidatePaths]);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  // The last stats this instance saw for `key`: a cache entry expiring
  // while the card stays mounted must not flip it back to "unknown".
  const lastRef = useRef<{ key: string; value: ReadonlyMap<string, ArtifactPathStat> } | null>(null);

  // Re-render whenever ANY load of this set lands — this view's own, another
  // card's, or a forced re-check — so two views of one artifact set (the
  // transcript card and the run-view history card) never disagree.
  useEffect(() => {
    if (key === "") return;
    const unsubscribe = artifactStatsCache.subscribe(key, rerender);
    // A load that landed between this render and the subscription.
    const fresh = artifactStatsCache.peek(key);
    if (fresh !== undefined && (lastRef.current?.key !== key || lastRef.current.value !== fresh)) rerender();
    return unsubscribe;
  }, [key]);

  useEffect(() => {
    if (key === "" || artifactStatsCache.peek(key) !== undefined) return;
    artifactStatsCache.load(key, key.split("\n")).catch(() => {
      // Network hiccup or a headless quirk — leave the chips unknown.
    });
  }, [key]);

  const recheck = useCallback(
    (force = false) => {
      if (key === "") return;
      if (force) artifactStatsCache.invalidate(key);
      else if (artifactStatsCache.peek(key) !== undefined) {
        // Fresh in the cache, but possibly newer than what this view shows
        // (another view re-stat'ed while this one held its last value).
        if (lastRef.current?.key !== key || lastRef.current.value !== artifactStatsCache.peek(key)) rerender();
        return;
      }
      artifactStatsCache.load(key, key.split("\n")).catch(() => {
        // Keep the last stats — unknown is never missing.
      });
    },
    [key],
  );

  const fresh = key === "" ? undefined : artifactStatsCache.peek(key);
  if (fresh !== undefined) lastRef.current = { key, value: fresh };
  const value = fresh ?? (lastRef.current?.key === key ? lastRef.current.value : undefined);

  return useMemo(
    () =>
      value === undefined ? { known: false, stats: EMPTY_STATS, recheck } : { known: true, stats: value, recheck },
    [value, recheck],
  );
}

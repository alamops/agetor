import { useEffect, useMemo, useReducer, useRef } from "react";
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

  useEffect(() => {
    if (key === "" || artifactStatsCache.peek(key) !== undefined) return;
    let cancelled = false;
    artifactStatsCache
      .load(key, key.split("\n"))
      .then(() => {
        if (!cancelled) rerender();
      })
      .catch(() => {
        // Network hiccup or a headless quirk — leave the chips unknown.
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const fresh = key === "" ? undefined : artifactStatsCache.peek(key);
  if (fresh !== undefined) lastRef.current = { key, value: fresh };
  const value = fresh ?? (lastRef.current?.key === key ? lastRef.current.value : undefined);

  return useMemo(
    () => (value === undefined ? { known: false, stats: EMPTY_STATS } : { known: true, stats: value }),
    [value],
  );
}

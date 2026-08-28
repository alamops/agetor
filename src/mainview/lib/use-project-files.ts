// Loads and caches the `@` file-reference listing for a project scope, and
// turns it into the `FileEntry[]`/`validPaths` shapes `AtFileAutocomplete`
// and `AtHighlightBackdrop` need. See docs/plans/at-file-references.md §3.3
// for the per-surface scope derivation this hook is agnostic to — callers
// (RunPanel, NewTaskForm, the issue/resolve-conflicts dialogs) just pass a
// `FileScope`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { buildFileEntries, type FileEntry } from "./at-file-filter";

/** The project scope a listing is fetched against — mirrors `GET
 *  /files/index`'s two query params. `ref` given selects the `git ls-tree`
 *  mode (tracked files at that ref); omitted/null selects the live `git
 *  ls-files` mode. `dir` is the absolute path the server runs git in. */
export interface FileScope {
  dir: string;
  ref?: string | null;
}

interface CacheEntry {
  files: string[];
  truncated: boolean;
}

function cacheKey(scope: { dir: string; ref?: string | null }): string {
  return `${scope.dir} ${scope.ref ?? ""}`;
}

// Module-level so a second composer open against the same scope (dir + ref)
// — e.g. the RunPanel and a New Task form both pointed at the same worktree
// — renders its file list instantly from cache instead of refetching, and so
// a scope change is deduped across every mounted consumer sharing that key.
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

function fetchEntry(scope: { dir: string; ref?: string | null }): Promise<CacheEntry> {
  const key = cacheKey(scope);
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = api.listProjectFiles(scope)
    .catch((e: unknown) => {
      // Never throw into a render — an unreachable server or a bad `ref`
      // just means "no suggestions yet", not a crash.
      console.warn("[agetor] listProjectFiles failed", e);
      return { files: [], truncated: false } as CacheEntry;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

/**
 * Loads (and caches) the file listing for `scope`. `null`/`undefined`
 * (no project/scope resolved yet) or a blank `dir` skips fetching entirely
 * and yields empty results. Refetches whenever `scope.dir`/`scope.ref`
 * changes; `refresh()` forces another fetch for the current scope (e.g. on
 * textarea focus, to pick up files the agent just created).
 */
export function useProjectFiles(scope: FileScope | null | undefined): {
  entries: FileEntry[];
  validPaths: Set<string>;
  truncated: boolean;
  loading: boolean;
  refresh: () => void;
} {
  const hasScope = !!(scope && scope.dir);
  const initialKey = hasScope ? cacheKey(scope!) : null;
  const [files, setFiles] = useState<string[]>(() => (initialKey ? cache.get(initialKey)?.files ?? [] : []));
  const [truncated, setTruncated] = useState<boolean>(
    () => (initialKey ? cache.get(initialKey)?.truncated ?? false : false),
  );
  const [loading, setLoading] = useState(false);
  // Bumped by `refresh()` to force a refetch even when the scope itself
  // hasn't changed.
  const [gen, setGen] = useState(0);

  // Guards a response from a superseded request (scope changed mid-flight,
  // or a newer `refresh()` fired) from clobbering fresher state.
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!scope || !scope.dir) {
      setFiles([]);
      setTruncated(false);
      setLoading(false);
      return;
    }

    const thisScope = { dir: scope.dir, ref: scope.ref };
    const key = cacheKey(thisScope);
    const cached = cache.get(key);
    setFiles(cached?.files ?? []);
    setTruncated(cached?.truncated ?? false);

    const requestId = ++requestIdRef.current;
    setLoading(true);
    fetchEntry(thisScope).then((entry) => {
      cache.set(key, entry);
      if (requestIdRef.current !== requestId) return; // superseded — drop it
      setFiles(entry.files);
      setTruncated(entry.truncated);
      setLoading(false);
    });
    // `insert`-style closures aside, the only inputs that should trigger a
    // refetch are the scope's own fields (not a fresh object identity every
    // render) and `gen` (refresh()).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.dir, scope?.ref, gen]);

  const refresh = useCallback(() => setGen((g) => g + 1), []);

  const entries = useMemo(() => buildFileEntries(files), [files]);
  const validPaths = useMemo(() => new Set(entries.map((e) => e.path)), [entries]);

  return { entries, validPaths, truncated, loading, refresh };
}

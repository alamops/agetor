// Loads and caches the `@` file-reference listing for a project scope, and
// turns it into the `FileEntry[]`/`validPaths` shapes `AtFileAutocomplete`
// and `AtHighlightBackdrop` need. See docs/plans/at-file-references.md §3.3
// for the per-surface scope derivation this hook is agnostic to — callers
// (RunPanel, NewTaskForm, the issue/resolve-conflicts dialogs) just pass a
// `FileScope`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { buildFileEntries, type FileEntry } from "../../shared/at-file-filter.ts";

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

/** A resolved fetch attempt: `error` is null on success, or the failure
 *  message on failure (from the `{ error }` 400 body via `ApiError.message`,
 *  or the thrown error's own message). Deliberately NOT the same shape as
 *  `CacheEntry` — a failed attempt must never be written to `cache` (see
 *  `fetchEntry`'s doc), so keeping the two types distinct is what stops a
 *  future edit from accidentally `cache.set`-ing a failure result. */
interface FetchResult {
  entry: CacheEntry;
  error: string | null;
}

function cacheKey(scope: { dir: string; ref?: string | null }): string {
  return `${scope.dir} ${scope.ref ?? ""}`;
}

// Module-level so a second composer open against the same scope (dir + ref)
// — e.g. the RunPanel and a New Task form both pointed at the same worktree
// — renders its file list instantly from cache instead of refetching, and so
// a scope change is deduped across every mounted consumer sharing that key.
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<FetchResult>>();

/** Never throws into a render and never populates `cache` on failure — a
 *  down server or a bad `ref` must not coerce into a cached `{files: [],
 *  truncated: false}` entry, or every other composer sharing this scope
 *  would render an empty listing (no error, no retry) until something else
 *  happens to trigger a refetch. Failures are surfaced via `FetchResult
 *  .error` instead and left for the caller to decide what (if anything) to
 *  cache. */
function fetchEntry(scope: { dir: string; ref?: string | null }): Promise<FetchResult> {
  const key = cacheKey(scope);
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = api.listProjectFiles(scope)
    .then((entry): FetchResult => ({ entry, error: null }))
    .catch((e: unknown): FetchResult => {
      console.warn("[agetor] listProjectFiles failed", e);
      const message = e instanceof Error ? e.message : String(e);
      return { entry: { files: [], truncated: false }, error: message };
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
 * textarea focus, to pick up files the agent just created) and also drops
 * any cached `searchProjectFiles` answers for that scope (see
 * `clearSearchCacheForScope`) — otherwise a truncated scope's remote search
 * results could keep serving a stale answer for up to `SEARCH_CACHE_TTL_MS`
 * after a run-settle refresh, defeating the point of forcing one.
 */
export function useProjectFiles(scope: FileScope | null | undefined): {
  entries: FileEntry[];
  validPaths: Set<string>;
  truncated: boolean;
  loading: boolean;
  /** Non-null when the most recent fetch attempt for the current scope
   *  failed (server unreachable, bad `ref`, …) — the `{ error }` 400 body's
   *  message, or the thrown error's own message. Cleared on the next
   *  successful fetch for this scope. A failure never touches `entries`/
   *  `validPaths`/`truncated` (they keep whatever was last known-good for
   *  this scope, empty if nothing ever succeeded) and never poisons the
   *  shared module-level cache — see `fetchEntry`. */
  error: string | null;
  refresh: () => void;
} {
  const hasScope = !!(scope && scope.dir);
  const initialKey = hasScope ? cacheKey(scope!) : null;
  const [files, setFiles] = useState<string[]>(() => (initialKey ? cache.get(initialKey)?.files ?? [] : []));
  const [truncated, setTruncated] = useState<boolean>(
    () => (initialKey ? cache.get(initialKey)?.truncated ?? false : false),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      setError(null);
      return;
    }

    const thisScope = { dir: scope.dir, ref: scope.ref };
    const key = cacheKey(thisScope);
    const cached = cache.get(key);
    setFiles(cached?.files ?? []);
    setTruncated(cached?.truncated ?? false);

    const requestId = ++requestIdRef.current;
    setLoading(true);
    fetchEntry(thisScope).then(({ entry, error }) => {
      if (requestIdRef.current !== requestId) return; // superseded — drop it
      if (error) {
        // Do NOT cache.set here — a failed listing must not overwrite (or
        // manufacture) a cache entry for this scope; every other composer
        // sharing it keeps whatever it already had. `files`/`truncated`
        // likewise stay at whatever was set above (the cached entry, or
        // empty if this scope never succeeded).
        setError(error);
        setLoading(false);
        return;
      }
      cache.set(key, entry);
      setFiles(entry.files);
      setTruncated(entry.truncated);
      setError(null);
      setLoading(false);
    });
    // `insert`-style closures aside, the only inputs that should trigger a
    // refetch are the scope's own fields (not a fresh object identity every
    // render) and `gen` (refresh()).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.dir, scope?.ref, gen]);

  const refresh = useCallback(() => {
    // Clear remote-search results for this scope FIRST, so a caller that
    // awaits nothing (the common case — `refresh()` is fire-and-forget) can't
    // observe a stale cached `searchProjectFiles` answer served in between.
    if (scope?.dir) clearSearchCacheForScope({ dir: scope.dir, ref: scope.ref });
    setGen((g) => g + 1);
  }, [scope?.dir, scope?.ref]);

  const entries = useMemo(() => buildFileEntries(files), [files]);
  const validPaths = useMemo(() => new Set(entries.map((e) => e.path)), [entries]);

  return { entries, validPaths, truncated, loading, error, refresh };
}

// ---------------------------------------------------------------------------
// searchProjectFiles — server-side full-depth search, for when a scope's base
// listing (above) came back `truncated` (a monorepo past `MAX_PROJECT_FILES`,
// see at-refs.ts). `GET /files/index?q=` ranks the FULL listing — not just
// the capped set `useProjectFiles` caches — via the same `filterFileEntries`
// scorer the client uses locally, so a past-the-cap file can still be found
// by name. Consumed by `AtFileAutocomplete` (popover fallback) and
// `PromptComposer` (highlight/warning verification of individual tokens).
// ---------------------------------------------------------------------------

/** Result cache for `searchProjectFiles`, keyed on scope + `limit` + exact
 *  query text (unlike `cache` above, which is keyed on scope alone) — so
 *  backspacing through a query re-renders instantly from cache instead of
 *  re-fetching on every keystroke. `limit` is part of the key because a
 *  `limit: 20` verification answer (`PromptComposer`'s truncated-scope
 *  per-token check) must never silently serve a `limit: 50` popover request
 *  (`AtFileAutocomplete`) for the same query — the popover would render
 *  fewer rows than it asked for. Each entry is stamped with `at: Date.now()`
 *  and treated as a miss once older than `SEARCH_CACHE_TTL_MS`: this enforces
 *  the same 3s TTL the server places on the underlying listing a query is
 *  ranked against (`Q_MODE_CACHE_TTL_MS` in `project-files.ts`) — a prior
 *  version of this comment claimed the server's own TTL alone bounded
 *  staleness here, but an *unstamped* client cache entry never expires on
 *  its own, so it would happily keep serving a 10-minute-old answer forever.
 *  Also cleared per-scope by `clearSearchCacheForScope` (called from
 *  `useProjectFiles`'s `refresh()`) so a forced refresh — e.g. the run-settle
 *  `fileScopeRefreshToken` — doesn't have to wait out the TTL either. Capped
 *  at `SEARCH_CACHE_MAX` entries, evicting the oldest (first-inserted) key
 *  once full — a plain `Map`'s insertion-order iteration makes that a
 *  one-line `delete`, no LRU bookkeeping needed for what's just a
 *  keystroke-smoothing cache. */
export const SEARCH_CACHE_MAX = 200;
export const SEARCH_CACHE_TTL_MS = 3000;
const searchCache = new Map<string, { rows: FileEntry[]; at: number }>();

function searchCacheKey(scope: FileScope, q: string, limit: number): string {
  return `${scope.dir}\0${scope.ref ?? ""}\0${limit}\0${q}`;
}

/** Prefix shared by every `searchCacheKey` for `scope`, regardless of query
 *  or limit — `dir`/`ref` come first in the key precisely so this prefix
 *  match works. */
function searchScopePrefix(scope: FileScope): string {
  return `${scope.dir}\0${scope.ref ?? ""}\0`;
}

function setSearchCacheEntry(key: string, rows: FileEntry[]): void {
  if (searchCache.size >= SEARCH_CACHE_MAX && !searchCache.has(key)) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey !== undefined) searchCache.delete(oldestKey);
  }
  searchCache.set(key, { rows, at: Date.now() });
}

/**
 * Drops every cached `searchProjectFiles` answer for `scope` — any query,
 * any `limit`. Called from `useProjectFiles`'s `refresh()` so a forced
 * refresh (textarea focus, the run-settle `fileScopeRefreshToken`) actually
 * invalidates a truncated scope's remote search results too, not just the
 * base listing `useProjectFiles` itself caches — restoring the mid-run
 * freshness guarantee `fileScopeRefreshToken` provides for scopes under the
 * cap to scopes past it as well.
 */
export function clearSearchCacheForScope(scope: FileScope): void {
  const prefix = searchScopePrefix(scope);
  for (const key of [...searchCache.keys()]) {
    if (key.startsWith(prefix)) searchCache.delete(key);
  }
}

// Scopes (dir+ref, via the existing `cacheKey`) already warned about after a
// failed search — at most one `console.warn` per scope until a subsequent
// successful search re-arms it, so a flaky server (or a scope with no
// network path) doesn't spam the console on every keystroke of a fast typer.
const searchWarnedScopes = new Set<string>();

/**
 * Server-side ranked search over a scope's FULL file listing (`GET
 * /files/index?q=`), for use once `useProjectFiles` reports `truncated` —
 * the client-cached listing is capped at `MAX_PROJECT_FILES` and can't find
 * anything past it. Resolves to up to `limit` `FileEntry` rows (files plus
 * derived directories, matching `buildFileEntries`'s shape — a directory
 * path ends with "/") — including a genuinely empty `[]` when the server
 * ranked the query and found nothing.
 *
 * Resolves to `null` — deliberately NOT `[]` — when the REQUEST itself
 * failed (network error, non-2xx, a bad `ref`, …): `null` means "unknown,"
 * `[]` means "the server looked and there's nothing." A caller that
 * conflated the two would read a transient outage as proof a file doesn't
 * exist — e.g. warning on an `@`-token that's actually fine, or silently
 * dropping rows a popover already had. See the two call sites
 * (`AtFileAutocomplete`'s remote-search effect, `PromptComposer`'s
 * truncated-scope verification effect) for how each keeps the "unproven"
 * state distinct from "confirmed missing."
 *
 * `null`/blank `scope.dir` resolves to `[]`, not `null` — there is no
 * request in flight to have failed. A failure additionally `console.warn`s,
 * at most once per scope (see `searchWarnedScopes`) until a later call
 * against that same scope succeeds, and — unlike a success — is never
 * written to `searchCache`: caching a transient failure would make it
 * durably "not found" for up to `SEARCH_CACHE_TTL_MS`.
 */
export async function searchProjectFiles(scope: FileScope, q: string, limit = 50): Promise<FileEntry[] | null> {
  if (!scope || !scope.dir) return [];
  const scopeWarnKey = cacheKey(scope);
  const resultKey = searchCacheKey(scope, q, limit);
  const cached = searchCache.get(resultKey);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) return cached.rows;
  try {
    const { files } = await api.listProjectFiles({ dir: scope.dir, ref: scope.ref, q, limit });
    const entries: FileEntry[] = files.map((path) => ({ path, isDirectory: path.endsWith("/") }));
    setSearchCacheEntry(resultKey, entries);
    searchWarnedScopes.delete(scopeWarnKey);
    return entries;
  } catch (e) {
    if (!searchWarnedScopes.has(scopeWarnKey)) {
      searchWarnedScopes.add(scopeWarnKey);
      console.warn("[agetor] searchProjectFiles failed", e);
    }
    return null;
  }
}

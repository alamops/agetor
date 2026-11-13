// Loads and caches the `@` file-reference listing for a project scope, and
// turns it into the `FileEntry[]`/`validPaths` shapes `AtFileAutocomplete`
// and `AtHighlightBackdrop` need. See docs/plans/at-file-references.md §3.3
// for the per-surface scope derivation this hook is agnostic to — callers
// (RunPanel, NewTaskForm, the issue/resolve-conflicts dialogs) just pass a
// `FileScope`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { addScopeRoots, buildFileEntries, type FileEntry } from "../../shared/at-file-filter.ts";
import { splitNamedScopePath } from "../../shared/file-scope.ts";
import { mapWithConcurrency } from "./map-with-concurrency.ts";

/** Per-repository requests a multi-repository listing or search keeps in
 *  flight at once. WKWebView allows about six HTTP/1.1 connections per host
 *  and two are permanent SSE channels; a 16-repository task opened with one
 *  unbounded `Promise.all` queued the task's own event stream behind its
 *  listing requests (see docs/architecture/multi-repo-tasks.md). */
export const MULTI_SCOPE_CONCURRENCY = 2;

/** A focus-triggered multi-repository refresh skips every repository whose
 *  listing was fetched (or is being fetched) within this window, so tabbing
 *  in and out of the composer doesn't re-list every repository each time. A
 *  forced refresh (the run-settle `fileScopeRefreshToken`) ignores it. */
export const FOCUS_REFRESH_MIN_AGE_MS = 5000;

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
// When each scope's listing last came back successfully — the freshness test
// for a coalesced (focus) refresh of a multi-repository listing.
const fetchedAt = new Map<string, number>();

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
    .then((entry): FetchResult => {
      fetchedAt.set(key, Date.now());
      return { entry, error: null };
    })
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

/** One repository's scope, tagged with its workspace name (issue #291). */
export interface NamedFileScope extends FileScope {
  name: string;
}

/**
 * The named scopes a composer lists through, or null for the single-scope
 * path. Callers pass named scopes only for a multi-repository task, so their
 * presence (not a count) decides: a multi task left with ONE repository
 * (issue #291) still lists `<name>/…`, because its agent's cwd is the non-git
 * workspace root. The one rule `PromptComposer`, `AtFileAutocomplete`, the run
 * panel's draft editor and {@link useProjectFileScopes} share.
 */
export function multiScopesOrNull<T>(scopes: T[] | null | undefined): T[] | null {
  return scopes && scopes.length > 0 ? scopes : null;
}

/**
 * Resolve a multi-repository `@` token/query to the repository scope it names.
 * A multi listing prefixes every entry with its workspace name
 * (`uniqueRepoSlugs`), so the first path segment must equal one of `scopes`'
 * names. Returns that scope plus the repo-local remainder (a trailing slash is
 * preserved, so directory tokens keep their shape), or `null` for an
 * unprefixed path / unknown name — neither can resolve inside the multi
 * workspace, where only `<name>/<path>` exists.
 */
export function resolveNamedScopePath(
  scopes: readonly NamedFileScope[] | null | undefined,
  path: string,
): { scope: NamedFileScope; path: string } | null {
  // The prefix grammar lives in `src/shared/file-scope.ts` so the CLI's
  // advisory pre-check resolves tokens exactly like this popover does.
  return splitNamedScopePath(scopes, path);
}

/**
 * Merge the per-scope cached listings for `scopes` into the prefixed shape the
 * multi listing renders, or `null` when ANY scope has no cached entry yet.
 * `useProjectFileScopes` uses the result to seed (or clear) its state the
 * moment its scope key changes: without that, a RunPanel task switch kept the
 * PREVIOUS task's `@` entries on screen until every repository answered.
 * A partial cache is deliberately not returned either — showing only some
 * repositories' files is not the new scope's listing, and `null` makes the
 * caller clear instead of pretending otherwise.
 *
 * `lookup` is injectable so the merge/clear decision is unit-testable without
 * a React harness; production passes the module-level listing cache.
 */
export function cachedMultiScopeListing(
  scopes: readonly NamedFileScope[],
  lookup: (scope: FileScope) => { files: string[]; truncated: boolean } | undefined = (scope) =>
    cache.get(cacheKey(scope)),
): { files: string[]; truncated: boolean } | null {
  const files: string[] = [];
  let truncated = false;
  for (const scope of scopes) {
    const cached = lookup({ dir: scope.dir, ref: scope.ref });
    if (!cached) return null;
    files.push(...cached.files.map((f) => `${scope.name}/${f}`));
    if (cached.truncated) truncated = true;
  }
  return { files, truncated };
}

/**
 * Whether every scope's listing is fresh enough that a coalesced refresh can
 * skip it: cached and fetched within `maxAgeMs`, or already in flight (the
 * in-flight request is about to deliver exactly what a refetch would).
 * `now` is injectable for tests.
 */
export function scopeListingIsFresh(scope: FileScope, maxAgeMs: number, now: number = Date.now()): boolean {
  const key = cacheKey(scope);
  if (inflight.has(key)) return true;
  const at = fetchedAt.get(key);
  return cache.has(key) && at !== undefined && now - at < maxAgeMs;
}

/**
 * Fetch and merge a multi-repository listing: the module-level half of
 * {@link useProjectFileScopes}, kept outside the hook so its request pattern
 * is unit-testable without a React harness.
 *
 * - `awaitReady` (RunPanel's stream-ready gate) is awaited before the first
 *   request, so opening a task never queues its own event stream behind one
 *   listing per repository. Absent → no wait (the New Task form has no stream).
 * - At most {@link MULTI_SCOPE_CONCURRENCY} repository listings are in flight.
 * - `maxAgeMs` (a coalesced focus refresh) serves a repository from cache
 *   instead of refetching when {@link scopeListingIsFresh} says so.
 * - `isCurrent` is re-checked after the gate and before each request; once it
 *   reports false (scope switched, newer refresh) nothing further is fetched
 *   and the call resolves `null`.
 *
 * A successful repository listing is written to the shared cache, so a later
 * open of the same repository set seeds instantly
 * (`cachedMultiScopeListing`). A failed one is never cached, and the merge
 * keeps whatever that repository last cached so a transient failure doesn't
 * blank it.
 */
export async function loadMultiScopeListing(
  scopes: readonly NamedFileScope[],
  opts: {
    awaitReady?: (() => Promise<void>) | null;
    isCurrent?: () => boolean;
    maxAgeMs?: number | null;
  } = {},
): Promise<{ files: string[]; truncated: boolean; error: string | null } | null> {
  const isCurrent = opts.isCurrent ?? (() => true);
  if (opts.awaitReady) await opts.awaitReady();
  if (!isCurrent()) return null;
  const maxAgeMs = opts.maxAgeMs ?? null;
  const results = await mapWithConcurrency(scopes, MULTI_SCOPE_CONCURRENCY, async (scope) => {
    const thisScope = { dir: scope.dir, ref: scope.ref };
    const key = cacheKey(thisScope);
    if (!isCurrent()) return { scope, entry: null, error: null };
    const cached = cache.get(key);
    if (maxAgeMs !== null && cached && !inflight.has(key) && scopeListingIsFresh(thisScope, maxAgeMs)) {
      return { scope, entry: cached, error: null };
    }
    const result = await fetchEntry(thisScope);
    if (!result.error) cache.set(key, result.entry);
    return { scope, entry: result.error ? null : result.entry, error: result.error };
  });
  if (!isCurrent()) return null;
  const merged: string[] = [];
  let anyError: string | null = null;
  let anyTruncated = false;
  for (const { scope, entry, error: err } of results) {
    if (err || !entry) {
      if (err) anyError ??= err;
      // Keep whatever this scope last cached so a transient failure doesn't
      // blank a repository that was listing fine a moment ago.
      const cached = cache.get(cacheKey(scope));
      if (cached) merged.push(...cached.files.map((f) => `${scope.name}/${f}`));
      if (cached?.truncated) anyTruncated = true;
      continue;
    }
    merged.push(...entry.files.map((f) => `${scope.name}/${f}`));
    if (entry.truncated) anyTruncated = true;
  }
  return { files: merged, truncated: anyTruncated, error: anyError };
}

/**
 * Loads the union of several repository scopes for a multi-repository task's
 * `@` popover. Each scope keeps its own cache entry (so a single scope still
 * renders instantly from the shared cache); entries are prefixed with
 * `<name>/` so `@frontend/src/a.ts` is unambiguous. `null`/`[]` fetches
 * nothing — a single-repository caller passes its scope to
 * {@link useProjectFiles}. One named scope is still listed here: it is a
 * multi-repository task left with one repository (issue #291), whose agent
 * reads `<name>/…` from the workspace root.
 *
 * `opts.awaitReady` gates the fetches on the caller's event stream (see
 * {@link loadMultiScopeListing}). `refresh({ maxAgeMs })` is the coalesced
 * form the composer's focus handler uses: it refetches only repositories
 * whose listing is older than `maxAgeMs`, and does nothing when none is.
 * `refresh()` with no argument forces every repository, as before.
 */
export function useProjectFileScopes(
  scopes: NamedFileScope[] | null | undefined,
  opts?: { awaitReady?: (() => Promise<void>) | null },
): {
  entries: FileEntry[];
  validPaths: Set<string>;
  truncated: boolean;
  loading: boolean;
  error: string | null;
  refresh: (opts?: { maxAgeMs?: number }) => void;
} {
  const multi = multiScopesOrNull(scopes) !== null;
  const key = multi ? scopes!.map((s) => `${s.name}:${cacheKey(s)}`).join("|") : null;
  // The listing is stamped with the scope key it was fetched/seeded for. A
  // render for a NEW key must never show the previous key's rows — not even
  // for the frame before this hook's effect runs — so unmatched state is
  // replaced at render time by the new scope's cached rows (or nothing).
  const [listing, setListing] = useState<{ key: string | null; files: string[]; truncated: boolean }>({
    key: null,
    files: [],
    truncated: false,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gen, setGen] = useState(0);
  const requestIdRef = useRef(0);
  // The gate is usually a fresh closure every parent render (RunPanel binds
  // its task id into it); read through a ref so it never re-arms the effect.
  const awaitReadyRef = useRef(opts?.awaitReady ?? null);
  awaitReadyRef.current = opts?.awaitReady ?? null;
  // Set by a coalesced `refresh({ maxAgeMs })` for the effect run it
  // triggers; consumed (reset to null) by that run, and honored only when the
  // scope key is still the one the refresh was asked for.
  const pendingMaxAgeRef = useRef<{ key: string; maxAgeMs: number } | null>(null);

  const seeded = !multi || listing.key === key ? null : cachedMultiScopeListing(scopes ?? []);
  const files = !multi ? [] : listing.key === key ? listing.files : seeded?.files ?? [];
  const truncated = !multi ? false : listing.key === key ? listing.truncated : seeded?.truncated ?? false;

  useEffect(() => {
    if (!multi) {
      pendingMaxAgeRef.current = null;
      setListing({ key: null, files: [], truncated: false });
      setLoading(false);
      setError(null);
      return;
    }
    const list = scopes!;
    const requestId = ++requestIdRef.current;
    const pending = pendingMaxAgeRef.current;
    pendingMaxAgeRef.current = null;
    const maxAgeMs = pending && pending.key === key ? pending.maxAgeMs : null;
    if (maxAgeMs === null) {
      // Reset to THIS scope's cached rows — or clear — BEFORE the refetch.
      // The previous task's prefixed entries otherwise stayed on screen until
      // every repository answered, so a RunPanel task switch briefly offered
      // the old task's `@` entries (and a token picked in that window could be
      // sent). All-cached scopes seed instantly (a repeat open of the same
      // project set); a partial cache clears rather than show a misleading
      // subset. A coalesced refresh keeps the rows already on screen.
      const cached = cachedMultiScopeListing(list);
      setListing({ key, files: cached?.files ?? [], truncated: cached?.truncated ?? false });
      setError(null);
    }
    setLoading(true);
    void loadMultiScopeListing(list, {
      awaitReady: awaitReadyRef.current,
      isCurrent: () => requestIdRef.current === requestId,
      maxAgeMs,
    }).then((result) => {
      if (!result || requestIdRef.current !== requestId) return;
      setListing({ key, files: result.files, truncated: result.truncated });
      setError(result.error);
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, gen]);

  const refresh = useCallback((refreshOpts?: { maxAgeMs?: number }) => {
    if (!multi) return;
    const maxAgeMs = refreshOpts?.maxAgeMs;
    if (maxAgeMs !== undefined) {
      const stale = scopes!.filter((scope) => !scopeListingIsFresh(scope, maxAgeMs));
      if (stale.length === 0) return;
      for (const scope of stale) clearSearchCacheForScope({ dir: scope.dir, ref: scope.ref });
      pendingMaxAgeRef.current = { key: key!, maxAgeMs };
    } else {
      for (const scope of scopes!) clearSearchCacheForScope({ dir: scope.dir, ref: scope.ref });
      pendingMaxAgeRef.current = null;
    }
    setGen((g) => g + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key encodes scopes
  }, [multi, key]);

  const entries = useMemo(() => {
    // Each repository's own root is a real directory at the workspace root,
    // but the merged listing only carries its files. Add `<name>/` rows so
    // `@frontend` resolves (send-time expansion already resolves it).
    // `key` changes with the scope list, including its names.
    const names = multi ? (scopes ?? []).map((s) => s.name) : [];
    return addScopeRoots(buildFileEntries(files), names);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key encodes scopes/names
  }, [files, key, multi]);
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
 *
 * `opts.signal` cancels the request; an aborted search resolves `null`
 * ("unknown") without warning — it was superseded, not failed.
 */
export async function searchProjectFiles(
  scope: FileScope,
  q: string,
  limit = 50,
  opts?: { signal?: AbortSignal },
): Promise<FileEntry[] | null> {
  if (!scope || !scope.dir) return [];
  const scopeWarnKey = cacheKey(scope);
  const resultKey = searchCacheKey(scope, q, limit);
  const cached = searchCache.get(resultKey);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) return cached.rows;
  const signal = opts?.signal;
  if (signal?.aborted) return null;
  try {
    const params = { dir: scope.dir, ref: scope.ref, q, limit };
    const { files } = await (signal ? api.listProjectFiles(params, signal) : api.listProjectFiles(params));
    const entries: FileEntry[] = files.map((path) => ({ path, isDirectory: path.endsWith("/") }));
    setSearchCacheEntry(resultKey, entries);
    searchWarnedScopes.delete(scopeWarnKey);
    return entries;
  } catch (e) {
    if (signal?.aborted) return null;
    if (!searchWarnedScopes.has(scopeWarnKey)) {
      searchWarnedScopes.add(scopeWarnKey);
      console.warn("[agetor] searchProjectFiles failed", e);
    }
    return null;
  }
}

// The live `searchProjectFileScopes` call's controller; a newer call aborts it.
let activeScopesSearch: AbortController | null = null;

/**
 * {@link searchProjectFiles} for a multi-repository listing. A query that
 * starts with a known workspace name (`backend/src/ap`) searches only that
 * repository, with the prefix stripped — the prefix is a client-side layout
 * alias, not part of the repository's own file tree. An unprefixed query
 * searches every repository; each result is re-prefixed with its workspace
 * name so remote rows keep the exact shape of the merged client listing.
 *
 * Resolves to `null` when EVERY targeted request failed (the caller must
 * keep "unproven" distinct from "confirmed missing"); a partial failure keeps
 * the answers that did succeed. A named query with nothing after the prefix
 * resolves to `[]` — the client already has every entry under that prefix, so
 * a full-listing search would have nothing to narrow.
 *
 * The per-repository requests run at most {@link MULTI_SCOPE_CONCURRENCY} at
 * a time, and only the latest call is live: this is the popover's
 * per-keystroke search, so starting a new one aborts the previous call's
 * in-flight requests and skips the ones it had not started. A superseded
 * call (or one whose `opts.signal` aborts) resolves `null`, which every
 * caller already reads as "no answer" and drops. Without this, a fast typer
 * on a 16-repository task queued 16 searches per pause behind each other.
 */
export async function searchProjectFileScopes(
  scopes: readonly NamedFileScope[] | null | undefined,
  q: string,
  limit = 50,
  opts?: { signal?: AbortSignal },
): Promise<FileEntry[] | null> {
  activeScopesSearch?.abort();
  activeScopesSearch = null;
  const list = scopes ?? [];
  if (list.length === 0) return [];
  const named = resolveNamedScopePath(list, q);
  const targets = named
    ? [{ scope: named.scope, local: named.path.replace(/\/+$/, "") }]
    : list.map((scope) => ({ scope, local: q }));
  if (targets.length === 0 || targets.some((t) => !t.local)) return [];
  const controller = new AbortController();
  activeScopesSearch = controller;
  const onCallerAbort = () => controller.abort();
  opts?.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (opts?.signal?.aborted) controller.abort();
  let results: Array<{ scope: NamedFileScope; local: string; rows: FileEntry[] | null }>;
  try {
    results = await mapWithConcurrency(targets, MULTI_SCOPE_CONCURRENCY, async (t) => ({
      ...t,
      rows: controller.signal.aborted
        ? null
        : await searchProjectFiles(t.scope, t.local, limit, { signal: controller.signal }),
    }));
  } finally {
    opts?.signal?.removeEventListener("abort", onCallerAbort);
    if (activeScopesSearch === controller) activeScopesSearch = null;
  }
  if (controller.signal.aborted) return null;
  if (results.every((r) => r.rows === null)) return null;
  // Interleave the per-repository rankings instead of concatenating them:
  // concatenation let the first repository's `limit` rows hide every later
  // repository's matches entirely. Round-robin keeps the top of each
  // repository's ranking visible while still honoring the overall cap.
  const successes = results.filter((r) => r.rows !== null) as Array<{ scope: NamedFileScope; rows: FileEntry[] }>;
  const out: FileEntry[] = [];
  for (let i = 0; out.length < limit; i++) {
    let added = false;
    for (const r of successes) {
      const row = r.rows[i];
      if (!row) continue;
      out.push({ path: `${r.scope.name}/${row.path}`, isDirectory: row.isDirectory });
      added = true;
      if (out.length >= limit) break;
    }
    if (!added) break;
  }
  return out;
}

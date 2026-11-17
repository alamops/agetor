// A small module cache of each project's forge identity (host, owner, name),
// read through `GET /github/provider-info`. The Create-all-PRs button gate
// attributes proposals by link on every render of RunPanel, so the identity
// must be a cheap synchronous read after the first fetch, and an unmounted or
// switched panel must not refetch. Entries live 5 minutes (30 s for a failure,
// so a repository that gains a remote isn't stuck as "unknown"); in-flight
// requests are shared. `useSyncExternalStore` consumers subscribe for updates.
//
// Stale-while-revalidate: an expired entry is still *served* by
// `cachedProviderIdentity` (a remote's identity almost never changes, and
// dropping it to `undefined` would make every link-matched proposal head fall
// out of the Create-all-PRs gate until the next fetch lands), while
// `loadProviderIdentity` refetches it. A failed refresh keeps the last good
// identity and retries after the short TTL.
import type { RepoIdentity } from "./pr-link.ts";

const TTL_MS = 5 * 60_000;
const ERROR_TTL_MS = 30_000;

interface Entry {
  /** `null`: the project has no supported forge remote (or the lookup failed). */
  value: RepoIdentity | null;
  expiresAt: number;
}

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<RepoIdentity | null>>();
const listeners = new Set<() => void>();
let version = 0;

type Fetcher = (path: string) => Promise<RepoIdentity | null>;
let fetcher: Fetcher | null = null;

/** Wire the network read (done once, by the api module's consumer). */
export function setProviderInfoFetcher(f: Fetcher | null): void {
  fetcher = f;
}

function notify(): void {
  version += 1;
  for (const l of listeners) l();
}

/** `useSyncExternalStore` subscribe. */
export function subscribeProviderInfo(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `useSyncExternalStore` snapshot: changes whenever any entry changes. */
export function providerInfoVersion(): number {
  return version;
}

/**
 * The cached identity: `undefined` when never loaded, `null` when known to have
 * none. An expired entry is returned as is (stale-while-revalidate) unless it
 * is a failed lookup, which stops counting once its short TTL has passed.
 */
export function cachedProviderIdentity(path: string, now = Date.now()): RepoIdentity | null | undefined {
  const e = entries.get(path);
  if (!e) return undefined;
  if (e.expiresAt <= now && e.value === null) return undefined;
  return e.value;
}

/** Whether a path has no entry, or an entry past its TTL (so a load would refetch). */
export function providerIdentityNeedsRefresh(path: string, now = Date.now()): boolean {
  const e = entries.get(path);
  return !e || e.expiresAt <= now;
}

/**
 * Load a project's identity, deduping in-flight calls. A fresh hit resolves
 * immediately; an expired entry is refetched (readers keep seeing the stale
 * value meanwhile). A failed lookup is cached as `null` for 30 s, or leaves the
 * last good identity in place for 30 s.
 */
export function loadProviderIdentity(path: string): Promise<RepoIdentity | null> {
  if (!providerIdentityNeedsRefresh(path)) return Promise.resolve(entries.get(path)!.value);
  const pending = inflight.get(path);
  if (pending) return pending;
  if (!fetcher) return Promise.resolve(entries.get(path)?.value ?? null);
  const previous = entries.get(path)?.value ?? null;
  const request = fetcher(path)
    .then(
      (value) => ({ value, ttl: TTL_MS }),
      // Keep the last good identity across a failed refresh.
      () => ({ value: previous, ttl: ERROR_TTL_MS }),
    )
    .then(({ value, ttl }) => {
      const before = entries.get(path);
      entries.set(path, { value, expiresAt: Date.now() + ttl });
      inflight.delete(path);
      // Readers only need a re-render when what they would read changed.
      if (!before || !sameIdentity(before.value, value)) notify();
      return value;
    });
  inflight.set(path, request);
  return request;
}

function sameIdentity(a: RepoIdentity | null, b: RepoIdentity | null): boolean {
  if (a === b) return true;
  return a !== null && b !== null && a.host === b.host && a.owner === b.owner && a.name === b.name;
}

/** Test seam: forget every entry and request. */
export function resetProviderInfoCacheForTest(): void {
  entries.clear();
  inflight.clear();
  fetcher = null;
  notify();
}

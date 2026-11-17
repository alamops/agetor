// A small module cache of each project's forge identity (host, owner, name),
// read through `GET /github/provider-info`. The Create-all-PRs button gate
// attributes proposals by link on every render of RunPanel, so the identity
// must be a cheap synchronous read after the first fetch, and an unmounted or
// switched panel must not refetch. Entries live 5 minutes (30 s for a failure,
// so a repository that gains a remote isn't stuck as "unknown"); in-flight
// requests are shared. `useSyncExternalStore` consumers subscribe for updates.
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

/** The cached identity: `undefined` when not loaded (or expired), `null` when known to have none. */
export function cachedProviderIdentity(path: string, now = Date.now()): RepoIdentity | null | undefined {
  const e = entries.get(path);
  if (!e || e.expiresAt <= now) return undefined;
  return e.value;
}

/**
 * Load a project's identity, deduping in-flight calls. A cache hit resolves
 * immediately. A failed lookup is cached as `null` for 30 s.
 */
export function loadProviderIdentity(path: string): Promise<RepoIdentity | null> {
  const hit = cachedProviderIdentity(path);
  if (hit !== undefined) return Promise.resolve(hit);
  const pending = inflight.get(path);
  if (pending) return pending;
  if (!fetcher) return Promise.resolve(null);
  const request = fetcher(path)
    .then(
      (value) => ({ value, ttl: TTL_MS }),
      () => ({ value: null as RepoIdentity | null, ttl: ERROR_TTL_MS }),
    )
    .then(({ value, ttl }) => {
      entries.set(path, { value, expiresAt: Date.now() + ttl });
      inflight.delete(path);
      notify();
      return value;
    });
  inflight.set(path, request);
  return request;
}

/** Test seam: forget every entry and request. */
export function resetProviderInfoCacheForTest(): void {
  entries.clear();
  inflight.clear();
  fetcher = null;
  notify();
}

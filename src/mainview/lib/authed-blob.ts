// Authenticated image loading for the webview (master-token plan, D13/P9).
// An `<img src>` can't send an `Authorization` header and the API no longer
// accepts the master token in a URL, so every image the webview shows from a
// core byte-serving route (`/files/preview`, `/tasks/:id/diff/blob`,
// `/github/pull-blob`) is fetched with the header and shown through a `blob:`
// object URL instead.
//
// Layout:
//   - `createAuthedBlobCache(deps)` is the pure, React-free core: a refcounted
//     cache keyed by URL. Two consumers of the same URL share one fetch and one
//     object URL; the object URL is revoked `REVOKE_GRACE_MS` after its last
//     consumer lets go (a re-mount inside the window — a list re-render, a
//     candidate flip-flop — costs nothing); a fetch nobody wants any more is
//     aborted. Everything environmental (fetch, object URLs, timers) is injected
//     so `bun test` exercises it without a DOM.
//   - `useAuthedObjectUrl(url)` binds one shared cache to React through
//     `useSyncExternalStore`.
//
// The status vocabulary replaces the old `api.probeBlobStatus` re-probe: the
// hook already saw the response, so a 404 is "missing" and a 413 is
// "too-large" without a second request.
import { useCallback, useSyncExternalStore } from "react";
import { authedFetch } from "./api.ts";

export type AuthedBlobStatus = "loading" | "ok" | "missing" | "too-large" | "error";

export interface AuthedBlobState {
  /** `blob:` object URL once `status === "ok"`, otherwise `null`. */
  src: string | null;
  status: AuthedBlobStatus;
}

/** How long an object URL outlives its last consumer. */
export const REVOKE_GRACE_MS = 30_000;

/** Shared by every "nothing to show yet" read; also the identity-stable
 *  snapshot `useSyncExternalStore` needs before a subscription exists. */
export const LOADING_STATE: AuthedBlobState = Object.freeze({ src: null, status: "loading" });

/** Maps a non-2xx status to the pane vocabulary (404 / 413 / everything else). */
export function statusForHttp(status: number): Exclude<AuthedBlobStatus, "loading" | "ok"> {
  if (status === 404) return "missing";
  if (status === 413) return "too-large";
  return "error";
}

export interface AuthedBlobDeps {
  /** GET `url` with the auth header. */
  fetch(url: string, init: { signal: AbortSignal }): Promise<Response>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(objectUrl: string): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Cap on simultaneous fetches (default: unlimited). WKWebView allows ~6
   *  HTTP/1.1 connections per host and two are permanent SSE streams, so the
   *  shared cache keeps image fetches well under that: a long transcript with
   *  many images used to be throttled by `<img loading="lazy">`, and the
   *  queue plays that role now. Queued entries start in subscription order. */
  maxConcurrent?: number;
}

export interface AuthedBlobCache {
  /** Current state for `url`; stable identity until it changes. A URL nobody
   *  has subscribed to reads as `LOADING_STATE`. */
  get(url: string): AuthedBlobState;
  /** Register interest in `url` (starting its fetch when nobody else has).
   *  Returns the unsubscribe function. */
  subscribe(url: string, onChange: () => void): () => void;
  /** Number of URLs currently held (tests / diagnostics). */
  size(): number;
}

interface Entry {
  state: AuthedBlobState;
  listeners: Set<() => void>;
  controller: AbortController | null;
  /** Pending revoke timer while no one is subscribed. */
  revokeTimer: unknown;
  /** Forgotten before (or while) its fetch ran; the queue skips it. */
  dropped: boolean;
}

export function createAuthedBlobCache(deps: AuthedBlobDeps): AuthedBlobCache {
  const entries = new Map<string, Entry>();
  const maxConcurrent = deps.maxConcurrent ?? Number.POSITIVE_INFINITY;
  let running = 0;
  const queue: Array<{ url: string; entry: Entry }> = [];

  const notify = (entry: Entry): void => {
    for (const l of [...entry.listeners]) l();
  };

  const settle = (entry: Entry, state: AuthedBlobState): void => {
    entry.state = state;
    entry.controller = null;
    notify(entry);
  };

  const pump = (): void => {
    while (running < maxConcurrent && queue.length > 0) {
      const next = queue.shift()!;
      if (!next.entry.dropped) run(next.url, next.entry);
    }
  };

  /** Queue the fetch; it starts as soon as a slot is free. */
  const start = (url: string, entry: Entry): void => {
    queue.push({ url, entry });
    pump();
  };

  const run = (url: string, entry: Entry): void => {
    const controller = new AbortController();
    entry.controller = controller;
    running += 1;
    void (async () => {
      try {
        const res = await deps.fetch(url, { signal: controller.signal });
        if (controller.signal.aborted) {
          void res.body?.cancel().catch(() => {});
          return;
        }
        if (!res.ok) {
          void res.body?.cancel().catch(() => {});
          settle(entry, { src: null, status: statusForHttp(res.status) });
          return;
        }
        const blob = await res.blob();
        if (controller.signal.aborted) return;
        settle(entry, { src: deps.createObjectURL(blob), status: "ok" });
      } catch {
        // An abort means the entry was dropped; anything else is a network
        // or body failure.
        if (controller.signal.aborted) return;
        settle(entry, { src: null, status: "error" });
      } finally {
        running -= 1;
        pump();
      }
    })();
  };

  const drop = (url: string, entry: Entry): void => {
    entry.dropped = true;
    if (entries.get(url) === entry) entries.delete(url);
    if (entry.revokeTimer !== null) {
      deps.clearTimeout(entry.revokeTimer);
      entry.revokeTimer = null;
    }
    if (entry.state.src !== null) deps.revokeObjectURL(entry.state.src);
  };

  return {
    get(url) {
      return entries.get(url)?.state ?? LOADING_STATE;
    },
    subscribe(url, onChange) {
      let entry = entries.get(url);
      if (!entry) {
        entry = { state: LOADING_STATE, listeners: new Set(), controller: null, revokeTimer: null, dropped: false };
        entries.set(url, entry);
        start(url, entry);
      } else if (entry.revokeTimer !== null) {
        // Came back inside the grace window: keep the same object URL.
        deps.clearTimeout(entry.revokeTimer);
        entry.revokeTimer = null;
      }
      const e = entry;
      e.listeners.add(onChange);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        e.listeners.delete(onChange);
        if (e.listeners.size > 0) return;
        if (e.state.status === "loading") {
          // Nobody wants the bytes any more: abort and forget.
          e.controller?.abort();
          drop(url, e);
        } else if (e.state.status !== "ok") {
          // A failure holds no object URL; forget it so the next consumer
          // retries instead of inheriting a stale error.
          drop(url, e);
        } else {
          e.revokeTimer = deps.setTimeout(() => {
            e.revokeTimer = null;
            if (e.listeners.size === 0) drop(url, e);
          }, REVOKE_GRACE_MS);
        }
      };
    },
    size: () => entries.size,
  };
}

let sharedCache: AuthedBlobCache | null = null;

/** The app-wide cache, created on first use so importing this module in a
 *  non-browser runtime (bun test) touches no browser globals. */
function getSharedCache(): AuthedBlobCache {
  if (!sharedCache) {
    sharedCache = createAuthedBlobCache({
      fetch: (url, init) => authedFetch(url, init),
      createObjectURL: (blob) => URL.createObjectURL(blob),
      revokeObjectURL: (u) => URL.revokeObjectURL(u),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      maxConcurrent: 3,
    });
  }
  return sharedCache;
}

/** Fetch `url` with the auth header and expose it as a `blob:` URL.
 *  `url === null` means "nothing to load" and reads as `loading` with no src. */
export function useAuthedObjectUrl(url: string | null): AuthedBlobState {
  const subscribe = useCallback(
    (onChange: () => void) => (url === null ? () => {} : getSharedCache().subscribe(url, onChange)),
    [url],
  );
  const getSnapshot = useCallback(
    () => (url === null ? LOADING_STATE : getSharedCache().get(url)),
    [url],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => LOADING_STATE);
}

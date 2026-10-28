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
//   - `createViewportRegistry(factory)` + `createLazyGate(deps)` are the equally
//     pure pieces behind `AuthedImg`'s lazy loading: one shared
//     IntersectionObserver per (scroll root, margin), and a small timer state
//     machine that turns "near the viewport" into "should hold a cache
//     subscription" (acquire at once, release after a delay).
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
   *  queue plays that role now. Queued entries start newest-first (LIFO): the
   *  image requested last is the one just scrolled to, so it should not wait
   *  behind a backlog of earlier requests. A queued entry nobody wants any more
   *  is removed from the queue and never fetched. */
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
  /** Waiting in the queue for a free slot. */
  queued: boolean;
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
      // LIFO: the most recently requested entry is the one the user just
      // scrolled to.
      const next = queue.pop()!;
      next.entry.queued = false;
      if (!next.entry.dropped) run(next.url, next.entry);
    }
  };

  const dequeue = (entry: Entry): void => {
    if (!entry.queued) return;
    entry.queued = false;
    const i = queue.findIndex((q) => q.entry === entry);
    if (i >= 0) queue.splice(i, 1);
  };

  /** Queue the fetch; it starts as soon as a slot is free. */
  const start = (url: string, entry: Entry): void => {
    entry.queued = true;
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
    dequeue(entry);
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
        entry = { state: LOADING_STATE, listeners: new Set(), controller: null, revokeTimer: null, dropped: false, queued: false };
        entries.set(url, entry);
        start(url, entry);
      } else if (entry.revokeTimer !== null) {
        // Came back inside the grace window: keep the same object URL.
        deps.clearTimeout(entry.revokeTimer);
        entry.revokeTimer = null;
      } else if (entry.queued) {
        // Wanted again while still waiting: it is the newest request now.
        const i = queue.findIndex((q) => q.entry === entry);
        if (i >= 0) queue.push(queue.splice(i, 1)[0]!);
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

// ---------------------------------------------------------------------------
// Lazy loading support (viewport registry + gate)
// ---------------------------------------------------------------------------

/** How far outside the scroll root an image may sit and still be fetched. */
export const LAZY_ROOT_MARGIN = "300px 0px";
/** A loaded image out of view this long releases its cache subscription (the
 *  cache then revokes the blob after `REVOKE_GRACE_MS`). */
export const IDLE_RELEASE_MS = 20_000;
/** An image still loading/queued when it leaves the view is released sooner:
 *  it holds a fetch slot nobody is looking at. Short enough that a fast scroll
 *  past an image does not abort and restart it. */
export const LOADING_RELEASE_MS = 1_000;

type Target = object;

export interface ViewportObserverLike {
  observe(target: Target): void;
  unobserve(target: Target): void;
  disconnect(): void;
}

export type ViewportObserverFactory = (
  onEntries: (entries: ReadonlyArray<{ target: Target; isIntersecting: boolean }>) => void,
  options: { root: Target | null; rootMargin: string },
) => ViewportObserverLike;

export interface ViewportRegistry {
  /** Report `onChange(true|false)` whenever `target` enters/leaves the root
   *  (expanded by `rootMargin`); the first report follows `observe`. Targets
   *  sharing a (root, margin) share ONE observer, disconnected when its last
   *  target leaves. Returns the unobserve function. */
  observe(
    target: Target,
    options: { root: Target | null; rootMargin: string },
    onChange: (near: boolean) => void,
  ): () => void;
  /** Number of live observers (tests / diagnostics). */
  observerCount(): number;
}

export function createViewportRegistry(factory: ViewportObserverFactory): ViewportRegistry {
  interface Group {
    observer: ViewportObserverLike;
    listeners: Map<Target, Set<(near: boolean) => void>>;
  }
  // root -> margin -> group. `null` (the viewport) is a valid Map key.
  const groups = new Map<Target | null, Map<string, Group>>();

  return {
    observe(target, { root, rootMargin }, onChange) {
      let byMargin = groups.get(root);
      if (!byMargin) {
        byMargin = new Map();
        groups.set(root, byMargin);
      }
      let group = byMargin.get(rootMargin);
      if (!group) {
        const created: Group = {
          listeners: new Map(),
          observer: factory(
            (entries) => {
              for (const entry of entries) {
                const set = created.listeners.get(entry.target);
                if (set) for (const l of [...set]) l(entry.isIntersecting);
              }
            },
            { root, rootMargin },
          ),
        };
        group = created;
        byMargin.set(rootMargin, group);
      }
      const g = group;
      let set = g.listeners.get(target);
      const first = !set;
      if (!set) {
        set = new Set();
        g.listeners.set(target, set);
      }
      set.add(onChange);
      // A second listener on an already-observed target gets no initial
      // callback from the browser; one observe() per target is enough.
      if (first) g.observer.observe(target);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        set!.delete(onChange);
        if (set!.size > 0) return;
        g.listeners.delete(target);
        g.observer.unobserve(target);
        if (g.listeners.size > 0) return;
        g.observer.disconnect();
        const m = groups.get(root);
        if (m?.get(rootMargin) === g) {
          m.delete(rootMargin);
          if (m.size === 0) groups.delete(root);
        }
      };
    },
    observerCount() {
      let n = 0;
      for (const m of groups.values()) n += m.size;
      return n;
    },
  };
}

export interface LazyGateDeps {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Fired when `active` flips (never with the same value twice). */
  onActiveChange(active: boolean): void;
  idleReleaseMs?: number;
  loadingReleaseMs?: number;
}

export interface LazyGate {
  readonly active: boolean;
  /** Near the viewport: activate immediately. Out of view: deactivate after
   *  the release delay (shorter while the image is still loading). */
  setNear(near: boolean): void;
  /** Whether the guarded image is still loading; shortens a pending release. */
  setLoading(loading: boolean): void;
  dispose(): void;
}

export function createLazyGate(deps: LazyGateDeps): LazyGate {
  const idleMs = deps.idleReleaseMs ?? IDLE_RELEASE_MS;
  const loadingMs = deps.loadingReleaseMs ?? LOADING_RELEASE_MS;
  let active = false;
  let near = false;
  let loading = true;
  let timer: unknown = null;
  let disposed = false;

  const cancel = (): void => {
    if (timer !== null) {
      deps.clearTimeout(timer);
      timer = null;
    }
  };
  const schedule = (): void => {
    cancel();
    timer = deps.setTimeout(() => {
      timer = null;
      if (disposed || near || !active) return;
      active = false;
      deps.onActiveChange(false);
    }, loading ? loadingMs : idleMs);
  };

  return {
    get active() {
      return active;
    },
    setNear(value) {
      if (disposed) return;
      near = value;
      if (near) {
        cancel();
        if (!active) {
          active = true;
          deps.onActiveChange(true);
        }
      } else if (active) {
        schedule();
      }
    },
    setLoading(value) {
      if (disposed || loading === value) return;
      loading = value;
      // A release already counting down restarts with the delay that now fits.
      if (timer !== null) schedule();
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
}

/** The size an image last showed at, recorded when the lazy gate releases it. */
export interface HeldBox {
  url: string;
  width: number;
  height: number;
}

/**
 * The box an `AuthedImg` that is not showing its image should keep, or `null`
 * for its placeholder. The last measured size holds while the image is
 * deferred (released off-screen) AND while it is re-fetching on return — the
 * blob is revoked after the grace period, so coming back means a fresh
 * `loading` — so neither step collapses the box and shifts the transcript. A
 * settled failure (the file is gone) shows the placeholder, and a box measured
 * for another `url` (a candidate walk moved on) is never reused.
 */
export function heldBoxFor(
  held: HeldBox | null,
  url: string,
  active: boolean,
  status: AuthedBlobStatus,
): HeldBox | null {
  if (!held || held.url !== url) return null;
  return !active || status === "loading" ? held : null;
}

/**
 * The box to keep remembering once `url`'s status changes. A settled failure
 * while active means the image is gone, so the box measured for it no longer
 * applies: forgetting it keeps a later release off-screen on the placeholder
 * the failure already shows, instead of flipping back to the old box. Returns
 * `held` itself (same reference, so React skips the update) otherwise.
 */
export function heldBoxAfterStatus(
  held: HeldBox | null,
  url: string,
  active: boolean,
  status: AuthedBlobStatus,
): HeldBox | null {
  if (!held || held.url !== url || !active || status === "loading" || status === "ok") return held;
  return null;
}

/** Nearest ancestor that scrolls vertically, or `null` for the viewport.
 *  IntersectionObserver clips a target by every ancestor scroller, but
 *  `rootMargin` only grows the ROOT, so lookahead inside a scroll container
 *  (the run panel transcript) needs that container as the root. */
export function findScrollRoot(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return p;
  }
  return null;
}

let sharedViewport: ViewportRegistry | null = null;

/** The app-wide registry, or `null` where IntersectionObserver is missing
 *  (then callers load immediately). */
export function getSharedViewportRegistry(): ViewportRegistry | null {
  if (typeof IntersectionObserver === "undefined") return null;
  if (!sharedViewport) {
    sharedViewport = createViewportRegistry((onEntries, { root, rootMargin }) =>
      new IntersectionObserver((entries) => onEntries(entries), { root: root as Element | null, rootMargin }),
    );
  }
  return sharedViewport;
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

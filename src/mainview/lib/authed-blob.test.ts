// The pure cache behind `useAuthedObjectUrl` (master-token plan, TT6): shared
// fetches, refcounting, the 30 s revoke grace, and the status mapping. Timers,
// fetch and object URLs are injected, so no DOM is needed.
import { describe, expect, test } from "bun:test";
import {
  createAuthedBlobCache,
  createLazyGate,
  createViewportRegistry,
  heldBoxAfterStatus,
  heldBoxFor,
  IDLE_RELEASE_MS,
  LOADING_RELEASE_MS,
  LOADING_STATE,
  REVOKE_GRACE_MS,
  statusForHttp,
  type AuthedBlobDeps,
} from "./authed-blob.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function settle(times = 4) { for (let i = 0; i < times; i++) await tick(); }

function setup(
  respond: (url: string, signal: AbortSignal) => Response | Promise<Response> = () => new Response(new Blob(["png"])),
  maxConcurrent?: number,
) {
  const fetched: string[] = [];
  const signals = new Map<string, AbortSignal>();
  const created: string[] = [];
  const revoked: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  let n = 0;
  const deps: AuthedBlobDeps = {
    fetch: async (url, init) => {
      fetched.push(url);
      signals.set(url, init.signal);
      return respond(url, init.signal);
    },
    createObjectURL: () => { const u = `blob:test/${++n}`; created.push(u); return u; },
    revokeObjectURL: (u) => { revoked.push(u); },
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: (h) => { (h as { cleared: boolean }).cleared = true; },
    maxConcurrent,
  };
  const live = () => timers.filter((t) => !t.cleared);
  return { cache: createAuthedBlobCache(deps), fetched, signals, created, revoked, timers, live };
}

describe("status mapping", () => {
  test("404 missing, 413 too-large, everything else error", () => {
    expect(statusForHttp(404)).toBe("missing");
    expect(statusForHttp(413)).toBe("too-large");
    expect(statusForHttp(400)).toBe("error");
    expect(statusForHttp(401)).toBe("error");
    expect(statusForHttp(500)).toBe("error");
  });

  test.each([
    [404, "missing"],
    [413, "too-large"],
    [500, "error"],
  ] as const)("a %d answer settles as %s with no src", async (status, expected) => {
    const t = setup(() => new Response("x", { status }));
    t.cache.subscribe("u", () => {});
    await settle();
    expect(t.cache.get("u")).toEqual({ src: null, status: expected });
    expect(t.created).toEqual([]);
  });

  test("a network failure settles as error", async () => {
    const t = setup(() => { throw new TypeError("Load failed"); });
    t.cache.subscribe("u", () => {});
    await settle();
    expect(t.cache.get("u")).toEqual({ src: null, status: "error" });
  });

  test("a 2xx settles as ok with a blob: object URL", async () => {
    const t = setup();
    let notified = 0;
    t.cache.subscribe("u", () => { notified++; });
    expect(t.cache.get("u")).toBe(LOADING_STATE);
    await settle();
    expect(t.cache.get("u")).toEqual({ src: "blob:test/1", status: "ok" });
    expect(notified).toBe(1);
  });

  test("an unsubscribed URL reads as the shared loading state", () => {
    expect(setup().cache.get("nobody")).toBe(LOADING_STATE);
  });
});

describe("sharing and refcounting", () => {
  test("two subscribers share one fetch and one object URL", async () => {
    const t = setup();
    let a = 0;
    let b = 0;
    t.cache.subscribe("u", () => { a++; });
    t.cache.subscribe("u", () => { b++; });
    await settle();
    expect(t.fetched).toEqual(["u"]);
    expect(t.created).toHaveLength(1);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(t.cache.get("u")).toBe(t.cache.get("u")); // stable identity
  });

  test("different URLs are fetched separately", async () => {
    const t = setup();
    t.cache.subscribe("a", () => {});
    t.cache.subscribe("b", () => {});
    await settle();
    expect(t.fetched.sort()).toEqual(["a", "b"]);
    expect(t.created).toHaveLength(2);
  });

  test("the object URL survives until the LAST subscriber leaves, then is revoked after the grace", async () => {
    const t = setup();
    const unsubA = t.cache.subscribe("u", () => {});
    const unsubB = t.cache.subscribe("u", () => {});
    await settle();
    unsubA();
    expect(t.live()).toHaveLength(0);
    unsubB();
    expect(t.live()).toHaveLength(1);
    expect(t.live()[0]!.ms).toBe(REVOKE_GRACE_MS);
    expect(t.revoked).toEqual([]);
    t.live()[0]!.fn();
    expect(t.revoked).toEqual(["blob:test/1"]);
    expect(t.cache.size()).toBe(0);
    expect(t.cache.get("u")).toBe(LOADING_STATE);
  });

  test("resubscribing inside the grace window reuses the object URL and cancels the revoke", async () => {
    const t = setup();
    const unsub = t.cache.subscribe("u", () => {});
    await settle();
    unsub();
    expect(t.live()).toHaveLength(1);
    t.cache.subscribe("u", () => {});
    expect(t.live()).toHaveLength(0);
    expect(t.fetched).toEqual(["u"]);
    expect(t.cache.get("u")).toEqual({ src: "blob:test/1", status: "ok" });
    expect(t.revoked).toEqual([]);
  });

  test("subscribing after the revoke fetches afresh", async () => {
    const t = setup();
    const unsub = t.cache.subscribe("u", () => {});
    await settle();
    unsub();
    t.live()[0]!.fn();
    t.cache.subscribe("u", () => {});
    await settle();
    expect(t.fetched).toEqual(["u", "u"]);
    expect(t.cache.get("u").src).toBe("blob:test/2");
  });

  test("unsubscribing twice is harmless", async () => {
    const t = setup();
    const unsubA = t.cache.subscribe("u", () => {});
    t.cache.subscribe("u", () => {});
    await settle();
    unsubA();
    unsubA();
    expect(t.live()).toHaveLength(0);
    expect(t.cache.get("u").status).toBe("ok");
  });

  test("failures are forgotten on last release so the next consumer retries", async () => {
    const t = setup(() => new Response("x", { status: 500 }));
    const unsub = t.cache.subscribe("u", () => {});
    await settle();
    unsub();
    expect(t.cache.size()).toBe(0);
    expect(t.live()).toHaveLength(0);
    t.cache.subscribe("u", () => {});
    await settle();
    expect(t.fetched).toEqual(["u", "u"]);
  });
});

describe("in-flight fetches", () => {
  test("a fetch nobody wants any more is aborted and its late answer never creates an object URL", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const t = setup(async () => { await gate; return new Response(new Blob(["x"])); });
    const unsub = t.cache.subscribe("u", () => {});
    await settle();
    const signal = t.signals.get("u")!;
    expect(signal.aborted).toBe(false);
    unsub();
    expect(signal.aborted).toBe(true);
    expect(t.cache.size()).toBe(0);
    release();
    await settle();
    expect(t.created).toEqual([]);
  });

  test("one subscriber leaving a shared in-flight fetch does not abort it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const t = setup(async () => { await gate; return new Response(new Blob(["x"])); });
    const unsubA = t.cache.subscribe("u", () => {});
    t.cache.subscribe("u", () => {});
    await settle();
    unsubA();
    expect(t.signals.get("u")!.aborted).toBe(false);
    release();
    await settle();
    expect(t.cache.get("u").status).toBe("ok");
  });
});

describe("concurrency cap", () => {
  test("queues fetches past the cap and starts them as slots free", async () => {
    const gates = new Map<string, () => void>();
    const t = setup((url) => new Promise<Response>((resolve) => {
      gates.set(url, () => resolve(new Response(new Blob(["x"]))));
    }), 2);
    for (const u of ["a", "b", "c"]) t.cache.subscribe(u, () => {});
    await settle();
    expect(t.fetched).toEqual(["a", "b"]);
    gates.get("a")!();
    await settle();
    expect(t.fetched).toEqual(["a", "b", "c"]);
  });

  test("a queued entry dropped before it started is never fetched", async () => {
    const gates = new Map<string, () => void>();
    const t = setup((url) => new Promise<Response>((resolve) => {
      gates.set(url, () => resolve(new Response(new Blob(["x"]))));
    }), 1);
    t.cache.subscribe("a", () => {});
    const unsubB = t.cache.subscribe("b", () => {});
    t.cache.subscribe("c", () => {});
    await settle();
    expect(t.fetched).toEqual(["a"]);
    unsubB();
    gates.get("a")!();
    await settle();
    expect(t.fetched).toEqual(["a", "c"]);
  });
});

describe("queue priority and cancellation", () => {
  function gated(max: number) {
    const gates = new Map<string, () => void>();
    const t = setup((url) => new Promise<Response>((resolve) => {
      gates.set(url, () => resolve(new Response(new Blob(["x"]))));
    }), max);
    return { t, gates };
  }

  test("queued fetches start newest-first (LIFO)", async () => {
    const { t, gates } = gated(1);
    for (const u of ["a", "b", "c", "d"]) t.cache.subscribe(u, () => {});
    await settle();
    expect(t.fetched).toEqual(["a"]);
    gates.get("a")!();
    await settle();
    expect(t.fetched).toEqual(["a", "d"]);
    gates.get("d")!();
    await settle();
    expect(t.fetched).toEqual(["a", "d", "c"]);
  });

  test("a queued entry wanted again jumps to the front", async () => {
    const { t, gates } = gated(1);
    t.cache.subscribe("a", () => {});
    t.cache.subscribe("b", () => {});
    t.cache.subscribe("c", () => {});
    t.cache.subscribe("b", () => {}); // second consumer of the queued "b"
    await settle();
    gates.get("a")!();
    await settle();
    expect(t.fetched).toEqual(["a", "b"]);
  });

  test("an entry cancelled while queued leaves the queue and is never fetched", async () => {
    const { t, gates } = gated(1);
    t.cache.subscribe("a", () => {});
    const unsubB = t.cache.subscribe("b", () => {});
    const unsubC = t.cache.subscribe("c", () => {});
    await settle();
    unsubB();
    unsubC();
    gates.get("a")!();
    await settle();
    expect(t.fetched).toEqual(["a"]);
    expect(t.cache.size()).toBe(1);
  });

  test("a cancelled in-flight fetch frees its slot for the next queued entry", async () => {
    const { t, gates } = gated(1);
    const unsubA = t.cache.subscribe("a", () => {});
    t.cache.subscribe("b", () => {});
    await settle();
    unsubA();
    gates.get("a")!(); // late answer of the aborted fetch
    await settle();
    expect(t.fetched).toEqual(["a", "b"]);
    expect(t.created).toEqual([]);
  });
});

describe("release and revoke interplay", () => {
  test("releasing one of two consumers keeps the blob; releasing the last revokes after the grace; re-acquire refetches", async () => {
    const t = setup();
    const unsubA = t.cache.subscribe("u", () => {});
    const unsubB = t.cache.subscribe("u", () => {});
    await settle();
    unsubA();
    expect(t.revoked).toEqual([]);
    unsubB();
    expect(t.live()).toHaveLength(1);
    t.live()[0]!.fn();
    expect(t.revoked).toEqual(["blob:test/1"]);
    t.cache.subscribe("u", () => {});
    await settle();
    expect(t.fetched).toEqual(["u", "u"]);
  });

  test("a consumer that re-acquires within the grace keeps the blob (no refetch)", async () => {
    const t = setup();
    const unsub = t.cache.subscribe("u", () => {});
    await settle();
    unsub();
    const again = t.cache.subscribe("u", () => {});
    expect(t.live()).toHaveLength(0);
    expect(t.cache.get("u").src).toBe("blob:test/1");
    again();
    expect(t.fetched).toEqual(["u"]);
  });
});

describe("viewport registry", () => {
  function fakeFactory() {
    const observers: Array<{
      options: { root: object | null; rootMargin: string };
      targets: Set<object>;
      disconnected: boolean;
      emit: (target: object, isIntersecting: boolean) => void;
    }> = [];
    const factory: Parameters<typeof createViewportRegistry>[0] = (cb, options) => {
      const o = {
        options,
        targets: new Set<object>(),
        disconnected: false,
        emit: (target: object, isIntersecting: boolean) => cb([{ target, isIntersecting }]),
      };
      observers.push(o);
      return {
        observe: (x) => { o.targets.add(x); },
        unobserve: (x) => { o.targets.delete(x); },
        disconnect: () => { o.disconnected = true; },
      };
    };
    return { observers, factory };
  }

  test("targets with the same root and margin share one observer", () => {
    const { observers, factory } = fakeFactory();
    const reg = createViewportRegistry(factory);
    const a = {}; const b = {};
    reg.observe(a, { root: null, rootMargin: "300px" }, () => {});
    reg.observe(b, { root: null, rootMargin: "300px" }, () => {});
    expect(observers).toHaveLength(1);
    expect(reg.observerCount()).toBe(1);
    expect(observers[0]!.targets.size).toBe(2);
  });

  test("a different root or margin gets its own observer", () => {
    const { observers, factory } = fakeFactory();
    const reg = createViewportRegistry(factory);
    const root = {};
    reg.observe({}, { root: null, rootMargin: "300px" }, () => {});
    reg.observe({}, { root, rootMargin: "300px" }, () => {});
    reg.observe({}, { root: null, rootMargin: "100px" }, () => {});
    expect(observers).toHaveLength(3);
  });

  test("entries are routed to the matching target's listeners only", () => {
    const { observers, factory } = fakeFactory();
    const reg = createViewportRegistry(factory);
    const a = {}; const b = {};
    const seenA: boolean[] = []; const seenB: boolean[] = [];
    reg.observe(a, { root: null, rootMargin: "m" }, (n) => seenA.push(n));
    reg.observe(b, { root: null, rootMargin: "m" }, (n) => seenB.push(n));
    observers[0]!.emit(a, true);
    observers[0]!.emit(b, false);
    observers[0]!.emit(a, false);
    expect(seenA).toEqual([true, false]);
    expect(seenB).toEqual([false]);
  });

  test("the observer disconnects with its last target; unobserve is idempotent", () => {
    const { observers, factory } = fakeFactory();
    const reg = createViewportRegistry(factory);
    const a = {}; const b = {};
    const offA = reg.observe(a, { root: null, rootMargin: "m" }, () => {});
    const offB = reg.observe(b, { root: null, rootMargin: "m" }, () => {});
    offA(); offA();
    expect(observers[0]!.disconnected).toBe(false);
    expect(observers[0]!.targets.has(a)).toBe(false);
    offB();
    expect(observers[0]!.disconnected).toBe(true);
    expect(reg.observerCount()).toBe(0);
    // A later observe builds a fresh observer.
    reg.observe(a, { root: null, rootMargin: "m" }, () => {});
    expect(observers).toHaveLength(2);
  });

  test("two listeners on one element share one observe() and survive one leaving", () => {
    const { observers, factory } = fakeFactory();
    const reg = createViewportRegistry(factory);
    const a = {};
    const seen: string[] = [];
    const off1 = reg.observe(a, { root: null, rootMargin: "m" }, (n) => seen.push(`1:${n}`));
    reg.observe(a, { root: null, rootMargin: "m" }, (n) => seen.push(`2:${n}`));
    off1();
    observers[0]!.emit(a, true);
    expect(seen).toEqual(["2:true"]);
    expect(observers[0]!.disconnected).toBe(false);
  });
});

describe("lazy gate", () => {
  function gateSetup() {
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const changes: boolean[] = [];
    const gate = createLazyGate({
      setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
      clearTimeout: (h) => { (h as { cleared: boolean }).cleared = true; },
      onActiveChange: (a) => changes.push(a),
    });
    const live = () => timers.filter((t) => !t.cleared);
    return { gate, changes, timers, live };
  }

  test("starts inactive and activates the moment it is near", () => {
    const g = gateSetup();
    expect(g.gate.active).toBe(false);
    g.gate.setNear(false);
    expect(g.changes).toEqual([]);
    g.gate.setNear(true);
    expect(g.gate.active).toBe(true);
    expect(g.changes).toEqual([true]);
    g.gate.setNear(true);
    expect(g.changes).toEqual([true]);
  });

  test("leaving the view releases after the idle delay; a loaded image waits the long delay", () => {
    const g = gateSetup();
    g.gate.setNear(true);
    g.gate.setLoading(false);
    g.gate.setNear(false);
    expect(g.live()).toHaveLength(1);
    expect(g.live()[0]!.ms).toBe(IDLE_RELEASE_MS);
    expect(g.gate.active).toBe(true);
    g.live()[0]!.fn();
    expect(g.gate.active).toBe(false);
    expect(g.changes).toEqual([true, false]);
  });

  test("a still-loading image is released after the short delay", () => {
    const g = gateSetup();
    g.gate.setNear(true);
    g.gate.setNear(false);
    expect(g.live()[0]!.ms).toBe(LOADING_RELEASE_MS);
  });

  test("coming back before the delay cancels the release", () => {
    const g = gateSetup();
    g.gate.setNear(true);
    g.gate.setNear(false);
    g.gate.setNear(true);
    expect(g.live()).toHaveLength(0);
    expect(g.gate.active).toBe(true);
    expect(g.changes).toEqual([true]);
  });

  test("a pending release restarts with the long delay once loading finishes", () => {
    const g = gateSetup();
    g.gate.setNear(true);
    g.gate.setNear(false);
    g.gate.setLoading(false);
    expect(g.live()).toHaveLength(1);
    expect(g.live()[0]!.ms).toBe(IDLE_RELEASE_MS);
  });

  test("re-activates after a release", () => {
    const g = gateSetup();
    g.gate.setNear(true);
    g.gate.setNear(false);
    g.live()[0]!.fn();
    g.gate.setNear(true);
    expect(g.changes).toEqual([true, false, true]);
  });

  test("dispose cancels a pending release and ignores later input", () => {
    const g = gateSetup();
    g.gate.setNear(true);
    g.gate.setNear(false);
    g.gate.dispose();
    expect(g.live()).toHaveLength(0);
    g.gate.setNear(true);
    expect(g.changes).toEqual([true]);
  });
});

describe("held box after a status change (heldBoxAfterStatus)", () => {
  const box = { url: "/files/preview?path=a.png", width: 320, height: 240 };

  test("a failed re-fetch forgets the box, so a later release shows the placeholder", () => {
    // Regression: the stale box was kept, so once the failed image left the
    // view it flipped from the placeholder back to its old size.
    for (const status of ["missing", "error", "too-large"] as const) {
      const after = heldBoxAfterStatus(box, box.url, true, status);
      expect(after).toBeNull();
      expect(heldBoxFor(after, box.url, false, "loading")).toBeNull();
    }
  });

  test("loading, ok, a released image and another url's box keep it unchanged", () => {
    expect(heldBoxAfterStatus(box, box.url, true, "loading")).toBe(box);
    expect(heldBoxAfterStatus(box, box.url, true, "ok")).toBe(box);
    expect(heldBoxAfterStatus(box, box.url, false, "loading")).toBe(box);
    expect(heldBoxAfterStatus(box, "/files/preview?path=b.png", true, "missing")).toBe(box);
    expect(heldBoxAfterStatus(null, box.url, true, "missing")).toBeNull();
  });
});

describe("held box (heldBoxFor)", () => {
  const box = { url: "/files/preview?path=a.png", width: 320, height: 240 };

  test("holds the measured box while the image is released off-screen", () => {
    expect(heldBoxFor(box, box.url, false, "loading")).toBe(box);
  });

  test("keeps holding it while the image re-fetches on return (blob revoked after the grace)", () => {
    // Regression: the box used to collapse to the placeholder here, so a
    // transcript image shrank and then grew again — the scroll position jumped.
    expect(heldBoxFor(box, box.url, true, "loading")).toBe(box);
  });

  test("a settled failure shows the placeholder, not an empty box", () => {
    expect(heldBoxFor(box, box.url, true, "missing")).toBeNull();
    expect(heldBoxFor(box, box.url, true, "error")).toBeNull();
    expect(heldBoxFor(box, box.url, true, "too-large")).toBeNull();
  });

  test("a box measured for another url is never reused", () => {
    expect(heldBoxFor(box, "/files/preview?path=b.png", false, "loading")).toBeNull();
    expect(heldBoxFor(box, "/files/preview?path=b.png", true, "loading")).toBeNull();
  });

  test("nothing measured yet: the placeholder", () => {
    expect(heldBoxFor(null, box.url, false, "loading")).toBeNull();
  });
});

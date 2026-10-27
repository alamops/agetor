// The pure cache behind `useAuthedObjectUrl` (master-token plan, TT6): shared
// fetches, refcounting, the 30 s revoke grace, and the status mapping. Timers,
// fetch and object URLs are injected, so no DOM is needed.
import { describe, expect, test } from "bun:test";
import {
  createAuthedBlobCache,
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

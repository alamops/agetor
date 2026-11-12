// The multi-repository request pattern of use-project-files.ts (finding M7,
// issue #291): opening a multi-repository task must not put one listing per
// repository ahead of the task's event stream, and per-keystroke searches
// must not pile up. WKWebView allows ~6 HTTP/1.1 connections per host and two
// are permanent SSE channels. The React hook has no unit harness (house
// convention), so these drive its module-level halves — `loadMultiScopeListing`
// and `searchProjectFileScopes` — with `api.listProjectFiles` spied. Every
// test uses UNIQUE dirs because the caches are module-level and `bun test`
// runs every file in one process.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { api } from "./api";
import {
  FOCUS_REFRESH_MIN_AGE_MS,
  MULTI_SCOPE_CONCURRENCY,
  loadMultiScopeListing,
  scopeListingIsFresh,
  searchProjectFileScopes,
} from "./use-project-files";

type ListArgs = Parameters<typeof api.listProjectFiles>;

let spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  setSystemTime();
});

/** A `listProjectFiles` stub whose calls stay pending until released, so the
 *  in-flight count is observable at every step. */
function manualStub() {
  const pending: Array<{ args: ListArgs; resolve: (files: string[]) => void; reject: (e: unknown) => void }> = [];
  let inFlight = 0;
  let peak = 0;
  const spy = spyOn(api, "listProjectFiles").mockImplementation(((...args: ListArgs) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    return new Promise((resolve, reject) => {
      const signal = args[1];
      const settle = () => { inFlight -= 1; };
      signal?.addEventListener("abort", () => {
        settle();
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
      pending.push({
        args,
        resolve: (files) => { settle(); resolve({ files, truncated: false }); },
        reject: (e) => { settle(); reject(e); },
      });
    });
  }) as typeof api.listProjectFiles);
  spies.push(spy);
  return {
    spy,
    pending,
    get inFlight() { return inFlight; },
    get peak() { return peak; },
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function scopes(tag: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({ name: `repo${i}`, dir: `/t/m7-${tag}-${i}` }));
}

describe("loadMultiScopeListing", () => {
  test("never has more than MULTI_SCOPE_CONCURRENCY listings in flight and merges every repository", async () => {
    const stub = manualStub();
    const list = scopes("cap", 6);
    const run = loadMultiScopeListing(list);
    await flush();
    // Before the fix this was a bare Promise.all: all 6 fired at once.
    expect(stub.inFlight).toBe(MULTI_SCOPE_CONCURRENCY);
    while (stub.pending.length > 0) {
      expect(stub.inFlight).toBeLessThanOrEqual(MULTI_SCOPE_CONCURRENCY);
      const next = stub.pending.shift()!;
      next.resolve([`${next.args[0].dir.split("-").pop()}.ts`]);
      await flush();
    }
    const result = await run;
    expect(stub.peak).toBe(MULTI_SCOPE_CONCURRENCY);
    expect(stub.spy).toHaveBeenCalledTimes(6);
    expect(result?.files).toEqual(list.map((s, i) => `${s.name}/${i}.ts`));
    expect(result?.error).toBeNull();
  });

  test("waits for awaitReady before the first request", async () => {
    const stub = manualStub();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const run = loadMultiScopeListing(scopes("gate", 3), { awaitReady: () => gate });
    await flush();
    expect(stub.spy).toHaveBeenCalledTimes(0);
    open();
    await flush();
    expect(stub.spy).toHaveBeenCalledTimes(2);
    while (stub.pending.length > 0) {
      stub.pending.shift()!.resolve([]);
      await flush();
    }
    await run;
    expect(stub.spy).toHaveBeenCalledTimes(3);
  });

  test("a call superseded while waiting on the gate fetches nothing and resolves null", async () => {
    const stub = manualStub();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let current = true;
    const run = loadMultiScopeListing(scopes("superseded", 3), { awaitReady: () => gate, isCurrent: () => current });
    current = false; // the task switched away before its stream came up
    open();
    expect(await run).toBeNull();
    expect(stub.spy).toHaveBeenCalledTimes(0);
  });

  test("a coalesced refresh (maxAgeMs) refetches only repositories listed longer ago than the window", async () => {
    const spy = spyOn(api, "listProjectFiles").mockImplementation((async () => ({ files: ["a.ts"], truncated: false })) as typeof api.listProjectFiles);
    spies.push(spy);
    const list = scopes("coalesce", 3);
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    setSystemTime(new Date(t0));
    await loadMultiScopeListing(list);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(list.every((s) => scopeListingIsFresh(s, FOCUS_REFRESH_MIN_AGE_MS))).toBe(true);

    // A focus right after: every repository is fresh → served from cache.
    setSystemTime(new Date(t0 + FOCUS_REFRESH_MIN_AGE_MS - 1));
    const again = await loadMultiScopeListing(list, { maxAgeMs: FOCUS_REFRESH_MIN_AGE_MS });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(again?.files).toEqual(list.map((s) => `${s.name}/a.ts`));

    // Past the window: refetched. A forced refresh (no maxAgeMs) always is.
    setSystemTime(new Date(t0 + FOCUS_REFRESH_MIN_AGE_MS + 1));
    expect(scopeListingIsFresh(list[0]!, FOCUS_REFRESH_MIN_AGE_MS)).toBe(false);
    await loadMultiScopeListing(list, { maxAgeMs: FOCUS_REFRESH_MIN_AGE_MS });
    expect(spy).toHaveBeenCalledTimes(6);
    await loadMultiScopeListing(list);
    expect(spy).toHaveBeenCalledTimes(9);
  });

  test("a never-listed repository is never fresh, and a failed listing does not make it fresh", async () => {
    const spy = spyOn(api, "listProjectFiles").mockImplementation((async () => { throw new Error("down"); }) as typeof api.listProjectFiles);
    spies.push(spy);
    spies.push(spyOn(console, "warn").mockImplementation(() => {}));
    const list = scopes("fail", 2);
    expect(scopeListingIsFresh(list[0]!, FOCUS_REFRESH_MIN_AGE_MS)).toBe(false);
    const result = await loadMultiScopeListing(list);
    expect(result?.error).toBe("down");
    expect(scopeListingIsFresh(list[0]!, FOCUS_REFRESH_MIN_AGE_MS)).toBe(false);
  });
});

describe("searchProjectFileScopes", () => {
  test("keeps at most MULTI_SCOPE_CONCURRENCY per-repository searches in flight", async () => {
    const stub = manualStub();
    const list = scopes("search-cap", 5);
    const run = searchProjectFileScopes(list, "abc", 20);
    await flush();
    expect(stub.inFlight).toBe(MULTI_SCOPE_CONCURRENCY);
    while (stub.pending.length > 0) {
      expect(stub.inFlight).toBeLessThanOrEqual(MULTI_SCOPE_CONCURRENCY);
      stub.pending.shift()!.resolve(["abc.ts"]);
      await flush();
    }
    const rows = await run;
    expect(stub.peak).toBe(MULTI_SCOPE_CONCURRENCY);
    expect(rows?.map((r) => r.path)).toEqual(list.map((s) => `${s.name}/abc.ts`));
  });

  test("a newer search aborts the superseded one: in-flight requests cancelled, queued ones never sent", async () => {
    const stub = manualStub();
    const warns: unknown[][] = [];
    spies.push(spyOn(console, "warn").mockImplementation((...a: unknown[]) => { warns.push(a); }));
    const list = scopes("supersede", 5);
    const first = searchProjectFileScopes(list, "ab", 20);
    await flush();
    expect(stub.spy).toHaveBeenCalledTimes(2);
    const firstSignals = stub.spy.mock.calls.map((c) => c[1]);

    const second = searchProjectFileScopes(list, "abc", 20);
    await flush();
    // The first call's two in-flight requests were aborted…
    expect(firstSignals.every((s) => s?.aborted)).toBe(true);
    expect(await first).toBeNull();
    // …and its three queued repositories were never requested: only the
    // second search's first two requests follow.
    expect(stub.spy).toHaveBeenCalledTimes(4);
    expect(stub.spy.mock.calls.slice(2).every((c) => c[0].q === "abc")).toBe(true);
    // A superseded search is not a failure: nothing is warned.
    expect(warns.length).toBe(0);

    stub.pending.splice(0, 2); // the aborted ones
    while (stub.pending.length > 0) {
      stub.pending.shift()!.resolve(["abc.ts"]);
      await flush();
    }
    expect((await second)?.length).toBe(5);
    expect(stub.spy).toHaveBeenCalledTimes(7);
  });

  test("a caller's own AbortSignal cancels the search", async () => {
    const stub = manualStub();
    const controller = new AbortController();
    const run = searchProjectFileScopes(scopes("caller-abort", 3), "xyz", 20, { signal: controller.signal });
    await flush();
    controller.abort();
    expect(await run).toBeNull();
    expect(stub.spy).toHaveBeenCalledTimes(2);
  });
});

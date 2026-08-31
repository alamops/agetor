// Unit coverage for the module-level half of use-project-files.ts —
// `searchProjectFiles`' cache semantics and `clearSearchCacheForScope`.
// The React hook itself has no unit harness (house convention: DOM behavior
// is Playwright's job); everything here is plain module logic, seamed by
// spying on `api.listProjectFiles` and driving the TTL with bun's
// `setSystemTime`. Each test uses a UNIQUE `dir` because the caches are
// module-level and `bun test` runs every file in one process.
import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { api } from "./api";
import {
  SEARCH_CACHE_MAX,
  SEARCH_CACHE_TTL_MS,
  clearSearchCacheForScope,
  searchProjectFiles,
} from "./use-project-files";

let spies: Array<{ mockRestore: () => void }> = [];
function stub(impl: (scope: Parameters<typeof api.listProjectFiles>[0]) => Promise<{ files: string[]; truncated: boolean }>) {
  const spy = spyOn(api, "listProjectFiles").mockImplementation(impl as typeof api.listProjectFiles);
  spies.push(spy);
  return spy;
}

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  setSystemTime(); // restore the real clock — bun test shares one process
});

test("maps files to FileEntry (trailing slash = directory) and forwards dir/ref/q/limit", async () => {
  const spy = stub(async () => ({ files: ["src/", "src/app.ts"], truncated: false }));
  const rows = await searchProjectFiles({ dir: "/t/map", ref: "main" }, "sr", 7);
  expect(rows).toEqual([
    { path: "src/", isDirectory: true },
    { path: "src/app.ts", isDirectory: false },
  ]);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0]![0]).toEqual({ dir: "/t/map", ref: "main", q: "sr", limit: 7 });
});

test("caches per dir+ref+q+LIMIT: identical call is served from cache, a different limit is not", async () => {
  const spy = stub(async () => ({ files: ["a.ts"], truncated: false }));
  await searchProjectFiles({ dir: "/t/key" }, "a", 50);
  await searchProjectFiles({ dir: "/t/key" }, "a", 50); // cache hit
  expect(spy).toHaveBeenCalledTimes(1);
  await searchProjectFiles({ dir: "/t/key" }, "a", 20); // limit differs → miss
  await searchProjectFiles({ dir: "/t/key" }, "b", 50); // query differs → miss
  await searchProjectFiles({ dir: "/t/key", ref: "main" }, "a", 50); // ref differs → miss
  expect(spy).toHaveBeenCalledTimes(4);
});

test("a cached answer expires after SEARCH_CACHE_TTL_MS and refetches", async () => {
  const spy = stub(async () => ({ files: ["a.ts"], truncated: false }));
  const t0 = new Date("2026-01-01T00:00:00Z");
  setSystemTime(t0);
  await searchProjectFiles({ dir: "/t/ttl" }, "a");
  setSystemTime(new Date(t0.getTime() + SEARCH_CACHE_TTL_MS - 1));
  await searchProjectFiles({ dir: "/t/ttl" }, "a"); // still fresh
  expect(spy).toHaveBeenCalledTimes(1);
  setSystemTime(new Date(t0.getTime() + SEARCH_CACHE_TTL_MS + 1));
  await searchProjectFiles({ dir: "/t/ttl" }, "a"); // stale → refetch
  expect(spy).toHaveBeenCalledTimes(2);
});

test("a request failure resolves null, is never cached, and warns once per scope until a success re-arms", async () => {
  const warns: unknown[][] = [];
  const warnSpy = spyOn(console, "warn").mockImplementation((...a: unknown[]) => { warns.push(a); });
  spies.push(warnSpy);
  let fail = true;
  const spy = stub(async () => {
    if (fail) throw new Error("boom");
    return { files: ["a.ts"], truncated: false };
  });
  expect(await searchProjectFiles({ dir: "/t/fail" }, "a")).toBeNull();
  expect(await searchProjectFiles({ dir: "/t/fail" }, "a")).toBeNull(); // not served from cache
  expect(spy).toHaveBeenCalledTimes(2);
  expect(warns.length).toBe(1); // once per scope, not per call
  fail = false;
  expect(await searchProjectFiles({ dir: "/t/fail" }, "a")).toEqual([{ path: "a.ts", isDirectory: false }]);
  fail = true;
  clearSearchCacheForScope({ dir: "/t/fail" }); // bypass the fresh cache entry
  expect(await searchProjectFiles({ dir: "/t/fail" }, "a")).toBeNull();
  expect(warns.length).toBe(2); // the success re-armed the warn
});

test("a genuinely empty server answer IS cached (empty ≠ failure)", async () => {
  const spy = stub(async () => ({ files: [], truncated: false }));
  expect(await searchProjectFiles({ dir: "/t/empty" }, "zz")).toEqual([]);
  expect(await searchProjectFiles({ dir: "/t/empty" }, "zz")).toEqual([]);
  expect(spy).toHaveBeenCalledTimes(1);
});

test("a blank scope resolves [] without any request — nothing failed", async () => {
  const spy = stub(async () => ({ files: ["a.ts"], truncated: false }));
  expect(await searchProjectFiles({ dir: "" }, "a")).toEqual([]);
  expect(spy).toHaveBeenCalledTimes(0);
});

test("clearSearchCacheForScope drops every query/limit for THAT scope and no other", async () => {
  const spy = stub(async () => ({ files: ["a.ts"], truncated: false }));
  await searchProjectFiles({ dir: "/t/clear" }, "a", 50);
  await searchProjectFiles({ dir: "/t/clear" }, "b", 20);
  await searchProjectFiles({ dir: "/t/other" }, "a", 50);
  expect(spy).toHaveBeenCalledTimes(3);
  clearSearchCacheForScope({ dir: "/t/clear" });
  await searchProjectFiles({ dir: "/t/clear" }, "a", 50); // refetch
  await searchProjectFiles({ dir: "/t/clear" }, "b", 20); // refetch
  await searchProjectFiles({ dir: "/t/other" }, "a", 50); // untouched → cache hit
  expect(spy).toHaveBeenCalledTimes(5);
});

test("the cache caps at SEARCH_CACHE_MAX, evicting the oldest key", async () => {
  const spy = stub(async () => ({ files: ["a.ts"], truncated: false }));
  await searchProjectFiles({ dir: "/t/evict" }, "first");
  // Fill the cache well past the cap with distinct keys.
  for (let i = 0; i < SEARCH_CACHE_MAX; i++) {
    await searchProjectFiles({ dir: "/t/evict" }, `q${i}`);
  }
  const before = spy.mock.calls.length;
  await searchProjectFiles({ dir: "/t/evict" }, "first"); // evicted → refetch
  expect(spy.mock.calls.length).toBe(before + 1);
});

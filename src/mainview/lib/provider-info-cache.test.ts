import { beforeEach, expect, test } from "bun:test";
import {
  cachedProviderIdentity,
  loadProviderIdentity,
  providerInfoVersion,
  resetProviderInfoCacheForTest,
  setProviderInfoFetcher,
  subscribeProviderInfo,
} from "./provider-info-cache.ts";

const ID = { host: "github.com", owner: "acme", name: "app" };

beforeEach(() => resetProviderInfoCacheForTest());

test("dedupes in-flight calls per path and serves later reads from the cache", async () => {
  let calls = 0;
  setProviderInfoFetcher(async () => {
    calls += 1;
    return ID;
  });
  const [a, b] = await Promise.all([loadProviderIdentity("/p"), loadProviderIdentity("/p")]);
  expect(a).toEqual(ID);
  expect(b).toEqual(ID);
  expect(calls).toBe(1);
  expect(cachedProviderIdentity("/p")).toEqual(ID);
  await loadProviderIdentity("/p");
  expect(calls).toBe(1);
});

test("a different path is a different request", async () => {
  let calls = 0;
  setProviderInfoFetcher(async () => {
    calls += 1;
    return ID;
  });
  await loadProviderIdentity("/a");
  await loadProviderIdentity("/b");
  expect(calls).toBe(2);
});

test("a failure is cached as null, but only for 30 seconds", async () => {
  setProviderInfoFetcher(async () => {
    throw new Error("no remote");
  });
  expect(await loadProviderIdentity("/p")).toBeNull();
  const now = Date.now();
  expect(cachedProviderIdentity("/p", now)).toBeNull();
  expect(cachedProviderIdentity("/p", now + 31_000)).toBeUndefined();
});

test("a success expires after five minutes", async () => {
  setProviderInfoFetcher(async () => ID);
  await loadProviderIdentity("/p");
  const now = Date.now();
  expect(cachedProviderIdentity("/p", now + 4 * 60_000)).toEqual(ID);
  expect(cachedProviderIdentity("/p", now + 6 * 60_000)).toBeUndefined();
});

test("subscribers are notified, and the snapshot version changes", async () => {
  setProviderInfoFetcher(async () => ID);
  let notified = 0;
  const off = subscribeProviderInfo(() => {
    notified += 1;
  });
  const before = providerInfoVersion();
  await loadProviderIdentity("/p");
  expect(notified).toBe(1);
  expect(providerInfoVersion()).toBeGreaterThan(before);
  off();
  await loadProviderIdentity("/q");
  expect(notified).toBe(1);
});

test("without a fetcher the identity is unknown (null) and not cached", async () => {
  expect(await loadProviderIdentity("/p")).toBeNull();
  expect(cachedProviderIdentity("/p")).toBeUndefined();
});

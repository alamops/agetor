import { beforeEach, expect, test } from "bun:test";
import {
  cachedProviderIdentity,
  loadProviderIdentity,
  providerIdentityNeedsRefresh,
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
  expect(providerIdentityNeedsRefresh("/p", now + 31_000)).toBe(true);
});

test("an expired success is still served, and a load refetches it", async () => {
  let calls = 0;
  setProviderInfoFetcher(async () => {
    calls += 1;
    return ID;
  });
  await loadProviderIdentity("/p");
  const later = Date.now() + 6 * 60_000;
  expect(cachedProviderIdentity("/p", later)).toEqual(ID);
  expect(providerIdentityNeedsRefresh("/p", later)).toBe(true);
  expect(providerIdentityNeedsRefresh("/p", later - 2 * 60_000)).toBe(false);
  const realNow = Date.now;
  Date.now = () => later;
  try {
    expect(await loadProviderIdentity("/p")).toEqual(ID);
  } finally {
    Date.now = realNow;
  }
  expect(calls).toBe(2);
});

test("a failed refresh keeps the last good identity", async () => {
  let fail = false;
  setProviderInfoFetcher(async () => {
    if (fail) throw new Error("offline");
    return ID;
  });
  await loadProviderIdentity("/p");
  fail = true;
  const realNow = Date.now;
  Date.now = () => realNow() + 6 * 60_000;
  try {
    expect(await loadProviderIdentity("/p")).toEqual(ID);
    expect(cachedProviderIdentity("/p")).toEqual(ID);
  } finally {
    Date.now = realNow;
  }
});

test("an unchanged refresh does not notify subscribers", async () => {
  setProviderInfoFetcher(async () => ID);
  await loadProviderIdentity("/p");
  let notified = 0;
  const off = subscribeProviderInfo(() => {
    notified += 1;
  });
  const realNow = Date.now;
  Date.now = () => realNow() + 6 * 60_000;
  try {
    await loadProviderIdentity("/p");
  } finally {
    Date.now = realNow;
    off();
  }
  expect(notified).toBe(0);
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

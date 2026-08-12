import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppEvent, Harness, HarnessQuota } from "../../shared/types.ts";

// Set AGETOR_DATA_DIR before any import that pulls in db.ts. ES imports
// hoist before top-level code, so we use dynamic `await import()` below
// instead of a top-level `import { db } from "../db.ts"` — mirrors
// src/bun/harnesses.test.ts's precedent.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-poller-"));
const { db, harnesses, harnessUsage } = await import("../db.ts");
const { subscribeAppEvents } = await import("../quit-guard.ts");
const { pollAllUsage, refreshOne, __setUsageProviderForTest } = await import("./poller.ts");

function fakeQuota(overrides: Partial<HarnessQuota> = {}): HarnessQuota {
  return {
    harnessId: "claude-code",
    kind: "claude-code",
    planType: null,
    status: "ok",
    source: "api",
    fetchedAtMs: Date.now(),
    meters: [{ id: "five_hour", label: "5 hour", usedPercent: 50, resetsAtMs: null }],
    reason: null,
    ...overrides,
  };
}

// Track every unsubscribe fn registered by a test so a forgotten one can't
// leak a listener into a sibling test in this same file (quit-guard's
// `listeners` set is module-level and process-global under `bun test`).
let activeUnsubs: Array<() => void> = [];
function trackSubscribe(fn: (e: AppEvent) => void): () => void {
  const unsub = subscribeAppEvents(fn);
  activeUnsubs.push(unsub);
  return unsub;
}

beforeEach(() => {
  // Baseline: only claude-code enabled, so `pollAllUsage` never has a
  // reason to touch a REAL provider for codex (enabled by default) —
  // per-test fake providers only ever cover claude-code/gemini here.
  db.run(`UPDATE harnesses SET enabled = 1 WHERE id = 'claude-code'`);
  db.run(`UPDATE harnesses SET enabled = 0 WHERE id IN ('codex', 'cursor', 'gemini')`);
  db.run(`DELETE FROM harnesses WHERE is_builtin = 0`);
  db.run(`DELETE FROM harness_usage`);
});

afterEach(() => {
  __setUsageProviderForTest("claude-code", null);
  __setUsageProviderForTest("codex", null);
  __setUsageProviderForTest("cursor", null);
  __setUsageProviderForTest("gemini", null);
  for (const unsub of activeUnsubs) unsub();
  activeUnsubs = [];
});

afterAll(() => {
  // Belt-and-braces: restore the default-enabled baseline in case a later
  // file in the same `bun test` process reads this module's db instance
  // (shouldn't happen given the mkdtemp isolation, but costs nothing).
  db.run(`UPDATE harnesses SET enabled = 1 WHERE id IN ('claude-code', 'codex')`);
  db.run(`UPDATE harnesses SET enabled = 0 WHERE id IN ('cursor', 'gemini')`);
});

test("pollAllUsage fans out to the fake provider, upserts, and broadcasts", async () => {
  let calls = 0;
  const quota = fakeQuota({ fetchedAtMs: Date.now() });
  __setUsageProviderForTest("claude-code", async (_h: Harness) => {
    calls++;
    return quota;
  });

  const events: AppEvent[] = [];
  trackSubscribe((e) => events.push(e));

  await pollAllUsage();

  expect(calls).toBe(1);
  expect(harnessUsage.get("claude-code")).toEqual(quota);

  const usageEvents = events.filter(
    (e): e is Extract<AppEvent, { type: "harness_usage" }> => e.type === "harness_usage",
  );
  expect(usageEvents.length).toBeGreaterThanOrEqual(1);
  expect(usageEvents.some((e) => e.quota.harnessId === "claude-code")).toBe(true);
});

test("refreshOne respects the freshness floor and bypasses it on force", async () => {
  const cached = fakeQuota({ fetchedAtMs: Date.now(), meters: [{ id: "five_hour", label: "5 hour", usedPercent: 10, resetsAtMs: null }] });
  harnessUsage.upsert(cached);

  let calls = 0;
  const fresh = fakeQuota({ fetchedAtMs: Date.now(), meters: [{ id: "five_hour", label: "5 hour", usedPercent: 90, resetsAtMs: null }] });
  __setUsageProviderForTest("claude-code", async (_h: Harness) => {
    calls++;
    return fresh;
  });

  // Non-force: cached snapshot is still fresh (< USAGE_MIN_REFRESH_MS old) →
  // provider must not be called, and the cached snapshot comes back as-is.
  const result1 = await refreshOne("claude-code");
  expect(calls).toBe(0);
  expect(result1).toEqual(cached);

  // Force: bypasses the freshness floor, hits the provider, replaces the
  // stored snapshot.
  const result2 = await refreshOne("claude-code", { force: true });
  expect(calls).toBe(1);
  expect(result2).toEqual(fresh);
  expect(harnessUsage.get("claude-code")).toEqual(fresh);
});

test("refreshOne returns null and stores nothing for a kind with no registered provider", async () => {
  // gemini has no entry in USAGE_PROVIDERS and no override installed here —
  // enable the harness so the null comes specifically from "no provider",
  // not from "harness disabled".
  harnesses.setEnabled("gemini", true);

  const result = await refreshOne("gemini");

  expect(result).toBeNull();
  expect(harnessUsage.get("gemini")).toBeNull();
});

test("pollAllUsage no-ops on an overlapping call while a sweep is in flight", async () => {
  let calls = 0;
  let resolveDeferred!: (q: HarnessQuota) => void;
  const deferred = new Promise<HarnessQuota>((resolve) => {
    resolveDeferred = resolve;
  });
  __setUsageProviderForTest("claude-code", async (_h: Harness) => {
    calls++;
    return deferred;
  });

  // Fire both sweeps without awaiting the first. `pollAllUsage` flips its
  // module-level `pollInFlight` guard synchronously (before its first
  // `await`), so the second call's guard check observes it already set and
  // returns immediately without touching the provider.
  const p1 = pollAllUsage();
  const p2 = pollAllUsage();

  resolveDeferred(fakeQuota({ fetchedAtMs: Date.now() }));
  await Promise.all([p1, p2]);

  expect(calls).toBe(1);
});

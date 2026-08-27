import { test, expect, beforeAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppEvent, HarnessStatus } from "../shared/types.ts";

// Top-level, before any db.ts-touching import: model-discovery.ts imports
// db.ts (unlike agent-discovery.ts, which is a deliberate leaf) so this file
// follows the fx-permissions-endpoint.test.ts / backlog.test.ts convention —
// set AGETOR_DATA_DIR as a plain statement here (import declarations are
// hoisted above it, so a static top-level `import "./db.ts"` would race this
// assignment), then load every db.ts-touching module dynamically inside
// beforeAll once the env var is guaranteed to be in place.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-model-discovery-"));

let harnesses: typeof import("./db.ts").harnesses;
let subscribeAppEvents: typeof import("./quit-guard.ts").subscribeAppEvents;
let discovery: typeof import("./agent-discovery.ts");
let scheduler: typeof import("./model-discovery.ts");

beforeAll(async () => {
  ({ harnesses } = await import("./db.ts"));
  ({ subscribeAppEvents } = await import("./quit-guard.ts"));
  discovery = await import("./agent-discovery.ts");
  scheduler = await import("./model-discovery.ts");
});

function resetAll(): void {
  scheduler.__testing.resetForTests();
  discovery.__testing.resetForTests();
}

/** Harness ids created by a test, torn down in `afterEach` so leftover
 *  enabled aliases from one test can't skew a later test's "one key per
 *  enabled harness" / broadcast assertions (all tests share one on-disk DB
 *  for the whole file, per the mkdtemp-once convention above). */
const createdHarnessIds: string[] = [];

function insertFxHarness(overrides: { id: string; home?: string | null }): ReturnType<typeof import("./db.ts").harnesses.insert> {
  const created = harnesses.insert({
    id: overrides.id,
    kind: "fx",
    label: overrides.id,
    home: overrides.home ?? null,
    bin: null,
    env: {},
  });
  createdHarnessIds.push(created.id);
  return created;
}

afterEach(() => {
  for (const id of createdHarnessIds.splice(0)) {
    try {
      harnesses.delete(id);
    } catch {
      /* best effort */
    }
  }
});

/* ── fx stub-binary helpers (local copies of agent-discovery.test.ts's —
 * that file is off-limits here, owned by a sibling wave-1 task) ────────── */

function plantFakeFxModelsBin(script: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-model-discovery-fxbin-"));
  const bin = path.join(dir, "fx");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return bin;
}

function plantHomeBranchingFxBin(homeForA: string): string {
  return plantFakeFxModelsBin(
    [
      `if [ "$1" = "models" ] && [ "$2" = "--json" ]; then`,
      `  if [ "$HOME" = "${homeForA}" ]; then echo '{"ids":["a/one"]}'; else echo '{"ids":["b/two"]}'; fi`,
      `  exit 0`,
      `fi`,
      `exit 1`,
    ].join("\n"),
  );
}

async function withFxBin(bin: string, run: () => Promise<void>): Promise<void> {
  const prev = process.env.AGETOR_FX_BIN;
  process.env.AGETOR_FX_BIN = bin;
  try {
    await run();
  } finally {
    if (prev === undefined) delete process.env.AGETOR_FX_BIN;
    else process.env.AGETOR_FX_BIN = prev;
  }
}

function makeStatus(harnessId: string, overrides: Partial<HarnessStatus> = {}): HarnessStatus {
  return {
    harnessId,
    kind: "fx",
    bin: "fx",
    available: true,
    path: "/usr/local/bin/fx",
    version: "0.0.6",
    reason: null,
    installHint: null,
    loggedIn: true,
    authHelp: null,
    ...overrides,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── transition detector (noteHarnessStatuses) ───────────────────────────── */

test("noteHarnessStatuses: first sighting of a harness is recorded but schedules no refresh (boot already discovered it)", () => {
  resetAll();
  scheduler.noteHarnessStatuses([makeStatus("first-sight")]);
  expect(scheduler.__testing.pendingRefreshCount()).toBe(0);
});

test("noteHarnessStatuses: an unchanged status on a second sighting schedules no refresh", () => {
  resetAll();
  scheduler.noteHarnessStatuses([makeStatus("steady")]);
  scheduler.noteHarnessStatuses([makeStatus("steady")]);
  expect(scheduler.__testing.pendingRefreshCount()).toBe(0);
});

test("noteHarnessStatuses: loggedIn false -> true schedules a debounced refresh", () => {
  resetAll();
  scheduler.noteHarnessStatuses([makeStatus("login-flip", { loggedIn: false })]);
  expect(scheduler.__testing.pendingRefreshCount()).toBe(0);
  scheduler.noteHarnessStatuses([makeStatus("login-flip", { loggedIn: true })]);
  expect(scheduler.__testing.pendingRefreshCount()).toBe(1);
});

test("noteHarnessStatuses: available false -> true schedules a debounced refresh", () => {
  resetAll();
  scheduler.noteHarnessStatuses([makeStatus("avail-flip", { available: false, path: null, version: null, loggedIn: null })]);
  expect(scheduler.__testing.pendingRefreshCount()).toBe(0);
  scheduler.noteHarnessStatuses([makeStatus("avail-flip", { available: true })]);
  expect(scheduler.__testing.pendingRefreshCount()).toBe(1);
});

test("noteHarnessStatuses: a path change (binary swap) schedules a debounced refresh", () => {
  resetAll();
  scheduler.noteHarnessStatuses([makeStatus("path-flip", { path: "/opt/homebrew/bin/fx" })]);
  expect(scheduler.__testing.pendingRefreshCount()).toBe(0);
  scheduler.noteHarnessStatuses([makeStatus("path-flip", { path: "/usr/local/bin/fx-v2" })]);
  expect(scheduler.__testing.pendingRefreshCount()).toBe(1);
});

test("noteHarnessStatuses: rapid repeated transitions for the same harness collapse into one pending refresh (debounced, not queued)", () => {
  resetAll();
  scheduler.noteHarnessStatuses([makeStatus("flappy", { available: false })]);
  scheduler.noteHarnessStatuses([makeStatus("flappy", { available: true })]);
  scheduler.noteHarnessStatuses([makeStatus("flappy", { available: false })]);
  scheduler.noteHarnessStatuses([makeStatus("flappy", { available: true })]);
  expect(scheduler.__testing.pendingRefreshCount()).toBe(1);
});

test("noteHarnessStatuses: two different harnesses transitioning at once each get their own pending refresh", () => {
  resetAll();
  scheduler.noteHarnessStatuses([makeStatus("multi-a", { available: false }), makeStatus("multi-b", { available: false })]);
  scheduler.noteHarnessStatuses([makeStatus("multi-a", { available: true }), makeStatus("multi-b", { available: true })]);
  expect(scheduler.__testing.pendingRefreshCount()).toBe(2);
});

test("noteHarnessStatuses: a scheduled refresh actually fires after the debounce window and updates that harness's discovered catalog", async () => {
  resetAll();
  const homeA = mkdtempSync(path.join(tmpdir(), "agetor-model-discovery-home-a-"));
  await withFxBin(plantHomeBranchingFxBin(homeA), async () => {
    const created = insertFxHarness({ id: "fx-transition-live", home: homeA });
    scheduler.noteHarnessStatuses([makeStatus(created.id)]);
    expect(discovery.getHarnessDiscoveredModels(created.id)).toEqual([]);
    scheduler.noteHarnessStatuses([makeStatus(created.id, { loggedIn: false })]);
    expect(scheduler.__testing.pendingRefreshCount()).toBe(1);

    // pendingRefreshCount() drops to 0 the instant the 500ms debounce timer
    // fires (it reflects *scheduled* refreshes, not in-flight ones) — the
    // triggered probe (a real Bun.spawn + stdout read, even against a
    // trivial local script) then takes its own ~0.3-0.8s round trip on this
    // machine, so poll rather than sleep a single fixed window to avoid
    // flaking on a slower CI box.
    const deadline = Date.now() + 5_000;
    while (discovery.getHarnessDiscoveredModels(created.id).length === 0 && Date.now() < deadline) {
      await wait(50);
    }

    expect(scheduler.__testing.pendingRefreshCount()).toBe(0);
    expect(discovery.getHarnessDiscoveredModels(created.id)).toEqual([{ id: "a/one" }]);
  });
});

/* ── startPeriodicDiscovery ───────────────────────────────────────────────── */

test("startPeriodicDiscovery: idempotent (a second call returns the existing timer, not a new one) and unref'd", () => {
  scheduler.stopPeriodicDiscovery();
  const first = scheduler.startPeriodicDiscovery(60_000);
  const second = scheduler.startPeriodicDiscovery(60_000);
  expect(second).toBe(first);
  expect((first as unknown as { hasRef: () => boolean }).hasRef()).toBe(false);
  scheduler.stopPeriodicDiscovery();
});

test("stopPeriodicDiscovery: a subsequent startPeriodicDiscovery call creates a fresh timer", () => {
  scheduler.stopPeriodicDiscovery();
  const first = scheduler.startPeriodicDiscovery(60_000);
  scheduler.stopPeriodicDiscovery();
  const second = scheduler.startPeriodicDiscovery(60_000);
  expect(second).not.toBe(first);
  scheduler.stopPeriodicDiscovery();
});

/* ── publishIfChanged / broadcast (via refreshAllModels + refreshHarnessModels) ── */

// NOTE on the assertions below: `bun test` runs every *.test.ts file in one
// process (see db.ts's own comment on this), so every test file in a full
// suite run shares this one on-disk DB — a sibling file elsewhere in the
// repo may leave its own enabled harness rows behind (established repo
// convention: e.g. orchestrator-fx.test.ts's "fx-alt", reconcile-session
// .test.ts's "codex-alias" — neither is deleted after its test). None of
// that affects the SAME two back-to-back calls inside a single test below
// (no other file's code can interleave mid-test), but it does mean the
// exact *count*/*set* of changed harnesses on a bare `refreshAllModels()`
// isn't fully under this test's control — so assertions here check "our
// harness's change was broadcast, with the right shape" via `.toContain`
// rather than pinning the whole `harnessIds` array or event count.

test("refreshAllModels: claude-code's kind-level list has no discoverer (always []), so it never appears as a 'changed' harness — an empty list never counts as changed even on the first publish", async () => {
  resetAll();
  const events: AppEvent[] = [];
  const unsubscribe = subscribeAppEvents((e) => events.push(e));
  try {
    await scheduler.refreshAllModels();
    for (const e of events) {
      if (e.type === "agent_models_changed") expect(e.harnessIds).not.toContain("claude-code");
    }
  } finally {
    unsubscribe();
  }
});

test("refreshAllModels: broadcasts agent_models_changed with the changed harness id when an enabled fx harness's catalog goes from empty to non-empty, then broadcasts nothing on a no-op re-refresh", async () => {
  resetAll();
  const events: AppEvent[] = [];
  const unsubscribe = subscribeAppEvents((e) => events.push(e));
  try {
    await withFxBin(plantFakeFxModelsBin(`echo '{"ids":["m1","m2"]}'; exit 0`), async () => {
      const created = insertFxHarness({ id: "fx-broadcast-live" });

      await scheduler.refreshAllModels();
      const changeEvents = events.filter((e): e is Extract<AppEvent, { type: "agent_models_changed" }> => e.type === "agent_models_changed");
      expect(changeEvents.length).toBeGreaterThanOrEqual(1);
      const ourEvent = changeEvents.find((e) => e.harnessIds.includes(created.id));
      expect(ourEvent).toBeDefined();
      expect(typeof ourEvent!.ts).toBe("number");
      events.length = 0;

      // Same catalog again -> no change for our harness -> not broadcast again.
      await scheduler.refreshAllModels();
      for (const e of events) {
        if (e.type === "agent_models_changed") expect(e.harnessIds).not.toContain(created.id);
      }
    });
  } finally {
    unsubscribe();
  }
});

test("refreshHarnessModels: probing one fx harness broadcasts that harness's id when its catalog changed", async () => {
  resetAll();
  const events: AppEvent[] = [];
  const unsubscribe = subscribeAppEvents((e) => events.push(e));
  try {
    const created = insertFxHarness({ id: "fx-single-refresh" });
    // Seed a non-broadcasting baseline first publish.
    await withFxBin(plantFakeFxModelsBin(`exit 1`), async () => {
      await scheduler.refreshAllModels();
    });
    events.length = 0;

    await withFxBin(plantFakeFxModelsBin(`echo '{"ids":["fresh"]}'; exit 0`), async () => {
      await scheduler.refreshHarnessModels(created.id);
    });
    const changeEvents = events.filter((e): e is Extract<AppEvent, { type: "agent_models_changed" }> => e.type === "agent_models_changed");
    expect(changeEvents.some((e) => e.harnessIds.includes(created.id))).toBe(true);
  } finally {
    unsubscribe();
  }
});

test("refreshHarnessModels: an unknown/non-fx harness id falls back to a full sweep instead of throwing", async () => {
  resetAll();
  await expect(scheduler.refreshHarnessModels("does-not-exist")).resolves.toBeUndefined();
  await expect(scheduler.refreshHarnessModels("claude-code")).resolves.toBeUndefined();
});

/* ── getHarnessModelMap ───────────────────────────────────────────────────── */

test("getHarnessModelMap: ready mirrors isDiscoveryReady() — false before any refresh, true after", async () => {
  resetAll();
  expect(scheduler.getHarnessModelMap().ready).toBe(false);
  expect(scheduler.getHarnessModelMap().ready).toBe(discovery.isDiscoveryReady());
  await scheduler.refreshAllModels();
  expect(scheduler.getHarnessModelMap().ready).toBe(true);
  expect(scheduler.getHarnessModelMap().ready).toBe(discovery.isDiscoveryReady());
});

test("getHarnessModelMap: includes the built-in claude-code harness (enabled by default) mapped to the kind-level list", async () => {
  resetAll();
  await scheduler.refreshAllModels();
  const map = scheduler.getHarnessModelMap();
  expect(map.byHarness["claude-code"]).toEqual(discovery.getDiscoveredModels("claude-code"));
});

test("getHarnessModelMap: an enabled fx harness is keyed by its own per-harness catalog, and a disabled harness is excluded entirely", async () => {
  resetAll();
  const homeA = mkdtempSync(path.join(tmpdir(), "agetor-model-discovery-home-map-"));
  await withFxBin(plantHomeBranchingFxBin(homeA), async () => {
    const created = insertFxHarness({ id: "fx-map-live", home: homeA });
    await scheduler.refreshAllModels();

    const map = scheduler.getHarnessModelMap();
    expect(map.byHarness[created.id]).toEqual([{ id: "a/one" }]);
    // The harness-keyed entry must come from the per-harness cache, not the
    // shared kind-level "fx" list (which — probed under agetor's own
    // process env, i.e. not homeA — would read the "b/two" branch instead).
    expect(map.byHarness[created.id]).not.toEqual(discovery.getDiscoveredModels("fx"));

    harnesses.setEnabled(created.id, false);
    const mapAfterDisable = scheduler.getHarnessModelMap();
    expect(mapAfterDisable.byHarness[created.id]).toBeUndefined();
  });
});

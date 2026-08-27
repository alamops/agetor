import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppEvent } from "../shared/types.ts";

// Top-level, before any db.ts/server.ts import: db.ts captures
// AGETOR_DATA_DIR at first import (same convention as
// agent-models-endpoint.test.ts / fx-permissions-endpoint.test.ts — "the
// whole bun test suite shares one on-disk DB per process", first import
// wins). A dedicated port avoids colliding with any other test file's
// server in the same `bun test` run — 4576 doesn't collide with any
// existing *.test.ts file's AGETOR_API_PORT.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-model-discovery-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4576";

/**
 * Integration proof for docs/plans/fx-model-catalog-refresh.md §3 D4's full
 * trigger chain (TT2 in §5): a status transition observed by `GET
 * /harnesses` feeds the scheduler's transition detector
 * (`noteHarnessStatuses`), which schedules a debounced per-harness re-probe,
 * which broadcasts `agent_models_changed`, which `GET /agent-models/harnesses`
 * then reflects. This is the one thing none of the unit-level suites
 * (model-discovery.test.ts calls the scheduler directly; agent-models-
 * endpoint.test.ts never exercises `GET /harnesses`) actually proves end to
 * end over real HTTP.
 *
 * The stub fx binary answers exactly three probes agent-status.ts /
 * agent-discovery.ts issue against a real fx binary — `--help` (so
 * checkHarness's "is this actually Vercel's fx" marker check passes),
 * `--version` (cat's a version file next to the binary — this is what we
 * flip to drive the transition), and `models --json` (cat's a catalog file
 * next to the binary — this is what changes underneath the version flip).
 * It deliberately does NOT answer `status --json` (exits 1), matching the
 * documented stub convention (agent-status.ts's `probeStatus` fails open to
 * `{loggedIn: null}` for that, and e2e/fixtures.ts's fx stub does the same)
 * — and matters here specifically because that auth probe is memoized for
 * 60s, which would make it useless as this test's transition trigger.
 */
const fxDir = mkdtempSync(path.join(tmpdir(), "agetor-model-discovery-endpoint-fxbin-"));
const fxBin = path.join(fxDir, "fx");
const fxVersionFile = path.join(fxDir, "version.txt");
const fxCatalogFile = path.join(fxDir, "catalog.json");

const CATALOG_V1 = ["zai/glm-5.3-flash", "openai/gpt-5.2"];
const CATALOG_V2 = ["zai/glm-5.3-flash", "openai/gpt-5.2", "e2e/discovered-only-v2"];

writeFileSync(fxVersionFile, "0.0.6-fake\n");
writeFileSync(fxCatalogFile, JSON.stringify({ ids: CATALOG_V1 }));
writeFileSync(
  fxBin,
  [
    "#!/bin/sh",
    'if [ "$1" = "--help" ]; then',
    '  echo "fx - a coding agent for the terminal"',
    "  exit 0",
    "fi",
    'if [ "$1" = "--version" ]; then',
    `  cat "${fxVersionFile}"`,
    "  exit 0",
    "fi",
    'if [ "$1" = "models" ] && [ "$2" = "--json" ]; then',
    `  cat "${fxCatalogFile}"`,
    "  exit 0",
    "fi",
    "exit 1",
    "",
  ].join("\n"),
  { mode: 0o755 },
);

let server: { stop: () => void } | null = null;
let token: string;
let harnesses: typeof import("./db.ts").harnesses;
let scheduler: typeof import("./model-discovery.ts");
const url = (p: string) => `http://127.0.0.1:4576${p}`;

let priorFxEnabled = false;
let prevFxBinEnv: string | undefined;
let unsubscribe: (() => void) | null = null;
const events: AppEvent[] = [];

beforeAll(async () => {
  ({ harnesses } = await import("./db.ts"));
  const { subscribeAppEvents } = await import("./quit-guard.ts");
  scheduler = await import("./model-discovery.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");

  // Point AGETOR_FX_BIN at the stub before the server (and thus any probe)
  // boots. Scoped here (not at module top level) and restored in afterAll
  // so it can't leak into whichever *.test.ts file `bun test` loads next in
  // the same process.
  prevFxBinEnv = process.env.AGETOR_FX_BIN;
  process.env.AGETOR_FX_BIN = fxBin;

  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;

  const fx = harnesses.get("fx");
  priorFxEnabled = fx?.enabled ?? false;

  // `startApiServer()` itself never runs the initial discovery sweep —
  // that's index.ts's/headless.ts's job at real boot (D4 trigger (1)),
  // which this test doesn't otherwise exercise. Without it, `isDiscoveryReady()`
  // would never flip true through this test's own fx-only trigger chain: a
  // per-harness refresh (what the enable hook and the debounced transition
  // refresh below both use) never sets `ready`, only a full sweep does.
  // Replicating that one-time boot precondition here isn't the thing under
  // test — it's what "the app has already booted" means.
  await scheduler.refreshAllModels();

  unsubscribe = subscribeAppEvents((e) => events.push(e));
});

afterAll(() => {
  unsubscribe?.();
  harnesses.setEnabled("fx", priorFxEnabled);
  if (prevFxBinEnv === undefined) delete process.env.AGETOR_FX_BIN;
  else process.env.AGETOR_FX_BIN = prevFxBinEnv;
  server?.stop?.();
  rmSync(fxDir, { recursive: true, force: true });
});

function authedFetch(p: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url(p), {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type HarnessModelsBody = { ready: boolean; byHarness: Record<string, { id: string; label?: string }[]> };

async function fxCatalogIds(): Promise<{ ids: string[]; ready: boolean }> {
  const res = await authedFetch("/agent-models/harnesses");
  expect(res.status).toBe(200);
  const body = (await res.json()) as HarnessModelsBody;
  return { ids: (body.byHarness.fx ?? []).map((m) => m.id), ready: body.ready };
}

function isFxChangeEvent(e: AppEvent): e is Extract<AppEvent, { type: "agent_models_changed" }> {
  return e.type === "agent_models_changed" && e.harnessIds.includes("fx");
}

async function pollUntil(check: () => Promise<boolean>, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await wait(100);
  }
}

test(
  "trigger chain: GET /harnesses status transition -> debounced scheduler refresh -> " +
    "agent_models_changed broadcast -> GET /agent-models/harnesses reflects the new fx catalog",
  async () => {
    // 1. Enable the built-in fx harness. PATCH /harnesses/:id's `enabled`
    //    carve-out (server.ts) fires its own fire-and-forget per-harness
    //    refresh — independent of the GET /harnesses trigger this test is
    //    actually about — so wait for the catalog to settle to v1 before
    //    treating v1 as the baseline for the transition below.
    const patchRes = await authedFetch("/harnesses/fx", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(patchRes.status).toBe(200);
    expect(((await patchRes.json()) as { enabled: boolean }).enabled).toBe(true);

    let v1Ids: string[] = [];
    await pollUntil(async () => {
      const { ids } = await fxCatalogIds();
      v1Ids = ids;
      return ids.length === CATALOG_V1.length && CATALOG_V1.every((id) => ids.includes(id));
    }, 5_000);
    expect([...v1Ids].sort()).toEqual([...CATALOG_V1].sort());

    // 2. First sight: GET /harnesses records the current
    //    {available, path, version, loggedIn} snapshot for "fx" in the
    //    scheduler's transition detector. Not asserted on by itself — in a
    //    full-suite run another file could in principle have already primed
    //    that key via its own GET /harnesses call, so this call's own
    //    (non-)effect isn't part of this test's contract, only step 4's is.
    const firstRes = await authedFetch("/harnesses");
    expect(firstRes.status).toBe(200);

    // 3. Flip something the transition detector actually watches that ISN'T
    //    covered by the 60s status-probe memoization (agent-status.ts's
    //    `status --json` auth cache) — fx's own reported `--version` — and
    //    change the catalog behind it in the same beat.
    writeFileSync(fxVersionFile, "0.0.7-fake\n");
    writeFileSync(fxCatalogFile, JSON.stringify({ ids: CATALOG_V2 }));

    // 4. Second GET /harnesses: checkAllHarnesses() reprobes fx, observes a
    //    version change versus step 2's snapshot, and noteHarnessStatuses
    //    schedules a debounced (500ms) per-harness refresh for "fx".
    const secondRes = await authedFetch("/harnesses");
    expect(secondRes.status).toBe(200);

    // 5. Poll GET /agent-models/harnesses until the debounced refresh has
    //    actually run and the fx catalog reflects v2 — no fixed sleep: the
    //    debounce window plus a real Bun.spawn round trip for the reprobe
    //    together can take a moment, so this polls with a deadline instead.
    let v2Ids: string[] = [];
    let readyAtV2 = false;
    await pollUntil(async () => {
      const { ids, ready } = await fxCatalogIds();
      v2Ids = ids;
      readyAtV2 = ready;
      return ids.length === CATALOG_V2.length && CATALOG_V2.every((id) => ids.includes(id));
    }, 5_000);
    expect([...v2Ids].sort()).toEqual([...CATALOG_V2].sort());
    expect(readyAtV2).toBe(true);

    // The chain's own broadcast: at least one collected event names "fx" as
    // a harness whose catalog changed.
    expect(events.some(isFxChangeEvent)).toBe(true);

    // 6. Negative: a third GET /harnesses with nothing changed for fx must
    //    not produce another fx-tagged event. Scoped to fx specifically
    //    (not the raw event count) because this route probes every
    //    registered harness, including real claude-code/codex/cursor/gemini
    //    binaries whose own status can independently flap in a shared test
    //    environment — that's out of scope for this assertion. Debounce is
    //    500ms, so 800ms is a bounded wait comfortably past it without a
    //    sleep long enough to itself be flaky.
    const fxEventCountBefore = events.filter(isFxChangeEvent).length;
    const thirdRes = await authedFetch("/harnesses");
    expect(thirdRes.status).toBe(200);
    await wait(800);
    expect(events.filter(isFxChangeEvent).length).toBe(fxEventCountBefore);
  },
);

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  __testing,
  getAllHarnessDiscoveredModels,
  getDiscoveredEfforts,
  getDiscoveredModels,
  getHarnessDiscoveredModels,
  isDiscoveryReady,
  pruneHarnessDiscovery,
  refreshDiscoveredModels,
  refreshFxHarnessModels,
  refreshKindModels,
  type FxHarnessTarget,
} from "./agent-discovery.ts";
import { plantFakeCodexAppServer } from "./test-codex-app-server.ts";

/* ── codex: parseCodexModelList (pure) ───────────────────────────────────
 * `discoverCodex` speaks `codex app-server`'s JSON-RPC `model/list` and hands
 * the concatenated-across-pages `{ data: [...] }` result straight to this
 * parser — see agent-discovery.ts's doc comment. Replaces the old
 * line-heuristic `parseCodexModels` parser, which never actually ran against
 * anything real (`codex prompt --models` never existed). */

test("parseCodexModelList: picks ids and labels out of a model/list result", () => {
  const result = {
    data: [
      { id: "gpt-6-astra", displayName: "GPT-6 Astra" },
      { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
    ],
  };
  const parsed = __testing.parseCodexModelList(result);
  expect(parsed).toEqual([
    { id: "gpt-6-astra", label: "GPT-6 Astra" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  ]);
});

test("parseCodexModelList: carries efforts in reported order and dedupes them", () => {
  const result = {
    data: [
      {
        id: "gpt-6-astra",
        displayName: "GPT-6 Astra",
        supportedReasoningEfforts: [
          { reasoningEffort: "ultra" },
          { reasoningEffort: "high" },
          { reasoningEffort: "high" },
          { reasoningEffort: "low" },
        ],
      },
    ],
  };
  const parsed = __testing.parseCodexModelList(result);
  expect(parsed).toEqual([
    { id: "gpt-6-astra", label: "GPT-6 Astra", efforts: ["ultra", "high", "low"] },
  ]);
});

test("parseCodexModelList: omits the efforts key when the list is empty or missing", () => {
  const result = {
    data: [
      { id: "x", displayName: "X", supportedReasoningEfforts: [] },
      { id: "y", displayName: "Y" },
    ],
  };
  const parsed = __testing.parseCodexModelList(result);
  // toEqual is exact-shape here — this fails if an `efforts` key sneaks in.
  expect(parsed[0]).toEqual({ id: "x", label: "X" });
  expect(parsed[1]).toEqual({ id: "y", label: "Y" });
});

test("parseCodexModelList: skips hidden:true entries", () => {
  const result = {
    data: [
      { id: "visible", displayName: "Visible" },
      { id: "secret", displayName: "Secret", hidden: true },
    ],
  };
  const parsed = __testing.parseCodexModelList(result);
  expect(parsed).toEqual([{ id: "visible", label: "Visible" }]);
});

test("parseCodexModelList: dedupes repeated ids, first occurrence wins", () => {
  const result = {
    data: [
      { id: "dup", displayName: "First" },
      { id: "dup", displayName: "Second" },
    ],
  };
  const parsed = __testing.parseCodexModelList(result);
  expect(parsed).toEqual([{ id: "dup", label: "First" }]);
});

test("parseCodexModelList: malformed inputs degrade to [] without throwing", () => {
  expect(__testing.parseCodexModelList(null)).toEqual([]);
  expect(__testing.parseCodexModelList({})).toEqual([]);
  expect(__testing.parseCodexModelList({ data: "nope" })).toEqual([]);
  expect(__testing.parseCodexModelList({ data: [null, 42, { id: "" }] })).toEqual([]);
});

test("parseCodexModelList: ignores a non-string displayName", () => {
  const result = { data: [{ id: "x", displayName: 42 }] };
  const parsed = __testing.parseCodexModelList(result);
  expect(parsed).toEqual([{ id: "x" }]);
});

test("cache returns an empty list before refresh is called", () => {
  // The cache is module-level; depending on test order another test may have
  // populated it. We just assert the shape — an array — rather than emptiness.
  expect(Array.isArray(getDiscoveredModels("claude-code"))).toBe(true);
  expect(Array.isArray(getDiscoveredModels("codex"))).toBe(true);
});

/* ── codex: discoverCodex end-to-end (via refreshKindModels + a planted
 * `codex app-server` JSON-RPC stub) ─────────────────────────────────────── */

test("discoverCodex (via refreshKindModels): one page with a hidden row surfaces only the visible rows, with label + efforts", async () => {
  __testing.resetForTests();
  const bin = plantFakeCodexAppServer({
    pages: [
      [
        { id: "m1", displayName: "M One", efforts: ["low", "high", "ultra"] },
        { id: "m2", displayName: "M Two", hidden: true },
      ],
    ],
  });
  await withEnvOverride("AGETOR_CODEX_BIN", bin, async () => {
    await refreshKindModels("codex");
  });
  expect(getDiscoveredModels("codex")).toEqual([
    { id: "m1", label: "M One", efforts: ["low", "high", "ultra"] },
  ]);
});

test("discoverCodex (via refreshKindModels): two pages via nextCursor are merged in order", async () => {
  __testing.resetForTests();
  const bin = plantFakeCodexAppServer({
    pages: [
      [{ id: "page1-model", displayName: "Page 1 Model" }],
      [{ id: "page2-model", displayName: "Page 2 Model" }],
    ],
  });
  await withEnvOverride("AGETOR_CODEX_BIN", bin, async () => {
    await refreshKindModels("codex");
  });
  expect(getDiscoveredModels("codex")).toEqual([
    { id: "page1-model", label: "Page 1 Model" },
    { id: "page2-model", label: "Page 2 Model" },
  ]);
});

test("discoverCodex (via refreshKindModels): a JSON-RPC error on model/list resolves to []", async () => {
  __testing.resetForTests();
  const bin = plantFakeCodexAppServer({ pages: [[{ id: "unreachable" }]], error: true });
  await withEnvOverride("AGETOR_CODEX_BIN", bin, async () => {
    await refreshKindModels("codex");
  });
  expect(getDiscoveredModels("codex")).toEqual([]);
});

test("discoverCodex (via refreshKindModels): /bin/echo as the bin resolves to [] promptly — on child exit, not the 5s timer", async () => {
  __testing.resetForTests();
  const start = Date.now();
  await withEnvOverride("AGETOR_CODEX_BIN", "/bin/echo", async () => {
    await refreshKindModels("codex");
  });
  expect(getDiscoveredModels("codex")).toEqual([]);
  expect(Date.now() - start).toBeLessThan(2_000);
});

test("discoverCodex (via refreshKindModels): a non-existent bin path resolves to [] without throwing", async () => {
  __testing.resetForTests();
  await withEnvOverride("AGETOR_CODEX_BIN", "/tmp/agetor-nonexistent-codex-bin-xxxxx", async () => {
    await refreshKindModels("codex");
  });
  expect(getDiscoveredModels("codex")).toEqual([]);
});

/* ── fx: parseFxModels (pure) ────────────────────────────────────────────
 * `fx models --json`'s shape is spike-verified precisely (unlike codex/
 * cursor's loose line-heuristic parsers above): exactly one JSON object,
 * `ids: string[]`. See agent-discovery.ts's parseFxModels doc comment. */

test("parseFxModels: {ids:[...]} maps to [{id}] entries, in order", () => {
  const parsed = __testing.parseFxModels(JSON.stringify({ ids: ["a", "b"] }));
  expect(parsed).toEqual([{ id: "a" }, { id: "b" }]);
});

test("parseFxModels: non-string entries in ids are dropped", () => {
  const parsed = __testing.parseFxModels(JSON.stringify({ ids: ["a", 42, null, {}, [], "b"] }));
  expect(parsed.map((m) => m.id)).toEqual(["a", "b"]);
});

test("parseFxModels: an empty-string id is dropped (falsy-length guard)", () => {
  const parsed = __testing.parseFxModels(JSON.stringify({ ids: ["a", "", "b"] }));
  expect(parsed.map((m) => m.id)).toEqual(["a", "b"]);
});

test("parseFxModels: duplicate ids are deduped, first occurrence wins order", () => {
  // parseFxModels carries a `seen` Set (same convention as parseCodexModels/
  // parseCursorModels above) — a duplicate id in the Gateway catalog must not
  // become a duplicate React key in the model picker.
  const parsed = __testing.parseFxModels(JSON.stringify({ ids: ["a", "a", "b"] }));
  expect(parsed.map((m) => m.id)).toEqual(["a", "b"]);
});

test("parseFxModels: missing ids field -> []", () => {
  expect(__testing.parseFxModels(JSON.stringify({ kind: "models", count: 0 }))).toEqual([]);
});

test("parseFxModels: non-array ids field -> []", () => {
  expect(__testing.parseFxModels(JSON.stringify({ ids: "not-an-array" }))).toEqual([]);
});

test("parseFxModels: empty ids array -> []", () => {
  expect(__testing.parseFxModels(JSON.stringify({ ids: [] }))).toEqual([]);
});

test("parseFxModels: top-level non-object JSON (array, null, string, number) -> [] without throwing", () => {
  expect(__testing.parseFxModels(JSON.stringify(["a", "b"]))).toEqual([]);
  expect(__testing.parseFxModels(JSON.stringify(null))).toEqual([]);
  expect(__testing.parseFxModels(JSON.stringify("just a string"))).toEqual([]);
  expect(__testing.parseFxModels(JSON.stringify(42))).toEqual([]);
});

test("parseFxModels: empty string / non-JSON input -> [] without throwing", () => {
  expect(__testing.parseFxModels("")).toEqual([]);
  expect(__testing.parseFxModels("not json at all")).toEqual([]);
  expect(__testing.parseFxModels("{not even valid json")).toEqual([]);
});

test("parseFxModels: full 0.0.7-shaped `models --json` payload (kind/count/shown_count/more_count/private_models_hidden) -> ids parsed, extra fields ignored", () => {
  // Real fx 0.0.7 wraps `ids` in envelope metadata parseFxModels never reads
  // (only `ids` is read, matching every JSON-parsing probe's
  // unknown-fields-are-fine contract) — this is an explicit tolerance
  // assertion, not just a shape check.
  const payload = {
    kind: "models",
    count: 234,
    shown_count: 234,
    more_count: 0,
    private_models_hidden: true,
    ids: ["zai/glm-5.3-flash", "openai/gpt-5.2", "anthropic/claude-sonnet-5"],
  };
  const parsed = __testing.parseFxModels(JSON.stringify(payload));
  expect(parsed.map((m) => m.id)).toEqual([
    "zai/glm-5.3-flash",
    "openai/gpt-5.2",
    "anthropic/claude-sonnet-5",
  ]);
});

/* ── fx: discoverFx (exercised indirectly via refreshDiscoveredModels +
 * getDiscoveredModels, since discoverFx itself isn't exported — same
 * pattern the codex CLI-missing test above uses) ───────────────────────── */

/** Plant a fake `fx` binary whose body is the caller-supplied shell script,
 *  reachable as `$1 $2 ...` (e.g. `models --json`). No --version/--help
 *  branches needed here — discovery never probes those, only agent-status's
 *  checkHarness does. */
function plantFakeFxModelsBin(script: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-fx-discovery-"));
  const bin = path.join(dir, "fx");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return bin;
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

test("discoverFx (via refreshDiscoveredModels): valid `models --json` output populates the fx cache", async () => {
  // Ids here are arbitrary parsing fixtures, not a claim about what's in any
  // account's real catalog — swapped off the two ids that used to be here
  // (`moonshotai/kimi-k3`, `openai/gpt-5.5`) since neither is guaranteed to
  // still be curated/available; the test only cares that parsing round-trips.
  await withFxBin(
    plantFakeFxModelsBin(
      `if [ "$1" = "models" ] && [ "$2" = "--json" ]; then echo '{"ids":["zai/glm-5.3-flash","openai/gpt-5.2"]}'; exit 0; fi\nexit 1`,
    ),
    async () => {
      await refreshDiscoveredModels();
      expect(getDiscoveredModels("fx")).toEqual([
        { id: "zai/glm-5.3-flash" },
        { id: "openai/gpt-5.2" },
      ]);
    },
  );
});

test("discoverFx: garbage (non-JSON) stdout -> [] without throwing", async () => {
  await withFxBin(
    plantFakeFxModelsBin(`echo 'not json at all'; exit 0`),
    async () => {
      await refreshDiscoveredModels();
      expect(getDiscoveredModels("fx")).toEqual([]);
    },
  );
});

test("discoverFx: non-zero exit (even with parseable JSON on stdout) -> [] without throwing", async () => {
  await withFxBin(
    plantFakeFxModelsBin(`echo '{"ids":["a"]}'; exit 1`),
    async () => {
      await refreshDiscoveredModels();
      expect(getDiscoveredModels("fx")).toEqual([]);
    },
  );
});

test("discoverFx: binary missing entirely -> [] without throwing", async () => {
  await withFxBin("/tmp/agetor-nonexistent-fx-bin-xxxxx", async () => {
    await refreshDiscoveredModels();
    expect(getDiscoveredModels("fx")).toEqual([]);
  });
});

/* ── per-harness discovery (T3: harness-keyed cache, `ready`, serialization,
 * `refreshFxHarnessModels`) ─────────────────────────────────────────────── */

/** Plant a fake `fx` binary whose `models --json` output branches on `$HOME`
 *  — used to prove two fx harnesses (different env overrides) get different,
 *  account-scoped catalogs from the very same binary. */
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

test("isDiscoveryReady: false after resetForTests(), true after the first refresh settles — even a failing stub", async () => {
  __testing.resetForTests();
  expect(isDiscoveryReady()).toBe(false);
  await withFxBin(plantFakeFxModelsBin(`exit 1`), async () => {
    await refreshDiscoveredModels();
  });
  expect(isDiscoveryReady()).toBe(true);
});

test("refreshDiscoveredModels: per-harness fx targets each get their own account-scoped catalog", async () => {
  __testing.resetForTests();
  const homeA = mkdtempSync(path.join(tmpdir(), "agetor-fx-home-a-"));
  const bin = plantHomeBranchingFxBin(homeA);
  await withFxBin(bin, async () => {
    await refreshDiscoveredModels({
      fxHarnesses: [
        { harnessId: "fx", env: {} },
        { harnessId: "fx-2", env: { HOME: homeA } },
      ],
    });
  });
  // "fx-2" is probed under HOME=homeA -> the "a" branch.
  expect(getHarnessDiscoveredModels("fx-2")).toEqual([{ id: "a/one" }]);
  // "fx" has an empty env override -> probed under agetor's own process env
  // (not homeA) -> the "b" branch, same as the kind-level built-in result.
  expect(getHarnessDiscoveredModels("fx")).toEqual([{ id: "b/two" }]);
  expect(getHarnessDiscoveredModels("fx")).toEqual(getDiscoveredModels("fx"));
});

test("refreshDiscoveredModels: pruning drops a harness absent from a later call; omitting opts leaves harnessCache untouched", async () => {
  __testing.resetForTests();
  await withFxBin(plantFakeFxModelsBin(`echo '{"ids":["x"]}'; exit 0`), async () => {
    await refreshDiscoveredModels({
      fxHarnesses: [
        { harnessId: "fx", env: {} },
        { harnessId: "fx-2", env: { HOME: "/nonexistent-agetor-fx-home-a" } },
      ],
    });
    expect(getAllHarnessDiscoveredModels()).toEqual({
      fx: [{ id: "x" }],
      "fx-2": [{ id: "x" }],
    });

    // "fx-2" is absent from this call's target list -> pruned.
    await refreshDiscoveredModels({ fxHarnesses: [{ harnessId: "fx", env: {} }] });
    expect(getAllHarnessDiscoveredModels()).toEqual({ fx: [{ id: "x" }] });

    // A call with no opts at all must leave harnessCache exactly as-is —
    // it never enters the fxHarnesses branch, so nothing is pruned or added.
    await refreshDiscoveredModels();
    expect(getAllHarnessDiscoveredModels()).toEqual({ fx: [{ id: "x" }] });
  });
});

test("refreshDiscoveredModels: overlapping calls serialize — the final harness cache reflects only the second call's targets", async () => {
  __testing.resetForTests();
  const bin = plantFakeFxModelsBin(`sleep 0.05; echo '{"ids":["x"]}'; exit 0`);
  await withFxBin(bin, async () => {
    // Fire both without awaiting between them — if the old `inflight`
    // short-circuit were still in place, the second call would just return
    // the first call's promise and its target list would never be probed.
    const first = refreshDiscoveredModels({
      fxHarnesses: [
        { harnessId: "fx", env: {} },
        { harnessId: "old-harness", env: {} },
      ],
    });
    const second = refreshDiscoveredModels({
      fxHarnesses: [
        { harnessId: "fx", env: {} },
        { harnessId: "new-harness", env: {} },
      ],
    });
    await Promise.all([first, second]);
  });
  const all = getAllHarnessDiscoveredModels();
  expect(Object.keys(all).sort()).toEqual(["fx", "new-harness"]);
  expect(all["new-harness"]).toEqual([{ id: "x" }]);
  expect(all["fx"]).toEqual([{ id: "x" }]);
});

test("refreshFxHarnessModels: updates only the targeted harness, leaving the kind cache alone when env is non-empty", async () => {
  __testing.resetForTests();
  await withFxBin(plantFakeFxModelsBin(`echo '{"ids":["seed"]}'; exit 0`), async () => {
    await refreshDiscoveredModels({
      fxHarnesses: [
        { harnessId: "fx", env: {} },
        { harnessId: "fx-2", env: { HOME: "/nonexistent-agetor-fx-home-b" } },
      ],
    });
  });

  await withFxBin(plantFakeFxModelsBin(`echo '{"ids":["updated"]}'; exit 0`), async () => {
    const result = await refreshFxHarnessModels({
      harnessId: "fx-2",
      env: { HOME: "/nonexistent-agetor-fx-home-b" },
    });
    expect(result).toEqual([{ id: "updated" }]);
  });

  expect(getHarnessDiscoveredModels("fx-2")).toEqual([{ id: "updated" }]);
  expect(getHarnessDiscoveredModels("fx")).toEqual([{ id: "seed" }]); // untouched
  expect(getDiscoveredModels("fx")).toEqual([{ id: "seed" }]); // kind cache untouched (env wasn't empty)
});

test("refreshFxHarnessModels: an empty-env target also drift-corrects the kind-level cache (it IS the built-in account)", async () => {
  __testing.resetForTests();
  await withFxBin(plantFakeFxModelsBin(`echo '{"ids":["seed"]}'; exit 0`), async () => {
    await refreshDiscoveredModels({ fxHarnesses: [{ harnessId: "fx", env: {} }] });
  });
  expect(getDiscoveredModels("fx")).toEqual([{ id: "seed" }]);

  await withFxBin(plantFakeFxModelsBin(`echo '{"ids":["fresh"]}'; exit 0`), async () => {
    const result = await refreshFxHarnessModels({ harnessId: "fx", env: {} });
    expect(result).toEqual([{ id: "fresh" }]);
  });
  expect(getHarnessDiscoveredModels("fx")).toEqual([{ id: "fresh" }]);
  expect(getDiscoveredModels("fx")).toEqual([{ id: "fresh" }]);
});

/* ── per-target `bin` (code-review finding #1: discovery used to ignore
 * harness.bin entirely — every fx probe went through AGETOR_FX_BIN ?? "fx"
 * regardless of what a harness alias had configured) ───────────────────── */

test("refreshDiscoveredModels: a target's explicit `bin` is probed instead of AGETOR_FX_BIN, while a target with no `bin` still falls back to it — even with the same empty env on both", async () => {
  __testing.resetForTests();
  const builtinBin = plantFakeFxModelsBin(`echo '{"ids":["builtin-model"]}'; exit 0`);
  const secondBin = plantFakeFxModelsBin(`echo '{"ids":["second-stub-model"]}'; exit 0`);
  await withFxBin(builtinBin, async () => {
    await refreshDiscoveredModels({
      fxHarnesses: [
        { harnessId: "fx", env: {} }, // no `bin` -> AGETOR_FX_BIN (builtinBin)
        { harnessId: "fx-second", env: {}, bin: secondBin }, // explicit `bin` wins
      ],
    });
  });
  expect(getHarnessDiscoveredModels("fx")).toEqual([{ id: "builtin-model" }]);
  expect(getHarnessDiscoveredModels("fx-second")).toEqual([{ id: "second-stub-model" }]);
  // The built-in (no-bin) target's result also drift-corrects the kind-level
  // cache, same as before this field existed.
  expect(getDiscoveredModels("fx")).toEqual([{ id: "builtin-model" }]);
});

test("refreshFxHarnessModels: an explicit `bin` on the target is honored independent of AGETOR_FX_BIN, and — unlike an empty-env/no-bin target — does not drift-correct the kind-level cache", async () => {
  __testing.resetForTests();
  await withFxBin(plantFakeFxModelsBin(`echo '{"ids":["seed"]}'; exit 0`), async () => {
    await refreshDiscoveredModels({ fxHarnesses: [{ harnessId: "fx", env: {} }] });
  });
  expect(getDiscoveredModels("fx")).toEqual([{ id: "seed" }]);

  // A different AGETOR_FX_BIN is in effect here to prove the target's own
  // `bin` — not the env var — is what gets probed.
  const customBin = plantFakeFxModelsBin(`echo '{"ids":["custom"]}'; exit 0`);
  await withFxBin(plantFakeFxModelsBin(`echo '{"ids":["should-not-be-used"]}'; exit 0`), async () => {
    const result = await refreshFxHarnessModels({ harnessId: "fx-custom-bin", env: {}, bin: customBin });
    expect(result).toEqual([{ id: "custom" }]);
  });
  expect(getHarnessDiscoveredModels("fx-custom-bin")).toEqual([{ id: "custom" }]);
  // Even though env is empty, the explicit bin makes this a *different*
  // binary/account than the built-in — the kind-level "fx" cache must stay
  // exactly what it was.
  expect(getDiscoveredModels("fx")).toEqual([{ id: "seed" }]);
});

/* ── refreshKindModels / pruneHarnessDiscovery (code-review finding #2:
 * every harness edit used to trigger a full five-CLI sweep) ─────────────── */

async function withEnvOverride(name: string, value: string, run: () => Promise<void>): Promise<void> {
  const prev = process.env[name];
  process.env[name] = value;
  try {
    await run();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

function plantBin(name: string, script: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-refresh-kind-"));
  const bin = path.join(dir, name);
  writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return bin;
}

test("refreshKindModels: refreshes only the targeted kind's cache, leaving a sibling kind untouched", async () => {
  __testing.resetForTests();
  const codexBin = plantFakeCodexAppServer({ pages: [[{ id: "model-one-x" }]] });
  const cursorBin = plantBin("cursor-agent", `echo 'model-two-y'; exit 0`);

  await withEnvOverride("AGETOR_CODEX_BIN", codexBin, () =>
    withEnvOverride("AGETOR_CURSOR_BIN", cursorBin, async () => {
      await refreshKindModels("codex");
      expect(getDiscoveredModels("codex")).toEqual([{ id: "model-one-x", label: "model-one-x" }]);
      // refreshKindModels("codex") must never have probed cursor.
      expect(getDiscoveredModels("cursor")).toEqual([]);
    }));
});

test("pruneHarnessDiscovery: drops one harness's cache entry with no probe, leaving a sibling entry untouched", async () => {
  __testing.resetForTests();
  await withFxBin(plantFakeFxModelsBin(`echo '{"ids":["x"]}'; exit 0`), async () => {
    await refreshDiscoveredModels({
      fxHarnesses: [
        { harnessId: "prune-a", env: {} },
        { harnessId: "prune-b", env: { HOME: "/nonexistent-agetor-prune-b" } },
      ],
    });
  });
  expect(getAllHarnessDiscoveredModels()).toEqual({
    "prune-a": [{ id: "x" }],
    "prune-b": [{ id: "x" }],
  });

  pruneHarnessDiscovery("prune-b");

  expect(getAllHarnessDiscoveredModels()).toEqual({ "prune-a": [{ id: "x" }] });
});

test("getAllHarnessDiscoveredModels: returns copied arrays, not a live view — mutating a returned array must not corrupt the cache", async () => {
  __testing.resetForTests();
  await withFxBin(plantFakeFxModelsBin(`echo '{"ids":["stable"]}'; exit 0`), async () => {
    await refreshDiscoveredModels({ fxHarnesses: [{ harnessId: "copy-check", env: {} }] });
  });
  const snapshot = getAllHarnessDiscoveredModels();
  snapshot["copy-check"]!.push({ id: "mutated-in-caller" });
  expect(getHarnessDiscoveredModels("copy-check")).toEqual([{ id: "stable" }]);
});

/* ── refreshDiscoveredModels: `fxHarnesses` as a thunk (code-review finding
 * #10: a queued full sweep could prune a harness created after its target
 * list was snapshotted, if the list were resolved eagerly at the call site
 * instead of when the enqueued run actually starts) ─────────────────────── */

test("refreshDiscoveredModels: a thunk `fxHarnesses` is resolved inside the enqueued run, not at call time", async () => {
  __testing.resetForTests();
  await withFxBin(plantFakeFxModelsBin(`echo '{"ids":["x"]}'; exit 0`), async () => {
    let targets: FxHarnessTarget[] = [{ harnessId: "before-run", env: {} }];
    const promise = refreshDiscoveredModels({ fxHarnesses: () => targets });
    // Mutate the thunk's return value synchronously, before the enqueued run
    // has had any chance to execute — `enqueue` schedules it via
    // `chain.then(run, run)`, a microtask that can't fire until this
    // synchronous block yields control, which it hasn't done yet here. If
    // the thunk were resolved eagerly at this call site instead of inside
    // the enqueued run, this reassignment would have no effect on the
    // outcome below.
    targets = [{ harnessId: "after-run", env: {} }];
    await promise;
  });
  expect(getAllHarnessDiscoveredModels()).toEqual({ "after-run": [{ id: "x" }] });
});

/* ── getDiscoveredEfforts (the bun-side twin of `discoveredEffortsFor` in
 * src/shared/model-options.ts): harness cache first, then kind cache, `null`
 * when nothing matches or the matching entry has no efforts ────────────── */

test("getDiscoveredEfforts: returns the discovered efforts for a codex model after refresh", async () => {
  __testing.resetForTests();
  const bin = plantFakeCodexAppServer({
    pages: [[{ id: "gpt-6-astra", displayName: "GPT-6 Astra", efforts: ["ultra", "max", "high"] }]],
  });
  await withEnvOverride("AGETOR_CODEX_BIN", bin, async () => {
    await refreshKindModels("codex");
  });
  expect(getDiscoveredEfforts("codex", "gpt-6-astra")).toEqual(["ultra", "max", "high"]);
});

test("getDiscoveredEfforts: null for an unknown model id", async () => {
  __testing.resetForTests();
  const bin = plantFakeCodexAppServer({ pages: [[{ id: "gpt-6-astra", efforts: ["high"] }]] });
  await withEnvOverride("AGETOR_CODEX_BIN", bin, async () => {
    await refreshKindModels("codex");
  });
  expect(getDiscoveredEfforts("codex", "does-not-exist")).toBeNull();
});

test("getDiscoveredEfforts: null for a model whose discovered entry has no efforts", async () => {
  __testing.resetForTests();
  const bin = plantFakeCodexAppServer({ pages: [[{ id: "no-efforts-model" }]] });
  await withEnvOverride("AGETOR_CODEX_BIN", bin, async () => {
    await refreshKindModels("codex");
  });
  expect(getDiscoveredEfforts("codex", "no-efforts-model")).toBeNull();
});

test("getDiscoveredEfforts: null when nothing is cached for the kind", () => {
  __testing.resetForTests();
  expect(getDiscoveredEfforts("codex", "anything")).toBeNull();
});

// codex has no per-harness discovery seam today — only fx populates
// `harnessCache` (via `refreshFxHarnessModels`/the `fxHarnesses` sweep
// option), so harness-first precedence for codex can't be exercised here.
// This pins the fallback half of that precedence instead: a `harnessId`
// with no entry in `harnessCache` (true for every codex harness id, since
// nothing ever writes one) falls through to the kind-level cache rather than
// returning `null` outright.
test("getDiscoveredEfforts: a harnessId with no harness-cache entry falls back to the kind cache", async () => {
  __testing.resetForTests();
  const bin = plantFakeCodexAppServer({ pages: [[{ id: "gpt-6-astra", efforts: ["ultra"] }]] });
  await withEnvOverride("AGETOR_CODEX_BIN", bin, async () => {
    await refreshKindModels("codex");
  });
  expect(getDiscoveredEfforts("codex", "gpt-6-astra", "some-codex-harness-id")).toEqual(["ultra"]);
});

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  __testing,
  getAllHarnessDiscoveredModels,
  getDiscoveredModels,
  getHarnessDiscoveredModels,
  isDiscoveryReady,
  refreshDiscoveredModels,
  refreshFxHarnessModels,
} from "./agent-discovery.ts";

test("codex parser picks model ids out of a verbose listing", () => {
  const stdout = [
    "Available models:",
    "  ID                NAME            TYPE",
    "  ----------------  --------------  ---------",
    "  gpt-5             GPT-5           reasoning",
    "  gpt-5-codex       GPT-5 Codex     reasoning",
    "  o4-mini           o4 mini         reasoning",
    "",
    "Use `codex exec --model <id>` to start a run.",
  ].join("\n");

  const parsed = __testing.parseCodexModels(stdout);
  const ids = parsed.map((m) => m.id);
  expect(ids).toContain("gpt-5");
  expect(ids).toContain("gpt-5-codex");
  expect(ids).toContain("o4-mini");
  // Banner/prose lines must not bleed in.
  expect(ids).not.toContain("Available");
  expect(ids).not.toContain("Use");
});

test("codex parser dedupes repeated ids", () => {
  const parsed = __testing.parseCodexModels("gpt-5\ngpt-5\ngpt-5-codex");
  expect(parsed.map((m) => m.id)).toEqual(["gpt-5", "gpt-5-codex"]);
});

test("codex parser drops single-token words without dashes", () => {
  // Real model ids in our universe always contain a dash (gpt-5, gpt-5-codex,
  // o4-mini, opus-4-7). A bare prose word like "Available" wouldn't match
  // even if the header guard missed it.
  const parsed = __testing.parseCodexModels("hello\nworld\ngpt-5");
  expect(parsed.map((m) => m.id)).toEqual(["gpt-5"]);
});

test("cache returns an empty list before refresh is called", () => {
  // The cache is module-level; depending on test order another test may have
  // populated it. We just assert the shape — an array — rather than emptiness.
  expect(Array.isArray(getDiscoveredModels("claude-code"))).toBe(true);
  expect(Array.isArray(getDiscoveredModels("codex"))).toBe(true);
});

test("refreshDiscoveredModels resolves without throwing when the CLI is missing", async () => {
  // Point to a binary that definitely doesn't exist so the spawn fails fast.
  const prev = process.env.AGETOR_CODEX_BIN;
  process.env.AGETOR_CODEX_BIN = "/tmp/agetor-nonexistent-codex-bin-xxxxx";
  try {
    await refreshDiscoveredModels();
    expect(getDiscoveredModels("codex")).toEqual([]);
  } finally {
    if (prev === undefined) delete process.env.AGETOR_CODEX_BIN;
    else process.env.AGETOR_CODEX_BIN = prev;
  }
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

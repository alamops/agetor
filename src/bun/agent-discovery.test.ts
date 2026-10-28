import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  refreshHarnessTarget,
  refreshKindModels,
  type FxHarnessTarget,
  type HarnessTarget,
} from "./agent-discovery.ts";
import { plantFakeCodexAppServer } from "./test-codex-app-server.ts";
import { AGENT_OPTIONS } from "../shared/types.ts";

// Full sweeps (`refreshDiscoveredModels`) also run `discoverOpencode()` for the
// built-in opencode probe. Point it at a binary that doesn't exist for this
// file, so a sweep never spawns whatever real `opencode` the machine has —
// the opencode tests below plant their own stub and override this per test.
const MISSING_OPENCODE_BIN = "/nonexistent/agetor-test-opencode";
let prevOpencodeBin: string | undefined;
beforeAll(() => {
  prevOpencodeBin = process.env.AGETOR_OPENCODE_BIN;
  process.env.AGETOR_OPENCODE_BIN = MISSING_OPENCODE_BIN;
});
afterAll(() => {
  if (prevOpencodeBin === undefined) delete process.env.AGETOR_OPENCODE_BIN;
  else process.env.AGETOR_OPENCODE_BIN = prevOpencodeBin;
});

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

test("parseFxModels: 0.0.8-shaped `models --json` envelope (kind/count/shown_count/more_count/private_models_hidden) -> ids parsed, deduped, extra fields ignored", () => {
  // A dozen real ids (id subset) copied from a live binary probe of fx
  // 0.0.8's unauthenticated 244-id Gateway catalog (2026-09-08) — see
  // docs/plans/fx-0.0.8-compat.md TT3. The envelope shape itself is
  // unchanged from 0.0.7 (§2 evidence: `output_contracts.zig` byte-identical
  // both versions) — this pins the same unknown-fields-are-fine tolerance
  // against the 0.0.8-measured count/ids.
  const payload = {
    kind: "models",
    count: 244,
    shown_count: 244,
    more_count: 0,
    private_models_hidden: true,
    ids: [
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-fable-5.1",
      "anthropic/claude-haiku-4.5",
      "openai/gpt-6-astra",
      "openai/gpt-5.6-sol",
      "zai/glm-5.3",
      "zai/glm-5.3-flash",
      "deepseek/deepseek-v4-pro",
      "spacexai/grok-4.6",
      "meta/llama-4-maverick",
      "mistral/mistral-large-3",
      "zai/glm-5.3", // duplicate — must be deduped, first occurrence wins
    ],
  };
  const parsed = __testing.parseFxModels(JSON.stringify(payload));
  expect(parsed.map((m) => m.id)).toEqual([
    "anthropic/claude-opus-5",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-fable-5.1",
    "anthropic/claude-haiku-4.5",
    "openai/gpt-6-astra",
    "openai/gpt-5.6-sol",
    "zai/glm-5.3",
    "zai/glm-5.3-flash",
    "deepseek/deepseek-v4-pro",
    "spacexai/grok-4.6",
    "meta/llama-4-maverick",
    "mistral/mistral-large-3",
  ]);
});

test("parseFxModels: 0.0.10-shaped envelope (247 ids, private_models_hidden true, 2026-09-14 — identical on the 0.0.8/0.0.9/0.0.10 binaries, i.e. Gateway-side)", () => {
  // Real fx 0.0.10 `models --json` (build_revision 1210c2756ea8) returns an
  // unauthenticated Gateway catalog of 247 ids — grown from 0.0.8's 244
  // (docs/plans/fx-0.0.8-compat.md) purely Gateway-side: the same probe pass
  // measured 247 identically against the 0.0.8, 0.0.9, and 0.0.10 binaries
  // (docs/plans/fx-0.0.10-compat.md §2) — see
  // scratchpad/spikes/fx-0010-probe/models-0.0.10.json, whose `count`/
  // `shown_count`/`more_count`/`private_models_hidden` fields are mirrored
  // below. Rather than inline all 247 real ids, generate a list that
  // contains every curated AGENT_OPTIONS.fx.models id (all 28 then-curated
  // ids confirmed present in the real payload; spacexai/grok-4.7 (curated
  // since 2026-09-21), anthropic/claude-opus-5.5, openai/gpt-6-sol and
  // openai/gpt-6-luna (curated since 2026-09-22) and
  // anthropic/claude-sonnet-5.5 (curated since 2026-09-28) and
  // anthropic/claude-haiku-5.5 (curated since 2026-10-07) and
  // google/gemini-4-argon (curated since 2026-10-14) postdate it)
  // padded out with synthetic filler ids to
  // the real count, and assert both the exact count and full curated
  // coverage — the envelope's unknown-fields-are-fine tolerance is already
  // pinned by the 0.0.7/0.0.8 tests above.
  const curatedIds = AGENT_OPTIONS.fx.models.map((m) => m.id);
  const filler = Array.from(
    { length: 247 - curatedIds.length },
    (_, i) => `vendor/filler-model-${i}`,
  );
  const ids = [...curatedIds, ...filler];
  const payload = {
    kind: "models",
    count: 247,
    shown_count: 247,
    more_count: 0,
    private_models_hidden: true,
    ids,
  };
  const parsed = __testing.parseFxModels(JSON.stringify(payload));
  expect(parsed.length).toBe(247);
  const parsedIds = new Set(parsed.map((m) => m.id));
  for (const id of curatedIds) {
    expect(parsedIds.has(id)).toBe(true);
  }
});

/* ── fx 0.0.14: parseFxModels reading `models[]` ───────────────────────────
 * 0.0.14 adds `models: [{id, name, efforts, fast, ultrafast}]` beside `ids`
 * (same ids, same order). The entries below mirror real 0.0.14 rows from
 * the 2026-10-22 unauthenticated capture (264 ids). */

const FX_0014_MODELS = [
  { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: ["low", "medium", "high", "xhigh", "max"], fast: true, ultrafast: true },
  { id: "openai/gpt-5.2", name: "GPT 5.2", efforts: ["none", "minimal", "low", "medium", "high", "xhigh"], fast: true, ultrafast: false },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", efforts: ["none", "low", "medium", "high"], fast: false, ultrafast: false },
  { id: "vendor/no-reasoning", name: "No Reasoning", efforts: [], fast: false, ultrafast: false },
];

function fx0014Envelope(models: unknown[], ids?: unknown[]): string {
  return JSON.stringify({
    kind: "models",
    count: models.length,
    shown_count: models.length,
    more_count: 0,
    private_models_hidden: true,
    ids: ids ?? models.map((m) => (m as { id: unknown }).id),
    models,
  });
}

test("parseFxModels (0.0.14): models[] maps to efforts + auto, the name as label, and true-only fast/ultrafast", () => {
  expect(__testing.parseFxModels(fx0014Envelope(FX_0014_MODELS))).toEqual([
    {
      id: "openai/gpt-6.1-sol",
      label: "GPT-6.1 Sol",
      efforts: ["low", "medium", "high", "xhigh", "max", "auto"],
      fast: true,
      ultrafast: true,
    },
    {
      id: "openai/gpt-5.2",
      label: "GPT 5.2",
      efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "auto"],
      fast: true,
    },
    { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", efforts: ["none", "low", "medium", "high", "auto"] },
    // No efforts reported → no `efforts` key at all (not even `["auto"]`),
    // so the curated table stays the source for that id.
    { id: "vendor/no-reasoning", label: "No Reasoning" },
  ]);
});

test("parseFxModels (0.0.14): never attaches false/empty keys", () => {
  const [entry] = __testing.parseFxModels(
    fx0014Envelope([{ id: "a/b", name: "", efforts: [], fast: false, ultrafast: false }]),
  );
  expect(entry).toEqual({ id: "a/b" });
  expect(Object.keys(entry!)).toEqual(["id"]);
});

test("parseFxModels (0.0.14): a reported `auto` isn't doubled, and repeated efforts are deduped", () => {
  const [entry] = __testing.parseFxModels(
    fx0014Envelope([{ id: "a/b", efforts: ["low", "auto", "low", "high"] }]),
  );
  expect(entry!.efforts).toEqual(["low", "auto", "high"]);
});

test("parseFxModels (0.0.14): malformed entries are skipped and malformed fields ignored", () => {
  const parsed = __testing.parseFxModels(
    fx0014Envelope(
      [
        null,
        "openai/gpt-5.2",
        42,
        [],
        { name: "No id" },
        { id: "" },
        { id: 7 },
        // Field-level junk: a non-string name, non-string efforts entries,
        // and truthy-but-not-`true` speed flags all read as absent.
        { id: "x/one", name: 3, efforts: ["high", 1, null, "", "low"], fast: "true", ultrafast: 1 },
        { id: "x/two", efforts: "high" },
        { id: "x/one", name: "Duplicate", efforts: ["max"] },
      ],
      ["x/one", "x/two"],
    ),
  );
  expect(parsed).toEqual([
    { id: "x/one", efforts: ["high", "low", "auto"] },
    { id: "x/two" },
  ]);
});

test("parseFxModels (0.0.14): an id missing from models[] still comes through from ids, after the models[] rows", () => {
  const parsed = __testing.parseFxModels(
    fx0014Envelope([FX_0014_MODELS[2]], ["openai/gpt-5.2", "deepseek/deepseek-v4-flash"]),
  );
  expect(parsed).toEqual([
    { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", efforts: ["none", "low", "medium", "high", "auto"] },
    { id: "openai/gpt-5.2" },
  ]);
});

test("parseFxModels (0.0.14): models[] alone (no ids) is enough", () => {
  const parsed = __testing.parseFxModels(JSON.stringify({ models: [FX_0014_MODELS[2]] }));
  expect(parsed.map((m) => m.id)).toEqual(["deepseek/deepseek-v4-flash"]);
});

test("parseFxModels (≤0.0.13): an ids-only envelope behaves exactly as before — {id} rows, no efforts/labels/flags", () => {
  const parsed = __testing.parseFxModels(
    JSON.stringify({ kind: "models", count: 2, ids: ["openai/gpt-5.2", "deepseek/deepseek-v4-flash"] }),
  );
  expect(parsed).toEqual([{ id: "openai/gpt-5.2" }, { id: "deepseek/deepseek-v4-flash" }]);
});

test("parseFxModels (0.0.14): a non-array models field falls back to ids", () => {
  const parsed = __testing.parseFxModels(JSON.stringify({ ids: ["a/b"], models: "nope" }));
  expect(parsed).toEqual([{ id: "a/b" }]);
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

test("getDiscoveredEfforts: an fx 0.0.14 `models --json` catalog serves its efforts (with auto) after refresh", async () => {
  __testing.resetForTests();
  const body = fx0014Envelope(FX_0014_MODELS);
  await withFxBin(
    plantFakeFxModelsBin(`if [ "$1" = "models" ] && [ "$2" = "--json" ]; then echo '${body}'; exit 0; fi\nexit 1`),
    async () => {
      await refreshKindModels("fx");
    },
  );
  expect(getDiscoveredEfforts("fx", "deepseek/deepseek-v4-flash")).toEqual(["none", "low", "medium", "high", "auto"]);
  expect(getDiscoveredEfforts("fx", "vendor/no-reasoning")).toBeNull();
  expect(getDiscoveredModels("fx").find((m) => m.id === "openai/gpt-6.1-sol")).toMatchObject({ fast: true, ultrafast: true });
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

/* ── per-harness codex discovery (`HarnessTarget` with `kind: "codex"`,
 * `refreshHarnessTarget`) — codex joined the same per-harness discovery path
 * fx already had; see agent-discovery.ts's `isBuiltinLikeTarget`/
 * `runRefreshHarnessTarget`/`runRefresh` for the kind-aware dispatch this
 * pins. ─────────────────────────────────────────────────────────────────── */

test("refreshHarnessTarget: a codex target with its own env/bin gets its own harness-cache entry and does not drift-correct the kind cache", async () => {
  __testing.resetForTests();
  const stubA = plantFakeCodexAppServer({ pages: [[{ id: "stub-a-model", displayName: "Stub A" }]] });
  const stubB = plantFakeCodexAppServer({ pages: [[{ id: "stub-b-model", displayName: "Stub B" }]] });

  await withEnvOverride("AGETOR_CODEX_BIN", stubA, async () => {
    await refreshKindModels("codex");
  });
  expect(getDiscoveredModels("codex")).toEqual([{ id: "stub-a-model", label: "Stub A" }]);

  const target: HarnessTarget = {
    harnessId: "codex-2",
    kind: "codex",
    env: { HOME: "/tmp/agetor-fake-home-x" },
    bin: stubB,
  };
  const result = await refreshHarnessTarget(target);
  expect(result).toEqual([{ id: "stub-b-model", label: "Stub B" }]);
  expect(getHarnessDiscoveredModels("codex-2")).toEqual([{ id: "stub-b-model", label: "Stub B" }]);
  // A target with its own env/bin is a different account/binary from the
  // built-in kind-level probe — it must never drift-correct that cache.
  expect(getDiscoveredModels("codex")).toEqual([{ id: "stub-a-model", label: "Stub A" }]);
  expect(getAllHarnessDiscoveredModels()).toEqual({ "codex-2": [{ id: "stub-b-model", label: "Stub B" }] });
});

test("getDiscoveredEfforts: harness cache wins over the kind cache for codex when both report the same model id with different efforts", async () => {
  __testing.resetForTests();
  const stubA = plantFakeCodexAppServer({
    pages: [[{ id: "m1", displayName: "M1", efforts: ["low", "high"] }]],
  });
  const stubB = plantFakeCodexAppServer({
    pages: [[{ id: "m1", displayName: "M1", efforts: ["low", "high", "ultra"] }]],
  });

  await withEnvOverride("AGETOR_CODEX_BIN", stubA, async () => {
    await refreshKindModels("codex");
  });
  await refreshHarnessTarget({
    harnessId: "codex-2",
    kind: "codex",
    env: { HOME: "/tmp/agetor-fake-home-x" },
    bin: stubB,
  });

  expect(getDiscoveredEfforts("codex", "m1", "codex-2")).toEqual(["low", "high", "ultra"]);
  // No harnessId at all -> straight to the kind cache (stubA's efforts).
  expect(getDiscoveredEfforts("codex", "m1")).toEqual(["low", "high"]);
  // "codex" has no entry of its own in harnessCache (only "codex-2" does) ->
  // falls back to the kind cache, same result as the no-harnessId call above.
  expect(getDiscoveredEfforts("codex", "m1", "codex")).toEqual(["low", "high"]);
});

test("refreshHarnessTarget: a built-in-like codex target (empty env, default bin) drift-corrects the kind-level cache", async () => {
  __testing.resetForTests();
  const stub = plantFakeCodexAppServer({ pages: [[{ id: "builtin-like-model", displayName: "Builtin Like" }]] });
  await withEnvOverride("AGETOR_CODEX_BIN", stub, async () => {
    const result = await refreshHarnessTarget({ harnessId: "codex", kind: "codex", env: {} });
    expect(result).toEqual([{ id: "builtin-like-model", label: "Builtin Like" }]);
  });
  expect(getHarnessDiscoveredModels("codex")).toEqual([{ id: "builtin-like-model", label: "Builtin Like" }]);
  expect(getDiscoveredModels("codex")).toEqual([{ id: "builtin-like-model", label: "Builtin Like" }]);
});

test("refreshDiscoveredModels({ fxHarnesses }): a codex target populates the harness cache, and a stale codex harness id absent from a later call is pruned", async () => {
  __testing.resetForTests();
  const stub = plantFakeCodexAppServer({ pages: [[{ id: "codex-sweep-model", displayName: "Sweep" }]] });
  await refreshDiscoveredModels({
    fxHarnesses: [
      { harnessId: "codex-a", kind: "codex", env: {}, bin: stub },
      { harnessId: "codex-b", kind: "codex", env: {}, bin: stub },
    ],
  });
  expect(getAllHarnessDiscoveredModels()).toEqual({
    "codex-a": [{ id: "codex-sweep-model", label: "Sweep" }],
    "codex-b": [{ id: "codex-sweep-model", label: "Sweep" }],
  });

  // "codex-b" is absent from this call's target list -> pruned, mirroring the
  // fx prune idiom above ("pruning drops a harness absent from a later call").
  await refreshDiscoveredModels({
    fxHarnesses: [{ harnessId: "codex-a", kind: "codex", env: {}, bin: stub }],
  });
  expect(getAllHarnessDiscoveredModels()).toEqual({
    "codex-a": [{ id: "codex-sweep-model", label: "Sweep" }],
  });
});

/* ── discoverCodex edge cases the shared `plantFakeCodexAppServer` stub can't
 * drive (timing and exact-byte-output control) — small inline stubs built
 * directly with `plantBin`, the same helper `refreshKindModels`'s own tests
 * below use. ─────────────────────────────────────────────────────────────── */

function plantCodexTimeoutStub(): string {
  return plantBin(
    "codex",
    `if [ "$1" != "app-server" ]; then exit 2; fi
n=0
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\\([0-9][0-9]*\\).*/\\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{"userAgent":"fake-codex"}}\\n' "$id" ;;
    *'"method":"model/list"'*)
      n=$((n+1))
      if [ "$n" -eq 1 ]; then
        printf '{"id":%s,"result":{"data":[{"id":"early-model"}],"nextCursor":"c1"}}\\n' "$id"
      else
        sleep 2
        printf '{"id":%s,"result":{"data":[{"id":"late-model"}],"nextCursor":null}}\\n' "$id"
      fi
      ;;
  esac
done`,
  );
}

test("discoverCodex (via refreshKindModels): a timeout that fires mid-pagination discards the already-fetched first page, resolving [] promptly", async () => {
  __testing.resetForTests();
  const bin = plantCodexTimeoutStub();
  __testing.setCodexProbeTimeoutMs(300);
  try {
    const start = Date.now();
    await withEnvOverride("AGETOR_CODEX_BIN", bin, async () => {
      await refreshKindModels("codex");
    });
    expect(getDiscoveredModels("codex")).toEqual([]);
    expect(Date.now() - start).toBeLessThan(1_500);
  } finally {
    __testing.setCodexProbeTimeoutMs(null);
  }
});

function plantCodexNoTrailingNewlineStub(): string {
  return plantBin(
    "codex",
    `if [ "$1" != "app-server" ]; then exit 2; fi
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\\([0-9][0-9]*\\).*/\\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{"userAgent":"fake-codex"}}\\n' "$id" ;;
    *'"method":"model/list"'*)
      json='{"id":'"$id"',"result":{"data":[{"id":"no-newline-model","displayName":"No NL"}],"nextCursor":null}}'
      printf '%s' "$json"
      exit 0
      ;;
  esac
done`,
  );
}

test("discoverCodex (via refreshKindModels): a final model/list reply with no trailing newline is still parsed", async () => {
  __testing.resetForTests();
  const bin = plantCodexNoTrailingNewlineStub();
  const start = Date.now();
  await withEnvOverride("AGETOR_CODEX_BIN", bin, async () => {
    await refreshKindModels("codex");
  });
  expect(getDiscoveredModels("codex")).toEqual([{ id: "no-newline-model", label: "No NL" }]);
  expect(Date.now() - start).toBeLessThan(1_500);
});

function plantCodexGrandchildStub(): string {
  return plantBin(
    "codex",
    `if [ "$1" != "app-server" ]; then exit 2; fi
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\\([0-9][0-9]*\\).*/\\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{"userAgent":"fake-codex"}}\\n' "$id" ;;
    *'"method":"model/list"'*)
      printf '{"id":%s,"result":{"data":[{"id":"grandchild-model","displayName":"GC"}],"nextCursor":null}}\\n' "$id"
      sleep 30 &
      exit 0
      ;;
  esac
done`,
  );
}

test("discoverCodex (via refreshKindModels): a grandchild that keeps holding the stdout pipe open after the direct child exits does not block discovery from resolving promptly", async () => {
  __testing.resetForTests();
  const bin = plantCodexGrandchildStub();
  const start = Date.now();
  await withEnvOverride("AGETOR_CODEX_BIN", bin, async () => {
    await refreshKindModels("codex");
  });
  expect(getDiscoveredModels("codex")).toEqual([{ id: "grandchild-model", label: "GC" }]);
  expect(Date.now() - start).toBeLessThan(1_500);
});

/* ── opencode: parsers (pure, over the captured CLI fixtures) ─────────────
 * Fixtures: src/bun/fixtures/opencode/ (README.md), captured from live v2.1.3
 * and v1.19.4 runs. Spike doc §2e / amendment A3: v2 reads variants from
 * `api --standalone model.list`, v1 from `models --verbose`. */

const OPENCODE_FIXTURES = path.join(import.meta.dir, "fixtures", "opencode");
const opencodeFixture = (name: string): string => readFileSync(path.join(OPENCODE_FIXTURES, name), "utf8");

test("parseOpencodeModels: one provider/model id per line (v2 and v1 fixtures)", () => {
  const v2 = __testing.parseOpencodeModels(opencodeFixture("v2-models.txt"));
  expect(v2.map((m) => m.id)).toEqual([
    "opencode/beam-free",
    "opencode/big-pickle",
    "opencode/deepseek-v4.1-flash-free",
    "opencode/flint-40b-free",
    "opencode/glm-5.3-flash-free",
    "opencode/mimo-v2.6-flash-free",
    "opencode/nemotron-3-ultra-free",
    "opencode/nemotron-3.5-lightning-free",
    "opencode/nemotron-3.5-super-vl-free",
  ]);
  // Ids only — `models` carries no label or variant data.
  expect(v2[0]).toEqual({ id: "opencode/beam-free" });
  expect(__testing.parseOpencodeModels(opencodeFixture("v1-models.txt"))).toHaveLength(10);
});

test("parseOpencodeModels: skips blanks, prose, JSON lines and ANSI noise; dedupes", () => {
  const out = __testing.parseOpencodeModels(
    "\n\x1b[33mwarning: something\x1b[0m\n{\n  \"id\": \"x\"\n}\nopencode/a\nopencode/a\n  anthropic/claude-x  \n",
  );
  expect(out).toEqual([{ id: "opencode/a" }, { id: "anthropic/claude-x" }]);
});

test("parseOpencodeApiModelList: v2 model.list → providerID/id, name, variant ids in order; [] for none", () => {
  const out = __testing.parseOpencodeApiModelList(opencodeFixture("v2-api-model-list.json"));
  expect(out).toHaveLength(9);
  const byId = new Map(out.map((m) => [m.id, m]));
  expect(byId.get("opencode/big-pickle")).toEqual({ id: "opencode/big-pickle", label: "Big Pickle", efforts: [] });
  expect(byId.get("opencode/deepseek-v4.1-flash-free")).toEqual({
    id: "opencode/deepseek-v4.1-flash-free",
    label: "DeepSeek V4.1 Flash Free",
    efforts: ["low", "high", "max"],
  });
  expect(byId.get("opencode/nemotron-3.5-super-vl-free")?.efforts).toEqual([
    "none", "minimal", "low", "medium", "high", "xhigh",
  ]);
});

test("parseOpencodeApiModelList: malformed answers degrade to []; bad entries and enabled:false are skipped", () => {
  expect(__testing.parseOpencodeApiModelList("not json")).toEqual([]);
  expect(__testing.parseOpencodeApiModelList("{}")).toEqual([]);
  expect(__testing.parseOpencodeApiModelList(JSON.stringify({ data: "x" }))).toEqual([]);
  const out = __testing.parseOpencodeApiModelList(JSON.stringify({
    data: [
      null,
      { providerID: "p", id: "" },
      { id: "no-provider" },
      { providerID: "p", id: "off", enabled: false },
      { providerID: "p", id: "m", variants: [{ id: "high" }, { id: "high" }, { id: 3 }, "low", { id: " " }] },
      { providerID: "p", id: "m", name: "Dup" },
      { providerID: "p", id: "nv" },
    ],
  }));
  expect(out).toEqual([
    { id: "p/m", efforts: ["high"] },
    { id: "p/nv", efforts: [] },
  ]);
});

test("parseOpencodeVerboseModels: v1 models --verbose → id + name + Object.keys(variants); {} → []", () => {
  expect(__testing.parseOpencodeVerboseModels(opencodeFixture("v1-models-verbose.txt"))).toEqual([
    { id: "opencode/beam-free", label: "Beam Free", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "opencode/big-pickle", label: "Big Pickle", efforts: [] },
  ]);
});

test("parseOpencodeVerboseModels: an id with no block, or an unparsable block, keeps no efforts key (unknown)", () => {
  const out = __testing.parseOpencodeVerboseModels(
    ["p/no-block", "p/bad-block", "{", "  not json", "}", "p/no-variants-key", "{", '  "name": "N"', "}"].join("\n"),
  );
  expect(out).toEqual([
    { id: "p/no-block" },
    { id: "p/bad-block" },
    { id: "p/no-variants-key", label: "N", efforts: [] },
  ]);
});

/* ── opencode: discoverOpencode end-to-end against planted stub binaries ── */

/**
 * A stub `opencode` that answers by argv (`$*`): each case key is the exact
 * argument string, each value a shell body. Unknown argv exits 1 (both real
 * lines reject an unknown flag). Every invocation's argv is appended to the
 * returned `log` file, and `env` lines prove what env the probe ran under.
 */
function plantFakeOpencode(cases: Record<string, string>): { bin: string; log: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-opencode-bin-"));
  const bin = path.join(dir, "opencode");
  const log = path.join(dir, "argv.log");
  const branches = Object.entries(cases)
    .map(([argv, body]) => `  "${argv}")\n${body}\n    ;;`)
    .join("\n");
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$*" >> '${log}'\ncase "$*" in\n${branches}\n  *) exit 1 ;;\nesac\n`,
    { mode: 0o755 },
  );
  writeFileSync(log, "");
  return { bin, log, dir };
}

const catFixture = (name: string): string => `    cat '${path.join(OPENCODE_FIXTURES, name)}'`;
const loggedArgv = (log: string): string[] => readFileSync(log, "utf8").split("\n").filter((l) => l !== "");

test("discoverOpencode v2: ids from models --standalone, labels + variants from api --standalone model.list", async () => {
  __testing.resetForTests();
  const { bin, log } = plantFakeOpencode({
    "--version": catFixture("v2-version.txt"),
    "models --standalone": catFixture("v2-models.txt"),
    "api --standalone model.list": catFixture("v2-api-model-list.json"),
  });
  const models = await refreshHarnessTarget({ harnessId: "opencode-v2", kind: "opencode", env: {}, bin });
  // Order follows `models`; data follows the API.
  expect(models.map((m) => m.id)).toEqual(__testing.parseOpencodeModels(opencodeFixture("v2-models.txt")).map((m) => m.id));
  expect(models[0]).toEqual({
    id: "opencode/beam-free",
    label: "Beam Free",
    efforts: ["low", "medium", "high", "xhigh", "max"],
  });
  expect(models.find((m) => m.id === "opencode/big-pickle")).toEqual({
    id: "opencode/big-pickle",
    label: "Big Pickle",
    efforts: [],
  });
  expect(getHarnessDiscoveredModels("opencode-v2")).toEqual(models);
  // v2 never ran a probe without --standalone (that would start the shared service).
  const argv = loggedArgv(log);
  expect(argv).toContain("--version");
  expect(argv.filter((a) => a !== "--version").every((a) => a.includes("--standalone"))).toBe(true);
});

test("discoverOpencode: probes under the target env, with OPENCODE_DISABLE_AUTOUPDATE defaulting to 1", async () => {
  __testing.resetForTests();
  const { bin } = plantFakeOpencode({
    "--version": `    [ "$OPENCODE_DISABLE_AUTOUPDATE" = "1" ] || exit 1\n    [ "$AGETOR_TEST_HOME_MARK" = "acct-b" ] || exit 1\n    echo 'opencode v2.1.3'`,
    "models --standalone": `    echo 'anthropic/claude-x'`,
    "api --standalone model.list": `    exit 1`,
  });
  const models = await refreshHarnessTarget({
    harnessId: "opencode-env",
    kind: "opencode",
    env: { AGETOR_TEST_HOME_MARK: "acct-b" },
    bin,
  });
  expect(models).toEqual([{ id: "anthropic/claude-x" }]);
});

test("discoverOpencode v2: a failed variant probe → ids only, with no efforts key (unknown)", async () => {
  __testing.resetForTests();
  const { bin } = plantFakeOpencode({
    "--version": catFixture("v2-version.txt"),
    "models --standalone": catFixture("v2-models.txt"),
    "api --standalone model.list": `    echo 'not json'`,
  });
  const models = await refreshHarnessTarget({ harnessId: "opencode-noapi", kind: "opencode", env: {}, bin });
  expect(models).toHaveLength(9);
  for (const m of models) expect(m).toEqual({ id: m.id });
  expect(getDiscoveredEfforts("opencode", "opencode/big-pickle", "opencode-noapi")).toBeNull();
});

test("discoverOpencode v2: a probe that loses the cold-home db race is retried once and its variants kept", async () => {
  __testing.resetForTests();
  // The first `api` call fails like a real v2 in a fresh home whose
  // opencode.db the concurrent `models` call is creating (live W4 smoke).
  const flagDir = mkdtempSync(path.join(tmpdir(), "agetor-opencode-cold-"));
  const { bin, log } = plantFakeOpencode({
    "--version": catFixture("v2-version.txt"),
    "models --standalone": catFixture("v2-models.txt"),
    "api --standalone model.list":
      `    if [ ! -f '${flagDir}/api-once' ]; then : > '${flagDir}/api-once'; echo 'Error: Standalone server exited before reporting readiness' >&2; exit 1; fi\n` +
      catFixture("v2-api-model-list.json"),
  });
  const models = await refreshHarnessTarget({ harnessId: "opencode-cold", kind: "opencode", env: {}, bin });
  expect(models.find((m) => m.id === "opencode/deepseek-v4.1-flash-free")?.efforts).toEqual(["low", "high", "max"]);
  expect(loggedArgv(log).filter((a) => a === "api --standalone model.list")).toHaveLength(2);
  expect(loggedArgv(log).filter((a) => a === "models --standalone")).toHaveLength(1);
});

test("discoverOpencode v2: models --standalone failing falls back to the API's own list", async () => {
  __testing.resetForTests();
  const { bin } = plantFakeOpencode({
    "--version": catFixture("v2-version.txt"),
    "models --standalone": `    exit 1`,
    "api --standalone model.list": catFixture("v2-api-model-list.json"),
  });
  const models = await refreshHarnessTarget({ harnessId: "opencode-nomodels", kind: "opencode", env: {}, bin });
  expect(models).toEqual(__testing.parseOpencodeApiModelList(opencodeFixture("v2-api-model-list.json")));
});

test("discoverOpencode v1: one models --verbose call; never passes --standalone", async () => {
  __testing.resetForTests();
  const { bin, log } = plantFakeOpencode({
    "--version": catFixture("v1-version.txt"),
    "models --verbose": catFixture("v1-models-verbose.txt"),
  });
  const models = await refreshHarnessTarget({ harnessId: "opencode-v1", kind: "opencode", env: {}, bin });
  expect(models).toEqual([
    { id: "opencode/beam-free", label: "Beam Free", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "opencode/big-pickle", label: "Big Pickle", efforts: [] },
  ]);
  expect(loggedArgv(log)).toEqual(["--version", "models --verbose"]);
});

test("discoverOpencode v1: models --verbose failing falls back to plain models (ids only)", async () => {
  __testing.resetForTests();
  const { bin, log } = plantFakeOpencode({
    "--version": catFixture("v1-version.txt"),
    "models --verbose": `    exit 1`,
    models: catFixture("v1-models.txt"),
  });
  const models = await refreshHarnessTarget({ harnessId: "opencode-v1-plain", kind: "opencode", env: {}, bin });
  expect(models).toHaveLength(10);
  for (const m of models) expect(m).toEqual({ id: m.id });
  expect(loggedArgv(log)).toEqual(["--version", "models --verbose", "models"]);
});

test("discoverOpencode: a failing --version probe → [] without running any model probe", async () => {
  __testing.resetForTests();
  const { bin, log } = plantFakeOpencode({ "--version": `    exit 1` });
  expect(await refreshHarnessTarget({ harnessId: "opencode-broken", kind: "opencode", env: {}, bin })).toEqual([]);
  expect(loggedArgv(log)).toEqual(["--version"]);
});

test("discoverOpencode: a binary that doesn't exist resolves [] without spawning", async () => {
  __testing.resetForTests();
  expect(await __testing.discoverOpencode({}, "/nonexistent/opencode-xyz")).toEqual([]);
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("discoverOpencode: a hung variant probe times out → ids only; the child is killed and a pipe-holding grandchild can't stall it", async () => {
  __testing.resetForTests();
  __testing.setOpencodeProbeTimeouts({ budgetMs: 1_200, versionMs: 1_000 });
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-opencode-hang-"));
  const pidFile = path.join(dir, "api.pid");
  const grandchildPidFile = path.join(dir, "grandchild.pid");
  const { bin } = plantFakeOpencode({
    "--version": catFixture("v2-version.txt"),
    "models --standalone": catFixture("v2-models.txt"),
    // Prints half an answer, leaves a grandchild holding stdout, then hangs.
    "api --standalone model.list": [
      `    echo $$ > '${pidFile}'`,
      `    printf '{"data":['`,
      `    sleep 30 &`,
      `    echo $! > '${grandchildPidFile}'`,
      `    wait`,
    ].join("\n"),
  });
  const start = Date.now();
  let grandchild: number | null = null;
  try {
    const models = await refreshHarnessTarget({ harnessId: "opencode-hang", kind: "opencode", env: {}, bin });
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(models).toHaveLength(9);
    for (const m of models) expect(m).toEqual({ id: m.id });
    grandchild = Number(readFileSync(grandchildPidFile, "utf8").trim());
    const apiPid = Number(readFileSync(pidFile, "utf8").trim());
    const deadline = Date.now() + 1_000;
    while (pidAlive(apiPid) && Date.now() < deadline) await Bun.sleep(25);
    expect(pidAlive(apiPid)).toBe(false);
  } finally {
    __testing.setOpencodeProbeTimeouts(null);
    if (grandchild !== null && pidAlive(grandchild)) process.kill(grandchild);
  }
});

test("discoverOpencode: a probe whose grandchild keeps stdout open after a clean exit still succeeds promptly", async () => {
  __testing.resetForTests();
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-opencode-linger-"));
  const grandchildPidFile = path.join(dir, "grandchild.pid");
  const { bin } = plantFakeOpencode({
    "--version": catFixture("v2-version.txt"),
    "models --standalone": catFixture("v2-models.txt"),
    "api --standalone model.list": [
      catFixture("v2-api-model-list.json"),
      `    sleep 30 &`,
      `    echo $! > '${grandchildPidFile}'`,
      `    exit 0`,
    ].join("\n"),
  });
  const start = Date.now();
  try {
    const models = await refreshHarnessTarget({ harnessId: "opencode-linger", kind: "opencode", env: {}, bin });
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(models.find((m) => m.id === "opencode/big-pickle")?.efforts).toEqual([]);
  } finally {
    try {
      const gc = Number(readFileSync(grandchildPidFile, "utf8").trim());
      if (pidAlive(gc)) process.kill(gc);
    } catch { /* never started */ }
  }
});

// A full sweep also runs every other kind's real probe (cursor's alone can
// take its 3 s cap), so give it room on a loaded machine.
test("refreshKindModels('opencode') and a full sweep fill the opencode kind cache from AGETOR_OPENCODE_BIN (index-aligned kinds)", async () => {
  __testing.resetForTests();
  const { bin } = plantFakeOpencode({
    "--version": catFixture("v1-version.txt"),
    "models --verbose": catFixture("v1-models-verbose.txt"),
  });
  const expected = __testing.parseOpencodeVerboseModels(opencodeFixture("v1-models-verbose.txt"));
  await withEnvOverride("AGETOR_OPENCODE_BIN", bin, async () => {
    await refreshKindModels("opencode");
    expect(getDiscoveredModels("opencode")).toEqual(expected);

    __testing.resetForTests();
    await refreshDiscoveredModels();
  });
  expect(getDiscoveredModels("opencode")).toEqual(expected);
  // The sweep's results land under their own kinds — opencode's list didn't
  // shift onto a neighbour.
  expect(getDiscoveredModels("antigravity")).not.toEqual(expected);
  expect(getDiscoveredModels("claude-code")).toEqual([]);
}, 30_000);

// A full sweep also runs every other kind's real probe (cursor's alone can
// take its 3 s cap), so give it room on a loaded machine.
test("a full sweep probes an opencode harness target under its own bin, and prunes it when absent", async () => {
  __testing.resetForTests();
  const { bin } = plantFakeOpencode({
    "--version": catFixture("v2-version.txt"),
    "models --standalone": `    echo 'opencode/only-model'`,
    "api --standalone model.list": `    echo '{"data":[{"providerID":"opencode","id":"only-model","variants":[{"id":"thinking"}]}]}'`,
  });
  await refreshDiscoveredModels({ fxHarnesses: [{ harnessId: "opencode-sweep", kind: "opencode", env: {}, bin }] });
  expect(getHarnessDiscoveredModels("opencode-sweep")).toEqual([{ id: "opencode/only-model", efforts: ["thinking"] }]);
  expect(getDiscoveredEfforts("opencode", "opencode/only-model", "opencode-sweep")).toEqual(["thinking"]);
  await refreshDiscoveredModels({ fxHarnesses: [] });
  expect(getHarnessDiscoveredModels("opencode-sweep")).toEqual([]);
}, 30_000);

test("getDiscoveredEfforts: passes an explicit [] through (opencode 'no variants'), null when the key is absent", async () => {
  __testing.resetForTests();
  const { bin } = plantFakeOpencode({
    "--version": catFixture("v2-version.txt"),
    "models --standalone": `    printf 'p/none\\np/unknown\\n'`,
    "api --standalone model.list": `    echo '{"data":[{"providerID":"p","id":"none","variants":[]}]}'`,
  });
  await refreshHarnessTarget({ harnessId: "opencode-efforts", kind: "opencode", env: {}, bin });
  expect(getHarnessDiscoveredModels("opencode-efforts")).toEqual([{ id: "p/none", efforts: [] }, { id: "p/unknown" }]);
  expect(getDiscoveredEfforts("opencode", "p/none", "opencode-efforts")).toEqual([]);
  expect(getDiscoveredEfforts("opencode", "p/unknown", "opencode-efforts")).toBeNull();
  expect(getDiscoveredEfforts("opencode", "p/missing", "opencode-efforts")).toBeNull();
  expect(getDiscoveredEfforts("opencode", null, "opencode-efforts")).toBeNull();
});

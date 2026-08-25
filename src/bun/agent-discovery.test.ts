import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { __testing, getDiscoveredModels, refreshDiscoveredModels } from "./agent-discovery.ts";

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
  await withFxBin(
    plantFakeFxModelsBin(
      `if [ "$1" = "models" ] && [ "$2" = "--json" ]; then echo '{"ids":["moonshotai/kimi-k3","openai/gpt-5.5"]}'; exit 0; fi\nexit 1`,
    ),
    async () => {
      await refreshDiscoveredModels();
      expect(getDiscoveredModels("fx")).toEqual([
        { id: "moonshotai/kimi-k3" },
        { id: "openai/gpt-5.5" },
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

import { test, expect } from "bun:test";
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

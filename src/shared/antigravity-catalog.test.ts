import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  antigravitySpecKeyFor,
  antigravityVariantOf,
  normalizeAntigravityDiscovered,
  parseAntigravityModelList,
} from "./antigravity-catalog.ts";
import { buildModelOptions, effortOptionsFor, knownModelIds } from "./model-catalog.ts";
import { ANTIGRAVITY_MODEL_SPECS, antigravityModelArg } from "./types.ts";

const FIXTURE = readFileSync(
  new URL("../bun/fixtures/model-discovery/antigravity-models-1.5.18.txt", import.meta.url),
  "utf8",
);

describe("parseAntigravityModelList on the live agy 1.5.18 fixture", () => {
  const rows = parseAntigravityModelList(FIXTURE);
  const byId = new Map(rows.map((r) => [r.id, r] as const));

  test("groups the 27 flat rows into 11 unique base rows in first-seen CLI order", () => {
    expect(rows.map((r) => r.id)).toEqual([
      "gemini-4-neon",
      "gemini-4-carbon",
      "gemini-4-argon",
      "gemini-4-hydrogen",
      "gemini-pro-orchestrator-neon",
      "gemini-pro-orchestrator",
      "gemini-pro-orchestrator-argon",
      "gemini-3.8-flash",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "gpt-oss-120b",
    ]);
    const labels = rows.map((r) => r.label).filter((l): l is string => Boolean(l));
    expect(new Set(labels.map((l) => l.toLowerCase())).size).toBe(labels.length);
  });

  test("strips parenthesized effort suffixes from grouped labels while keeping non-effort labels intact", () => {
    expect(byId.get("gemini-4-neon")?.label).toBe("Gemini 4 Neon");
    expect(byId.get("gemini-4-hydrogen")?.label).toBe("Gemini 4 Hydrogen");
    expect(byId.get("gemini-3.8-flash")?.label).toBe("Gemini 3.8 Flash");
    expect(byId.get("claude-opus-5-5")?.label).toBe("Claude Opus 5.5");
    expect(byId.get("gpt-oss-120b")?.label).toBe("GPT-OSS 120B");
    expect(byId.get("gemini-pro-orchestrator-neon")?.label).toBe("Orchestrator (Neon)");
    expect(byId.get("gemini-pro-orchestrator")?.label).toBe("Orchestrator (Carbon)");
    expect(byId.get("gemini-pro-orchestrator-argon")?.label).toBe("Orchestrator (Argon)");
  });

  test("attaches discovered efforts and effortIds to every effort-bearing family and omits them on effort-less rows", () => {
    expect(byId.get("gemini-4-neon")?.efforts).toEqual(["high", "xhigh", "medium", "low"]);
    expect(byId.get("gemini-4-neon")?.antigravity?.effortIds).toEqual({
      high: "gemini-4-neon-high",
      xhigh: "gemini-4-neon-xhigh",
      medium: "gemini-4-neon-medium",
      low: "gemini-4-neon-low",
    });
    expect(byId.get("gpt-oss-120b")?.efforts).toEqual(["medium"]);
    expect(byId.get("gpt-oss-120b")?.antigravity?.effortIds).toEqual({ medium: "gpt-oss-120b-medium" });
    for (const id of ["gemini-pro-orchestrator-neon", "gemini-pro-orchestrator", "gemini-pro-orchestrator-argon"]) {
      expect(byId.get(id)?.efforts).toBeUndefined();
      expect(byId.get(id)?.antigravity).toBeUndefined();
    }
  });

  test("merged picker rows expose canonical effort ladders and compose back to the exact CLI ids", () => {
    const merged = buildModelOptions("antigravity", { discovered: rows });
    expect(effortOptionsFor("antigravity", "gemini-4-neon", merged).map((e) => e.id)).toEqual([
      "xhigh", "high", "medium", "low",
    ]);
    expect(effortOptionsFor("antigravity", "gemini-4-carbon", merged).map((e) => e.id)).toEqual([
      "high", "medium", "low",
    ]);
    expect(effortOptionsFor("antigravity", "gpt-oss-120b", merged).map((e) => e.id)).toEqual(["medium"]);
    expect(effortOptionsFor("antigravity", "gemini-pro-orchestrator-neon", merged)).toEqual([]);

    for (const r of rows) {
      for (const [effort, flatId] of Object.entries(r.antigravity?.effortIds ?? {})) {
        expect(antigravityModelArg(r.id, effort, r.antigravity)).toBe(flatId!);
      }
    }
  });

  test("knownModelIds includes both grouped base ids and every flat CLI variant id", () => {
    const known = new Set(knownModelIds("antigravity", rows, null));
    expect(known.has("gemini-4-neon")).toBe(true);
    expect(known.has("gemini-4-neon-xhigh")).toBe(true);
    expect(known.has("gemini-pro-orchestrator-neon")).toBe(true);
    for (const spec of Object.values(ANTIGRAVITY_MODEL_SPECS)) {
      for (const flat of Object.values(spec.effortIds ?? {})) {
        expect(known.has(flat!)).toBe(true);
      }
    }
  });
});

describe("parseAntigravityModelList & normalizeAntigravityDiscovered edge cases", () => {
  test("handles carriage-return spinner frames on the first line without dropping the first model", () => {
    const stdout = [
      "\r\x1B[36m⠋ Fetching available models...\x1B[0m\r\x1B[36m⠙ Fetching available models...\x1B[0m\rgemini-4-neon-high\tGemini 4 Neon (High)",
      "gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)",
    ].join("\n");
    const rows = parseAntigravityModelList(stdout);
    expect(rows).toEqual([
      {
        id: "gemini-4-neon",
        label: "Gemini 4 Neon",
        efforts: ["high", "xhigh"],
        antigravity: {
          effortIds: {
            high: "gemini-4-neon-high",
            xhigh: "gemini-4-neon-xhigh",
          },
        },
      },
    ]);
  });

  test("normalizes legacy flat cached DiscoveredModel rows idempotently", () => {
    const legacyFlat = [
      { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" },
      { id: "gemini-4-neon-low", label: "Gemini 4 Neon (Low)" },
      { id: "gemini-pro-orchestrator", label: "Orchestrator (Carbon)" },
    ];
    const once = normalizeAntigravityDiscovered(legacyFlat);
    const twice = normalizeAntigravityDiscovered(once);
    expect(once).toEqual(twice);
    expect(once).toEqual([
      {
        id: "gemini-4-neon",
        label: "Gemini 4 Neon",
        efforts: ["high", "low"],
        antigravity: { effortIds: { high: "gemini-4-neon-high", low: "gemini-4-neon-low" } },
      },
      { id: "gemini-pro-orchestrator", label: "Orchestrator (Carbon)" },
    ]);
  });

  test("antigravityVariantOf and buildModelOptions give a legacy selected flat variant an honest hint", () => {
    const rows = parseAntigravityModelList(FIXTURE);
    expect(antigravityVariantOf("gemini-4-neon-xhigh", rows)).toEqual({
      base: "gemini-4-neon",
      effort: "xhigh",
      label: "Gemini 4 Neon",
    });
    expect(antigravityVariantOf("gemini-4-argon-high", [])).toEqual({
      base: "gemini-4-argon",
      effort: "high",
      label: "Gemini 4 Argon",
    });
    expect(antigravitySpecKeyFor("gemini-3.8-flash-low")).toBe("gemini-3.8-flash");
    expect(antigravityVariantOf("gemini-pro-orchestrator-neon", rows)).toBeNull();

    const merged = buildModelOptions("antigravity", { discovered: rows, selected: "gemini-4-neon-xhigh" });
    const unlisted = merged.find((r) => r.id === "gemini-4-neon-xhigh");
    expect(unlisted?.unlisted).toBe(true);
    expect(unlisted?.label).toBe("Gemini 4 Neon Extra high");
    expect(unlisted?.hint).toContain("pick the base model to change its effort");
  });

  test("a newly discovered effort on a curated base (e.g. xhigh on Argon) surfaces in the picker and resolves at spawn", () => {
    const discovered = parseAntigravityModelList(
      "gemini-4-argon-xhigh\tGemini 4 Argon (XHigh)\ngemini-4-argon-high\tGemini 4 Argon (High)\n",
    );
    const merged = buildModelOptions("antigravity", { discovered });
    expect(effortOptionsFor("antigravity", "gemini-4-argon", merged).map((e) => e.id)).toEqual(["xhigh", "high"]);
    expect(antigravityModelArg("gemini-4-argon", "xhigh", discovered[0]?.antigravity)).toBe("gemini-4-argon-xhigh");
  });
});

import { test, expect, describe } from "bun:test";
import {
  AGENT_OPTIONS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORT_OPTIONS,
  cursorModelArg,
  cursorModelIdCoveredByCatalog,
  cursorModelSupportsFast,
  cursorModelSupportsMaxMode,
  retainableEfforts,
  supportedEfforts,
  supportedModes,
} from "../shared/types.ts";

test("claude opus-5 supports xhigh + max", () => {
  const ids = supportedEfforts("claude-code", "opus-5").map((o) => o.id);
  expect(ids).toContain("max");
  expect(ids).toContain("xhigh");
  expect(ids).toContain("high");
  expect(ids).toContain("medium");
  expect(ids).toContain("low");
});

test("claude opus-4.8 supports xhigh + max", () => {
  const ids = supportedEfforts("claude-code", "opus-4.8").map((o) => o.id);
  expect(ids).toContain("max");
  expect(ids).toContain("xhigh");
  expect(ids).toContain("high");
  expect(ids).toContain("medium");
  expect(ids).toContain("low");
});

test("claude opus-4.7 supports xhigh + max", () => {
  const ids = supportedEfforts("claude-code", "opus-4.7").map((o) => o.id);
  expect(ids).toContain("max");
  expect(ids).toContain("xhigh");
  expect(ids).toContain("high");
  expect(ids).toContain("medium");
  expect(ids).toContain("low");
});

test("claude sonnet-4.6 supports max but not xhigh (per API docs)", () => {
  const ids = supportedEfforts("claude-code", "sonnet-4.6").map((o) => o.id);
  expect(ids).toContain("max");
  expect(ids).toContain("high");
  expect(ids).toContain("medium");
  expect(ids).toContain("low");
  expect(ids).not.toContain("xhigh");
});

test("claude sonnet-5 supports xhigh + max (first Sonnet tier with xhigh)", () => {
  const ids = supportedEfforts("claude-code", "sonnet-5").map((o) => o.id);
  expect(ids).toContain("max");
  expect(ids).toContain("xhigh");
  expect(ids).toContain("high");
  expect(ids).toContain("medium");
  expect(ids).toContain("low");
});

test("claude haiku-4.5 exposes no effort options (CLI doesn't accept the flag)", () => {
  const ids = supportedEfforts("claude-code", "haiku-4.5").map((o) => o.id);
  expect(ids).toEqual([]);
});

test("claude null model falls back to DEFAULT_MODEL support set (opus-5)", () => {
  // No model specified → use the agent's default model's support set. Since
  // claude-code's DEFAULT_MODEL is opus-5, xhigh + max are both available.
  expect(DEFAULT_MODEL["claude-code"]).toBe("opus-5");
  const ids = supportedEfforts("claude-code", null).map((o) => o.id);
  expect(ids).toContain("xhigh");
  expect(ids).toContain("max");
  expect(ids).toContain("high");
});

test("claude fable-5 supports xhigh + max", () => {
  const ids = supportedEfforts("claude-code", "fable-5").map((o) => o.id);
  expect(ids).toContain("xhigh");
  expect(ids).toContain("max");
});

test("claude mythos-5 supports xhigh + max", () => {
  const ids = supportedEfforts("claude-code", "mythos-5").map((o) => o.id);
  expect(ids).toContain("xhigh");
  expect(ids).toContain("max");
});

test("claude fable-5.1 supports xhigh + max", () => {
  const ids = supportedEfforts("claude-code", "fable-5.1").map((o) => o.id);
  expect(ids).toContain("xhigh");
  expect(ids).toContain("max");
});

test("claude mythos-5.1 supports xhigh + max", () => {
  const ids = supportedEfforts("claude-code", "mythos-5.1").map((o) => o.id);
  expect(ids).toContain("xhigh");
  expect(ids).toContain("max");
});

test("codex DEFAULT_MODEL is GPT-6 Astra", () => {
  expect(DEFAULT_MODEL.codex).toBe("gpt-6-astra");
});

test("codex DEFAULT_EFFORT is high (ultra deliberately not the default)", () => {
  expect(DEFAULT_EFFORT.codex).toBe("high");
});

test("codex GPT-6 Astra + Aeon support ultra through low, no none", () => {
  for (const model of ["gpt-6-astra", "gpt-6-astra-aeon"]) {
    const ids = supportedEfforts("codex", model).map((o) => o.id);
    expect(ids).toEqual(["ultra", "max", "xhigh", "high", "medium", "low"]);
  }
});

test("codex GPT-5.6 Cyber/Sol/Terra support ultra through none", () => {
  for (const model of ["gpt-5.6-cyber", "gpt-5.6-sol", "gpt-5.6-terra"]) {
    const ids = supportedEfforts("codex", model).map((o) => o.id);
    expect(ids).toEqual(["ultra", "max", "xhigh", "high", "medium", "low", "none"]);
  }
});

test("codex GPT-5.6 Luna supports max through none, no ultra (catalog doesn't offer it there)", () => {
  const ids = supportedEfforts("codex", "gpt-5.6-luna").map((o) => o.id);
  expect(ids).toEqual(["max", "xhigh", "high", "medium", "low", "none"]);
});

test("codex model picker orders Astra, Aeon, Cyber, Sol, Terra, Luna first", () => {
  const ids = AGENT_OPTIONS.codex.models.map((m) => m.id);
  expect(ids.slice(0, 6)).toEqual([
    "gpt-6-astra",
    "gpt-6-astra-aeon",
    "gpt-5.6-cyber",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);
});

test("codex gpt-5.5 supports xhigh through none, no max/ultra", () => {
  const ids = supportedEfforts("codex", "gpt-5.5").map((o) => o.id);
  expect(ids).toEqual(["xhigh", "high", "medium", "low", "none"]);
});

test("codex gpt-5 / gpt-5-codex support xhigh through low, no max/ultra/none (unchanged)", () => {
  for (const model of ["gpt-5", "gpt-5-codex"]) {
    const ids = supportedEfforts("codex", model).map((o) => o.id);
    expect(ids).toEqual(["xhigh", "high", "medium", "low"]);
  }
});

test("unknown model falls back to the agent's DEFAULT_MODEL support set (Astra's)", () => {
  // codex's default is now gpt-6-astra, so pasted future ids inherit its
  // range — ultra through low, no none (Astra doesn't offer none).
  const ids = supportedEfforts("codex", "future-codex-9000").map((o) => o.id);
  expect(ids).toEqual(["ultra", "max", "xhigh", "high", "medium", "low"]);
});

test("ordered highest → lowest (no placeholder at the top)", () => {
  const ids = supportedEfforts("claude-code", "opus-4.7").map((o) => o.id);
  expect(ids[0]).toBe("max");
  const expectedOrder = ["max", "xhigh", "high", "medium", "low"];
  const filteredExpected = expectedOrder.filter((id) => ids.includes(id));
  expect(ids).toEqual(filteredExpected);
});

test("EFFORT_OPTIONS lists ultra first (Codex's top tier)", () => {
  expect(EFFORT_OPTIONS[0]?.id).toBe("ultra");
});

test("ultra is Codex-only — never offered on claude-code, cursor, gemini, or fx", () => {
  // Confirm these are real, currently-supported model ids (not vacuously
  // true because the id doesn't exist in the table at all).
  expect(AGENT_OPTIONS["claude-code"].models.map((m) => m.id)).toContain("opus-5");
  expect(AGENT_OPTIONS.cursor.models.map((m) => m.id)).toContain("cursor-grok-4.6");

  expect(supportedEfforts("claude-code", "opus-5").map((o) => o.id)).not.toContain("ultra");
  expect(supportedEfforts("cursor", "cursor-grok-4.6").map((o) => o.id)).not.toContain("ultra");
  for (const model of AGENT_OPTIONS.gemini.models) {
    expect(supportedEfforts("gemini", model.id).map((o) => o.id)).not.toContain("ultra");
  }
  for (const model of AGENT_OPTIONS.fx.models) {
    expect(supportedEfforts("fx", model.id).map((o) => o.id)).not.toContain("ultra");
  }
});

describe("supportedEfforts with discovered efforts", () => {
  test("a non-empty discovered list wins outright, returned in canonical order", () => {
    const ids = supportedEfforts("codex", "gpt-6-astra", ["low", "high"]).map((o) => o.id);
    expect(ids).toEqual(["high", "low"]);
  });

  test("discovered ids unknown to agetor fall back to the curated table", () => {
    const withUnknownDiscovery = supportedEfforts("codex", "gpt-6-astra", ["turbo"]).map((o) => o.id);
    const curated = supportedEfforts("codex", "gpt-6-astra").map((o) => o.id);
    expect(withUnknownDiscovery).toEqual(curated);
  });

  test("null / undefined / empty discovered efforts behave exactly like the two-arg call", () => {
    const curated = supportedEfforts("codex", "gpt-5.6-sol").map((o) => o.id);
    expect(supportedEfforts("codex", "gpt-5.6-sol", null).map((o) => o.id)).toEqual(curated);
    expect(supportedEfforts("codex", "gpt-5.6-sol", undefined).map((o) => o.id)).toEqual(curated);
    expect(supportedEfforts("codex", "gpt-5.6-sol", []).map((o) => o.id)).toEqual(curated);
  });

  test("a discovered set can add none to Astra even though the curated table lacks it", () => {
    const ids = supportedEfforts("codex", "gpt-6-astra", [
      "ultra", "max", "xhigh", "high", "medium", "low", "none",
    ]).map((o) => o.id);
    expect(ids).toContain("none");
  });

  test("a discovered set can drop none from Sol even though the curated table has it", () => {
    const ids = supportedEfforts("codex", "gpt-5.6-sol", [
      "ultra", "max", "xhigh", "high", "medium", "low",
    ]).map((o) => o.id);
    expect(ids).toEqual(["ultra", "max", "xhigh", "high", "medium", "low"]);
    expect(ids).not.toContain("none");
  });

  test("discovered efforts on an unknown codex id win over the default-model fallback", () => {
    const ids = supportedEfforts("codex", "gpt-9-test", ["low", "medium"]).map((o) => o.id);
    expect(ids).toEqual(["medium", "low"]);
  });

  test("a non-codex kind with a discovered list also honours it (the function is kind-agnostic)", () => {
    const ids = supportedEfforts("claude-code", "opus-5", ["low", "medium"]).map((o) => o.id);
    expect(ids).toEqual(["medium", "low"]);
  });
});

describe("retainableEfforts", () => {
  test("union: Sol + discovered without none still retains none", () => {
    const retained = retainableEfforts("codex", "gpt-5.6-sol", [
      "ultra", "max", "xhigh", "high", "medium", "low",
    ]);
    // The offered (discovered-wins) picker set drops none...
    expect(
      supportedEfforts("codex", "gpt-5.6-sol", ["ultra", "max", "xhigh", "high", "medium", "low"]).map((o) => o.id),
    ).not.toContain("none");
    // ...but the retainable union still keeps it, from the curated side.
    expect(retained.has("none")).toBe(true);
  });

  test("union: Astra + discovered with none retains none even though curated lacks it", () => {
    const retained = retainableEfforts("codex", "gpt-6-astra", [
      "ultra", "max", "xhigh", "high", "medium", "low", "none",
    ]);
    expect(retained.has("none")).toBe(true);
  });

  test("null discovered equals the curated ids", () => {
    const retained = retainableEfforts("codex", "gpt-5.6-sol", null);
    const curated = new Set(supportedEfforts("codex", "gpt-5.6-sol").map((o) => o.id));
    expect(retained).toEqual(curated);
  });

  test("unknown codex id includes both the discovered ids and Astra's fallback set", () => {
    const retained = retainableEfforts("codex", "gpt-9-test", ["low", "none"]);
    // Astra's curated fallback set (gpt-9-test is unknown to MODEL_EFFORT_SUPPORT).
    for (const id of ["ultra", "max", "xhigh", "high", "medium", "low"]) {
      expect(retained.has(id)).toBe(true);
    }
    // "none" isn't in Astra's curated set — it's retained only because the
    // discovered list carried it.
    expect(retained.has("none")).toBe(true);
  });
});

// --- gemini: no per-invocation effort flag -------------------------------------

test("gemini gemini-3.7-flash exposes no effort options (no effort flag on the CLI)", () => {
  const ids = supportedEfforts("gemini", "gemini-3.7-flash").map((o) => o.id);
  expect(ids).toEqual([]);
});

// --- cursor: model thinking modes + fast variants -----------------------------

test("cursor DEFAULT_MODEL is Grok 4.6 (explicit flagship pin, not cursor-agent's 'auto')", () => {
  expect(DEFAULT_MODEL.cursor).toBe("cursor-grok-4.6");
});

test("cursor DEFAULT_EFFORT is high for parameterized non-Auto models", () => {
  expect(DEFAULT_EFFORT.cursor).toBe("high");
});

test("cursor model catalog includes the screenshot/default surface", () => {
  const ids = AGENT_OPTIONS.cursor.models.map((m) => m.id);
  // The recommended default tops the list (same convention as codex/gemini).
  expect(ids[0]).toBe("cursor-grok-4.6");
  expect(ids).toContain("auto");
  expect(ids).toContain("gpt-5.3-codex");
  expect(ids).toContain("cursor-grok-4.5");
  expect(ids).toContain("composer-2.5");
  expect(ids).toContain("claude-opus-5");
  expect(ids).toContain("claude-opus-4-7");
  expect(ids).toContain("gpt-5.6-sol");
  expect(ids).toContain("gpt-5.6-terra");
  expect(ids).toContain("gemini-3.1-pro");
  expect(ids).toContain("glm-5.2");
});

test("cursor Auto model reports zero efforts", () => {
  expect(supportedEfforts("cursor", "auto")).toEqual([]);
});

test("cursor null model resolves to the Grok 4.6 default effort surface", () => {
  expect(supportedEfforts("cursor", null).map((o) => o.id)).toEqual(["xhigh", "high", "medium", "low"]);
});

test("cursor Grok 4.6 exposes Extra High but no Max (ids verified via `cursor-agent models`)", () => {
  const ids = supportedEfforts("cursor", "cursor-grok-4.6").map((o) => o.id);
  expect(ids).toEqual(["xhigh", "high", "medium", "low"]);
  expect(cursorModelSupportsMaxMode("cursor-grok-4.6")).toBe(false);
});

test("cursor Opus 4.8 and GPT-5.6 Sol expose Max", () => {
  expect(supportedEfforts("cursor", "claude-opus-4-8").map((o) => o.id)).toContain("max");
  expect(supportedEfforts("cursor", "gpt-5.6-sol").map((o) => o.id)).toContain("max");
});

test("cursor GPT-5.4 exposes Extra High but not Max", () => {
  const ids = supportedEfforts("cursor", "gpt-5.4").map((o) => o.id);
  expect(ids).toContain("xhigh");
  expect(ids).not.toContain("max");
});

test("cursor Gemini 3.6 Flash exposes Minimal", () => {
  expect(supportedEfforts("cursor", "gemini-3.6-flash").map((o) => o.id)).toContain("minimal");
});

test("cursor unknown model id reports zero efforts (effort rides in the id, so a pick would be inert)", () => {
  expect(supportedEfforts("cursor", "cursor-mystery-9000")).toEqual([]);
});

test("cursor fast support is model and effort specific", () => {
  expect(cursorModelSupportsFast("gpt-5.6-sol", "max")).toBe(true);
  expect(cursorModelSupportsFast("gpt-5.4", "low")).toBe(false);
  expect(cursorModelSupportsFast("composer-2.5", null)).toBe(true);
  expect(cursorModelSupportsFast("claude-sonnet-5", "max")).toBe(false);
});

test("cursor Max Mode support is a context-level model capability", () => {
  expect(cursorModelSupportsMaxMode("gpt-5.6-sol")).toBe(true);
  expect(cursorModelSupportsMaxMode("claude-opus-4-8")).toBe(true);
  expect(cursorModelSupportsMaxMode("claude-opus-4-7")).toBe(true);
  expect(cursorModelSupportsMaxMode("composer-2.5")).toBe(false);
  expect(cursorModelSupportsMaxMode("auto")).toBe(false);
});

test("cursorModelArg composes known model, effort, and fast variants", () => {
  expect(cursorModelArg("gpt-5.5", "xhigh", false)).toBe("gpt-5.5-extra-high");
  expect(cursorModelArg("gpt-5.5", "xhigh", true)).toBe("gpt-5.5-extra-high-fast");
  expect(cursorModelArg("composer-2.5", null, true)).toBe("composer-2.5-fast");
  expect(cursorModelArg("gpt-5.6-sol", "high", true, true)).toBe("gpt-5.6-sol[context=1m,effort=high,fast=true]");
  expect(cursorModelArg("gpt-5.6-sol", "high", false, true)).toBe("gpt-5.6-sol[context=1m,effort=high,fast=false]");
  expect(cursorModelArg("unknown-model", "max", true)).toBe("unknown-model");
  // Grok 4.6: DEFAULT_EFFORT ("high") fills a null effort; fast suffixes apply
  // across the whole ladder; no Max-Mode bracket syntax (no 1M variant).
  expect(cursorModelArg("cursor-grok-4.6", null, false)).toBe("cursor-grok-4.6-high");
  expect(cursorModelArg("cursor-grok-4.6", "xhigh", true)).toBe("cursor-grok-4.6-xhigh-fast");
  expect(cursorModelArg("cursor-grok-4.6", "low", false)).toBe("cursor-grok-4.6-low");
});

test("cursor Fable 5.1 exposes the full max/xhigh/high/medium/low ladder", () => {
  const ids = supportedEfforts("cursor", "claude-fable-5-1").map((o) => o.id);
  expect(ids).toEqual(["max", "xhigh", "high", "medium", "low"]);
});

test("cursorModelArg composes Fable 5.1 efforts with no -fast variant (catalog has none)", () => {
  expect(cursorModelArg("claude-fable-5-1", "xhigh", false)).toBe("claude-fable-5-1-xhigh");
  // fast never composes for this model — no fastEfforts entry in the catalog.
  expect(cursorModelArg("claude-fable-5-1", "high", true)).toBe("claude-fable-5-1-high");
  expect(cursorModelSupportsFast("claude-fable-5-1", "high")).toBe(false);
  // Max-Mode bracket syntax omits `fast=` since fastEfforts is absent.
  expect(cursorModelArg("claude-fable-5-1", "xhigh", false, true)).toBe("claude-fable-5-1[context=1m,effort=xhigh]");
});

test("cursorModelIdCoveredByCatalog recognizes a Fable 5.1 effort variant", () => {
  expect(cursorModelIdCoveredByCatalog("claude-fable-5-1-high")).toBe(true);
});

test("cursor supportedModes returns the auto/ask pair (no per-model mode carve-outs)", () => {
  const ids = supportedModes("cursor", null).map((o) => o.id);
  expect(ids).toEqual(["auto", "ask"]);
});

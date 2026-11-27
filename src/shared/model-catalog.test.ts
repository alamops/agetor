import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { __testing } from "../bun/agent-discovery.ts";
import { parseClaudeInitModels } from "../bun/discovery/claude-probe.ts";
import { parseCopilotSessionNew } from "../bun/discovery/copilot-acp-probe.ts";
import { parseGeminiModelsJson } from "../bun/discovery/gemini-probe.ts";
import {
  CLI_AUTHORITATIVE_CATALOG_KINDS,
  buildModelOptions,
  effortOptionsFor,
  knownModelIds,
  modelCatalogVerdict,
  resolveDefaultEffort,
  resolveDefaultModel,
  resolveSeedModel,
  seedModelStep,
  retainableEffortsFor,
  speedOptionsFor,
  speedTiersKnown,
} from "./model-catalog.ts";
import type { DiscoveredModel } from "./model-options.ts";
import { AGENT_OPTIONS, DEFAULT_EFFORT, DEFAULT_MODEL, type AgentKind } from "./types.ts";

const FIX = new URL("../bun/fixtures/model-discovery/", import.meta.url);
const text = (n: string) => readFileSync(new URL(n, FIX), "utf8");

const claude = parseClaudeInitModels(JSON.parse(text("claude-init-2.1.326.json")));
const codex = __testing.parseCodexModelList(JSON.parse(text("codex-model-list-0.166.0.json")));
const cursor = __testing.parseCursorModels(text("cursor-models-2026.10.22.txt"));
const gemini = parseGeminiModelsJson(text("gemini-models.json"));
const antigravity = __testing.parseAntigravityModels(text("antigravity-models-1.5.18.txt"));
const copilotAcp = parseCopilotSessionNew(JSON.parse(text("copilot-acp-session-new.json")));
const copilotHelp = __testing.parseCopilotModels(`  \`model\`: m\n    - "claude-opus-5.5"\n    - "gpt-6.1-sol"\n    - "kimi-k3"\n`);

const CATALOGS: Record<string, { kind: AgentKind; rows: DiscoveredModel[] }> = {
  claude: { kind: "claude-code", rows: claude },
  codex: { kind: "codex", rows: codex },
  cursor: { kind: "cursor", rows: cursor },
  gemini: { kind: "gemini", rows: gemini },
  antigravity: { kind: "antigravity", rows: antigravity },
  copilotAcp: { kind: "copilot", rows: copilotAcp },
  copilotHelp: { kind: "copilot", rows: copilotHelp },
};

describe("C3: no duplicate rows for any kind's fixture", () => {
  for (const [name, { kind, rows }] of Object.entries(CATALOGS)) {
    test(`${name}: unique ids and unique labels, discovery trusted`, () => {
      expect(rows.length).toBeGreaterThan(0);
      const merged = buildModelOptions(kind, { discovered: rows });
      const ids = merged.map((r) => r.id);
      expect(new Set(ids).size, "duplicate ids").toBe(ids.length);
      const labels = merged.map((r) => r.label.toLowerCase());
      const dup = labels.filter((l, i) => labels.indexOf(l) !== i);
      expect(dup, "duplicate labels").toEqual([]);
    });
  }

  test("claude: the 13 CLI rows come first in CLI order, curated-only rows (Mythos) follow", () => {
    const merged = buildModelOptions("claude-code", { discovered: claude });
    expect(merged.slice(0, 13).map((r) => r.id)).toEqual(claude.map((r) => r.id));
    expect(merged.slice(13).map((r) => r.id)).toEqual(
      AGENT_OPTIONS["claude-code"].models.map((m) => m.id).filter((id) => !claude.some((c) => c.id === id)),
    );
    expect(merged.map((r) => r.id)).toContain("mythos-5.2");
  });

  test("copilot: the pinned Auto row is first with ACP or help-config discovery", () => {
    for (const rows of [copilotAcp, copilotHelp]) {
      expect(buildModelOptions("copilot", { discovered: rows })[0]?.id).toBe("auto");
    }
    expect(buildModelOptions("copilot", { discovered: [] })[0]?.id).toBe("auto");
  });

  test("empty and logged-out discovery is exactly the curated picker", () => {
    for (const kind of ["claude-code", "codex", "cursor", "gemini", "copilot"] as const) {
      const curated = AGENT_OPTIONS[kind].models.filter((m) => !m.catalogOnly).map((m) => m.id);
      const noDiscovery = buildModelOptions(kind, { discovered: [] }).map((r) => r.id);
      expect(noDiscovery.slice().sort()).toEqual(curated.slice().sort());
      const loggedOut = buildModelOptions(kind, { discovered: CATALOGS.claude?.rows ?? [], loggedIn: false }).map((r) => r.id);
      expect(loggedOut.slice().sort()).toEqual(curated.slice().sort());
    }
  });
});

describe("a trusted codex/copilot catalog is authoritative for the picker (review M1)", () => {
  const authoritative = [
    ["codex", "codex", codex],
    ["copilot ACP", "copilot", copilotAcp],
    ["copilot help config", "copilot", copilotHelp],
  ] as const;

  for (const [name, kind, rows] of authoritative) {
    test(`${name}: no listed picker row is one pre-flight refuses`, () => {
      const merged = buildModelOptions(kind, { discovered: rows });
      expect(merged.length).toBeGreaterThan(0);
      for (const row of merged.filter((r) => !r.unlisted)) {
        expect(modelCatalogVerdict(kind, row.id, rows, null), row.id).not.toBe("missing");
      }
      // The curated rows the CLI lacks are gone; the CLI's own rows all stay.
      const curatedOnly = AGENT_OPTIONS[kind].models.filter((m) => !m.pinned && !rows.some((r) => r.id === m.id));
      for (const m of curatedOnly) expect(merged.map((r) => r.id), m.id).not.toContain(m.id);
      for (const r of rows) expect(merged.map((x) => x.id)).toContain(r.id);
    });
  }

  test("a stored curated-only model stays representable as an unlisted row with an honest hint", () => {
    const gone = AGENT_OPTIONS.codex.models.find((m) => !codex.some((r) => r.id === m.id));
    expect(gone, "the codex fixture lacks a curated model").toBeDefined();
    const merged = buildModelOptions("codex", { discovered: codex, selected: gone?.id ?? null });
    const row = merged.find((r) => r.id === gone?.id);
    expect(row).toMatchObject({ unlisted: true });
    expect(row?.hint).toContain("model list");
    expect(merged.filter((r) => r.id === gone?.id)).toHaveLength(1);
  });

  test("copilot's pinned Auto stays offered", () => {
    expect(buildModelOptions("copilot", { discovered: copilotAcp }).map((r) => r.id)).toContain("auto");
  });

  test("an untrusted catalog (logged out, empty) still shows every curated row", () => {
    const curated = AGENT_OPTIONS.codex.models.filter((m) => !m.catalogOnly).map((m) => m.id).sort();
    expect(buildModelOptions("codex", { discovered: codex, loggedIn: false }).map((r) => r.id).sort()).toEqual(curated);
    expect(buildModelOptions("codex", { discovered: [] }).map((r) => r.id).sort()).toEqual(curated);
  });

  test("a remembered curated-only model is not a usable seed once the catalog lacks it", () => {
    const gone = AGENT_OPTIONS.codex.models.find((m) => !codex.some((r) => r.id === m.id))?.id ?? "";
    const rows = buildModelOptions("codex", { discovered: codex, selected: gone });
    expect(resolveSeedModel("codex", gone, rows)).toBeNull();
    const listed = codex[0]?.id ?? "";
    expect(resolveSeedModel("codex", listed, rows)).toBe(listed);
    // With no catalog the curated row is real again.
    expect(resolveSeedModel("codex", gone, buildModelOptions("codex", { discovered: [] }))).toBe(gone);
  });

  // The remembered-model step as the form sees it when preferences resolve
  // BEFORE the catalog (review S-A): codex/copilot apply the built-in model at
  // once but stay unconfirmed until a trusted catalog lists it.
  describe("seedModelStep (preferences before the catalog)", () => {
    const gone = AGENT_OPTIONS.codex.models.find((m) => !codex.some((r) => r.id === m.id))?.id ?? "";
    const listed = codex[0]?.id ?? "";

    test("no catalog yet: a built-in codex model applies but is not confirmed", () => {
      const rows = buildModelOptions("codex", { discovered: [] });
      expect(seedModelStep("codex", gone, rows, [], null)).toEqual({ action: "apply", model: gone, confirmed: false });
    });

    test("the trusted catalog then lacks it: the seed falls to the default", () => {
      const rows = buildModelOptions("codex", { discovered: codex, selected: gone });
      expect(seedModelStep("codex", gone, rows, codex, null)).toEqual({ action: "default" });
    });

    test("the trusted catalog lists it: confirmed", () => {
      const rows = buildModelOptions("codex", { discovered: codex, selected: listed });
      expect(seedModelStep("codex", listed, rows, codex, null)).toEqual({ action: "apply", model: listed, confirmed: true });
    });

    test("a logged-out harness keeps waiting on an id the curated rows lack, and never falls to the default", () => {
      const rows = buildModelOptions("codex", { discovered: codex, loggedIn: false });
      expect(seedModelStep("codex", "brand-new-model", rows, codex, false)).toEqual({ action: "wait" });
    });

    test("a kind with a non-authoritative catalog is confirmed by its curated row at once", () => {
      const curated = AGENT_OPTIONS["claude-code"].models[0]?.id ?? "";
      const rows = buildModelOptions("claude-code", { discovered: [] });
      expect(seedModelStep("claude-code", curated, rows, [], null)).toEqual({ action: "apply", model: curated, confirmed: true });
    });
  });
});

describe("C1: a brand-new CLI model needs no agetor change", () => {
  const withOpus6: DiscoveredModel[] = [
    { id: "opus-6", cliId: "claude-opus-6", label: "Opus 6", efforts: ["low", "turbo", "max"], fast: true },
    ...claude,
  ];
  test("it leads the picker with the CLI's own ladder, including the unknown effort", () => {
    const rows = buildModelOptions("claude-code", { discovered: withOpus6 });
    expect(rows[0]).toMatchObject({ id: "opus-6", label: "Opus 6" });
    const efforts = effortOptionsFor("claude-code", "opus-6", rows);
    expect(efforts.map((e) => e.id)).toEqual(["max", "turbo", "low"]);
    expect(efforts.find((e) => e.id === "turbo")?.label).toBe("Turbo");
    expect(speedOptionsFor("claude-code", "opus-6", "max", rows)).toEqual(["off", "fast"]);
  });
});

describe("effort and speed helpers", () => {
  test("retainable efforts union discovered and curated", () => {
    const rows = buildModelOptions("claude-code", { discovered: claude });
    expect(retainableEffortsFor("claude-code", "opus-4.6", rows).has("max")).toBe(true);
  });

  test("codex Fast comes from the discovered tier flag", () => {
    const rows = buildModelOptions("codex", { discovered: codex });
    expect(speedOptionsFor("codex", "gpt-6.2-sol", "high", rows)).toEqual(["off", "fast"]);
    expect(speedOptionsFor("codex", "gpt-6.2-sol", "high", [])).toEqual(["off"]);
  });

  test("a discovered-only cursor base offers Fast on the efforts that have a twin", () => {
    const rows = buildModelOptions("cursor", {
      discovered: __testing.parseCursorModels("gpt-7-low - GPT-7 Low\ngpt-7-high - GPT-7 High\ngpt-7-high-fast - GPT-7 High Fast"),
    });
    expect(speedOptionsFor("cursor", "gpt-7", "high", rows)).toEqual(["off", "fast"]);
    expect(speedOptionsFor("cursor", "gpt-7", "low", rows)).toEqual(["off"]);
    expect(effortOptionsFor("cursor", "gpt-7", rows).map((e) => e.id)).toEqual(["high", "low"]);
  });

  test("speedTiersKnown: cursor always, discovered kinds once a trusted catalog loaded", () => {
    expect(speedTiersKnown("cursor", [], null)).toBe(true);
    expect(speedTiersKnown("codex", [], null)).toBe(false);
    expect(speedTiersKnown("codex", codex, null)).toBe(true);
    expect(speedTiersKnown("codex", codex, false)).toBe(false);
    expect(speedTiersKnown("claude-code", claude, true)).toBe(true);
    expect(speedTiersKnown("gemini", gemini, true)).toBe(false);
  });
});

describe("defaults and seeds", () => {
  test("default model: the owner's pick unless a trusted catalog lacks it, then the CLI default", () => {
    expect(resolveDefaultModel("codex", [], null)).toBe(DEFAULT_MODEL.codex);
    expect(resolveDefaultModel("codex", [{ id: "other", cliDefault: true }], null)).toBe("other");
    expect(resolveDefaultModel("codex", [{ id: "other", cliDefault: true }], false)).toBe(DEFAULT_MODEL.codex);
    expect(resolveDefaultModel("codex", [{ id: DEFAULT_MODEL.codex }, { id: "other", cliDefault: true }], null)).toBe(DEFAULT_MODEL.codex);
    expect(resolveDefaultModel("codex", [{ id: "only" }], null)).toBe(DEFAULT_MODEL.codex);
  });

  test("default effort: owner pick when offered, then the CLI's, then the first, else null", () => {
    const rows = buildModelOptions("codex", { discovered: [{ id: "m", efforts: ["low", "medium"], defaultEffort: "medium" }] });
    expect(DEFAULT_EFFORT.codex).toBe("high");
    expect(resolveDefaultEffort("codex", "m", rows)).toBe("medium");
    const rows2 = buildModelOptions("codex", { discovered: [{ id: "m", efforts: ["low", "high"] }] });
    expect(resolveDefaultEffort("codex", "m", rows2)).toBe("high");
    const rows3 = buildModelOptions("codex", { discovered: [{ id: "m", efforts: ["low", "turbo"] }] });
    expect(resolveDefaultEffort("codex", "m", rows3)).toBe("low"); // first offered; the unknown id sorts last
    expect(resolveDefaultEffort("claude-code", "haiku-4.5", buildModelOptions("claude-code", { discovered: [] }))).toBeNull();
  });

  test("seed: a remembered id is kept when curated or in the loaded catalog; an unlisted placeholder is not a seed", () => {
    const rows = buildModelOptions("claude-code", { discovered: claude });
    expect(resolveSeedModel("claude-code", "opus-5.5", rows)).toBe("opus-5.5");
    expect(resolveSeedModel("claude-code", "opus-6", rows)).toBeNull();
    const withNew = buildModelOptions("claude-code", { discovered: [{ id: "opus-6" }, ...claude] });
    expect(resolveSeedModel("claude-code", "opus-6", withNew)).toBe("opus-6");
    const placeholder = buildModelOptions("claude-code", { discovered: [], selected: "opus-6" });
    expect(resolveSeedModel("claude-code", "opus-6", placeholder)).toBeNull();
    expect(resolveSeedModel("claude-code", null, rows)).toBeNull();
  });
});

describe("cursor variants (read-time normalization)", () => {
  const discovered = __testing.parseCursorModels("gpt-7-low - GPT-7 Low\ngpt-7-high - GPT-7 High\ngpt-7-high-fast - GPT-7 High Fast");
  test("a stored flat variant id becomes one unlisted row with the variant label and hint", () => {
    const rows = buildModelOptions("cursor", { discovered, selected: "gpt-7-high-fast" });
    const row = rows.find((r) => r.id === "gpt-7-high-fast");
    expect(row).toMatchObject({ unlisted: true, label: "GPT-7 High Fast" });
    expect(row?.hint).toContain("pick the base model");
  });

  test("knownModelIds includes every variant id, curated and discovered", () => {
    const ids = knownModelIds("cursor", discovered, null);
    for (const id of ["gpt-7", "gpt-7-low", "gpt-7-high", "gpt-7-high-fast", "grok-4.7-high", "grok-4.7-high-fast"]) {
      expect(ids, id).toContain(id);
    }
  });

  test("knownModelIds for other kinds is the merged picker ids", () => {
    expect(knownModelIds("opencode", [{ id: "a/b" }], null)).toContain("a/b");
    expect(knownModelIds("claude-code", claude, null)).toContain("opus-5.5");
  });
});

describe("modelCatalogVerdict", () => {
  test("only codex and copilot are CLI-authoritative", () => {
    expect([...CLI_AUTHORITATIVE_CATALOG_KINDS].sort()).toEqual(["codex", "copilot"]);
  });

  test("offered / missing / unknown matrix", () => {
    expect(modelCatalogVerdict("codex", "gpt-6.2-sol", codex, null)).toBe("offered");
    expect(modelCatalogVerdict("codex", "gpt-9", codex, null)).toBe("missing");
    expect(modelCatalogVerdict("codex", "gpt-9", [], null)).toBe("unknown");
    expect(modelCatalogVerdict("codex", "gpt-9", codex, false)).toBe("unknown");
    expect(modelCatalogVerdict("claude-code", "opus-9", claude, null)).toBe("unknown");
    expect(modelCatalogVerdict("gemini", "x", gemini, null)).toBe("unknown");
    expect(modelCatalogVerdict("copilot", "auto", copilotAcp, null)).toBe("offered");
    expect(modelCatalogVerdict("copilot", "auto", [], null)).toBe("offered");
    expect(modelCatalogVerdict("copilot", "claude-sonnet-4.5", copilotAcp, null)).toBe("offered");
    expect(modelCatalogVerdict("copilot", "kimi-k9", copilotAcp, null)).toBe("missing");
  });
});

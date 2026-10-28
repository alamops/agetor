import { expect, test } from "bun:test";
import { mergeModelOptions, type DiscoveredModel } from "./model-options.ts";
import { supportedSpeeds } from "./speed.ts";
import {
  AGENT_OPTIONS,
  CATALOG_SCOPED_KINDS,
  CURSOR_MODEL_SPECS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  cursorModelIdCoveredByCatalog,
  retainableEfforts,
  supportedEfforts,
} from "./types.ts";

/**
 * GPT-6.1 Terra and the eight other models added alongside it
 * (docs/plans/add-gpt-6-1-terra.md) through the real picker merge:
 * `mergeModelOptions` over the actual `AGENT_OPTIONS` rows, the way every
 * picker (New Task form, task details, `agetor add`, launch dialogs) calls
 * it. types.test.ts pins the catalog rows themselves; this file pins what a
 * user actually sees for each harness.
 */

const TERRA_CODEX = "gpt-6.1-terra";
const SOL_CODEX = "gpt-6.1-sol";

/** The six new fx rows that are `catalogOnly`: absent from the owner's
 *  signed-in catalog (plan §2b), so offered only when a catalog lists them. */
const NEW_FX_CATALOG_ONLY = [
  "openai/gpt-6.1-terra",
  "moonshotai/kimi-k3.1-pro",
  "deepseek/deepseek-v4.1-flash-1017",
  "meta/muse-wonder-1.0",
  "mistral/mistral-large-4",
  "reflection/beam",
];

/** The three new fx rows whose models the signed-in catalog does carry. */
const NEW_FX_STANDARD = ["minimax/minimax-m3.1-flash", "meta/muse-spark-open", "inception/mercury-3"];

function ids(rows: { id: string }[]): string[] {
  return rows.map((r) => r.id);
}

/** Precondition for the "hidden" cases: the id must be a curated catalogOnly
 *  row, so hiding is the gate's doing rather than the id simply not existing. */
function expectCuratedCatalogOnly(id: string): void {
  expect(AGENT_OPTIONS.fx.models.find((m) => m.id === id)?.catalogOnly, id).toBe(true);
}

function fxRows(opts: { discovered: DiscoveredModel[]; loggedIn?: boolean | null; selected?: string | null }) {
  return mergeModelOptions({
    curated: AGENT_OPTIONS.fx.models,
    discovered: opts.discovered,
    scoped: CATALOG_SCOPED_KINDS.has("fx"),
    selected: opts.selected ?? null,
    loggedIn: opts.loggedIn,
  });
}

// --- codex: not catalog-scoped, Terra listed right after 6.1 Sol ---------------

test("codex picker lists GPT-6.1 Terra directly after GPT-6.1 Sol when the discovered catalog has both", () => {
  expect(CATALOG_SCOPED_KINDS.has("codex")).toBe(false);
  const discovered: DiscoveredModel[] = [{ id: SOL_CODEX }, { id: TERRA_CODEX }];
  const rows = mergeModelOptions({ curated: AGENT_OPTIONS.codex.models, discovered, scoped: false, selected: null });
  const order = ids(rows);
  expect(order.indexOf(TERRA_CODEX)).toBe(order.indexOf(SOL_CODEX) + 1);
  const terra = rows.find((r) => r.id === TERRA_CODEX);
  expect(terra?.label).toBe("GPT-6.1 Terra");
  expect(terra?.unlisted).toBeUndefined();
  // Curated rows only: the discovered ids were both curated, nothing is appended.
  expect(rows.length).toBe(AGENT_OPTIONS.codex.models.length);
});

test("codex picker still shows GPT-6.1 Terra on the discovery-empty fallback (codex is not catalog-scoped)", () => {
  const rows = mergeModelOptions({ curated: AGENT_OPTIONS.codex.models, discovered: [], scoped: false, selected: null });
  const order = ids(rows);
  expect(order).toContain(TERRA_CODEX);
  expect(order.indexOf(TERRA_CODEX)).toBe(order.indexOf(SOL_CODEX) + 1);
});

test("codex: a task still pinned to retired gpt-5.5 shows it as an unlisted row (migration 075 normally rewrites it first; frozen snapshots keep it)", () => {
  expect(ids(AGENT_OPTIONS.codex.models)).not.toContain("gpt-5.5");
  const rows = mergeModelOptions({
    curated: AGENT_OPTIONS.codex.models,
    discovered: [],
    scoped: false,
    selected: "gpt-5.5",
  });
  const row = rows.find((r) => r.id === "gpt-5.5");
  expect(row).toBeDefined();
  expect(row?.unlisted).toBe(true);
});

// --- fx: six catalogOnly rows, three standard rows ---------------------------

test("fx picker shows each new catalogOnly row when the account's discovered catalog lists it", () => {
  for (const id of NEW_FX_CATALOG_ONLY) {
    const rows = fxRows({ discovered: [{ id: DEFAULT_MODEL.fx }, { id }] });
    const row = rows.find((r) => r.id === id);
    expect(row, id).toBeDefined();
    expect(row?.unlisted, id).toBeUndefined();
    // A curated label, not the bare id a discovered-only row would carry.
    expect(row?.label, id).not.toBe(id);
  }
});

test("fx picker hides each new catalogOnly row when discovery is empty (catalogOnly never shows on the fallback)", () => {
  const rows = fxRows({ discovered: [] });
  for (const id of NEW_FX_CATALOG_ONLY) {
    expectCuratedCatalogOnly(id);
    expect(ids(rows), id).not.toContain(id);
  }
  // The fallback still lists the default and the three standard rows.
  expect(ids(rows)).toContain(DEFAULT_MODEL.fx);
  for (const id of NEW_FX_STANDARD) expect(ids(rows), id).toContain(id);
});

test("fx picker hides each new catalogOnly row on a logged-out harness even when the (unauthenticated) catalog lists them", () => {
  const rows = fxRows({
    discovered: [{ id: DEFAULT_MODEL.fx }, ...NEW_FX_CATALOG_ONLY.map((id) => ({ id }))],
    loggedIn: false,
  });
  for (const id of NEW_FX_CATALOG_ONLY) {
    expectCuratedCatalogOnly(id);
    expect(ids(rows), id).not.toContain(id);
  }
});

test("fx: a signed-in-shaped catalog (default + the 3 new standard ids, none of the 6) shows the 3 standard rows and none of the 6", () => {
  const rows = fxRows({ discovered: [{ id: DEFAULT_MODEL.fx }, ...NEW_FX_STANDARD.map((id) => ({ id }))] });
  const order = ids(rows);
  for (const id of NEW_FX_STANDARD) {
    const row = rows.find((r) => r.id === id);
    expect(row, id).toBeDefined();
    expect(row?.unlisted, id).toBeUndefined();
    // Curated, not a bare discovered-only row labelled with its id.
    expect(row?.label, id).not.toBe(id);
    expect(AGENT_OPTIONS.fx.models.find((m) => m.id === id)?.catalogOnly, id).toBeFalsy();
  }
  for (const id of NEW_FX_CATALOG_ONLY) {
    expectCuratedCatalogOnly(id);
    expect(order, id).not.toContain(id);
  }
  // Exactly the default plus the three, nothing else.
  expect(order.length).toBe(1 + NEW_FX_STANDARD.length);
  expect(order[0]).toBe(DEFAULT_MODEL.fx);
});

test("fx: DeepSeek V4.1 Flash 1017 renders second, right under the default, when the catalog lists it", () => {
  const rows = fxRows({
    discovered: [{ id: DEFAULT_MODEL.fx }, { id: "deepseek/deepseek-v4.1-flash-1017" }, { id: "zai/glm-5.3-flash" }],
  });
  expect(ids(rows).slice(0, 3)).toEqual([DEFAULT_MODEL.fx, "deepseek/deepseek-v4.1-flash-1017", "zai/glm-5.3-flash"]);
  expect(rows[1]?.label).toBe("DeepSeek V4.1 Flash 1017");
});

test("fx: a task pinned to a catalogOnly new row keeps it visible as an unlisted row when the catalog drops it", () => {
  expectCuratedCatalogOnly("openai/gpt-6.1-terra");
  const rows = fxRows({ discovered: [{ id: DEFAULT_MODEL.fx }], selected: "openai/gpt-6.1-terra" });
  const row = rows.find((r) => r.id === "openai/gpt-6.1-terra");
  expect(row?.unlisted).toBe(true);
});

// --- cursor: three new families, variants are not picker rows -----------------

test("cursor picker offers one bare row per new family and no suffixed variant rows", () => {
  // `cursor-agent --list-models` lists the suffixed variants; every cursor
  // picker (NewTaskForm, TaskLaunchPickers, RunPanel, `agetor add`) drops the
  // ids the curated specs already cover from the discovered list before
  // merging (the filter is `cursorModelIdCoveredByCatalog`, applied by the
  // callers, not inside `mergeModelOptions`).
  const families: Record<string, string[]> = {
    "muse-wonder-1.0": ["max", "xhigh", "high", "medium", "low", "minimal"],
    "muse-spark-1.3": ["max", "xhigh", "high", "medium", "low", "minimal"],
    "deepseek-v41-flash-1017": ["max", "high", "medium", "low", "none"],
  };
  const raw: DiscoveredModel[] = [];
  for (const [base, tiers] of Object.entries(families)) {
    raw.push({ id: base });
    for (const tier of tiers) raw.push({ id: `${base}-${tier}` });
  }
  // 3 bases + 17 variants.
  expect(raw.length).toBe(3 + 17);
  const discovered = raw.filter((m) => !cursorModelIdCoveredByCatalog(m.id));
  expect(discovered).toEqual([]);

  const rows = mergeModelOptions({ curated: AGENT_OPTIONS.cursor.models, discovered, scoped: false, selected: null });
  for (const base of Object.keys(families)) {
    expect(ids(rows).filter((id) => id.startsWith(base)), base).toEqual([base]);
  }
});

// --- efforts and speed tiers as the pickers offer them -------------------------

/** What codex's own `model/list` reports for GPT-6.1 Terra (plan §1.2): low
 *  through max plus ultra, without `none`, which the API accepts anyway. */
const CODEX_CATALOG_TERRA_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
/** And for GPT-6.1 Sol, which rejects `none` with a live 400. */
const CODEX_CATALOG_SOL_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

test("codex GPT-6.1 Terra: the live effort picker follows codex's catalog (ultra…low), the discovery-empty fallback adds none", () => {
  const live = supportedEfforts("codex", TERRA_CODEX, CODEX_CATALOG_TERRA_EFFORTS).map((o) => o.id);
  expect(live).toEqual(["ultra", "max", "xhigh", "high", "medium", "low"]);
  const fallback = supportedEfforts("codex", TERRA_CODEX, []).map((o) => o.id);
  expect(fallback).toEqual(["ultra", "max", "xhigh", "high", "medium", "low", "none"]);
  // The kind default effort is offered either way, so a new Terra task starts at it.
  expect(live).toContain(DEFAULT_EFFORT.codex);
  expect(fallback).toContain(DEFAULT_EFFORT.codex);
});

test("codex GPT-6.1 Terra: a task already on effort none keeps it when codex's catalog omits none; GPT-6.1 Sol does not", () => {
  // `retainableEfforts` decides whether a model change cascades the stored
  // effort: Terra keeps a `none` the curated table offers, Sol (no `none`
  // anywhere) forces a fallback.
  expect(retainableEfforts("codex", TERRA_CODEX, CODEX_CATALOG_TERRA_EFFORTS).has("none")).toBe(true);
  expect(retainableEfforts("codex", SOL_CODEX, CODEX_CATALOG_SOL_EFFORTS).has("none")).toBe(false);
  expect(retainableEfforts("codex", SOL_CODEX, []).has("none")).toBe(false);
});

test("codex: the retired gpt-5.5 has no effort set of its own, so it falls back to the default model's set", () => {
  const retired = supportedEfforts("codex", "gpt-5.5").map((o) => o.id);
  const fallback = supportedEfforts("codex", DEFAULT_MODEL.codex).map((o) => o.id);
  expect(retired).toEqual(fallback);
});

test("fx: every new row's curated effort set offers fx's own default (auto), so a new task starts on it", () => {
  for (const id of [...NEW_FX_STANDARD, ...NEW_FX_CATALOG_ONLY]) {
    const offered = supportedEfforts("fx", id).map((o) => o.id);
    expect(offered, id).toContain(DEFAULT_EFFORT.fx);
    // At least one real tier beyond auto: each new model advertises reasoning efforts.
    expect(offered.length, id).toBeGreaterThan(1);
  }
});

test("Speed: none of the new codex, fx or cursor models offers a tier beyond Off unless fx discovery flags one", () => {
  for (const effort of [null, ...supportedEfforts("codex", TERRA_CODEX).map((o) => o.id)]) {
    expect(supportedSpeeds("codex", TERRA_CODEX, effort)).toEqual(["off"]);
  }
  for (const id of [...NEW_FX_STANDARD, ...NEW_FX_CATALOG_ONLY]) {
    expect(supportedSpeeds("fx", id, "auto"), id).toEqual(["off"]);
  }
  for (const base of ["muse-wonder-1.0", "muse-spark-1.3", "deepseek-v41-flash-1017"]) {
    const spec = CURSOR_MODEL_SPECS[base];
    expect(spec?.fastEfforts, base).toBeUndefined();
    for (const effort of [null, ...Object.keys(spec?.effortIds ?? {})]) {
      expect(supportedSpeeds("cursor", base, effort), `${base}/${effort}`).toEqual(["off"]);
    }
  }
});

test("cursor: each new family's effort picker lists exactly the tiers cursor-agent lists as variant ids", () => {
  for (const base of ["muse-wonder-1.0", "muse-spark-1.3", "deepseek-v41-flash-1017"]) {
    const spec = CURSOR_MODEL_SPECS[base];
    expect(spec, base).toBeDefined();
    const tiers = Object.keys(spec?.effortIds ?? {});
    expect(supportedEfforts("cursor", base).map((o) => o.id).sort(), base).toEqual([...tiers].sort());
    // Every variant id is `<base>-<tier>`, the shape migration 076 folds.
    for (const tier of tiers) expect(spec?.effortIds?.[tier], `${base}/${tier}`).toBe(`${base}-${tier}`);
  }
});

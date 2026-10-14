import { expect, test } from "bun:test";
import { mergeModelOptions, type DiscoveredModel } from "./model-options.ts";
import { AGENT_OPTIONS, CATALOG_SCOPED_KINDS, DEFAULT_MODEL } from "./types.ts";

/**
 * Gemini 4 Argon (docs/plans/add-gemini-4-argon.md) through the real picker
 * merge: `mergeModelOptions` over the actual `AGENT_OPTIONS` rows, the way
 * every picker (New Task form, task details, `agetor add`, launch dialogs)
 * calls it. types.test.ts pins the catalog rows themselves; this file pins
 * what a user actually sees for each harness.
 */

const ARGON_FX = "google/gemini-4-argon";
const ARGON_AGY = ["gemini-4-argon-high", "gemini-4-argon-medium", "gemini-4-argon-low"];

function ids(rows: { id: string }[]): string[] {
  return rows.map((r) => r.id);
}

// --- fx: catalogOnly, so only an account whose catalog lists it sees it ------

test("fx picker shows Gemini 4 Argon when the account's discovered catalog lists it", () => {
  const discovered: DiscoveredModel[] = [{ id: DEFAULT_MODEL.fx }, { id: ARGON_FX }];
  const rows = mergeModelOptions({
    curated: AGENT_OPTIONS.fx.models,
    discovered,
    scoped: CATALOG_SCOPED_KINDS.has("fx"),
    selected: null,
  });
  const argon = rows.find((r) => r.id === ARGON_FX);
  expect(argon?.label).toBe("Gemini 4 Argon");
  expect(argon?.unlisted).toBeUndefined();
});

test("fx picker hides Gemini 4 Argon when the account's catalog lacks it", () => {
  const rows = mergeModelOptions({
    curated: AGENT_OPTIONS.fx.models,
    discovered: [{ id: DEFAULT_MODEL.fx }],
    scoped: true,
    selected: null,
  });
  expect(ids(rows)).not.toContain(ARGON_FX);
});

test("fx picker hides Gemini 4 Argon when discovery is empty (catalogOnly never shows on the fallback)", () => {
  const rows = mergeModelOptions({ curated: AGENT_OPTIONS.fx.models, discovered: [], scoped: true, selected: null });
  expect(ids(rows)).not.toContain(ARGON_FX);
  // The fallback still lists the default.
  expect(ids(rows)).toContain(DEFAULT_MODEL.fx);
});

test("fx picker hides Gemini 4 Argon on a logged-out harness even when the (unauthenticated) catalog lists it", () => {
  const rows = mergeModelOptions({
    curated: AGENT_OPTIONS.fx.models,
    discovered: [{ id: DEFAULT_MODEL.fx }, { id: ARGON_FX }],
    scoped: true,
    selected: null,
    loggedIn: false,
  });
  expect(ids(rows)).not.toContain(ARGON_FX);
});

test("fx: a task already pinned to Gemini 4 Argon keeps it visible as an unlisted row when the catalog drops it", () => {
  const rows = mergeModelOptions({
    curated: AGENT_OPTIONS.fx.models,
    discovered: [{ id: DEFAULT_MODEL.fx }],
    scoped: true,
    selected: ARGON_FX,
  });
  const argon = rows.find((r) => r.id === ARGON_FX);
  expect(argon).toBeDefined();
  expect(argon?.unlisted).toBe(true);
});

// --- antigravity: not catalog-scoped, Argon rows always listed first ---------

test("antigravity is not catalog-scoped, so the three Argon rows show even when discovery is empty", () => {
  expect(CATALOG_SCOPED_KINDS.has("antigravity")).toBe(false);
  const rows = mergeModelOptions({
    curated: AGENT_OPTIONS.antigravity.models,
    discovered: [],
    scoped: false,
    selected: null,
  });
  expect(ids(rows).slice(0, 3)).toEqual(ARGON_AGY);
  expect(rows.length).toBe(AGENT_OPTIONS.antigravity.models.length);
});

test("antigravity: a differently named Argon id from `agy models` is appended after every curated row (the fallback if the curated ids are wrong)", () => {
  const discovered: DiscoveredModel[] = [
    { id: "gemini-4-argon-high" },
    { id: "gemini-4-argon" },
    { id: DEFAULT_MODEL.antigravity },
  ];
  const rows = mergeModelOptions({
    curated: AGENT_OPTIONS.antigravity.models,
    discovered,
    scoped: false,
    selected: null,
  });
  const curatedCount = AGENT_OPTIONS.antigravity.models.length;
  // Curated rows keep their order, including the ones discovery didn't report.
  expect(ids(rows).slice(0, curatedCount)).toEqual(ids(AGENT_OPTIONS.antigravity.models));
  // The discovered-only id lands after them, once, labelled with its id.
  expect(ids(rows).slice(curatedCount)).toEqual(["gemini-4-argon"]);
  expect(rows[curatedCount]?.label).toBe("gemini-4-argon");
  // A curated id that discovery also reported is not listed twice.
  expect(ids(rows).filter((id) => id === "gemini-4-argon-high").length).toBe(1);
});

test("antigravity: a task still pinned to a retired 3.7 Flash id shows it as an unlisted row (migration 065 normally rewrites it first)", () => {
  const rows = mergeModelOptions({
    curated: AGENT_OPTIONS.antigravity.models,
    discovered: [],
    scoped: false,
    selected: "gemini-3.7-flash-high",
  });
  expect(rows.find((r) => r.id === "gemini-3.7-flash-high")?.unlisted).toBe(true);
});

// --- gemini: Argon listed first, default unchanged -------------------------

test("gemini picker lists Gemini 4 Argon first on the discovery-empty fallback, with the 3.1 Pro default still present", () => {
  const rows = mergeModelOptions({ curated: AGENT_OPTIONS.gemini.models, discovered: [], scoped: false, selected: null });
  expect(rows[0]?.id).toBe("gemini-4-argon");
  expect(ids(rows)).toContain(DEFAULT_MODEL.gemini);
  expect(ids(rows)).not.toContain("gemini-3.7-flash");
  expect(ids(rows)).not.toContain("gemini-3.5-flash");
});

test("gemini: a task still pinned to retired gemini-3.5-flash shows it as an unlisted row", () => {
  const rows = mergeModelOptions({
    curated: AGENT_OPTIONS.gemini.models,
    discovered: [],
    scoped: false,
    selected: "gemini-3.5-flash",
  });
  expect(rows.find((r) => r.id === "gemini-3.5-flash")?.unlisted).toBe(true);
});

// --- cursor: one Argon row, variants are not picker rows ----------------------

test("cursor picker offers one bare Gemini 4 Argon row and no suffixed variant rows", () => {
  const rows = mergeModelOptions({ curated: AGENT_OPTIONS.cursor.models, discovered: [], scoped: false, selected: null });
  const argonRows = ids(rows).filter((id) => id.startsWith("gemini-4-argon"));
  expect(argonRows).toEqual(["gemini-4-argon"]);
});

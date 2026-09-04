import { expect, test } from "bun:test";
import {
  type CuratedModel,
  type DiscoveredModel,
  type ModelOption,
  discoveredEffortsFor,
  hasDiscoveredCatalog,
  mergeModelOptions,
} from "./model-options.ts";

function curatedFixture(): CuratedModel[] {
  return [
    { id: "zai/glm-5.3-flash", label: "GLM 5.3 Flash", hint: "Default" },
    { id: "openai/gpt-5.2", label: "GPT-5.2" },
    { id: "anthropic/claude-opus-5", label: "Claude Opus 5", hint: "Premium", catalogOnly: true },
    { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", catalogOnly: true },
  ];
}

// --- rule 1: catalogOnly gating -----------------------------------------

test("rule 1: catalogOnly row included when discovered contains its id", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [{ id: "anthropic/claude-opus-5" }];
  const result = mergeModelOptions({ curated, discovered, scoped: true, selected: null });
  expect(result.find((r) => r.id === "anthropic/claude-opus-5")).toBeDefined();
});

test("rule 1: catalogOnly row excluded when discovered lacks its id (scoped)", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [{ id: "openai/gpt-5.2" }];
  const result = mergeModelOptions({ curated, discovered, scoped: true, selected: null });
  expect(result.find((r) => r.id === "anthropic/claude-opus-5")).toBeUndefined();
  expect(result.find((r) => r.id === "google/gemini-3.1-pro-preview")).toBeUndefined();
});

test("rule 1: catalogOnly row excluded when discovered lacks its id (unscoped)", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [{ id: "openai/gpt-5.2" }];
  const result = mergeModelOptions({ curated, discovered, scoped: false, selected: null });
  expect(result.find((r) => r.id === "anthropic/claude-opus-5")).toBeUndefined();
  expect(result.find((r) => r.id === "google/gemini-3.1-pro-preview")).toBeUndefined();
});

test("rule 1: catalogOnly rows never appear on the discovery-empty fallback, regardless of scoped", () => {
  const curated = curatedFixture();
  const scopedResult = mergeModelOptions({ curated, discovered: [], scoped: true, selected: null });
  const unscopedResult = mergeModelOptions({ curated, discovered: [], scoped: false, selected: null });
  for (const result of [scopedResult, unscopedResult]) {
    expect(result.find((r) => r.id === "anthropic/claude-opus-5")).toBeUndefined();
    expect(result.find((r) => r.id === "google/gemini-3.1-pro-preview")).toBeUndefined();
  }
});

// --- rule 2: discovery-empty fallback -----------------------------------

test("rule 2: discovered.length === 0 returns all non-catalogOnly curated rows in curated order", () => {
  const curated = curatedFixture();
  const result = mergeModelOptions({ curated, discovered: [], scoped: true, selected: null });
  expect(result).toEqual([
    { id: "zai/glm-5.3-flash", label: "GLM 5.3 Flash", hint: "Default" },
    { id: "openai/gpt-5.2", label: "GPT-5.2" },
  ]);
});

// --- rule 3: scoped, discovered non-empty -------------------------------

test("rule 3: scoped filters curated to the discovered set, then appends discovered-only ids in discovered order", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [
    { id: "zai/glm-5.3-flash" },
    { id: "e2e/discovered-only-b" },
    { id: "e2e/discovered-only-a", label: "Discovered A" },
  ];
  const result = mergeModelOptions({ curated, discovered, scoped: true, selected: null });
  expect(result).toEqual([
    { id: "zai/glm-5.3-flash", label: "GLM 5.3 Flash", hint: "Default" },
    { id: "e2e/discovered-only-b", label: "e2e/discovered-only-b" },
    { id: "e2e/discovered-only-a", label: "Discovered A" },
  ]);
});

test("rule 3 / named case: scoped with a catalogOnly row present in discovered is included with its curated label", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [
    { id: "openai/gpt-5.2" },
    { id: "anthropic/claude-opus-5" },
  ];
  const result = mergeModelOptions({ curated, discovered, scoped: true, selected: null });
  expect(result).toEqual([
    { id: "openai/gpt-5.2", label: "GPT-5.2" },
    { id: "anthropic/claude-opus-5", label: "Claude Opus 5", hint: "Premium" },
  ]);
});

// --- rule 4: unscoped, discovered non-empty -----------------------------

test("rule 4: unscoped keeps all (non-gated) curated rows, then discovered-only ids", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [
    { id: "openai/gpt-5.2" }, // already curated — should not duplicate
    { id: "e2e/discovered-only" },
  ];
  const result = mergeModelOptions({ curated, discovered, scoped: false, selected: null });
  expect(result).toEqual([
    { id: "zai/glm-5.3-flash", label: "GLM 5.3 Flash", hint: "Default" },
    { id: "openai/gpt-5.2", label: "GPT-5.2" },
    { id: "e2e/discovered-only", label: "e2e/discovered-only" },
  ]);
});

test("named case: unscoped result is byte-identical to [...curated(non-gated), ...extras]", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [
    { id: "anthropic/claude-opus-5" }, // catalogOnly, now present -> included
    { id: "e2e/extra-one" },
    { id: "e2e/extra-two", label: "Extra Two" },
  ];
  const result = mergeModelOptions({ curated, discovered, scoped: false, selected: null });

  const nonGatedCurated = curated
    .filter((m) => !m.catalogOnly || discovered.some((d) => d.id === m.id))
    .map((m) => {
      const opt: { id: string; label: string; hint?: string } = { id: m.id, label: m.label };
      if (m.hint !== undefined) opt.hint = m.hint;
      return opt;
    });
  const curatedIds = new Set(curated.map((m) => m.id));
  const extras = discovered
    .filter((m) => !curatedIds.has(m.id))
    .map((m) => ({ id: m.id, label: m.label ?? m.id }));

  expect(result).toEqual([...nonGatedCurated, ...extras]);
});

// --- rule 5: dedupe by id, first occurrence wins ------------------------

test("rule 5 / named case: duplicate ids across curated and discovered collapse to the curated row", () => {
  const curated: CuratedModel[] = [{ id: "zai/glm-5.3-flash", label: "GLM 5.3 Flash", hint: "Default" }];
  const discovered: DiscoveredModel[] = [{ id: "zai/glm-5.3-flash", label: "Some Other Label" }];
  const scopedResult = mergeModelOptions({ curated, discovered, scoped: true, selected: null });
  const unscopedResult = mergeModelOptions({ curated, discovered, scoped: false, selected: null });
  expect(scopedResult).toEqual([{ id: "zai/glm-5.3-flash", label: "GLM 5.3 Flash", hint: "Default" }]);
  expect(unscopedResult).toEqual([{ id: "zai/glm-5.3-flash", label: "GLM 5.3 Flash", hint: "Default" }]);
});

// --- rule 6: selected-unlisted appending ---------------------------------

test("rule 6: a selected id absent from the merged result is appended last as unlisted", () => {
  const curated = curatedFixture();
  const result = mergeModelOptions({
    curated,
    discovered: [],
    scoped: true,
    selected: "moonshotai/kimi-k3",
  });
  expect(result.at(-1)).toEqual({
    id: "moonshotai/kimi-k3",
    label: "moonshotai/kimi-k3",
    hint: "Not in this account's model catalog",
    unlisted: true,
  });
});

test("rule 6: a selected id already present in the merged result is not duplicated or marked unlisted", () => {
  const curated = curatedFixture();
  const result = mergeModelOptions({
    curated,
    discovered: [],
    scoped: true,
    selected: "openai/gpt-5.2",
  });
  expect(result.filter((r) => r.id === "openai/gpt-5.2")).toHaveLength(1);
  expect(result.find((r) => r.id === "openai/gpt-5.2")?.unlisted).toBeUndefined();
});

test("named case: scoped with the selected id filtered out of curated∩discovered reappears as unlisted at the end", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [{ id: "openai/gpt-5.2" }];
  const result = mergeModelOptions({
    curated,
    discovered,
    scoped: true,
    selected: "zai/glm-5.3-flash", // curated, but not in this (scoped) discovered set
  });
  expect(result).toEqual([
    { id: "openai/gpt-5.2", label: "GPT-5.2" },
    {
      id: "zai/glm-5.3-flash",
      label: "zai/glm-5.3-flash",
      hint: "Not in this account's model catalog",
      unlisted: true,
    },
  ]);
});

test("named case: selected null/undefined/empty-string appends nothing", () => {
  const curated = curatedFixture();
  const base = { curated, discovered: [] as DiscoveredModel[], scoped: true };
  const withNull = mergeModelOptions({ ...base, selected: null });
  const withUndefined = mergeModelOptions({ ...base, selected: undefined });
  const withEmptyString = mergeModelOptions({ ...base, selected: "" });
  const withOmitted = mergeModelOptions({ curated, discovered: [], scoped: true });
  expect(withNull.some((r) => r.unlisted)).toBe(false);
  expect(withUndefined.some((r) => r.unlisted)).toBe(false);
  expect(withEmptyString.some((r) => r.unlisted)).toBe(false);
  expect(withOmitted.some((r) => r.unlisted)).toBe(false);
  expect(withNull).toEqual(withUndefined);
  expect(withUndefined).toEqual(withEmptyString);
  expect(withEmptyString).toEqual(withOmitted);
});

// --- rule 6 (no mutation) / general invariants ---------------------------

test("inputs are never mutated by the call", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [
    { id: "openai/gpt-5.2" },
    { id: "e2e/discovered-only" },
  ];
  const curatedSnapshot = JSON.parse(JSON.stringify(curated));
  const discoveredSnapshot = JSON.parse(JSON.stringify(discovered));

  mergeModelOptions({ curated, discovered, scoped: true, selected: "unlisted/id" });
  mergeModelOptions({ curated, discovered, scoped: false, selected: null });
  mergeModelOptions({ curated, discovered: [], scoped: true, selected: null });

  expect(curated).toEqual(curatedSnapshot);
  expect(discovered).toEqual(discoveredSnapshot);
});

test("mergeModelOptions returns a fresh array each call, not a shared reference", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [{ id: "openai/gpt-5.2" }];
  const a = mergeModelOptions({ curated, discovered, scoped: false, selected: null });
  const b = mergeModelOptions({ curated, discovered, scoped: false, selected: null });
  expect(a).not.toBe(b);
  expect(a).toEqual(b);
});

// --- rule 7: loggedIn:false distrusts the discovered catalog ------------

test("rule 7: loggedIn:false with a catalogOnly-containing discovered catalog (scoped) matches the discovery-empty fallback", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [
    { id: "zai/glm-5.3-flash" },
    { id: "anthropic/claude-opus-5" },
    { id: "e2e/discovered-only" },
  ];
  const loggedOut = mergeModelOptions({ curated, discovered, scoped: true, selected: null, loggedIn: false });
  const fallback = mergeModelOptions({ curated, discovered: [], scoped: true, selected: null });
  expect(loggedOut).toEqual(fallback);
  expect(loggedOut).toEqual([
    { id: "zai/glm-5.3-flash", label: "GLM 5.3 Flash", hint: "Default" },
    { id: "openai/gpt-5.2", label: "GPT-5.2" },
  ]);
});

test("rule 7: loggedIn:false with a catalogOnly-containing discovered catalog (unscoped) matches the discovery-empty fallback", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [
    { id: "openai/gpt-5.2" },
    { id: "anthropic/claude-opus-5" },
    { id: "google/gemini-3.1-pro-preview" },
    { id: "e2e/discovered-only" },
  ];
  const loggedOut = mergeModelOptions({ curated, discovered, scoped: false, selected: null, loggedIn: false });
  const fallback = mergeModelOptions({ curated, discovered: [], scoped: false, selected: null });
  expect(loggedOut).toEqual(fallback);
  expect(loggedOut).toEqual([
    { id: "zai/glm-5.3-flash", label: "GLM 5.3 Flash", hint: "Default" },
    { id: "openai/gpt-5.2", label: "GPT-5.2" },
  ]);
});

test("rule 7: loggedIn:false still appends a selected discovered-only id as unlisted (rule 6 survives the distrust)", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [
    { id: "zai/glm-5.3-flash" },
    { id: "e2e/discovered-only" },
  ];
  const result = mergeModelOptions({
    curated,
    discovered,
    scoped: true,
    selected: "e2e/discovered-only",
    loggedIn: false,
  });
  expect(result).toEqual([
    { id: "zai/glm-5.3-flash", label: "GLM 5.3 Flash", hint: "Default" },
    { id: "openai/gpt-5.2", label: "GPT-5.2" },
    {
      id: "e2e/discovered-only",
      label: "e2e/discovered-only",
      hint: "Not logged in — this account's catalog is unavailable",
      unlisted: true,
    },
  ]);
});

test("rule 7: loggedIn true/null/omitted are all identical to today's (unchanged) behavior — unscoped", () => {
  // Explicit-literal pin for the unscoped case, kept alongside the looped
  // assertion below so the scoped/unscoped pair can't both silently drift.
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [
    { id: "openai/gpt-5.2" },
    { id: "anthropic/claude-opus-5" },
    { id: "e2e/discovered-only" },
  ];
  const withTrue = mergeModelOptions({ curated, discovered, scoped: false, selected: null, loggedIn: true });
  const withNull = mergeModelOptions({ curated, discovered, scoped: false, selected: null, loggedIn: null });
  const omitted = mergeModelOptions({ curated, discovered, scoped: false, selected: null });
  const expected: ModelOption[] = [
    { id: "zai/glm-5.3-flash", label: "GLM 5.3 Flash", hint: "Default" },
    { id: "openai/gpt-5.2", label: "GPT-5.2" },
    { id: "anthropic/claude-opus-5", label: "Claude Opus 5", hint: "Premium" },
    { id: "e2e/discovered-only", label: "e2e/discovered-only" },
  ];
  expect(withTrue).toEqual(expected);
  expect(withNull).toEqual(expected);
  expect(omitted).toEqual(expected);
});

test("rule 7: loggedIn true/null/omitted are all identical to today's (unchanged) behavior — scoped and unscoped", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [
    { id: "openai/gpt-5.2" },
    { id: "anthropic/claude-opus-5" },
    { id: "e2e/discovered-only" },
  ];
  for (const scoped of [true, false]) {
    const expected = mergeModelOptions({ curated, discovered, scoped, selected: null });
    const withTrue = mergeModelOptions({ curated, discovered, scoped, selected: null, loggedIn: true });
    const withNull = mergeModelOptions({ curated, discovered, scoped, selected: null, loggedIn: null });
    const omitted = mergeModelOptions({ curated, discovered, scoped, selected: null });
    expect(withTrue).toEqual(expected);
    expect(withNull).toEqual(expected);
    expect(omitted).toEqual(expected);
  }
});

// --- rule 8: discovered `efforts` attached to merged rows ---------------

test("rule 8: curated∩discovered row carries discovered efforts, keeping curated label/hint", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [{ id: "openai/gpt-5.2", label: "Ignored Label", efforts: ["high", "low"] }];
  const result = mergeModelOptions({ curated, discovered, scoped: false, selected: null });
  expect(result.find((r) => r.id === "openai/gpt-5.2")).toEqual({
    id: "openai/gpt-5.2",
    label: "GPT-5.2", // curated label wins per rule 5, unaffected by rule 8
    efforts: ["high", "low"],
  });
});

test("rule 8: discovered-only row carries its efforts", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [{ id: "e2e/discovered-only", label: "Discovered Only", efforts: ["ultra", "high"] }];
  const result = mergeModelOptions({ curated, discovered, scoped: false, selected: null });
  expect(result.find((r) => r.id === "e2e/discovered-only")).toEqual({
    id: "e2e/discovered-only",
    label: "Discovered Only",
    efforts: ["ultra", "high"],
  });
});

test("rule 8: scoped (fx-style) path also attaches efforts to curated∩discovered and discovered-only rows", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [
    { id: "openai/gpt-5.2", efforts: ["medium"] },
    { id: "e2e/discovered-only", efforts: ["low"] },
  ];
  const result = mergeModelOptions({ curated, discovered, scoped: true, selected: null });
  expect(result.find((r) => r.id === "openai/gpt-5.2")?.efforts).toEqual(["medium"]);
  expect(result.find((r) => r.id === "e2e/discovered-only")?.efforts).toEqual(["low"]);
});

test("rule 8: discovery-empty fallback attaches no efforts key to any row", () => {
  const curated = curatedFixture();
  const result = mergeModelOptions({ curated, discovered: [], scoped: false, selected: null });
  expect(result.length).toBeGreaterThan(0);
  for (const row of result) {
    expect(row).not.toHaveProperty("efforts");
  }
});

test("rule 8: loggedIn:false discards discovered efforts too, even though the discovered list carries them", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [
    { id: "openai/gpt-5.2", efforts: ["high", "low"] },
    { id: "e2e/discovered-only", efforts: ["ultra"] },
  ];
  const result = mergeModelOptions({ curated, discovered, scoped: false, selected: null, loggedIn: false });
  expect(result.find((r) => r.id === "e2e/discovered-only")).toBeUndefined();
  for (const row of result) {
    expect(row).not.toHaveProperty("efforts");
  }
});

test("rule 8: an entry with efforts: [] attaches no efforts key", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [{ id: "openai/gpt-5.2", efforts: [] }];
  const result = mergeModelOptions({ curated, discovered, scoped: false, selected: null });
  expect(result.find((r) => r.id === "openai/gpt-5.2")).not.toHaveProperty("efforts");
});

test("rule 8: an entry with no efforts field attaches no efforts key", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [{ id: "openai/gpt-5.2" }];
  const result = mergeModelOptions({ curated, discovered, scoped: false, selected: null });
  expect(result.find((r) => r.id === "openai/gpt-5.2")).not.toHaveProperty("efforts");
});

test("rule 8: the rule-6 unlisted row for a selected id absent from both lists has no efforts", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [{ id: "openai/gpt-5.2", efforts: ["high"] }];
  const result = mergeModelOptions({
    curated,
    discovered,
    scoped: false,
    selected: "moonshotai/kimi-k3", // in neither curated nor discovered
  });
  const unlistedRow = result.find((r) => r.id === "moonshotai/kimi-k3");
  expect(unlistedRow?.unlisted).toBe(true);
  expect(unlistedRow).not.toHaveProperty("efforts");
});

test("rule 8: a selected id present only in discovery is a discovered-only row (not unlisted) and carries its efforts", () => {
  const curated = curatedFixture();
  const discovered: DiscoveredModel[] = [{ id: "e2e/discovered-only", efforts: ["ultra", "max"] }];
  const result = mergeModelOptions({
    curated,
    discovered,
    scoped: false,
    selected: "e2e/discovered-only",
  });
  const row = result.find((r) => r.id === "e2e/discovered-only");
  // Discovery already surfaced this id via the discovered-only merge pass, so
  // rule 6's "not in either list" unlisted branch never fires for it — it's
  // an ordinary discovered-only row, present exactly once, carrying efforts.
  expect(result.filter((r) => r.id === "e2e/discovered-only")).toHaveLength(1);
  expect(row?.unlisted).toBeUndefined();
  expect(row?.efforts).toEqual(["ultra", "max"]);
});

test("rule 8: mutating a returned efforts array does not mutate the input discovered entry", () => {
  const curated = curatedFixture();
  const entry: DiscoveredModel = { id: "openai/gpt-5.2", efforts: ["high", "low"] };
  const result = mergeModelOptions({ curated, discovered: [entry], scoped: false, selected: null });
  const row = result.find((r) => r.id === "openai/gpt-5.2");
  const rowEfforts = row?.efforts as string[];
  expect(rowEfforts).toEqual(["high", "low"]);
  expect(rowEfforts).not.toBe(entry.efforts);
  rowEfforts.push("mutated");
  expect(entry.efforts).toEqual(["high", "low"]);
});

// --- discoveredEffortsFor --------------------------------------------------

test("discoveredEffortsFor: returns the matching entry's efforts on a hit", () => {
  const models = [
    { id: "openai/gpt-5.2", efforts: ["high", "low"] },
    { id: "e2e/discovered-only", efforts: ["ultra"] },
  ];
  expect(discoveredEffortsFor(models, "openai/gpt-5.2")).toEqual(["high", "low"]);
});

test("discoveredEffortsFor: returns null when the id is absent from the list (miss)", () => {
  const models = [{ id: "openai/gpt-5.2", efforts: ["high", "low"] }];
  expect(discoveredEffortsFor(models, "not/found")).toBeNull();
});

test("discoveredEffortsFor: returns null when id is null or undefined", () => {
  const models = [{ id: "openai/gpt-5.2", efforts: ["high", "low"] }];
  expect(discoveredEffortsFor(models, null)).toBeNull();
  expect(discoveredEffortsFor(models, undefined)).toBeNull();
});

test("discoveredEffortsFor: returns null when models is null, undefined, or empty", () => {
  expect(discoveredEffortsFor(null, "openai/gpt-5.2")).toBeNull();
  expect(discoveredEffortsFor(undefined, "openai/gpt-5.2")).toBeNull();
  expect(discoveredEffortsFor([], "openai/gpt-5.2")).toBeNull();
});

test("discoveredEffortsFor: returns null when the matching entry's efforts is an empty array", () => {
  const models = [{ id: "openai/gpt-5.2", efforts: [] as string[] }];
  expect(discoveredEffortsFor(models, "openai/gpt-5.2")).toBeNull();
});

test("discoveredEffortsFor: returns null when the matching entry has no efforts field", () => {
  const models = [{ id: "openai/gpt-5.2" }];
  expect(discoveredEffortsFor(models, "openai/gpt-5.2")).toBeNull();
});

test("discoveredEffortsFor: the first matching entry wins when ids repeat", () => {
  const models = [
    { id: "dup/id", efforts: ["first"] },
    { id: "dup/id", efforts: ["second"] },
  ];
  expect(discoveredEffortsFor(models, "dup/id")).toEqual(["first"]);
});

// --- hasDiscoveredCatalog -------------------------------------------------

test("hasDiscoveredCatalog: false for an empty catalog", () => {
  expect(hasDiscoveredCatalog([])).toBe(false);
});

test("hasDiscoveredCatalog: true for a non-empty catalog", () => {
  expect(hasDiscoveredCatalog([{ id: "openai/gpt-5.2" }])).toBe(true);
});

// --- discoveredEffortsFor over mergeModelOptions' MERGED rows applies rule 7 ---

test("discoveredEffortsFor over merged rows: loggedIn:false distrusts discovered efforts (rule 7 applied)", () => {
  const merged = mergeModelOptions({
    curated: [{ id: "a", label: "A" }],
    discovered: [{ id: "a", efforts: ["low", "high"] }],
    selected: "a",
    scoped: false,
    loggedIn: false,
  });
  // Rule 7 discarded `discovered` wholesale before rule 8 ever ran, so the
  // merged row for "a" carries no `efforts` key at all.
  expect(discoveredEffortsFor(merged, "a")).toBeNull();
});

test("discoveredEffortsFor over merged rows: loggedIn:true (or omitted) trusts discovered efforts", () => {
  const mergedLoggedIn = mergeModelOptions({
    curated: [{ id: "a", label: "A" }],
    discovered: [{ id: "a", efforts: ["low", "high"] }],
    selected: "a",
    scoped: false,
    loggedIn: true,
  });
  expect(discoveredEffortsFor(mergedLoggedIn, "a")).toEqual(["low", "high"]);

  const mergedOmitted = mergeModelOptions({
    curated: [{ id: "a", label: "A" }],
    discovered: [{ id: "a", efforts: ["low", "high"] }],
    selected: "a",
    scoped: false,
  });
  expect(discoveredEffortsFor(mergedOmitted, "a")).toEqual(["low", "high"]);
});

test("discoveredEffortsFor over the RAW discovered list would wrongly return efforts regardless of loggedIn — documenting why callers must pass merged rows", () => {
  const rawDiscovered: DiscoveredModel[] = [{ id: "a", efforts: ["low", "high"] }];
  // discoveredEffortsFor has no `loggedIn` of its own to consult — fed the
  // raw pre-merge list, it can't tell a distrusted (logged-out) catalog from
  // a trusted one, so it returns the efforts unconditionally. This is
  // exactly the bug rule 8's merged-rows contract exists to prevent; real
  // callers must pass `mergeModelOptions`'s own output instead (see the two
  // tests above).
  expect(discoveredEffortsFor(rawDiscovered, "a")).toEqual(["low", "high"]);
});

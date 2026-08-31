import { expect, test } from "bun:test";
import {
  type CuratedModel,
  type DiscoveredModel,
  type ModelOption,
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
      hint: "Not in this account's model catalog",
      unlisted: true,
    },
  ]);
});

test("rule 7: loggedIn true/null/omitted are all identical to today's (unchanged) behavior", () => {
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

// --- hasDiscoveredCatalog -------------------------------------------------

test("hasDiscoveredCatalog: false for an empty catalog", () => {
  expect(hasDiscoveredCatalog([])).toBe(false);
});

test("hasDiscoveredCatalog: true for a non-empty catalog", () => {
  expect(hasDiscoveredCatalog([{ id: "openai/gpt-5.2" }])).toBe(true);
});

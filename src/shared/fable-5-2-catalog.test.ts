import { expect, test } from "bun:test";
import { mergeModelOptions, type DiscoveredModel } from "./model-options.ts";
import {
  AGENT_OPTIONS,
  CATALOG_SCOPED_KINDS,
  CURSOR_MODEL_SPECS,
  DEFAULT_MODEL,
  cursorModelArg,
  cursorModelIdCoveredByCatalog,
  supportedEfforts,
  supportedModes,
} from "./types.ts";

/**
 * Fable 5.2 / Mythos 5.2 (docs/plans/add-fable-5-2.md) through the real
 * picker merge: `mergeModelOptions` over the actual `AGENT_OPTIONS` rows, the
 * way every picker (New Task form, task details, `agetor add`, launch
 * dialogs) calls it. types.test.ts pins the catalog rows themselves; this
 * file pins what a user actually sees for each harness.
 */

const CLAUDE_FABLE = "fable-5.2";
const CLAUDE_MYTHOS = "mythos-5.2";
const CURSOR_FABLE = "claude-fable-5-2";
const CURSOR_FABLE_51 = "claude-fable-5-1";
const FX_FABLE = "anthropic/claude-fable-5.2";
const FX_FABLE_51 = "anthropic/claude-fable-5.1";

/** The owner-verbatim leading rows (plan §1) — family-grouped, not globally
 *  newest-first (owner decision D4). */
const CLAUDE_LEADING_ROWS: Array<[string, string]> = [
  ["mythos-5.2", "Mythos 5.2"],
  ["mythos-5.1", "Mythos 5.1"],
  ["mythos-5", "Mythos 5"],
  ["fable-5.2", "Fable 5.2"],
  ["fable-5.1", "Fable 5.1"],
  ["fable-5", "Fable 5"],
];

const CURSOR_FABLE_TIERS = ["max", "xhigh", "high", "medium", "low"] as const;

function ids(rows: { id: string }[]): string[] {
  return rows.map((r) => r.id);
}

// --- claude-code: discovery is always empty, so the curated fallback IS the picker ---

test("claude-code picker leads with the six Mythos/Fable rows (5.2 first) and keeps Opus 5.5 as the default", () => {
  // `discoverClaude` always returns [] (no programmatic model-list command
  // exists), so the discovery-empty fallback is the real picker list: every
  // curated row, curated order. This is the list NewTaskForm, RunPanel,
  // TaskLaunchPickers and `agetor add` all render.
  expect(CATALOG_SCOPED_KINDS.has("claude-code")).toBe(false);
  const rows = mergeModelOptions({
    curated: AGENT_OPTIONS["claude-code"].models,
    discovered: [],
    scoped: false,
    selected: null,
  });

  expect(rows.slice(0, 6).map((r) => [r.id, r.label])).toEqual(CLAUDE_LEADING_ROWS);
  expect(rows.find((r) => r.id === CLAUDE_FABLE)?.hint).toBe(
    "Most capable widely released model — above Opus. Uses 2x the usage of Opus.",
  );
  expect(rows.find((r) => r.id === CLAUDE_MYTHOS)?.hint).toBe(
    "Fable 5.2's twin — same capability and cost; requires approved-org (Project Glasswing) access. Uses 2x the usage of Opus.",
  );

  // Standard rows on a non-catalog-scoped kind — never gated on discovery.
  expect(AGENT_OPTIONS["claude-code"].models.find((m) => m.id === CLAUDE_FABLE)?.catalogOnly).toBeUndefined();
  expect(AGENT_OPTIONS["claude-code"].models.find((m) => m.id === CLAUDE_MYTHOS)?.catalogOnly).toBeUndefined();

  // The default stays Opus 5.5 (owner D3): Fable 5.2 is exactly 2x the usage.
  expect(DEFAULT_MODEL["claude-code"]).toBe("opus-5.5");
  expect(rows.find((r) => r.id === DEFAULT_MODEL["claude-code"])?.unlisted).toBeUndefined();
  // Nothing is an unlisted leftover on a fresh picker.
  expect(rows.some((r) => r.unlisted)).toBe(false);
});

test("claude-code Fable 5.2 / Mythos 5.2 offer the full max→low ladder and every Claude mode through the shared tables", () => {
  const allModes = AGENT_OPTIONS["claude-code"].modes.map((m) => m.id);
  expect(allModes).toEqual(["auto", "bypass", "acceptEdits", "plan", "ask"]);
  for (const id of [CLAUDE_FABLE, CLAUDE_MYTHOS]) {
    expect(supportedEfforts("claude-code", id).map((o) => o.id), id).toEqual([
      "max",
      "xhigh",
      "high",
      "medium",
      "low",
    ]);
    expect(supportedModes("claude-code", id).map((m) => m.id), id).toEqual(allModes);
  }
});

// --- cursor: the catalog's suffixed variants are not picker rows -------------

test("cursor picker offers one bare Fable 5.2 row: the catalog's five plain variants are all covered and dropped, and the row sits directly above Fable 5.1", () => {
  const spec = CURSOR_MODEL_SPECS[CURSOR_FABLE];
  expect(spec).toBeDefined();
  expect(spec?.label).toBe("Fable 5.2");

  // `cursor-agent models` (2026-11-09) lists the base id plus the five plain
  // tiers — no -thinking / -fast forms. Every cursor picker (NewTaskForm,
  // TaskLaunchPickers, RunPanel, `agetor add`) drops the ids the curated
  // specs already cover from the discovered list before merging.
  const raw: DiscoveredModel[] = [
    { id: CURSOR_FABLE },
    ...CURSOR_FABLE_TIERS.map((tier) => ({ id: `${CURSOR_FABLE}-${tier}` })),
  ];
  expect(raw).toHaveLength(6);
  const discovered = raw.filter((m) => !cursorModelIdCoveredByCatalog(m.id));
  expect(discovered).toEqual([]);

  const rows = mergeModelOptions({
    curated: AGENT_OPTIONS.cursor.models,
    discovered,
    scoped: CATALOG_SCOPED_KINDS.has("cursor"),
    selected: null,
  });
  expect(ids(rows).filter((id) => id.startsWith(CURSOR_FABLE))).toEqual([CURSOR_FABLE]);
  expect(rows.find((r) => r.id === CURSOR_FABLE)?.label).toBe("Fable 5.2");

  // Spec insertion order is picker order (AGENT_OPTIONS.cursor.models is
  // built from CURSOR_MODEL_SPECS), so 5.2 renders immediately above 5.1.
  const order = ids(rows);
  expect(order.indexOf(CURSOR_FABLE)).toBe(order.indexOf(CURSOR_FABLE_51) - 1);
});

test("cursor: the Fable 5.1 -thinking sibling is not spec-covered, so it stays a discovered-only row beside the bare rows", () => {
  // The 5.2 spec deliberately covers only the five plain ids (the 2026-11-09
  // catalog has no 5.2 -thinking form), while 5.1's -thinking rows remain
  // discovered-only — the coverage filter must not over-reach and hide them.
  const thinking = `${CURSOR_FABLE_51}-thinking-high`;
  expect(cursorModelIdCoveredByCatalog(thinking)).toBe(false);
  const discovered = [{ id: thinking }].filter((m) => !cursorModelIdCoveredByCatalog(m.id));
  expect(discovered).toEqual([{ id: thinking }]);

  const rows = mergeModelOptions({
    curated: AGENT_OPTIONS.cursor.models,
    discovered,
    scoped: false,
    selected: null,
  });
  // Every curated row survives in curated order; the discovered-only id is
  // appended last and is NOT marked unlisted (rule 4).
  expect(ids(rows).slice(0, AGENT_OPTIONS.cursor.models.length)).toEqual(ids(AGENT_OPTIONS.cursor.models));
  expect(ids(rows).at(-1)).toBe(thinking);
  expect(rows.find((r) => r.id === thinking)?.unlisted).toBeUndefined();
});

test("cursor Fable 5.2 re-composes every catalog variant id, never a -fast id, and brackets Max Mode", () => {
  for (const tier of CURSOR_FABLE_TIERS) {
    expect(cursorModelArg(CURSOR_FABLE, tier, false), tier).toBe(`${CURSOR_FABLE}-${tier}`);
    // A stale fast flag never attaches a -fast form — the catalog has none.
    expect(cursorModelArg(CURSOR_FABLE, tier, true), tier).toBe(`${CURSOR_FABLE}-${tier}`);
  }
  expect(cursorModelArg(CURSOR_FABLE, "xhigh", false, true)).toBe(`${CURSOR_FABLE}[context=1m,effort=xhigh]`);
});

// --- fx: catalogOnly, so only an account whose catalog lists it sees it ------

test("fx picker shows Claude Fable 5.2 only when the account's discovered catalog lists it, directly above Claude Fable 5.1", () => {
  // Precondition: the curated row is gated, so its presence below is the
  // gate opening rather than the row being unconditional.
  expect(AGENT_OPTIONS.fx.models.find((m) => m.id === FX_FABLE)?.catalogOnly).toBe(true);

  // Curated order pins the successor/predecessor pair independently of the
  // discovered list's order.
  const curatedIds = ids(AGENT_OPTIONS.fx.models);
  expect(curatedIds.indexOf(FX_FABLE)).toBe(curatedIds.indexOf(FX_FABLE_51) - 1);

  const discovered: DiscoveredModel[] = [
    { id: DEFAULT_MODEL.fx },
    { id: FX_FABLE },
    { id: FX_FABLE_51 },
  ];
  const rows = mergeModelOptions({
    curated: AGENT_OPTIONS.fx.models,
    discovered,
    scoped: CATALOG_SCOPED_KINDS.has("fx"),
    selected: null,
  });
  const row = rows.find((r) => r.id === FX_FABLE);
  expect(row?.label).toBe("Claude Fable 5.2");
  expect(row?.hint).toBe("Premium Gateway tier — offered only when this account's catalog includes it.");
  expect(row?.unlisted).toBeUndefined();
  expect(ids(rows)).toEqual([DEFAULT_MODEL.fx, FX_FABLE, FX_FABLE_51]);
});

test("fx picker hides Claude Fable 5.2 when the catalog lacks it, on empty discovery, and on a logged-out harness", () => {
  const absent = mergeModelOptions({
    curated: AGENT_OPTIONS.fx.models,
    discovered: [{ id: DEFAULT_MODEL.fx }],
    scoped: true,
    selected: null,
  });
  expect(ids(absent)).not.toContain(FX_FABLE);

  // The discovery-empty fallback never shows catalogOnly rows (rule 1/2).
  const empty = mergeModelOptions({
    curated: AGENT_OPTIONS.fx.models,
    discovered: [],
    scoped: true,
    selected: null,
  });
  expect(ids(empty)).not.toContain(FX_FABLE);
  expect(ids(empty)).toContain(DEFAULT_MODEL.fx);

  // An expired login's discovery can still read back the unauthenticated
  // catalog (which does carry the id) — the row must still hide.
  const loggedOut = mergeModelOptions({
    curated: AGENT_OPTIONS.fx.models,
    discovered: [{ id: DEFAULT_MODEL.fx }, { id: FX_FABLE }],
    scoped: true,
    selected: null,
    loggedIn: false,
  });
  expect(ids(loggedOut)).not.toContain(FX_FABLE);
});

test("fx: a task pinned to Claude Fable 5.2 keeps it visible as an unlisted row when the catalog drops it", () => {
  const rows = mergeModelOptions({
    curated: AGENT_OPTIONS.fx.models,
    discovered: [{ id: DEFAULT_MODEL.fx }],
    scoped: true,
    selected: FX_FABLE,
  });
  const row = rows.find((r) => r.id === FX_FABLE);
  expect(row?.unlisted).toBe(true);
});

test("fx Fable 5.2 advertises max→auto through the curated effort table (Gateway reasoning_options + fx's auto)", () => {
  expect(supportedEfforts("fx", FX_FABLE).map((o) => o.id)).toEqual([
    "max",
    "xhigh",
    "high",
    "medium",
    "low",
    "auto",
  ]);
});

import { test, expect } from "bun:test";
import {
  AGENT_OPTIONS,
  CATALOG_SCOPED_KINDS,
  CODE_PLAN_MODE,
  CURSOR_MODEL_SPECS,
  DEFAULT_MODEL,
  FX_PROVIDER_STATUS_PREFIX,
  FX_RECOVERY_STATUS_PREFIX,
  FX_SESSION_TITLE_STATUS_PREFIX,
  FX_USAGE_STATUS_PREFIX,
  MODEL_EFFORT_SUPPORT,
  PERMISSION_MODE_STATUS_PREFIX,
  isInternalStatusSentinel,
  supportedModes,
  type AgentKind,
} from "./types.ts";

/* ── isInternalStatusSentinel ────────────────────────────────────────────── */

test("isInternalStatusSentinel: true for a permission-mode status chunk", () => {
  expect(isInternalStatusSentinel(`${PERMISSION_MODE_STATUS_PREFIX}plan`)).toBe(true);
});

test("isInternalStatusSentinel: true for an fx-usage status chunk", () => {
  expect(isInternalStatusSentinel(`${FX_USAGE_STATUS_PREFIX}{"used":1,"size":2}`)).toBe(true);
});

test("isInternalStatusSentinel: true for an fx-provider status chunk", () => {
  expect(isInternalStatusSentinel(`${FX_PROVIDER_STATUS_PREFIX}gateway`)).toBe(true);
});

test("isInternalStatusSentinel: true for an fx-title status chunk", () => {
  expect(isInternalStatusSentinel(`${FX_SESSION_TITLE_STATUS_PREFIX}x`)).toBe(true);
});

test("isInternalStatusSentinel: true for an fx-recovery status chunk", () => {
  expect(isInternalStatusSentinel(`${FX_RECOVERY_STATUS_PREFIX}{}`)).toBe(true);
});

test("isInternalStatusSentinel: false for the plain 'fx turn ended: refused' status line — it's transcript-visible prose, not the sentinel channel", () => {
  expect(isInternalStatusSentinel("fx turn ended: refused")).toBe(false);
});

test("isInternalStatusSentinel: false for text that merely looks like the fx-title prefix without its trailing space", () => {
  expect(isInternalStatusSentinel("fx-title:x")).toBe(false);
});

test("isInternalStatusSentinel: false for ordinary text mentioning a session title", () => {
  expect(isInternalStatusSentinel("Renamed the session title to x")).toBe(false);
});

test("isInternalStatusSentinel: false for a plain status line that merely mentions a provider", () => {
  expect(isInternalStatusSentinel("provider: gateway")).toBe(false);
});

test("isInternalStatusSentinel: false for plain transcript text", () => {
  expect(isInternalStatusSentinel("started — worktree — agent=fx, model=zai/glm-5.3-flash, mode=auto")).toBe(false);
});

test("isInternalStatusSentinel: false for an empty string", () => {
  expect(isInternalStatusSentinel("")).toBe(false);
});

test("isInternalStatusSentinel: false when a sentinel appears as a substring but not as the prefix", () => {
  // The predicate is startsWith-based — a sentinel string embedded mid-line
  // (e.g. quoted inside a larger message) must NOT be suppressed, or a real
  // assistant message that happens to mention the sentinel text would
  // silently vanish from the transcript.
  expect(isInternalStatusSentinel(`note: saw "${PERMISSION_MODE_STATUS_PREFIX}plan" in the log`)).toBe(false);
  expect(isInternalStatusSentinel(`re: ${FX_USAGE_STATUS_PREFIX}{"used":1}`)).toBe(false);
});

/* ── CODE_PLAN_MODE / AGENT_OPTIONS invariants ───────────────────────────── */

const KINDS = Object.keys(AGENT_OPTIONS) as AgentKind[];

test("every AgentKind has both an AGENT_OPTIONS entry and a CODE_PLAN_MODE entry", () => {
  // Guards against either record silently falling out of sync when a new
  // AgentKind is added to the union without updating both.
  expect(KINDS.length).toBeGreaterThan(0);
  for (const kind of KINDS) {
    expect(CODE_PLAN_MODE[kind]).toBeDefined();
  }
});

test("for every AgentKind, CODE_PLAN_MODE[kind].code equals AGENT_OPTIONS[kind].modes[0].id", () => {
  // The Code/Plan pill's "Code" side always resolves to the agent's
  // most-permissive first-listed mode — see CODE_PLAN_MODE's own doc
  // comment. A mismatch here would mean clicking "Code" doesn't actually
  // select the mode the picker shows as the top/default option.
  for (const kind of KINDS) {
    const modesFirstId = AGENT_OPTIONS[kind].modes[0]?.id;
    expect(modesFirstId).toBeDefined();
    expect(CODE_PLAN_MODE[kind].code).toBe(modesFirstId as string);
  }
});

test("for every AgentKind, CODE_PLAN_MODE[kind].plan is a mode id that kind actually offers", () => {
  for (const kind of KINDS) {
    const validIds = AGENT_OPTIONS[kind].modes.map((m) => m.id);
    expect(validIds).toContain(CODE_PLAN_MODE[kind].plan);
  }
});

test("every AGENT_OPTIONS model entry (all kinds) carries a non-empty hint", () => {
  // As of this writing every kind's model list — including fx's — populates
  // `hint` on every entry (verified directly against AGENT_OPTIONS below), so
  // the assertion is not narrowed to fx alone. If a future kind's model list
  // legitimately ships hint-less entries, narrow this loop to the kinds that
  // still guarantee hints rather than deleting the invariant outright.
  for (const kind of KINDS) {
    const models = AGENT_OPTIONS[kind].models;
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(typeof model.hint).toBe("string");
      expect((model.hint ?? "").trim().length).toBeGreaterThan(0);
    }
  }
});

/* ── fx model catalog invariants (docs/plans/fx-model-catalog-refresh.md §3) ─ */

test("DEFAULT_MODEL.fx is zai/glm-5.3-flash (owner-chosen, 2026-08-27) and is present in AGENT_OPTIONS.fx.models as a non-catalogOnly row", () => {
  expect(DEFAULT_MODEL.fx).toBe("zai/glm-5.3-flash");
  const ids = AGENT_OPTIONS.fx.models.map((m) => m.id);
  expect(ids).toContain(DEFAULT_MODEL.fx);
  const defaultRow = AGENT_OPTIONS.fx.models.find((m) => m.id === DEFAULT_MODEL.fx);
  expect(defaultRow?.catalogOnly).toBeFalsy();
});

test("for every AgentKind, DEFAULT_MODEL[kind] is present in AGENT_OPTIONS[kind].models", () => {
  // Generalizes the fx-specific check above across every kind — a default
  // that isn't one of the picker's own options would silently strand the
  // picker's "current selection" highlight on nothing.
  for (const kind of KINDS) {
    const ids = AGENT_OPTIONS[kind].models.map((m) => m.id);
    expect(ids).toContain(DEFAULT_MODEL[kind]);
  }
});

test("MODEL_EFFORT_SUPPORT.fx's keys exactly match AGENT_OPTIONS.fx.models' ids (both directions)", () => {
  const catalogIds = new Set(AGENT_OPTIONS.fx.models.map((m) => m.id));
  const effortKeys = new Set(Object.keys(MODEL_EFFORT_SUPPORT.fx));
  for (const id of catalogIds) expect(effortKeys.has(id)).toBe(true);
  for (const key of effortKeys) expect(catalogIds.has(key)).toBe(true);
  expect(effortKeys.size).toBe(catalogIds.size);
});

test("MODEL_EFFORT_SUPPORT.fx reports no supported efforts for any model — fx has no per-invocation effort/reasoning flag", () => {
  for (const supported of Object.values(MODEL_EFFORT_SUPPORT.fx)) {
    expect(supported).toEqual([]);
  }
});

test("none of the seven previously-curated fx ids survives as an unconditional row — each is either absent or catalogOnly — and the nonexistent google/gemini-3-pro id is gone entirely", () => {
  const models = AGENT_OPTIONS.fx.models;
  const byId = new Map(models.map((m) => [m.id, m]));
  const previouslyCurated = [
    "moonshotai/kimi-k3",
    "moonshotai/kimi-k3-fast",
    "zai/glm-5.2-fast",
    "anthropic/claude-opus-5",
    "anthropic/claude-sonnet-5",
    "openai/gpt-5.5",
    "google/gemini-3.1-pro-preview",
  ];
  for (const id of previouslyCurated) {
    const row = byId.get(id);
    if (row) expect(row.catalogOnly).toBe(true);
    // else: absent from the catalog entirely — also acceptable.
  }
  const catalogIds = models.map((m) => m.id);
  expect(catalogIds).not.toContain("google/gemini-3-pro");
  expect(Object.keys(MODEL_EFFORT_SUPPORT.fx)).not.toContain("google/gemini-3-pro");
});

test("exactly the twelve premium Gateway ids are catalogOnly in AGENT_OPTIONS.fx, and no other kind's models use catalogOnly", () => {
  const expectedCatalogOnly = new Set([
    "anthropic/claude-opus-5",
    "anthropic/claude-sonnet-5",
    "openai/gpt-5.5",
    "google/gemini-3.1-pro-preview",
    "google/gemini-3.8-flash",
    "moonshotai/kimi-k3",
    // 2026-09-08 fx 0.0.8 catalog refresh (plan §3 S2) — six more premium
    // rows drawn from the unauth catalog, same "offered only when the
    // signed-in account's catalog includes it" treatment as the original six.
    "anthropic/claude-fable-5.1",
    "anthropic/claude-haiku-4.5",
    "openai/gpt-6-astra",
    "openai/gpt-5.6-sol",
    "zai/glm-5.3",
    "deepseek/deepseek-v4-pro",
  ]);
  const actualCatalogOnly = new Set(
    AGENT_OPTIONS.fx.models.filter((m) => m.catalogOnly).map((m) => m.id),
  );
  expect(actualCatalogOnly).toEqual(expectedCatalogOnly);
  expect(actualCatalogOnly.size).toBe(12);

  for (const kind of KINDS) {
    if (kind === "fx") continue;
    for (const model of AGENT_OPTIONS[kind].models) {
      expect(model.catalogOnly).toBeFalsy();
    }
  }
});

test("every AGENT_OPTIONS.fx.models id has an entry in MODEL_EFFORT_SUPPORT.fx and vice versa (twelve catalogOnly rows included)", () => {
  // Narrower restatement of the bidirectional-keys test above, scoped to
  // just the fx picker's own ids — guards specifically against a
  // catalogOnly row landing in AGENT_OPTIONS.fx.models without a paired
  // (empty) MODEL_EFFORT_SUPPORT.fx entry, or vice versa.
  const catalogIds = AGENT_OPTIONS.fx.models.map((m) => m.id);
  const effortKeys = Object.keys(MODEL_EFFORT_SUPPORT.fx);
  for (const id of catalogIds) {
    expect(effortKeys).toContain(id);
  }
  for (const key of effortKeys) {
    expect(catalogIds).toContain(key);
  }
});

test("AGENT_OPTIONS.fx.modes' yolo row is labelled 'Full access' with id 'yolo', and supportedModes('fx', null) still offers auto/yolo/ask", () => {
  const yoloRow = AGENT_OPTIONS.fx.modes.find((m) => m.id === "yolo");
  expect(yoloRow).toBeDefined();
  expect(yoloRow?.label).toBe("Full access");

  const offeredIds = supportedModes("fx", null).map((m) => m.id);
  expect(offeredIds).toContain("auto");
  expect(offeredIds).toContain("yolo");
  expect(offeredIds).toContain("ask");
});

test("AGENT_OPTIONS.fx.modes is ordered yolo, auto, ask — yolo ('Full access') first is fx's actual hands-off default (docs/plans/fix-fx-harness-rate-limit.md §3.7)", () => {
  expect(AGENT_OPTIONS.fx.modes.map((m) => m.id)).toEqual(["yolo", "auto", "ask"]);
  expect(AGENT_OPTIONS.fx.modes[0]?.label).toBe("Full access");
});

test("CODE_PLAN_MODE.fx pins Code to yolo (Full access) and Plan to ask, matching the reordered modes[0]", () => {
  expect(CODE_PLAN_MODE.fx).toEqual({ code: "yolo", plan: "ask" });
});

test("AGENT_OPTIONS.fx.models has unique ids, unique labels, and every id matches provider/model shape", () => {
  const ids = AGENT_OPTIONS.fx.models.map((m) => m.id);
  const labels = AGENT_OPTIONS.fx.models.map((m) => m.label);
  expect(new Set(ids).size).toBe(ids.length);
  expect(new Set(labels).size).toBe(labels.length);
  for (const id of ids) {
    expect(id).toMatch(/^[a-z0-9.-]+\/[a-z0-9.-]+$/);
  }
});

test("CATALOG_SCOPED_KINDS contains exactly fx", () => {
  expect(CATALOG_SCOPED_KINDS.size).toBe(1);
  expect(CATALOG_SCOPED_KINDS.has("fx")).toBe(true);
});

/* ── gemini 3.8 Flash + retired gemini-3-pro-preview default (docs/plans/add-gemini-3-8-flash.md §5 TEST-2) ── */

test("DEFAULT_MODEL.gemini is gemini-3.1-pro-preview (Google's successor to the shut-down 3 Pro preview) and heads the gemini picker", () => {
  expect(DEFAULT_MODEL.gemini).toBe("gemini-3.1-pro-preview");
  expect(AGENT_OPTIONS.gemini.models[0]?.id).toBe("gemini-3.1-pro-preview");
});

test("the gemini picker offers gemini-3.8-flash and no longer offers the shut-down gemini-3-pro-preview", () => {
  const ids = AGENT_OPTIONS.gemini.models.map((m) => m.id);
  expect(ids).toContain("gemini-3.8-flash");
  expect(ids).not.toContain("gemini-3-pro-preview");
  expect(Object.keys(MODEL_EFFORT_SUPPORT.gemini)).not.toContain("gemini-3-pro-preview");
});

test("MODEL_EFFORT_SUPPORT.gemini's keys exactly match AGENT_OPTIONS.gemini.models' ids (both directions) and every value is empty", () => {
  const catalogIds = new Set(AGENT_OPTIONS.gemini.models.map((m) => m.id));
  const effortKeys = new Set(Object.keys(MODEL_EFFORT_SUPPORT.gemini));
  for (const id of catalogIds) expect(effortKeys.has(id)).toBe(true);
  for (const key of effortKeys) expect(catalogIds.has(key)).toBe(true);
  expect(effortKeys.size).toBe(catalogIds.size);

  for (const supported of Object.values(MODEL_EFFORT_SUPPORT.gemini)) {
    expect(supported).toEqual([]);
  }
});

test("gemini picker is tier-ordered: Pro rows first, then Flash rows newest-first", () => {
  const ids = AGENT_OPTIONS.gemini.models.map((m) => m.id);
  expect(ids).toEqual([
    "gemini-3.1-pro-preview",
    "gemini-2.5-pro",
    "gemini-3.8-flash",
    "gemini-3.8-flash-cyber",
    "gemini-3.7-flash",
    "gemini-3.5-flash",
    "gemini-2.5-flash",
  ]);
});

test("gemini-3.8-flash-cyber sits directly under 3.8 Flash and its hint names the Fairwind gate (no public model code — id is convention-based)", () => {
  const models = AGENT_OPTIONS.gemini.models;
  const i = models.findIndex((m) => m.id === "gemini-3.8-flash-cyber");
  expect(i).toBeGreaterThan(0);
  expect(models[i - 1]?.id).toBe("gemini-3.8-flash");
  expect(models[i]?.hint).toContain("Fairwind");
  expect(DEFAULT_MODEL.gemini).not.toBe("gemini-3.8-flash-cyber");
});

test("cursor picker lists Gemini Flash newest-first: 3.8 before 3.7 before 3.6", () => {
  const ids = AGENT_OPTIONS.cursor.models.map((m) => m.id);
  const i38 = ids.indexOf("gemini-3.8-flash");
  const i37 = ids.indexOf("gemini-3.7-flash");
  const i36 = ids.indexOf("gemini-3.6-flash");
  expect(i38).toBeGreaterThanOrEqual(0);
  expect(i37).toBeGreaterThanOrEqual(0);
  expect(i36).toBeGreaterThanOrEqual(0);
  expect(i38).toBeLessThan(i37);
  expect(i37).toBeLessThan(i36);

  for (const id of ["gemini-3.8-flash", "gemini-3.7-flash"]) {
    const spec = CURSOR_MODEL_SPECS[id];
    expect(spec).toBeDefined();
    expect(Object.keys(spec?.effortIds ?? {}).sort()).toEqual(["high", "low", "medium"]);
    expect(spec?.fastEfforts).toBeUndefined();
    expect(spec?.fastId).toBeUndefined();
    expect(spec?.supportsMaxMode).toBeUndefined();
  }
});

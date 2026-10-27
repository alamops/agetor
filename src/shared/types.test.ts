import { test, expect } from "bun:test";
import {
  AGENT_OPTIONS,
  CATALOG_SCOPED_KINDS,
  CODE_PLAN_MODE,
  CURSOR_MODEL_SPECS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORT_OPTIONS,
  FX_AUTO_RESUME_MAX,
  FX_PROVIDER_STATUS_PREFIX,
  FX_RECOVERY_STATUS_PREFIX,
  FX_SESSION_TITLE_STATUS_PREFIX,
  FX_USAGE_STATUS_PREFIX,
  MODEL_EFFORT_SUPPORT,
  MODEL_MIN_CLI_VERSION,
  PERMISSION_MODE_STATUS_PREFIX,
  defaultModeFor,
  isInternalStatusSentinel,
  retainableEfforts,
  supportedEfforts,
  supportedModes,
  type AgentKind,
  type GlobalEvent,
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

test("DEFAULT_MODEL.fx is deepseek/deepseek-v4-flash (owner D21, 2026-10-22) and is the first AGENT_OPTIONS.fx.models row, non-catalogOnly", () => {
  expect(DEFAULT_MODEL.fx).toBe("deepseek/deepseek-v4-flash");
  expect(AGENT_OPTIONS.fx.models[0]?.id).toBe(DEFAULT_MODEL.fx);
  const defaultRow = AGENT_OPTIONS.fx.models.find((m) => m.id === DEFAULT_MODEL.fx);
  expect(defaultRow?.catalogOnly).toBeFalsy();
});

test("the previous fx default zai/glm-5.3-flash stays a standard (non-catalogOnly) row, and spacexai/grok-4.7 stays catalogOnly", () => {
  const byId = new Map(AGENT_OPTIONS.fx.models.map((m) => [m.id, m]));
  expect(byId.get("zai/glm-5.3-flash")).toBeDefined();
  expect(byId.get("zai/glm-5.3-flash")?.catalogOnly).toBeFalsy();
  expect(byId.get("spacexai/grok-4.7")?.catalogOnly).toBe(true);
});

const RETIRED_FX_IDS = ["alibaba/qwen3-coder-plus", "mistral/devstral-2", "anthropic/claude-3-haiku"];

test("the three retired fx ids (D10) are absent from both AGENT_OPTIONS.fx.models and MODEL_EFFORT_SUPPORT.fx", () => {
  const ids = AGENT_OPTIONS.fx.models.map((m) => m.id);
  for (const id of RETIRED_FX_IDS) {
    expect(ids).not.toContain(id);
    expect(Object.keys(MODEL_EFFORT_SUPPORT.fx)).not.toContain(id);
  }
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

/* ── fx effort (docs/plans/fx-0.0.14-and-cursor-updates.md §3.4 / T1) ────── */

// The 40 effort-advertising ids. Twenty were refreshed on 2026-10-22 against
// fx 0.0.14's `models --json` `models[].efforts` (plus fx's always-present
// `auto`) — the plan §3.4 table, copied verbatim; the other eleven are
// unchanged from their earlier live-probe (fx 0.0.10, 2026-09-14) or Gateway
// `reasoning_options` measurement. Every row ends in "auto" (fx's own
// default, off-scale) and lists ids in agetor order (max, xhigh, high,
// medium, low, minimal, none, auto).
const FX_EFFORT_MODELS: Record<string, string[]> = {
  // Refreshed 2026-10-22 (plan §3.4).
  "zai/glm-5v-turbo": ["high", "medium", "low", "none", "auto"],
  "zai/glm-4.7": ["high", "medium", "low", "none", "auto"],
  "openai/gpt-5.2": ["xhigh", "high", "medium", "low", "minimal", "none", "auto"],
  "openai/gpt-5.1-codex-max": ["high", "medium", "low", "none", "auto"],
  "openai/gpt-5.4-mini": ["xhigh", "high", "medium", "low", "minimal", "none", "auto"],
  "spacexai/grok-4.6": ["xhigh", "high", "medium", "low", "auto"],
  "spacexai/grok-build-0.1": ["high", "medium", "low", "none", "auto"],
  "moonshotai/kimi-k2.7-code": ["high", "medium", "low", "none", "auto"],
  "deepseek/deepseek-v4-flash": ["high", "medium", "low", "none", "auto"],
  "alibaba/qwen3.8-flash": ["xhigh", "medium", "low", "auto"],
  "google/gemini-2.5-flash": ["high", "medium", "low", "none", "auto"],
  "anthropic/claude-opus-5": ["max", "xhigh", "high", "medium", "low", "none", "auto"],
  "anthropic/claude-sonnet-5": ["max", "xhigh", "high", "medium", "low", "none", "auto"],
  "openai/gpt-5.5": ["xhigh", "high", "medium", "low", "minimal", "none", "auto"],
  "google/gemini-3.1-pro-preview": ["high", "low", "auto"],
  "google/gemini-3.8-flash": ["high", "low", "auto"],
  "anthropic/claude-fable-5.1": ["max", "xhigh", "high", "medium", "low", "auto"],
  "openai/gpt-5.6-sol": ["max", "xhigh", "high", "medium", "low", "minimal", "none", "auto"],
  "deepseek/deepseek-v4-pro": ["max", "high", "low", "none", "auto"],
  "spacexai/grok-4.7": ["xhigh", "high", "medium", "low", "auto"],
  // Unchanged by the 0.0.14 refresh.
  "zai/glm-5.3-flash": ["max", "high", "low", "auto"],
  "moonshotai/kimi-k3": ["max", "high", "low", "auto"],
  "openai/gpt-6-astra": ["max", "xhigh", "high", "medium", "low", "auto"],
  "zai/glm-5.3": ["max", "high", "low", "auto"],
  "anthropic/claude-opus-5.5": ["max", "xhigh", "high", "medium", "low", "auto"],
  "openai/gpt-6-sol": ["max", "xhigh", "high", "medium", "low", "none", "auto"],
  "openai/gpt-6-luna": ["max", "xhigh", "high", "medium", "low", "none", "auto"],
  "anthropic/claude-sonnet-5.5": ["max", "xhigh", "high", "medium", "low", "auto"],
  "openai/gpt-6.1-sol": ["max", "xhigh", "high", "medium", "low", "auto"],
  "anthropic/claude-haiku-5.5": ["max", "xhigh", "high", "medium", "low", "none", "auto"],
  "google/gemini-4-argon": ["high", "medium", "low", "auto"],
  // 2026-10-26 (docs/plans/add-gpt-6-1-terra.md): nine new rows. Each set is
  // the Gateway `reasoning_options` plus `auto`, confirmed identical to fx
  // 0.0.14's `models[].efforts` (plan §2b; Mercury 3 minus fx's `instant`).
  "openai/gpt-6.1-terra": ["max", "xhigh", "high", "medium", "low", "none", "auto"],
  "minimax/minimax-m3.1-flash": ["max", "xhigh", "high", "medium", "low", "auto"],
  "meta/muse-spark-open": ["xhigh", "high", "medium", "low", "auto"],
  "inception/mercury-3": ["high", "medium", "low", "auto"],
  "moonshotai/kimi-k3.1-pro": ["max", "high", "low", "auto"],
  "deepseek/deepseek-v4.1-flash-1017": ["max", "high", "low", "none", "auto"],
  "meta/muse-wonder-1.0": ["max", "xhigh", "high", "medium", "low", "minimal", "auto"],
  "mistral/mistral-large-4": ["high", "none", "auto"],
  "reflection/beam": ["max", "xhigh", "high", "medium", "low", "auto"],
};

// The 2 no-effort ids left — the picker collapses for them, same treatment
// as every gemini model.
const FX_NO_EFFORT_MODELS = ["minimax/minimax-m3", "anthropic/claude-haiku-4.5"];

const AGETOR_EFFORT_ORDER = ["max", "xhigh", "high", "medium", "low", "minimal", "none", "auto"];

test("MODEL_EFFORT_SUPPORT.fx exactly matches the 0.0.14-refreshed table — 40 effort models in agetor order each end in auto, 2 named models are empty", () => {
  for (const [id, expected] of Object.entries(FX_EFFORT_MODELS)) {
    expect(MODEL_EFFORT_SUPPORT.fx[id]).toEqual(expected);
    expect(expected[expected.length - 1]).toBe("auto");
    expect(expected).toEqual(AGETOR_EFFORT_ORDER.filter((e) => expected.includes(e)));
  }
  for (const id of FX_NO_EFFORT_MODELS) {
    expect(MODEL_EFFORT_SUPPORT.fx[id]).toEqual([]);
  }
  // The two lists above are exactly the 42 curated fx ids, no more no less.
  expect(Object.keys(FX_EFFORT_MODELS).length).toBe(40);
  expect(FX_NO_EFFORT_MODELS.length).toBe(2);
  expect(Object.keys(MODEL_EFFORT_SUPPORT.fx).length).toBe(42);
  expect(AGENT_OPTIONS.fx.models.length).toBe(42);
});

test("DEFAULT_EFFORT.fx is 'auto' (fx's own default — owner decision D1, docs/plans/fx-0.0.10-compat.md §8)", () => {
  expect(DEFAULT_EFFORT.fx).toBe("auto");
});

test("EFFORT_OPTIONS: ultra is first, auto ('Model default') is last", () => {
  expect(EFFORT_OPTIONS[0]?.id).toBe("ultra");
  const last = EFFORT_OPTIONS[EFFORT_OPTIONS.length - 1];
  expect(last?.id).toBe("auto");
  expect(last?.label).toBe("Model default");
});

test("no non-fx kind's MODEL_EFFORT_SUPPORT table lists 'auto' — it is fx-only", () => {
  for (const kind of KINDS) {
    if (kind === "fx") continue;
    for (const ids of Object.values(MODEL_EFFORT_SUPPORT[kind])) {
      expect(ids).not.toContain("auto");
    }
  }
});

test("supportedEfforts('fx', 'deepseek/deepseek-v4-flash') — the default — returns exactly [high, medium, low, none, auto]", () => {
  const ids = supportedEfforts("fx", "deepseek/deepseek-v4-flash").map((o) => o.id);
  expect(ids).toEqual(["high", "medium", "low", "none", "auto"]);
});

test("supportedEfforts('fx', 'zai/glm-5.3-flash') returns exactly [max, high, low, auto] in canonical order", () => {
  const ids = supportedEfforts("fx", "zai/glm-5.3-flash").map((o) => o.id);
  expect(ids).toEqual(["max", "high", "low", "auto"]);
});

test("supportedEfforts('fx', 'openai/gpt-5.2') surfaces minimal between low and none", () => {
  const ids = supportedEfforts("fx", "openai/gpt-5.2").map((o) => o.id);
  expect(ids).toEqual(["xhigh", "high", "medium", "low", "minimal", "none", "auto"]);
});

test("supportedEfforts('fx', 'minimax/minimax-m3') is empty (no-effort model)", () => {
  expect(supportedEfforts("fx", "minimax/minimax-m3")).toEqual([]);
});

test("supportedEfforts('fx', <unknown id>) falls back to DEFAULT_MODEL.fx's set (deepseek/deepseek-v4-flash's)", () => {
  const fallback = supportedEfforts("fx", "vendor/unknown-model").map((o) => o.id);
  const curated = supportedEfforts("fx", DEFAULT_MODEL.fx).map((o) => o.id);
  expect(fallback).toEqual(curated);
  expect(fallback).toEqual(["high", "medium", "low", "none", "auto"]);
});

test("supportedEfforts('fx', …) lets a discovered models[].efforts set (plus auto) win over the curated table", () => {
  const ids = supportedEfforts("fx", "deepseek/deepseek-v4-flash", ["xhigh", "high", "auto"]).map((o) => o.id);
  expect(ids).toEqual(["xhigh", "high", "auto"]);
});

test("retainableEfforts('fx', 'deepseek/deepseek-v4-flash') contains 'auto'", () => {
  const retained = retainableEfforts("fx", "deepseek/deepseek-v4-flash");
  expect(retained.has("auto")).toBe(true);
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

test("exactly the twenty-six catalog-gated Gateway ids are catalogOnly in AGENT_OPTIONS.fx, and no other kind's models use catalogOnly", () => {
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
    // 2026-09-21 (docs/plans/add-grok-4-7.md) — signed-in presence unverified,
    // same reason google/gemini-3.8-flash is gated.
    "spacexai/grok-4.7",
    // 2026-09-22 (docs/plans/add-claude-opus-5-5.md) — signed-in presence
    // unverified, same reason as grok-4.7.
    "anthropic/claude-opus-5.5",
    // 2026-09-22 (docs/plans/add-gpt-6-sol-and-luna.md) — released the same
    // day; signed-in presence unverified, same treatment as the rows above.
    "openai/gpt-6-sol",
    "openai/gpt-6-luna",
    // 2026-09-28 (docs/plans/add-claude-sonnet-5-5.md) — signed-in presence
    // unverified, same reason as opus-5.5.
    "anthropic/claude-sonnet-5.5",
    // 2026-09-30 (docs/plans/add-gpt-6-1-sol.md) — released 2026-09-29;
    // signed-in presence unverified, same treatment as the rows above.
    "openai/gpt-6.1-sol",
    // 2026-10-07 (docs/plans/add-haiku-5-5.md) — signed-in presence
    // unverified, same treatment as the rows above.
    "anthropic/claude-haiku-5.5",
    // 2026-10-14 (docs/plans/add-gemini-4-argon.md) — released 2026-10-13;
    // signed-in presence unverified, same treatment as the rows above.
    "google/gemini-4-argon",
    // 2026-10-26 (docs/plans/add-gpt-6-1-terra.md) — gated by absence from the
    // owner's signed-in catalog (fx 0.0.14 re-measure, plan §2b).
    "openai/gpt-6.1-terra",
    "moonshotai/kimi-k3.1-pro",
    "deepseek/deepseek-v4.1-flash-1017",
    "meta/muse-wonder-1.0",
    "mistral/mistral-large-4",
    "reflection/beam",
  ]);
  const actualCatalogOnly = new Set(
    AGENT_OPTIONS.fx.models.filter((m) => m.catalogOnly).map((m) => m.id),
  );
  expect(actualCatalogOnly).toEqual(expectedCatalogOnly);
  expect(actualCatalogOnly.size).toBe(26);

  for (const kind of KINDS) {
    if (kind === "fx") continue;
    for (const model of AGENT_OPTIONS[kind].models) {
      expect(model.catalogOnly).toBeFalsy();
    }
  }
});

test("the three fx rows added 2026-10-26 whose models are in the signed-in catalog are standard (non-catalogOnly)", () => {
  // docs/plans/add-gpt-6-1-terra.md §2b: gating follows signed-in presence.
  const byId = new Map(AGENT_OPTIONS.fx.models.map((m) => [m.id, m]));
  for (const id of ["minimax/minimax-m3.1-flash", "meta/muse-spark-open", "inception/mercury-3"]) {
    const row = byId.get(id);
    expect(row, id).toBeDefined();
    expect(row?.catalogOnly, id).toBeFalsy();
  }
});

test("deepseek/deepseek-v4.1-flash-1017 sits directly below the default at index 1 (the default stays first)", () => {
  const ids = AGENT_OPTIONS.fx.models.map((m) => m.id);
  expect(ids[0]).toBe(DEFAULT_MODEL.fx);
  expect(ids[1]).toBe("deepseek/deepseek-v4.1-flash-1017");
});

test("each fx successor row sits directly above its predecessor (M3.1 Flash above M3, Kimi K3.1 Pro above K3)", () => {
  const ids = AGENT_OPTIONS.fx.models.map((m) => m.id);
  const pairs: [string, string][] = [
    ["minimax/minimax-m3.1-flash", "minimax/minimax-m3"],
    ["moonshotai/kimi-k3.1-pro", "moonshotai/kimi-k3"],
  ];
  for (const [successor, predecessor] of pairs) {
    expect(ids.indexOf(successor), successor).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(successor), successor).toBe(ids.indexOf(predecessor) - 1);
  }
});

test("every AGENT_OPTIONS.fx.models id has an entry in MODEL_EFFORT_SUPPORT.fx and vice versa (twenty-six catalogOnly rows included)", () => {
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

test("cursor offers auto / plan / ask (D23) and CODE_PLAN_MODE.cursor maps Plan to its native plan mode", () => {
  expect(AGENT_OPTIONS.cursor.modes.map((m) => m.id)).toEqual(["auto", "plan", "ask"]);
  expect(supportedModes("cursor", null).map((m) => m.id)).toEqual(["auto", "plan", "ask"]);
  const byId = new Map(AGENT_OPTIONS.cursor.modes.map((m) => [m.id, m]));
  expect(byId.get("auto")?.label).toBe("Auto (force)");
  expect(byId.get("plan")?.label).toBe("Plan");
  expect(byId.get("plan")?.hint).toBe("Read-only planning — cursor-agent --mode plan. Approve the plan to implement.");
  expect(byId.get("ask")?.label).toBe("Read-only");
  expect(byId.get("ask")?.hint).toBe("Read-only Q&A — cursor-agent --mode ask. Answers questions, makes no edits.");
  expect(CODE_PLAN_MODE.cursor).toEqual({ code: "auto", plan: "plan" });
  expect(defaultModeFor("cursor")).toBe("auto");
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

test("DEFAULT_MODEL.gemini stays gemini-3.1-pro-preview (owner D1) while gemini-4-argon heads the picker above it", () => {
  expect(DEFAULT_MODEL.gemini).toBe("gemini-3.1-pro-preview");
  expect(AGENT_OPTIONS.gemini.models[0]?.id).toBe("gemini-4-argon");
  const defaultRow = AGENT_OPTIONS.gemini.models.find((m) => m.id === DEFAULT_MODEL.gemini);
  expect(defaultRow).toBeDefined();
  expect(defaultRow?.hint?.startsWith("Recommended default")).toBe(true);
});

test("the gemini picker offers gemini-3.8-flash and no longer offers the shut-down gemini-3-pro-preview", () => {
  const ids = AGENT_OPTIONS.gemini.models.map((m) => m.id);
  expect(ids).toContain("gemini-3.8-flash");
  expect(ids).not.toContain("gemini-3-pro-preview");
  expect(Object.keys(MODEL_EFFORT_SUPPORT.gemini)).not.toContain("gemini-3-pro-preview");
});

test("the gemini picker offers gemini-4-argon and no longer offers the deprecated 3.7 / 3.5 Flash (migration 066)", () => {
  const ids = AGENT_OPTIONS.gemini.models.map((m) => m.id);
  expect(ids).toContain("gemini-4-argon");
  expect(ids).not.toContain("gemini-3.7-flash");
  expect(ids).not.toContain("gemini-3.5-flash");
  const effortKeys = Object.keys(MODEL_EFFORT_SUPPORT.gemini);
  expect(effortKeys).toContain("gemini-4-argon");
  expect(effortKeys).not.toContain("gemini-3.7-flash");
  expect(effortKeys).not.toContain("gemini-3.5-flash");
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

test("gemini picker is tier-ordered: Gemini 4 first, then Pro rows, then Flash rows newest-first", () => {
  const ids = AGENT_OPTIONS.gemini.models.map((m) => m.id);
  expect(ids).toEqual([
    "gemini-4-argon",
    "gemini-3.1-pro-preview",
    "gemini-2.5-pro",
    "gemini-3.8-flash",
    "gemini-3.8-flash-cyber",
    "gemini-2.5-flash",
  ]);
});

test("the gemini-4-argon row's hint names the paid-API-key requirement (Gemini CLI no longer serves AI Pro/Ultra) and the medium default thinking, and gemini has no CLI version floor (owner D2)", () => {
  const row = AGENT_OPTIONS.gemini.models.find((m) => m.id === "gemini-4-argon");
  expect(row?.hint).toContain("paid Gemini API");
  expect(row?.hint).toContain("not the API free tier");
  expect(row?.hint).toContain("Antigravity harness");
  // Gemini CLI stopped serving Google AI Pro/Ultra on 2026-06-18, so the hint
  // must never present an Ultra plan as a way to run this row.
  expect(row?.hint).not.toMatch(/Needs Google AI Ultra/);
  expect(row?.hint).toContain("medium");
  expect(MODEL_MIN_CLI_VERSION.gemini).toBeUndefined();
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
  // Gemini 4 Argon sits above the whole Flash run (spec insertion order is
  // picker order).
  const iArgon = ids.indexOf("gemini-4-argon");
  expect(iArgon).toBeGreaterThanOrEqual(0);
  expect(iArgon).toBeLessThan(i38);

  for (const id of ["gemini-4-argon", "gemini-3.8-flash", "gemini-3.7-flash"]) {
    const spec = CURSOR_MODEL_SPECS[id];
    expect(spec).toBeDefined();
    expect(Object.keys(spec?.effortIds ?? {}).sort()).toEqual(["high", "low", "medium"]);
    expect(spec?.fastEfforts).toBeUndefined();
    expect(spec?.fastId).toBeUndefined();
    expect(spec?.supportsMaxMode).toBeUndefined();
  }
});

/* ── antigravity: Gemini 4 Argon rows + effort-in-id (docs/plans/add-gemini-4-argon.md) ── */

test("antigravity picker leads with the three Gemini 4 Argon effort rows, and the default stays 3.8 Flash (High) right behind them", () => {
  const ids = AGENT_OPTIONS.antigravity.models.map((m) => m.id);
  expect(ids.slice(0, 3)).toEqual([
    "gemini-4-argon-high",
    "gemini-4-argon-medium",
    "gemini-4-argon-low",
  ]);
  expect(DEFAULT_MODEL.antigravity).toBe("gemini-3.8-flash-high");
  expect(ids.indexOf(DEFAULT_MODEL.antigravity)).toBe(3);
  expect(AGENT_OPTIONS.antigravity.models.slice(0, 3).map((m) => m.label)).toEqual([
    "Gemini 4 Argon (High)",
    "Gemini 4 Argon (Medium)",
    "Gemini 4 Argon (Low)",
  ]);
});

test("antigravity no longer offers the deprecated 3.7 Flash rows (migration 066), still 18 curated rows", () => {
  const ids = AGENT_OPTIONS.antigravity.models.map((m) => m.id);
  for (const id of ids) expect(id.startsWith("gemini-3.7-flash")).toBe(false);
  expect(ids.length).toBe(18);
});

test("MODEL_EFFORT_SUPPORT.antigravity keys exactly match the antigravity picker ids (both directions) and every value is empty — effort rides in the id", () => {
  const catalogIds = new Set(AGENT_OPTIONS.antigravity.models.map((m) => m.id));
  const effortKeys = new Set(Object.keys(MODEL_EFFORT_SUPPORT.antigravity));
  for (const id of catalogIds) expect(effortKeys.has(id)).toBe(true);
  for (const key of effortKeys) expect(catalogIds.has(key)).toBe(true);
  expect(effortKeys.size).toBe(catalogIds.size);
  for (const supported of Object.values(MODEL_EFFORT_SUPPORT.antigravity)) {
    expect(supported).toEqual([]);
  }
});

test("every antigravity Gemini 4 Argon hint flags the id as unconfirmed and points at `agy models`", () => {
  const argon = AGENT_OPTIONS.antigravity.models.filter((m) => m.id.startsWith("gemini-4-argon-"));
  expect(argon.length).toBe(3);
  for (const row of argon) {
    expect(row.hint).toContain("unconfirmed");
    expect(row.hint).toContain("agy models");
    expect(row.hint).toContain("AI Ultra");
  }
});

/* ── defaultModeFor (docs/plans/fx-recovery-follow-ups.md §3.6) ─────────── */

test("defaultModeFor: auto for every AgentKind except fx, which is yolo (Full access)", () => {
  for (const kind of KINDS) {
    expect(defaultModeFor(kind)).toBe(kind === "fx" ? "yolo" : "auto");
  }
  // Explicit, non-loop pins so a future kind added to the union can't
  // silently change fx's own expectation without this test noticing.
  expect(defaultModeFor("claude-code")).toBe("auto");
  expect(defaultModeFor("codex")).toBe("auto");
  expect(defaultModeFor("cursor")).toBe("auto");
  expect(defaultModeFor("gemini")).toBe("auto");
  expect(defaultModeFor("fx")).toBe("yolo");
});

test("defaultModeFor: always equals AGENT_OPTIONS[kind].modes[0].id — the single source of truth it's defined against", () => {
  for (const kind of KINDS) {
    const modesFirstId = AGENT_OPTIONS[kind].modes[0]?.id;
    expect(modesFirstId).toBeDefined();
    expect(defaultModeFor(kind)).toBe(modesFirstId as string);
  }
});

/* ── GlobalEvent discriminated union — "fx-auto-resume" kind ────────────── */

// Compile-time exhaustiveness guard: if a new GlobalEvent.kind is ever added
// without a case here, `bun run typecheck` fails at the `default` branch
// below (assertNever's `never` parameter rejects anything still assignable).
// This is what proves the new "fx-auto-resume" kind — and every existing one
// — type-checks cleanly in a discriminated switch, not just that an object
// literal happens to satisfy the union.
function assertNever(x: never): never {
  throw new Error(`unhandled GlobalEvent kind: ${JSON.stringify(x)}`);
}

function describeGlobalEvent(event: GlobalEvent): string {
  switch (event.kind) {
    case "run-status":
      return `run-status:${event.status}`;
    case "column":
      return `column:${event.column}`;
    case "update":
      return `update:${event.status}`;
    case "interaction":
      return `interaction:${event.state}`;
    case "files-sent":
      return `files-sent:${event.count}`;
    case "fx-auto-resume":
      return `fx-auto-resume:${event.state}`;
    case "pipeline":
      return `pipeline:${event.status}`;
    case "send-failed":
      return `send-failed:${event.savedToBacklog}`;
    default:
      return assertNever(event);
  }
}

test("GlobalEvent: the \"fx-auto-resume\" kind type-checks in a discriminated switch alongside every other kind", () => {
  const scheduled: GlobalEvent = {
    kind: "fx-auto-resume",
    taskId: "t1",
    state: "scheduled",
    at: Date.now() + 120_000,
    attempt: 1,
    max: FX_AUTO_RESUME_MAX,
    ts: Date.now(),
  };
  expect(describeGlobalEvent(scheduled)).toBe("fx-auto-resume:scheduled");

  // Every documented state value round-trips through the same switch with no
  // cast required — `at` is intentionally omitted here (it's only present
  // for `state: "scheduled"`), matching the field's own doc comment.
  for (const state of ["scheduled", "fired", "cancelled", "exhausted", "disabled"] as const) {
    const event: GlobalEvent = { kind: "fx-auto-resume", taskId: "t1", state, attempt: 1, max: FX_AUTO_RESUME_MAX, ts: 0 };
    expect(describeGlobalEvent(event)).toBe(`fx-auto-resume:${state}`);
  }

  // Sanity: a couple of the pre-existing kinds still route through the same
  // switch correctly, proving the new case was added without disturbing it.
  expect(describeGlobalEvent({ kind: "run-status", taskId: "t1", runId: "r1", status: "succeeded", ts: 0 }))
    .toBe("run-status:succeeded");
  expect(describeGlobalEvent({ kind: "files-sent", taskId: "t1", runId: "r1", count: 2, caption: null, proactive: false, ts: 0 }))
    .toBe("files-sent:2");
});

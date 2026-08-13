import { describe, expect, test } from "bun:test";
import { parseCursorUsage } from "./cursor-usage.ts";

// `parseCursorUsage` is pure (no I/O, no network) — these tests are hermetic
// and use only inline, synthetic (redacted) fixtures. Cursor's `usage-summary`
// schema is undocumented/reverse-engineered, so the parser probes several
// plausible field names defensively (see module doc in cursor-usage.ts);
// these tests assert exactly the field-probing order the code implements.
const FETCHED_AT_MS = 1_755_000_000_000;

describe("parseCursorUsage — plan meter, usedPercent-style summary", () => {
  test("usedPercent + billingCycleEnd maps to a plan meter with resetsAtMs", () => {
    const { meters, planType } = parseCursorUsage(
      { usedPercent: 42, billingCycleEnd: "2026-09-01T00:00:00Z" },
      null,
      FETCHED_AT_MS,
    );
    expect(meters).toHaveLength(1);
    expect(meters[0]).toMatchObject({
      id: "plan",
      label: "Plan usage",
      usedPercent: 42,
      resetsAtMs: Date.parse("2026-09-01T00:00:00Z"),
    });
    expect(planType).toBeNull();
  });

  test("resetAt takes priority over billingCycleEnd when both are present", () => {
    const { meters } = parseCursorUsage(
      { usedPercent: 10, resetAt: "2026-08-20T00:00:00Z", billingCycleEnd: "2026-09-01T00:00:00Z" },
      null,
      FETCHED_AT_MS,
    );
    expect(meters[0]?.resetsAtMs).toBe(Date.parse("2026-08-20T00:00:00Z"));
  });

  test("no reset field present yields resetsAtMs: null", () => {
    const { meters } = parseCursorUsage({ usedPercent: 10 }, null, FETCHED_AT_MS);
    expect(meters).toHaveLength(1);
    expect(meters[0]?.resetsAtMs).toBeNull();
  });
});

describe("parseCursorUsage — plan meter, used/limit pair", () => {
  test("used/limit computes a percentage when no direct percent field is present", () => {
    const { meters } = parseCursorUsage({ used: 30, limit: 120 }, null, FETCHED_AT_MS);
    expect(meters).toHaveLength(1);
    expect(meters[0]).toMatchObject({ id: "plan", usedPercent: 25 });
  });

  test("a direct percent field wins over a used/limit pair when both are present", () => {
    const { meters } = parseCursorUsage({ usedPercent: 77, used: 1, limit: 2 }, null, FETCHED_AT_MS);
    expect(meters[0]?.usedPercent).toBe(77);
  });

  test("limit: 0 is treated as unusable and produces no plan meter from the used/limit fallback", () => {
    const { meters } = parseCursorUsage({ used: 5, limit: 0 }, null, FETCHED_AT_MS);
    expect(meters).toHaveLength(0);
  });

  test("nested plan.used / plan.limit is also probed", () => {
    const { meters } = parseCursorUsage({ plan: { used: 10, limit: 40 } }, null, FETCHED_AT_MS);
    expect(meters).toHaveLength(1);
    expect(meters[0]?.usedPercent).toBe(25);
  });
});

describe("parseCursorUsage — on-demand/overage meter", () => {
  test("a direct onDemand.usedPercent field produces its own meter", () => {
    const { meters } = parseCursorUsage(
      { usedPercent: 10, onDemand: { usedPercent: 5, resetAt: "2026-09-05T00:00:00Z" } },
      null,
      FETCHED_AT_MS,
    );
    expect(meters).toHaveLength(2);
    const onDemand = meters.find((m) => m.id === "on-demand");
    expect(onDemand).toMatchObject({
      id: "on-demand",
      label: "On-demand",
      usedPercent: 5,
      resetsAtMs: Date.parse("2026-09-05T00:00:00Z"),
    });
  });

  test("a used/budget pair under onDemand computes a percentage", () => {
    const { meters } = parseCursorUsage(
      { usedPercent: 10, onDemand: { used: 25, limit: 50 } },
      null,
      FETCHED_AT_MS,
    );
    const onDemand = meters.find((m) => m.id === "on-demand");
    expect(onDemand?.usedPercent).toBe(50);
  });

  test("overage.usedPercent (an alternate probed field name) also works", () => {
    const { meters } = parseCursorUsage(
      { usedPercent: 10, overage: { usedPercent: 15 } },
      null,
      FETCHED_AT_MS,
    );
    const onDemand = meters.find((m) => m.id === "on-demand");
    expect(onDemand?.usedPercent).toBe(15);
  });

  test("on-demand reset falls back to the plan meter's resetsAtMs when onDemand/overage have none", () => {
    const { meters } = parseCursorUsage(
      { usedPercent: 10, resetAt: "2026-08-20T00:00:00Z", onDemand: { usedPercent: 5 } },
      null,
      FETCHED_AT_MS,
    );
    const plan = meters.find((m) => m.id === "plan");
    const onDemand = meters.find((m) => m.id === "on-demand");
    expect(onDemand?.resetsAtMs).toBe(plan?.resetsAtMs);
  });

  test("no on-demand fields at all means no on-demand meter is emitted", () => {
    const { meters } = parseCursorUsage({ usedPercent: 10 }, null, FETCHED_AT_MS);
    expect(meters.find((m) => m.id === "on-demand")).toBeUndefined();
  });
});

describe("parseCursorUsage — planType extraction", () => {
  test("planType is read from meJson when present, preferred over summaryJson", () => {
    const { planType } = parseCursorUsage(
      { usedPercent: 10, plan: "team" },
      { plan: "pro" },
      FETCHED_AT_MS,
    );
    expect(planType).toBe("pro");
  });

  test("planType falls back to summaryJson when meJson has none", () => {
    const { planType } = parseCursorUsage(
      { usedPercent: 10, planType: "team" },
      { somethingElse: true },
      FETCHED_AT_MS,
    );
    expect(planType).toBe("team");
  });

  test("planType is null when neither summary nor me expose a recognizable field", () => {
    const { planType } = parseCursorUsage({ usedPercent: 10 }, { unrelated: "x" }, FETCHED_AT_MS);
    expect(planType).toBeNull();
  });
});

describe("parseCursorUsage — garbage/empty/null input", () => {
  test("null summaryJson returns an empty, non-throwing result", () => {
    expect(parseCursorUsage(null, null, FETCHED_AT_MS)).toEqual({ meters: [], planType: null });
  });

  test("undefined summaryJson returns an empty, non-throwing result", () => {
    expect(parseCursorUsage(undefined, null, FETCHED_AT_MS)).toEqual({ meters: [], planType: null });
  });

  test("a non-object summaryJson (string) returns an empty, non-throwing result", () => {
    expect(() => parseCursorUsage("not json", null, FETCHED_AT_MS)).not.toThrow();
    expect(parseCursorUsage("not json", null, FETCHED_AT_MS)).toEqual({ meters: [], planType: null });
  });

  test("a non-object summaryJson (number) returns an empty, non-throwing result", () => {
    expect(parseCursorUsage(42, null, FETCHED_AT_MS)).toEqual({ meters: [], planType: null });
  });

  test("an empty object summaryJson with no recognizable fields yields no meters and null planType", () => {
    expect(parseCursorUsage({}, {}, FETCHED_AT_MS)).toEqual({ meters: [], planType: null });
  });

  test("an unrecognized summaryJson shape (no matching field names at all) does not throw and yields no meters", () => {
    expect(() =>
      parseCursorUsage({ someTotallyUnrelatedField: 123 }, { alsoUnrelated: true }, FETCHED_AT_MS),
    ).not.toThrow();
    const { meters, planType } = parseCursorUsage(
      { someTotallyUnrelatedField: 123 },
      { alsoUnrelated: true },
      FETCHED_AT_MS,
    );
    expect(meters).toEqual([]);
    expect(planType).toBeNull();
  });
});

describe("parseCursorUsage — confirmed live shape (individualUsage, 2026-08)", () => {
  // Redacted real pro_plus response shape, verified live 2026-08-13.
  const liveSummary = {
    billingCycleStart: "2026-08-08T20:58:45.000Z",
    billingCycleEnd: "2026-09-08T20:58:45.000Z",
    membershipType: "pro_plus",
    limitType: "user",
    isUnlimited: false,
    individualUsage: {
      plan: {
        enabled: true,
        used: 7000,
        limit: 7000,
        remaining: 0,
        breakdown: { included: 7000, bonus: 32742, total: 39742 },
        autoPercentUsed: 40.84,
        apiPercentUsed: 64.27,
        totalPercentUsed: 43.67,
      },
      onDemand: { enabled: true, used: 0, limit: 5000, remaining: 5000 },
    },
    teamUsage: {},
  };

  test("maps total/auto/api + on-demand meters with billing-cycle reset", () => {
    const { meters, planType } = parseCursorUsage(liveSummary, null, 0);
    expect(meters.map((m) => m.id)).toEqual(["plan", "auto", "api", "on-demand"]);
    const byId = Object.fromEntries(meters.map((m) => [m.id, m]));
    expect(byId["plan"]!.usedPercent).toBeCloseTo(43.67, 1);
    expect(byId["plan"]!.label).toBe("Plan (total)");
    expect(byId["auto"]!.usedPercent).toBeCloseTo(40.84, 1);
    expect(byId["api"]!.usedPercent).toBeCloseTo(64.27, 1);
    expect(byId["on-demand"]!.usedPercent).toBe(0);
    const cycleEnd = Date.parse("2026-09-08T20:58:45.000Z");
    for (const m of meters) expect(m.resetsAtMs).toBe(cycleEnd);
    expect(planType).toBe("pro_plus");
  });

  test("uses totalPercentUsed, NOT the misleading used/limit pair (bonus credits extend the quota)", () => {
    // used===limit (7000/7000) would read 100%; the live branch must report
    // totalPercentUsed (43.67) instead of falling into the legacy pair math.
    const { meters } = parseCursorUsage(liveSummary, null, 0);
    const plan = meters.find((m) => m.id === "plan")!;
    expect(plan.usedPercent).toBeLessThan(50);
  });

  test("skips on-demand when limit is 0, keeps percent meters", () => {
    const s = structuredClone(liveSummary);
    s.individualUsage.onDemand.limit = 0;
    const { meters } = parseCursorUsage(s, null, 0);
    expect(meters.map((m) => m.id)).toEqual(["plan", "auto", "api"]);
  });

  test("individualUsage present but empty falls back to legacy probing without throwing", () => {
    const { meters, planType } = parseCursorUsage(
      { individualUsage: { plan: {} }, membershipType: "pro" },
      null,
      0,
    );
    expect(meters).toEqual([]);
    expect(planType).toBe("pro");
  });
});

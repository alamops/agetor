import { describe, expect, test } from "bun:test";
import { parseClaudeUsage } from "./claude-usage.ts";

// `parseClaudeUsage` is pure (no I/O, no network) — these tests are hermetic
// and use only inline, synthetic (redacted) fixtures. The extra positional
// args (harnessId/kind/source/fetchedAtMs) don't affect meter output, so a
// fixed set of stand-in values is reused across every call.
const HARNESS_ID = "claude-code-default";
const KIND = "claude-code" as const;
const SOURCE = "api" as const;
const FETCHED_AT_MS = 1_755_000_000_000;

function parse(json: unknown) {
  return parseClaudeUsage(json, HARNESS_ID, KIND, SOURCE, FETCHED_AT_MS);
}

describe("parseClaudeUsage — scalar shape", () => {
  test("maps all five scalar fields with correct percent, resetsAtMs, and scope", () => {
    const json = {
      five_hour: { utilization: 0.28, resets_at: "2026-08-12T17:00:00Z" },
      seven_day: { utilization: 0.55, resets_at: "2026-08-15T00:00:00Z" },
      seven_day_opus: { utilization: 0.1, resets_at: "2026-08-15T00:00:00Z" },
      seven_day_sonnet: { utilization: 0.2, resets_at: "2026-08-15T00:00:00Z" },
      seven_day_routines: { utilization: 0.05, resets_at: "2026-08-13T00:00:00Z" },
    };

    const meters = parse(json);
    expect(meters).toHaveLength(5);

    const byId = new Map(meters.map((m) => [m.id, m]));

    const fiveHour = byId.get("five_hour");
    expect(fiveHour).toBeDefined();
    expect(fiveHour?.usedPercent).toBe(28);
    expect(fiveHour?.resetsAtMs).toBe(Date.parse("2026-08-12T17:00:00Z"));
    expect(fiveHour?.scope).toBeUndefined();

    const sevenDay = byId.get("seven_day");
    expect(sevenDay?.usedPercent).toBe(55);
    expect(sevenDay?.resetsAtMs).toBe(Date.parse("2026-08-15T00:00:00Z"));

    const opus = byId.get("seven_day_opus");
    expect(opus?.usedPercent).toBe(10);
    expect(opus?.scope).toBe("Opus");

    const sonnet = byId.get("seven_day_sonnet");
    expect(sonnet?.usedPercent).toBe(20);
    expect(sonnet?.scope).toBe("Sonnet");

    const routines = byId.get("seven_day_routines");
    expect(routines?.usedPercent).toBe(5);
    expect(routines?.scope).toBeUndefined();
  });

  test("rounds utilization (0..1) to a 0..100 percent", () => {
    const meters = parse({ five_hour: { utilization: 0.284, resets_at: "2026-08-12T17:00:00Z" } });
    expect(meters).toHaveLength(1);
    expect(meters[0]?.usedPercent).toBe(28); // Math.round(28.4)
  });
});

describe("parseClaudeUsage — extra_usage", () => {
  test("is_enabled:true produces a credit/extra meter", () => {
    const meters = parse({
      extra_usage: { is_enabled: true, utilization: 0.42, resets_at: "2026-09-01T00:00:00Z" },
    });
    expect(meters).toHaveLength(1);
    expect(meters[0]).toMatchObject({
      id: "extra_usage",
      label: "Extra usage",
      usedPercent: 42,
      resetsAtMs: Date.parse("2026-09-01T00:00:00Z"),
    });
  });

  test("is_enabled:false produces no meter", () => {
    const meters = parse({
      extra_usage: { is_enabled: false, utilization: 0.9, resets_at: "2026-09-01T00:00:00Z" },
    });
    expect(meters).toHaveLength(0);
  });

  test("extra_usage combines alongside scalar meters", () => {
    const meters = parse({
      five_hour: { utilization: 0.28, resets_at: "2026-08-12T17:00:00Z" },
      extra_usage: { is_enabled: true, utilization: 0.1, resets_at: "2026-09-01T00:00:00Z" },
    });
    expect(meters).toHaveLength(2);
    expect(meters.map((m) => m.id).sort()).toEqual(["extra_usage", "five_hour"]);
  });
});

describe("parseClaudeUsage — limits[] shape supersedes scalar fields", () => {
  test("limits[] alone maps to meters with derived id/label/scope", () => {
    const meters = parse({
      limits: [
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 33,
          resets_at: "2026-08-15T00:00:00Z",
          scope: { model: { id: "fable-1", display_name: "Fable" } },
        },
      ],
    });
    expect(meters).toHaveLength(1);
    expect(meters[0]).toMatchObject({
      id: "weekly_scoped",
      // Pretty label for known limit kinds (verified live 2026-08): the raw
      // "weekly_scoped" machine name renders as "Weekly (<model>)".
      label: "Weekly (Fable)",
      usedPercent: 33,
      resetsAtMs: Date.parse("2026-08-15T00:00:00Z"),
      scope: "Fable",
    });
  });

  test("a limits[] entry whose kind matches a known scalar id reuses its label", () => {
    const meters = parse({
      limits: [{ kind: "seven_day_opus", group: "weekly", percent: 12, resets_at: "2026-08-15T00:00:00Z" }],
    });
    expect(meters).toHaveLength(1);
    expect(meters[0]).toMatchObject({ id: "seven_day_opus", label: "Weekly Opus", usedPercent: 12 });
  });

  test("when both scalar fields and a non-empty limits[] are present, only limits[]-derived meters are used (plus extra_usage)", () => {
    const json = {
      // Scalar fields — must be entirely ignored once limits[] is non-empty.
      five_hour: { utilization: 0.28, resets_at: "2026-08-12T17:00:00Z" },
      seven_day: { utilization: 0.55, resets_at: "2026-08-15T00:00:00Z" },
      seven_day_opus: { utilization: 0.1, resets_at: "2026-08-15T00:00:00Z" },
      limits: [
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 33,
          resets_at: "2026-08-15T00:00:00Z",
          scope: { model: { id: "fable-1", display_name: "Fable" } },
        },
      ],
      extra_usage: { is_enabled: true, utilization: 0.1, resets_at: "2026-09-01T00:00:00Z" },
    };

    const meters = parse(json);
    const ids = meters.map((m) => m.id).sort();

    // Scalar-only ids must be entirely absent.
    expect(ids).not.toContain("five_hour");
    expect(ids).not.toContain("seven_day");
    expect(ids).not.toContain("seven_day_opus");

    // Only the limits[]-derived meter plus extra_usage survive.
    expect(ids).toEqual(["extra_usage", "weekly_scoped"]);
    expect(meters).toHaveLength(2);
  });

  test("an empty limits[] array falls back to the scalar fields", () => {
    const meters = parse({
      limits: [],
      five_hour: { utilization: 0.28, resets_at: "2026-08-12T17:00:00Z" },
    });
    expect(meters).toHaveLength(1);
    expect(meters[0]?.id).toBe("five_hour");
  });

  test("a limits[] entry with no kind/group falls back to a positional id", () => {
    const meters = parse({ limits: [{ percent: 50, resets_at: "2026-08-15T00:00:00Z" }] });
    expect(meters).toHaveLength(1);
    expect(meters[0]?.id).toBe("limit_0");
  });
});

describe("parseClaudeUsage — defensive handling", () => {
  test("null input returns []", () => {
    expect(parse(null)).toEqual([]);
  });

  test("undefined input returns []", () => {
    expect(parse(undefined)).toEqual([]);
  });

  test("empty object returns []", () => {
    expect(parse({})).toEqual([]);
  });

  test("a non-object top-level value (string/number/array) returns []", () => {
    expect(parse("not json")).toEqual([]);
    expect(parse(42)).toEqual([]);
    expect(parse([1, 2, 3])).toEqual([]);
  });

  test("a field with a non-number utilization is skipped, not thrown", () => {
    expect(() => parse({ five_hour: { utilization: "high", resets_at: "2026-08-12T17:00:00Z" } })).not.toThrow();
    const meters = parse({ five_hour: { utilization: "high", resets_at: "2026-08-12T17:00:00Z" } });
    expect(meters).toEqual([]);
  });

  test("a mix of one valid and one malformed scalar field keeps only the valid one", () => {
    const meters = parse({
      five_hour: { utilization: 0.5, resets_at: "2026-08-12T17:00:00Z" },
      seven_day: { utilization: "bad" },
    });
    expect(meters).toHaveLength(1);
    expect(meters[0]?.id).toBe("five_hour");
  });

  test("a missing/malformed resets_at yields resetsAtMs: null without throwing", () => {
    const meters = parse({ five_hour: { utilization: 0.5, resets_at: "not-a-date" } });
    expect(meters).toHaveLength(1);
    expect(meters[0]?.resetsAtMs).toBeNull();
  });

  test("a malformed limits[] entry (non-object) is skipped, not thrown", () => {
    expect(() => parse({ limits: [null, "oops", 42, { percent: 10, resets_at: "2026-08-15T00:00:00Z" }] })).not.toThrow();
    const meters = parse({ limits: [null, "oops", 42, { percent: 10, resets_at: "2026-08-15T00:00:00Z" }] });
    expect(meters).toHaveLength(1);
  });
});

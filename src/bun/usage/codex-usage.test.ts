import { describe, expect, test } from "bun:test";
import { parseCodexSessionRateLimits, parseCodexUsage } from "./codex-usage.ts";

const FETCHED_AT_MS = 1_700_000_000_000;

describe("parseCodexUsage", () => {
  test("maps a wham/usage-shaped body to session + weekly + credits meters", () => {
    const json = {
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 12, reset_at: 1787024752, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 40, reset_at: 1787100000, limit_window_seconds: 604800 },
      },
      credits: { has_credits: true, unlimited: false, balance: 42.5 },
    };

    const meters = parseCodexUsage(json, FETCHED_AT_MS);

    expect(meters).toEqual([
      {
        id: "session",
        label: "Session (5h)",
        usedPercent: 12,
        resetsAtMs: 1787024752 * 1000,
      },
      {
        id: "weekly",
        label: "Weekly",
        usedPercent: 40,
        resetsAtMs: 1787100000 * 1000,
      },
      {
        id: "credits",
        label: "Credits: 42.5",
        usedPercent: 0,
        resetsAtMs: null,
      },
    ]);
  });

  test("rounds usedPercent to the nearest whole percent", () => {
    const json = {
      rate_limit: {
        primary_window: { used_percent: 12.6, limit_window_seconds: 18000 },
      },
    };

    const meters = parseCodexUsage(json, FETCHED_AT_MS);

    expect(meters).toHaveLength(1);
    expect(meters[0]?.usedPercent).toBe(13);
  });

  test("accepts both reset_at and resets_at spellings on rate_limit windows", () => {
    const jsonWithResetAt = {
      rate_limit: {
        primary_window: { used_percent: 12, reset_at: 1787024752, limit_window_seconds: 18000 },
      },
    };
    const jsonWithResetsAt = {
      rate_limit: {
        primary_window: { used_percent: 12, resets_at: 1787024752, limit_window_seconds: 18000 },
      },
    };

    const metersA = parseCodexUsage(jsonWithResetAt, FETCHED_AT_MS);
    const metersB = parseCodexUsage(jsonWithResetsAt, FETCHED_AT_MS);

    expect(metersA).toHaveLength(1);
    expect(metersB).toHaveLength(1);
    expect(metersA[0]?.resetsAtMs).toBe(1787024752 * 1000);
    expect(metersB[0]?.resetsAtMs).toBe(1787024752 * 1000);
  });

  test("prefers reset_at over resets_at when both are present", () => {
    const json = {
      rate_limit: {
        primary_window: {
          used_percent: 12,
          reset_at: 111,
          resets_at: 222,
          limit_window_seconds: 18000,
        },
      },
    };

    const meters = parseCodexUsage(json, FETCHED_AT_MS);

    expect(meters[0]?.resetsAtMs).toBe(111 * 1000);
  });

  test("maps model-scoped additional_rate_limits[] entries", () => {
    // NOTE: additional_rate_limits entries carry primary_window/secondary_window
    // directly on the entry object (not nested under a `rate_limit` key) — see
    // parseCodexUsage's `e[key]` lookup over ["primary_window", "secondary_window"].
    const json = {
      additional_rate_limits: [
        {
          limit_name: "gpt-5",
          primary_window: { used_percent: 20, reset_at: 1787024752, limit_window_seconds: 18000 },
          secondary_window: { used_percent: 55, reset_at: 1787100000, limit_window_seconds: 604800 },
        },
      ],
    };

    const meters = parseCodexUsage(json, FETCHED_AT_MS);

    expect(meters).toEqual([
      {
        id: "gpt-5_session",
        label: "gpt-5 — Session (5h)",
        usedPercent: 20,
        resetsAtMs: 1787024752 * 1000,
        scope: "gpt-5",
      },
      {
        id: "gpt-5_weekly",
        label: "gpt-5 — Weekly",
        usedPercent: 55,
        resetsAtMs: 1787100000 * 1000,
        scope: "gpt-5",
      },
    ]);
  });

  test("skips a malformed additional_rate_limits entry without throwing", () => {
    const json = {
      additional_rate_limits: [null, "not-an-object", { limit_name: "gpt-5" }, 42],
    };

    expect(() => parseCodexUsage(json, FETCHED_AT_MS)).not.toThrow();
    expect(parseCodexUsage(json, FETCHED_AT_MS)).toEqual([]);
  });

  test("does not add a credits meter when has_credits is false or unlimited is true", () => {
    const jsonNoCredits = { credits: { has_credits: false, unlimited: false, balance: 10 } };
    const jsonUnlimited = { credits: { has_credits: true, unlimited: true, balance: 10 } };

    expect(parseCodexUsage(jsonNoCredits, FETCHED_AT_MS)).toEqual([]);
    expect(parseCodexUsage(jsonUnlimited, FETCHED_AT_MS)).toEqual([]);
  });

  test("returns [] for null, non-object, and empty-object input", () => {
    expect(parseCodexUsage(null, FETCHED_AT_MS)).toEqual([]);
    expect(parseCodexUsage(undefined, FETCHED_AT_MS)).toEqual([]);
    expect(parseCodexUsage({}, FETCHED_AT_MS)).toEqual([]);
    expect(parseCodexUsage("garbage", FETCHED_AT_MS)).toEqual([]);
    expect(parseCodexUsage(42, FETCHED_AT_MS)).toEqual([]);
    expect(parseCodexUsage([1, 2, 3], FETCHED_AT_MS)).toEqual([]);
  });

  test("never throws on deeply malformed shapes", () => {
    const garbageShapes: unknown[] = [
      { rate_limit: "not-an-object" },
      { rate_limit: { primary_window: "nope" } },
      { rate_limit: { primary_window: { used_percent: "12" } } },
      { rate_limit: { primary_window: { used_percent: Number.NaN } } },
      { credits: "not-an-object" },
      { additional_rate_limits: "not-an-array" },
    ];
    for (const shape of garbageShapes) {
      expect(() => parseCodexUsage(shape, FETCHED_AT_MS)).not.toThrow();
    }
  });
});

describe("parseCodexSessionRateLimits", () => {
  test("maps a session-JSONL rate_limits blob to a weekly meter using resets_in_seconds", () => {
    const rateLimits = {
      primary: { used_percent: 6, window_minutes: 10080, resets_in_seconds: 275281 },
      secondary: { used_percent: 6, window_minutes: 10080, resets_in_seconds: 275281 },
    };

    const meters = parseCodexSessionRateLimits(rateLimits, FETCHED_AT_MS);

    expect(meters).toEqual([
      {
        id: "weekly",
        label: "Weekly",
        usedPercent: 6,
        resetsAtMs: FETCHED_AT_MS + 275281 * 1000,
      },
      {
        id: "weekly",
        label: "Weekly",
        usedPercent: 6,
        resetsAtMs: FETCHED_AT_MS + 275281 * 1000,
      },
    ]);
  });

  test("prefers resets_at over resets_in_seconds when both are present", () => {
    const rateLimits = {
      primary: { used_percent: 6, window_minutes: 10080, resets_at: 1787024752, resets_in_seconds: 999999 },
    };

    const meters = parseCodexSessionRateLimits(rateLimits, FETCHED_AT_MS);

    expect(meters).toHaveLength(1);
    expect(meters[0]?.resetsAtMs).toBe(1787024752 * 1000);
  });

  test("maps a 5h-window primary meter to the session id/label", () => {
    const rateLimits = {
      primary: { used_percent: 10, window_minutes: 300, resets_in_seconds: 1000 },
    };

    const meters = parseCodexSessionRateLimits(rateLimits, FETCHED_AT_MS);

    expect(meters).toEqual([
      {
        id: "session",
        label: "Session (5h)",
        usedPercent: 10,
        resetsAtMs: FETCHED_AT_MS + 1000 * 1000,
      },
    ]);
  });

  test("falls back to primary/secondary as the meter id when the window role is unrecognized", () => {
    // window_minutes: 0 -> 0 seconds -> inferWindowRole returns { id: "window", ... },
    // which parseCodexSessionRateLimits maps back to the "primary"/"secondary" fallbackId.
    const rateLimits = {
      primary: { used_percent: 5, window_minutes: 0 },
      secondary: { used_percent: 8, window_minutes: 0 },
    };

    const meters = parseCodexSessionRateLimits(rateLimits, FETCHED_AT_MS);

    expect(meters).toEqual([
      { id: "primary", label: "Usage", usedPercent: 5, resetsAtMs: null },
      { id: "secondary", label: "Usage", usedPercent: 8, resetsAtMs: null },
    ]);
  });

  test("includes a credits meter from rate_limits.credits", () => {
    const rateLimits = {
      primary: { used_percent: 6, window_minutes: 10080, resets_in_seconds: 100 },
      credits: { has_credits: true, unlimited: false, balance: 5 },
    };

    const meters = parseCodexSessionRateLimits(rateLimits, FETCHED_AT_MS);

    expect(meters).toHaveLength(2);
    expect(meters[1]).toEqual({ id: "credits", label: "Credits: 5", usedPercent: 0, resetsAtMs: null });
  });

  test("returns [] when rate_limits is null (exec-mode sessions per openai/codex#14728)", () => {
    expect(parseCodexSessionRateLimits(null, FETCHED_AT_MS)).toEqual([]);
  });

  test("returns [] for undefined, non-object, and empty-object input", () => {
    expect(parseCodexSessionRateLimits(undefined, FETCHED_AT_MS)).toEqual([]);
    expect(parseCodexSessionRateLimits({}, FETCHED_AT_MS)).toEqual([]);
    expect(parseCodexSessionRateLimits("garbage", FETCHED_AT_MS)).toEqual([]);
    expect(parseCodexSessionRateLimits(42, FETCHED_AT_MS)).toEqual([]);
    expect(parseCodexSessionRateLimits([1, 2, 3], FETCHED_AT_MS)).toEqual([]);
  });

  test("never throws on deeply malformed shapes", () => {
    const garbageShapes: unknown[] = [
      { primary: "not-an-object" },
      { primary: { used_percent: "6" } },
      { primary: { used_percent: Number.NaN } },
      { credits: "not-an-object" },
    ];
    for (const shape of garbageShapes) {
      expect(() => parseCodexSessionRateLimits(shape, FETCHED_AT_MS)).not.toThrow();
    }
  });
});

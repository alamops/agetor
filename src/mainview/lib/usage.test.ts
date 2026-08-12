import { describe, expect, test } from "bun:test";
import {
  clampPercent,
  formatResetsIn,
  formatUpdatedAgo,
  tierColorVar,
  warnTier,
  worstMeter,
  worstTier,
} from "./usage.ts";
import type { QuotaMeter } from "../../shared/types.ts";

function meter(id: string, usedPercent: number, resetsAtMs: number | null = null): QuotaMeter {
  return { id, label: id, usedPercent, resetsAtMs };
}

describe("warnTier", () => {
  const cases: { name: string; input: number; expected: "ok" | "warn" | "crit" }[] = [
    { name: "just below the warn threshold is ok", input: 69, expected: "ok" },
    { name: "exactly the warn threshold is warn", input: 70, expected: "warn" },
    { name: "just below the crit threshold is still warn", input: 89, expected: "warn" },
    { name: "exactly the crit threshold is crit", input: 90, expected: "crit" },
    { name: "0 is ok", input: 0, expected: "ok" },
    { name: "100 is crit", input: 100, expected: "crit" },
    { name: "NaN falls back to ok", input: NaN, expected: "ok" },
    { name: "positive Infinity falls back to ok", input: Infinity, expected: "ok" },
    { name: "negative Infinity falls back to ok", input: -Infinity, expected: "ok" },
  ];

  for (const { name, input, expected } of cases) {
    test(name, () => {
      expect(warnTier(input)).toBe(expected);
    });
  }
});

describe("worstMeter", () => {
  test("returns null for an empty list", () => {
    expect(worstMeter([])).toBeNull();
  });

  test("picks the meter with the highest usedPercent", () => {
    const meters = [meter("a", 10), meter("b", 90), meter("c", 50)];
    expect(worstMeter(meters)?.id).toBe("b");
  });

  test("a single meter is trivially the worst", () => {
    expect(worstMeter([meter("only", 42)])?.id).toBe("only");
  });

  test("ties keep the first occurrence", () => {
    const meters = [meter("first", 80), meter("second", 80)];
    expect(worstMeter(meters)?.id).toBe("first");
  });
});

describe("worstTier", () => {
  test("no meters is ok", () => {
    expect(worstTier([])).toBe("ok");
  });

  test("reflects the worst meter's tier", () => {
    expect(worstTier([meter("a", 10), meter("b", 95)])).toBe("crit");
    expect(worstTier([meter("a", 10), meter("b", 75)])).toBe("warn");
    expect(worstTier([meter("a", 10), meter("b", 20)])).toBe("ok");
  });
});

describe("tierColorVar", () => {
  test("maps crit to danger", () => {
    expect(tierColorVar("crit")).toBe("danger");
  });
  test("maps warn to warning", () => {
    expect(tierColorVar("warn")).toBe("warning");
  });
  test("maps ok to success", () => {
    expect(tierColorVar("ok")).toBe("success");
  });
});

describe("clampPercent", () => {
  const cases: { name: string; input: number; expected: number }[] = [
    { name: "a negative value clamps up to 0", input: -20, expected: 0 },
    { name: "a value above 100 clamps down to 100", input: 150, expected: 100 },
    { name: "NaN clamps to 0", input: NaN, expected: 0 },
    { name: "positive Infinity clamps to 0", input: Infinity, expected: 0 },
    { name: "an in-range value passes through", input: 42, expected: 42 },
    { name: "exactly 0 passes through", input: 0, expected: 0 },
    { name: "exactly 100 passes through", input: 100, expected: 100 },
  ];

  for (const { name, input, expected } of cases) {
    test(name, () => {
      expect(clampPercent(input)).toBe(expected);
    });
  }
});

describe("formatResetsIn", () => {
  const now = 1_700_000_000_000;

  test("null resetsAtMs renders as empty string", () => {
    expect(formatResetsIn(null, now)).toBe("");
  });

  test("a past resetsAtMs renders as empty string", () => {
    expect(formatResetsIn(now - 60_000, now)).toBe("");
  });

  test("exactly now renders as empty string", () => {
    expect(formatResetsIn(now, now)).toBe("");
  });

  test("a few minutes in the future renders minutes", () => {
    expect(formatResetsIn(now + 5 * 60_000, now)).toBe("resets in 5m");
  });

  test("a sub-minute future value still rounds up to at least 1m", () => {
    expect(formatResetsIn(now + 10_000, now)).toBe("resets in 1m");
  });

  test("a few hours in the future renders hours", () => {
    expect(formatResetsIn(now + 3 * 60 * 60_000, now)).toBe("resets in 3h");
  });

  test("just under a day renders hours, not days", () => {
    expect(formatResetsIn(now + 23 * 60 * 60_000, now)).toBe("resets in 23h");
  });

  test("a couple days in the future renders days", () => {
    expect(formatResetsIn(now + 2 * 24 * 60 * 60_000, now)).toBe("resets in 2d");
  });

  test("NaN resetsAtMs renders as empty string", () => {
    expect(formatResetsIn(NaN, now)).toBe("");
  });
});

describe("formatUpdatedAgo", () => {
  const now = 1_700_000_000_000;

  test("just fetched renders 'updated just now'", () => {
    expect(formatUpdatedAgo(now, now)).toBe("updated just now");
  });

  test("under a minute ago still renders 'updated just now'", () => {
    expect(formatUpdatedAgo(now - 30_000, now)).toBe("updated just now");
  });

  test("a couple minutes ago renders minutes", () => {
    expect(formatUpdatedAgo(now - 2 * 60_000, now)).toBe("updated 2m ago");
  });

  test("a few hours ago renders hours", () => {
    expect(formatUpdatedAgo(now - 3 * 60 * 60_000, now)).toBe("updated 3h ago");
  });

  test("a couple days ago renders days", () => {
    expect(formatUpdatedAgo(now - 2 * 24 * 60 * 60_000, now)).toBe("updated 2d ago");
  });

  test("a fetchedAtMs in the future (clock skew) still renders 'updated just now'", () => {
    expect(formatUpdatedAgo(now + 60_000, now)).toBe("updated just now");
  });
});

import { expect, test } from "bun:test";
import {
  formatAiCredits,
  formatUsageCount,
  fxUsageChipText,
  fxUsageTitle,
  mergeFxUsage,
  parseFxUsage,
} from "./fx-usage.ts";

// --- parseFxUsage -------------------------------------------------------

test("parseFxUsage: 0.0.7 shape (used+size only)", () => {
  expect(parseFxUsage('{"used":1234,"size":128000}')).toEqual({ used: 1234, size: 128000 });
});

test("parseFxUsage: a well-formed cost is kept alongside used/size", () => {
  expect(parseFxUsage('{"used":1234,"size":128000,"cost":{"amount":0.0012,"currency":"USD"}}'))
    .toEqual({ used: 1234, size: 128000, cost: { amount: 0.0012, currency: "USD" } });
});

test("parseFxUsage: a malformed cost is dropped entirely, used/size survive", () => {
  expect(parseFxUsage('{"used":1234,"size":128000,"cost":{"amount":"x"}}'))
    .toEqual({ used: 1234, size: 128000 });
});

test("parseFxUsage: a wrong-typed known field is dropped on its own", () => {
  expect(parseFxUsage('{"used":"x","size":5}')).toEqual({ size: 5 });
});

test("parseFxUsage: turn keeps only its known, well-typed fields", () => {
  expect(parseFxUsage('{"turn":{"inputTokens":42,"outputTokens":7,"cacheReadTokens":"x","bogus":1}}'))
    .toEqual({ turn: { inputTokens: 42, outputTokens: 7 } });
});

test("parseFxUsage: an all-invalid turn object is dropped rather than surviving as {}", () => {
  expect(parseFxUsage('{"turn":{}}')).toBeNull();
});

test("parseFxUsage: {} has no keys to keep, so it parses to null", () => {
  expect(parseFxUsage("{}")).toBeNull();
});

test("parseFxUsage: non-object or unparsable JSON all yield null", () => {
  expect(parseFxUsage("[]")).toBeNull();
  expect(parseFxUsage("null")).toBeNull();
  expect(parseFxUsage("not json")).toBeNull();
  expect(parseFxUsage("")).toBeNull();
});

test("parseFxUsage: an Infinity-valued field (1e999 overflow) is dropped, not kept", () => {
  expect(parseFxUsage('{"used":1e999}')).toBeNull();
  expect(parseFxUsage('{"used":1e999,"size":128000}')).toEqual({ size: 128000 });
  expect(parseFxUsage('{"turn":{"inputTokens":-1e999,"outputTokens":7}}'))
    .toEqual({ turn: { outputTokens: 7 } });
});

// --- mergeFxUsage --------------------------------------------------------

test("mergeFxUsage: undefined prev + next yields next", () => {
  const next = { used: 1234, size: 128000 };
  expect(mergeFxUsage(undefined, next)).toEqual(next);
});

test("mergeFxUsage: used/size and turn from different sentinels both survive", () => {
  const prev = { used: 1234, size: 128000 };
  const next = { turn: { inputTokens: 42, outputTokens: 7 } };
  expect(mergeFxUsage(prev, next)).toEqual({
    used: 1234,
    size: 128000,
    turn: { inputTokens: 42, outputTokens: 7 },
  });
});

test("mergeFxUsage: a later turn replaces the earlier one wholesale, not field-by-field", () => {
  const prev = { turn: { inputTokens: 1 } };
  const next = { turn: { outputTokens: 2 } };
  expect(mergeFxUsage(prev, next)).toEqual({ turn: { outputTokens: 2 } });
});

test("mergeFxUsage: a later used/size overrides the earlier pair but keeps the earlier turn", () => {
  const prev = { used: 1, size: 2, turn: { inputTokens: 5 } };
  const next = { used: 9, size: 9 };
  expect(mergeFxUsage(prev, next)).toEqual({ used: 9, size: 9, turn: { inputTokens: 5 } });
});

// --- formatUsageCount ------------------------------------------------------

test("formatUsageCount: sub-1000 values print verbatim", () => {
  expect(formatUsageCount(999)).toBe("999");
});

test("formatUsageCount: thousands abbreviate, one decimal unless whole", () => {
  expect(formatUsageCount(1234)).toBe("1.2k");
  expect(formatUsageCount(45_000)).toBe("45k");
  expect(formatUsageCount(128_000)).toBe("128k");
});

test("formatUsageCount: millions abbreviate the same way", () => {
  expect(formatUsageCount(1_200_000)).toBe("1.2M");
  expect(formatUsageCount(2_000_000)).toBe("2M");
});

// --- fxUsageChipText ---------------------------------------------------

test("fxUsageChipText: used/size only", () => {
  expect(fxUsageChipText({ used: 1234, size: 128000 })).toBe("1.2k/128k");
});

test("fxUsageChipText: sub-cent USD cost widens to four decimals", () => {
  expect(fxUsageChipText({ used: 1234, size: 128000, cost: { amount: 0.0012, currency: "USD" } }))
    .toBe("1.2k/128k · $0.0012");
});

test("fxUsageChipText: USD cost at or above a cent uses two decimals", () => {
  expect(fxUsageChipText({ used: 1234, size: 128000, cost: { amount: 0.5, currency: "USD" } }))
    .toBe("1.2k/128k · $0.50");
});

test("fxUsageChipText: non-USD cost prints amount + currency code", () => {
  expect(fxUsageChipText({ used: 1234, size: 128000, cost: { amount: 0.5, currency: "EUR" } }))
    .toBe("1.2k/128k · 0.50 EUR");
});

test("fxUsageChipText: turn-only falls back to the compact in/out form", () => {
  expect(fxUsageChipText({ turn: { inputTokens: 42, outputTokens: 7 } })).toBe("↑42 ↓7");
});

test("fxUsageChipText: a missing half of turn reads as 0", () => {
  expect(fxUsageChipText({ turn: { inputTokens: 42 } })).toBe("↑42 ↓0");
});

test("fxUsageChipText: turn without input/output tokens yields no chip", () => {
  expect(fxUsageChipText({ turn: { cacheReadTokens: 3 } })).toBeNull();
});

test("fxUsageChipText: an empty payload yields no chip", () => {
  expect(fxUsageChipText({})).toBeNull();
});

test("fxUsageChipText: used alone (no size, no turn) yields no chip", () => {
  expect(fxUsageChipText({ used: 1 })).toBeNull();
});

// --- fxUsageTitle --------------------------------------------------------

test("fxUsageTitle: used/size renders the exact, comma-grouped numbers", () => {
  expect(fxUsageTitle({ used: 1234, size: 128000 })).toContain("1,234/128,000 tokens");
});

test("fxUsageTitle: wording is harness-neutral (cursor feeds the same sentinel)", () => {
  expect(fxUsageTitle({ used: 1234, size: 128000 })).toBe("usage: 1,234/128,000 tokens");
  expect(fxUsageTitle({ used: 1234, size: 128000 })).not.toContain("fx");
});

test("fxUsageTitle: a cursor-shaped turn-only payload (no cost, no reasoning) titles cleanly", () => {
  const usage = { turn: { inputTokens: 1200, outputTokens: 34, cacheReadTokens: 5000, cacheWriteTokens: 0 } };
  expect(fxUsageTitle(usage)).toBe("turn: in 1200 · out 34 · cache read 5000 · cache write 0");
  expect(fxUsageChipText(usage)).toBe("↑1.2k ↓34");
});

test("fxUsageTitle: no cost (fx 0.0.14's usage_update) leaves the segment bare", () => {
  expect(fxUsageTitle({ used: 10, size: 100 })).toBe("usage: 10/100 tokens");
});

test("fxUsageTitle: merged used/size + turn appends the turn segment", () => {
  const title = fxUsageTitle({
    used: 1234,
    size: 128000,
    turn: { inputTokens: 42, outputTokens: 7 },
  });
  expect(title).toContain("in 42 · out 7");
  expect(title).toContain("1,234/128,000 tokens");
});

test("fxUsageTitle: cache/reasoning fields each print their own labeled bit", () => {
  const title = fxUsageTitle({
    turn: {
      inputTokens: 42,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      reasoningTokens: 5,
    },
  });
  expect(title).toContain("cache read 3");
  expect(title).toContain("cache write 4");
  expect(title).toContain("reasoning 5");
});

test("fxUsageTitle: turn-only omits the used/size segment entirely (no 'tokens')", () => {
  const title = fxUsageTitle({ turn: { inputTokens: 42, outputTokens: 7 } });
  expect(title).toContain("in 42 · out 7");
  expect(title).not.toContain("tokens");
});

test("fxUsageTitle: a known cost is appended to the used/size segment", () => {
  const title = fxUsageTitle({ used: 1234, size: 128000, cost: { amount: 0.5, currency: "USD" } });
  expect(title).toContain("· 0.5 USD");
});

test("fxUsageTitle: an empty payload renders an empty string", () => {
  expect(fxUsageTitle({})).toBe("");
});

// --- aiCredits (GitHub Copilot) -----------------------------------------

test("parseFxUsage: aiCredits is kept when a finite number > 0", () => {
  expect(parseFxUsage('{"turn":{"inputTokens":42},"aiCredits":1.25}'))
    .toEqual({ turn: { inputTokens: 42 }, aiCredits: 1.25 });
});

test("parseFxUsage: aiCredits of 0, negative, non-numeric or overflowing is dropped", () => {
  expect(parseFxUsage('{"aiCredits":0}')).toBeNull();
  expect(parseFxUsage('{"aiCredits":-3}')).toBeNull();
  expect(parseFxUsage('{"aiCredits":"2"}')).toBeNull();
  expect(parseFxUsage('{"aiCredits":1e999}')).toBeNull();
  expect(parseFxUsage('{"used":5,"aiCredits":0}')).toEqual({ used: 5 });
});

test("mergeFxUsage: aiCredits merges alongside used/size and turn", () => {
  const prev = { used: 10, size: 100 };
  const next = { turn: { inputTokens: 1 }, aiCredits: 0.5 };
  expect(mergeFxUsage(prev, next)).toEqual({ used: 10, size: 100, turn: { inputTokens: 1 }, aiCredits: 0.5 });
  expect(mergeFxUsage({ aiCredits: 1 }, { aiCredits: 2 })).toEqual({ aiCredits: 2 });
});

test("formatAiCredits: two decimals, trailing zeros dropped, sub-cent widened", () => {
  expect(formatAiCredits(1.256)).toBe("1.26");
  expect(formatAiCredits(2.5)).toBe("2.5");
  expect(formatAiCredits(3)).toBe("3");
  expect(formatAiCredits(0.0042)).toBe("0.0042");
});

test("fxUsageTitle: aiCredits appends an 'AI credits' segment", () => {
  expect(fxUsageTitle({ turn: { inputTokens: 42, outputTokens: 7 }, aiCredits: 1.25 }))
    .toBe("turn: in 42 · out 7 · AI credits: 1.25");
  expect(fxUsageTitle({ aiCredits: 0.0042 })).toBe("AI credits: 0.0042");
});

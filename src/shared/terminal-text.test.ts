import { describe, expect, test } from "bun:test";
import { escapeFreeText, truncateText } from "./terminal-text.ts";
import * as bundle from "./bundle.ts";
import * as terminalText from "./terminal-text.ts";

describe("truncateText", () => {
  test("leaves text within the limit alone", () => {
    expect(truncateText("short", 5)).toBe("short");
    expect(truncateText("", 3)).toBe("");
  });

  test("cuts to max - 1 code units plus an ellipsis", () => {
    expect(truncateText("abcdefgh", 5)).toBe("abcd…");
  });

  test("never ends on half a surrogate pair", () => {
    // 42 a's + a rocket at max 44: the cut at 43 lands inside the pair.
    const cut = truncateText(`${"a".repeat(42)}🚀 launch`, 44);
    expect(cut).toBe(`${"a".repeat(42)}…`);
    expect(escapeFreeText(cut)).not.toContain("\\ud83d");
    // A pair that fits whole is kept.
    expect(truncateText(`${"a".repeat(41)}🚀 launch`, 44)).toBe(`${"a".repeat(41)}🚀…`);
  });

  test("drops invisible characters the cut leaves trailing", () => {
    // The ZWNJ of a Persian half-space whose next letter was cut off.
    expect(truncateText("abc\u200cdef", 5)).toBe("abc…");
    // A ZWJ whose emoji was cut off.
    expect(truncateText("ab👩\u200d💻", 6)).toBe("ab👩…");
    // One inside the kept text stays (and escapeFreeText judges it).
    expect(truncateText("رفع\u200cاشکال و بیشتر", 8)).toBe("رفع\u200cاشک…");
  });
});

test("bundle.ts re-exports the text helpers it used to define", () => {
  expect(bundle.escapeControlChars).toBe(terminalText.escapeControlChars);
  expect(bundle.escapeFreeText).toBe(terminalText.escapeFreeText);
  expect(bundle.escapeCapped).toBe(terminalText.escapeCapped);
  expect(bundle.findInvisibleChar).toBe(terminalText.findInvisibleChar);
  expect(bundle.stripInvisible).toBe(terminalText.stripInvisible);
  expect(bundle.truncateText).toBe(terminalText.truncateText);
});

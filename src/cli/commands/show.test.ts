import { test, expect } from "bun:test";
import { promptSummary } from "./show.ts";

test("promptSummary: one escaped line, cut to 240 characters", () => {
  // An issue body quoted into the prompt can carry a terminal escape.
  expect(promptSummary("Fix it\n\u001b]0;pwned\u0007 now\r\nplease")).toBe("Fix it \\u001b]0;pwned\\u0007 now please");
  expect(promptSummary("a‮b")).toBe("a\\u202eb");
  const long = promptSummary("x".repeat(500));
  expect(long).toBe(`${"x".repeat(239)}…`);
  expect(promptSummary("plain prompt")).toBe("plain prompt");
});

test("promptSummary: the cut never leaves half an emoji or a stranded joiner", () => {
  // 238 x's + an emoji: the cut at 239 code units would split its surrogate pair.
  expect(promptSummary(`${"x".repeat(238)}🚀${"y".repeat(10)}`)).toBe(`${"x".repeat(238)}…`);
  // A ZWJ left at the end once the emoji it joined is cut off is dropped too.
  expect(promptSummary(`${"x".repeat(236)}👩\u200d💻${"y".repeat(10)}`)).toBe(`${"x".repeat(236)}👩…`);
});

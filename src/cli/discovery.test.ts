import { test, expect } from "bun:test";
import { brief, commandLabel } from "./commands/discovery.ts";

test("commandLabel adds a leading slash only when missing (no doubling)", () => {
  expect(commandLabel("review")).toBe("/review");
  expect(commandLabel("/appstore-review")).toBe("/appstore-review");
});

test("brief collapses whitespace to one line and caps the length", () => {
  expect(brief("a\n  b   c")).toBe("a b c");
  expect(brief("   spaced   ")).toBe("spaced");
  const out = brief("x".repeat(100), 10);
  expect(out.length).toBe(10); // 9 chars + the … ellipsis
  expect(out).toBe("xxxxxxxxx…");
});

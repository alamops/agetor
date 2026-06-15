import { test, expect } from "bun:test";
import { sanitizeDrop } from "./paste.ts";

test("sanitizeDrop normalizes a dragged file path but leaves typing/prose untouched", () => {
  expect(sanitizeDrop("/Users/me/My\\ Shot.png")).toBe("/Users/me/My Shot.png"); // escaped space
  expect(sanitizeDrop("'/Users/me/My Shot.png'")).toBe("/Users/me/My Shot.png"); // quoted
  expect(sanitizeDrop("/Users/me/clean.png ")).toBe("/Users/me/clean.png"); // trailing drop space
  expect(sanitizeDrop("/Users/me/clean.png")).toBe("/Users/me/clean.png"); // already clean → unchanged
  expect(sanitizeDrop("just some prose")).toBe("just some prose"); // not a path → untouched
  expect(sanitizeDrop("review the \\ thing")).toBe("review the \\ thing"); // prose w/ backslash, not absolute
});

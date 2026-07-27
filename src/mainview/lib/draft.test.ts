import { expect, test } from "bun:test";
import type { TaskReference } from "../../shared/types.ts";
import { draftsEqual, normalizeDraft } from "./draft.ts";

function refs(...specs: [string, boolean][]): TaskReference[] {
  return specs.map(([p, isDirectory]) => ({ path: p, isDirectory }));
}

// --- normalizeDraft ------------------------------------------------------

test("normalizeDraft returns null for empty text and no references", () => {
  expect(normalizeDraft("", [])).toBeNull();
});

test("normalizeDraft returns null for whitespace-only text and no references", () => {
  expect(normalizeDraft("   \n\t  ", [])).toBeNull();
});

test("normalizeDraft preserves text verbatim, including leading/trailing whitespace", () => {
  const out = normalizeDraft("  hello world  \n", []);
  expect(out).not.toBeNull();
  expect(out!.text).toBe("  hello world  \n");
});

test("normalizeDraft returns a non-null draft for a references-only composer state", () => {
  const r = refs(["/tmp/a", false]);
  const out = normalizeDraft("", r);
  expect(out).not.toBeNull();
  expect(out).toEqual({ text: "", references: r });
});

test("normalizeDraft returns a non-null draft even when text is whitespace-only, if refs are present", () => {
  const r = refs(["/tmp/a", true]);
  const out = normalizeDraft("   ", r);
  expect(out).not.toBeNull();
  expect(out!.text).toBe("   "); // verbatim, not trimmed away
  expect(out!.references).toEqual(r);
});

test("normalizeDraft preserves non-empty text plus references together", () => {
  const r = refs(["/tmp/a", false], ["/tmp/b", true]);
  const out = normalizeDraft("some text", r);
  expect(out).toEqual({ text: "some text", references: r });
});

// --- draftsEqual -----------------------------------------------------------

test("draftsEqual: null and null are equal", () => {
  expect(draftsEqual(null, null)).toBe(true);
});

test("draftsEqual: null and a value are not equal", () => {
  expect(draftsEqual(null, { text: "x", references: [] })).toBe(false);
  expect(draftsEqual({ text: "x", references: [] }, null)).toBe(false);
});

test("draftsEqual: identical drafts are equal", () => {
  const a = { text: "hi", references: refs(["/tmp/a", false]) };
  const b = { text: "hi", references: refs(["/tmp/a", false]) };
  expect(draftsEqual(a, b)).toBe(true);
});

test("draftsEqual: differing text is not equal", () => {
  const a = { text: "hi", references: [] };
  const b = { text: "bye", references: [] };
  expect(draftsEqual(a, b)).toBe(false);
});

test("draftsEqual: reference order matters", () => {
  const a = { text: "", references: refs(["/tmp/a", false], ["/tmp/b", false]) };
  const b = { text: "", references: refs(["/tmp/b", false], ["/tmp/a", false]) };
  expect(draftsEqual(a, b)).toBe(false);
});

test("draftsEqual: a path difference between otherwise-matching refs is not equal", () => {
  const a = { text: "", references: refs(["/tmp/a", false]) };
  const b = { text: "", references: refs(["/tmp/other", false]) };
  expect(draftsEqual(a, b)).toBe(false);
});

test("draftsEqual: an isDirectory difference between otherwise-matching refs is not equal", () => {
  const a = { text: "", references: refs(["/tmp/a", false]) };
  const b = { text: "", references: refs(["/tmp/a", true]) };
  expect(draftsEqual(a, b)).toBe(false);
});

test("draftsEqual: different reference-array lengths are not equal", () => {
  const a = { text: "", references: refs(["/tmp/a", false]) };
  const b = { text: "", references: refs(["/tmp/a", false], ["/tmp/b", false]) };
  expect(draftsEqual(a, b)).toBe(false);
  expect(draftsEqual(b, a)).toBe(false);
});

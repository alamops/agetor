import { test, expect } from "bun:test";
import type { SavedPrompt } from "../../shared/types.ts";
import { filterPromptsForPicker, filterPromptsForSlash } from "./prompt-picker.ts";

function prompt(id: string, name: string, content: string): SavedPrompt {
  return { id, name, content, createdAt: 0, updatedAt: 0 };
}

// ── empty prompts array ─────────────────────────────────────────────────────

test("filterPromptsForPicker: empty prompts array returns empty", () => {
  expect(filterPromptsForPicker([], "anything")).toEqual([]);
});

test("filterPromptsForSlash: empty prompts array returns empty", () => {
  expect(filterPromptsForSlash([], "anything")).toEqual([]);
});

// ── empty / whitespace-only query returns all ──────────────────────────────

test("filterPromptsForPicker: empty query returns all prompts, in order", () => {
  const prompts = [prompt("1", "Alpha", "one"), prompt("2", "Beta", "two")];
  expect(filterPromptsForPicker(prompts, "")).toEqual(prompts);
});

test("filterPromptsForPicker: whitespace-only query returns all prompts", () => {
  const prompts = [prompt("1", "Alpha", "one"), prompt("2", "Beta", "two")];
  expect(filterPromptsForPicker(prompts, "   ")).toEqual(prompts);
});

test("filterPromptsForSlash: empty query returns all prompts, in order", () => {
  const prompts = [prompt("1", "Alpha", "one"), prompt("2", "Beta", "two")];
  expect(filterPromptsForSlash(prompts, "")).toEqual(prompts);
});

test("filterPromptsForSlash: whitespace-only query returns all prompts", () => {
  const prompts = [prompt("1", "Alpha", "one"), prompt("2", "Beta", "two")];
  expect(filterPromptsForSlash(prompts, "   ")).toEqual(prompts);
});

// ── case-insensitive name match ────────────────────────────────────────────

test("filterPromptsForPicker: case-insensitive name match", () => {
  const prompts = [prompt("1", "Code Review", "body")];
  expect(filterPromptsForPicker(prompts, "CODE review")).toEqual(prompts);
});

test("filterPromptsForSlash: case-insensitive name match", () => {
  const prompts = [prompt("1", "Code Review", "body")];
  expect(filterPromptsForSlash(prompts, "CODE review")).toEqual(prompts);
});

// ── content match: included for picker, excluded for slash ────────────────

test("filterPromptsForPicker: matches on content when name doesn't match", () => {
  const p = prompt("1", "Greeting", "Please review the repo carefully");
  expect(filterPromptsForPicker([p], "review the repo")).toEqual([p]);
});

test("filterPromptsForSlash: does NOT match on content, only name", () => {
  const p = prompt("1", "Greeting", "Please review the repo carefully");
  expect(filterPromptsForSlash([p], "review the repo")).toEqual([]);
});

// ── no cross-field seam match for picker (per-field substring only) ───────

test("filterPromptsForPicker: no cross-field seam match spanning end-of-name + start-of-content", () => {
  // "end start" appears nowhere in "alphaend" nor in "startbeta" individually,
  // even though concatenating name+content would produce "...end start...".
  const p = prompt("1", "AlphaEnd", "StartBeta");
  expect(filterPromptsForPicker([p], "end start")).toEqual([]);
});

test("filterPromptsForSlash: seam text also does not match via name alone", () => {
  const p = prompt("1", "AlphaEnd", "StartBeta");
  expect(filterPromptsForSlash([p], "end start")).toEqual([]);
});

// ── non-matching query returns empty ───────────────────────────────────────

test("filterPromptsForPicker: non-matching query returns empty", () => {
  const prompts = [prompt("1", "Alpha", "one"), prompt("2", "Beta", "two")];
  expect(filterPromptsForPicker(prompts, "zzz")).toEqual([]);
});

test("filterPromptsForSlash: non-matching query returns empty", () => {
  const prompts = [prompt("1", "Alpha", "one"), prompt("2", "Beta", "two")];
  expect(filterPromptsForSlash(prompts, "zzz")).toEqual([]);
});

// ── multiple matches preserve input order ──────────────────────────────────

test("filterPromptsForPicker: multiple matches preserve input order", () => {
  const prompts = [
    prompt("1", "Zeta Review", "x"),
    prompt("2", "Alpha", "review body"),
    prompt("3", "Middle", "no match here"),
    prompt("4", "Beta Review", "y"),
  ];
  const result = filterPromptsForPicker(prompts, "review");
  expect(result.map((p) => p.id)).toEqual(["1", "2", "4"]);
});

test("filterPromptsForSlash: multiple matches preserve input order", () => {
  const prompts = [
    prompt("1", "Zeta Review", "x"),
    prompt("2", "Alpha", "review body"), // content-only match, excluded from slash
    prompt("3", "Middle", "no match here"),
    prompt("4", "Beta Review", "y"),
  ];
  const result = filterPromptsForSlash(prompts, "review");
  expect(result.map((p) => p.id)).toEqual(["1", "4"]);
});

// ── query with surrounding whitespace ──────────────────────────────────────
// Implementation calls query.trim().toLowerCase(), so surrounding whitespace
// is stripped before matching — a query of " review " behaves identically to
// "review" (not as a literal substring search including the spaces).

test("filterPromptsForPicker: surrounding whitespace in query is trimmed away", () => {
  const p = prompt("1", "Review", "body");
  expect(filterPromptsForPicker([p], "  review  ")).toEqual([p]);
});

test("filterPromptsForSlash: surrounding whitespace in query is trimmed away", () => {
  const p = prompt("1", "Review", "body");
  expect(filterPromptsForSlash([p], "  review  ")).toEqual([p]);
});

import { describe, expect, test } from "bun:test";
import {
  appendTaskPr,
  firstPrUrl,
  headerPr,
  legacyTaskPrs,
  livePr,
  parseTaskPrs,
  prForHead,
  taskPrsOf,
} from "./task-prs.ts";
import type { TaskPr } from "./types.ts";

const pr = (over: Partial<TaskPr> = {}): TaskPr => ({
  url: "https://github.com/o/r/pull/1",
  head: "feature/a",
  base: "main",
  number: 1,
  createdAt: 10,
  ...over,
});

describe("parseTaskPrs", () => {
  test("drops entries without a url and coerces bad numbers to null", () => {
    const out = parseTaskPrs([
      { url: "https://x/1", head: "a", base: "b", number: "7", createdAt: 5 },
      { head: "no-url" },
      "junk",
      null,
      { url: "" },
    ]);
    expect(out).toEqual([{ url: "https://x/1", head: "a", base: "b", number: null, createdAt: 5 }]);
  });
  test("accepts JSON text and returns [] for malformed JSON or a non-array", () => {
    expect(parseTaskPrs(JSON.stringify([pr()]))).toEqual([pr()]);
    expect(parseTaskPrs("{not json")).toEqual([]);
    expect(parseTaskPrs({ url: "x" })).toEqual([]);
    expect(parseTaskPrs(undefined)).toEqual([]);
  });
});

describe("legacy conversion", () => {
  test("legacyTaskPrs makes one head-only record, or none without a url", () => {
    expect(legacyTaskPrs("https://x/1", "feature/a", 3)).toEqual([
      { url: "https://x/1", head: "feature/a", base: null, number: null, createdAt: 3 },
    ]);
    expect(legacyTaskPrs(null, "a")).toEqual([]);
    expect(legacyTaskPrs("  ", "a")).toEqual([]);
  });
  test("taskPrsOf reads prUrl only when prs is absent", () => {
    expect(taskPrsOf({ prUrl: "https://x/1" })).toEqual([
      { url: "https://x/1", head: null, base: null, number: null, createdAt: 0 },
    ]);
    expect(taskPrsOf({ prs: [], prUrl: "https://x/1" })).toEqual([]);
    expect(taskPrsOf({ prs: [pr()], prUrl: "https://other" })).toEqual([pr()]);
    expect(taskPrsOf({})).toEqual([]);
  });
});

describe("selection helpers", () => {
  const a = pr({ url: "https://x/a", head: "a" });
  const b = pr({ url: "https://x/b", head: "b" });
  const legacy = pr({ url: "https://x/l", head: null, base: null });

  test("prForHead matches the head exactly", () => {
    expect(prForHead([a, b], "b")).toBe(b);
    expect(prForHead([a, b], "c")).toBeNull();
    expect(prForHead([a, b], null)).toBeNull();
  });
  test("livePr prefers a head match over a head:null entry", () => {
    expect(livePr([legacy, a], ["a"])).toBe(a);
    expect(livePr([legacy, a], ["zzz"])).toBe(legacy);
    expect(livePr([a, b], ["zzz"])).toBeNull();
  });
  test("livePr tries the heads in order", () => {
    expect(livePr([a, b], ["b", "a"])).toBe(b);
    expect(livePr([a, b], [null, "a"])).toBe(a);
  });
  test("headerPr falls back to the first record", () => {
    expect(headerPr([a, b], ["zzz"])).toBe(a);
    expect(headerPr([a, b], ["b"])).toBe(b);
    expect(headerPr([], ["a"])).toBeNull();
  });
  test("firstPrUrl is the first record's url", () => {
    expect(firstPrUrl([a, b])).toBe("https://x/a");
    expect(firstPrUrl([])).toBeNull();
  });
});

describe("appendTaskPr", () => {
  test("appends and dedupes by url", () => {
    const a = pr({ url: "https://x/a" });
    const b = pr({ url: "https://x/b" });
    expect(appendTaskPr([a], b)).toEqual([a, b]);
    const dup = appendTaskPr([a], { ...a, head: "other" });
    expect(dup).toEqual([a]);
  });
});

import { beforeEach, describe, expect, test } from "bun:test";
import {
  getHandoffSearchSession,
  publishHandoffSearchSession,
  resetHandoffSearchSessionForTest,
  rawHandoffMatchesJump,
  searchHintStillValid,
  subscribeHandoffSearchSession,
} from "./handoff-search-hint";

beforeEach(resetHandoffSearchSessionForTest);

describe("rawHandoffMatchesJump", () => {
  const raw = '{"summary": "Needle in the raw body"';

  test("opens the raw section only when the jump's query occurs in it, like the search (trimmed, case-insensitive)", () => {
    expect(rawHandoffMatchesJump(raw, "needle")).toBe(true);
    expect(rawHandoffMatchesJump(raw, "  RAW BODY ")).toBe(true);
    expect(rawHandoffMatchesJump(raw, "elsewhere")).toBe(false);
  });

  test("a blank query matches nothing; a jump with no query reads as a plain expand", () => {
    expect(rawHandoffMatchesJump(raw, "")).toBe(false);
    expect(rawHandoffMatchesJump(raw, "   ")).toBe(false);
    expect(rawHandoffMatchesJump(raw, undefined)).toBe(true);
  });
});

describe("searchHintStillValid", () => {
  test("valid only while the same query is open", () => {
    expect(searchHintStillValid("abc", { open: true, query: "abc" })).toBe(true);
    expect(searchHintStillValid("abc", { open: true, query: "abcd" })).toBe(false);
    expect(searchHintStillValid("abc", { open: false, query: "abc" })).toBe(false);
    expect(searchHintStillValid("abc", { open: false, query: "" })).toBe(false);
  });
});

describe("session store", () => {
  test("notifies subscribers on change only, and unsubscribes", () => {
    const seen: string[] = [];
    const off = subscribeHandoffSearchSession((s) => seen.push(`${s.open}:${s.query}`));
    publishHandoffSearchSession({ open: true, query: "a" });
    publishHandoffSearchSession({ open: true, query: "a" });
    publishHandoffSearchSession({ open: false, query: "" });
    expect(seen).toEqual(["true:a", "false:"]);
    off();
    publishHandoffSearchSession({ open: true, query: "b" });
    expect(seen).toHaveLength(2);
    expect(getHandoffSearchSession()).toEqual({ open: true, query: "b" });
  });
});

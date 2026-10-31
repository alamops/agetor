// Pure forward-resume helpers (docs/plans/event-stream-forward-resume.md §3.1,
// TT2): cursor parsing/precedence and the resume/snapshot decision table.
// No db, no data dir.
import { describe, expect, test } from "bun:test";
import { decideForwardResume, parseResumeCursor, resolveResumeCursor } from "./event-resume.ts";

describe("parseResumeCursor", () => {
  const cases: Array<[string | null | undefined, number | null]> = [
    ["0", 0],
    ["42", 42],
    ["007", 7],
    ["1234567890123456", 1234567890123456],
    ["-1", null],
    ["+1", null],
    ["1.5", null],
    ["abc", null],
    ["1a", null],
    [" 1", null],
    ["", null],
    ["12345678901234567", null], // 17 digits
    ["9999999999999999", null], // 16 digits but above MAX_SAFE_INTEGER
    [null, null],
    [undefined, null],
  ];
  for (const [raw, expected] of cases) {
    test(`${JSON.stringify(raw)} -> ${expected}`, () => {
      expect(parseResumeCursor(raw)).toBe(expected);
    });
  }
});

describe("resolveResumeCursor", () => {
  test("header wins when both are valid", () => {
    expect(resolveResumeCursor("10", "20")).toBe(10);
  });
  test("query is used when the header is absent", () => {
    expect(resolveResumeCursor(null, "20")).toBe(20);
    expect(resolveResumeCursor(undefined, "20")).toBe(20);
  });
  test("a malformed header falls through to a valid query", () => {
    expect(resolveResumeCursor("abc", "20")).toBe(20);
    expect(resolveResumeCursor("-5", "20")).toBe(20);
    expect(resolveResumeCursor("", "20")).toBe(20);
  });
  test("a valid header wins over a malformed query", () => {
    expect(resolveResumeCursor("10", "zzz")).toBe(10);
  });
  test("both malformed or absent -> null", () => {
    expect(resolveResumeCursor("x", "y")).toBeNull();
    expect(resolveResumeCursor(null, null)).toBeNull();
  });
  test("zero is a valid cursor (not treated as absent)", () => {
    expect(resolveResumeCursor("0", "20")).toBe(0);
  });
});

describe("decideForwardResume", () => {
  const MAX_EVENTS = 800;
  const MAX_BYTES = 4 * 1024 * 1024;
  const rows = (n: number, len = 1) => Array.from({ length: n }, (_, i) => ({ id: i + 1, len }));
  const decide = (over: Partial<Parameters<typeof decideForwardResume>[0]>) =>
    decideForwardResume({
      afterId: 0,
      highWater: 1000,
      gapRowsAsc: [],
      maxEvents: MAX_EVENTS,
      maxBytes: MAX_BYTES,
      ...over,
    });

  test("empty gap resumes", () => {
    expect(decide({})).toEqual({ kind: "resume" });
  });
  test("cursor equal to the high-water resumes", () => {
    expect(decide({ afterId: 1000 })).toEqual({ kind: "resume" });
  });
  test("cursor above the high-water -> cursor-ahead", () => {
    expect(decide({ afterId: 1001 })).toEqual({ kind: "snapshot", reason: "cursor-ahead" });
  });
  test("cursor-ahead is checked before the gap size", () => {
    expect(decide({ afterId: 5, highWater: 4, gapRowsAsc: rows(MAX_EVENTS + 1) })).toEqual({
      kind: "snapshot",
      reason: "cursor-ahead",
    });
  });
  test("exactly maxEvents rows resumes; one more -> too-many", () => {
    expect(decide({ gapRowsAsc: rows(MAX_EVENTS) })).toEqual({ kind: "resume" });
    expect(decide({ gapRowsAsc: rows(MAX_EVENTS + 1) })).toEqual({ kind: "snapshot", reason: "too-many" });
  });
  test("too-many is checked before too-large", () => {
    expect(decide({ gapRowsAsc: rows(MAX_EVENTS + 1, MAX_BYTES) })).toEqual({
      kind: "snapshot",
      reason: "too-many",
    });
  });
  test("exactly maxBytes resumes; one byte more -> too-large", () => {
    expect(decide({ gapRowsAsc: [{ id: 1, len: MAX_BYTES }] })).toEqual({ kind: "resume" });
    expect(decide({ gapRowsAsc: [{ id: 1, len: MAX_BYTES + 1 }] })).toEqual({
      kind: "snapshot",
      reason: "too-large",
    });
  });
  test("bytes are summed across rows", () => {
    expect(decide({ gapRowsAsc: [{ id: 1, len: MAX_BYTES / 2 }, { id: 2, len: MAX_BYTES / 2 }] })).toEqual({
      kind: "resume",
    });
    expect(decide({ gapRowsAsc: [{ id: 1, len: MAX_BYTES / 2 }, { id: 2, len: MAX_BYTES / 2 + 1 }] })).toEqual({
      kind: "snapshot",
      reason: "too-large",
    });
  });
});

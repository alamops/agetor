import { describe, expect, test } from "bun:test";
import { parsePullNumber } from "./pr-url.ts";

describe("parsePullNumber — GitHub", () => {
  test("parses a plain GitHub pull URL", () => {
    expect(parsePullNumber("https://github.com/o/r/pull/12")).toBe(12);
  });

  test("tolerates an extra tail segment (.../pull/12/files)", () => {
    expect(parsePullNumber("https://github.com/o/r/pull/12/files")).toBe(12);
  });

  test("tolerates a trailing slash", () => {
    expect(parsePullNumber("https://github.com/o/r/pull/12/")).toBe(12);
  });

  test("tolerates a query string", () => {
    expect(parsePullNumber("https://github.com/o/r/pull/12?diff=split")).toBe(12);
  });

  test("tolerates a fragment", () => {
    expect(parsePullNumber("https://github.com/o/r/pull/12#discussion_r123")).toBe(12);
  });
});

describe("parsePullNumber — GitLab", () => {
  test("parses a merge_requests URL", () => {
    expect(parsePullNumber("https://gitlab.com/o/r/merge_requests/7")).toBe(7);
  });

  test("parses a merge_requests URL nested under /-/", () => {
    expect(parsePullNumber("https://gitlab.com/o/r/-/merge_requests/7")).toBe(7);
  });
});

describe("parsePullNumber — Bitbucket", () => {
  test("parses a pull-requests URL", () => {
    expect(parsePullNumber("https://bitbucket.org/o/r/pull-requests/3")).toBe(3);
  });
});

describe("parsePullNumber — rejections", () => {
  test("rejects a file: scheme", () => {
    expect(parsePullNumber("file:///pull/12")).toBeNull();
  });

  test("rejects a custom (non-http/https) scheme", () => {
    expect(parsePullNumber("myapp://host/pull/12")).toBeNull();
  });

  test("rejects a malformed URL", () => {
    expect(parsePullNumber("not a url")).toBeNull();
  });

  test("rejects a URL with no marker segment", () => {
    expect(parsePullNumber("https://github.com/o/r/issues/12")).toBeNull();
  });

  test("rejects a marker followed by a non-numeric segment", () => {
    expect(parsePullNumber("https://github.com/o/r/pull/abc")).toBeNull();
  });

  test('rejects exponential notation ("1e3")', () => {
    expect(parsePullNumber("https://github.com/o/r/pull/1e3")).toBeNull();
  });

  test('rejects hex notation ("0x10")', () => {
    expect(parsePullNumber("https://github.com/o/r/pull/0x10")).toBeNull();
  });

  test('rejects decimal notation ("12.0")', () => {
    expect(parsePullNumber("https://github.com/o/r/pull/12.0")).toBeNull();
  });

  test('accepts a leading-zero decimal ("0012") since it is all digits, parsing to 12', () => {
    expect(parsePullNumber("https://github.com/o/r/pull/0012")).toBe(12);
  });

  test("rejects zero (.../pull/0)", () => {
    expect(parsePullNumber("https://github.com/o/r/pull/0")).toBeNull();
  });

  test("rejects the marker as the last path segment (no number follows)", () => {
    expect(parsePullNumber("https://github.com/o/r/pull")).toBeNull();
  });

  test("rejects an empty string", () => {
    expect(parsePullNumber("")).toBeNull();
  });

  test("is case-sensitive about the marker segment", () => {
    expect(parsePullNumber("https://github.com/o/r/Pull/12")).toBeNull();
  });
});

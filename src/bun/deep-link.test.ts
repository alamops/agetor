import { test, expect, describe } from "bun:test";
import { APP_URL_SCHEME, buildTaskDeepLink, parseTaskDeepLink } from "./deep-link.ts";

describe("constants", () => {
  test("APP_URL_SCHEME is agetor", () => {
    expect(APP_URL_SCHEME).toBe("agetor");
  });
});

describe("buildTaskDeepLink", () => {
  test("builds the expected literal string for a plain id", () => {
    expect(buildTaskDeepLink("abc")).toBe("agetor://task/abc");
  });
});

describe("round-trip through buildTaskDeepLink -> parseTaskDeepLink", () => {
  const cases: Array<[string, string]> = [
    ["plain id", "abc123"],
    ["id with slash", "a/b"],
    ["id with question mark", "a?b"],
    ["id with hash", "a#b"],
    ["id with space", "a b"],
    ["id with unicode", "táșk-é-🚀"],
  ];

  for (const [label, id] of cases) {
    test(`round-trips ${label}`, () => {
      const link = buildTaskDeepLink(id);
      expect(parseTaskDeepLink(link)).toBe(id);
    });
  }
});

describe("parseTaskDeepLink valid input", () => {
  test("returns the decoded id for a valid single-segment link", () => {
    expect(parseTaskDeepLink("agetor://task/abc%20def")).toBe("abc def");
  });
});

describe("parseTaskDeepLink rejects malformed input", () => {
  const invalid: Array<[string, string]> = [
    ["wrong scheme (http)", "http://task/x"],
    ["wrong scheme (foo)", "foo://task/x"],
    ["wrong host (other)", "agetor://other/x"],
    ["wrong host (task2)", "agetor://task2/x"],
    ["missing id", "agetor://task"],
    ["empty id", "agetor://task/"],
    ["extra segments", "agetor://task/a/b"],
    ["doubled slash", "agetor://task//a"],
    ["query string", "agetor://task/a?x=1"],
    ["fragment", "agetor://task/a#y"],
    ["non-URL garbage", "not a url"],
    ["empty string", ""],
  ];

  for (const [label, input] of invalid) {
    test(`returns null for ${label}`, () => {
      expect(parseTaskDeepLink(input)).toBeNull();
    });
  }
});

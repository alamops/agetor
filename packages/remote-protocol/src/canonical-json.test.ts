import { describe, expect, test } from "bun:test";
import { canonicalize, parseJsonStrict, CanonicalJsonError } from "./canonical-json.ts";

describe("canonicalize (RFC 8785)", () => {
  test("RFC 8785 section 3.2.2.3 number examples", () => {
    expect(canonicalize([333333333.33333329, 1e30, 4.5, 2e-3, 1e-27])).toBe("[333333333.3333333,1e+30,4.5,0.002,1e-27]");
    expect(canonicalize([-0, 1e21, 1e-7, 0.000001])).toBe("[0,1e+21,1e-7,0.000001]");
  });
  test("keys sort by UTF-16 code unit (a surrogate pair sorts before U+FF5E)", () => {
    expect(canonicalize({ b: 1, a: 2, "": 3, A: 4, "é": 5, "😀": 6, "～": 7 })).toBe(
      '{"":3,"A":4,"a":2,"b":1,"\u00e9":5,"\ud83d\ude00":6,"\uff5e":7}',
    );
  });
  test("escapes follow RFC 8785", () => {
    expect(canonicalize("\b\t\n\f\r\u0000\u001f\"\\")).toBe('"\\b\\t\\n\\f\\r\\u0000\\u001f\\"\\\\"');
  });
  test("refuses non-finite numbers, undefined, lone surrogates and non-plain objects", () => {
    expect(() => canonicalize(NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalize(Infinity)).toThrow(CanonicalJsonError);
    expect(() => canonicalize({ a: undefined })).toThrow(CanonicalJsonError);
    expect(() => canonicalize("\ud800")).toThrow(CanonicalJsonError);
    expect(() => canonicalize(new Date())).toThrow(CanonicalJsonError);
    expect(() => canonicalize(1n)).toThrow(CanonicalJsonError);
  });
  test("round trip through the strict parser", () => {
    const v = { z: [1, { y: null, x: "é" }], a: true };
    expect(canonicalize(parseJsonStrict(canonicalize(v)))).toBe(canonicalize(v));
  });
});

describe("parseJsonStrict", () => {
  test("refuses duplicate keys, trailing data, bare tokens and huge numbers", () => {
    for (const bad of ['{"a":1,"a":2}', "[1,]", "{\"a\":1} x", "NaN", "{\"a\":1e999}", "01", "[1 2]", '{"a" 1}']) {
      expect(() => parseJsonStrict(bad)).toThrow(CanonicalJsonError);
    }
  });
  test("refuses nesting past the depth cap", () => {
    expect(() => parseJsonStrict("[".repeat(100) + "]".repeat(100))).toThrow(CanonicalJsonError);
  });
  test("keeps a __proto__ key as data", () => {
    const v = parseJsonStrict('{"__proto__":1}') as Record<string, unknown>;
    expect(Object.keys(v)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
  });
});

import { describe, expect, test } from "bun:test";
import { equalBytes, fromBase64, fromBase64Url, fromHex, toBase64, toBase64Url, toHex, u64be, readU64 } from "./bytes.ts";

describe("bytes", () => {
  test("hex round-trips and is strict", () => {
    expect(toHex(Uint8Array.of(0, 15, 255))).toBe("000fff");
    expect([...fromHex("000fff")]).toEqual([0, 15, 255]);
    for (const bad of ["0F", "abc", "zz", " 00"]) expect(() => fromHex(bad)).toThrow();
  });
  test("base64 matches Buffer for every length", () => {
    for (let n = 0; n < 40; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
      expect(toBase64(b)).toBe(Buffer.from(b).toString("base64"));
      expect([...fromBase64(toBase64(b))]).toEqual([...b]);
      expect(toBase64Url(b)).toBe(Buffer.from(b).toString("base64url"));
      expect([...fromBase64Url(toBase64Url(b))]).toEqual([...b]);
    }
  });
  test("base64 refuses malformed input", () => {
    for (const bad of ["abc", "ab=c", "a===", "ab!d"]) expect(() => fromBase64(bad)).toThrow();
    expect(() => fromBase64Url("a")).toThrow();
    expect(() => fromBase64Url("ab+/")).toThrow();
  });
  test("equalBytes and u64", () => {
    expect(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(equalBytes(Uint8Array.of(1), Uint8Array.of(1, 2))).toBe(false);
    expect(readU64(u64be(2n ** 63n + 5n), 0)).toBe(2n ** 63n + 5n);
  });
});

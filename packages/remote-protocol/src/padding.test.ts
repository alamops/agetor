import { describe, expect, test } from "bun:test";
import { PADDING_BUCKETS } from "./constants.ts";
import { PaddingError, bucketFor, pad, unpad } from "./padding.ts";
import vectors from "../vectors/agetor-padding.json";

describe("padding", () => {
  test("every bucket edge pads to its bucket and round-trips", () => {
    for (const b of PADDING_BUCKETS) {
      const edge = new Uint8Array(b - 1).fill(7);
      expect(pad(edge).length).toBe(b);
      expect(unpad(pad(edge))).toEqual(edge);
      if (b !== PADDING_BUCKETS[PADDING_BUCKETS.length - 1]) {
        const over = new Uint8Array(b).fill(7);
        expect(pad(over).length).toBeGreaterThan(b);
      }
    }
    expect(PADDING_BUCKETS[4]).toBe(65535 - 16);
  });
  test("payloads that end in zeros or 0x80 survive", () => {
    for (const p of [Uint8Array.of(0, 0, 0), Uint8Array.of(0x80), Uint8Array.of(), Uint8Array.of(0x80, 0, 0x80)]) {
      expect(unpad(pad(p))).toEqual(p);
    }
  });
  test("an oversize payload is refused", () => {
    expect(bucketFor(65519)).toBeNull();
    expect(() => pad(new Uint8Array(65519))).toThrow(PaddingError);
  });
  test("bad padding is refused", () => {
    expect(() => unpad(new Uint8Array(300))).toThrow(PaddingError);
    expect(() => unpad(new Uint8Array(256))).toThrow(PaddingError);
    const noMarker = new Uint8Array(256).fill(1);
    expect(() => unpad(noMarker)).toThrow(PaddingError);
  });
  test("the vectors agree", () => {
    for (const c of vectors.cases) expect(pad(new Uint8Array(c.payloadLength).fill(0x61)).length).toBe(c.paddedLength);
  });
});

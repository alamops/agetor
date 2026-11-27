import { describe, expect, test } from "bun:test";
import { fromHex, toHex } from "./bytes.ts";
import { FrameError, decodeFrame, encodeFrame } from "./relay-frames.ts";
import vectors from "../vectors/agetor-relay-frames.json";

describe("relay frames", () => {
  test("every vector frame encodes to its bytes and decodes back", () => {
    for (const v of vectors.frames) {
      const bytes = fromHex(v.hex);
      const f = decodeFrame(bytes);
      expect(toHex(encodeFrame(f))).toBe(v.hex);
      expect(f.type as string).toBe((v.frame as { type: string }).type);
    }
  });
  test("refused vectors", () => {
    for (const r of vectors.refused) expect(() => decodeFrame(fromHex(r.hex))).toThrow(FrameError);
  });
  test("bytes after the known fields are ignored", () => {
    expect(decodeFrame(fromHex(vectors.ignoredTrailing.hex)).type).toBe("full");
  });
  test("a frame over 66 KB is refused before parsing", () => {
    const big = new Uint8Array(66 * 1024 + 1);
    big[0] = 1;
    big[1] = 3;
    expect(() => decodeFrame(big)).toThrow("66 KB");
  });
  test("fuzz: 10,000 random buffers and truncations only ever throw FrameError", () => {
    let threw = 0;
    const seed = encodeFrame({ type: "deliver", mailbox: new Uint8Array(16).fill(1), seq: 9n, tag: new Uint8Array(8).fill(2), payload: new Uint8Array(30).fill(3) });
    for (let i = 0; i < 10000; i++) {
      let b: Uint8Array;
      if (i % 3 === 0) b = crypto.getRandomValues(new Uint8Array(Math.floor(Math.random() * 120)));
      else if (i % 3 === 1) b = seed.slice(0, Math.floor(Math.random() * seed.length));
      else {
        b = seed.slice();
        b[Math.floor(Math.random() * b.length)] = Math.floor(Math.random() * 256);
      }
      if (b.length > 1 && i % 3 === 0) { b[0] = 1; b[1] = 1 + (i % 12); }
      try {
        decodeFrame(b);
      } catch (e) {
        threw++;
        expect(e).toBeInstanceOf(FrameError);
      }
    }
    expect(threw).toBeGreaterThan(1000);
  });
  test("encode refuses wrong-sized fields", () => {
    expect(() => encodeFrame({ type: "ack", mailbox: new Uint8Array(15), seq: 1n })).toThrow(FrameError);
    expect(() => encodeFrame({ type: "hello", role: "core", keys: [] })).toThrow(FrameError);
  });
});

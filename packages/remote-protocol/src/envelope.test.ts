import { describe, expect, test } from "bun:test";
import { fromHex, toHex, utf8 } from "./bytes.ts";
import { EnvelopeError, Reassembler, seal } from "./envelope.ts";
import { MAX_CHUNKS_PER_MESSAGE } from "./constants.ts";
import vectors from "../vectors/agetor-envelope.json";

describe("envelope", () => {
  test("a small message is one padded chunk and reassembles", () => {
    const parts = seal("response", "m1", utf8("hello"));
    expect(parts.length).toBe(1);
    const m = new Reassembler().push(parts[0]!);
    expect(m?.t).toBe("response");
    expect(m?.id).toBe("m1");
    expect(new TextDecoder().decode(m!.body)).toBe("hello");
  });
  test("a big message chunks, and every plaintext fits one Noise message", () => {
    const body = crypto.getRandomValues(new Uint8Array(300_000));
    const parts = seal("event", "m2", body);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(65535 - 16);
    const r = new Reassembler();
    let out = null;
    for (const p of parts) out = r.push(p);
    expect(toHex(out!.body)).toBe(toHex(body));
    expect(r.inFlight()).toBe(0);
  });
  test("out-of-order, duplicate and header-changing chunks are refused", () => {
    const parts = seal("event", "m3", new Uint8Array(250), 100);
    expect(parts.length).toBe(3);
    expect(() => new Reassembler().push(parts[1]!)).toThrow(EnvelopeError);
    const r = new Reassembler();
    r.push(parts[0]!);
    expect(() => r.push(parts[0]!)).toThrow("duplicate");
    const r2 = new Reassembler();
    r2.push(parts[0]!);
    expect(() => r2.push(parts[2]!)).toThrow("out of order");
    const other = seal("other", "m3", new Uint8Array(250), 100);
    const r3 = new Reassembler();
    r3.push(parts[0]!);
    expect(() => r3.push(other[1]!)).toThrow("changed");
  });
  test("caps: too many chunks, too many in flight", () => {
    expect(() => seal("x", "id", new Uint8Array(MAX_CHUNKS_PER_MESSAGE + 1), 1)).toThrow(EnvelopeError);
    const r = new Reassembler();
    for (let i = 0; i < 16; i++) r.push(seal("x", `id${i}`, new Uint8Array(250), 100)[0]!);
    expect(() => r.push(seal("x", "id16", new Uint8Array(250), 100)[0]!)).toThrow("in flight");
  });
  test("unknown fields and bad shapes are refused", () => {
    const bad = (obj: unknown) => {
      const text = JSON.stringify(obj);
      const padded = new Uint8Array(256);
      padded.set(utf8(text));
      padded[utf8(text).length] = 0x80;
      return padded;
    };
    expect(() => new Reassembler().push(bad({ t: "a", id: "b", ci: 0, cc: 1, b: "", extra: 1 }))).toThrow(EnvelopeError);
    expect(() => new Reassembler().push(bad({ t: "a", id: "b", ci: 1, cc: 1, b: "" }))).toThrow(EnvelopeError);
    expect(() => new Reassembler().push(bad({ t: "a", id: "b", ci: 0, cc: 1, b: "!!" }))).toThrow(EnvelopeError);
    expect(() => new Reassembler().push(new Uint8Array(100))).toThrow(EnvelopeError);
  });
  test("the vectors agree", () => {
    const single = vectors.single;
    expect(seal(single.t, single.id, fromHex(single.body)).map(toHex)).toEqual(single.plaintexts);
    const ch = vectors.chunked;
    expect(seal(ch.t, ch.id, fromHex(ch.body), ch.chunkBytes).map(toHex)).toEqual(ch.plaintexts);
  });
});

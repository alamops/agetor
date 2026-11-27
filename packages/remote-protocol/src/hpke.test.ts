import { describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { fromHex, toHex, utf8 } from "./bytes.ts";
import { HpkeError, hpkeOpen, hpkeSeal, setupBaseR, setupBaseS } from "./hpke.ts";
import rfc from "../vectors/rfc9180-base-x25519-chacha.json";

describe("HPKE base mode, DHKEM(X25519, HKDF-SHA256) + ChaCha20-Poly1305: RFC 9180 vectors", () => {
  test("the suite is the one the vectors name", () => {
    expect(rfc.suite).toEqual({ mode: 0, kem_id: 32, kdf_id: 1, aead_id: 3 });
    expect(rfc.source).toContain("rfc9180");
    expect(rfc.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("the sender derives the vector's enc, key, base nonce and ciphertexts", () => {
    const { enc, context } = setupBaseS(fromHex(rfc.pkRm), fromHex(rfc.info), fromHex(rfc.skEm));
    expect(toHex(enc)).toBe(rfc.enc);
    for (const e of rfc.encryptions) {
      expect(toHex(context.seal(fromHex(e.aad), fromHex(e.pt)))).toBe(e.ct);
    }
    expect(toHex(context.exporterSecret)).toBe(rfc.exporter_secret);
  });

  test("the receiver opens the vector's ciphertexts in sequence", () => {
    const ctx = setupBaseR(fromHex(rfc.enc), fromHex(rfc.skRm), fromHex(rfc.info));
    for (const e of rfc.encryptions) {
      expect(toHex(ctx.open(fromHex(e.aad), fromHex(e.ct)))).toBe(e.pt);
    }
    expect(toHex(ctx.exporterSecret)).toBe(rfc.exporter_secret);
  });
});

describe("one-shot seal and open", () => {
  const sk = x25519.utils.randomSecretKey();
  const pk = x25519.getPublicKey(sk);
  const info = utf8("agetor-push/1");

  test("round trip, with fresh ephemeral keys each time", () => {
    const a = hpkeSeal(pk, info, new Uint8Array(0), utf8("hello"));
    const b = hpkeSeal(pk, info, new Uint8Array(0), utf8("hello"));
    expect(toHex(a)).not.toBe(toHex(b));
    expect(toHex(hpkeOpen(sk, info, new Uint8Array(0), a))).toBe(toHex(utf8("hello")));
  });

  test("a wrong key, info, aad, flipped bit or truncation fails", () => {
    const sealed = hpkeSeal(pk, info, utf8("aad"), utf8("hello"));
    expect(() => hpkeOpen(x25519.utils.randomSecretKey(), info, utf8("aad"), sealed)).toThrow(HpkeError);
    expect(() => hpkeOpen(sk, utf8("other"), utf8("aad"), sealed)).toThrow(HpkeError);
    expect(() => hpkeOpen(sk, info, utf8("other"), sealed)).toThrow(HpkeError);
    const flipped = sealed.slice();
    flipped[40] = (flipped[40] as number) ^ 1;
    expect(() => hpkeOpen(sk, info, utf8("aad"), flipped)).toThrow(HpkeError);
    expect(() => hpkeOpen(sk, info, utf8("aad"), sealed.slice(0, 40))).toThrow(HpkeError);
  });

  test("a low-order recipient or enc is refused", () => {
    expect(() => setupBaseS(new Uint8Array(32), info)).toThrow(HpkeError);
    expect(() => setupBaseR(new Uint8Array(32), sk, info)).toThrow(HpkeError);
    expect(() => setupBaseS(new Uint8Array(31), info)).toThrow(HpkeError);
  });
});

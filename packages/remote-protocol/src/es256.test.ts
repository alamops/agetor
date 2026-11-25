import { describe, expect, test } from "bun:test";
import { p256 } from "@noble/curves/nist.js";
import { toHex } from "./bytes.ts";
import { signEs256, verifyEs256 } from "./es256.ts";

const N = p256.Point.Fn.ORDER;

async function webCryptoSignature(msg: Uint8Array): Promise<{ pub: Uint8Array; sig: Uint8Array }> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, msg as BufferSource));
  return { pub, sig };
}

describe("verifyEs256", () => {
  test("200 WebCrypto signatures verify, high-S included", async () => {
    let high = 0;
    for (let i = 0; i < 200; i++) {
      const msg = crypto.getRandomValues(new Uint8Array(40));
      const { pub, sig } = await webCryptoSignature(msg);
      if (BigInt("0x" + toHex(sig.slice(32))) > N / 2n) high++;
      expect(verifyEs256(pub, msg, sig)).toBe(true);
    }
    // Sanity: the corpus really contained high-S signatures, so lowS:false is what makes this pass (E2).
    expect(high).toBeGreaterThan(40);
  });
  test("noble's default (lowS:true) would have rejected some of them", async () => {
    let rejected = 0;
    for (let i = 0; i < 60; i++) {
      const msg = crypto.getRandomValues(new Uint8Array(32));
      const { pub, sig } = await webCryptoSignature(msg);
      if (!p256.verify(sig, msg, pub)) rejected++;
    }
    expect(rejected).toBeGreaterThan(0);
  });
  test("a flipped bit, a wrong message and a DER signature fail", async () => {
    const msg = new TextEncoder().encode("consent");
    const { pub, sig } = await webCryptoSignature(msg);
    const flipped = sig.slice();
    flipped[5] = (flipped[5] as number) ^ 1;
    expect(verifyEs256(pub, msg, flipped)).toBe(false);
    expect(verifyEs256(pub, new TextEncoder().encode("other"), sig)).toBe(false);
    const der = Uint8Array.of(0x30, 0x44, 0x02, 0x20, ...sig.slice(0, 32), 0x02, 0x20, ...sig.slice(32));
    expect(verifyEs256(pub, msg, der)).toBe(false);
    expect(verifyEs256(pub, msg, sig.slice(0, 63))).toBe(false);
  });
  test("a compressed or malformed public key fails closed", () => {
    const sk = p256.utils.randomSecretKey();
    const msg = Uint8Array.of(1, 2, 3);
    const sig = signEs256(sk, msg);
    expect(verifyEs256(p256.getPublicKey(sk, true), msg, sig)).toBe(false);
    expect(verifyEs256(new Uint8Array(65), msg, sig)).toBe(false);
    expect(verifyEs256(p256.getPublicKey(sk, false), msg, sig)).toBe(true);
  });
});

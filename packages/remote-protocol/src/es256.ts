/**
 * ES256 (ECDSA P-256 with SHA-256), raw `r‖s` signatures (64 bytes), uncompressed public keys (65 bytes).
 *
 * `lowS:false` is load-bearing: WebCrypto, CryptoKit and Android Keystore produce high-S signatures about half the
 * time, and noble's default (`lowS:true`) rejects those (spike E2: 107/200 verified with defaults, 200/200 with
 * `lowS:false`). A DER signature is refused by length.
 */
import { p256 } from "@noble/curves/nist.js";

export const ES256_SIG_BYTES = 64;
export const P256_PUB_BYTES = 65;

export function verifyEs256(pubRaw: Uint8Array, msg: Uint8Array, sigRaw64: Uint8Array): boolean {
  if (pubRaw.length !== P256_PUB_BYTES || pubRaw[0] !== 4) return false;
  if (sigRaw64.length !== ES256_SIG_BYTES) return false;
  try {
    return p256.verify(sigRaw64, msg, pubRaw, { lowS: false });
  } catch {
    return false;
  }
}

export function signEs256(secretKey: Uint8Array, msg: Uint8Array): Uint8Array {
  return p256.sign(msg, secretKey, { lowS: false });
}

export function generateP256(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const secretKey = p256.utils.randomSecretKey();
  return { secretKey, publicKey: p256.getPublicKey(secretKey, false) };
}

export function p256PublicFromSecret(secretKey: Uint8Array): Uint8Array {
  return p256.getPublicKey(secretKey, false);
}

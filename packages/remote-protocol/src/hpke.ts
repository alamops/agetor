/**
 * HPKE (RFC 9180) base mode with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and ChaCha20-Poly1305: the suite sealing every push
 * payload to the phone's push key (spec "Keys and cryptography", grill C4). Only what the Companion needs: `setupBaseS`/`setupBaseR`
 * contexts and the one-shot `seal`/`open`. Passes RFC 9180's test vectors for this suite (`vectors/rfc9180-base-x25519-chacha.json`).
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, u16be, utf8, zero } from "./bytes.ts";

export class HpkeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HpkeError";
  }
}

const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0003;
const MODE_BASE = 0;
const NK = 32;
const NN = 12;
const NSECRET = 32;
const NENC = 32;
const EMPTY = new Uint8Array(0);

const KEM_SUITE = concat(utf8("KEM"), u16be(KEM_ID));
const HPKE_SUITE = concat(utf8("HPKE"), u16be(KEM_ID), u16be(KDF_ID), u16be(AEAD_ID));
const V1 = utf8("HPKE-v1");

function labeledExtract(suite: Uint8Array, salt: Uint8Array | undefined, label: string, ikm: Uint8Array): Uint8Array {
  return extract(sha256, concat(V1, suite, utf8(label), ikm), salt && salt.length > 0 ? salt : undefined);
}

function labeledExpand(suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, length: number): Uint8Array {
  return expand(sha256, prk, concat(u16be(length), V1, suite, utf8(label), info), length);
}

function extractAndExpand(dh: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const eaePrk = labeledExtract(KEM_SUITE, undefined, "eae_prk", dh);
  return labeledExpand(KEM_SUITE, eaePrk, "shared_secret", kemContext, NSECRET);
}

function dh(secret: Uint8Array, pub: Uint8Array): Uint8Array {
  let out: Uint8Array;
  try {
    out = x25519.getSharedSecret(secret, pub);
  } catch {
    throw new HpkeError("invalid or low-order public key");
  }
  let all = 0;
  for (const b of out) all |= b;
  if (all === 0) throw new HpkeError("low-order public key");
  return out;
}

function keySchedule(sharedSecret: Uint8Array, info: Uint8Array): { key: Uint8Array; baseNonce: Uint8Array; exporterSecret: Uint8Array } {
  const pskIdHash = labeledExtract(HPKE_SUITE, undefined, "psk_id_hash", EMPTY);
  const infoHash = labeledExtract(HPKE_SUITE, undefined, "info_hash", info);
  const context = concat(Uint8Array.of(MODE_BASE), pskIdHash, infoHash);
  const secret = labeledExtract(HPKE_SUITE, sharedSecret, "secret", EMPTY);
  return {
    key: labeledExpand(HPKE_SUITE, secret, "key", context, NK),
    baseNonce: labeledExpand(HPKE_SUITE, secret, "base_nonce", context, NN),
    exporterSecret: labeledExpand(HPKE_SUITE, secret, "exp", context, 32),
  };
}

/** An HPKE encryption context: a key, a base nonce and a sequence number. */
export class HpkeContext {
  private seq = 0n;
  constructor(
    private readonly key: Uint8Array,
    private readonly baseNonce: Uint8Array,
    readonly exporterSecret: Uint8Array,
  ) {}

  private nonce(): Uint8Array {
    const n = this.baseNonce.slice();
    const view = new DataView(n.buffer);
    // base_nonce XOR I2OSP(seq, Nn): the sequence number occupies the last 8 bytes.
    const tail = view.getBigUint64(NN - 8, false) ^ this.seq;
    view.setBigUint64(NN - 8, tail, false);
    return n;
  }

  seal(aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    const ct = chacha20poly1305(this.key, this.nonce(), aad).encrypt(plaintext);
    this.seq++;
    return ct;
  }

  open(aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    let pt: Uint8Array;
    try {
      pt = chacha20poly1305(this.key, this.nonce(), aad).decrypt(ciphertext);
    } catch {
      throw new HpkeError("decryption failed");
    }
    this.seq++;
    return pt;
  }

  destroy(): void {
    zero(this.key);
    zero(this.baseNonce);
  }
}

/** SetupBaseS: encapsulate to `recipientPublic` and derive the sender context. `ephemeralSecret` is for vectors only. */
export function setupBaseS(recipientPublic: Uint8Array, info: Uint8Array, ephemeralSecret?: Uint8Array): { enc: Uint8Array; context: HpkeContext } {
  if (recipientPublic.length !== NENC) throw new HpkeError("recipient public key must be 32 bytes");
  const skE = ephemeralSecret ?? x25519.utils.randomSecretKey();
  const pkE = x25519.getPublicKey(skE);
  const shared = extractAndExpand(dh(skE, recipientPublic), concat(pkE, recipientPublic));
  const { key, baseNonce, exporterSecret } = keySchedule(shared, info);
  if (!ephemeralSecret) zero(skE);
  return { enc: pkE, context: new HpkeContext(key, baseNonce, exporterSecret) };
}

/** SetupBaseR: decapsulate `enc` with the recipient's private key and derive the receiver context. */
export function setupBaseR(enc: Uint8Array, recipientSecret: Uint8Array, info: Uint8Array): HpkeContext {
  if (enc.length !== NENC) throw new HpkeError("enc must be 32 bytes");
  const pkR = x25519.getPublicKey(recipientSecret);
  const shared = extractAndExpand(dh(recipientSecret, enc), concat(enc, pkR));
  const { key, baseNonce, exporterSecret } = keySchedule(shared, info);
  return new HpkeContext(key, baseNonce, exporterSecret);
}

/** One-shot seal: returns `enc ‖ ciphertext`. */
export function hpkeSeal(recipientPublic: Uint8Array, info: Uint8Array, aad: Uint8Array, plaintext: Uint8Array, ephemeralSecret?: Uint8Array): Uint8Array {
  const { enc, context } = setupBaseS(recipientPublic, info, ephemeralSecret);
  const ct = context.seal(aad, plaintext);
  context.destroy();
  return concat(enc, ct);
}

/** One-shot open of `enc ‖ ciphertext`. */
export function hpkeOpen(recipientSecret: Uint8Array, info: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array {
  if (sealed.length < NENC + 16) throw new HpkeError("sealed message too short");
  const context = setupBaseR(sealed.slice(0, NENC), recipientSecret, info);
  try {
    return context.open(aad, sealed.slice(NENC));
  } finally {
    context.destroy();
  }
}

export const HPKE_ENC_BYTES = NENC;
export const HPKE_SUITE_IDS = { kem: KEM_ID, kdf: KDF_ID, aead: AEAD_ID } as const;

/** Key and id derivations (spec "Keys and cryptography"). Every derivation has a vector in `vectors/agetor-derive.json`. */
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, readU32, toHex, u32be, utf8 } from "./bytes.ts";
import { INFO_MAILBOX, INFO_PAIRING, INFO_SAS, MAILBOX_ID_BYTES, MAILBOX_KEY_BYTES } from "./constants.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` in UTC. */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The day's mailbox key for a device: HKDF-SHA256(link secret, info `agetor-mailbox/1` ‖ date). */
export function mailboxKey(linkSecret: Uint8Array, date: string): Uint8Array {
  if (!DATE_RE.test(date)) throw new RangeError("date must be YYYY-MM-DD");
  return hkdf(sha256, linkSecret, undefined, concat(utf8(INFO_MAILBOX), utf8(date)), MAILBOX_KEY_BYTES);
}

/** The pairing mailbox key: HKDF-SHA256(pairing secret, info `agetor-pairing/1`). */
export function pairingMailboxKey(pairingSecret: Uint8Array): Uint8Array {
  return hkdf(sha256, pairingSecret, undefined, utf8(INFO_PAIRING), MAILBOX_KEY_BYTES);
}

/** The mailbox id is the first 16 bytes of the key's SHA-256. The relay never stores the key. */
export function mailboxId(key: Uint8Array): Uint8Array {
  return sha256(key).slice(0, MAILBOX_ID_BYTES);
}

/** The six-digit pairing code both sides show: u32be(HKDF(handshake hash, `agetor-sas/1`)[0..4]) mod 1,000,000. */
export function sasCode(handshakeHash: Uint8Array): string {
  const okm = hkdf(sha256, handshakeHash, undefined, utf8(INFO_SAS), 32);
  const n = readU32(okm, 0) % 1_000_000;
  return String(n).padStart(6, "0");
}

/** The core id: SHA-256 of the core's X25519 public key. */
export function coreId(corePub: Uint8Array): Uint8Array {
  return sha256(corePub);
}

/** The stable, opaque push collapse id for a task: HMAC-SHA256(link secret, task id). */
export function collapseId(linkSecret: Uint8Array, taskId: string): Uint8Array {
  return hmac(sha256, linkSecret, utf8(taskId));
}

/** The push gateway request MAC: HMAC-SHA256 under the device's push send key over the canonical request bytes. */
export function pushRequestMac(sendKey: Uint8Array, canonicalRequest: Uint8Array): Uint8Array {
  return hmac(sha256, sendKey, canonicalRequest);
}

export function sha256Hex(b: Uint8Array): string {
  return toHex(sha256(b));
}

export { u32be };

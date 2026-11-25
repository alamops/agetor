/**
 * The pairing QR payload (spec "Pairing" step 2): base64url, no padding, of the canonical JSON
 * `{"fmt":1,"corePub":hex32,"relayUrl":string,"mailbox":hex16,"pairingSecret":hex32,"expiresAt":ms}`.
 * The key helper builds it (native/keyhelper/PairingWindow.swift), the phone parses it with this format, and
 * `vectors/agetor-qr.json` is the contract between the two (the helper's `selftest-vectors` checks it).
 */
import { fromBase64Url, fromUtf8, toBase64Url } from "./bytes.ts";
import { canonicalBytes, parseJsonStrict } from "./canonical-json.ts";
import { ParseError, parseValue, type Spec } from "./messages.ts";

export interface QrPayload {
  fmt: 1;
  corePub: string;
  relayUrl: string;
  mailbox: string;
  pairingSecret: string;
  expiresAt: number;
}

const QR_SPEC: Spec = {
  t: "object",
  fields: {
    fmt: { t: "lit", value: 1 },
    corePub: { t: "hex", bytes: 32 },
    relayUrl: { t: "str", min: 8, max: 512, pattern: /^wss?:\/\/[^\s]+$/, patternHint: "a ws:// or wss:// URL" },
    mailbox: { t: "hex", bytes: 16 },
    pairingSecret: { t: "hex", bytes: 32 },
    expiresAt: { t: "int", min: 0, max: 253402300799999 },
  },
};

export const QR_MAX_CHARS = 1024;

export function encodeQr(p: QrPayload): string {
  parseValue(QR_SPEC, p);
  return toBase64Url(canonicalBytes(p));
}

/** Strict decode: base64url, UTF-8, JSON with no duplicate keys, exactly the six fields. Throws ParseError. */
export function decodeQr(s: string): QrPayload {
  if (typeof s !== "string" || s.length === 0 || s.length > QR_MAX_CHARS) throw new ParseError("bad QR size");
  let value: unknown;
  try {
    value = parseJsonStrict(fromUtf8(fromBase64Url(s)));
  } catch {
    throw new ParseError("bad QR encoding");
  }
  return parseValue<QrPayload>(QR_SPEC, value);
}

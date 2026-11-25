import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { toBase64Url, utf8 } from "./bytes.ts";
import { canonicalBytes } from "./canonical-json.ts";
import { ParseError } from "./messages.ts";
import { decodeQr, encodeQr, type QrPayload } from "./qr.ts";
import vectors from "../vectors/agetor-qr.json";

const cases: QrPayload[] = [
  { fmt: 1, corePub: "ab".repeat(32), relayUrl: "wss://relay.example.test/v1", mailbox: "cd".repeat(16), pairingSecret: "ef".repeat(32), expiresAt: 1795560120000 },
  { fmt: 1, corePub: "00".repeat(32), relayUrl: "ws://127.0.0.1:8787", mailbox: "11".repeat(16), pairingSecret: "22".repeat(32), expiresAt: 1 },
];

if (process.env.UPDATE_VECTORS === "1") {
  await Bun.write(
    resolve(import.meta.dir, "../vectors/agetor-qr.json"),
    JSON.stringify({ source: "Agetor pairing QR: base64url (no padding) of the RFC 8785 canonical JSON; the key helper builds it too", cases: cases.map((payload) => ({ payload, qr: encodeQr(payload) })) }, null, 2) + "\n",
  );
}

describe("pairing QR", () => {
  test("the vectors match and decode back (UPDATE_VECTORS=1 rewrites them after an intended change)", () => {
    expect(vectors.cases.map((c) => c.payload)).toEqual(cases);
    for (const c of vectors.cases) {
      expect(encodeQr(c.payload as QrPayload)).toBe(c.qr);
      expect(decodeQr(c.qr)).toEqual(c.payload as QrPayload);
    }
  });

  test("the encoding is base64url without padding of the canonical JSON", () => {
    const qr = encodeQr(cases[0]!);
    expect(qr).toBe(toBase64Url(canonicalBytes(cases[0])));
    expect(qr).not.toMatch(/[=+/]/);
  });

  test("a strict decode refuses every deviation", () => {
    const good = cases[0]!;
    const enc = (v: unknown) => toBase64Url(utf8(JSON.stringify(v)));
    expect(() => decodeQr("")).toThrow(ParseError);
    expect(() => decodeQr("!!!")).toThrow(ParseError);
    expect(() => decodeQr("a".repeat(2000))).toThrow(ParseError);
    expect(() => decodeQr(enc({ ...good, extra: 1 }))).toThrow(ParseError);
    expect(() => decodeQr(enc({ ...good, fmt: 2 }))).toThrow(ParseError);
    expect(() => decodeQr(enc({ ...good, relayUrl: "https://example.test" }))).toThrow(ParseError);
    expect(() => decodeQr(enc({ ...good, corePub: "AB".repeat(32) }))).toThrow(ParseError);
    expect(() => decodeQr(enc({ ...good, mailbox: "cd".repeat(8) }))).toThrow(ParseError);
    const { expiresAt, ...missing } = good;
    expect(expiresAt).toBeGreaterThan(0);
    expect(() => decodeQr(enc(missing))).toThrow(ParseError);
    expect(() => decodeQr(toBase64Url(utf8('{"fmt":1,"fmt":1}')))).toThrow(ParseError);
  });
});

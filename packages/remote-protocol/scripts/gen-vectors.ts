/**
 * Generates the language-neutral vectors this package owns: `bun scripts/gen-vectors.ts` rewrites
 * `vectors/agetor-{canonical-json,es256,derive,padding,relay-frames,envelope}.json`. The drift test
 * (`src/vectors.test.ts`) regenerates them in memory and fails on any difference, so a vector never changes silently.
 * The Swift and Kotlin implementations must pass these files too.
 */
import { p256 } from "@noble/curves/nist.js";
import { resolve } from "node:path";
import { concat, toBase64, toHex, u32be, utf8 } from "../src/bytes.ts";
import { canonicalize } from "../src/canonical-json.ts";
import { PADDING_BUCKETS } from "../src/constants.ts";
import { coreId, collapseId, mailboxId, mailboxKey, pairingMailboxKey, pushRequestMac, sasCode } from "../src/derive.ts";
import { seal } from "../src/envelope.ts";
import { signEs256 } from "../src/es256.ts";
import { pad } from "../src/padding.ts";
import { encodeFrame, type RelayFrame } from "../src/relay-frames.ts";

const seq = (n: number, start = 0): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);
const hex = toHex;

export function canonicalJsonVectors() {
  const cases: unknown[] = [
    { name: "rfc8785-sample", input: { numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27], string: "\u20ac$\u000f\nA'B\"\\/", literals: [null, true, false] } },
    { name: "key-order", input: { b: 1, a: 2, "": 3, A: 4, "é": 5, "😀": 6, "～": 7 } },
    { name: "nested", input: { z: [{ y: 1, x: [] }, {}], a: { c: null, b: "x" } } },
    { name: "numbers", input: [0, -0, 1, -1, 1.5, 1e21, 1e-7, 100000000000000000000, 0.000001] },
    { name: "escapes", input: "\b\t\n\f\r\u0000\u001f\u007f " },
  ];
  return {
    source: "RFC 8785 sections 3.2 and Appendix B (sample), plus Agetor cases",
    cases: cases.map((c) => {
      const input = (c as { input: unknown }).input;
      const canonical = canonicalize(input);
      return { name: (c as { name: string }).name, input: JSON.parse(JSON.stringify(input)), canonical, canonicalHex: hex(utf8(canonical)) };
    }),
    invalid: ["{\"a\":1,\"a\":2}", "{\"a\":NaN}", "[1,]", "{\"a\":1e999}"],
  };
}

const N = p256.Point.Fn.ORDER;
function highS(sig: Uint8Array): Uint8Array {
  const r = sig.slice(0, 32);
  const s = BigInt("0x" + toHex(sig.slice(32)));
  const flipped = N - s;
  const sb = flipped.toString(16).padStart(64, "0");
  return concat(r, Uint8Array.from(sb.match(/../g)!.map((h) => parseInt(h, 16))));
}

export function es256Vectors() {
  const out: unknown[] = [];
  for (let i = 1; i <= 6; i++) {
    const secret = seq(32, i * 7);
    secret[0] = 1;
    const pub = p256.getPublicKey(secret, false);
    const msg = utf8(`agetor es256 vector ${i}`);
    const sig = signEs256(secret, msg);
    const sBig = BigInt("0x" + toHex(sig.slice(32)));
    const low = sBig <= N / 2n ? sig : highS(sig);
    const high = highS(low);
    out.push({ name: `case-${i}`, pub: hex(pub), msg: hex(msg), valid: [hex(low), hex(high)] });
  }
  const first = out[0] as { pub: string; msg: string; valid: string[] };
  const badFlip = first.valid[0]!.slice(0, 10) + (first.valid[0]![10] === "0" ? "1" : "0") + first.valid[0]!.slice(11);
  return {
    source: "Agetor: deterministic P-256 keys, each signature both low-S and high-S (CryptoKit and WebCrypto emit both)",
    cases: out,
    invalid: [
      { name: "flipped-bit", pub: first.pub, msg: first.msg, sig: badFlip },
      { name: "der-encoded", pub: first.pub, msg: first.msg, sig: "3044" + first.valid[0]!.slice(0, 136) },
      { name: "wrong-message", pub: first.pub, msg: hex(utf8("other")), sig: first.valid[0] },
    ],
  };
}

export function deriveVectors() {
  const link = seq(32, 1);
  const pairing = seq(32, 100);
  const hh = seq(32, 50);
  const corePub = seq(32, 9);
  const dates = ["2026-11-24", "2026-11-25", "2026-12-31"];
  return {
    source: "Agetor: HKDF-SHA256 (RFC 5869) derivations, also cross-checked against node:crypto in derive.test.ts",
    linkSecret: hex(link),
    pairingSecret: hex(pairing),
    handshakeHash: hex(hh),
    corePub: hex(corePub),
    mailbox: dates.map((d) => ({ date: d, key: hex(mailboxKey(link, d)), id: hex(mailboxId(mailboxKey(link, d))) })),
    pairingMailbox: { key: hex(pairingMailboxKey(pairing)), id: hex(mailboxId(pairingMailboxKey(pairing))) },
    sas: sasCode(hh),
    sasCases: [seq(32, 0), seq(32, 1), seq(32, 2), seq(32, 3)].map((h) => ({ handshakeHash: hex(h), code: sasCode(h) })),
    coreId: hex(coreId(corePub)),
    collapse: { taskId: "9a1f0c2e-1111-4222-8333-444455556666", id: hex(collapseId(link, "9a1f0c2e-1111-4222-8333-444455556666")) },
    pushMac: { sendKey: hex(seq(32, 77)), request: hex(utf8('{"a":1}')), mac: hex(pushRequestMac(seq(32, 77), utf8('{"a":1}'))) },
  };
}

export function paddingVectors() {
  const cases: unknown[] = [];
  for (const b of PADDING_BUCKETS) {
    for (const len of [b - 1, b - 2, b === PADDING_BUCKETS[0] ? 0 : b / 2]) {
      if (len < 0 || len + 1 > b) continue;
      const payload = new Uint8Array(len).fill(0x61);
      cases.push({ payloadLength: len, paddedLength: pad(payload).length, bucket: b });
    }
  }
  cases.push({ payloadLength: 0, paddedLength: 256, bucket: 256 }, { payloadLength: 255, paddedLength: 256, bucket: 256 }, { payloadLength: 256, paddedLength: 1024, bucket: 1024 });
  return { source: "Agetor: ISO/IEC 7816-4 padding to the buckets 256, 1024, 4096, 16384, 65519", buckets: [...PADDING_BUCKETS], payloadByte: "61", cases, small: { payload: hex(utf8("hi")), padded: hex(pad(utf8("hi"))).slice(0, 12) + "…" } };
}

export function relayFrameVectors() {
  const key = (n: number) => seq(32, n);
  const id = (n: number) => seq(16, n);
  const frames: RelayFrame[] = [
    { type: "hello", role: "core", keys: [key(1), key(2)] },
    { type: "hello", role: "device", keys: [key(3)] },
    { type: "welcome", ids: [id(1), id(2)], queued: 3 },
    { type: "send", mailbox: id(1), tag: seq(8, 5), payload: utf8("ciphertext") },
    { type: "deliver", mailbox: id(1), seq: 42n, tag: seq(8, 5), payload: utf8("ciphertext") },
    { type: "ack", mailbox: id(1), seq: 42n },
    { type: "peer", mailbox: id(1), present: true },
    { type: "peer", mailbox: id(1), present: false },
    { type: "full", mailbox: id(1) },
    { type: "replaced", mailbox: id(1) },
    { type: "ping" },
    { type: "pong" },
  ];
  return {
    source: "Agetor relay framing: [version=1][type][fields], big-endian; types hello=1 welcome=2 send=3 deliver=4 ack=5 peer=6 full=7 replaced=8 ping=9 pong=10; roles core=1 device=2",
    frames: frames.map((f) => ({ frame: describe(f), hex: hex(encodeFrame(f)) })),
    refused: [{ name: "unknown-type", hex: "0163" }, { name: "unknown-version", hex: "0209" }, { name: "truncated-hello", hex: "01010101" }, { name: "empty", hex: "" }],
    ignoredTrailing: { hex: hex(concat(encodeFrame({ type: "full", mailbox: id(1) }), utf8("future"))), frame: describe({ type: "full", mailbox: id(1) }) },
  };
}

function describe(f: RelayFrame): unknown {
  return JSON.parse(JSON.stringify(f, (_k, v) => (v instanceof Uint8Array ? toHex(v) : typeof v === "bigint" ? v.toString() : v)));
}

export function envelopeVectors() {
  const body = utf8('{"hello":"world"}');
  const big = new Uint8Array(250).map((_, i) => i & 0xff);
  return {
    source: "Agetor envelope: padded canonical JSON {b,cc,ci,id,t}, b = base64 of the chunk",
    single: { t: "response", id: "m1", body: hex(body), plaintexts: seal("response", "m1", body).map(hex) },
    chunked: { t: "event", id: "m2", chunkBytes: 100, body: hex(big), plaintexts: seal("event", "m2", big, 100).map(hex), base64OfFirstChunk: toBase64(big.subarray(0, 100)) },
    u32: hex(u32be(1000000)),
  };
}

export const FILES = {
  "agetor-canonical-json.json": canonicalJsonVectors,
  "agetor-es256.json": es256Vectors,
  "agetor-derive.json": deriveVectors,
  "agetor-padding.json": paddingVectors,
  "agetor-relay-frames.json": relayFrameVectors,
  "agetor-envelope.json": envelopeVectors,
} as const;

if (import.meta.main) {
  const dir = resolve(import.meta.dir, "../vectors");
  for (const [name, fn] of Object.entries(FILES)) {
    await Bun.write(resolve(dir, name), JSON.stringify(fn(), null, 2) + "\n");
    console.log("wrote", name);
  }
}

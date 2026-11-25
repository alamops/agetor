import { describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { resolve } from "node:path";
import { concat, fromHex, toHex, utf8 } from "./bytes.ts";
import { PROLOGUE_PREFIX } from "./constants.ts";
import { coreId } from "./derive.ts";
import { CipherState, HandshakeState, NoiseError, prologue, type NoisePattern } from "./noise.ts";
import cacophonyNk from "../vectors/cacophony-nk.json";
import cacophonyNkpsk0 from "../vectors/cacophony-nkpsk0.json";
import snowNk from "../vectors/snow-nk.json";
import agetorNoise from "../vectors/agetor-noise.json";

const EMPTY = new Uint8Array(0);

interface UpstreamVector {
  protocol_name: string;
  init_prologue: string;
  init_psks?: string[];
  init_ephemeral: string;
  init_remote_static: string;
  resp_prologue: string;
  resp_psks?: string[];
  resp_static: string;
  resp_ephemeral: string;
  handshake_hash?: string;
  messages: Array<{ payload: string; ciphertext: string }>;
}

function patternOf(name: string): NoisePattern {
  return name.includes("NKpsk0") ? "NKpsk0" : "NK";
}

function pair(v: UpstreamVector) {
  const pattern = patternOf(v.protocol_name);
  const respSecret = fromHex(v.resp_static);
  const respPublic = x25519.getPublicKey(respSecret);
  const initiator = new HandshakeState({
    pattern,
    role: "initiator",
    prologue: fromHex(v.init_prologue),
    psk: v.init_psks?.[0] ? fromHex(v.init_psks[0]) : undefined,
    staticPublic: fromHex(v.init_remote_static),
    ephemeralSecret: fromHex(v.init_ephemeral),
  });
  const responder = new HandshakeState({
    pattern,
    role: "responder",
    prologue: fromHex(v.resp_prologue),
    psk: v.resp_psks?.[0] ? fromHex(v.resp_psks[0]) : undefined,
    staticPublic: respPublic,
    staticDh: (pub) => x25519.getSharedSecret(respSecret, pub),
    ephemeralSecret: fromHex(v.resp_ephemeral),
  });
  return { initiator, responder, respPublic };
}

async function runUpstream(v: UpstreamVector, checkHash: boolean): Promise<void> {
  const { initiator, responder, respPublic } = pair(v);
  // The vector's initiator knows the responder's static key: the public half of resp_static.
  expect(toHex(respPublic)).toBe(v.init_remote_static);
  const m = v.messages;
  // message 0: initiator -> responder
  expect(toHex(await initiator.writeMessage(fromHex(m[0]!.payload)))).toBe(m[0]!.ciphertext);
  expect(toHex(await responder.readMessage(fromHex(m[0]!.ciphertext)))).toBe(m[0]!.payload);
  // message 1: responder -> initiator
  expect(toHex(await responder.writeMessage(fromHex(m[1]!.payload)))).toBe(m[1]!.ciphertext);
  expect(toHex(await initiator.readMessage(fromHex(m[1]!.ciphertext)))).toBe(m[1]!.payload);
  expect(initiator.complete && responder.complete).toBe(true);
  if (checkHash) {
    expect(toHex(initiator.handshakeHash())).toBe(v.handshake_hash!);
    expect(toHex(responder.handshakeHash())).toBe(v.handshake_hash!);
  }
  const i = initiator.split();
  const r = responder.split();
  for (let n = 2; n < m.length; n++) {
    const fromInitiator = n % 2 === 0;
    const sender = fromInitiator ? i.send : r.send;
    const receiver = fromInitiator ? r.recv : i.recv;
    const ct = sender.encrypt(EMPTY, fromHex(m[n]!.payload));
    expect(toHex(ct)).toBe(m[n]!.ciphertext);
    expect(toHex(receiver.decrypt(EMPTY, ct))).toBe(m[n]!.payload);
  }
}

describe("upstream vectors", () => {
  test("cacophony NK: ciphertexts and the handshake hash", async () => {
    expect(cacophonyNk.vectors.length).toBeGreaterThan(0);
    for (const v of cacophonyNk.vectors) await runUpstream(v as UpstreamVector, true);
  });
  test("cacophony NKpsk0: ciphertexts and the handshake hash", async () => {
    expect(cacophonyNkpsk0.vectors.length).toBeGreaterThan(0);
    for (const v of cacophonyNkpsk0.vectors) await runUpstream(v as UpstreamVector, true);
  });
  test("snow NK: ciphertexts (snow's file has no handshake hash)", async () => {
    expect(snowNk.vectors.length).toBeGreaterThan(0);
    for (const v of snowNk.vectors) await runUpstream(v as UpstreamVector, false);
  });
  test("every upstream file records its source, license and retrieval date", () => {
    for (const f of [cacophonyNk, cacophonyNkpsk0, snowNk]) {
      expect(f.source).toMatch(/^https:\/\/github\.com\//);
      expect(f.license.length).toBeGreaterThan(3);
      expect(f.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

// ── Agetor's own vectors ───────────────────────────────────────────────────────────────────────────────────────────────

const seed = (n: number, start: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (start + i * 3) & 0xff);
const RESP_SECRET = seed(32, 11);
const INIT_E = seed(32, 22);
const RESP_E = seed(32, 33);
const PSK = seed(32, 44);
const corePub = x25519.getPublicKey(RESP_SECRET);
const PROLOGUE = prologue(PROLOGUE_PREFIX, coreId(corePub));

interface Built {
  pattern: NoisePattern;
  prologue: string;
  psk?: string;
  responderStaticSecret: string;
  initiatorEphemeral: string;
  responderEphemeral: string;
  handshakeHash: string;
  messages: Array<{ from: "initiator" | "responder"; payload: string; ciphertext: string }>;
  /** Both sides rekey after this many transport messages (counted from 0), then the rest continue. */
  rekeyAfterTransportMessages?: number;
}

async function build(pattern: NoisePattern, rekeyAfter?: number): Promise<Built> {
  const psk = pattern === "NKpsk0" ? PSK : undefined;
  const base = { pattern, prologue: PROLOGUE, psk, staticPublic: corePub };
  const initiator = new HandshakeState({ ...base, role: "initiator", ephemeralSecret: INIT_E });
  const responder = new HandshakeState({ ...base, role: "responder", ephemeralSecret: RESP_E, staticDh: (p) => x25519.getSharedSecret(RESP_SECRET, p) });
  const messages: Built["messages"] = [];
  const p0 = utf8("pairing request");
  const c0 = await initiator.writeMessage(p0);
  await responder.readMessage(c0);
  messages.push({ from: "initiator", payload: toHex(p0), ciphertext: toHex(c0) });
  const p1 = utf8("pairing result");
  const c1 = await responder.writeMessage(p1);
  await initiator.readMessage(c1);
  messages.push({ from: "responder", payload: toHex(p1), ciphertext: toHex(c1) });
  const i = initiator.split();
  const r = responder.split();
  for (let n = 0; n < 6; n++) {
    const fromInitiator = n % 2 === 0;
    if (rekeyAfter !== undefined && n === rekeyAfter) {
      i.send.rekey(); i.recv.rekey(); r.send.rekey(); r.recv.rekey();
    }
    const payload = utf8(`transport ${n}`);
    const ct = (fromInitiator ? i.send : r.send).encrypt(EMPTY, payload);
    expect(toHex((fromInitiator ? r.recv : i.recv).decrypt(EMPTY, ct))).toBe(toHex(payload));
    messages.push({ from: fromInitiator ? "initiator" : "responder", payload: toHex(payload), ciphertext: toHex(ct) });
  }
  return {
    pattern, prologue: toHex(PROLOGUE), psk: psk ? toHex(psk) : undefined,
    responderStaticSecret: toHex(RESP_SECRET), initiatorEphemeral: toHex(INIT_E), responderEphemeral: toHex(RESP_E),
    handshakeHash: toHex(initiator.handshakeHash()), messages, rekeyAfterTransportMessages: rekeyAfter,
  };
}

async function buildVectors() {
  return {
    source: "Agetor: Noise_NK / Noise_NKpsk0 over 25519, ChaChaPoly, SHA256 with the protocol prologue (agetor-remote/1 || core id), plus rekey",
    license: "Same as this repository",
    retrieved: "2026-11-25",
    cases: [await build("NK"), await build("NKpsk0"), await build("NK", 2)],
  };
}

if (process.env.UPDATE_VECTORS === "1") {
  await Bun.write(resolve(import.meta.dir, "../vectors/agetor-noise.json"), JSON.stringify(await buildVectors(), null, 2) + "\n");
}

describe("agetor vectors", () => {
  test("the checked-in file matches the implementation (UPDATE_VECTORS=1 rewrites it after an intended change)", async () => {
    expect(JSON.parse(JSON.stringify(await buildVectors()))).toEqual(agetorNoise);
  });

  test("a responder replays every case from the file: ciphertexts, hash and rekey", async () => {
    for (const c of agetorNoise.cases as unknown as Built[]) {
      const secret = fromHex(c.responderStaticSecret);
      const responder = new HandshakeState({
        pattern: c.pattern, role: "responder", prologue: fromHex(c.prologue), psk: c.psk ? fromHex(c.psk) : undefined,
        staticPublic: x25519.getPublicKey(secret), staticDh: (p) => x25519.getSharedSecret(secret, p), ephemeralSecret: fromHex(c.responderEphemeral),
      });
      expect(toHex(await responder.readMessage(fromHex(c.messages[0]!.ciphertext)))).toBe(c.messages[0]!.payload);
      expect(toHex(await responder.writeMessage(fromHex(c.messages[1]!.payload)))).toBe(c.messages[1]!.ciphertext);
      expect(toHex(responder.handshakeHash())).toBe(c.handshakeHash);
      const { send, recv } = responder.split();
      for (let n = 2; n < c.messages.length; n++) {
        const m = c.messages[n]!;
        if (c.rekeyAfterTransportMessages !== undefined && n - 2 === c.rekeyAfterTransportMessages) {
          send.rekey();
          recv.rekey();
        }
        if (m.from === "initiator") expect(toHex(recv.decrypt(EMPTY, fromHex(m.ciphertext)))).toBe(m.payload);
        else expect(toHex(send.encrypt(EMPTY, fromHex(m.payload)))).toBe(m.ciphertext);
      }
    }
  });
});

// ── Failure behaviour ──────────────────────────────────────────────────────────────────────────────────────────────────

function mk(pattern: NoisePattern, role: "initiator" | "responder", over: Partial<{ prologue: Uint8Array; psk: Uint8Array }> = {}) {
  const common = { pattern, prologue: over.prologue ?? PROLOGUE, psk: pattern === "NKpsk0" ? (over.psk ?? PSK) : undefined, staticPublic: corePub };
  return role === "initiator"
    ? new HandshakeState({ ...common, role })
    : new HandshakeState({ ...common, role, staticDh: (p) => x25519.getSharedSecret(RESP_SECRET, p) });
}

async function handshake(a: HandshakeState, b: HandshakeState) {
  const m0 = await a.writeMessage(utf8("hello"));
  await b.readMessage(m0);
  const m1 = await b.writeMessage(utf8("world"));
  await a.readMessage(m1);
  return { i: a.split(), r: b.split() };
}

describe("failure behaviour", () => {
  test("random ephemerals still interoperate, and both sides agree on the handshake hash", async () => {
    const a = mk("NK", "initiator");
    const b = mk("NK", "responder");
    const { i, r } = await handshake(a, b);
    expect(toHex(a.handshakeHash())).toBe(toHex(b.handshakeHash()));
    expect(toHex(r.recv.decrypt(EMPTY, i.send.encrypt(EMPTY, utf8("x"))))).toBe(toHex(utf8("x")));
  });

  test("a wrong prologue (another protocol version or another core) fails the handshake", async () => {
    for (const bad of [prologue("agetor-remote/2", coreId(corePub)), prologue(PROLOGUE_PREFIX, coreId(seed(32, 99))), EMPTY]) {
      const a = mk("NK", "initiator", { prologue: bad });
      const b = mk("NK", "responder");
      const m0 = await a.writeMessage(utf8("hello"));
      await expect(b.readMessage(m0)).rejects.toThrow(NoiseError);
    }
  });

  test("a wrong PSK fails the pairing handshake", async () => {
    const a = mk("NKpsk0", "initiator", { psk: seed(32, 200) });
    const b = mk("NKpsk0", "responder");
    const m0 = await a.writeMessage(utf8("hello"));
    await expect(b.readMessage(m0)).rejects.toThrow(NoiseError);
  });

  test("a tampered handshake message fails, and the handshake stays failed", async () => {
    const a = mk("NK", "initiator");
    const b = mk("NK", "responder");
    const m0 = await a.writeMessage(utf8("hello"));
    const bad = m0.slice();
    bad[bad.length - 1] = (bad[bad.length - 1] as number) ^ 1;
    await expect(b.readMessage(bad)).rejects.toThrow(NoiseError);
    await expect(b.readMessage(m0)).rejects.toThrow("failed earlier");
  });

  test("a transport message that is flipped, replayed or reordered fails to decrypt", async () => {
    const { i, r } = await handshake(mk("NK", "initiator"), mk("NK", "responder"));
    const c0 = i.send.encrypt(EMPTY, utf8("zero"));
    const c1 = i.send.encrypt(EMPTY, utf8("one"));
    // reordered: message 1 first
    expect(() => r.recv.decrypt(EMPTY, c1)).toThrow(NoiseError);
    // flipped bit
    const flipped = c0.slice();
    flipped[0] = (flipped[0] as number) ^ 1;
    expect(() => r.recv.decrypt(EMPTY, flipped)).toThrow(NoiseError);
    // a failure leaves the counter in place, so the right message still decrypts, once
    expect(toHex(r.recv.decrypt(EMPTY, c0))).toBe(toHex(utf8("zero")));
    expect(() => r.recv.decrypt(EMPTY, c0)).toThrow(NoiseError);
    expect(toHex(r.recv.decrypt(EMPTY, c1))).toBe(toHex(utf8("one")));
  });

  test("a wrong associated-data value fails", async () => {
    const { i, r } = await handshake(mk("NK", "initiator"), mk("NK", "responder"));
    const ct = i.send.encrypt(utf8("ad"), utf8("x"));
    expect(() => r.recv.decrypt(utf8("other"), ct)).toThrow(NoiseError);
  });

  test("rekey: both sides rekey at the same count, one side alone cannot decrypt", async () => {
    const { i, r } = await handshake(mk("NK", "initiator"), mk("NK", "responder"));
    i.send.rekey();
    const first = i.send.encrypt(EMPTY, utf8("x"));
    expect(() => r.recv.decrypt(EMPTY, first)).toThrow(NoiseError);
    r.recv.rekey();
    // The failed attempt did not move the receiver's counter, so the same message now decrypts.
    expect(toHex(r.recv.decrypt(EMPTY, first))).toBe(toHex(utf8("x")));
    expect(toHex(r.recv.decrypt(EMPTY, i.send.encrypt(EMPTY, utf8("y"))))).toBe(toHex(utf8("y")));
  });

  test("the nonce counts messages and refuses at 2^64-1", () => {
    const c = new CipherState(seed(32, 1));
    c.encrypt(EMPTY, EMPTY);
    c.encrypt(EMPTY, EMPTY);
    expect(c.nonce()).toBe(2n);
    (c as unknown as { n: bigint }).n = 2n ** 64n - 1n;
    expect(() => c.encrypt(EMPTY, EMPTY)).toThrow("nonce exhausted");
  });

  test("turns, lengths and misuse are refused", async () => {
    const a = mk("NK", "initiator");
    const b = mk("NK", "responder");
    await expect(a.readMessage(new Uint8Array(100))).rejects.toThrow("out of turn");
    await expect(b.writeMessage(EMPTY)).rejects.toThrow("out of turn");
    await expect(b.readMessage(new Uint8Array(10))).rejects.toThrow("too short");
    expect(() => a.handshakeHash()).toThrow("not complete");
    expect(() => a.split()).toThrow("not complete");
    expect(() => new HandshakeState({ pattern: "NKpsk0", role: "initiator", prologue: EMPTY, staticPublic: corePub })).toThrow("psk");
    expect(() => new HandshakeState({ pattern: "NK", role: "responder", prologue: EMPTY, staticPublic: corePub })).toThrow("staticDh");
    expect(() => new HandshakeState({ pattern: "XX" as never, role: "initiator", prologue: EMPTY, staticPublic: corePub })).toThrow("unsupported");
  });

  test("a low-order ephemeral from the peer is refused", async () => {
    const b = mk("NK", "responder");
    const lowOrder = concat(new Uint8Array(32), new Uint8Array(16));
    await expect(b.readMessage(lowOrder)).rejects.toThrow(NoiseError);
  });

  test("the responder's static DH is injected: the module never needs the private key", async () => {
    let calls = 0;
    const b = new HandshakeState({ pattern: "NK", role: "responder", prologue: PROLOGUE, staticPublic: corePub, staticDh: (p) => { calls++; return x25519.getSharedSecret(RESP_SECRET, p); } });
    const a = mk("NK", "initiator");
    await b.readMessage(await a.writeMessage(EMPTY));
    expect(calls).toBe(1);
  });
});

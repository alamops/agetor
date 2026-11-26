// The headless phone against a minimal responder built only from this package's own primitives (Noise, framing, envelopes, strict
// parsers, signed decisions) through the local relay: no core involved. The core's own session tests (src/bun/remote/) then run the same
// client against the real gateway.
import { afterEach, describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { concat, fromHex, randomBytes, toHex } from "./bytes.ts";
import { PROLOGUE_PREFIX } from "./constants.ts";
import { verifySigned } from "./decision.ts";
import { coreId, mailboxId, mailboxKey, pairingMailboxKey, sasCode, utcDate } from "./derive.ts";
import { Reassembler, sealStream } from "./envelope.ts";
import { verifyEs256 } from "./es256.ts";
import { encodeMessage, parseMessage } from "./messages.ts";
import { CipherState, HandshakeState, prologue } from "./noise.ts";
import { encodeQr } from "./qr.ts";
import { decodeFrame, encodeFrame, type RelayFrame } from "./relay-frames.ts";
import { TestPhone } from "./test-client.ts";
import { startTestRelay, type TestRelay } from "./test-relay.ts";

let relay: TestRelay | null = null;
const closers: Array<() => void> = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
  relay?.stop();
  relay = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A relay peer playing the CORE: joins a mailbox as role core, frames in and out. */
class Responder {
  private ws!: WebSocket;
  private frames: RelayFrame[] = [];
  private waiters: Array<() => void> = [];
  tag: Uint8Array | null = null;
  mailbox: Uint8Array | null = null;
  send: CipherState | null = null;
  recv: CipherState | null = null;
  reassembler = new Reassembler();
  hash: Uint8Array | null = null;
  ended = false;
  readonly corePriv = x25519.utils.randomSecretKey();
  readonly corePub = x25519.getPublicKey(this.corePriv);

  async join(url: string, keys: Uint8Array[]): Promise<void> {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (e) => {
      this.frames.push(decodeFrame(new Uint8Array(e.data as ArrayBuffer)));
      this.waiters.splice(0).forEach((w) => w());
    };
    await new Promise<void>((r) => (this.ws.onopen = () => r()));
    this.ws.send(encodeFrame({ type: "hello", role: "core", keys }));
    closers.push(() => this.ws.close());
    await this.take((f) => f.type === "welcome");
  }

  private async take(pred: (f: RelayFrame) => boolean): Promise<RelayFrame> {
    const end = Date.now() + 8000;
    for (;;) {
      const i = this.frames.findIndex(pred);
      if (i >= 0) return this.frames.splice(i, 1)[0]!;
      if (Date.now() > end) throw new Error("responder timed out");
      await new Promise<void>((r) => {
        const t = setTimeout(r, 100);
        this.waiters.push(() => (clearTimeout(t), r()));
      });
    }
  }

  async nextCipher(): Promise<Uint8Array> {
    const f = (await this.take((x) => x.type === "deliver")) as Extract<RelayFrame, { type: "deliver" }>;
    this.ws.send(encodeFrame({ type: "ack", mailbox: f.mailbox, seq: f.seq }));
    this.tag = f.tag;
    this.mailbox = f.mailbox;
    return f.payload;
  }

  put(payload: Uint8Array): void {
    this.ws.send(encodeFrame({ type: "send", mailbox: this.mailbox!, tag: this.tag!, payload }));
  }

  /** Read until one whole message, or throw on any failure (a flipped bit, a replay...). */
  async read(): Promise<{ t: string; value: Record<string, unknown> }> {
    for (;;) {
      const pt = this.recv!.decrypt(new Uint8Array(0), await this.nextCipher());
      const m = this.reassembler.push(pt);
      if (m) return { t: m.t, value: parseMessage<Record<string, unknown>>(m.t, m.body) };
    }
  }

  /** Send a message; a multi-chunk one is paced (the relay holds 256 KB of frames the phone has not acknowledged, and answers `full` past it). */
  async say(type: string, body: Record<string, unknown>): Promise<void> {
    const id = String(body.id ?? "m");
    let first = true;
    for (const p of sealStream(type, id, encodeMessage(type as never, body))) {
      if (!first) await sleep(25);
      first = false;
      this.put(this.send!.encrypt(new Uint8Array(0), p));
    }
  }
}

async function nkResponder(r: Responder, pattern: "NK" | "NKpsk0", psk?: Uint8Array): Promise<void> {
  const hs = new HandshakeState({ pattern, role: "responder", prologue: prologue(PROLOGUE_PREFIX, coreId(r.corePub)), psk, staticPublic: r.corePub, staticDh: (p) => x25519.getSharedSecret(r.corePriv, p) });
  await hs.readMessage(await r.nextCipher());
  r.put(await hs.writeMessage(new Uint8Array(0)));
  const c = hs.split();
  r.send = c.send;
  r.recv = c.recv;
  r.hash = hs.handshakeHash();
}

describe("pairing", () => {
  test("pairs through the pairing mailbox: the SAS matches on both sides, both signatures verify, and the phone learns its id and link secret", async () => {
    relay = startTestRelay();
    const core = new Responder();
    const pairingSecret = randomBytes(32);
    const pkey = pairingMailboxKey(pairingSecret);
    await core.join(relay.url, [pkey]);
    const qr = encodeQr({ fmt: 1, corePub: toHex(core.corePub), relayUrl: relay.url, mailbox: toHex(mailboxId(pkey)), pairingSecret: toHex(pairingSecret), expiresAt: Date.now() + 120_000 });

    const phone = new TestPhone({ relayUrl: relay.url });
    const handle = phone.pair({ qr, name: "Ana's iPhone", platform: "ios", appVersion: "1.2.3" });
    await nkResponder(core, "NKpsk0", pairingSecret);
    const sas = await handle.sas;
    expect(sas).toBe(sasCode(core.hash!));
    expect(sas).toMatch(/^\d{6}$/);

    const req = await core.read();
    expect(req.t).toBe("pairing-request");
    expect(req.value).toMatchObject({ name: "Ana's iPhone", platform: "ios", appVersion: "1.2.3" });
    expect(verifyEs256(fromHex(req.value.sessionPub as string), core.hash!, fromHex(req.value.sessionSig as string))).toBe(true);
    expect(verifyEs256(fromHex(req.value.approvePub as string), core.hash!, fromHex(req.value.approveSig as string))).toBe(true);
    expect(req.value.sessionPub).toBe(toHex(phone.sessionPub));
    expect(req.value.pushPub).toBe(toHex(phone.pushPub));

    const linkSecret = randomBytes(32);
    const deviceId = toHex(randomBytes(16));
    await core.say("pairing-result", { deviceId, linkSecret: toHex(linkSecret), level: "operate" });
    const result = await handle.result;
    expect(result).toMatchObject({ deviceId, level: "operate" });
    expect(toHex(result.linkSecret)).toBe(toHex(linkSecret));
    expect(toHex(result.corePub)).toBe(toHex(core.corePub));
  });

  test("a wrong pairing secret fails the handshake and never produces a result", async () => {
    relay = startTestRelay();
    const core = new Responder();
    const pairingSecret = randomBytes(32);
    const pkey = pairingMailboxKey(pairingSecret);
    await core.join(relay.url, [pkey]);
    const qr = encodeQr({ fmt: 1, corePub: toHex(core.corePub), relayUrl: relay.url, mailbox: toHex(mailboxId(pkey)), pairingSecret: toHex(pairingSecret), expiresAt: Date.now() + 120_000 });
    const phone = new TestPhone({ relayUrl: relay.url, timeoutMs: 1500 });
    const handle = phone.pair({ qr, name: "x" });
    await expect(nkResponder(core, "NKpsk0", randomBytes(32))).rejects.toThrow();
    await expect(handle.sas).rejects.toThrow();
    await expect(handle.result).rejects.toThrow();
  });
});

describe("sessions", () => {
  async function sessionRig() {
    relay = startTestRelay();
    const core = new Responder();
    const linkSecret = randomBytes(32);
    const deviceId = toHex(randomBytes(16));
    const t = Date.now();
    const keys = [mailboxKey(linkSecret, utcDate(t)), mailboxKey(linkSecret, utcDate(t - 86_400_000))];
    await core.join(relay.url, keys);
    const phone = new TestPhone({ relayUrl: relay.url, timeoutMs: 3000 });
    closers.push(() => phone.close());
    const connecting = phone.connect({ corePub: core.corePub, deviceId, linkSecret });
    await nkResponder(core, "NK");
    const binding = await core.read();
    expect(binding.t).toBe("binding");
    expect(binding.value.deviceId).toBe(deviceId);
    expect(verifyEs256(phone.sessionPub, core.hash!, fromHex(binding.value.sig as string))).toBe(true);
    await core.say("hello", {
      protocolVersion: 1, minProtocolVersion: 1, deviceId, level: "respond", routes: [], auditHead: null, clock: Date.now(), macName: "Test Mac",
    });
    const hello = await connecting;
    return { core, phone, deviceId, hello };
  }

  test("connect does the NK handshake, the channel binding and returns the core's hello", async () => {
    const { phone, hello, deviceId } = await sessionRig();
    expect(hello).toMatchObject({ deviceId, level: "respond", macName: "Test Mac" });
    expect(phone.level).toBe("respond");
    expect(phone.handshakeHash).not.toBeNull();
  });

  test("a request goes out with an idem key and the response comes back, in both encodings", async () => {
    const { core, phone } = await sessionRig();
    const p = phone.request("POST", "/runs/r1/input", { text: "continue" });
    const req = await core.read();
    expect(req.t).toBe("request");
    expect(req.value).toMatchObject({ method: "POST", path: "/runs/r1/input", body: { text: "continue" }, decision: null });
    expect(req.value.idem).toMatch(/^[0-9a-f]{32}$/);
    await core.say("response", { id: req.value.id as string, status: 200, contentType: "application/json", encoding: "utf8", body: '{"ok":true}' });
    const res = await p;
    expect(res.status).toBe(200);
    expect(res.json<{ ok: boolean }>()).toEqual({ ok: true });

    const g = phone.request("GET", "/tasks/t1/files/preview", null, { query: "path=%2Ftmp%2Fa.png" });
    const greq = await core.read();
    expect(greq.value.idem).toBeNull();
    expect(greq.value.query).toBe("path=%2Ftmp%2Fa.png");
    await core.say("response", { id: greq.value.id as string, status: 200, contentType: "image/png", encoding: "base64", body: btoa("\x89PNG") });
    expect((await g).bytes().length).toBe(4);
  });

  test("a GET carries no idem key, and `idem: null` on a POST sends none, to test the refusal", async () => {
    const { core, phone } = await sessionRig();
    void phone.request("POST", "/x", {}, { idem: null }).catch(() => undefined);
    expect((await core.read()).value.idem).toBeNull();
  });

  test("a large response is chunked by the core and reassembled by the phone", async () => {
    const { core, phone } = await sessionRig();
    const p = phone.request("GET", "/tasks/t1/events/9");
    const req = await core.read();
    const big = "x".repeat(300_000);
    await core.say("response", { id: req.value.id as string, status: 200, contentType: "text/plain", encoding: "utf8", body: big });
    expect((await p).text().length).toBe(300_000);
  });

  test("subscriptions: task events and a global event arrive and are logged", async () => {
    const { core, phone } = await sessionRig();
    const sub = await phone.subscribeTask("t1", { afterId: 5 });
    const msg = await core.read();
    expect(msg).toMatchObject({ t: "subscribe-task", value: { sub, taskId: "t1", afterId: 5, maxBytes: null } });
    await core.say("task-meta", { sub, taskId: "t1", meta: { earliestId: null, hasMore: false, resumedAfter: 5 } });
    await core.say("task-event", { sub, event: { id: 6, runId: "r", taskId: "t1", stream: "assistant", data: "hi", ts: 1, subagentId: null } });
    expect((await phone.next<{ sub: string }>("task-event")).sub).toBe(sub);
    expect(phone.received("task-meta")).toHaveLength(1);
  });

  test("a challenge, a signed decision the verifier accepts, and an unlock", async () => {
    const { core, phone, deviceId } = await sessionRig();
    const asking = phone.challenge({ kind: "plan", taskId: "t1", planId: "p1" });
    const c = await core.read();
    expect(c.t).toBe("challenge");
    const content = new TextEncoder().encode('{"markdown":"# plan"}');
    const hash = "sha256:" + toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", content)));
    await core.say("challenge-issued", { id: c.value.id as string, challenge: "ab".repeat(16), contentBytes: btoa(String.fromCharCode(...content)), contentHash: hash, expiresAt: Date.now() + 120_000 });
    const issued = await asking;
    expect(issued.contentHash).toBe(hash);
    const signed = phone.decide(issued, { route: "POST /tasks/t1/plans/p1/approve", target: { kind: "plan", taskId: "t1", planId: "p1" }, decision: "approve" });
    expect(signed.payload).toMatchObject({ deviceId, contentHash: hash, sessionHash: toHex(core.hash!), challenge: "ab".repeat(16) });
    expect(verifySigned("decision", signed.payload, signed.sig, phone.approvePub)).toBe(true);

    const unlocking = phone.unlock(60_000);
    const u = await core.read();
    expect(u.t).toBe("unlock");
    expect(verifySigned("unlock", u.value.payload, u.value.sig as string, phone.approvePub)).toBe(true);
    await core.say("unlock-ok", { id: u.value.id as string, expiresAt: (u.value.payload as { expiresAt: number }).expiresAt });
    expect(await unlocking).toBeGreaterThan(Date.now());
  });

  test("the terminal helpers send their messages; output is collected", async () => {
    const { core, phone } = await sessionRig();
    const attaching = phone.terminal.attach("t1", "agetor-0123456789ab");
    const c = await core.read();
    expect(c.t).toBe("challenge");
    expect(c.value.target).toEqual({ kind: "terminal", taskId: "t1", tmuxSession: "agetor-0123456789ab" });
    const content = new TextEncoder().encode('{"ok":true}');
    const hash = "sha256:" + toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", content)));
    await core.say("challenge-issued", { id: c.value.id as string, challenge: "cd".repeat(16), contentBytes: btoa(String.fromCharCode(...content)), contentHash: hash, expiresAt: Date.now() + 120_000 });
    const attach = await core.read();
    expect(attach).toMatchObject({ t: "terminal-attach", value: { taskId: "t1", cols: 80, rows: 24 } });
    await attaching;
    await phone.terminal.input("t1", "ls\n");
    expect((await core.read()).value).toMatchObject({ taskId: "t1" });
    await core.say("terminal-output", { taskId: "t1", data: btoa("hello\n") });
    await phone.next("terminal-output");
    expect(phone.terminal.output("t1")).toBe("hello\n");
  });

  test("the relay only ever carried ciphertext: no plaintext marker appears in what the phone sent", async () => {
    const { core, phone } = await sessionRig();
    void phone.request("POST", "/runs/r1/input", { text: "TOP-SECRET-MARKER-TEXT" }).catch(() => undefined);
    await core.read();
    const wire = Buffer.concat(phone.sentOnWire.map((b) => Buffer.from(b))).toString("latin1");
    expect(wire).not.toContain("TOP-SECRET-MARKER-TEXT");
    expect(wire).not.toContain("request");
  });
});

describe("tamper hooks: each ends the session at the core", () => {
  async function ended(setup: (phone: TestPhone) => void): Promise<boolean> {
    relay = startTestRelay();
    const core = new Responder();
    const linkSecret = randomBytes(32);
    const deviceId = toHex(randomBytes(16));
    const t = Date.now();
    await core.join(relay.url, [mailboxKey(linkSecret, utcDate(t)), mailboxKey(linkSecret, utcDate(t - 86_400_000))]);
    const phone = new TestPhone({ relayUrl: relay.url, timeoutMs: 3000 });
    closers.push(() => phone.close());
    const connecting = phone.connect({ corePub: core.corePub, deviceId, linkSecret });
    await nkResponder(core, "NK");
    await core.read();
    await core.say("hello", { protocolVersion: 1, minProtocolVersion: 1, deviceId, level: "respond", routes: [], auditHead: null, clock: 1, macName: "m" });
    await connecting;
    setup(phone);
    void phone.sendMessage("unsubscribe", { sub: "one" }).catch(() => undefined);
    void phone.sendMessage("unsubscribe", { sub: "two" }).catch(() => undefined);
    const results: string[] = [];
    try {
      results.push((await core.read()).value.sub as string);
      results.push((await core.read()).value.sub as string);
      return false; // both arrived intact: nothing ended
    } catch {
      await sleep(10);
      return true;
    } finally {
      void results;
    }
  }

  test("no tamper: both messages arrive", async () => {
    expect(await ended(() => undefined)).toBe(false);
  });
  test("a flipped bit fails decryption", async () => {
    expect(await ended((p) => (p.tamper = { flipBit: true }))).toBe(true);
  });
  test("a replayed frame fails (the nonce moved on)", async () => {
    // The first send goes normally; the replay hook then sends the previous frame instead of the second message.
    expect(await ended((p) => { p.tamper = { replay: true }; })).toBe(true);
  });
  test("reordered frames fail", async () => {
    expect(await ended((p) => (p.tamper = { reorder: true }))).toBe(true);
  });
  test("an oversize frame is refused by the relay's limit and no message arrives", async () => {
    expect(await ended((p) => (p.tamper = { oversize: true }))).toBe(true);
  });
});

void concat;

/**
 * A headless phone (docs/specs/remote-readiness-spec.md "Tests, CI and review", plan P6): it pairs through a relay, opens sessions, and
 * drives the blocked-agent loop, speaking exactly what a real phone speaks, built only from this package's primitives (Noise, framing,
 * envelopes, strict parsers, signed decisions). The core's security suite, the e2e specs and the relay conformance tests use it; the
 * production code never imports it.
 *
 *   const phone = new TestPhone({ relayUrl });
 *   const paired = phone.pair({ qr, name: "Ana's iPhone" });       // paired.sas resolves with the code to type on the Mac
 *   const { deviceId, linkSecret } = await paired.result;
 *   await phone.connect({ corePub, deviceId, linkSecret });        // NK handshake, channel binding, hello
 *   await phone.request("GET", "/tasks", null, { query: "delta=1" });
 *
 * Tamper hooks (`phone.tamper`) corrupt the NEXT frame it sends: flip a bit, replay the previous one, swap two, or send one over the limit,
 * so the security suite can show each ends the session.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { concat, fromHex, fromUtf8, randomBytes, toBase64, toHex, utf8 } from "./bytes.ts";
import { canonicalBytes } from "./canonical-json.ts";
import { PROLOGUE_PREFIX, SESSION_TAG_BYTES } from "./constants.ts";
import { contentHashOf, decisionBytes, terminalAttachBytes, unlockBytes, type DecisionPayload, type TerminalAttachPayload } from "./decision.ts";
import { coreId, mailboxId, mailboxKey, pairingMailboxKey, sasCode, utcDate } from "./derive.ts";
import { Reassembler, seal } from "./envelope.ts";
import { signEs256 } from "./es256.ts";
import type { RemoteLevel } from "./levels.ts";
import { encodeMessage, parseMessage } from "./messages.ts";
import { CipherState, HandshakeState, prologue } from "./noise.ts";
import { decodeQr, type QrPayload } from "./qr.ts";
import { decodeFrame, encodeFrame, type RelayFrame } from "./relay-frames.ts";

export interface TestPhoneOptions {
  relayUrl: string;
  WebSocketImpl?: typeof WebSocket;
  /** Fixed keys for a reproducible phone; otherwise random ones. */
  keys?: { sessionSecret?: Uint8Array; approveSecret?: Uint8Array; pushSecret?: Uint8Array };
  now?: () => number;
  /** How long to wait for any one reply. */
  timeoutMs?: number;
}

export interface PairingResult {
  deviceId: string;
  linkSecret: Uint8Array;
  level: RemoteLevel;
  corePub: Uint8Array;
}

export interface PairHandle {
  /** The six-digit code the phone shows (resolves once the handshake is done, before the Mac's window completes). */
  sas: Promise<string>;
  result: Promise<PairingResult>;
}

export interface SignedDecisionWire {
  payload: DecisionPayload;
  sig: string;
}

export interface ChallengeIssued {
  id: string;
  challenge: string;
  contentBytes: Uint8Array;
  contentHash: string;
  expiresAt: number;
}

export interface Response {
  id: string;
  status: number;
  contentType: string;
  /** The body decoded as text (utf8) or bytes (base64). */
  text(): string;
  json<T = unknown>(): T;
  bytes(): Uint8Array;
}

export interface Tamper {
  /** Corrupt one bit of the next ciphertext. */
  flipBit?: boolean;
  /** Send the previous frame again instead of the next. */
  replay?: boolean;
  /** Hold the next frame and send it after the one after. */
  reorder?: boolean;
  /** Send a payload larger than a Noise message. */
  oversize?: boolean;
}

interface Collected {
  type: string;
  value: Record<string, unknown>;
}

export class TestPhone {
  readonly sessionSecret: Uint8Array;
  readonly approveSecret: Uint8Array;
  readonly pushSecret: Uint8Array;
  readonly sessionPub: Uint8Array;
  readonly approvePub: Uint8Array;
  readonly pushPub: Uint8Array;
  tamper: Tamper = {};

  deviceId: string | null = null;
  linkSecret: Uint8Array | null = null;
  corePub: Uint8Array | null = null;
  level: RemoteLevel | null = null;
  hello: Record<string, unknown> | null = null;
  /** The Noise handshake hash of the current session (what decisions and the channel binding are bound to). */
  handshakeHash: Uint8Array | null = null;

  private readonly WS: typeof WebSocket;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private ws: WebSocket | null = null;
  private frames: RelayFrame[] = [];
  private frameWaiters: Array<() => void> = [];
  private closedInfo: { code: number; reason: string } | null = null;
  private tag: Uint8Array = new Uint8Array(SESSION_TAG_BYTES);
  private mailbox: Uint8Array | null = null;
  private send: CipherState | null = null;
  private recv: CipherState | null = null;
  private reassembler = new Reassembler();
  private inbox: Collected[] = [];
  private inboxWaiters: Array<() => void> = [];
  private nextId = 1;
  private lastSent: Uint8Array | null = null;
  private held: Uint8Array | null = null;
  private sessionEnded = false;
  /** Messages received per type, for assertions (`phone.received("task-event")`). */
  readonly log: Collected[] = [];
  /** Every ciphertext frame the phone put on the relay, for the "relay sees only ciphertext" assertion. */
  readonly sentOnWire: Uint8Array[] = [];

  constructor(private readonly opts: TestPhoneOptions) {
    this.WS = opts.WebSocketImpl ?? WebSocket;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.sessionSecret = opts.keys?.sessionSecret ?? p256.utils.randomSecretKey();
    this.approveSecret = opts.keys?.approveSecret ?? p256.utils.randomSecretKey();
    this.pushSecret = opts.keys?.pushSecret ?? x25519.utils.randomSecretKey();
    this.sessionPub = p256.getPublicKey(this.sessionSecret, false);
    this.approvePub = p256.getPublicKey(this.approveSecret, false);
    this.pushPub = x25519.getPublicKey(this.pushSecret);
  }

  // ── relay socket ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Bumped by every `open`: a reader from an earlier connection (a pump of an earlier session) must not consume the new one's frames. */
  private generation = 0;

  private async open(keys: Uint8Array[]): Promise<Uint8Array[]> {
    this.generation++;
    this.wake(this.frameWaiters);
    this.frames = [];
    this.closedInfo = null;
    this.sessionEnded = false;
    const ws = new this.WS(this.opts.relayUrl);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = (e) => {
      try {
        this.frames.push(decodeFrame(new Uint8Array(e.data as ArrayBuffer)));
      } catch {
        return;
      }
      this.wake(this.frameWaiters);
    };
    ws.onclose = (e) => {
      this.closedInfo = { code: e.code, reason: e.reason };
      this.sessionEnded = true;
      this.wake(this.frameWaiters);
      this.wake(this.inboxWaiters);
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      const prevClose = ws.onclose;
      ws.onerror = () => reject(new Error("relay socket error"));
      void prevClose;
    });
    ws.send(encodeFrame({ type: "hello", role: "device", keys }));
    const welcome = await this.nextFrame((f) => f.type === "welcome");
    return (welcome as Extract<RelayFrame, { type: "welcome" }>).ids;
  }

  private wake(list: Array<() => void>): void {
    for (const w of list.splice(0)) w();
  }

  private async nextFrame(pred: (f: RelayFrame) => boolean, generation = this.generation, waitMs = this.timeoutMs): Promise<RelayFrame> {
    const deadline = this.now() + waitMs;
    for (;;) {
      if (generation !== this.generation) throw new Error("a newer connection replaced this one");
      const i = this.frames.findIndex(pred);
      if (i >= 0) return this.frames.splice(i, 1)[0]!;
      if (this.closedInfo) throw new Error(`relay closed (${this.closedInfo.code} ${this.closedInfo.reason})`);
      const left = deadline - this.now();
      if (left <= 0) throw new Error("timed out waiting for a relay frame");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 200));
        this.frameWaiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /** The next deliver frame of this session (tag matches); stale tags are acknowledged and skipped. */
  /** `waitMs`: how long to wait for a frame. A session's reader waits as long as the connection lives; a handshake step waits `timeoutMs`. */
  private async nextCiphertext(generation = this.generation, waitMs = this.timeoutMs): Promise<Uint8Array> {
    for (;;) {
      const f = (await this.nextFrame((x) => x.type === "deliver", generation, waitMs)) as Extract<RelayFrame, { type: "deliver" }>;
      this.ws?.send(encodeFrame({ type: "ack", mailbox: f.mailbox, seq: f.seq }));
      if (toHex(f.tag) !== toHex(this.tag)) continue;
      this.mailbox = f.mailbox;
      return f.payload;
    }
  }

  private put(payload: Uint8Array): void {
    if (!this.ws || !this.mailbox) throw new Error("no open session");
    let frame = payload;
    const t = this.tamper;
    if (t.flipBit) {
      frame = payload.slice();
      frame[Math.floor(frame.length / 2)] = (frame[Math.floor(frame.length / 2)] as number) ^ 1;
      this.tamper = { ...t, flipBit: false };
    } else if (t.oversize) {
      frame = new Uint8Array(65_536 + 1000).fill(7);
      this.tamper = { ...t, oversize: false };
    } else if (t.replay && this.lastSent) {
      frame = this.lastSent;
      this.tamper = { ...t, replay: false };
    } else if (t.reorder) {
      if (!this.held) {
        this.held = payload;
        return;
      }
      const first = this.held;
      this.held = null;
      this.tamper = { ...t, reorder: false };
      this.rawSend(payload);
      this.rawSend(first);
      return;
    }
    this.lastSent = payload;
    this.rawSend(frame);
  }

  private rawSend(payload: Uint8Array): void {
    this.sentOnWire.push(payload);
    this.ws!.send(encodeFrame({ type: "send", mailbox: this.mailbox!, tag: this.tag, payload: payload.length > 65_535 && payload.length < 70_000 ? payload : payload }));
  }

  // ── session transport ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** Send one app message through the session: envelope, pad, encrypt, relay. */
  async sendMessage(type: string, body: Record<string, unknown>): Promise<string> {
    if (!this.send) throw new Error("no open session");
    const id = String(body.id ?? `m${this.nextId++}`);
    const bytes = type === "rekey" ? canonicalBytes(body) : encodeMessage(type as never, body);
    for (const plaintext of seal(type, id, bytes)) this.put(this.send.encrypt(new Uint8Array(0), plaintext));
    return id;
  }

  /** Same as `sendMessage` but without validating against the strict parsers: for the security suite's malformed messages. */
  async sendRaw(type: string, body: unknown): Promise<void> {
    if (!this.send) throw new Error("no open session");
    for (const plaintext of seal(type, `m${this.nextId++}`, canonicalBytes(body))) this.put(this.send.encrypt(new Uint8Array(0), plaintext));
  }

  /** Read deliver frames until one whole app message is reassembled (or the wait ends). Messages go to the inbox. */
  private async pump(): Promise<void> {
    const generation = this.generation;
    for (;;) {
      if (this.sessionEnded || generation !== this.generation) return;
      let ct: Uint8Array;
      try {
        ct = await this.nextCiphertext(generation, Number.POSITIVE_INFINITY);
      } catch {
        if (generation !== this.generation) return; // replaced by a newer connection: not this session's end
        this.sessionEnded = true;
        this.wake(this.inboxWaiters);
        return;
      }
      try {
        const plaintext = this.recv!.decrypt(new Uint8Array(0), ct);
        const msg = this.reassembler.push(plaintext);
        if (!msg) continue;
        if (msg.t === "rekey") {
          this.recv!.rekey();
          this.rekeysReceived++;
          continue;
        }
        const value = parseMessage<Record<string, unknown>>(msg.t, msg.body);
        const item = { type: msg.t, value };
        this.inbox.push(item);
        this.log.push(item);
        this.wake(this.inboxWaiters);
      } catch {
        this.sessionEnded = true;
        this.wake(this.inboxWaiters);
        return;
      }
    }
  }

  /** Wait for a message of `type` (matching `pred`). Throws when the session ended first or the wait ran out. */
  async next<T = Record<string, unknown>>(type: string, pred: (v: T) => boolean = () => true, timeoutMs = this.timeoutMs): Promise<T> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const i = this.inbox.findIndex((m) => m.type === type && pred(m.value as T));
      if (i >= 0) return this.inbox.splice(i, 1)[0]!.value as T;
      if (this.sessionEnded) throw new Error(`session ended while waiting for ${type}`);
      const left = deadline - this.now();
      if (left <= 0) throw new Error(`timed out waiting for ${type}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 100));
        this.inboxWaiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /** Every message of a type received so far (and not yet consumed by `next`). */
  /** How many in-band rekeys the core has sent this phone (each one rekeyed the receiving side). */
  rekeysReceived = 0;

  received(type: string): Array<Record<string, unknown>> {
    return this.log.filter((m) => m.type === type).map((m) => m.value);
  }

  /** True once the session ended (the core closed it, a frame failed, or the relay dropped). */
  get ended(): boolean {
    return this.sessionEnded;
  }

  async waitEnded(timeoutMs = this.timeoutMs): Promise<boolean> {
    const deadline = this.now() + timeoutMs;
    while (!this.sessionEnded) {
      if (this.now() > deadline) return false;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 50);
        this.inboxWaiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    return true;
  }

  // ── pairing ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Pair through the pairing mailbox the QR names. NKpsk0 with the pairing secret as the PSK; then, over the transport, the
   * `pairing-request` carrying the keys and BOTH signatures over the final handshake hash (a signature can only cover a hash that
   * exists, so it travels in the first transport message). `sas` is what the phone would show; `result` resolves when the Mac's window
   * finished (code typed, level chosen, Touch ID) and the core sent `pairing-result`.
   */
  pair(opts: { qr: string; name: string; platform?: "ios" | "android"; appVersion?: string; /** Sign one of the two proofs with a key that is not the enrolled one (a refusal test). */ badSignature?: "session" | "approve" }): PairHandle {
    const qr: QrPayload = decodeQr(opts.qr);
    const corePub = fromHex(qr.corePub);
    let resolveSas!: (s: string) => void;
    let rejectSas!: (e: unknown) => void;
    const sas = new Promise<string>((res, rej) => {
      resolveSas = res;
      rejectSas = rej;
    });
    const result = (async (): Promise<PairingResult> => {
      try {
        const pairingSecret = fromHex(qr.pairingSecret);
        const key = pairingMailboxKey(pairingSecret);
        await this.open([key]);
        this.tag = randomBytes(SESSION_TAG_BYTES);
        this.mailbox = mailboxId(key);
        const hs = new HandshakeState({ pattern: "NKpsk0", role: "initiator", prologue: prologue(PROLOGUE_PREFIX, coreId(corePub)), psk: pairingSecret, staticPublic: corePub });
        this.rawSend(await hs.writeMessage(new Uint8Array(0)));
        await hs.readMessage(await this.nextCiphertext());
        const ciphers = hs.split();
        this.send = ciphers.send;
        this.recv = ciphers.recv;
        this.handshakeHash = hs.handshakeHash();
        this.corePub = corePub;
        resolveSas(sasCode(this.handshakeHash));
        void this.pump();
        const hash = this.handshakeHash;
        await this.sendMessage("pairing-request", {
          name: opts.name,
          platform: opts.platform ?? "ios",
          appVersion: opts.appVersion ?? "1.0.0",
          sessionPub: toHex(this.sessionPub),
          approvePub: toHex(this.approvePub),
          pushPub: toHex(this.pushPub),
          sessionSig: toHex(signEs256(opts.badSignature === "session" ? p256.utils.randomSecretKey() : this.sessionSecret, hash)),
          approveSig: toHex(signEs256(opts.badSignature === "approve" ? p256.utils.randomSecretKey() : this.approveSecret, hash)),
        });
        // The core answers a refused pairing with an `error` message (and closes its mailbox): that ends the wait.
        const won = this.next<{ deviceId: string; linkSecret: string; level: RemoteLevel }>("pairing-result", () => true, 180_000);
        const lost = this.next<{ code: string }>("error", () => true, 180_000).then((e) => {
          throw new Error(`pairing refused: ${e.code}`);
        });
        won.catch(() => undefined);
        lost.catch(() => undefined);
        const r = await Promise.race([won, lost]);
        this.deviceId = r.deviceId;
        this.linkSecret = fromHex(r.linkSecret);
        this.level = r.level;
        return { deviceId: r.deviceId, linkSecret: this.linkSecret, level: r.level, corePub };
      } catch (e) {
        rejectSas(e);
        throw e;
      }
    })();
    result.catch(() => undefined);
    sas.catch(() => undefined);
    return { sas, result };
  }

  // ── sessions ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * A fresh session: NK handshake with the core's pinned key, the channel-binding message (the device id and an ES256 signature by
   * the session key over the handshake hash), then the core's `hello`.
   */
  async connect(opts: { corePub: Uint8Array; deviceId: string; linkSecret: Uint8Array; prologuePrefix?: string; bindingSecret?: Uint8Array }): Promise<Record<string, unknown>> {
    this.close();
    this.corePub = opts.corePub;
    this.deviceId = opts.deviceId;
    this.linkSecret = opts.linkSecret;
    const t = this.now();
    const keys = [mailboxKey(opts.linkSecret, utcDate(t)), mailboxKey(opts.linkSecret, utcDate(t - 86_400_000))];
    await this.open(keys);
    this.tag = randomBytes(SESSION_TAG_BYTES);
    this.mailbox = mailboxId(keys[0]!);
    const hs = new HandshakeState({ pattern: "NK", role: "initiator", prologue: prologue(opts.prologuePrefix ?? PROLOGUE_PREFIX, coreId(opts.corePub)), staticPublic: opts.corePub });
    this.rawSend(await hs.writeMessage(new Uint8Array(0)));
    await hs.readMessage(await this.nextCiphertext());
    const ciphers = hs.split();
    this.send = ciphers.send;
    this.recv = ciphers.recv;
    this.handshakeHash = hs.handshakeHash();
    this.reassembler = new Reassembler();
    this.inbox = [];
    void this.pump();
    await this.sendMessage("binding", { deviceId: opts.deviceId, sig: toHex(signEs256(opts.bindingSecret ?? this.sessionSecret, this.handshakeHash)) });
    const hello = await this.next<Record<string, unknown>>("hello");
    this.hello = hello;
    this.level = hello.level as RemoteLevel;
    return hello;
  }

  close(): void {
    this.sessionEnded = true;
    try {
      this.ws?.close(1000, "bye");
    } catch {
      /* already closed */
    }
    this.ws = null;
  }

  /** Rekey this phone's sending side (and tell the core, which rekeys its receiving side). */
  async rekey(): Promise<void> {
    if (!this.send) throw new Error("no open session");
    await this.sendRaw("rekey", {});
    this.send.rekey();
  }

  // ── the loop ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  newIdemKey(): string {
    return toHex(randomBytes(16));
  }

  /** A request through the router. Non-GET calls get an `idem` key unless one is given (`idem: null` sends none, to test the refusal). */
  async request(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body: unknown = null,
    opts: { query?: string | null; idem?: string | null; decision?: SignedDecisionWire | null; timeoutMs?: number } = {},
  ): Promise<Response> {
    const id = `q${this.nextId++}`;
    const idem = opts.idem === undefined ? (method === "GET" ? null : this.newIdemKey()) : opts.idem;
    await this.sendMessage("request", { id, method, path, query: opts.query ?? null, body, idem, decision: opts.decision ?? null });
    const r = await this.next<{ id: string; status: number; contentType: string; encoding: "utf8" | "base64"; body: string }>("response", (v) => v.id === id, opts.timeoutMs);
    const bytes = () => (r.encoding === "base64" ? fromBase64Lenient(r.body) : utf8(r.body));
    return { id, status: r.status, contentType: r.contentType, text: () => (r.encoding === "utf8" ? r.body : fromUtf8(bytes())), json: <T>() => JSON.parse(r.encoding === "utf8" ? r.body : fromUtf8(bytes())) as T, bytes };
  }

  /** The reply of type `type` to message `id`, or a thrown Error naming the code of the `error` the core sent for it instead. */
  private async reply<T extends { id: string }>(type: string, id: string): Promise<T> {
    const ok = this.next<T>(type, (v) => v.id === id);
    const bad = this.next<{ id: string | null; code: string }>("error", (v) => v.id === id).then((e) => {
      throw new Error(`core refused: ${e.code}`);
    });
    ok.catch(() => undefined);
    bad.catch(() => undefined);
    return await Promise.race([ok, bad]);
  }

  /** Ask for a challenge for a target and return what the core says to show. */
  async challenge(target: Record<string, unknown>): Promise<ChallengeIssued> {
    const id = `c${this.nextId++}`;
    await this.sendMessage("challenge", { id, target });
    const r = await this.reply<{ id: string; challenge: string; contentBytes: string; contentHash: string; expiresAt: number }>("challenge-issued", id);
    return { id, challenge: r.challenge, contentBytes: fromBase64Lenient(r.contentBytes), contentHash: r.contentHash, expiresAt: r.expiresAt };
  }

  /**
   * Sign a decision over what the core showed: recompute the hash from the bytes (what a real phone does), build the exact payload and sign
   * it with the approve key. `override` lets the security suite sign something else (a stale hash, another session, a wrong decision).
   */
  decide(issued: ChallengeIssued, args: { route: string; target: Record<string, unknown>; decision: DecisionPayload["decision"]; comment?: string | null; override?: Partial<DecisionPayload>; signWith?: Uint8Array }): SignedDecisionWire {
    if (!this.handshakeHash || !this.deviceId) throw new Error("no open session");
    const payload = {
      v: 1, kind: "decision", deviceId: this.deviceId, sessionHash: toHex(this.handshakeHash), challenge: issued.challenge, route: args.route,
      target: args.target, contentHash: contentHashOf(issued.contentBytes), decision: args.decision, comment: args.comment ?? null, ts: this.now(), ...args.override,
    } as DecisionPayload;
    return { payload, sig: toHex(signEs256(args.signWith ?? this.approveSecret, decisionBytes(payload))) };
  }

  /** Open the unlock window for `ttlMs` (at most 10 minutes) with one approve-key signature. */
  async unlock(ttlMs = 5 * 60_000, override: { expiresAt?: number; sessionHash?: string } = {}): Promise<number> {
    if (!this.handshakeHash) throw new Error("no open session");
    const payload = { kind: "unlock" as const, sessionHash: override.sessionHash ?? toHex(this.handshakeHash), expiresAt: override.expiresAt ?? this.now() + ttlMs };
    const id = `u${this.nextId++}`;
    await this.sendMessage("unlock", { id, payload, sig: toHex(signEs256(this.approveSecret, unlockBytes(payload))) });
    return (await this.reply<{ id: string; expiresAt: number }>("unlock-ok", id)).expiresAt;
  }

  async subscribeTask(taskId: string, opts: { afterId?: number | null; maxBytes?: number | null; sub?: string } = {}): Promise<string> {
    const sub = opts.sub ?? `s${this.nextId++}`;
    await this.sendMessage("subscribe-task", { sub, taskId, afterId: opts.afterId ?? null, maxBytes: opts.maxBytes ?? null });
    return sub;
  }

  async subscribeGlobal(sub = `g${this.nextId++}`): Promise<string> {
    await this.sendMessage("subscribe-global", { sub });
    return sub;
  }

  async unsubscribe(sub: string): Promise<void> {
    await this.sendMessage("unsubscribe", { sub });
  }

  async registerPush(pushRef: string, sendKey: Uint8Array): Promise<void> {
    const id = `p${this.nextId++}`;
    await this.sendMessage("push-register", { id, pushRef, sendKey: toHex(sendKey) });
    await this.reply("ok", id);
  }

  async revokeSelf(): Promise<void> {
    const id = `x${this.nextId++}`;
    await this.sendMessage("revoke-self", { id });
    await this.next("ok", (v: { id: string }) => v.id === id).catch(() => undefined);
  }

  readonly terminal = {
    attach: async (taskId: string, tmuxSession: string, size = { cols: 80, rows: 24 }, override: { signWith?: Uint8Array } = {}): Promise<void> => {
      const issued = await this.challenge({ kind: "terminal", taskId, tmuxSession });
      const payload: TerminalAttachPayload = {
        v: 1, kind: "terminal-attach", deviceId: this.deviceId!, sessionHash: toHex(this.handshakeHash!), challenge: issued.challenge,
        taskId, tmuxSession, contentHash: contentHashOf(issued.contentBytes), ts: this.now(),
      };
      const id = `a${this.nextId++}`;
      await this.sendMessage("terminal-attach", { id, taskId, cols: size.cols, rows: size.rows, payload, sig: toHex(signEs256(override.signWith ?? this.approveSecret, terminalAttachBytes(payload))) });
    },
    input: (taskId: string, data: string | Uint8Array) => this.sendMessage("terminal-input", { taskId, data: toBase64(typeof data === "string" ? utf8(data) : data) }),
    resize: (taskId: string, cols: number, rows: number) => this.sendMessage("terminal-resize", { taskId, cols, rows }),
    detach: (taskId: string) => this.sendMessage("terminal-detach", { taskId }),
    /** The text of every `terminal-output` received for a task so far. */
    output: (taskId: string): string =>
      this.log.filter((m) => m.type === "terminal-output" && m.value.taskId === taskId).map((m) => fromUtf8(fromBase64Lenient(String(m.value.data)))).join(""),
  };
}

function fromBase64Lenient(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export { concat };

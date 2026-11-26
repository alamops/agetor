/**
 * The session manager (docs/specs/remote-readiness-spec.md "Sessions and the relay link", plan SS). One Noise session per device, over the
 * device's mailbox on the relay link.
 *
 * Lifecycle: the phone's first frame (a tag the core has not seen) is an NK handshake message; the core answers as the responder, doing its
 * one Diffie-Hellman through the key helper (invariant 10). The phone must then send `binding` (its device id and an ES256 signature by its
 * session key over the handshake hash) within 10 s, and the device must be TRUSTED right now (`registry.trustedDevice`, no cache); only then
 * does the core send `hello`, audit `session-open`, and open the session to the registered ops.
 *
 * Fail closed (invariants 13, 14): a frame is size-checked before decryption; ANY decryption failure, nonce gap, bad envelope or oversize frame
 * ends the session; a frame tagged with an ended session is dropped without decrypting. The protocol version is bound into the prologue
 * (`agetor-remote/1` ‖ core id), so a different version or core fails the handshake. A new handshake from the same device replaces its session;
 * handshakes pass the 6-a-minute bucket. Rekey every 10 minutes or 2^20 messages (an in-band `rekey` message under the old key, then both
 * sides rekey); a session ends after 15 idle minutes or 12 hours.
 *
 * Sending is one ordered pump per session: a message is chunked and padded, each chunk encrypted in order and handed to the relay link's
 * pacer, yielding between chunks and waiting while the pacer's queue is deep, so a 50 MB preview never freezes the core's thread and a slow
 * phone never grows memory (the queue the backpressure cap reads is `PhoneChannel.queuedBytes()`).
 */
import { equalBytes, fromHex, randomBytes, toHex } from "@agetor/remote-protocol/bytes";
import { MAX_NOISE_MESSAGE_BYTES, MIN_PROTOCOL_VERSION, PROLOGUE_PREFIX, PROTOCOL_VERSION, REKEY_INTERVAL_MS, REKEY_MESSAGES, SESSION_IDLE_MS, SESSION_MAX_MS, SESSION_TAG_BYTES } from "@agetor/remote-protocol/constants";
import { coreId } from "@agetor/remote-protocol/derive";
import { Reassembler, sealStream, EnvelopeError } from "@agetor/remote-protocol/envelope";
import { verifyEs256 } from "@agetor/remote-protocol/es256";
import { MESSAGES, ParseError, encodeMessage, isMessageType, parseMessage, type MessageType } from "@agetor/remote-protocol/messages";
import { CipherState, HandshakeState, prologue } from "@agetor/remote-protocol/noise";
import type { RemoteLevel } from "@agetor/remote-protocol/levels";
import { canonicalBytes } from "@agetor/remote-protocol/canonical-json";
import type { RemotePolicy } from "../route-policy.ts";
import type { Audit } from "./audit.ts";
import type { KeyHelper } from "./key-helper-api.ts";
import type { RateLimiter } from "./rate-limit.ts";
import type { Registry } from "./registry.ts";
import type { Delivered } from "./relay-link.ts";
import { bindSessionEnder, getSessionOp } from "./session-dispatch.ts";
import type { DevicePrincipal, PhoneChannel } from "./types.ts";

export const BINDING_TIMEOUT_MS = 10_000;
/** A handshake message is an ephemeral key plus a tag (and an empty payload): 48 bytes. Anything far larger is not one. */
export const MAX_HANDSHAKE_BYTES = 1024;
const MIN_HANDSHAKE_BYTES = 48;
const ENDED_TAGS_KEPT = 64;
const PUMP_HIGH_WATER_BYTES = 1024 * 1024;

export interface SessionLink {
  send(name: string, mailbox: Uint8Array | null, tag: Uint8Array, payload: Uint8Array, opts?: { priority?: boolean }): boolean;
  queuedBytes(name: string): number;
}

export interface SessionManagerDeps {
  link: SessionLink;
  helper: () => KeyHelper;
  registry: Pick<Registry, "trustedDevice">;
  audit: Pick<Audit, "event" | "refusal" | "head">;
  limiter: Pick<RateLimiter, "check">;
  decisions: { endSession(sessionId: string): void };
  macName: () => Promise<string>;
  routes: (level: RemoteLevel) => Array<{ method: string; route: string; policy: RemotePolicy }>;
  /** Record that a device was seen (the 60-day expiry reads it). */
  touch?: (deviceId: string, ts: number) => Promise<void> | void;
  /** A session became active: the gateway attaches per-session state (subscriptions, terminal) here. */
  onOpen?: (channel: PhoneChannel) => void;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
  /** Test seams for the lifetime rules. */
  limits?: { bindingMs?: number; idleMs?: number; maxMs?: number; rekeyMs?: number; rekeyMessages?: number };
}

interface QueueItem {
  kind: "message" | "rekey";
  type: string;
  id: string;
  bytes: Uint8Array;
}

type State = "binding" | "active" | "ended";

class Session {
  readonly id = toHex(randomBytes(8));
  state: State = "binding";
  principal: DevicePrincipal | null = null;
  readonly reassembler = new Reassembler();
  startedAt: number;
  lastActivity: number;
  sentMessages = 0;
  readonly queue: QueueItem[] = [];
  queuedBytesInQueue = 0;
  pumping = false;
  timers: unknown[] = [];
  closeFns = new Set<(reason: string) => void>();
  peerFns = new Set<(present: boolean) => void>();
  peer = true;
  constructor(
    readonly deviceId: string,
    readonly mailbox: Uint8Array,
    readonly tag: Uint8Array,
    readonly send: CipherState,
    readonly recv: CipherState,
    readonly handshakeHash: Uint8Array,
    now: number,
  ) {
    this.startedAt = this.lastActivity = now;
  }
}

interface DeviceState {
  session: Session | null;
  endedTags: string[];
  chain: Promise<void>;
}

export interface SessionManager {
  /** A frame delivered on a device's mailbox group (`name` is the device id). Serialized per device. */
  onFrame(name: string, d: Delivered): Promise<void>;
  /** True when the tag belongs to a session that ended: the relay link drops such frames before they get here. */
  isStaleTag(name: string, tag: Uint8Array): boolean;
  /** The relay said the phone joined or left the mailbox. */
  setPeer(name: string, present: boolean): void;
  endDeviceSessions(deviceId: string, reason: string): void;
  endAllSessions(reason: string): void;
  activeSessions(): Array<{ deviceId: string; sessionId: string; level: RemoteLevel; since: number }>;
  /** The channel of a device's active session, if any. */
  channelFor(deviceId: string): PhoneChannel | null;
  stop(): void;
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const now = deps.now ?? Date.now;
  const setIv = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearIv = deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const setTo = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTo = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const lim = { bindingMs: BINDING_TIMEOUT_MS, idleMs: SESSION_IDLE_MS, maxMs: SESSION_MAX_MS, rekeyMs: REKEY_INTERVAL_MS, rekeyMessages: REKEY_MESSAGES, ...deps.limits };
  const devices = new Map<string, DeviceState>();
  let stopped = false;

  const dev = (id: string): DeviceState => {
    let d = devices.get(id);
    if (!d) devices.set(id, (d = { session: null, endedTags: [], chain: Promise.resolve() }));
    return d;
  };

  // ── ending ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  function end(s: Session, reason: string, opts: { audit?: boolean } = {}): void {
    if (s.state === "ended") return;
    const wasActive = s.state === "active";
    s.state = "ended";
    for (const t of s.timers) {
      clearTo(t);
      clearIv(t);
    }
    s.timers = [];
    s.queue.length = 0;
    s.queuedBytesInQueue = 0;
    const d = dev(s.deviceId);
    if (d.session === s) d.session = null;
    d.endedTags.push(toHex(s.tag));
    if (d.endedTags.length > ENDED_TAGS_KEPT) d.endedTags.shift();
    deps.decisions.endSession(s.id);
    for (const fn of [...s.closeFns]) {
      try {
        fn(reason);
      } catch {
        /* a listener must not stop the others */
      }
    }
    s.closeFns.clear();
    s.peerFns.clear();
    if (wasActive && opts.audit !== false) {
      void deps.audit.event("session-close", { deviceId: s.deviceId, sessionHash: toHex(s.handshakeHash), resultCode: reason }).catch(() => undefined);
    }
  }

  // ── channel ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  function makeChannel(s: Session, principal: DevicePrincipal): PhoneChannel {
    return {
      principal,
      send(type, body, opts) {
        if (s.state !== "active") return;
        let bytes: Uint8Array;
        try {
          bytes = type === "rekey" ? canonicalBytes(body) : encodeMessage(type as MessageType, body);
        } catch {
          // The core never sends a message its own schema refuses: that would be a bug, so it is dropped loudly in tests via the error type.
          throw new Error(`refusing to send a malformed ${type} message`);
        }
        const id = String((body as { id?: unknown }).id ?? (body as { sub?: unknown }).sub ?? `c${s.sentMessages}`).slice(0, 64) || "m";
        enqueue(s, { kind: "message", type, id, bytes });
        void opts;
      },
      queuedBytes: () => deps.link.queuedBytes(s.deviceId) + s.queuedBytesInQueue,
      peerPresent: () => s.peer,
      onClose(fn) {
        s.closeFns.add(fn);
        return () => void s.closeFns.delete(fn);
      },
      onPeerChange(fn) {
        s.peerFns.add(fn);
        return () => void s.peerFns.delete(fn);
      },
    };
  }

  function enqueue(s: Session, item: QueueItem): void {
    if (s.state === "ended") return;
    s.queue.push(item);
    s.queuedBytesInQueue += item.bytes.length;
    pump(s).catch(() => end(s, "send-failed"));
  }

  const isEnded = (s: Session): boolean => s.state === "ended";

  async function pump(s: Session): Promise<void> {
    if (s.pumping) return;
    s.pumping = true;
    try {
      while (!isEnded(s) && s.queue.length > 0) {
        const item = s.queue.shift()!;
        s.queuedBytesInQueue -= item.bytes.length;
        if (item.kind === "rekey") {
          s.send.rekey();
          continue;
        }
        for (const plaintext of sealStream(item.type, item.id, item.bytes)) {
          while (!isEnded(s) && deps.link.queuedBytes(s.deviceId) > PUMP_HIGH_WATER_BYTES) await new Promise((r) => setTimeout(r, 5));
          if (isEnded(s)) return;
          const ct = s.send.encrypt(new Uint8Array(0), plaintext);
          // Never `priority`: a session's ciphertexts are one strictly ordered stream (the nonce counts them), and the pacer lets a priority
          // frame overtake the queue. One frame out of order ends the session on the other side.
          deps.link.send(s.deviceId, s.mailbox, s.tag, ct);
          s.sentMessages++;
          // Yield between chunks so a big message never holds the main thread.
          await new Promise<void>((r) => setImmediate(r));
        }
        if (s.sentMessages >= lim.rekeyMessages) rekeyNow(s);
      }
    } finally {
      s.pumping = false;
    }
  }

  /** An in-band rekey: the marker goes out under the old key, then the send cipher rekeys (both sides rekey at the same count). */
  function rekeyNow(s: Session): void {
    if (s.state !== "active") return;
    s.sentMessages = 0;
    enqueue(s, { kind: "message", type: "rekey", id: "rekey", bytes: canonicalBytes({}) });
    enqueue(s, { kind: "rekey", type: "rekey", id: "rekey", bytes: new Uint8Array(0) });
  }

  // ── frames ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  async function handle(name: string, d: Delivered): Promise<void> {
    if (stopped) return;
    const state = dev(name);
    const cur = state.session;
    if (d.payload.length > MAX_NOISE_MESSAGE_BYTES) {
      if (cur) end(cur, "oversize-frame");
      return;
    }
    if (cur && cur.state !== "ended" && equalBytes(cur.tag, d.tag)) return await transport(cur, d);
    return await handshake(name, state, d);
  }

  async function handshake(name: string, state: DeviceState, d: Delivered): Promise<void> {
    if (d.payload.length < MIN_HANDSHAKE_BYTES || d.payload.length > MAX_HANDSHAKE_BYTES || d.tag.length !== SESSION_TAG_BYTES) return;
    // Only a trusted device gets a handshake: untrusted ids cost nothing (no helper Diffie-Hellman) and get no answer.
    const row = await deps.registry.trustedDevice(name).catch(() => null);
    if (!row) {
      void deps.audit.refusal(name, "untrusted-device").catch(() => undefined);
      return;
    }
    if (!deps.limiter.check(name, "handshake").ok) {
      void deps.audit.refusal(name, "handshake-rate").catch(() => undefined);
      return;
    }
    const helper = deps.helper();
    let hs: HandshakeState;
    let corePub: Uint8Array;
    try {
      corePub = (await helper.status()).corePub;
      hs = new HandshakeState({
        pattern: "NK", role: "responder", prologue: prologue(PROLOGUE_PREFIX, coreId(corePub)), staticPublic: corePub, staticDh: (p) => helper.dh(p),
      });
      await hs.readMessage(d.payload);
    } catch {
      void deps.audit.refusal(name, "handshake-failed").catch(() => undefined);
      return;
    }
    // A new handshake from the same device replaces its session.
    if (state.session) end(state.session, "replaced");
    const reply = await hs.writeMessage(new Uint8Array(0));
    const { send, recv } = hs.split();
    const s = new Session(name, d.mailbox, d.tag, send, recv, hs.handshakeHash(), now());
    state.session = s;
    deps.link.send(name, d.mailbox, d.tag, reply, { priority: true });
    s.timers.push(setTo(() => end(s, "binding-timeout"), lim.bindingMs));
  }

  async function transport(s: Session, d: Delivered): Promise<void> {
    let plaintext: Uint8Array;
    let msg: { t: string; id: string; body: Uint8Array } | null;
    try {
      plaintext = s.recv.decrypt(new Uint8Array(0), d.payload);
      msg = s.reassembler.push(plaintext);
    } catch (e) {
      void deps.audit.refusal(s.deviceId, e instanceof EnvelopeError ? "bad-envelope" : "decrypt-failed").catch(() => undefined);
      end(s, e instanceof EnvelopeError ? "bad-envelope" : "decrypt-failed");
      return;
    }
    s.lastActivity = now();
    if (!msg) return;
    if (msg.t === "rekey") {
      s.recv.rekey();
      return;
    }
    if (s.state === "binding") return await bind(s, msg);
    await dispatch(s, msg);
  }

  async function bind(s: Session, msg: { t: string; id: string; body: Uint8Array }): Promise<void> {
    try {
      if (msg.t !== "binding") throw new ParseError("binding expected first");
      const b = parseMessage<{ deviceId: string; sig: string }>("binding", msg.body);
      if (b.deviceId !== s.deviceId) throw new ParseError("binding names another device");
      const row = await deps.registry.trustedDevice(s.deviceId);
      if (!row) throw new ParseError("device is not trusted");
      if (!verifyEs256(row.sessionPub, s.handshakeHash, fromHex(b.sig))) throw new ParseError("bad channel binding");
      if (s.state !== "binding") return;
      const principal: DevicePrincipal = {
        kind: "device", deviceId: row.id, deviceName: row.name, level: row.level, sessionId: s.id, sessionHash: s.handshakeHash, approvePub: row.approvePub,
      };
      s.principal = principal;
      s.state = "active";
      for (const t of s.timers) clearTo(t);
      s.timers = [];
      const channel = makeChannel(s, principal);
      const head = await deps.audit.head().catch(() => null);
      const routes = deps.routes(row.level).map((r) => ({ method: r.method, route: r.route, level: r.policy.level, stepUp: r.policy.stepUp, rate: r.policy.rate }));
      await deps.audit.event("session-open", { deviceId: row.id, sessionHash: toHex(s.handshakeHash) });
      channel.send("hello", {
        protocolVersion: PROTOCOL_VERSION, minProtocolVersion: MIN_PROTOCOL_VERSION, deviceId: row.id, level: row.level, routes,
        auditHead: head, clock: now(), macName: await deps.macName(),
      });
      s.timers.push(
        setIv(() => {
          if (now() - s.lastActivity > lim.idleMs) end(s, "idle");
          else if (now() - s.startedAt > lim.maxMs) end(s, "max-lifetime");
        }, Math.max(10, Math.min(30_000, Math.floor(Math.min(lim.idleMs, lim.maxMs) / 4)))),
        setIv(() => rekeyNow(s), lim.rekeyMs),
      );
      void Promise.resolve(deps.touch?.(row.id, now())).catch(() => undefined);
      deps.onOpen?.(channel);
    } catch (e) {
      void deps.audit.refusal(s.deviceId, e instanceof ParseError ? "binding-refused" : "binding-failed").catch(() => undefined);
      end(s, "binding-failed", { audit: false });
    }
  }

  async function dispatch(s: Session, msg: { t: string; id: string; body: Uint8Array }): Promise<void> {
    const channel = makeChannelOf(s);
    if (!channel) return;
    // Only phone-to-core messages are ops; a phone sending a core message type (or `binding` again) is misbehaving.
    if (!isMessageType(msg.t) || MESSAGES[msg.t].dir !== "phone" || msg.t === "binding" || msg.t === "pairing-request") {
      channel.send("error", { id: null, code: "unknown-op", message: "unknown operation" });
      void deps.audit.refusal(s.deviceId, "unknown-op").catch(() => undefined);
      return;
    }
    let body: unknown;
    try {
      body = parseMessage(msg.t, msg.body);
    } catch (e) {
      // A message that fails its strict schema is refused, never half-handled (invariant 13).
      channel.send("error", { id: null, code: "bad-message", message: e instanceof ParseError ? "the message did not match its schema" : "bad message" });
      void deps.audit.refusal(s.deviceId, "bad-message", msg.t).catch(() => undefined);
      return;
    }
    const handler = getSessionOp(msg.t);
    if (!handler) {
      channel.send("error", { id: (body as { id?: string }).id ?? null, code: "unsupported", message: "this operation is not available" });
      return;
    }
    try {
      await handler(channel, body, msg.id);
    } catch {
      // Handlers audit their own refusals; a throw is an internal failure and says nothing about why.
      if (s.state === "active") channel.send("error", { id: (body as { id?: string }).id ?? null, code: "internal", message: "the operation failed" });
    }
  }

  const channels = new WeakMap<Session, PhoneChannel>();
  function makeChannelOf(s: Session): PhoneChannel | null {
    if (s.state !== "active" || !s.principal) return null;
    let c = channels.get(s);
    if (!c) channels.set(s, (c = makeChannel(s, s.principal)));
    return c;
  }

  // ── public ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  const manager: SessionManager = {
    onFrame(name, d) {
      const state = dev(name);
      state.chain = state.chain.then(() => handle(name, d)).catch(() => undefined);
      return state.chain;
    },
    isStaleTag: (name, tag) => devices.get(name)?.endedTags.includes(toHex(tag)) ?? false,
    setPeer(name, present) {
      const s = devices.get(name)?.session;
      if (!s || s.state === "ended") return;
      s.peer = present;
      for (const fn of [...s.peerFns]) {
        try {
          fn(present);
        } catch {
          /* ignore */
        }
      }
    },
    endDeviceSessions(deviceId, reason) {
      const s = devices.get(deviceId)?.session;
      if (s) end(s, reason);
    },
    endAllSessions(reason) {
      for (const d of devices.values()) if (d.session) end(d.session, reason);
    },
    activeSessions: () =>
      [...devices.values()].flatMap((d) => (d.session && d.session.state === "active" && d.session.principal ? [{ deviceId: d.session.deviceId, sessionId: d.session.id, level: d.session.principal.level, since: d.session.startedAt }] : [])),
    channelFor(deviceId) {
      const s = devices.get(deviceId)?.session;
      return s ? makeChannelOf(s) : null;
    },
    stop() {
      stopped = true;
      manager.endAllSessions("stopped");
      bindSessionEnder(null);
    },
  };
  bindSessionEnder(manager);
  return manager;
}

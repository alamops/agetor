/**
 * Relay frames (relay contract §1, plan A-3): binary, `[version u8][type u8][fields…]`, big-endian, at most 66 KB.
 * A frame over the limit is refused before parsing. Bytes after the known fields are ignored, so a newer relay can add
 * fields; an unknown type is refused.
 */
import { readU16, readU64, u16be, u64be } from "./bytes.ts";
import { concat } from "./bytes.ts";
import { MAILBOX_ID_BYTES, MAILBOX_KEY_BYTES, MAX_RELAY_FRAME_BYTES, MAX_NOISE_MESSAGE_BYTES, SESSION_TAG_BYTES } from "./constants.ts";

export const RELAY_FRAME_VERSION = 1;

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

export type RelayRole = "core" | "device";

export type RelayFrame =
  | { type: "hello"; role: RelayRole; keys: Uint8Array[] }
  | { type: "welcome"; ids: Uint8Array[]; queued: number }
  | { type: "send"; mailbox: Uint8Array; tag: Uint8Array; payload: Uint8Array }
  | { type: "deliver"; mailbox: Uint8Array; seq: bigint; tag: Uint8Array; payload: Uint8Array }
  | { type: "ack"; mailbox: Uint8Array; seq: bigint }
  | { type: "peer"; mailbox: Uint8Array; present: boolean }
  | { type: "full"; mailbox: Uint8Array }
  | { type: "replaced"; mailbox: Uint8Array }
  | { type: "ping" }
  | { type: "pong" };

const T = { hello: 1, welcome: 2, send: 3, deliver: 4, ack: 5, peer: 6, full: 7, replaced: 8, ping: 9, pong: 10 } as const;
const ROLE = { core: 1, device: 2 } as const;

function need(cond: boolean, msg: string): void {
  if (!cond) throw new FrameError(msg);
}

function fixed(b: Uint8Array, len: number, what: string): void {
  need(b.length === len, `${what} must be ${len} bytes`);
}

export function encodeFrame(f: RelayFrame): Uint8Array {
  const head = Uint8Array.of(RELAY_FRAME_VERSION, T[f.type]);
  let out: Uint8Array;
  switch (f.type) {
    case "hello":
      need(f.keys.length >= 1 && f.keys.length <= 4, "hello needs 1 to 4 keys");
      for (const k of f.keys) fixed(k, MAILBOX_KEY_BYTES, "mailbox key");
      out = concat(head, Uint8Array.of(ROLE[f.role], f.keys.length), ...f.keys);
      break;
    case "welcome":
      need(f.ids.length <= 4, "welcome carries at most 4 ids");
      for (const id of f.ids) fixed(id, MAILBOX_ID_BYTES, "mailbox id");
      out = concat(head, Uint8Array.of(f.ids.length), ...f.ids, u16be(Math.min(f.queued, 0xffff)));
      break;
    case "send":
      fixed(f.mailbox, MAILBOX_ID_BYTES, "mailbox id");
      fixed(f.tag, SESSION_TAG_BYTES, "session tag");
      need(f.payload.length <= MAX_NOISE_MESSAGE_BYTES, "payload over 65,535 bytes");
      out = concat(head, f.mailbox, f.tag, u16be(f.payload.length), f.payload);
      break;
    case "deliver":
      fixed(f.mailbox, MAILBOX_ID_BYTES, "mailbox id");
      fixed(f.tag, SESSION_TAG_BYTES, "session tag");
      need(f.payload.length <= MAX_NOISE_MESSAGE_BYTES, "payload over 65,535 bytes");
      out = concat(head, f.mailbox, u64be(f.seq), f.tag, u16be(f.payload.length), f.payload);
      break;
    case "ack":
      fixed(f.mailbox, MAILBOX_ID_BYTES, "mailbox id");
      out = concat(head, f.mailbox, u64be(f.seq));
      break;
    case "peer":
      fixed(f.mailbox, MAILBOX_ID_BYTES, "mailbox id");
      out = concat(head, f.mailbox, Uint8Array.of(f.present ? 1 : 0));
      break;
    case "full":
    case "replaced":
      fixed(f.mailbox, MAILBOX_ID_BYTES, "mailbox id");
      out = concat(head, f.mailbox);
      break;
    case "ping":
    case "pong":
      out = head;
      break;
  }
  need(out.length <= MAX_RELAY_FRAME_BYTES, "frame over 66 KB");
  return out;
}

export function decodeFrame(b: Uint8Array): RelayFrame {
  need(b.length <= MAX_RELAY_FRAME_BYTES, "frame over 66 KB");
  need(b.length >= 2, "short frame");
  need(b[0] === RELAY_FRAME_VERSION, "unknown frame version");
  const type = b[1] as number;
  let o = 2;
  const take = (n: number): Uint8Array => {
    need(o + n <= b.length, "truncated frame");
    const s = b.slice(o, o + n);
    o += n;
    return s;
  };
  try {
    switch (type) {
      case T.hello: {
        const roleByte = take(1)[0] as number;
        const role = roleByte === ROLE.core ? "core" : roleByte === ROLE.device ? "device" : null;
        need(role !== null, "unknown role");
        const n = take(1)[0] as number;
        need(n >= 1 && n <= 4, "bad key count");
        const keys: Uint8Array[] = [];
        for (let i = 0; i < n; i++) keys.push(take(MAILBOX_KEY_BYTES));
        return { type: "hello", role: role as RelayRole, keys };
      }
      case T.welcome: {
        const n = take(1)[0] as number;
        need(n <= 4, "bad id count");
        const ids: Uint8Array[] = [];
        for (let i = 0; i < n; i++) ids.push(take(MAILBOX_ID_BYTES));
        const q = take(2);
        return { type: "welcome", ids, queued: readU16(q, 0) };
      }
      case T.send: {
        const mailbox = take(MAILBOX_ID_BYTES);
        const tag = take(SESSION_TAG_BYTES);
        const len = readU16(take(2), 0);
        return { type: "send", mailbox, tag, payload: take(len) };
      }
      case T.deliver: {
        const mailbox = take(MAILBOX_ID_BYTES);
        const seq = readU64(take(8), 0);
        const tag = take(SESSION_TAG_BYTES);
        const len = readU16(take(2), 0);
        return { type: "deliver", mailbox, seq, tag, payload: take(len) };
      }
      case T.ack: {
        const mailbox = take(MAILBOX_ID_BYTES);
        return { type: "ack", mailbox, seq: readU64(take(8), 0) };
      }
      case T.peer: {
        const mailbox = take(MAILBOX_ID_BYTES);
        const p = take(1)[0] as number;
        need(p === 0 || p === 1, "bad peer flag");
        return { type: "peer", mailbox, present: p === 1 };
      }
      case T.full:
        return { type: "full", mailbox: take(MAILBOX_ID_BYTES) };
      case T.replaced:
        return { type: "replaced", mailbox: take(MAILBOX_ID_BYTES) };
      case T.ping:
        return { type: "ping" };
      case T.pong:
        return { type: "pong" };
      default:
        throw new FrameError("unknown frame type");
    }
  } catch (e) {
    if (e instanceof FrameError) throw e;
    throw new FrameError("malformed frame");
  }
}

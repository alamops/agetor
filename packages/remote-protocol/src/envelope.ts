/**
 * App message envelopes inside Noise (plan A-3): a JSON plaintext `{t, id, ci, cc, b}`, padded to a bucket.
 * `t` is the message type, `id` the message id, `ci` the chunk index, `cc` the chunk count and `b` the base64 of
 * that chunk's bytes of the message body (canonical JSON). A message larger than one chunk is split; the
 * reassembler caps the count and total size and refuses out-of-order or duplicate chunks.
 */
import { fromBase64, fromUtf8, toBase64, utf8 } from "./bytes.ts";
import { canonicalize, parseJsonStrict } from "./canonical-json.ts";
import { CHUNK_RAW_BYTES, MAX_CHUNKS_PER_MESSAGE, MAX_INFLIGHT_MESSAGES, MAX_MESSAGE_BYTES } from "./constants.ts";
import { pad, unpad } from "./padding.ts";

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

export interface Envelope {
  t: string;
  id: string;
  ci: number;
  cc: number;
  b: string;
}

export interface AppMessage {
  t: string;
  id: string;
  body: Uint8Array;
}

/** Split a message body into padded Noise plaintexts, one per chunk. */
export function seal(t: string, id: string, body: Uint8Array, chunkBytes = CHUNK_RAW_BYTES): Uint8Array[] {
  const cc = Math.max(1, Math.ceil(body.length / chunkBytes));
  if (cc > MAX_CHUNKS_PER_MESSAGE) throw new EnvelopeError("message needs too many chunks");
  if (body.length > MAX_MESSAGE_BYTES) throw new EnvelopeError("message too large");
  const out: Uint8Array[] = [];
  for (let ci = 0; ci < cc; ci++) {
    const part = body.subarray(ci * chunkBytes, Math.min(body.length, (ci + 1) * chunkBytes));
    out.push(pad(utf8(canonicalize({ t, id, ci, cc, b: toBase64(part) } satisfies Envelope))));
  }
  return out;
}

export function parseEnvelope(plaintext: Uint8Array): Envelope {
  let v: unknown;
  try {
    v = parseJsonStrict(fromUtf8(unpad(plaintext)));
  } catch {
    throw new EnvelopeError("bad envelope");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new EnvelopeError("bad envelope");
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "b,cc,ci,id,t") throw new EnvelopeError("bad envelope fields");
  const { t, id, ci, cc, b } = o as { t: unknown; id: unknown; ci: unknown; cc: unknown; b: unknown };
  if (typeof t !== "string" || t.length === 0 || t.length > 64) throw new EnvelopeError("bad type");
  if (typeof id !== "string" || id.length === 0 || id.length > 64) throw new EnvelopeError("bad id");
  if (!Number.isInteger(ci) || !Number.isInteger(cc)) throw new EnvelopeError("bad chunk numbers");
  if ((cc as number) < 1 || (cc as number) > MAX_CHUNKS_PER_MESSAGE || (ci as number) < 0 || (ci as number) >= (cc as number)) {
    throw new EnvelopeError("chunk out of range");
  }
  if (typeof b !== "string") throw new EnvelopeError("bad body");
  return { t, id, ci: ci as number, cc: cc as number, b };
}

interface Pending {
  t: string;
  cc: number;
  next: number;
  parts: Uint8Array[];
  bytes: number;
}

export class Reassembler {
  private readonly inflight = new Map<string, Pending>();

  /** Feed one decrypted plaintext. Returns the whole message when its last chunk arrives, else null. Throws on any violation. */
  push(plaintext: Uint8Array): AppMessage | null {
    const e = parseEnvelope(plaintext);
    let chunk: Uint8Array;
    try {
      chunk = fromBase64(e.b);
    } catch {
      throw new EnvelopeError("bad chunk encoding");
    }
    let p = this.inflight.get(e.id);
    if (!p) {
      if (e.ci !== 0) throw new EnvelopeError("chunk out of order");
      if (this.inflight.size >= MAX_INFLIGHT_MESSAGES) throw new EnvelopeError("too many messages in flight");
      p = { t: e.t, cc: e.cc, next: 0, parts: [], bytes: 0 };
      this.inflight.set(e.id, p);
    }
    if (p.t !== e.t || p.cc !== e.cc) throw new EnvelopeError("chunk header changed");
    if (e.ci !== p.next) throw new EnvelopeError(e.ci < p.next ? "duplicate chunk" : "chunk out of order");
    p.bytes += chunk.length;
    if (p.bytes > MAX_MESSAGE_BYTES) throw new EnvelopeError("message too large");
    p.parts.push(chunk);
    p.next++;
    if (p.next < p.cc) return null;
    this.inflight.delete(e.id);
    const body = new Uint8Array(p.bytes);
    let o = 0;
    for (const part of p.parts) {
      body.set(part, o);
      o += part.length;
    }
    return { t: p.t, id: e.id, body };
  }

  inFlight(): number {
    return this.inflight.size;
  }

  clear(): void {
    this.inflight.clear();
  }
}

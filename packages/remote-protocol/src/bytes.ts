/** Byte helpers. No platform APIs beyond the Web standard ones, so the same file runs in Bun and a browser. */
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return decoder.decode(b);
}

const HEX = "0123456789abcdef";

export function toHex(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i++) {
    const v = b[i] as number;
    out += HEX[v >> 4]! + HEX[v & 15]!;
  }
  return out;
}

const HEX_RE = /^(?:[0-9a-f]{2})*$/;

/** Strict lowercase hex. Anything else (uppercase, odd length, whitespace) throws. */
export function fromHex(s: string): Uint8Array {
  if (typeof s !== "string" || !HEX_RE.test(s)) throw new TypeError("invalid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function isHex(s: unknown, bytes?: number): s is string {
  return typeof s === "string" && HEX_RE.test(s) && (bytes === undefined || s.length === bytes * 2);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function u16be(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new RangeError("u16 out of range");
  return Uint8Array.of(n >>> 8, n & 0xff);
}

export function u32be(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError("u32 out of range");
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

export function u64be(n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < 0n || v > 0xffffffffffffffffn) throw new RangeError("u64 out of range");
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, false);
  return out;
}

export function readU16(b: Uint8Array, o: number): number {
  if (o + 2 > b.length) throw new RangeError("short read");
  return ((b[o] as number) << 8) | (b[o + 1] as number);
}

export function readU32(b: Uint8Array, o: number): number {
  if (o + 4 > b.length) throw new RangeError("short read");
  return (((b[o] as number) << 24) | ((b[o + 1] as number) << 16) | ((b[o + 2] as number) << 8) | (b[o + 3] as number)) >>> 0;
}

export function readU64(b: Uint8Array, o: number): bigint {
  if (o + 8 > b.length) throw new RangeError("short read");
  return new DataView(b.buffer, b.byteOffset + o, 8).getBigUint64(0, false);
}

/** Constant-time comparison of two byte strings. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // getRandomValues is limited to 65,536 bytes per call.
  for (let o = 0; o < n; o += 65536) crypto.getRandomValues(out.subarray(o, Math.min(n, o + 65536)));
  return out;
}

export function zero(b: Uint8Array): void {
  b.fill(0);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_REV = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64_REV[B64.charCodeAt(i)] = i;

export function toBase64(b: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = ((b[i] as number) << 16) | ((b[i + 1] as number) << 8) | (b[i + 2] as number);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rem = b.length - i;
  if (rem === 1) {
    const n = (b[i] as number) << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + "==";
  } else if (rem === 2) {
    const n = ((b[i] as number) << 16) | ((b[i + 1] as number) << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + "=";
  }
  return out;
}

/** Strict standard base64 with padding. Throws on anything else. */
export function fromBase64(s: string): Uint8Array {
  if (typeof s !== "string" || s.length % 4 !== 0) throw new TypeError("invalid base64");
  let pad = 0;
  if (s.endsWith("==")) pad = 2;
  else if (s.endsWith("=")) pad = 1;
  const body = s.length - pad;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j++) {
      const c = s.charCodeAt(i + j);
      let v: number;
      if (i + j >= body) {
        if (c !== 61) throw new TypeError("invalid base64");
        v = 0;
      } else {
        v = c < 128 ? (B64_REV[c] as number) : -1;
        if (v < 0) throw new TypeError("invalid base64");
      }
      n = (n << 6) | v;
    }
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

export function toBase64Url(b: Uint8Array): string {
  return toBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict base64url without padding. */
export function fromBase64Url(s: string): Uint8Array {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new TypeError("invalid base64url");
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(std + "=".repeat((4 - (std.length % 4)) % 4));
}

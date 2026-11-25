/**
 * Padding inside the encryption: payload ‖ 0x80 ‖ zeros up to the smallest bucket that fits
 * (256 B, 1 KB, 4 KB, 16 KB, then the largest Noise plaintext). ISO/IEC 7816-4 style, so unpadding is unambiguous.
 */
import { concat } from "./bytes.ts";
import { MAX_NOISE_PLAINTEXT_BYTES, PADDING_BUCKETS } from "./constants.ts";

export class PaddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaddingError";
  }
}

/** The bucket a payload of `len` bytes pads to, or null when it cannot fit in one Noise message. */
export function bucketFor(len: number): number | null {
  for (const b of PADDING_BUCKETS) if (len + 1 <= b) return b;
  return null;
}

export function pad(payload: Uint8Array): Uint8Array {
  const bucket = bucketFor(payload.length);
  if (bucket === null) throw new PaddingError(`payload of ${payload.length} bytes exceeds ${MAX_NOISE_PLAINTEXT_BYTES - 1}`);
  const out = new Uint8Array(bucket);
  out.set(payload, 0);
  out[payload.length] = 0x80;
  return out;
}

export function unpad(padded: Uint8Array): Uint8Array {
  if (!(PADDING_BUCKETS as readonly number[]).includes(padded.length)) throw new PaddingError("not a bucket size");
  let i = padded.length - 1;
  while (i >= 0 && padded[i] === 0) i--;
  if (i < 0 || padded[i] !== 0x80) throw new PaddingError("bad padding");
  return padded.slice(0, i);
}

export { concat };

/**
 * The sealed push payload (spec "Push notifications"): `{v, taskId, kind, title, subtitle, ts}` padded to exactly 1 KB and
 * HPKE-sealed to the device's push key with info `agetor-push/1`. The output is always `enc (32) ‖ ciphertext (1,024 + 16)` =
 * 1,072 bytes whatever the title length, so a push reveals nothing about the text (spec "Threat model": the gateway and Apple see
 * only ciphertext, size and timing). A title that does not fit is cut, never refused.
 */
import { concat, fromUtf8, utf8 } from "./bytes.ts";
import { canonicalize, parseJsonStrict } from "./canonical-json.ts";
import { INFO_PUSH, PUSH_PAD_BYTES } from "./constants.ts";
import { hpkeOpen, hpkeSeal } from "./hpke.ts";

export class PushPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushPayloadError";
  }
}

export interface PushPayload {
  v: 1;
  taskId: string;
  kind: string;
  title: string;
  subtitle: string | null;
  ts: number;
}

const INFO = utf8(INFO_PUSH);
const EMPTY = new Uint8Array(0);
/** The marker byte takes one byte of the 1 KB. */
const MAX_JSON_BYTES = PUSH_PAD_BYTES - 1;

function cutTo(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  let cut = s.slice(0, Math.max(0, maxChars));
  // Never end on half a surrogate pair.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/** Fit the payload into 1,023 bytes of canonical JSON by cutting the title, then the subtitle. */
export function fitPayload(p: PushPayload): PushPayload {
  if (typeof p.taskId !== "string" || p.taskId.length === 0 || p.taskId.length > 128) throw new PushPayloadError("bad taskId");
  if (typeof p.kind !== "string" || p.kind.length === 0 || p.kind.length > 32) throw new PushPayloadError("bad kind");
  const size = (x: PushPayload) => utf8(canonicalize(x)).length;
  let cur: PushPayload = { v: 1, taskId: p.taskId, kind: p.kind, title: p.title, subtitle: p.subtitle ?? null, ts: p.ts };
  if (size(cur) <= MAX_JSON_BYTES) return cur;
  // Binary search the longest title prefix that fits (a code unit can take up to 3 UTF-8 bytes, so search on length, not bytes).
  let lo = 0;
  let hi = cur.title.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (size({ ...cur, title: cutTo(cur.title, mid) }) <= MAX_JSON_BYTES) lo = mid;
    else hi = mid - 1;
  }
  cur = { ...cur, title: cutTo(cur.title, lo) };
  if (size(cur) <= MAX_JSON_BYTES) return cur;
  // The title is already empty and it still does not fit: the subtitle goes the same way.
  let s = cur.subtitle ?? "";
  lo = 0;
  hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (size({ ...cur, subtitle: cutTo(s, mid) }) <= MAX_JSON_BYTES) lo = mid;
    else hi = mid - 1;
  }
  cur = { ...cur, subtitle: cutTo(s, lo) };
  if (size(cur) > MAX_JSON_BYTES) throw new PushPayloadError("payload cannot fit in 1 KB");
  return cur;
}

/** Pad to exactly 1 KB (marker byte 0x80 then zeros) and seal to the device's push public key. */
export function sealPush(payload: PushPayload, pushPublic: Uint8Array, ephemeralSecret?: Uint8Array): Uint8Array {
  const json = utf8(canonicalize(fitPayload(payload)));
  const padded = new Uint8Array(PUSH_PAD_BYTES);
  padded.set(json, 0);
  padded[json.length] = 0x80;
  return hpkeSeal(pushPublic, INFO, EMPTY, padded, ephemeralSecret);
}

/** Open a sealed push with the device's push private key; the inverse of `sealPush`. Throws on any malformation. */
export function openPush(sealed: Uint8Array, pushSecret: Uint8Array): PushPayload {
  const padded = hpkeOpen(pushSecret, INFO, EMPTY, sealed);
  if (padded.length !== PUSH_PAD_BYTES) throw new PushPayloadError("bad padded length");
  let i = padded.length - 1;
  while (i >= 0 && padded[i] === 0) i--;
  if (i < 0 || padded[i] !== 0x80) throw new PushPayloadError("bad padding");
  let v: unknown;
  try {
    v = parseJsonStrict(fromUtf8(padded.subarray(0, i)));
  } catch {
    throw new PushPayloadError("bad payload json");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new PushPayloadError("bad payload");
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "kind,subtitle,taskId,title,ts,v") throw new PushPayloadError("bad payload fields");
  if (o.v !== 1 || typeof o.taskId !== "string" || typeof o.kind !== "string" || typeof o.title !== "string" || typeof o.ts !== "number" || !(o.subtitle === null || typeof o.subtitle === "string")) {
    throw new PushPayloadError("bad payload types");
  }
  return { v: 1, taskId: o.taskId, kind: o.kind, title: o.title, subtitle: o.subtitle as string | null, ts: o.ts };
}

/** The constant size of every sealed push. */
export const SEALED_PUSH_BYTES = 32 + PUSH_PAD_BYTES + 16;

export { concat };

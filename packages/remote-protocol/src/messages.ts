/**
 * Every message a phone and the core exchange inside a Noise session, as ONE declarative spec per message. The spec drives:
 *   - the strict parser (`parseMessage`): the exact key set, exact types and lengths; an unknown field, a missing field or a
 *     wrong type is refused (invariant 13, "parse strictly, fail closed");
 *   - the JSON Schema (`schemaFor`, written to `schemas/messages/` by `scripts/gen-schemas.ts`), with `additionalProperties:false`;
 *   - the vectors (`vectors/agetor-messages.json`), which validate against both.
 * The Swift and Kotlin apps generate their models from the schemas and pass the same vectors.
 *
 * Envelope types are the message names below. Directions: `phone` messages the core receives (parsed with the strictest limits),
 * `core` messages a phone receives.
 */
import { fromUtf8, isHex } from "./bytes.ts";
import { canonicalBytes, parseJsonStrict, type Json } from "./canonical-json.ts";
import { DEVICE_NAME_MAX } from "./constants.ts";
import { REMOTE_LEVELS } from "./levels.ts";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

// ── The spec language ──────────────────────────────────────────────────────────────────────────────────────────────────

export type Spec =
  | { t: "str"; min?: number; max: number; pattern?: RegExp; patternHint?: string }
  | { t: "lit"; value: string | number | boolean }
  | { t: "int"; min: number; max: number }
  | { t: "bool" }
  | { t: "hex"; bytes: number }
  | { t: "b64"; maxBytes: number }
  | { t: "enum"; values: readonly string[] }
  | { t: "nullable"; of: Spec }
  | { t: "array"; of: Spec; max: number }
  | { t: "object"; fields: { [k: string]: Spec }; optional?: readonly string[] }
  | { t: "union"; tag: string; variants: { [k: string]: Spec & { t: "object" } } }
  | { t: "json"; maxChars: number };

const ID_RE = /^[A-Za-z0-9._:~-]+$/;
const id = (max = 128): Spec => ({ t: "str", min: 1, max, pattern: ID_RE, patternHint: "letters, digits and ._:~-" });
const hex = (bytes: number): Spec => ({ t: "hex", bytes });
const int = (min: number, max: number): Spec => ({ t: "int", min, max });
const str = (max: number, min = 0): Spec => ({ t: "str", min, max });
const nullable = (of: Spec): Spec => ({ t: "nullable", of });
const obj = (fields: { [k: string]: Spec }, optional: readonly string[] = []): Spec & { t: "object" } => ({ t: "object", fields, optional });
const levelEnum: Spec = { t: "enum", values: REMOTE_LEVELS };

const MS = int(0, 253402300799999);
const CHALLENGE = hex(16);
const SESSION_HASH = hex(32);
const SIG = hex(64);
const P256_PUB = hex(65);
const X25519_PUB = hex(32);
const DEVICE_ID = hex(16);
const CONTENT_HASH: Spec = { t: "str", min: 71, max: 71, pattern: /^sha256:[0-9a-f]{64}$/, patternHint: "sha256: and 64 lowercase hex digits" };

/** What a phone names when it asks for a challenge. The core builds the exact bytes to show from its own state. */
const TARGET: Spec = {
  t: "union",
  tag: "kind",
  variants: {
    plan: obj({ kind: { t: "lit", value: "plan" }, taskId: id(), planId: id() }),
    "plan-edit": obj({ kind: { t: "lit", value: "plan-edit" }, taskId: id(), planId: id(), body: str(262144) }),
    "claude-plan": obj({ kind: { t: "lit", value: "claude-plan" }, taskId: id(), promptId: id(), row: { t: "enum", values: ["auto", "manual"] } }),
    "tmux-card": obj({ kind: { t: "lit", value: "tmux-card" }, taskId: id(), promptId: id() }),
    "fx-permission": obj({ kind: { t: "lit", value: "fx-permission" }, taskId: id(), permissionId: id() }),
    gate: obj({ kind: { t: "lit", value: "gate" }, taskId: id(), stepId: id(), seq: int(0, 2 ** 31) }),
    "fx-resume": obj({ kind: { t: "lit", value: "fx-resume" }, taskId: id() }),
    terminal: obj({ kind: { t: "lit", value: "terminal" }, taskId: id(), tmuxSession: id(64) }),
  },
};

export const DECISIONS = ["approve", "allow-once", "accept", "return", "resume", "attach", "edit"] as const;

/** The signed decision (spec "Signed decisions"): the exact payload the approve key signed, plus the signature. */
export const DECISION_PAYLOAD: Spec = obj({
  v: { t: "lit", value: 1 },
  kind: { t: "lit", value: "decision" },
  deviceId: DEVICE_ID,
  sessionHash: SESSION_HASH,
  challenge: CHALLENGE,
  route: str(400, 3),
  target: TARGET,
  contentHash: CONTENT_HASH,
  decision: { t: "enum", values: DECISIONS },
  comment: nullable(str(4000)),
  ts: MS,
});
const SIGNED_DECISION: Spec = obj({ payload: DECISION_PAYLOAD, sig: SIG });

export const UNLOCK_PAYLOAD: Spec = obj({ kind: { t: "lit", value: "unlock" }, sessionHash: SESSION_HASH, expiresAt: MS });
export const TERMINAL_ATTACH_PAYLOAD: Spec = obj({
  v: { t: "lit", value: 1 },
  kind: { t: "lit", value: "terminal-attach" },
  deviceId: DEVICE_ID,
  sessionHash: SESSION_HASH,
  challenge: CHALLENGE,
  taskId: id(),
  tmuxSession: id(64),
  contentHash: CONTENT_HASH,
  ts: MS,
});

const REMOTE_POLICY_ENTRY: Spec = obj({
  method: { t: "enum", values: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
  route: str(200, 1),
  level: levelEnum,
  stepUp: { t: "enum", values: ["none", "unlock", "signed"] },
  rate: { t: "enum", values: ["normal", "heavy", "stop"] },
});

// `id` and `subagentId` are absent on a live-only frame (a subagent chunk the core has not persisted yet).
const RUN_EVENT: Spec = obj(
  {
    id: int(0, 2 ** 53 - 1),
    runId: id(),
    taskId: id(),
    stream: str(32, 1),
    data: { t: "str", max: 67108864 },
    ts: MS,
    subagentId: nullable(id()),
  },
  ["id", "subagentId"],
);

const REPLAY_META: Spec = obj(
  { earliestId: nullable(int(0, 2 ** 53 - 1)), hasMore: { t: "bool" }, resumedAfter: int(0, 2 ** 53 - 1), snapshotRequired: { t: "lit", value: true } },
  ["resumedAfter", "snapshotRequired"],
);

/** `both`: a control message either side may send (the in-band rekey marker). */
export type Direction = "phone" | "core" | "both";

export const MESSAGES = {
  // ── phone → core ───────────────────────────────────────────────────────────────────────────────────────────────────
  binding: { dir: "phone", spec: obj({ deviceId: DEVICE_ID, sig: SIG }) },
  "pairing-request": {
    dir: "phone",
    spec: obj({
      name: str(400, 1),
      platform: { t: "enum", values: ["ios", "android"] },
      appVersion: str(64, 1),
      sessionPub: P256_PUB,
      approvePub: P256_PUB,
      pushPub: X25519_PUB,
      sessionSig: SIG,
      approveSig: SIG,
    }),
  },
  request: {
    dir: "phone",
    spec: obj({
      id: id(64),
      method: { t: "enum", values: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      path: { t: "str", min: 1, max: 2000, pattern: /^\/[^\s?#]*$/, patternHint: "an absolute path with no query or fragment" },
      query: nullable({ t: "str", max: 4000, pattern: /^[^\s#]*$/ }),
      body: nullable({ t: "json", maxChars: 1048576 }),
      idem: nullable(hex(16)),
      decision: nullable(SIGNED_DECISION),
    }),
  },
  "subscribe-task": { dir: "phone", spec: obj({ sub: id(64), taskId: id(), afterId: nullable(int(0, 2 ** 53 - 1)), maxBytes: nullable(int(1, 67108864)) }) },
  "subscribe-global": { dir: "phone", spec: obj({ sub: id(64) }) },
  unsubscribe: { dir: "phone", spec: obj({ sub: id(64) }) },
  /** Sent under the old key; after it, the sender rekeys its send cipher and the receiver its receive cipher. */
  rekey: { dir: "both", spec: obj({}) },
  challenge: { dir: "phone", spec: obj({ id: id(64), target: TARGET }) },
  unlock: { dir: "phone", spec: obj({ id: id(64), payload: UNLOCK_PAYLOAD, sig: SIG }) },
  "push-register": { dir: "phone", spec: obj({ id: id(64), pushRef: str(512, 1), sendKey: hex(32) }) },
  "revoke-self": { dir: "phone", spec: obj({ id: id(64) }) },
  "terminal-attach": {
    dir: "phone",
    spec: obj({ id: id(64), taskId: id(), cols: int(10, 500), rows: int(2, 300), payload: TERMINAL_ATTACH_PAYLOAD, sig: SIG }),
  },
  "terminal-input": { dir: "phone", spec: obj({ taskId: id(), data: { t: "b64", maxBytes: 16384 } }) },
  "terminal-resize": { dir: "phone", spec: obj({ taskId: id(), cols: int(10, 500), rows: int(2, 300) }) },
  "terminal-detach": { dir: "phone", spec: obj({ taskId: id() }) },

  // ── core → phone ───────────────────────────────────────────────────────────────────────────────────────────────────
  "pairing-result": { dir: "core", spec: obj({ deviceId: DEVICE_ID, linkSecret: hex(32), level: levelEnum }) },
  hello: {
    dir: "core",
    spec: obj({
      protocolVersion: int(1, 1000),
      minProtocolVersion: int(1, 1000),
      deviceId: DEVICE_ID,
      level: levelEnum,
      routes: { t: "array", of: REMOTE_POLICY_ENTRY, max: 200 },
      auditHead: nullable(obj({ seq: int(0, 2 ** 53 - 1), hash: hex(32) })),
      clock: MS,
      macName: str(DEVICE_NAME_MAX, 1),
    }),
  },
  response: {
    dir: "core",
    spec: obj({
      id: id(64),
      status: int(100, 599),
      contentType: str(128),
      encoding: { t: "enum", values: ["utf8", "base64"] },
      body: { t: "str", max: 89478485 },
    }),
  },
  "task-meta": { dir: "core", spec: obj({ sub: id(64), taskId: id(), meta: REPLAY_META }) },
  "task-event": {
    dir: "core",
    spec: obj(
      { sub: id(64), event: RUN_EVENT, parsed: { t: "json", maxChars: 1048576 }, truncated: obj({ eventId: int(0, 2 ** 53 - 1), fullBytes: int(0, 2 ** 53 - 1) }) },
      ["parsed", "truncated"],
    ),
  },
  "global-event": { dir: "core", spec: obj({ sub: id(64), event: { t: "json", maxChars: 1048576 } }) },
  "snapshot-required": { dir: "core", spec: obj({ sub: id(64), reason: { t: "enum", values: ["backpressure", "gap", "restart"] } }) },
  "challenge-issued": {
    dir: "core",
    spec: obj({ id: id(64), challenge: CHALLENGE, contentBytes: { t: "b64", maxBytes: 1048576 }, contentHash: CONTENT_HASH, expiresAt: MS }),
  },
  "unlock-ok": { dir: "core", spec: obj({ id: id(64), expiresAt: MS }) },
  ok: { dir: "core", spec: obj({ id: id(64) }) },
  error: { dir: "core", spec: obj({ id: nullable(id(64)), code: { t: "str", min: 1, max: 64, pattern: /^[a-z0-9-]+$/ }, message: str(400) }) },
  "terminal-attached": { dir: "core", spec: obj({ id: id(64), taskId: id() }) },
  "terminal-output": { dir: "core", spec: obj({ taskId: id(), data: { t: "b64", maxBytes: 65536 } }) },
  "terminal-closed": { dir: "core", spec: obj({ taskId: id(), reason: str(64, 1) }) },
} as const satisfies Record<string, { dir: Direction; spec: Spec }>;

export type MessageType = keyof typeof MESSAGES;

export function isMessageType(t: string): t is MessageType {
  return Object.prototype.hasOwnProperty.call(MESSAGES, t);
}

// ── The strict parser ──────────────────────────────────────────────────────────────────────────────────────────────────

const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isPlain(v: unknown): v is { [k: string]: unknown } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function check(spec: Spec, v: unknown, path: string): unknown {
  const fail = (m: string): never => {
    throw new ParseError(`${path || "message"}: ${m}`);
  };
  switch (spec.t) {
    case "str": {
      if (typeof v !== "string") return fail("expected a string");
      if (v.length > spec.max) return fail("too long");
      if ((spec.min ?? 0) > v.length) return fail("too short");
      if (spec.pattern && !spec.pattern.test(v)) return fail("bad format");
      return v;
    }
    case "lit":
      return v === spec.value ? v : fail(`must be ${JSON.stringify(spec.value)}`);
    case "int":
      if (typeof v !== "number" || !Number.isSafeInteger(v)) return fail("expected an integer");
      if (v < spec.min || v > spec.max) return fail("out of range");
      return v;
    case "bool":
      return typeof v === "boolean" ? v : fail("expected a boolean");
    case "hex":
      return isHex(v, spec.bytes) ? v : fail(`expected ${spec.bytes} bytes of lowercase hex`);
    case "b64":
      if (typeof v !== "string" || !B64_RE.test(v)) return fail("expected base64");
      if ((v.length / 4) * 3 > spec.maxBytes + 2) return fail("too long");
      return v;
    case "enum":
      return typeof v === "string" && spec.values.includes(v) ? v : fail(`expected one of ${spec.values.join(", ")}`);
    case "nullable":
      return v === null ? null : check(spec.of, v, path);
    case "array": {
      if (!Array.isArray(v)) return fail("expected an array");
      if (v.length > spec.max) return fail("too many items");
      return v.map((x, i) => check(spec.of, x, `${path}[${i}]`));
    }
    case "object": {
      if (!isPlain(v)) return fail("expected an object");
      const out: { [k: string]: unknown } = {};
      const optional = new Set(spec.optional ?? []);
      for (const k of Object.keys(v)) if (!Object.prototype.hasOwnProperty.call(spec.fields, k)) return fail(`unknown field ${JSON.stringify(k)}`);
      for (const [k, s] of Object.entries(spec.fields)) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) {
          if (optional.has(k)) continue;
          return fail(`missing field ${JSON.stringify(k)}`);
        }
        out[k] = check(s, v[k], path ? `${path}.${k}` : k);
      }
      return out;
    }
    case "union": {
      if (!isPlain(v)) return fail("expected an object");
      const tag = v[spec.tag];
      if (typeof tag !== "string" || !Object.prototype.hasOwnProperty.call(spec.variants, tag)) return fail(`unknown ${spec.tag}`);
      return check(spec.variants[tag]!, v, path);
    }
    case "json": {
      // Already parsed by the strict JSON parser (no duplicate keys, finite numbers); here only bound its size.
      let size = 0;
      try {
        size = JSON.stringify(v).length;
      } catch {
        return fail("not JSON");
      }
      return size <= spec.maxChars ? v : fail("too large");
    }
  }
}

/** Parse and validate an already-decoded value against a spec. */
export function parseValue<T>(spec: Spec, value: unknown): T {
  return check(spec, value, "") as T;
}

/** Parse a message body (the canonical JSON bytes of an envelope chunk set) for a message type, strictly. */
export function parseMessage<T = unknown>(type: string, body: Uint8Array | string): T {
  if (!isMessageType(type)) throw new ParseError(`unknown message type ${JSON.stringify(type.slice(0, 64))}`);
  let value: Json;
  try {
    value = parseJsonStrict(typeof body === "string" ? body : fromUtf8(body));
  } catch {
    throw new ParseError("not valid JSON");
  }
  return parseValue<T>(MESSAGES[type].spec, value);
}

/** Validate then serialize a message the core sends, so a malformed message can never leave the core. */
export function encodeMessage(type: MessageType, value: unknown): Uint8Array {
  parseValue(MESSAGES[type].spec, value);
  return canonicalBytes(value);
}

// ── JSON Schema ────────────────────────────────────────────────────────────────────────────────────────────────────────

type Schema = { [k: string]: unknown };

export function schemaOf(spec: Spec): Schema {
  switch (spec.t) {
    case "str": {
      const s: Schema = { type: "string", maxLength: spec.max };
      if (spec.min) s.minLength = spec.min;
      if (spec.pattern) s.pattern = spec.pattern.source;
      return s;
    }
    case "lit":
      return { const: spec.value };
    case "int":
      return { type: "integer", minimum: spec.min, maximum: spec.max };
    case "bool":
      return { type: "boolean" };
    case "hex":
      return { type: "string", pattern: `^[0-9a-f]{${spec.bytes * 2}}$` };
    case "b64":
      return { type: "string", contentEncoding: "base64", pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$", maxLength: Math.ceil((spec.maxBytes / 3) * 4) + 4 };
    case "enum":
      return { type: "string", enum: [...spec.values] };
    case "nullable":
      return { anyOf: [schemaOf(spec.of), { type: "null" }] };
    case "array":
      return { type: "array", items: schemaOf(spec.of), maxItems: spec.max };
    case "object": {
      const optional = new Set(spec.optional ?? []);
      return {
        type: "object",
        properties: Object.fromEntries(Object.entries(spec.fields).map(([k, s]) => [k, schemaOf(s)])),
        required: Object.keys(spec.fields).filter((k) => !optional.has(k)),
        additionalProperties: false,
      };
    }
    case "union":
      return { oneOf: Object.values(spec.variants).map(schemaOf) };
    case "json":
      return { description: `any JSON value, at most ${spec.maxChars} characters when serialized` };
  }
}

export function schemaFor(type: MessageType): Schema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://agetor.dev/schemas/remote/messages/${type}.json`,
    title: type,
    "x-direction": MESSAGES[type].dir,
    ...schemaOf(MESSAGES[type].spec),
  };
}

// ── Device names ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Clean a name the phone supplied before it is shown or stored: strip control, bidirectional-override, zero-width and
 * other invisible characters, collapse whitespace, and cap at 40 characters (code points). The key helper window,
 * Settings, the CLI and the audit log only ever see the cleaned form.
 */
export function cleanDeviceName(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const c = ch.codePointAt(0)!;
    const control = c < 0x20 || (c >= 0x7f && c <= 0x9f);
    const invisible =
      (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2064) ||
      (c >= 0x2066 && c <= 0x2069) || c === 0xfeff || c === 0x00ad || c === 0x061c || c === 0x180e ||
      (c >= 0xe0000 && c <= 0xe007f) || (c >= 0xfff0 && c <= 0xfffb) || (c >= 0xfe00 && c <= 0xfe0f);
    if (!control && !invisible) out += ch;
  }
  out = out.replace(/\s+/g, " ").trim();
  return Array.from(out).slice(0, DEVICE_NAME_MAX).join("").trim();
}

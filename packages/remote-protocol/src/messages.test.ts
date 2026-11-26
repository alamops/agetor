import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { resolve } from "node:path";
import { toHex, utf8 } from "./bytes.ts";
import { MESSAGES, ParseError, cleanDeviceName, encodeMessage, parseMessage, schemaFor, type MessageType } from "./messages.ts";
import vectors from "../vectors/agetor-messages.json";

const h = (bytes: number, fill = "ab") => fill.repeat(bytes);
const DEVICE = h(16);
const HASH = `sha256:${h(32, "cd")}`;
const TARGET_PLAN = { kind: "plan", taskId: "t1", planId: "p2" };
const DECISION_PAYLOAD = {
  v: 1, kind: "decision", deviceId: DEVICE, sessionHash: h(32, "01"), challenge: h(16, "02"),
  route: "POST /tasks/t1/plans/p2/approve", target: TARGET_PLAN, contentHash: HASH, decision: "approve", comment: null, ts: 1795560000000,
};
const RUN_EVENT = { id: 12, runId: "r1", taskId: "t1", stream: "assistant", data: "hello", ts: 1795560000000, subagentId: null };

/** One valid example per message type. The checked-in vectors are exactly these. */
export const EXAMPLES: Record<MessageType, unknown> = {
  binding: { deviceId: DEVICE, sig: h(64, "ef") },
  "pairing-request": { name: "Ana's iPhone", platform: "ios", appVersion: "1.0.0", sessionPub: `04${h(64)}`, approvePub: `04${h(64, "cd")}`, pushPub: h(32, "ef"), sessionSig: h(64, "11"), approveSig: h(64, "22") },
  request: { id: "r-1", method: "POST", path: "/runs/r1/input", query: null, body: { text: "continue" }, idem: h(16, "9a"), decision: null },
  "subscribe-task": { sub: "s1", taskId: "t1", afterId: 40, maxBytes: 262144 },
  "subscribe-global": { sub: "g1" },
  unsubscribe: { sub: "s1" },
  rekey: {},
  challenge: { id: "c-1", target: TARGET_PLAN },
  unlock: { id: "u-1", payload: { kind: "unlock", sessionHash: h(32, "01"), expiresAt: 1795560600000 }, sig: h(64, "33") },
  "push-register": { id: "p-1", pushRef: "opaque-ref", sendKey: h(32, "44") },
  "revoke-self": { id: "x-1" },
  "terminal-attach": {
    id: "a-1", taskId: "t1", cols: 80, rows: 24,
    payload: { v: 1, kind: "terminal-attach", deviceId: DEVICE, sessionHash: h(32, "01"), challenge: h(16, "02"), taskId: "t1", tmuxSession: "agetor-0123456789ab", contentHash: HASH, ts: 1795560000000 },
    sig: h(64, "55"),
  },
  "terminal-input": { taskId: "t1", data: "bHMK" },
  "terminal-resize": { taskId: "t1", cols: 100, rows: 30 },
  "terminal-detach": { taskId: "t1" },
  "pairing-result": { deviceId: DEVICE, linkSecret: h(32, "66"), level: "respond" },
  hello: {
    protocolVersion: 1, minProtocolVersion: 1, deviceId: DEVICE, level: "respond",
    routes: [{ method: "GET", route: "/tasks", level: "observe", stepUp: "none", rate: "normal" }],
    auditHead: { seq: 7, hash: h(32, "77") }, clock: 1795560000000, macName: "Ana's MacBook",
  },
  response: { id: "r-1", status: 200, contentType: "application/json", encoding: "utf8", body: "{}" },
  "task-meta": { sub: "s1", taskId: "t1", meta: { earliestId: 3, hasMore: true } },
  "task-event": { sub: "s1", event: RUN_EVENT, parsed: { kind: "text" }, truncated: { eventId: 12, fullBytes: 20000 } },
  "global-event": { sub: "g1", event: { kind: "tasks-changed" } },
  "snapshot-required": { sub: "s1", reason: "backpressure" },
  "challenge-issued": { id: "c-1", challenge: h(16, "02"), contentBytes: "eyJhIjoxfQ==", contentHash: HASH, expiresAt: 1795560120000 },
  "unlock-ok": { id: "u-1", expiresAt: 1795560600000 },
  ok: { id: "x-1" },
  error: { id: null, code: "level", message: "this device's level is too low" },
  "terminal-attached": { id: "a-1", taskId: "t1" },
  "terminal-output": { taskId: "t1", data: "aGk=" },
  "terminal-closed": { taskId: "t1", reason: "peer-left" },
};

/** A value that must be refused for a message type, with the reason. */
export const INVALID: Array<{ type: MessageType; why: string; value: unknown }> = [
  { type: "binding", why: "unknown field", value: { ...(EXAMPLES.binding as object), extra: 1 } },
  { type: "binding", why: "missing field", value: { deviceId: DEVICE } },
  { type: "binding", why: "uppercase hex", value: { deviceId: DEVICE.toUpperCase(), sig: h(64) } },
  { type: "binding", why: "short signature", value: { deviceId: DEVICE, sig: h(63) } },
  { type: "request", why: "a path with a query string", value: { ...(EXAMPLES.request as object), path: "/tasks?x=1" } },
  { type: "request", why: "a relative path", value: { ...(EXAMPLES.request as object), path: "tasks" } },
  { type: "request", why: "an unknown method", value: { ...(EXAMPLES.request as object), method: "TRACE" } },
  { type: "request", why: "an idem key of the wrong size", value: { ...(EXAMPLES.request as object), idem: h(8) } },
  { type: "request", why: "a decision with an unknown field", value: { ...(EXAMPLES.request as object), decision: { payload: DECISION_PAYLOAD, sig: h(64), extra: true } } },
  { type: "request", why: "a decision whose target is unknown", value: { ...(EXAMPLES.request as object), decision: { payload: { ...DECISION_PAYLOAD, target: { kind: "nope", taskId: "t" } }, sig: h(64) } } },
  { type: "pairing-request", why: "an unknown platform", value: { ...(EXAMPLES["pairing-request"] as object), platform: "windows" } },
  { type: "pairing-request", why: "a compressed P-256 key", value: { ...(EXAMPLES["pairing-request"] as object), sessionPub: h(33) } },
  { type: "subscribe-task", why: "a negative cursor", value: { ...(EXAMPLES["subscribe-task"] as object), afterId: -1 } },
  { type: "subscribe-task", why: "a task id with a slash", value: { ...(EXAMPLES["subscribe-task"] as object), taskId: "a/b" } },
  { type: "challenge", why: "a plan-edit target with no body", value: { id: "c", target: { kind: "plan-edit", taskId: "t", planId: "p" } } },
  { type: "unlock", why: "a payload of another kind", value: { id: "u", payload: { kind: "decision" }, sig: h(64) } },
  { type: "terminal-input", why: "input that is not base64", value: { taskId: "t", data: "not base64!" } },
  { type: "terminal-input", why: "oversize input", value: { taskId: "t", data: "A".repeat(30000) } },
  { type: "terminal-resize", why: "a zero-width terminal", value: { taskId: "t", cols: 0, rows: 24 } },
  { type: "hello", why: "a level outside the vocabulary", value: { ...(EXAMPLES.hello as object), level: "full" } },
  { type: "hello", why: "a Mac name over 40 characters", value: { ...(EXAMPLES.hello as object), macName: "m".repeat(41) } },
  { type: "response", why: "a status outside HTTP", value: { ...(EXAMPLES.response as object), status: 99 } },
  { type: "error", why: "a code with uppercase", value: { id: null, code: "Level", message: "x" } },
];

if (process.env.UPDATE_VECTORS === "1") {
  await Bun.write(
    resolve(import.meta.dir, "../vectors/agetor-messages.json"),
    JSON.stringify(
      {
        source: "Agetor session messages: one valid example per type, and values every strict parser must refuse",
        messages: Object.fromEntries(Object.entries(EXAMPLES).map(([t, v]) => [t, { direction: MESSAGES[t as MessageType].dir, value: v }])),
        invalid: INVALID.map((i) => ({ type: i.type, why: i.why, value: i.value })),
      },
      null,
      2,
    ) + "\n",
  );
}

const ajv = new Ajv2020({ strict: false, allErrors: false });
const validators = new Map<MessageType, ValidateFunction<unknown>>();
/** Compile each schema once (its $id may be registered only once per Ajv instance). */
function schemaAccepts(type: MessageType, value: unknown): boolean {
  let v = validators.get(type);
  if (!v) validators.set(type, (v = ajv.compile<unknown>(schemaFor(type))));
  return (v as unknown as (d: unknown) => boolean)(value);
}

describe("strict message parsers", () => {
  test("every message type has an example, and every example parses to itself", () => {
    expect(Object.keys(EXAMPLES).sort()).toEqual(Object.keys(MESSAGES).sort());
    for (const [type, value] of Object.entries(EXAMPLES)) {
      expect(parseMessage<unknown>(type, JSON.stringify(value))).toEqual(value as never);
    }
  });

  test("every invalid case is refused with a ParseError", () => {
    for (const bad of INVALID) {
      expect(() => parseMessage(bad.type, JSON.stringify(bad.value)), `${bad.type}: ${bad.why}`).toThrow(ParseError);
    }
  });

  test("an unknown message type, bad JSON and a duplicate key are refused", () => {
    expect(() => parseMessage("nope", "{}")).toThrow(ParseError);
    expect(() => parseMessage("ok", "not json")).toThrow(ParseError);
    expect(() => parseMessage("ok", '{"id":"a","id":"b"}')).toThrow(ParseError);
    expect(() => parseMessage("ok", "[]")).toThrow(ParseError);
    expect(() => parseMessage("ok", "null")).toThrow(ParseError);
  });

  test("optional fields may be absent, and only those", () => {
    const { truncated, parsed, ...bare } = EXAMPLES["task-event"] as Record<string, unknown>;
    expect(truncated).toBeDefined();
    expect(parsed).toBeDefined();
    expect(() => parseMessage("task-event", JSON.stringify(bare))).not.toThrow();
    const { sub, ...noSub } = bare;
    expect(sub).toBe("s1");
    expect(() => parseMessage("task-event", JSON.stringify(noSub))).toThrow(ParseError);
  });

  test("fuzz: random JSON never throws anything but ParseError, for every message", () => {
    const rnd = (depth = 0): unknown => {
      const r = Math.random();
      if (depth > 3 || r < 0.35) return [null, true, false, 0, -1, 1.5, 2 ** 40, "", "a", "ab".repeat(40), "zz", "0".repeat(32)][Math.floor(Math.random() * 12)];
      if (r < 0.65) return Array.from({ length: Math.floor(Math.random() * 4) }, () => rnd(depth + 1));
      return Object.fromEntries(Array.from({ length: Math.floor(Math.random() * 5) }, () => [["id", "sub", "taskId", "kind", "sig", "data", "x"][Math.floor(Math.random() * 7)]!, rnd(depth + 1)]));
    };
    for (const type of Object.keys(MESSAGES)) {
      for (let i = 0; i < 300; i++) {
        const base = Math.random() < 0.5 ? structuredClone(EXAMPLES[type as MessageType]) : rnd();
        // mutate one field of a valid example half of the time
        if (base && typeof base === "object" && !Array.isArray(base) && Math.random() < 0.7) {
          const keys = Object.keys(base);
          if (keys.length) (base as Record<string, unknown>)[keys[Math.floor(Math.random() * keys.length)]!] = rnd();
        }
        try {
          parseMessage(type, JSON.stringify(base));
        } catch (e) {
          expect(e).toBeInstanceOf(ParseError);
        }
      }
    }
  });

  test("encodeMessage refuses a malformed value and returns canonical bytes for a good one", () => {
    expect(() => encodeMessage("ok", { id: "x", extra: 1 })).toThrow(ParseError);
    expect(new TextDecoder().decode(encodeMessage("ok", { id: "x" }))).toBe('{"id":"x"}');
  });
});

describe("JSON Schemas agree with the parsers", () => {
  test("every example validates against its schema and every invalid case does not", () => {
    for (const type of Object.keys(MESSAGES) as MessageType[]) {
      expect(schemaAccepts(type, EXAMPLES[type]), `${type} example`).toBe(true);
    }
    for (const bad of INVALID) {
      expect(schemaAccepts(bad.type, bad.value), `${bad.type}: ${bad.why}`).toBe(false);
    }
  });
});

describe("checked-in vectors", () => {
  test("the file is current (UPDATE_VECTORS=1 rewrites it after an intended change)", () => {
    const fresh = JSON.parse(JSON.stringify({
      messages: Object.fromEntries(Object.entries(EXAMPLES).map(([t, v]) => [t, { direction: MESSAGES[t as MessageType].dir, value: v }])),
      invalid: INVALID,
    }));
    expect(vectors.messages).toEqual(fresh.messages);
    expect(vectors.invalid).toEqual(fresh.invalid);
  });
  test("each vector parses (or is refused) under the parser and the schema", () => {
    for (const [type, entry] of Object.entries(vectors.messages)) {
      const value = (entry as { value: unknown }).value;
      expect(parseMessage<unknown>(type, JSON.stringify(value))).toEqual(value as never);
      expect(schemaAccepts(type as MessageType, value)).toBe(true);
    }
  });
});

describe("cleanDeviceName", () => {
  test("strips control, bidi, zero-width and tag characters", () => {
    expect(cleanDeviceName("Ana‮s iPhone\u0000")).toBe("Anas iPhone");
    expect(cleanDeviceName("A​n‏a﻿")).toBe("Ana");
    expect(cleanDeviceName("A\u{E0041}na")).toBe("Ana");
    expect(cleanDeviceName("  a \t\n b  ")).toBe("a b");
  });
  test("caps at 40 characters by code point, never splitting an emoji", () => {
    const long = cleanDeviceName("😀".repeat(60));
    expect(Array.from(long).length).toBe(40);
    expect(cleanDeviceName("x".repeat(100)).length).toBe(40);
  });
  test("an all-invisible name cleans to empty", () => {
    expect(cleanDeviceName("​‮\u0007")).toBe("");
    expect(toHex(utf8("a")).length).toBe(2);
  });
});

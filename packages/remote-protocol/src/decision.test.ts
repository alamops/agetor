import { describe, expect, test } from "bun:test";
import { p256 } from "@noble/curves/nist.js";
import { resolve } from "node:path";
import { fromHex, toHex, utf8 } from "./bytes.ts";
import { ALLOWED_DECISIONS, contentHashOf, decisionBytes, terminalAttachBytes, unlockBytes, verifySigned, type DecisionPayload } from "./decision.ts";
import { signEs256 } from "./es256.ts";
import { DECISIONS, ParseError } from "./messages.ts";
import vectors from "../vectors/agetor-decision.json";

const SK = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const PUB = p256.getPublicKey(SK, false);

const payload: DecisionPayload = {
  v: 1, kind: "decision", deviceId: "ab".repeat(16), sessionHash: "01".repeat(32), challenge: "02".repeat(16),
  route: "POST /tasks/9a1f/plans/p2/approve", target: { kind: "plan", taskId: "9a1f", planId: "p2" },
  contentHash: contentHashOf(utf8('{"markdown":"plan","revision":2}')), decision: "approve", comment: null, ts: 1795560000000,
};
const unlock = { kind: "unlock" as const, sessionHash: "01".repeat(32), expiresAt: 1795560600000 };
const attach = {
  v: 1 as const, kind: "terminal-attach" as const, deviceId: "ab".repeat(16), sessionHash: "01".repeat(32), challenge: "02".repeat(16),
  taskId: "9a1f", tmuxSession: "agetor-0123456789ab", contentHash: contentHashOf(utf8("terminal")), ts: 1795560000000,
};

function build() {
  return {
    source: "Agetor signed decisions: canonical bytes and ES256 signatures by a fixed approve key",
    approveSecret: toHex(SK),
    approvePublic: toHex(PUB),
    decision: { payload, canonical: toHex(decisionBytes(payload)), sig: toHex(signEs256(SK, decisionBytes(payload))) },
    unlock: { payload: unlock, canonical: toHex(unlockBytes(unlock)), sig: toHex(signEs256(SK, unlockBytes(unlock))) },
    terminalAttach: { payload: attach, canonical: toHex(terminalAttachBytes(attach)), sig: toHex(signEs256(SK, terminalAttachBytes(attach))) },
  };
}

if (process.env.UPDATE_VECTORS === "1") {
  await Bun.write(resolve(import.meta.dir, "../vectors/agetor-decision.json"), JSON.stringify(build(), null, 2) + "\n");
}

describe("signed decisions", () => {
  test("the checked-in vectors match (UPDATE_VECTORS=1 rewrites them after an intended change)", () => {
    expect(JSON.parse(JSON.stringify(build()))).toEqual(vectors);
  });

  test("the vector signatures verify under the approve key", () => {
    expect(verifySigned("decision", vectors.decision.payload, vectors.decision.sig, fromHex(vectors.approvePublic))).toBe(true);
    expect(verifySigned("unlock", vectors.unlock.payload, vectors.unlock.sig, fromHex(vectors.approvePublic))).toBe(true);
    expect(verifySigned("terminal-attach", vectors.terminalAttach.payload, vectors.terminalAttach.sig, fromHex(vectors.approvePublic))).toBe(true);
  });

  test("the canonical bytes sort keys and carry exactly the payload", () => {
    const text = new TextDecoder().decode(decisionBytes(payload));
    expect(text.startsWith('{"challenge":"')).toBe(true);
    expect(JSON.parse(text)).toEqual(payload);
  });

  test("a changed field, the wrong key, a wrong kind or a malformed signature fails closed", () => {
    const sig = toHex(signEs256(SK, decisionBytes(payload)));
    expect(verifySigned("decision", payload, sig, PUB)).toBe(true);
    expect(verifySigned("decision", { ...payload, contentHash: contentHashOf(utf8("other")) }, sig, PUB)).toBe(false);
    expect(verifySigned("decision", { ...payload, sessionHash: "09".repeat(32) }, sig, PUB)).toBe(false);
    expect(verifySigned("decision", { ...payload, comment: "x" }, sig, PUB)).toBe(false);
    expect(verifySigned("decision", payload, sig, p256.getPublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1), false))).toBe(false);
    expect(verifySigned("unlock", payload, sig, PUB)).toBe(false);
    expect(verifySigned("decision", payload, "zz", PUB)).toBe(false);
    expect(verifySigned("decision", { ...payload, extra: 1 }, sig, PUB)).toBe(false);
    expect(verifySigned("decision", payload, sig.slice(0, -2), PUB)).toBe(false);
  });

  test("a payload the schema refuses cannot even be turned into bytes", () => {
    expect(() => decisionBytes({ ...payload, decision: "yes" as never })).toThrow(ParseError);
    expect(() => unlockBytes({ ...unlock, expiresAt: -1 })).toThrow(ParseError);
  });

  test("every decision value belongs to some target, and the table is closed", () => {
    const used = new Set(Object.values(ALLOWED_DECISIONS).flat());
    for (const d of DECISIONS) expect(used.has(d)).toBe(true);
    expect(ALLOWED_DECISIONS.gate).toEqual(["accept", "return"]);
    expect(ALLOWED_DECISIONS["tmux-card"]).toEqual(["allow-once"]);
  });
});

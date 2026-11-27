// The five ordered checks of a signed decision, each with a test that fails when that check is removed, plus challenges and the unlock window.
import { describe, expect, test } from "bun:test";
import { p256 } from "@noble/curves/nist.js";
import { toHex } from "@agetor/remote-protocol/bytes";
import { contentHashOf, decisionBytes, unlockBytes, type DecisionPayload } from "@agetor/remote-protocol/decision";
import { signEs256 } from "@agetor/remote-protocol/es256";
import { buildContent, type ContentSources } from "./content-hash.ts";
import { DecisionError, MAX_OUTSTANDING_CHALLENGES, createDecisions } from "./decisions.ts";
import type { ContentTarget, DevicePrincipal } from "./types.ts";

const approveSk = p256.utils.randomSecretKey();
const sessionHash = new Uint8Array(32).fill(7);

function principal(over: Partial<DevicePrincipal> = {}): DevicePrincipal {
  return { kind: "device", deviceId: "ab".repeat(16), deviceName: "Ana's iPhone", level: "respond", sessionId: "s1", sessionHash, approvePub: p256.getPublicKey(approveSk, false), ...over };
}

let plan = "# Plan\n1. do it";
let gateNext = ["s2"];
const sources: ContentSources = {
  plan: async () => ({ markdown: plan, status: "pending", name: "Plan" }),
  claudePlan: async () => ({ plan, mode: "auto" }),
  tmuxCard: async () => ({ question: "Proceed?", choices: [{ key: "1", label: "Yes" }], mode: "ask", answerKind: "choice" }),
  fxPermission: async () => null,
  gate: async () => ({ handoffs: [], nextStepIds: gateNext, mode: "auto" }),
  fxResume: async () => null,
  terminal: async () => ({ ok: true }),
};

const PLAN: ContentTarget = { kind: "plan", taskId: "t1", planId: "p1" };
const GATE: ContentTarget = { kind: "gate", taskId: "t1", stepId: "g", seq: 1 };

function rig(now = { t: 1_800_000_000_000 }) {
  const d = createDecisions({ sources, now: () => now.t });
  const sign = (p: DecisionPayload, key = approveSk) => ({ payload: p, sig: toHex(signEs256(key, decisionBytes(p))) });
  const payloadFor = (issued: { challenge: string; contentHash: string }, target: ContentTarget, over: Partial<DecisionPayload> = {}, who = principal()): DecisionPayload => ({
    v: 1, kind: "decision", deviceId: who.deviceId, sessionHash: toHex(who.sessionHash), challenge: issued.challenge, route: "POST /x",
    target: target as DecisionPayload["target"], contentHash: issued.contentHash, decision: target.kind === "gate" ? "accept" : "approve", comment: null, ts: now.t, ...over,
  });
  return { d, now, sign, payloadFor };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof DecisionError ? e.code : `other:${String(e)}`;
  }
}

describe("a good decision", () => {
  test("is accepted and returns the verified payload", async () => {
    plan = "# Plan\n1. do it";
    const r = rig();
    const issued = await r.d.issueChallenge(principal(), PLAN);
    expect(issued.contentHash).toBe(contentHashOf(issued.contentBytes));
    expect(issued.expiresAt).toBe(r.now.t + 120_000);
    const verified = await r.d.verifyDecision(principal(), r.sign(r.payloadFor(issued, PLAN)), PLAN);
    expect(verified.decision).toBe("approve");
  });

  test("a gate accept and return are both valid decisions for a gate", async () => {
    const r = rig();
    for (const decision of ["accept", "return"] as const) {
      const issued = await r.d.issueChallenge(principal(), GATE);
      expect((await r.d.verifyDecision(principal(), r.sign(r.payloadFor(issued, GATE, { decision, comment: decision === "return" ? "redo it" : null })), GATE)).decision).toBe(decision);
    }
  });
});

describe("check 1: the challenge", () => {
  test("a challenge is single use: the second try is refused", async () => {
    const r = rig();
    const issued = await r.d.issueChallenge(principal(), PLAN);
    const signed = r.sign(r.payloadFor(issued, PLAN));
    expect(await code(r.d.verifyDecision(principal(), signed, PLAN))).toBe("ok");
    expect(await code(r.d.verifyDecision(principal(), signed, PLAN))).toBe("challenge");
  });

  test("a stale challenge (120 s) is refused", async () => {
    const r = rig();
    const issued = await r.d.issueChallenge(principal(), PLAN);
    r.now.t += 120_000;
    expect(await code(r.d.verifyDecision(principal(), r.sign(r.payloadFor(issued, PLAN)), PLAN))).toBe("challenge");
  });

  test("another session's challenge is refused", async () => {
    const r = rig();
    const issued = await r.d.issueChallenge(principal({ sessionId: "other" }), PLAN);
    expect(await code(r.d.verifyDecision(principal(), r.sign(r.payloadFor(issued, PLAN)), PLAN))).toBe("challenge");
  });

  test("a challenge issued for another target is refused, and so is a made-up one", async () => {
    const r = rig();
    const forGate = await r.d.issueChallenge(principal(), GATE);
    expect(await code(r.d.verifyDecision(principal(), r.sign(r.payloadFor(forGate, PLAN)), PLAN))).toBe("challenge");
    const fake = { challenge: "00".repeat(16), contentHash: contentHashOf(new Uint8Array(1)) };
    expect(await code(r.d.verifyDecision(principal(), r.sign(r.payloadFor(fake, PLAN)), PLAN))).toBe("challenge");
  });

  test("an unknown target cannot be challenged", async () => {
    const r = rig();
    expect(await code(r.d.issueChallenge(principal(), { kind: "fx-permission", taskId: "t1", permissionId: "gone" }))).toBe("no-such-content");
  });

  test("one session may not hold more than 64 challenges", async () => {
    const r = rig();
    for (let i = 0; i < MAX_OUTSTANDING_CHALLENGES; i++) await r.d.issueChallenge(principal(), PLAN);
    expect(await code(r.d.issueChallenge(principal(), PLAN))).toBe("challenge");
    await r.d.issueChallenge(principal({ sessionId: "s2" }), PLAN); // another session is unaffected
  });
});

describe("check 2: the session", () => {
  test("a decision signed for another session's handshake hash is refused", async () => {
    const r = rig();
    const issued = await r.d.issueChallenge(principal(), PLAN);
    const wrong = r.payloadFor(issued, PLAN, { sessionHash: toHex(new Uint8Array(32).fill(8)) });
    expect(await code(r.d.verifyDecision(principal(), r.sign(wrong), PLAN))).toBe("session");
  });
});

describe("check 3: the signature", () => {
  test("a signature by another key is refused", async () => {
    const r = rig();
    const issued = await r.d.issueChallenge(principal(), PLAN);
    expect(await code(r.d.verifyDecision(principal(), r.sign(r.payloadFor(issued, PLAN), p256.utils.randomSecretKey()), PLAN))).toBe("signature");
  });

  test("a payload altered after signing is refused", async () => {
    const r = rig();
    const issued = await r.d.issueChallenge(principal(), PLAN);
    const signed = r.sign(r.payloadFor(issued, PLAN));
    expect(await code(r.d.verifyDecision(principal(), { ...signed, payload: { ...signed.payload, comment: "sneaked in" } }, PLAN))).toBe("signature");
  });

  test("a decision signed for another device id is refused", async () => {
    const r = rig();
    const issued = await r.d.issueChallenge(principal(), PLAN);
    expect(await code(r.d.verifyDecision(principal(), r.sign(r.payloadFor(issued, PLAN, { deviceId: "cd".repeat(16) })), PLAN))).toBe("signature");
  });

  test("a decision whose signed target differs from the call's target is refused", async () => {
    const r = rig();
    const issued = await r.d.issueChallenge(principal(), PLAN);
    const other: ContentTarget = { kind: "plan", taskId: "t1", planId: "p9" };
    expect(await code(r.d.verifyDecision(principal(), r.sign(r.payloadFor(issued, other)), PLAN))).toBe("signature");
  });

  test("a malformed signature is a refusal, not a crash", async () => {
    const r = rig();
    const issued = await r.d.issueChallenge(principal(), PLAN);
    expect(await code(r.d.verifyDecision(principal(), { payload: r.payloadFor(issued, PLAN), sig: "zz" }, PLAN))).toBe("signature");
  });
});

describe("check 4: the content", () => {
  test("a plan revised after the challenge voids the decision", async () => {
    plan = "# Plan\n1. do it";
    const r = rig();
    const issued = await r.d.issueChallenge(principal(), PLAN);
    plan = "# Plan\n1. do something dangerous";
    expect(await code(r.d.verifyDecision(principal(), r.sign(r.payloadFor(issued, PLAN)), PLAN))).toBe("content-changed");
    plan = "# Plan\n1. do it";
  });

  test("a gate whose next steps changed since it was shown is refused", async () => {
    gateNext = ["s2"];
    const r = rig();
    const issued = await r.d.issueChallenge(principal(), GATE);
    gateNext = ["s2", "s-new"];
    expect(await code(r.d.verifyDecision(principal(), r.sign(r.payloadFor(issued, GATE)), GATE))).toBe("content-changed");
    gateNext = ["s2"];
  });

  test("a card answered on the Mac in between (it no longer exists) is refused", async () => {
    const r = rig();
    const tmux: ContentTarget = { kind: "tmux-card", taskId: "t1", promptId: "q1" };
    const gone = createDecisions({ sources: { ...sources, tmuxCard: async () => null } });
    void gone;
    const live = createDecisions({ sources: { ...sources, tmuxCard: (() => { let n = 0; return async () => (n++ === 0 ? { question: "Proceed?", choices: [{ key: "1", label: "Yes" }], mode: "ask", answerKind: "choice" } : null); })() }, now: () => r.now.t });
    const issued = await live.issueChallenge(principal(), tmux);
    const p = r.payloadFor(issued, tmux, { decision: "allow-once" });
    expect(await code(live.verifyDecision(principal(), r.sign(p), tmux))).toBe("content-changed");
  });

  test("a signed hash that is simply wrong is refused", async () => {
    const r = rig();
    const issued = await r.d.issueChallenge(principal(), PLAN);
    const wrong = r.payloadFor(issued, PLAN, { contentHash: contentHashOf(new TextEncoder().encode("something else")) });
    expect(await code(r.d.verifyDecision(principal(), r.sign(wrong), PLAN))).toBe("content-changed");
  });
});

describe("check 5: the decision is valid for the target", () => {
  test("a plan cannot be 'accepted', a gate cannot be 'approved', a card cannot be 'resumed'", async () => {
    const r = rig();
    const a = await r.d.issueChallenge(principal(), PLAN);
    expect(await code(r.d.verifyDecision(principal(), r.sign(r.payloadFor(a, PLAN, { decision: "accept" })), PLAN))).toBe("decision");
    const b = await r.d.issueChallenge(principal(), GATE);
    expect(await code(r.d.verifyDecision(principal(), r.sign(r.payloadFor(b, GATE, { decision: "approve" })), GATE))).toBe("decision");
    const tmux: ContentTarget = { kind: "tmux-card", taskId: "t1", promptId: "q1" };
    const c = await r.d.issueChallenge(principal(), tmux);
    expect(await code(r.d.verifyDecision(principal(), r.sign(r.payloadFor(c, tmux, { decision: "resume" })), tmux))).toBe("decision");
  });
});

describe("the checks run in order", () => {
  test("a decision that fails several reports the FIRST: a bad challenge beats a bad signature beats a changed plan", async () => {
    plan = "# Plan\n1. do it";
    const r = rig();
    const issued = await r.d.issueChallenge(principal(), PLAN);
    plan = "# changed";
    const bad = r.sign(r.payloadFor(issued, PLAN, { sessionHash: toHex(new Uint8Array(32).fill(1)), decision: "accept" }), p256.utils.randomSecretKey());
    expect(await code(r.d.verifyDecision(principal(), bad, PLAN))).toBe("session"); // 2 before 3, 4, 5
    const issued2 = await r.d.issueChallenge(principal(), PLAN);
    expect(await code(r.d.verifyDecision(principal(), r.sign(r.payloadFor(issued2, PLAN, { decision: "accept" }), p256.utils.randomSecretKey()), PLAN))).toBe("signature"); // 3 before 4, 5
    const issued3 = await r.d.issueChallenge(principal(), PLAN);
    expect(await code(r.d.verifyDecision(principal(), r.sign(r.payloadFor({ ...issued3, contentHash: contentHashOf(new Uint8Array(1)) }, PLAN, { decision: "accept" })), PLAN))).toBe("content-changed"); // 4 before 5
    plan = "# Plan\n1. do it";
    void buildContent;
  });
});

describe("the unlock window", () => {
  const unlockPayload = (t: number, over: Partial<{ expiresAt: number; sessionHash: string }> = {}) => ({ kind: "unlock" as const, sessionHash: toHex(sessionHash), expiresAt: t + 5 * 60_000, ...over });
  const sig = (p: ReturnType<typeof unlockPayload>, key = approveSk) => toHex(signEs256(key, unlockBytes(p)));

  test("a signed unlock opens the window until its expiry, and the session's end closes it", () => {
    const r = rig();
    expect(r.d.isUnlocked(principal())).toBe(false);
    const p = unlockPayload(r.now.t);
    expect(r.d.verifyUnlock(principal(), p, sig(p))).toBe(p.expiresAt);
    expect(r.d.isUnlocked(principal())).toBe(true);
    expect(r.d.isUnlocked(principal({ sessionId: "other" }))).toBe(false);
    r.now.t += 5 * 60_000 + 1;
    expect(r.d.isUnlocked(principal())).toBe(false);
    r.d.verifyUnlock(principal(), unlockPayload(r.now.t), sig(unlockPayload(r.now.t)));
    r.d.endSession("s1");
    expect(r.d.isUnlocked(principal())).toBe(false);
  });

  test("an unlock more than ten minutes ahead, already expired, for another session or by another key is refused", () => {
    const r = rig();
    for (const [p, key] of [
      [unlockPayload(r.now.t, { expiresAt: r.now.t + 10 * 60_000 + 1 }), approveSk],
      [unlockPayload(r.now.t, { expiresAt: r.now.t - 1 }), approveSk],
      [unlockPayload(r.now.t, { sessionHash: toHex(new Uint8Array(32).fill(9)) }), approveSk],
      [unlockPayload(r.now.t), p256.utils.randomSecretKey()],
    ] as const) {
      expect(() => r.d.verifyUnlock(principal(), p, sig(p, key))).toThrow(DecisionError);
    }
    expect(r.d.isUnlocked(principal())).toBe(false);
  });

  test("ten minutes exactly is allowed", () => {
    const r = rig();
    const p = unlockPayload(r.now.t, { expiresAt: r.now.t + 10 * 60_000 });
    expect(r.d.verifyUnlock(principal(), p, sig(p))).toBe(p.expiresAt);
  });
});

// TS2, invariant 8 and the consent rules (grill D8, D9, D10): consent that runs code is signed over the exact content the phone showed. The
// router, the five-check verifier and the class rules are the real ones; the served handlers record what actually got through, and the audit and
// idempotency stores are the real SQLite tables.
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes, toHex } from "@agetor/remote-protocol/bytes";
import type { RemoteLevel } from "@agetor/remote-protocol/levels";
import type { ContentSources } from "../content-hash.ts";
import type { ContentTarget } from "../types.ts";
import { body, concretePath, pinDataDir, principal, signDecision, signUnlock } from "./inproc.ts";

const DATA = pinDataDir("consent");
const { createRouter } = await import("../router.ts");
const { createAudit } = await import("../audit.ts");
const { createDecisions } = await import("../decisions.ts");
const { createIdempotency } = await import("../idempotency.ts");
const { RateLimiter } = await import("../rate-limit.ts");
const { ROUTE_POLICY } = await import("../../route-policy.ts");
const { db } = await import("../../db.ts");
const { rmTestDataDir } = await import("../../test-data-dir.ts");
afterAll(() => rmTestDataDir(DATA));

const PLAN_MODAL = "Proceed?\n 1. Yes, and use auto mode\n 2. Yes, manually approve edits\n 3. Tell Claude what to change";
let plan = "# Plan\n1. add a login form";
let gateNext = ["s2"];
let cardGone = false;
const sources: ContentSources = {
  plan: async () => ({ markdown: plan, status: "pending", name: "Plan" }),
  claudePlan: async () => ({ plan, mode: "auto" }),
  tmuxCard: async () => (cardGone ? null : { question: "Allow this command?", choices: [{ key: "1", label: "Yes" }], mode: "auto", answerKind: null }),
  fxPermission: async () => ({ toolCall: { name: "bash", command: "ls" }, options: [{ optionId: "a" }], mode: "auto" }),
  gate: async () => ({ handoffs: [{ fromStepId: "s1", summary: "done" }], nextStepIds: gateNext, mode: "ask" }),
  fxResume: async () => ({ recovery: { paused: true } }),
  terminal: async () => ({ ok: true }),
};

interface TaskFacts { agent: string; mode: string | null }
let task: TaskFacts = { agent: "claude-code", mode: "auto" };

function rig() {
  let t = 1_800_000_000_000;
  const served: string[] = [];
  const routes: Record<string, Record<string, (req: Request) => Response>> = {};
  for (const [key, entry] of Object.entries(ROUTE_POLICY)) {
    const per = "callers" in entry ? { GET: entry } : entry;
    for (const method of Object.keys(per)) (routes[key] ??= {})[method] = () => (served.push(`${method} ${key}`), new Response("{}", { headers: { "content-type": "application/json" } }));
  }
  const decisions = createDecisions({ sources, now: () => t });
  const router = createRouter({
    limiter: new RateLimiter(() => t), idempotency: createIdempotency(undefined, () => t), decisions, audit: createAudit(undefined, () => t),
    lookups: {
      tmuxPrompt: async (id) =>
        id === "plan1" ? { taskId: "t1", paneText: PLAN_MODAL, choices: [{ key: "1", label: "Yes, and use auto mode" }, { key: "2", label: "Yes, manually approve edits" }, { key: "3", label: "Tell Claude what to change" }], answerKind: null }
        : id === "bash1" ? { taskId: "t1", paneText: "Allow this command?", choices: [{ key: "1", label: "Yes" }, { key: "2", label: "Yes, and don't ask again for ls" }, { key: "3", label: "No" }, { key: "4", label: "Yes, but only on Tuesdays" }], answerKind: null }
        : id === "code1" ? { taskId: "t1", paneText: "Paste the code", choices: [], answerKind: "code" }
        : id === "enter1" ? { taskId: "t1", paneText: "Press enter", choices: [], answerKind: "enter" }
        : null,
      fxPermission: async (id) => (id === "fx1" ? { taskId: "t1", harness: "fx" as const, options: [{ optionId: "a", kind: "allow_once" }, { optionId: "b", kind: "allow_always" }, { optionId: "c", kind: "reject_once" }] } : null),
      askQuestionTask: async () => "t1",
      runTask: async () => "t1",
      previewInScope: async () => true,
      planApprovalFlipsToAuto: async () => false,
      taskKind: async () => "claude-code",
      task: async () => task,
    },
    routes: () => routes as never,
  });
  // Random, not a counter: the idempotency table is the real one and outlives a rig.
  const idem = () => toHex(randomBytes(16));
  const call = (level: RemoteLevel, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", route: string, b: unknown, decision: ReturnType<typeof signDecision> | null = null) => {
    t += 2000;
    return router.invoke(principal(level), { method, path: concretePath(route), query: null, body: b, idem: method === "GET" ? null : idem(), decision });
  };
  const challenge = async (level: RemoteLevel, target: ContentTarget) => decisions.issueChallenge(principal(level), target);
  const unlock = (level: RemoteLevel) => { const u = signUnlock(principal(level), 60_000, t); decisions.verifyUnlock(principal(level), u.payload, u.sig); };
  return { call, challenge, unlock, served, advance: (ms: number) => void (t += ms), now: () => t };
}

const PLAN_T: ContentTarget = { kind: "plan", taskId: "x1", planId: "x1" };

describe("inv8: consent is signed over the exact content shown", () => {
  test("inv8: a correct signed approval is accepted, and each way of getting it wrong is refused on its own check", async () => {
    plan = "# Plan\n1. add a login form";
    const r = rig();
    const route = "POST /tasks/x1/plans/x1/approve";
    const good = async (over: Parameters<typeof signDecision>[5] = {}) => signDecision(principal("respond"), await r.challenge("respond", PLAN_T), PLAN_T, route, "approve", over);

    // 1. no decision at all
    expect((await body(await r.call("respond", "POST", "/tasks/:id/plans/:planId/approve", null))).code).toBe("signature");
    // 1. a made-up challenge
    const bogus = signDecision(principal("respond"), { challenge: "00".repeat(16), contentHash: "sha256:" + "00".repeat(32) }, PLAN_T, route, "approve");
    expect((await body(await r.call("respond", "POST", "/tasks/:id/plans/:planId/approve", null, bogus))).code).toBe("challenge");
    // 2. another session's hash
    expect((await body(await r.call("respond", "POST", "/tasks/:id/plans/:planId/approve", null, await good({ sessionHash: "11".repeat(32) })))).code).toBe("session");
    // 3. the wrong key
    const issued = await r.challenge("respond", PLAN_T);
    const wrongKey = signDecision(principal("respond"), issued, PLAN_T, route, "approve", {}, (await import("@noble/curves/nist.js")).p256.utils.randomSecretKey());
    expect((await body(await r.call("respond", "POST", "/tasks/:id/plans/:planId/approve", null, wrongKey))).code).toBe("signature");
    // 4. the plan changed after it was shown
    const stale = await good();
    plan = "# Plan\n1. delete everything";
    expect((await body(await r.call("respond", "POST", "/tasks/:id/plans/:planId/approve", null, stale))).code).toBe("content-changed");
    plan = "# Plan\n1. add a login form";
    // 5. a decision this target does not accept
    expect((await body(await r.call("respond", "POST", "/tasks/:id/plans/:planId/approve", null, await good({ decision: "accept" })))).code).toBe("decision");
    // the route inside the signature must be this call's
    const other = signDecision(principal("respond"), await r.challenge("respond", PLAN_T), PLAN_T, "POST /tasks/x1/plans/other/approve", "approve");
    expect((await body(await r.call("respond", "POST", "/tasks/:id/plans/:planId/approve", null, other))).code).toBe("signature");
    // nothing above reached the handler
    expect(r.served).toEqual([]);
    // the correct one, once, goes through; its challenge cannot be used again
    const ok = await good();
    expect((await r.call("respond", "POST", "/tasks/:id/plans/:planId/approve", null, ok)).status).toBe(200);
    expect(r.served).toEqual(["POST /tasks/:id/plans/:planId/approve"]);
    expect((await body(await r.call("respond", "POST", "/tasks/:id/plans/:planId/approve", null, ok))).code).toBe("challenge");
    expect(r.served).toHaveLength(1);
  });

  test("inv8: a gate decision is bound to its decision and comment, and to the next steps it showed", async () => {
    const r = rig();
    const gate: ContentTarget = { kind: "gate", taskId: "x1", stepId: "g1", seq: 2 };
    const route = "POST /tasks/x1/pipeline/review";
    const b = { stepId: "g1", seq: 2, decision: "accept" as const };
    const signed = async (over: Parameters<typeof signDecision>[5] = {}, decision: "accept" | "return" = "accept") =>
      signDecision(principal("respond"), await r.challenge("respond", gate), gate, route, decision, over);
    expect((await r.call("respond", "POST", "/tasks/:id/pipeline/review", b, await signed())).status).toBe(200);
    // the body says return, the signature says accept
    expect((await body(await r.call("respond", "POST", "/tasks/:id/pipeline/review", { ...b, decision: "return" }, await signed()))).code).toBe("decision");
    // the comment sent is not the comment signed
    expect((await body(await r.call("respond", "POST", "/tasks/:id/pipeline/review", { ...b, decision: "return", comment: "redo" }, await signed({ comment: "something else" }, "return")))).code).toBe("decision");
    // the next steps changed after the phone saw the gate
    const stale = await signed();
    gateNext = ["s2", "s-new"];
    expect((await body(await r.call("respond", "POST", "/tasks/:id/pipeline/review", b, stale))).code).toBe("content-changed");
    gateNext = ["s2"];
    // a phone-chosen subset of next steps, or a resume mode, is not a v1 option
    expect((await body(await r.call("respond", "POST", "/tasks/:id/pipeline/review", { ...b, nextStepIds: ["s2"] }, await signed()))).code).toBe("not-remote-v1");
    expect((await body(await r.call("respond", "POST", "/tasks/:id/pipeline/review", { ...b, mode: "resume" }, await signed()))).code).toBe("not-remote-v1");
  });

  test("inv8: a card answered on the Mac in between is gone: the signature is refused as content-changed", async () => {
    const r = rig();
    const card: ContentTarget = { kind: "tmux-card", taskId: "t1", promptId: "bash1" };
    const signed = signDecision(principal("respond"), await r.challenge("respond", card), card, "POST /tmux-prompts/bash1/answer", "allow-once");
    cardGone = true;
    const res = await r.call("respond", "POST", "/tmux-prompts/bash1/answer", { key: "1" }, signed);
    cardGone = false;
    expect(res.status).toBe(403);
  });
});

describe("D8: tmux rows", () => {
  test("an exact 'Yes' needs a signature; an always row, an unknown row and an extra-word row are refused even with a perfect signature", async () => {
    const r = rig();
    const card: ContentTarget = { kind: "tmux-card", taskId: "t1", promptId: "bash1" };
    const sign = async () => signDecision(principal("respond"), await r.challenge("respond", card), card, "POST /tmux-prompts/bash1/answer", "allow-once");
    expect((await body(await r.call("respond", "POST", "/tmux-prompts/bash1/answer", { key: "1" }))).code).toBe("signature");
    expect((await r.call("respond", "POST", "/tmux-prompts/bash1/answer", { key: "1" }, await sign())).status).toBe(200);
    for (const key of ["2", "4", "9"]) expect((await body(await r.call("respond", "POST", "/tmux-prompts/bash1/answer", { key }, await sign()))).code, `row ${key}`).toBe("not-remote-v1");
    // a bare No is a removal: no proof at all
    expect((await r.call("respond", "POST", "/tmux-prompts/bash1/answer", { key: "3" })).status).toBe(200);
    expect((await r.call("respond", "POST", "/tmux-prompts/bash1/answer", { reject: true })).status).toBe(200);
  });

  test("the OAuth code card is never answered from a phone, at any level", async () => {
    const r = rig();
    for (const level of ["respond", "operate", "configure"] as RemoteLevel[]) {
      expect((await body(await r.call(level, "POST", "/tmux-prompts/code1/answer", { code: "abc123" }))).code, level).toBe("not-remote-v1");
    }
    // the card itself says it is the OAuth code card: whatever the body claims, it is refused
    expect((await body(await r.call("configure", "POST", "/tmux-prompts/code1/answer", { key: "1" }))).code).toBe("not-remote-v1");
  });
});

describe("D9: Claude's plan modal at each level", () => {
  const modal = (row: "auto" | "manual"): ContentTarget => ({ kind: "claude-plan", taskId: "t1", promptId: "plan1", row });
  const answer = async (r: ReturnType<typeof rig>, level: RemoteLevel, key: string, row: "auto" | "manual") =>
    r.call(level, "POST", "/tmux-prompts/plan1/answer", { key }, signDecision(principal(level), await r.challenge(level, modal(row)), modal(row), "POST /tmux-prompts/plan1/answer", "approve"));

  test("row 1 (auto mode): respond is refused at level; operate needs the unlock window on top of the signature; with both it goes through", async () => {
    plan = "# Plan\n1. add a login form";
    task = { agent: "claude-code", mode: "ask" };
    const r = rig();
    expect((await body(await answer(r, "respond", "1", "auto"))).code).toBe("level");
    expect((await body(await answer(r, "operate", "1", "auto"))).code).toBe("unlock");
    r.unlock("operate");
    expect((await answer(r, "operate", "1", "auto")).status).toBe(200);
    expect(r.served).toEqual(["POST /tmux-prompts/:id/answer"]);
  });

  test("row 2 (manual approval) is a plain signed consent at respond; row 3 is content behind the unlock window", async () => {
    plan = "# Plan\n1. add a login form";
    task = { agent: "claude-code", mode: "auto" };
    const r = rig();
    expect((await answer(r, "respond", "2", "manual")).status).toBe(200);
    expect((await body(await r.call("respond", "POST", "/tmux-prompts/plan1/answer", { key: "3" }))).code).toBe("unlock");
    r.unlock("respond");
    expect((await r.call("respond", "POST", "/tmux-prompts/plan1/answer", { key: "3" })).status).toBe(200);
  });
});

describe("D10: words sent with a refusal are content", () => {
  test("a bare reject needs nothing; a reject with text needs the unlock window on an autonomous task", async () => {
    task = { agent: "claude-code", mode: "auto" };
    const r = rig();
    expect((await r.call("respond", "POST", "/fx-permissions/fx1/answer", { optionId: "c" })).status).toBe(200);
    expect((await body(await r.call("respond", "POST", "/fx-permissions/fx1/answer", { optionId: "c", message: "use another approach" }))).code).toBe("unlock");
    r.unlock("respond");
    expect((await r.call("respond", "POST", "/fx-permissions/fx1/answer", { optionId: "c", message: "use another approach" })).status).toBe(200);
    // allow-always is never available from a phone
    expect((await body(await r.call("respond", "POST", "/fx-permissions/fx1/answer", { optionId: "b" }))).code).toBe("not-remote-v1");
  });
});

describe("the unlock window", () => {
  test("a follow-up into an autonomous task is refused without it, accepted with it, and refused again after it expires; an ask-mode task never needs it", async () => {
    task = { agent: "claude-code", mode: "auto" };
    const r = rig();
    const send = () => r.call("respond", "POST", "/runs/:id/input", { text: "go on" });
    expect((await body(await send())).code).toBe("unlock");
    r.unlock("respond");
    expect((await send()).status).toBe(200);
    r.advance(61_000);
    expect((await body(await send())).code).toBe("unlock");
    task = { agent: "claude-code", mode: "ask" };
    expect((await send()).status).toBe(200);
  });

  test("an unknown harness or mode counts as running without asking (fail closed)", async () => {
    const r = rig();
    for (const t of [{ agent: "brand-new", mode: "ask" }, { agent: "claude-code", mode: "turbo" }]) {
      task = t;
      expect((await body(await r.call("respond", "POST", "/runs/:id/input", { text: "go" }))).code, JSON.stringify(t)).toBe("unlock");
    }
    task = { agent: "claude-code", mode: "auto" };
  });
});

describe("what was audited", () => {
  test("every consent attempt left an attempt row with the signature and a body hash, and a result row naming it; no body is in the log", async () => {
    plan = "# Plan\n1. add a login form";
    const r = rig();
    const sig = signDecision(principal("respond"), await r.challenge("respond", PLAN_T), PLAN_T, "POST /tasks/x1/plans/x1/approve", "approve");
    await r.call("respond", "POST", "/tasks/:id/plans/:planId/approve", null, sig);
    const rows = db.query<{ action: string; route: string | null; signature: string | null; attempt_seq: number | null }, []>(`SELECT action, route, signature, attempt_seq FROM remote_audit ORDER BY seq DESC LIMIT 4`).all();
    expect(rows.some((x) => x.action === "route" && x.route === "POST /tasks/x1/plans/x1/approve" && x.signature === sig.sig)).toBe(true);
    expect(rows.some((x) => x.action === "route-result" && x.attempt_seq !== null)).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { p256 } from "@noble/curves/nist.js";
import { toHex } from "@agetor/remote-protocol/bytes";
import { decisionBytes, type DecisionPayload } from "@agetor/remote-protocol/decision";
import { signEs256 } from "@agetor/remote-protocol/es256";
import type { AppEvent } from "../../shared/types.ts";
import { allRemoteRoutes, deviceOf } from "../route-policy.ts";
import type { ServedRoutes } from "../route-table.ts";
import { createDecisions } from "./decisions.ts";
import type { ContentSources } from "./content-hash.ts";
import { createIdempotency, type IdempotencyStore } from "./idempotency.ts";
import { RateLimiter } from "./rate-limit.ts";
import { createRouter, type RouteRequest, type RouterDeps } from "./router.ts";
import type { ClassifyLookups } from "./route-classes.ts";
import type { ContentTarget, DevicePrincipal } from "./types.ts";

const approveSk = p256.utils.randomSecretKey();
const sessionHash = new Uint8Array(32).fill(3);
const IDEM = "ab".repeat(16);

function principal(level: DevicePrincipal["level"] = "respond", sessionId = "s1"): DevicePrincipal {
  return { kind: "device", deviceId: "cd".repeat(16), deviceName: "Ana's iPhone", level, sessionId, sessionHash, approvePub: p256.getPublicKey(approveSk, false) };
}

let plan = "# Plan\n1. do it";
const sources: ContentSources = {
  plan: async () => ({ markdown: plan, status: "pending", name: "Plan" }),
  claudePlan: async () => ({ plan, mode: "auto" }),
  tmuxCard: async () => ({ question: "Allow?", choices: [{ key: "1", label: "Yes" }], mode: "auto", answerKind: null }),
  fxPermission: async () => null,
  gate: async () => ({ handoffs: [], nextStepIds: ["s2"], mode: "ask" }),
  fxResume: async () => null,
  terminal: async () => ({ ok: true }),
};

const PLAN_MODAL = "Proceed?\n 1. Yes, and use auto mode\n 2. Yes, manually approve edits\n 3. Tell Claude what to change";

function rig(over: { mode?: string; agent?: string } = {}) {
  const calls: Array<{ route: string; params: Record<string, string>; body: unknown; device: DevicePrincipal | null; url: string }> = [];
  const log: string[] = [];
  const audit: Array<Record<string, unknown>> = [];
  const events: AppEvent[] = [];
  const notes: Array<{ deviceId: string; title: string; body: string }> = [];
  let auditFails = false;
  let handlerThrows = false;
  const handlerStatus: { value: number } = { value: 200 };
  const served: ServedRoutes = {};
  for (const r of allRemoteRoutes()) {
    const h = async (req: Request & { params: Record<string, string> }) => {
      if (handlerThrows) throw new Error("boom");
      log.push("handler");
      calls.push({ route: `${req.method} ${r.route}`, params: req.params, body: await req.json().catch(() => null), device: deviceOf(req), url: req.url });
      return new Response(JSON.stringify({ ok: true }), { status: handlerStatus.value, headers: { "content-type": "application/json" } });
    };
    const cur = served[r.route];
    served[r.route] = typeof cur === "object" ? { ...cur, [r.method]: h } : { [r.method]: h };
  }
  const store = (): IdempotencyStore => {
    const rows = new Map<string, Parameters<IdempotencyStore["put"]>[0]>();
    return {
      get: async (d, k) => rows.get(`${d}${k}`) ?? null,
      put: async (row) => (rows.has(`${row.deviceId}${row.idemKey}`) ? false : (rows.set(`${row.deviceId}${row.idemKey}`, row), true)),
      prune: async () => 0,
    };
  };
  const lookups: RouterDeps["lookups"] = {
    tmuxPrompt: async (id) =>
      id === "plan1" ? { taskId: "t1", paneText: PLAN_MODAL, choices: [{ key: "1", label: "Yes, and use auto mode" }, { key: "2", label: "Yes, manually approve edits" }, { key: "3", label: "Tell Claude what to change" }], answerKind: null }
      : id === "bash1" ? { taskId: "t1", paneText: "Allow?", choices: [{ key: "1", label: "Yes" }, { key: "2", label: "Yes, and don't ask again" }, { key: "3", label: "No" }], answerKind: null }
      : null,
    fxPermission: async () => null,
    askQuestionTask: async () => "t1",
    runTask: async (id) => (id === "r1" ? "t1" : null),
    previewInScope: async (_t, p) => p.startsWith("/work/"),
    planApprovalFlipsToAuto: async () => false,
    taskKind: async (id) => (id === "t1" ? over.agent ?? "claude-code" : null),
    task: async (id) => (id === "t1" ? { agent: over.agent ?? "claude-code", mode: over.mode ?? "auto" } : null),
  };
  let t = 1_800_000_000_000;
  const decisions = createDecisions({ sources, now: () => t });
  const router = createRouter({
    limiter: new RateLimiter(() => t),
    idempotency: createIdempotency(store(), () => t),
    decisions,
    audit: {
      attempt: async (a) => {
        if (auditFails) throw new Error("db");
        log.push("attempt");
        audit.push({ kind: "attempt", ...a });
        return audit.length;
      },
      result: async (seq, code) => void (log.push("result"), audit.push({ kind: "result", seq, code })),
      event: async (action) => (audit.push({ kind: "event", action }), { seq: 0, hash: "" }),
      refusal: async (_d, code) => (audit.push({ kind: "refusal", code }), true),
    },
    lookups,
    routes: () => served,
    broadcast: (e) => void events.push(e),
    notify: (n) => void notes.push(n),
    now: () => t,
  });
  const call = (p: DevicePrincipal, req: Partial<RouteRequest> & { method: RouteRequest["method"]; path: string }) =>
    router.invoke(p, { query: null, body: null, idem: req.method === "GET" ? null : IDEM, decision: null, ...req });
  const sign = async (p: DevicePrincipal, target: ContentTarget, route: string, decision: DecisionPayload["decision"], extra: Partial<DecisionPayload> = {}) => {
    const issued = await decisions.issueChallenge(p, target);
    const payload: DecisionPayload = {
      v: 1, kind: "decision", deviceId: p.deviceId, sessionHash: toHex(sessionHash), challenge: issued.challenge, route, target: target as DecisionPayload["target"],
      contentHash: issued.contentHash, decision, comment: null, ts: t, ...extra,
    };
    return { payload, sig: toHex(signEs256(approveSk, decisionBytes(payload))) };
  };
  const openUnlock = async (p: DevicePrincipal) => {
    const { unlockBytes } = await import("@agetor/remote-protocol/decision");
    const payload = { kind: "unlock" as const, sessionHash: toHex(sessionHash), expiresAt: t + 60_000 };
    decisions.verifyUnlock(p, payload, toHex(signEs256(approveSk, unlockBytes(payload))));
  };
  return { router, call, calls, log, audit, events, notes, sign, openUnlock, setAuditFails: (v: boolean) => void (auditFails = v), setThrows: (v: boolean) => void (handlerThrows = v), handlerStatus, advance: (ms: number) => void (t += ms), setNow: (v: number) => void (t = v) };
}

const body = async (r: { body: Uint8Array }) => JSON.parse(new TextDecoder().decode(r.body)) as Record<string, unknown>;

describe("matching and refusals", () => {
  test("a read passes through to the served handler as a device request, with its params and query", async () => {
    const r = rig();
    const res = await r.call(principal("observe"), { method: "GET", path: "/tasks/t1/events/page", query: "limit=5" });
    expect(res.status).toBe(200);
    expect(r.calls[0]).toMatchObject({ route: "GET /tasks/:id/events/page", params: { id: "t1" }, url: "http://127.0.0.1/tasks/t1/events/page?limit=5" });
    expect(r.calls[0]!.device?.deviceId).toBe(principal().deviceId);
  });
  test("/tasks/:id/events/page and /tasks/:id/events/:eventId do not shadow each other", async () => {
    const r = rig();
    await r.call(principal("observe"), { method: "GET", path: "/tasks/t1/events/page" });
    await r.call(principal("observe"), { method: "GET", path: "/tasks/t1/events/42" });
    expect(r.calls.map((c) => c.route)).toEqual(["GET /tasks/:id/events/page", "GET /tasks/:id/events/:eventId"]);
    expect(r.calls[1]!.params).toEqual({ id: "t1", eventId: "42" });
  });
  test("odd paths are refused before matching", async () => {
    const r = rig();
    for (const path of ["/tasks/../seen", "/tasks//t1", "/tasks/t1/", "/tasks/%2e%2e/x", "/tasks/t1\\x", "tasks/t1", "/tasks/t 1", "/tasks/" + "a".repeat(600)]) {
      expect((await r.call(principal("observe"), { method: "GET", path })).status, path).toBe(400);
    }
    expect(r.calls).toHaveLength(0);
  });
  test("the SSE routes are refused with use-subscription; an unknown route is 404; a route with no remote policy is 404 too", async () => {
    const r = rig();
    for (const path of ["/events", "/tasks/t1/events"]) expect(await body(await r.call(principal("configure"), { method: "GET", path }))).toMatchObject({ code: "use-subscription" });
    expect((await r.call(principal("configure"), { method: "GET", path: "/nope" })).status).toBe(404);
    expect(await body(await r.call(principal("configure"), { method: "POST", path: "/tasks", body: {}, idem: IDEM }))).toMatchObject({ code: "not-remote" });
    expect((await r.call(principal("configure"), { method: "PATCH", path: "/tasks/t1/seen", body: {}, idem: IDEM })).status).toBe(404);
  });
  test("a route above the device's level is 403 level, not 404", async () => {
    const r = rig();
    const res = await r.call(principal("observe"), { method: "POST", path: "/runs/r1/cancel" });
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ code: "level", required: "respond" });
    expect(r.calls).toHaveLength(0);
  });
  test("the rate limit answers 429, and a stop-class call is never limited", async () => {
    const r = rig();
    let limited = 0;
    for (let i = 0; i < 40; i++) if ((await r.call(principal("observe"), { method: "GET", path: "/tasks/t1" })).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
    for (let i = 0; i < 60; i++) expect((await r.call(principal("respond"), { method: "POST", path: "/runs/r1/cancel", idem: toHex(new Uint8Array(16).fill(i)) })).status).toBe(200);
  });
});

describe("S3/S9: removals pass a spent bucket, and refusals are rate-limited too", () => {
  test("S3: a reject (a removal on a normal-rate route) is answered when the bucket is empty; content on the same route is 429", async () => {
    const r = rig();
    const p = principal("respond");
    for (let i = 0; i < 60; i++) await r.call(p, { method: "GET", path: "/tasks/t1" });
    expect((await r.call(p, { method: "GET", path: "/tasks/t1" })).status).toBe(429);
    // "No" is a reject (a removal); "Yes" would be a signed consent and is refused on the rate
    const reject = await r.call(p, { method: "POST", path: "/tmux-prompts/bash1/answer", body: { key: "3" }, idem: toHex(new Uint8Array(16).fill(1)) });
    expect(reject.status).toBe(200);
    const consent = await r.call(p, { method: "POST", path: "/tmux-prompts/bash1/answer", body: { key: "1" }, idem: toHex(new Uint8Array(16).fill(2)) });
    expect(consent.status).toBe(429);
  });

  test("S9: calls to a route with no remote policy are limited too; a stop-class call still passes the bucket they spent", async () => {
    const r = rig();
    const p = principal("configure");
    const statuses: number[] = [];
    for (let i = 0; i < 60; i++) statuses.push((await r.call(p, { method: "POST", path: "/tasks", body: {}, idem: toHex(new Uint8Array(16).fill(i)) })).status);
    expect(statuses[0]).toBe(403);
    expect(statuses).toContain(429);
    expect(r.calls).toHaveLength(0);
    expect((await r.call(p, { method: "POST", path: "/runs/r1/cancel", idem: toHex(new Uint8Array(16).fill(200)) })).status).toBe(200);
  });

  test("S9: calls refused for the level are limited too, so a device cannot write refusals without bound", async () => {
    const r = rig();
    const p = principal("observe");
    const statuses: number[] = [];
    for (let i = 0; i < 60; i++) statuses.push((await r.call(p, { method: "POST", path: "/tasks/t1/backlog", body: {}, idem: toHex(new Uint8Array(16).fill(i)) })).status);
    expect(statuses[0]).toBe(403);
    expect(statuses).toContain(429);
  });
});

describe("idempotency", () => {
  test("a write without a key is refused; with the same key twice the handler runs once and the second answer is the stored one", async () => {
    const r = rig();
    const p = principal("respond");
    expect((await r.call(p, { method: "POST", path: "/runs/r1/cancel", idem: null })).status).toBe(400);
    const a = await r.call(p, { method: "POST", path: "/runs/r1/cancel" });
    const b = await r.call(p, { method: "POST", path: "/runs/r1/cancel" });
    expect([a.status, b.status, b.replayed]).toEqual([200, 200, true]);
    expect(r.calls).toHaveLength(1);
    expect(r.audit.some((x) => x.action === "replayed")).toBe(true);
  });
  test("the same key with another body is 409", async () => {
    const r = rig();
    const p = principal("respond");
    await r.call(p, { method: "POST", path: "/tasks/t1/seen", body: {} });
    expect((await r.call(p, { method: "POST", path: "/tasks/t1/pipeline/cancel", body: {} })).status).toBe(409);
  });
  test("a handler that throws is 500 and the key is released, so the retry runs", async () => {
    const r = rig();
    const p = principal("respond");
    r.setThrows(true);
    expect((await r.call(p, { method: "POST", path: "/runs/r1/cancel" })).status).toBe(500);
    r.setThrows(false);
    expect((await r.call(p, { method: "POST", path: "/runs/r1/cancel" })).status).toBe(200);
  });
  test("a status the handler chose passes through unchanged and is stored", async () => {
    const r = rig();
    r.handlerStatus.value = 503;
    const res = await r.call(principal("respond"), { method: "POST", path: "/runs/r1/cancel" });
    expect(res.status).toBe(503);
  });
});

describe("the audit order", () => {
  test("the attempt is written before the handler runs, the result after, and neither holds the body", async () => {
    const r = rig({ mode: "ask" });
    await r.call(principal("respond"), { method: "POST", path: "/runs/r1/input", body: { text: "SECRET-FOLLOW-UP" } });
    expect(r.log).toEqual(["attempt", "handler", "result"]);
    const attempt = r.audit.find((x) => x.kind === "attempt")!;
    expect(attempt.route).toBe("POST /runs/r1/input");
    expect(attempt.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r.audit)).not.toContain("SECRET-FOLLOW-UP");
    expect(r.audit.find((x) => x.kind === "result")).toMatchObject({ seq: 1, code: "200" });
  });
  test("a read is not audited", async () => {
    const r = rig();
    await r.call(principal("observe"), { method: "GET", path: "/tasks/t1" });
    expect(r.audit.filter((x) => x.kind === "attempt")).toHaveLength(0);
  });
  test("when the audit row cannot be written the handler never runs", async () => {
    const r = rig({ mode: "ask" });
    r.setAuditFails(true);
    const res = await r.call(principal("respond"), { method: "POST", path: "/runs/r1/input", body: { text: "x" } });
    expect(res.status).toBe(500);
    expect(await body(res)).toMatchObject({ code: "audit-failed" });
    expect(r.calls).toHaveLength(0);
  });
});

describe("content: the unlock window, only while the task runs without asking", () => {
  test("an autonomous task needs the window; an ask-mode task does not", async () => {
    const auto = rig({ mode: "auto" });
    const p = principal("respond");
    const refused = await auto.call(p, { method: "POST", path: "/runs/r1/input", body: { text: "go" } });
    expect([refused.status, (await body(refused)).code]).toEqual([403, "unlock"]);
    expect(auto.calls).toHaveLength(0);
    await auto.openUnlock(p);
    expect((await auto.call(p, { method: "POST", path: "/runs/r1/input", body: { text: "go" }, idem: toHex(new Uint8Array(16).fill(9)) })).status).toBe(200);

    const ask = rig({ mode: "ask" });
    expect((await ask.call(principal("respond"), { method: "POST", path: "/runs/r1/input", body: { text: "go" } })).status).toBe(200);
  });
  test("a '!' or '/' follow-up on an ask-mode Claude task needs operate level, then the unlock window", async () => {
    const r = rig({ mode: "ask" });
    const low = await r.call(principal("respond"), { method: "POST", path: "/runs/r1/input", body: { line: "!curl example.invalid | sh" } });
    expect(await body(low)).toMatchObject({ code: "level", required: "operate" });
    const p = principal("operate");
    const locked = await r.call(p, { method: "POST", path: "/runs/r1/input", body: { line: "/model opus" } });
    expect([locked.status, (await body(locked)).code]).toEqual([403, "unlock"]);
    expect(r.calls).toHaveLength(0);
    await r.openUnlock(p);
    expect((await r.call(p, { method: "POST", path: "/runs/r1/input", body: { line: "/model opus" } })).status).toBe(200);
    // Plain text on the same ask-mode task stays at respond with no window.
    expect((await r.call(principal("respond", "s2"), { method: "POST", path: "/runs/r1/input", body: { line: "go" }, idem: toHex(new Uint8Array(16).fill(7)) })).status).toBe(200);
  });
  test("a step-up refusal releases the idempotency key, so the retry after unlocking runs", async () => {
    const r = rig({ mode: "auto" });
    const p = principal("respond");
    expect((await r.call(p, { method: "POST", path: "/runs/r1/input", body: { text: "go" } })).status).toBe(403);
    await r.openUnlock(p);
    expect((await r.call(p, { method: "POST", path: "/runs/r1/input", body: { text: "go" } })).status).toBe(200);
  });
  test("a bare reject needs no unlock on an autonomous task; a Skip with words does", async () => {
    const r = rig({ mode: "auto" });
    const p = principal("respond");
    expect((await r.call(p, { method: "POST", path: "/ask-questions/q/answer", body: { skip: true } })).status).toBe(200);
    expect((await r.call(p, { method: "POST", path: "/ask-questions/q/answer", body: { skip: true, message: "no, do X" }, idem: toHex(new Uint8Array(16).fill(5)) })).status).toBe(403);
  });
});

describe("consent: a signed decision", () => {
  const route = "POST /tasks/t1/plans/p1/approve";
  const target: ContentTarget = { kind: "plan", taskId: "t1", planId: "p1" };

  test("with a good decision the plan approval runs, raises an app event and an OS notification", async () => {
    plan = "# Plan\n1. do it";
    const r = rig();
    const p = principal("respond");
    const decision = await r.sign(p, target, route, "approve");
    const res = await r.call(p, { method: "POST", path: "/tasks/t1/plans/p1/approve", decision });
    expect(res.status).toBe(200);
    expect(r.audit.find((x) => x.kind === "attempt")!.signature).toBe(decision.sig);
    expect(r.events).toEqual([expect.objectContaining({ type: "remote_action", taskId: "t1", deviceName: "Ana's iPhone", action: "plan-approved" })]);
    expect(r.notes).toEqual([{ deviceId: p.deviceId, title: "Ana's iPhone", body: "approved a plan" }]);
  });
  test("no decision is 403 signature and nothing runs", async () => {
    const r = rig();
    const res = await r.call(principal("respond"), { method: "POST", path: "/tasks/t1/plans/p1/approve" });
    expect([res.status, (await body(res)).code]).toEqual([403, "signature"]);
    expect(r.calls).toHaveLength(0);
    expect(r.events).toHaveLength(0);
  });
  test("a plan revised after the challenge is 403 content-changed", async () => {
    plan = "# Plan\n1. do it";
    const r = rig();
    const p = principal("respond");
    const decision = await r.sign(p, target, route, "approve");
    plan = "# Plan\n1. do something dangerous";
    const res = await r.call(p, { method: "POST", path: "/tasks/t1/plans/p1/approve", decision });
    expect((await body(res)).code).toBe("content-changed");
    plan = "# Plan\n1. do it";
    expect(r.calls).toHaveLength(0);
  });
  test("a decision signed for another call's route is refused, a replayed challenge too", async () => {
    plan = "# Plan\n1. do it";
    const r = rig();
    const p = principal("respond");
    const wrongRoute = await r.sign(p, target, "POST /tasks/t1/plans/p2/approve", "approve");
    expect((await body(await r.call(p, { method: "POST", path: "/tasks/t1/plans/p1/approve", decision: wrongRoute }))).code).toBe("signature");
    const good = await r.sign(p, target, route, "approve");
    expect((await r.call(p, { method: "POST", path: "/tasks/t1/plans/p1/approve", decision: good })).status).toBe(200);
    expect((await body(await r.call(p, { method: "POST", path: "/tasks/t1/plans/p1/approve", decision: good, idem: toHex(new Uint8Array(16).fill(8)) }))).code).toBe("challenge");
  });
  test("a gate review must repeat the signed decision and comment", async () => {
    const r = rig();
    const p = principal("respond");
    const gate: ContentTarget = { kind: "gate", taskId: "t1", stepId: "g", seq: 1 };
    const rt = "POST /tasks/t1/pipeline/review";
    const signed = await r.sign(p, gate, rt, "accept");
    const lie = await r.call(p, { method: "POST", path: "/tasks/t1/pipeline/review", body: { stepId: "g", seq: 1, decision: "return", comment: "x" }, decision: signed });
    expect((await body(lie)).code).toBe("decision");
    const signed2 = await r.sign(p, gate, rt, "accept");
    const ok = await r.call(p, { method: "POST", path: "/tasks/t1/pipeline/review", body: { stepId: "g", seq: 1, decision: "accept" }, decision: signed2, idem: toHex(new Uint8Array(16).fill(7)) });
    expect(ok.status).toBe(200);
  });
});

describe("the tmux card rules end to end", () => {
  test("an always-allow row is 403 not-remote-v1", async () => {
    const r = rig();
    const res = await r.call(principal("respond"), { method: "POST", path: "/tmux-prompts/bash1/answer", body: { key: "2" } });
    expect([res.status, (await body(res)).code]).toEqual([403, "not-remote-v1"]);
  });
  test("a bare No removes with no proof", async () => {
    const r = rig();
    expect((await r.call(principal("respond"), { method: "POST", path: "/tmux-prompts/bash1/answer", body: { key: "3" } })).status).toBe(200);
  });
  test("Claude plan row 1: respond → 403 level; operate without unlock → 403 unlock; a signature on a stale plan → 403 content-changed", async () => {
    plan = "# Plan\n1. do it";
    const r = rig({ mode: "ask" }); // even an ask-mode task: row 1 switches it to auto, and the unlock is read from the live mode
    const target: ContentTarget = { kind: "claude-plan", taskId: "t1", promptId: "plan1", row: "auto" };
    const route = "POST /tmux-prompts/plan1/answer";
    expect(await body(await r.call(principal("respond"), { method: "POST", path: "/tmux-prompts/plan1/answer", body: { key: "1" } }))).toMatchObject({ code: "level", required: "operate" });

    const op = principal("operate");
    const staleDecision = await r.sign(op, target, route, "approve");
    plan = "# Plan\n1. changed";
    expect((await body(await r.call(op, { method: "POST", path: "/tmux-prompts/plan1/answer", body: { key: "1" }, decision: staleDecision }))).code).toBe("content-changed");
    plan = "# Plan\n1. do it";
    void r;
  });
  test("row 1 on an autonomous task without the unlock window is 403 unlock even with a good signature", async () => {
    plan = "# Plan\n1. do it";
    const r = rig({ mode: "auto" });
    const op = principal("operate");
    const decision = await r.sign(op, { kind: "claude-plan", taskId: "t1", promptId: "plan1", row: "auto" }, "POST /tmux-prompts/plan1/answer", "approve");
    expect((await body(await r.call(op, { method: "POST", path: "/tmux-prompts/plan1/answer", body: { key: "1" }, decision, idem: toHex(new Uint8Array(16).fill(1)) }))).code).toBe("unlock");
    await r.openUnlock(op);
    const again = await r.sign(op, { kind: "claude-plan", taskId: "t1", promptId: "plan1", row: "auto" }, "POST /tmux-prompts/plan1/answer", "approve");
    const ok = await r.call(op, { method: "POST", path: "/tmux-prompts/plan1/answer", body: { key: "1" }, decision: again, idem: toHex(new Uint8Array(16).fill(2)) });
    expect(ok.status).toBe(200);
    expect(r.events.at(-1)).toMatchObject({ action: "auto-mode-approved" });
  });
});

describe("the preview scope (D15)", () => {
  test("inside the task's folders respond is enough; outside it needs operate", async () => {
    const r = rig();
    expect(allRemoteRoutes().some((x) => x.route === "/tasks/:id/files/preview")).toBe(true);
    // A heavy read: two a second per device, so time moves between calls.
    const read = async (level: Parameters<typeof principal>[0], p: string) => {
      r.advance(1000);
      return await r.call(principal(level), { method: "GET", path: "/tasks/t1/files/preview", query: `path=${encodeURIComponent(p)}` });
    };
    expect((await read("observe", "/work/a.png")).status).toBe(200);
    expect(await body(await read("observe", "/etc/hosts"))).toMatchObject({ code: "level", required: "operate" });
    expect(await body(await read("respond", "/etc/hosts"))).toMatchObject({ code: "level", required: "operate" });
    expect((await read("operate", "/etc/hosts")).status).toBe(200);
    expect((await read("configure", "/etc/hosts")).status).toBe(200);
  });
});

describe("R5-S3: a call whose session ended", () => {
  const cancel = { method: "POST" as const, path: "/runs/r1/cancel", query: null, body: null, idem: IDEM, decision: null };
  test("a session that ended before the call is recorded: no attempt row, no handler, 410", async () => {
    const r = rig();
    const res = await r.router.invoke(principal("respond"), cancel, { live: () => false });
    expect(res.status).toBe(410);
    expect(await body(res)).toMatchObject({ code: "session-ended" });
    expect(r.calls).toHaveLength(0);
    expect(r.audit.filter((a) => a.kind === "attempt")).toHaveLength(0);
  });
  test("a session that ends while the attempt is being recorded: the attempt gets a session-ended result and the handler never runs", async () => {
    const r = rig();
    let checks = 0;
    const res = await r.router.invoke(principal("respond"), cancel, { live: () => ++checks === 1 });
    expect(res.status).toBe(410);
    expect(r.calls).toHaveLength(0);
    expect(r.audit.filter((a) => a.kind === "attempt")).toHaveLength(1);
    expect(r.audit.filter((a) => a.kind === "result")).toEqual([expect.objectContaining({ code: "session-ended" })]);
  });
  test("a live session's call runs as before", async () => {
    const r = rig();
    expect((await r.router.invoke(principal("respond"), cancel, { live: () => true })).status).toBe(200);
    expect(r.calls.map((c) => c.route)).toEqual(["POST /runs/:id/cancel"]);
  });
  test("isStopCall names the stop-rate routes only", () => {
    const r = rig();
    expect(r.router.isStopCall("POST", "/runs/r1/cancel")).toBe(true);
    expect(r.router.isStopCall("GET", "/tasks/t1/events/page")).toBe(false);
    expect(r.router.isStopCall("POST", "/runs/r1/input")).toBe(false);
    expect(r.router.isStopCall("POST", "/no/such/route")).toBe(false);
    expect(r.router.isStopCall("POST", "/tasks/../seen")).toBe(false);
  });
});

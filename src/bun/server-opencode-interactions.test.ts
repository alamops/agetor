import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { rmTestDataDir } from "./test-data-dir.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import. Port 5214 sits
// outside the e2e worker range (4600-4999), the unit-test range and Vite's 5173.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-server-opencode-interactions-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "5214";

let server: { stop: () => void } | null = null;
let token: string;
const url = (p: string) => `http://127.0.0.1:5214${p}`;

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(async () => {
  server?.stop?.();
  // `bun test` shares one process: leave no cards or gate behind.
  const { __testing } = await import("./interactions.ts");
  __testing.reset();
  rmTestDataDir(DATA_DIR);
});

beforeEach(async () => {
  const { __testing } = await import("./interactions.ts");
  __testing.reset();
});

/** Hold the ask route's in-flight claim open until `release()`. `entered`
 *  resolves with the card id each time a request reaches the claimed section
 *  (only a request that passed the claim check gets there). */
async function holdAskClaim() {
  const { __testing } = await import("./interactions.ts");
  const enteredIds: string[] = [];
  let signalEntered!: () => void;
  const entered = new Promise<void>((r) => { signalEntered = r; });
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  __testing.setOpencodeAskClaimGate(async (cardId) => {
    enteredIds.push(cardId);
    signalEntered();
    await released;
  });
  return { entered, release, enteredIds };
}

function post(p: string, body: unknown): Promise<Response> {
  return fetch(url(p), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function permCard(taskId = "t-oc-perm") {
  const { registerOpencodePermission } = await import("./interactions.ts");
  return registerOpencodePermission({
    taskId, runId: "r1", sessionId: "ses_1", requestId: `per_${Math.random()}`,
    toolCall: { toolCallId: "c1", title: "bash" }, mode: "ask",
  });
}

async function fxCard() {
  const { registerFxPermission } = await import("./interactions.ts");
  return registerFxPermission({
    taskId: "t-oc-fx", runId: "r1", toolCall: { toolCallId: "c1" },
    options: [{ optionId: "allow-once", name: "Allow once" }, { optionId: "reject", name: "Reject" }],
    mode: "ask",
  });
}

async function askCard(taskId = "t-oc-ask") {
  const { registerOpencodeAskQuestions } = await import("./interactions.ts");
  return registerOpencodeAskQuestions({
    taskId, runId: "r1", sessionId: "ses_1", formId: `form_${Math.random()}`,
    fields: [
      { key: "color", question: "Color?", multiple: false, custom: true,
        options: [{ value: "r", label: "Red" }, { value: "b", label: "Blue" }] },
      { key: "tags", question: "Tags?", multiple: true, custom: false,
        options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }] },
    ],
  });
}

async function stillPending(id: string): Promise<boolean> {
  const { findFxPermissionById, getAskQuestionsById } = await import("./interactions.ts");
  return findFxPermissionById(id) !== null || getAskQuestionsById(id) !== null;
}

// ───── /fx-permissions/:id/answer ─────

test("opencode permission: once / always resolve the decision", async () => {
  for (const decision of ["once", "always"] as const) {
    const c = await permCard();
    const res = await post(`/fx-permissions/${c.id}/answer`, { optionId: decision });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    await expect(c.answer).resolves.toEqual({ decision });
  }
});

test("opencode permission: reject carries the trimmed reason; an empty reason is omitted", async () => {
  const a = await permCard();
  expect((await post(`/fx-permissions/${a.id}/answer`, { optionId: "reject", message: "  use the other dir  " })).status).toBe(200);
  await expect(a.answer).resolves.toEqual({ decision: "reject", message: "use the other dir" });

  const b = await permCard();
  expect((await post(`/fx-permissions/${b.id}/answer`, { optionId: "reject", message: "   " })).status).toBe(200);
  await expect(b.answer).resolves.toEqual({ decision: "reject" });

  const c = await permCard();
  expect((await post(`/fx-permissions/${c.id}/answer`, { optionId: "reject" })).status).toBe(200);
  await expect(c.answer).resolves.toEqual({ decision: "reject" });
});

test("opencode permission: refusals are 400 and leave the card pending", async () => {
  const c = await permCard();
  const cases: Array<[unknown, string]> = [
    [{ optionId: "allow-once" }, "unknown option"],
    [{ optionId: "once", message: "why" }, "only allowed with reject"],
    [{ optionId: "always", message: "why" }, "only allowed with reject"],
    [{ cancel: true, message: "why" }, "only allowed with reject"],
    [{ message: "why" }, "only allowed with reject"],
    [{ optionId: "reject", message: "x".repeat(4097) }, "too long"],
    [{ optionId: "reject", message: 42 }, "must be a string"],
    [{ optionId: "reject", message: null }, "must be a string"],
    [{}, "optionId required"],
  ];
  for (const [body, fragment] of cases) {
    const res = await post(`/fx-permissions/${c.id}/answer`, body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(fragment);
    expect(await stillPending(c.id)).toBe(true);
  }
  // Exactly at the cap is accepted.
  const at = "y".repeat(4096);
  expect((await post(`/fx-permissions/${c.id}/answer`, { optionId: "reject", message: at })).status).toBe(200);
  await expect(c.answer).resolves.toEqual({ decision: "reject", message: at });
});

test("opencode permission: cancel resolves the cancellation; a second answer is ok:false", async () => {
  const c = await permCard();
  expect((await (await post(`/fx-permissions/${c.id}/answer`, { cancel: true })).json()).ok).toBe(true);
  await expect(c.answer).resolves.toEqual({ cancelled: true });
  const again = await post(`/fx-permissions/${c.id}/answer`, { optionId: "once" });
  expect(again.status).toBe(200);
  expect((await again.json()).ok).toBe(false);
});

test("fx permission regression: optionId works, a message is refused", async () => {
  const c = await fxCard();
  const bad = await post(`/fx-permissions/${c.id}/answer`, { optionId: "reject", message: "no" });
  expect(bad.status).toBe(400);
  expect(await stillPending(c.id)).toBe(true);
  const unknown = await post(`/fx-permissions/${c.id}/answer`, { optionId: "once" });
  expect(unknown.status).toBe(400);
  const ok = await post(`/fx-permissions/${c.id}/answer`, { optionId: "allow-once" });
  expect((await ok.json()).ok).toBe(true);
  await expect(c.answer).resolves.toEqual({ optionId: "allow-once" });
});

// ───── /ask-questions/:id/answer ─────

test("opencode ask: labels, ids and typed text map to the answer record", async () => {
  const a = await askCard();
  const res = await post(`/ask-questions/${a.id}/answer`, {
    answers: [{ selected: ["Red"] }, { selectedOptionIds: ["y", "x"] }],
  });
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
  await expect(a.answer).resolves.toEqual({ outcome: "answered", answer: { color: "r", tags: ["y", "x"] } });

  const b = await askCard();
  await post(`/ask-questions/${b.id}/answer`, { answers: [{ custom: " teal " }, { selected: ["X"] }] });
  await expect(b.answer).resolves.toEqual({ outcome: "answered", answer: { color: "teal", tags: ["x"] } });
});

test("opencode ask: refusals are 400 and leave the card pending", async () => {
  const a = await askCard();
  const cases: Array<[unknown, string]> = [
    [{}, "answers required"],
    [{ answers: [] }, "answers required"],
    [{ answers: [{ selected: ["Red"] }] }, "answers required"],
    [{ answers: [{ selected: ["Green"] }, { selected: ["X"] }] }, "unknown option"],
    [{ answers: [{ selectedOptionIds: ["nope"] }, { selected: ["X"] }] }, "unknown option"],
    [{ answers: [{ selected: ["Red"] }, {}] }, 'answer required for "tags"'],
    [{ answers: [{ selected: ["Red"] }, { custom: "free" }] }, "does not accept a typed answer"],
    [{ answers: [{ custom: "x".repeat(4097) }, { selected: ["X"] }] }, "too long"],
    [{ skip: true, message: "x".repeat(4097) }, "too long"],
    [{ skip: true, message: 7 }, "must be a string"],
  ];
  for (const [body, fragment] of cases) {
    const res = await post(`/ask-questions/${a.id}/answer`, body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(fragment);
    expect(await stillPending(a.id)).toBe(true);
  }
});

test("opencode ask: skip with a typed reason, and skip without one sends no words", async () => {
  const a = await askCard();
  expect((await post(`/ask-questions/${a.id}/answer`, { skip: true, message: " not now " })).status).toBe(200);
  await expect(a.answer).resolves.toEqual({ outcome: "skipped", message: "not now" });

  const b = await askCard();
  await post(`/ask-questions/${b.id}/answer`, { skip: true, message: "  " });
  await expect(b.answer).resolves.toEqual({ outcome: "skipped" });

  const c = await askCard();
  await post(`/ask-questions/${c.id}/answer`, { skip: true });
  await expect(c.answer).resolves.toEqual({ outcome: "skipped" });
});

test("opencode ask: a second submit while the first is in flight is a 409 and the first still lands", async () => {
  const gate = await holdAskClaim();
  const a = await askCard();
  const body = { answers: [{ selected: ["Red"] }, { selected: ["X"] }] };
  const first = post(`/ask-questions/${a.id}/answer`, body);
  await gate.entered; // the first request now holds the claim
  const second = await post(`/ask-questions/${a.id}/answer`, body);
  expect(second.status).toBe(409);
  expect(await stillPending(a.id)).toBe(true);
  gate.release();
  const done = await first;
  expect(done.status).toBe(200);
  expect((await done.json()).ok).toBe(true);
  await expect(a.answer).resolves.toEqual({ outcome: "answered", answer: { color: "r", tags: ["x"] } });
  // The claim is released: a late submit is the ordinary ok:false, not a 409.
  const late = await post(`/ask-questions/${a.id}/answer`, body);
  expect(late.status).toBe(200);
  expect((await late.json()).ok).toBe(false);
  expect(gate.enteredIds).toEqual([a.id]);
});

test("opencode ask: a card swept while its answer is in flight settles once as cancelled and the held answer is refused", async () => {
  const { cancelPendingForTask } = await import("./interactions.ts");
  const gate = await holdAskClaim();
  const a = await askCard("t-oc-sweep");
  const inFlight = post(`/ask-questions/${a.id}/answer`, { answers: [{ selected: ["Red"] }, { selected: ["X"] }] });
  await gate.entered;
  cancelPendingForTask("t-oc-sweep", "stop");
  gate.release();
  const res = await inFlight;
  expect((await res.json()).ok).toBe(false);
  // The in-flight path (and only it) reached the claimed section, and the
  // awaiter kept the sweep's cancellation instead of being answered twice.
  expect(gate.enteredIds).toEqual([a.id]);
  await expect(a.answer).resolves.toEqual({ outcome: "cancelled" });
});

test("opencode ask: an answer for a card already swept never reaches the claimed section", async () => {
  const { cancelPendingForTask } = await import("./interactions.ts");
  const gate = await holdAskClaim();
  const a = await askCard("t-oc-swept-before");
  cancelPendingForTask("t-oc-swept-before", "stop");
  const res = await post(`/ask-questions/${a.id}/answer`, { answers: [{ selected: ["Red"] }, { selected: ["X"] }] });
  expect((await res.json()).ok).toBe(false);
  expect(gate.enteredIds).toEqual([]);
  gate.release();
});

test("ask-questions answer on an unknown id stays ok:false at 200", async () => {
  const res = await post("/ask-questions/does-not-exist/answer", { answers: [{ selected: ["A"] }] });
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(false);
});

test("scraper ask route regression: still requires answers", async () => {
  const { registerScrapedAskQuestions } = await import("./interactions.ts");
  const req = registerScrapedAskQuestions({
    taskId: "t-oc-scraper", runId: "r", questions: [{ question: "?", options: [{ label: "A" }] }], fingerprint: "fp-oc-scraper",
  });
  const res = await post(`/ask-questions/${req.id}/answer`, {});
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("answers required");
});

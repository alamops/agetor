import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

// Several turns per test, on a loaded machine.
setDefaultTimeout(60_000);
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.ts captures AGETOR_DATA_DIR at first import: set it at module top level, before the dynamic
// imports below (same convention as the sibling OpenCode tests).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-opencode-driver-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
// The server manager hosts the stub's fake server as a child of this process: no tmux needed.
setEnv("AGETOR_OPENCODE_SERVER_HOST", "direct");

const WORK = path.join(DATA_DIR, "work");
mkdirSync(WORK, { recursive: true });
const STUB_BIN = path.resolve(import.meta.dir, "fixtures/opencode/stub-opencode.sh");
const SERVER_ENV: Record<string, string> = {
  FAKE_OC_BUN: process.execPath,
  FAKE_OC_SPEED: "0.4",
  FAKE_OC_HEARTBEAT_MS: "60000",
};

const driver = await import("./opencode-driver.ts");
const { spawnOpencodeServerTurn, attachOpencodeServerTurn, opencodeModelRefFor, opencodeResumeNotFoundStatus, OPENCODE_STALE_SERVER_STATUS, __forTest } = driver;
const serverMod = await import("./opencode-server.ts");
const { stopOpencodeServer, getOpencodeServer, __forTest: serverTest } = serverMod;
const hub = await import("./opencode-hub.ts");
const { closeOpencodeHub } = hub;
const interactions = await import("./interactions.ts");
const { listPendingForTask, answerOpencodePermission, answerOpencodeAsk, __testing: interactionsTest } = interactions;
const { createOpencodeClient } = await import("./opencode-http.ts");
const { startFakeOpencodeServer, FAKE_OC_MARKERS } = await import("./fixtures/opencode/fake-serve.ts");
const { rmTestDataDir } = await import("./test-data-dir.ts");
const { FX_USAGE_STATUS_PREFIX } = await import("../shared/types.ts");

type Turn = ReturnType<typeof spawnOpencodeServerTurn>;
type FakeServer = Awaited<ReturnType<typeof startFakeOpencodeServer>>;
type Args = Parameters<typeof spawnOpencodeServerTurn>[0];
type ChunkRec = { stream: string; data: string; lineUuid?: string };

const H_STUB = "oc-driver-stub";
const H_INPROC = "oc-driver-inproc";
const M = FAKE_OC_MARKERS;

afterAll(async () => {
  closeOpencodeHub();
  await stopOpencodeServer(H_STUB).catch(() => {});
  serverTest.reapDirect();
  serverTest.forget();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmTestDataDir(DATA_DIR);
});

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const turn of liveTurns.splice(0)) turn.detach();
  closeOpencodeHub();
  hub.__forTest.resetBackoff();
  interactionsTest.reset();
  while (cleanups.length > 0) await cleanups.pop()!();
});

const liveTurns: Turn[] = [];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 15_000, what = "condition"): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}
async function doneWithin(t: { done: Promise<number> }, ms = 20_000): Promise<number> {
  return Promise.race([t.done, sleep(ms).then((): never => { throw new Error("done did not resolve in time"); })]);
}

let seq = 0;
interface Run {
  args: Args;
  chunks: ChunkRec[];
  replaces: Array<{ lineUuid: string; data: string }>;
  sessionIds: string[];
  taskId: string;
  runId: string;
}
function mk(over: Partial<Args> = {}): Run {
  const n = ++seq;
  const run: Run = { args: undefined as unknown as Args, chunks: [], replaces: [], sessionIds: [], taskId: `task-${n}`, runId: `run-${n}` };
  run.args = {
    taskId: run.taskId,
    runId: run.runId,
    harnessId: H_STUB,
    bin: STUB_BIN,
    env: SERVER_ENV,
    serverCwd: WORK,
    cwd: WORK,
    prompt: "",
    mode: "auto",
    model: null,
    effort: null,
    isBusy: () => true,
    onChunk: (stream, data, lineUuid) => run.chunks.push({ stream, data, lineUuid }),
    onReplace: (lineUuid, data) => run.replaces.push({ lineUuid, data }),
    onSessionId: (id) => run.sessionIds.push(id),
    ...over,
  };
  return run;
}
function start(run: Run): Turn {
  const t = spawnOpencodeServerTurn(run.args);
  liveTurns.push(t);
  return t;
}
const textOf = (run: Run, stream = "assistant") => run.chunks.filter((c) => c.stream === stream).map((c) => c.data).join("\n");
const statusesOf = (run: Run) => run.chunks.filter((c) => c.stream === "status").map((c) => c.data);
function uniqueUuids(chunks: ChunkRec[]): boolean {
  const ids = chunks.map((c) => c.lineUuid).filter((u): u is string => !!u);
  return new Set(ids).size === ids.length;
}
function stubClient() {
  const h = getOpencodeServer(H_STUB);
  if (!h) throw new Error("stub server is not running");
  return createOpencodeClient({ url: h.url, password: h.password });
}
function pending(taskId: string) {
  return listPendingForTask(taskId);
}

/** An in-process fake server plus a driver `ensureServer` that points at it. */
async function inproc(speed = 0.4, urlOverride?: string): Promise<FakeServer> {
  const fake = await startFakeOpencodeServer({ speed, password: `pw-${++seq}`, heartbeatMs: 60_000 });
  cleanups.push(() => fake.stop());
  const restore = __forTest.setDeps({
    ensureServer: async () => ({
      harnessId: H_INPROC,
      url: urlOverride ?? fake.url,
      password: fake.password,
      tmuxSession: null,
      startedAt: Date.now(),
    }),
  });
  cleanups.push(restore);
  // Child rows need task and run rows in the db; these tests are about the driver, not T12's storage.
  cleanups.push(
    __forTest.setDeps({ registerChild: () => {}, ingestChildChunks: () => {}, settleChild: () => {}, syncChild: async () => {} }),
  );
  return fake;
}
/**
 * A pass-through proxy in front of an in-process fake: it can drop the event stream's bytes, inject an
 * event frame, and it records every non-GET request the driver makes.
 */
function flakyProxy(fake: FakeServer) {
  let blocked = false;
  const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const requests: string[] = [];
  const hooks: { beforePrompt: (() => void) | null } = { beforePrompt: null };
  const enc = new TextEncoder();
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/event") {
        const up = await fetch(`${fake.url}/api/event`, { headers: req.headers });
        const reader = up.body!.getReader();
        let ctl!: ReadableStreamDefaultController<Uint8Array>;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              ctl = c;
              controllers.add(c);
            },
            async pull(controller) {
              const { value, done } = await reader.read();
              if (done) return controller.close();
              if (!blocked) controller.enqueue(value);
            },
            cancel() {
              controllers.delete(ctl);
              void reader.cancel();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (req.method !== "GET") requests.push(`${req.method} ${u.pathname}`);
      if (u.pathname.endsWith("/prompt") && req.method === "POST") hooks.beforePrompt?.();
      return fetch(`${fake.url}${u.pathname}${u.search}`, { method: req.method, headers: req.headers, body: req.body });
    },
  });
  cleanups.push(() => void proxy.stop(true));
  const url = `http://127.0.0.1:${proxy.port}`;
  cleanups.push(
    __forTest.setDeps({
      ensureServer: async () => ({ harnessId: H_INPROC, url, password: fake.password, tmuxSession: null, startedAt: Date.now() }),
    }),
  );
  return {
    hooks,
    url,
    requests,
    setBlocked(v: boolean) {
      blocked = v;
    },
    inject(envelope: Record<string, unknown>) {
      for (const c of controllers) c.enqueue(enc.encode(`data: ${JSON.stringify({ id: `evt_inject${++seq}`, ...envelope })}\n\n`));
    },
  };
}
const inprocClient = (fake: FakeServer) => createOpencodeClient({ url: fake.url, password: fake.password });
const inprocArgs = { harnessId: H_INPROC };

describe("opencodeModelRefFor", () => {
  test("splits provider/model, adds the variant, and sends nothing for the sentinel or null", () => {
    expect(opencodeModelRefFor("opencode-go/deepseek-v4.1-flash", "high")).toEqual({ providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "high" });
    expect(opencodeModelRefFor("openrouter/anthropic/claude", "auto")).toEqual({ providerID: "openrouter", id: "anthropic/claude" });
    expect(opencodeModelRefFor("a/b", null)).toEqual({ providerID: "a", id: "b" });
    expect(opencodeModelRefFor("opencode-default", "high")).toBeNull();
    expect(opencodeModelRefFor(null, "high")).toBeNull();
    expect(opencodeModelRefFor("nomodel", null)).toBeNull();
  });

  test("the resume-not-found status is the one agents.ts posts", async () => {
    const { opencodeResumeFailedStatusLine } = await import("./agents.ts");
    expect(opencodeResumeNotFoundStatus("ses_gone1234567")).toBe(opencodeResumeFailedStatusLine("ses_gone1234567"));
  });
});

describe("a turn on the stub-hosted server", () => {
  test("basic turn: chunks, usage, session id, done 0, prompt delivered verbatim", async () => {
    const prompt = "hello   there\n  with  odd spacing";
    const run = mk({ prompt });
    const t = start(run);
    expect(await doneWithin(t)).toBe(0);
    expect(run.sessionIds.length).toBe(1);
    expect(t.sessionId()).toBe(run.sessionIds[0]!);
    expect(textOf(run)).toContain("ACK: hello there with odd spacing");
    expect(statusesOf(run).some((s) => s.startsWith(FX_USAGE_STATUS_PREFIX))).toBe(true);
    expect(uniqueUuids(run.chunks)).toBe(true);
    // I1: the server received exactly the user's text.
    const msgs = await stubClient().listMessages(run.sessionIds[0]!, { limit: 50, order: "asc" });
    const users = msgs.data.filter((m: { type: string }) => m.type === "user");
    expect(users.map((m: { text: string }) => m.text)).toEqual([prompt]);
    expect(await t.steer("late")).toBe("unavailable"); // settled
  });

  test("the session is created with the title (100 code points), directory, model, variant and agent", async () => {
    const title = "😀".repeat(150);
    const run = mk({ prompt: "x", title, model: "opencode-go/deepseek-v4.1-flash", effort: "high", mode: "plan" });
    const t = start(run);
    expect(await doneWithin(t)).toBe(0);
    const s = await stubClient().getSession(run.sessionIds[0]!);
    expect(Array.from(s.title as string).length).toBe(100);
    expect(s.location.directory).toBe(WORK);
    expect(s.model).toMatchObject({ providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "high" });
    expect(s.agent).toBe("plan");
    expect(s.permissions ?? []).toEqual([]);
  });

  test("steer: accepted, delivered into the same turn, text verbatim, no new run", async () => {
    const run = mk({ prompt: `go ${M.steer}` });
    const t = start(run);
    await waitFor(() => run.chunks.some((c) => c.stream === "tool_use"), 15_000, "the tool step");
    expect(await t.steer("BANANA")).toBe("accepted");
    expect(await doneWithin(t)).toBe(0);
    expect(textOf(run)).toContain("[steer: BANANA]");
    const msgs = await stubClient().listMessages(run.sessionIds[0]!, { limit: 50, order: "asc" });
    const users = msgs.data.filter((m: { type: string }) => m.type === "user").map((m: { text: string }) => m.text);
    expect(users).toEqual([`go ${M.steer}`, "BANANA"]);
  });

  test("steer is unavailable before the prompt is sent", async () => {
    const run = mk({ prompt: "hi" });
    const t = start(run);
    expect(await t.steer("too early")).toBe("unavailable");
    expect(await doneWithin(t)).toBe(0);
  });

  test("Stop: interrupt, done 130 quickly", async () => {
    const run = mk({ prompt: `run ${M.slow}` });
    const t = start(run);
    await waitFor(() => run.chunks.some((c) => c.stream === "tool_use"), 15_000, "the tool step");
    const t0 = Date.now();
    t.kill();
    expect(await doneWithin(t, 8000)).toBe(130);
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(statusesOf(run).some((s) => s.includes("didn't confirm"))).toBe(false);
  });

  test("Stop before the session exists settles 130 and never sends the prompt", async () => {
    const run = mk({ prompt: "never sent" });
    const t = start(run);
    t.kill();
    expect(await doneWithin(t)).toBe(130);
    await sleep(300);
    expect(run.sessionIds.length).toBe(0);
  });

  test("provider error: done 1 with the error line and the quota hint", async () => {
    const run = mk({ prompt: `fail ${M.error}` });
    const t = start(run);
    expect(await doneWithin(t)).toBe(1);
    const line = statusesOf(run).find((s) => s.startsWith("opencode: Upstream request failed"));
    expect(line).toBeDefined();
    expect(line).toContain("Go subscription");
  });

  test("resume: the same session id, a second user message, no status line", async () => {
    const first = mk({ prompt: "one" });
    expect(await doneWithin(start(first))).toBe(0);
    const sid = first.sessionIds[0]!;
    const second = mk({ prompt: "two", resumeSessionId: sid });
    expect(await doneWithin(start(second))).toBe(0);
    expect(second.sessionIds).toEqual([sid]);
    expect(statusesOf(second).some((s) => s.includes("couldn't resume"))).toBe(false);
    const msgs = await stubClient().listMessages(sid, { limit: 50, order: "asc" });
    expect(msgs.data.filter((m: { type: string }) => m.type === "user").map((m: { text: string }) => m.text)).toEqual(["one", "two"]);
  });

  test("resume reconciles mode: ask adds the all-ask rule, auto removes it, plan switches the agent", async () => {
    const first = mk({ prompt: "one" });
    expect(await doneWithin(start(first))).toBe(0);
    const sid = first.sessionIds[0]!;
    const c = stubClient();
    expect((await c.getSession(sid)).permissions ?? []).toEqual([]);

    expect(await doneWithin(start(mk({ prompt: "two", resumeSessionId: sid, mode: "ask" })))).toBe(0);
    expect((await c.getSession(sid)).permissions).toEqual([{ action: "*", resource: "*", effect: "ask" }]);

    expect(await doneWithin(start(mk({ prompt: "three", resumeSessionId: sid, mode: "auto" })))).toBe(0);
    expect((await c.getSession(sid)).permissions ?? []).toEqual([]);

    expect(await doneWithin(start(mk({ prompt: "four", resumeSessionId: sid, mode: "plan" })))).toBe(0);
    expect((await c.getSession(sid)).agent).toBe("plan");

    expect(await doneWithin(start(mk({ prompt: "five", resumeSessionId: sid, mode: "auto", model: "opencode-go/other-model" })))).toBe(0);
    const s = await c.getSession(sid);
    expect(s.agent).toBe("build");
    expect(s.model).toMatchObject({ providerID: "opencode-go", id: "other-model" });
  });

  test("resume of an unknown session id starts fresh and says so", async () => {
    const run = mk({ prompt: "hi", resumeSessionId: "ses_unknownunknown1" });
    expect(await doneWithin(start(run))).toBe(0);
    expect(run.sessionIds.length).toBe(1);
    expect(run.sessionIds[0]).not.toBe("ses_unknownunknown1");
    expect(statusesOf(run)).toContain(opencodeResumeNotFoundStatus("ses_unknownunknown1"));
  });

  test("a stale server (kept because busy) posts the status line", async () => {
    const restore = __forTest.setDeps({
      ensureServer: async (spec) => ({ ...(await serverMod.ensureOpencodeServer(spec)), stale: true }),
    });
    cleanups.push(restore);
    const run = mk({ prompt: "hi" });
    expect(await doneWithin(start(run))).toBe(0);
    expect(statusesOf(run)).toContain(OPENCODE_STALE_SERVER_STATUS);
  });
});

describe("permission cards", () => {
  async function askTurn(mode: "ask" | "plan" = "ask") {
    const run = mk({ prompt: `do it ${M.permission}`, mode });
    const t = start(run);
    await waitFor(() => pending(run.taskId).length === 1, 15_000, "the permission card");
    const card = pending(run.taskId)[0]! as import("./interactions.ts").FxPermissionRequest;
    return { run, t, card };
  }

  test("Ask mode raises a card with OpenCode's own words; Allow once runs the command", async () => {
    const { run, t, card } = await askTurn();
    expect(card.kind).toBe("fx_permission");
    expect(card.harness).toBe("opencode");
    expect(card.allowReason).toBe(true);
    expect(card.mode).toBe("ask");
    expect(card.toolCall.title).toBe("shell: echo hi");
    expect(card.toolCall.kind).toBe("shell");
    // The session was created with the all-ask rule.
    expect((await stubClient().getSession(t.sessionId()!)).permissions).toEqual([{ action: "*", resource: "*", effect: "ask" }]);
    expect(answerOpencodePermission(card.id, { decision: "once" })).toBe(true);
    expect(await doneWithin(t)).toBe(0);
    expect(textOf(run)).toContain("The command ran: hi");
    expect(pending(run.taskId).length).toBe(0);
  });

  test("Plan mode raises the same card with mode plan", async () => {
    const { t, card } = await askTurn("plan");
    expect(card.mode).toBe("plan");
    answerOpencodePermission(card.id, { decision: "once" });
    expect(await doneWithin(t)).toBe(0);
  });

  test("Reject with a typed reason: the model continues with exactly those words (done 0)", async () => {
    const { run, t, card } = await askTurn();
    answerOpencodePermission(card.id, { decision: "reject", message: "not now, please" });
    expect(await doneWithin(t)).toBe(0);
    expect(textOf(run)).toContain("The command was rejected: not now, please");
  });

  test("Reject with no reason stops the turn like a Stop (done 130)", async () => {
    const { run, t, card } = await askTurn();
    answerOpencodePermission(card.id, { decision: "reject" });
    expect(await doneWithin(t)).toBe(130);
    expect(textOf(run)).not.toContain("The command ran");
  });

  test("a card cancelled by Stop does not answer the server; the interrupt ends the turn (130)", async () => {
    const { run, t, card } = await askTurn();
    answerOpencodePermission(card.id, { cancelled: true });
    t.kill();
    expect(await doneWithin(t)).toBe(130);
    expect(textOf(run)).not.toContain("The command ran");
  });

  test("Auto mode approves silently, with no card", async () => {
    const run = mk({ prompt: `do it ${M.permission}`, mode: "auto" });
    const t = start(run);
    expect(await doneWithin(t)).toBe(0);
    expect(textOf(run)).toContain("The command ran: hi");
    expect(pending(run.taskId).length).toBe(0);
  });

  test("an answer the server settled elsewhere closes the card without a reply", async () => {
    const { run, t, card } = await askTurn();
    // Another client answers it first.
    const sid = t.sessionId()!;
    void card;
    const perms = await stubClient().listPermissions(sid);
    await stubClient().replyPermission(sid, perms[0].id, { decision: "once" });
    await waitFor(() => pending(run.taskId).length === 0, 10_000, "the card to close");
    expect(await doneWithin(t)).toBe(0);
  });
});

describe("question cards", () => {
  async function questionTurn(mode: "auto" | "ask" = "auto") {
    const run = mk({ prompt: `ask me ${M.question}`, mode });
    const t = start(run);
    await waitFor(() => pending(run.taskId).some((r) => r.kind === "ask_questions"), 15_000, "the question card");
    const card = pending(run.taskId).find((r) => r.kind === "ask_questions")! as import("./interactions.ts").AskQuestionsRequest;
    return { run, t, card };
  }

  test("the form maps to the shared ask card (question, header, options, free text)", async () => {
    const { t, card } = await questionTurn();
    expect(card.source).toBe("opencode");
    expect(card.allowReason).toBe(true);
    expect(card.questions.length).toBe(1);
    const q = card.questions[0]!;
    expect(q.id).toBe("q0");
    expect(q.question).toBe("Which color do you pick?");
    expect(q.header).toBe("Pick a color");
    expect(q.multiSelect).toBe(false);
    expect(q.allowCustom).toBe(true);
    expect(q.options.map((o) => o.id)).toEqual(["Red", "Blue"]);
    answerOpencodeAsk(card.id, { outcome: "answered", answer: { q0: "Red" } });
    expect(await doneWithin(t)).toBe(0);
  });

  test("answered: the model continues with the answer (any mode)", async () => {
    const { run, t, card } = await questionTurn("ask");
    answerOpencodeAsk(card.id, { outcome: "answered", answer: { q0: "Blue" } });
    expect(await doneWithin(t)).toBe(0);
    expect(textOf(run)).toContain("You picked **Blue**");
  });

  test("skipped with no text: an empty answer, the model continues", async () => {
    const { run, t, card } = await questionTurn();
    answerOpencodeAsk(card.id, { outcome: "skipped" });
    expect(await doneWithin(t)).toBe(0);
    expect(textOf(run)).toContain("You gave no answer.");
  });

  test("skipped with a reason: the model continues with the user's words", async () => {
    const { run, t, card } = await questionTurn();
    answerOpencodeAsk(card.id, { outcome: "skipped", message: "ask me later" });
    expect(await doneWithin(t)).toBe(0);
    expect(textOf(run)).toContain("The question was declined: ask me later");
  });

  test("a card cancelled by Stop does not answer; the interrupt ends the turn", async () => {
    const { t, card } = await questionTurn();
    answerOpencodeAsk(card.id, { outcome: "cancelled" });
    t.kill();
    expect(await doneWithin(t)).toBe(130);
  });
});

describe("subagents", () => {
  test("a child session is registered, its chunks ingested and it is settled", async () => {
    const registered: Array<Record<string, unknown>> = [];
    const ingested: Array<{ childSessionId: string; chunks: Array<{ stream: string; data: string; lineUuid: string }> }> = [];
    const settled: Array<Record<string, unknown>> = [];
    cleanups.push(
      __forTest.setDeps({
        registerChild: (a) => void registered.push(a as unknown as Record<string, unknown>),
        ingestChildChunks: (a) => void ingested.push(a),
        settleChild: (a) => void settled.push(a as unknown as Record<string, unknown>),
        syncChild: async () => {},
      }),
    );
    const run = mk({ prompt: `delegate ${M.subagent}` });
    const t = start(run);
    expect(await doneWithin(t)).toBe(0);
    expect(registered.length).toBe(1);
    const child = registered[0]!;
    expect(child).toMatchObject({ taskId: run.taskId, runId: run.runId, parentSessionId: run.sessionIds[0], depth: 1, background: false, agent: "general" });
    expect(typeof child.childSessionId).toBe("string");
    expect(child.title).toBe("Run echo CHILD");
    const childId = child.childSessionId as string;
    const chunks = ingested.filter((i) => i.childSessionId === childId).flatMap((i) => i.chunks);
    expect(chunks.some((c) => c.stream === "tool_use" && c.data.includes("echo CHILD"))).toBe(true);
    expect(chunks.some((c) => c.stream === "assistant" && c.data.includes("CHILD"))).toBe(true);
    expect(chunks.every((c) => c.lineUuid.startsWith(`opencode:${childId}:`))).toBe(true);
    expect(settled).toEqual([{ taskId: run.taskId, childSessionId: childId, outcome: "completed" }]);
    // The child's lines never reach the parent run.
    expect(run.chunks.some((c) => c.lineUuid?.includes(childId))).toBe(false);
  });

  test("a background subagent call is flagged background", async () => {
    const registered: Array<Record<string, unknown>> = [];
    cleanups.push(
      __forTest.setDeps({
        registerChild: (a) => void registered.push(a as unknown as Record<string, unknown>),
        ingestChildChunks: () => {},
        settleChild: () => {},
        syncChild: async () => {},
      }),
    );
    const run = mk({ prompt: `delegate ${M.wake}` });
    expect(await doneWithin(start(run))).toBe(0);
    expect(registered.length).toBe(1);
    expect(registered[0]).toMatchObject({ background: true, depth: 1 });
  });
});

describe("restart survival and server wake (attach)", () => {
  test("reattach mid-turn: remaining chunks once, the same card, done 0", async () => {
    const fake = await inproc();
    const since = Date.now();
    const a = mk({ ...inprocArgs, prompt: `do it ${M.permission}`, mode: "ask" });
    const first = start(a);
    await waitFor(() => pending(a.taskId).length === 1, 15_000, "the permission card");
    const cardId = pending(a.taskId)[0]!.id;
    const sid = first.sessionId()!;
    first.detach(); // the core goes away; the turn keeps running on the server

    const b = mk({ ...inprocArgs, taskId: a.taskId, runId: a.runId, prompt: "unused", mode: "ask" });
    const { prompt: _p, title: _t, resumeSessionId: _r, ...attachBase } = b.args;
    const second = attachOpencodeServerTurn({ ...attachBase, sessionId: sid, sinceMs: since, reason: "reattach" });
    liveTurns.push(second as Turn);
    await waitFor(() => b.chunks.some((c) => c.stream === "assistant"), 15_000, "the snapshot seed");
    // Still exactly one card, and it is the one the first driver raised.
    expect(pending(a.taskId).map((c) => c.id)).toEqual([cardId]);
    answerOpencodePermission(cardId, { decision: "once" });
    expect(await doneWithin(second)).toBe(0);
    expect(uniqueUuids(b.chunks)).toBe(true);
    const text = textOf(b);
    expect(text).toContain("I'll run it."); // from the snapshot
    expect(text).toContain("The command ran: hi"); // live
    expect(text.split("The command ran: hi").length).toBe(2);
    expect(pending(a.taskId).length).toBe(0);
    void fake;
  });

  test("attach to a turn that already finished settles from the snapshot, 0 and 1", async () => {
    const fake = await inproc();
    const since = Date.now();
    const ok = mk({ ...inprocArgs, prompt: "all good" });
    const first = start(ok);
    expect(await doneWithin(first)).toBe(0);
    const { prompt: _p, title: _t, resumeSessionId: _r, ...base } = ok.args;
    const again = mk({ ...inprocArgs });
    const twin = attachOpencodeServerTurn({ ...base, onChunk: again.args.onChunk, sessionId: first.sessionId()!, sinceMs: since, reason: "reattach" });
    expect(await doneWithin(twin)).toBe(0);
    expect(again.chunks.some((c) => c.stream === "assistant" && c.data.includes("ACK: all good"))).toBe(true);

    const bad = mk({ ...inprocArgs, prompt: `no ${M.error}` });
    const firstBad = start(bad);
    expect(await doneWithin(firstBad)).toBe(1);
    const badAgain = mk({ ...inprocArgs });
    const { prompt: _p2, title: _t2, resumeSessionId: _r2, ...base2 } = bad.args;
    const twinBad = attachOpencodeServerTurn({ ...base2, onChunk: badAgain.args.onChunk, sessionId: firstBad.sessionId()!, sinceMs: since, reason: "reattach" });
    expect(await doneWithin(twinBad)).toBe(1);
    expect(badAgain.chunks.some((c) => c.stream === "status" && c.data.startsWith("opencode: Upstream request failed"))).toBe(true);
    void fake;
  });

  test("wake attach follows only the wake execution, not the earlier turn", async () => {
    const fake = await inproc();
    const a = mk({ ...inprocArgs, prompt: `launch ${M.wake}` });
    const first = start(a);
    expect(await doneWithin(first)).toBe(0);
    expect(textOf(a)).toContain("LAUNCHED");
    const sid = first.sessionId()!;
    const c = inprocClient(fake);
    let syntheticAt = 0;
    // Poll the snapshot for the synthetic message the server queued when the child finished.
    const t0 = Date.now();
    while (syntheticAt === 0 && Date.now() - t0 < 15_000) {
      const msgs = await c.listMessages(sid, { limit: 50, order: "desc" });
      const syn = msgs.data.find((m: { type: string }) => m.type === "synthetic");
      if (syn) syntheticAt = syn.time.created;
      else await sleep(25);
    }
    expect(syntheticAt).toBeGreaterThan(0);
    const b = mk({ ...inprocArgs, taskId: "wake-task", runId: "wake-run" });
    const { prompt: _p, title: _t, resumeSessionId: _r, ...base } = b.args;
    const woken = attachOpencodeServerTurn({ ...base, sessionId: sid, sinceMs: syntheticAt, reason: "wake" });
    expect(await doneWithin(woken)).toBe(0);
    const text = textOf(b);
    expect(text).toContain("The background subagent finished");
    expect(text).not.toContain("LAUNCHED");
  });
});

describe("failure and edge paths", () => {
  test("the event stream is lost for good: status line and done 1", async () => {
    const fake = await inproc();
    hub.__forTest.setBackoff({ baseMs: 20, maxMs: 40, maxFailures: 3 });
    const run = mk({ ...inprocArgs, prompt: `run ${M.slow}` });
    const t = start(run);
    await waitFor(() => run.chunks.some((c) => c.stream === "tool_use"), 15_000, "the tool step");
    fake.dropEventStreams();
    void fake.stop();
    expect(await doneWithin(t, 15_000)).toBe(1);
    expect(statusesOf(run).some((s) => s.includes("connection lost"))).toBe(true);
  });

  test("a Stop OpenCode never confirms settles 130 with a status line instead of hanging", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    // Liveness is slower than the confirm timer here: only the timer may settle this turn.
    cleanups.push(__forTest.setTimings({ stopConfirmMs: 250, livenessMs: 60_000 }));
    const run = mk({ ...inprocArgs, prompt: `run ${M.slow}` });
    const t = start(run);
    await waitFor(() => run.chunks.some((c) => c.stream === "tool_use"), 15_000, "the tool step");
    proxy.setBlocked(true); // the interrupted terminal can never reach the driver
    t.kill();
    expect(await doneWithin(t, 8000)).toBe(130);
    expect(statusesOf(run)).toContain("OpenCode didn't confirm the stop");
  });

  test("the event stream never opens: the driver's own deadline ends the turn (done 1)", async () => {
    const fake = await inproc();
    const hang = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/api/event") {
          return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
        }
        return fetch(`${fake.url}${u.pathname}${u.search}`, { method: req.method, headers: req.headers, body: req.body });
      },
    });
    cleanups.push(() => void hang.stop(true));
    cleanups.push(
      __forTest.setDeps({
        ensureServer: async () => ({ harnessId: H_INPROC, url: `http://127.0.0.1:${hang.port}`, password: fake.password, tmuxSession: null, startedAt: Date.now() }),
      }),
    );
    cleanups.push(__forTest.setTimings({ readyMs: 300 }));
    const run = mk({ ...inprocArgs, prompt: "hi" });
    const t = start(run);
    expect(await doneWithin(t, 8000)).toBe(1);
    expect(statusesOf(run).some((s) => s.includes("couldn't watch the OpenCode session"))).toBe(true);
  });

  test("a terminal event lost on the stream is recovered by the liveness check", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    cleanups.push(__forTest.setTimings({ livenessMs: 150 }));
    const run = mk({ ...inprocArgs, prompt: `go ${M.steer}` });
    const t = start(run);
    await waitFor(() => run.chunks.some((c) => c.stream === "tool_use"), 15_000, "the tool step");
    proxy.setBlocked(true); // from here on the stream delivers nothing; the turn still finishes on the server
    expect(await doneWithin(t, 15_000)).toBe(0);
    expect(textOf(run)).toContain("Done."); // the final text arrived by snapshot
    expect(uniqueUuids(run.chunks)).toBe(true);
  });

  test("a terminal from an earlier execution does not end the turn", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const run = mk({ ...inprocArgs, prompt: "the real turn" });
    // The tail of a previous execution reaches us just before our prompt is delivered.
    proxy.hooks.beforePrompt = () => {
      proxy.inject({ type: "session.execution.succeeded", data: { sessionID: run.sessionIds[0] } });
      proxy.hooks.beforePrompt = null;
    };
    const t = start(run);
    expect(await doneWithin(t)).toBe(0);
    expect(textOf(run)).toContain("ACK: the real turn");
  });

  test("an unreachable server: status line, done 1, no throw", async () => {
    cleanups.push(
      __forTest.setDeps({
        ensureServer: async () => {
          throw new Error("OpenCode server is not responding");
        },
      }),
    );
    const run = mk({ prompt: "hi" });
    expect(await doneWithin(start(run))).toBe(1);
    expect(statusesOf(run).some((s) => s.includes("couldn't start the OpenCode server"))).toBe(true);
  });

  test("a form that is not a question is left alone (no card, no reply, no cancel)", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const run = mk({ ...inprocArgs, prompt: `run ${M.slow}`, mode: "auto" });
    const t = start(run);
    await waitFor(() => run.chunks.some((c) => c.stream === "tool_use"), 15_000, "the tool step");
    const sid = t.sessionId()!;
    const warn = console.warn;
    console.warn = () => {};
    cleanups.push(() => void (console.warn = warn));
    proxy.inject({
      type: "form.created",
      data: { form: { id: "frm_elicit1", sessionID: sid, title: "Server asks", metadata: { kind: "mcp-elicitation" }, fields: [{ key: "a", type: "string" }] } },
    });
    await sleep(250);
    expect(pending(run.taskId).length).toBe(0);
    expect(proxy.requests.filter((r) => r.includes("/form"))).toEqual([]);
    t.kill();
    expect(await doneWithin(t)).toBe(130);
  });

  test("a question form injected on the stream raises one card, once", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const run = mk({ ...inprocArgs, prompt: `run ${M.slow}`, mode: "auto" });
    const t = start(run);
    await waitFor(() => run.chunks.some((c) => c.stream === "tool_use"), 15_000, "the tool step");
    const form = {
      id: "frm_q1",
      sessionID: t.sessionId()!,
      title: "Questions",
      metadata: { kind: "question" },
      fields: [{ key: "q0", title: "Pick", description: "Pick several", type: "multiselect", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }],
    };
    proxy.inject({ type: "form.created", data: { form } });
    proxy.inject({ type: "form.created", data: { form } });
    await waitFor(() => pending(run.taskId).length === 1, 5000, "the card");
    await sleep(100);
    expect(pending(run.taskId).length).toBe(1);
    const q = (pending(run.taskId)[0] as import("./interactions.ts").AskQuestionsRequest).questions[0]!;
    expect(q.multiSelect).toBe(true);
    expect(q.allowCustom).toBe(false);
    // The server settled it elsewhere: the card closes and no reply goes out.
    proxy.inject({ type: "form.cancelled", data: { id: "frm_q1", sessionID: t.sessionId() } });
    await waitFor(() => pending(run.taskId).length === 0, 5000, "the card to close");
    expect(proxy.requests.filter((r) => r.includes("/form"))).toEqual([]);
    t.kill();
    expect(await doneWithin(t)).toBe(130);
  });
});

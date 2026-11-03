import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

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
// `bun test` runs every file in one process and many siblings leave `AGETOR_TMUX_BIN=/bin/echo` behind:
// whatever tmux the manager still calls is the real one, on a socket of this file's own (restored in afterAll).
beforeAll(() => {
  setEnv("AGETOR_TMUX_BIN", undefined);
  setEnv("AGETOR_TMUX_SOCKET", `agetor-test-ocdrv-${process.pid}`);
});

const WORK = path.join(DATA_DIR, "work");
mkdirSync(WORK, { recursive: true });
const STUB_BIN = path.resolve(import.meta.dir, "fixtures/opencode/stub-opencode.sh");
const SERVER_ENV: Record<string, string> = {
  FAKE_OC_BUN: process.execPath,
  FAKE_OC_SPEED: "0.4",
  // Below the SSE reader's 45 s stall watchdog, so a quiet stretch never reads as a dead stream.
  FAKE_OC_HEARTBEAT_MS: "2000",
};

const driver = await import("./opencode-driver.ts");
const {
  spawnOpencodeServerTurn,
  attachOpencodeServerTurn,
  attachOpencodeServerLinger,
  opencodeModelRefFor,
  OPENCODE_STALE_SERVER_STATUS,
  OPENCODE_EMPTY_REJECT_MESSAGE,
  setOpencodeSteerRequeueHandler,
  __forTest,
} = driver;
const { opencodeResumeFailedStatusLine } = await import("../shared/opencode.ts");
const { opencodeChildSessionOf, wasOpencodeChildStoppedByAgetor, registerOpencodeChildSession, orphanRunningOpencodeChildrenOfTask } = await import("./opencode-subagents.ts");
const serverMod = await import("./opencode-server.ts");
const { stopOpencodeServer, getOpencodeServer, __forTest: serverTest } = serverMod;
const hub = await import("./opencode-hub.ts");
const { closeOpencodeHub } = hub;
const interactions = await import("./interactions.ts");
const { listPendingForTask, answerOpencodePermission, answerOpencodeAsk, cancelPendingForTask, __testing: interactionsTest } = interactions;
const { createOpencodeClient } = await import("./opencode-http.ts");
const { startFakeOpencodeServer, FAKE_OC_MARKERS } = await import("./fixtures/opencode/fake-serve.ts");
const { rmTestDataDir } = await import("./test-data-dir.ts");
const { FX_USAGE_STATUS_PREFIX } = await import("../shared/types.ts");
const db = await import("./db.ts");
import type { Task } from "../shared/types.ts";

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
/** Tasks seeded into the shared db; removed (with their runs and subagent rows) after each test. */
const seededTasks: string[] = [];
afterEach(async () => {
  for (const id of seededTasks.splice(0)) {
    try {
      db.tasks.delete(id);
    } catch {
      /* already gone */
    }
  }
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
  /** `onUserStop` calls, and the order of "userStop" / "done" markers a test pushes. */
  userStops: number;
  events: string[];
}
function mk(over: Partial<Args> = {}): Run {
  const n = ++seq;
  const run: Run = { args: undefined as unknown as Args, chunks: [], replaces: [], sessionIds: [], taskId: `task-${n}`, runId: `run-${n}`, userStops: 0, events: [] };
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
    onUserStop: () => {
      run.userStops++;
      run.events.push("userStop");
    },
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

/** A task and run row, so the real subagent storage (T12) accepts child rows. */
function seedTask(): { taskId: string; runId: string } {
  const taskId = `task-drv-${++seq}-${Date.now()}`;
  const runId = `run-drv-${seq}-${Date.now()}`;
  const now = Date.now();
  const t: Task = {
    id: taskId, title: "t", prompt: "p", agent: "opencode", workdir: "/tmp", isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: null, model: null, effort: null, speed: "off", maxMode: false, opencodeServer: "shared",
    references: [], backlog: [], plans: [], draft: null, column: "running", runId: null,
    createdAt: now, updatedAt: now, hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0, archivedAt: null,
  };
  db.tasks.insert(t);
  seededTasks.push(taskId);
  db.runs.insert({
    id: runId, taskId, agent: "opencode", status: "running", startedAt: now, endedAt: null, exitCode: null,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  return { taskId, runId };
}
const childRows = (taskId: string) => db.subagents.listForTask(taskId);

/** Where a Stop's undelivered steers go (the orchestrator's follow-up queue in production). */
function captureRequeue(): Array<{ taskId: string; runId: string; texts: string[] }> {
  const got: Array<{ taskId: string; runId: string; texts: string[] }> = [];
  const prev = setOpencodeSteerRequeueHandler((a) => void got.push(a));
  cleanups.push(() => void setOpencodeSteerRequeueHandler(prev));
  return got;
}

/** An in-process fake server plus a driver `ensureServer` that points at it. */
async function inproc(speed = 0.4, opts: { realChildren?: boolean } = {}): Promise<FakeServer> {
  const fake = await startFakeOpencodeServer({ speed, password: `pw-${++seq}`, heartbeatMs: 2000 });
  cleanups.push(() => {
    // Streams whose consumer vanished (a proxy, a detached driver) would keep `stop()` waiting.
    fake.dropEventStreams();
    return fake.stop();
  });
  const restore = __forTest.setDeps({
    ensureServer: async () => ({
      harnessId: H_INPROC,
      url: fake.url,
      password: fake.password,
      tmuxSession: null,
      startedAt: Date.now(),
    }),
  });
  cleanups.push(restore);
  // Child rows need task and run rows in the db; these tests are about the driver, not T12's storage.
  if (!opts.realChildren) {
    cleanups.push(
      __forTest.setDeps({
        registerChild: () => {},
        ingestChildChunks: () => {},
        settleChild: () => {},
        syncChild: async () => {},
        openChildSessions: () => [],
        settledChildSessions: () => [],
      }),
    );
  }
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
  const gets: string[] = [];
  const hooks = {
    beforePrompt: null as (() => void) | null,
    /** The next N permission replies are answered 400 by the proxy (the fake never sees them). */
    failReplies: 0,
    /** The first prompt POST is forwarded, then its answer is held this long. */
    delayFirstPromptMs: 0,
    /** The next N message listings answer 500. */
    failMessageLists: 0,
    promptBodies: [] as string[],
    /** `start:<text>` when a prompt POST arrives, `end:<text>` when its answer goes back. */
    promptLog: [] as string[],
    /** Hold the answer to the prompt with this text until a prompt with `until` arrives, or `maxMs`. */
    holdPrompt: null as { text: string; until: string; maxMs: number } | null,
    /** One-shot: runs after the next message listing was read upstream, before it is answered. */
    onMessageList: null as (() => Promise<void>) | null,
    /** One-shot: runs after the next permission listing was read upstream, before it is answered. */
    onPermissionList: null as (() => Promise<void>) | null,
    /** The first prompt POST is NOT forwarded; its answer is held this long (past the client's budget). */
    swallowFirstPromptMs: 0,
    /** The first prompt POST is answered 409 ConflictError by the proxy (the fake never sees it). */
    conflictFirstPrompt: false,
    /** Bodies of the permission replies the driver sent, by path. */
    replyBodies: [] as Array<{ path: string; body: string }>,
    /** `start:<sid>` when an interrupt POST arrives, `end:<sid>` when its answer goes back (tests add their own marks). */
    interruptLog: [] as string[],
    /** Hold the answer to this session's interrupt (forwarded first) for `ms`. */
    holdInterrupt: null as { sessionId: string; ms: number } | null,
    /** One-shot: runs before the next message listing is forwarded (or failed by `failMessageLists`). */
    beforeMessageList: null as (() => Promise<void>) | null,
  };
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
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const bodyText = hasBody ? await req.text() : undefined;
      if (req.method === "GET") gets.push(u.pathname);
      else requests.push(`${req.method} ${u.pathname}`);
      const isPrompt = u.pathname.endsWith("/prompt") && req.method === "POST";
      if (req.method === "POST" && /\/permission\/[^/]+\/reply$/.test(u.pathname)) hooks.replyBodies.push({ path: u.pathname, body: bodyText ?? "" });
      if (isPrompt && hooks.conflictFirstPrompt) {
        hooks.conflictFirstPrompt = false;
        hooks.promptBodies.push(bodyText ?? "");
        return Response.json({ _tag: "ConflictError", message: "Prompt message ID conflicts with an existing durable record" }, { status: 409 });
      }
      if (isPrompt && hooks.swallowFirstPromptMs > 0) {
        const ms = hooks.swallowFirstPromptMs;
        hooks.swallowFirstPromptMs = 0;
        hooks.promptBodies.push(bodyText ?? "");
        await sleep(ms);
        return Response.json({ _tag: "UnknownError", message: "swallowed by the test" }, { status: 503 });
      }
      if (req.method === "POST" && /\/permission\/[^/]+\/reply$/.test(u.pathname) && hooks.failReplies > 0) {
        hooks.failReplies--;
        return Response.json({ _tag: "InvalidRequestError", message: "rejected by the test" }, { status: 400 });
      }
      if (req.method === "GET" && u.pathname.endsWith("/message") && hooks.beforeMessageList) {
        const run = hooks.beforeMessageList;
        hooks.beforeMessageList = null;
        await run();
      }
      const interruptOf = req.method === "POST" ? /^\/api\/session\/([^/]+)\/interrupt$/.exec(u.pathname)?.[1] : undefined;
      if (interruptOf) hooks.interruptLog.push(`start:${interruptOf}`);
      if (req.method === "GET" && u.pathname.endsWith("/message") && hooks.failMessageLists > 0) {
        hooks.failMessageLists--;
        return Response.json({ _tag: "UnknownError", message: "boom" }, { status: 500 });
      }
      const promptText = isPrompt ? String((JSON.parse(bodyText || "{}") as { text?: unknown }).text ?? "") : "";
      if (isPrompt) {
        hooks.promptBodies.push(bodyText ?? "");
        hooks.promptLog.push(`start:${promptText}`);
        hooks.beforePrompt?.();
      }
      const res = await fetch(`${fake.url}${u.pathname}${u.search}`, { method: req.method, headers: req.headers, body: bodyText });
      if (isPrompt && hooks.delayFirstPromptMs > 0) {
        const ms = hooks.delayFirstPromptMs;
        hooks.delayFirstPromptMs = 0;
        await sleep(ms);
      }
      if (interruptOf) {
        const h = hooks.holdInterrupt;
        if (h && h.sessionId === interruptOf) await sleep(h.ms);
        const body = await res.text();
        hooks.interruptLog.push(`end:${interruptOf}`);
        return new Response(body, { status: res.status, headers: res.headers });
      }
      const hold = hooks.holdPrompt;
      if (isPrompt && hold && hold.text === promptText) {
        hooks.holdPrompt = null;
        const t0 = Date.now();
        while (!hooks.promptLog.includes(`start:${hold.until}`) && Date.now() - t0 < hold.maxMs) await sleep(10);
      }
      const listHook =
        req.method === "GET" && u.pathname.endsWith("/message") ? "onMessageList" : req.method === "GET" && u.pathname.endsWith("/permission") ? "onPermissionList" : null;
      if (listHook && hooks[listHook]) {
        const run = hooks[listHook]!;
        hooks[listHook] = null;
        const body = await res.text();
        await run();
        return new Response(body, { status: res.status, headers: res.headers });
      }
      if (isPrompt) {
        const body = await res.text();
        hooks.promptLog.push(`end:${promptText}`);
        return new Response(body, { status: res.status, headers: res.headers });
      }
      return res;
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
    gets,
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

  test("a steer sent before the first prompt returned waits for it and is sent after it", async () => {
    const requeued = captureRequeue();
    const run = mk({ prompt: `go ${M.slow}` });
    const t = start(run);
    expect(await t.steer("early words")).toBe("accepted");
    const sid = t.sessionId()!;
    // The steer waits in the inbox behind the slow tool, after the initial prompt (which was delivered).
    const users = (await stubClient().listMessages(sid, { limit: 50, order: "asc" })).data.filter((m: { type: string }) => m.type === "user");
    expect(users.map((m: { text: string }) => m.text)).toEqual([`go ${M.slow}`]);
    expect((await stubClient().listInbox(sid)).map((i) => i.text)).toEqual(["early words"]);
    t.kill();
    expect(await doneWithin(t, 10_000)).toBe(130);
    // Stopped before it was delivered: taken back out of the inbox and handed back for the next turn.
    expect(requeued).toEqual([{ taskId: run.taskId, runId: run.runId, texts: ["early words"] }]);
    expect(await stubClient().listInbox(sid)).toEqual([]);
  });

  test("a steer waiting for the first prompt is released as unavailable when the turn is stopped", async () => {
    const run = mk({ prompt: "x" });
    const t = start(run);
    const early = t.steer("never delivered");
    t.kill();
    expect(await early).toBe("unavailable");
    expect(await doneWithin(t)).toBe(130);
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
    expect(run.userStops).toBe(0); // the orchestrator issued this stop itself
  });

  test("Stop before the session exists settles 130 and never touches the server", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    // The server handle is held until after the Stop: a (wrongly) continuing start sequence would post
    // createSession as soon as it is released.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const proxied = { harnessId: H_INPROC, url: proxy.url, password: fake.password, tmuxSession: null, startedAt: Date.now() };
    cleanups.push(__forTest.setDeps({ ensureServer: async () => (await gate, proxied) }));
    const run = mk({ ...inprocArgs, prompt: "never sent" });
    const t = start(run);
    t.kill();
    expect(await doneWithin(t)).toBe(130);
    release();
    // A sentinel turn through the same proxy: by its end, anything the stopped one sent has arrived.
    const sentinel = mk({ ...inprocArgs, prompt: "sentinel" });
    expect(await doneWithin(start(sentinel))).toBe(0);
    expect(proxy.requests.filter((r) => r === "POST /api/session").length).toBe(1); // the sentinel's session only
    expect(proxy.hooks.promptBodies.map((b) => (JSON.parse(b) as { text: string }).text)).toEqual(["sentinel"]);
    expect(run.sessionIds.length).toBe(0);
    expect(statusesOf(run)).toEqual([]);
  });

  test("provider error on a Zen model: done 1 with the error line and the quota hint (the turn's model reaches the mapper)", async () => {
    const run = mk({ prompt: `fail ${M.error}`, model: "opencode/zen-test-model" });
    const t = start(run);
    expect(await doneWithin(t)).toBe(1);
    const line = statusesOf(run).find((s) => s.startsWith("opencode: Upstream request failed"));
    expect(line).toBeDefined();
    expect(line).toContain("Go subscription");
  });

  test("provider error on a Go model: the error line without the Zen hint", async () => {
    const run = mk({ prompt: `fail ${M.error}`, model: "opencode-go/deepseek-v4.1-flash" });
    expect(await doneWithin(start(run))).toBe(1);
    const line = statusesOf(run).find((s) => s.startsWith("opencode: Upstream request failed"));
    expect(line).toBeDefined();
    expect(line).not.toContain("Go subscription");
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
    expect(statusesOf(run)).toContain(opencodeResumeFailedStatusLine("ses_unknownunknown1"));
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

  test("Reject with a typed reason sends exactly that reason", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const run = mk({ ...inprocArgs, prompt: `do it ${M.permission}`, mode: "ask" });
    const t = start(run);
    await waitFor(() => pending(run.taskId).length === 1, 15_000, "the permission card");
    answerOpencodePermission(pending(run.taskId)[0]!.id, { decision: "reject", message: "not now, please" });
    expect(await doneWithin(t)).toBe(0);
    expect(proxy.hooks.replyBodies.map((r) => JSON.parse(r.body))).toEqual([{ decision: "reject", message: "not now, please" }]);
  });

  test("Reject with no reason refuses the tool and the turn continues (done 0): the reply carries a single space", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const run = mk({ ...inprocArgs, prompt: `do it ${M.permission}`, mode: "ask" });
    const t = start(run);
    await waitFor(() => pending(run.taskId).length === 1, 15_000, "the permission card");
    answerOpencodePermission(pending(run.taskId)[0]!.id, { decision: "reject" });
    expect(await doneWithin(t)).toBe(0);
    expect(OPENCODE_EMPTY_REJECT_MESSAGE).toBe(" ");
    expect(proxy.hooks.replyBodies.map((r) => JSON.parse(r.body))).toEqual([{ decision: "reject", message: " " }]);
    expect(textOf(run)).not.toContain("The command ran");
    expect(textOf(run)).toContain("The command was rejected:");
    expect(run.userStops).toBe(0);
  });

  test("a reason of only spaces counts as none (still the single space, never the user's whitespace)", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const run = mk({ ...inprocArgs, prompt: `do it ${M.permission}`, mode: "ask" });
    const t = start(run);
    await waitFor(() => pending(run.taskId).length === 1, 15_000, "the permission card");
    answerOpencodePermission(pending(run.taskId)[0]!.id, { decision: "reject", message: "   " });
    expect(await doneWithin(t)).toBe(0);
    expect(proxy.hooks.replyBodies.map((r) => JSON.parse(r.body))).toEqual([{ decision: "reject", message: " " }]);
  });

  test("one reject refuses the session's other requests too: their cards close on OpenCode's permission.replied, with no reply from us", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const run = mk({ ...inprocArgs, prompt: `run ${M.slow}`, mode: "plan" });
    const t = start(run);
    await waitFor(() => run.chunks.some((c) => c.stream === "tool_use"), 15_000, "the tool step");
    const sid = t.sessionId()!;
    proxy.inject({ type: "permission.asked", data: { id: "per_sib_a", sessionID: sid, action: "shell", resources: ["echo a"] } });
    proxy.inject({ type: "permission.asked", data: { id: "per_sib_b", sessionID: sid, action: "shell", resources: ["echo b"] } });
    await waitFor(() => pending(run.taskId).length === 2, 10_000, "both cards");
    const cardA = pending(run.taskId).find((r) => r.kind === "fx_permission" && r.toolCall.title === "shell: echo a")!;
    answerOpencodePermission(cardA.id, { decision: "reject" });
    await waitFor(() => proxy.hooks.replyBodies.length === 1, 10_000, "the reply to A");
    // OpenCode rejects B with the same message and says so on the stream.
    proxy.inject({ type: "permission.replied", data: { sessionID: sid, requestID: "per_sib_b", reply: "reject" } });
    await waitFor(() => pending(run.taskId).length === 0, 10_000, "B's card to close");
    expect(proxy.hooks.replyBodies.map((r) => r.path)).toEqual([`/api/session/${sid}/permission/per_sib_a/reply`]);
    t.kill();
    expect(await doneWithin(t)).toBe(130);
  });

  test("a card cancelled by Stop does not answer the server; the interrupt ends the turn (130)", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const run = mk({ ...inprocArgs, prompt: `do it ${M.permission}`, mode: "ask" });
    const t = start(run);
    await waitFor(() => pending(run.taskId).length === 1, 15_000, "the permission card");
    answerOpencodePermission(pending(run.taskId)[0]!.id, { cancelled: true });
    t.kill();
    expect(await doneWithin(t)).toBe(130);
    expect(textOf(run)).not.toContain("The command ran");
    expect(proxy.requests.filter((r) => /\/permission\/[^/]+\/reply$/.test(r))).toEqual([]);
    expect(proxy.requests.some((r) => r.endsWith("/interrupt"))).toBe(true);
  });

  test("Auto mode approves silently, with no card", async () => {
    const run = mk({ prompt: `do it ${M.permission}`, mode: "auto" });
    const t = start(run);
    expect(await doneWithin(t)).toBe(0);
    expect(textOf(run)).toContain("The command ran: hi");
    expect(pending(run.taskId).length).toBe(0);
  });

  test("an answer the server settled elsewhere closes the card without a reply from us", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const run = mk({ ...inprocArgs, prompt: `do it ${M.permission}`, mode: "ask" });
    const t = start(run);
    await waitFor(() => pending(run.taskId).length === 1, 15_000, "the permission card");
    // Another client answers it first (straight to the server, not through the proxy).
    const sid = t.sessionId()!;
    const c = inprocClient(fake);
    const perms = await c.listPermissions(sid);
    await c.replyPermission(sid, perms[0].id, { decision: "once" });
    await waitFor(() => pending(run.taskId).length === 0, 10_000, "the card to close");
    expect(await doneWithin(t)).toBe(0);
    expect(proxy.requests.filter((r) => /\/permission\/[^/]+\/reply$/.test(r))).toEqual([]);
  });

  test("a failed reply puts the card back; the second answer goes through (done 0)", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    proxy.hooks.failReplies = 1;
    const run = mk({ ...inprocArgs, prompt: `do it ${M.permission}`, mode: "ask" });
    const t = start(run);
    await waitFor(() => pending(run.taskId).length === 1, 15_000, "the permission card");
    const first = pending(run.taskId)[0]!.id;
    answerOpencodePermission(first, { decision: "once" });
    // The reply is refused; the card comes back from the server's list under a new id.
    await waitFor(() => pending(run.taskId).length === 1 && pending(run.taskId)[0]!.id !== first, 15_000, "the card to come back");
    expect(statusesOf(run).some((s) => s.includes("didn't accept the permission answer"))).toBe(true);
    answerOpencodePermission(pending(run.taskId)[0]!.id, { decision: "once" });
    expect(await doneWithin(t)).toBe(0);
    expect(textOf(run)).toContain("The command ran: hi");
  });

  test("no reply goes out after Stop, even for an answered card", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    cleanups.push(__forTest.setTimings({ stopConfirmMs: 400, livenessMs: 60_000 }));
    const run = mk({ ...inprocArgs, prompt: `do it ${M.permission}`, mode: "ask" });
    const t = start(run);
    await waitFor(() => pending(run.taskId).length === 1, 15_000, "the permission card");
    const id = pending(run.taskId)[0]!.id;
    proxy.setBlocked(true); // the interrupt's terminal will not arrive; the confirm timer settles
    t.kill();
    answerOpencodePermission(id, { decision: "once" });
    expect(await doneWithin(t, 8000)).toBe(130);
    expect(proxy.requests.filter((r) => /\/permission\/[^/]+\/reply$/.test(r))).toEqual([]);
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
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const run = mk({ ...inprocArgs, prompt: `ask me ${M.question}` });
    const t = start(run);
    await waitFor(() => pending(run.taskId).some((r) => r.kind === "ask_questions"), 15_000, "the question card");
    answerOpencodeAsk(pending(run.taskId)[0]!.id, { outcome: "cancelled" });
    t.kill();
    expect(await doneWithin(t)).toBe(130);
    expect(proxy.requests.filter((r) => r.includes("/form"))).toEqual([]);
    expect(proxy.requests.some((r) => r.endsWith("/interrupt"))).toBe(true);
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
  test("reattach after a real restart (registry gone): the request gets a new card, one reply, text once, done 0", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const since = Date.now();
    const a = mk({ ...inprocArgs, prompt: `do it ${M.permission}`, mode: "ask" });
    const first = start(a);
    await waitFor(() => pending(a.taskId).length === 1, 15_000, "the permission card");
    const cardId = pending(a.taskId)[0]!.id;
    const sid = first.sessionId()!;
    first.detach(); // the core goes away; the turn keeps running on the server
    interactionsTest.reset(); // ...and so does its in-memory card registry

    const b = mk({ ...inprocArgs, taskId: a.taskId, runId: a.runId, prompt: "unused", mode: "ask" });
    const { prompt: _p, title: _t, resumeSessionId: _r, ...attachBase } = b.args;
    const second = attachOpencodeServerTurn({ ...attachBase, sessionId: sid, sinceMs: since, reason: "reattach" });
    liveTurns.push(second as Turn);
    // The catch-up re-lists the server's open request and raises a fresh card for it.
    await waitFor(() => pending(a.taskId).length === 1 && pending(a.taskId)[0]!.id !== cardId, 15_000, "the re-raised card");
    expect(pending(a.taskId).length).toBe(1);
    answerOpencodePermission(pending(a.taskId)[0]!.id, { decision: "once" });
    expect(await doneWithin(second)).toBe(0);
    expect(uniqueUuids(b.chunks)).toBe(true);
    const text = textOf(b);
    expect(text).toContain("I'll run it."); // from the snapshot
    expect(text).toContain("The command ran: hi"); // live
    expect(text.split("The command ran: hi").length).toBe(2);
    expect(pending(a.taskId).length).toBe(0);
    // The detached driver never answers: exactly one reply reached the server.
    expect(proxy.requests.filter((r) => /\/permission\/[^/]+\/reply$/.test(r)).length).toBe(1);
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
    proxy.inject({
      type: "form.created",
      data: { form: { id: "frm_elicit1", sessionID: sid, title: "Server asks", metadata: { kind: "mcp-elicitation" }, fields: [{ key: "a", type: "string" }] } },
    });
    // Events are handled in order: once a LATER question form has its card, the earlier one has been seen.
    proxy.inject({
      type: "form.created",
      data: { form: { id: "frm_sentinel", sessionID: sid, title: "Questions", metadata: { kind: "question" }, fields: [{ key: "q0", description: "Sentinel?", type: "string" }] } },
    });
    await waitFor(() => pending(run.taskId).length === 1, 10_000, "the sentinel card");
    expect(pending(run.taskId).length).toBe(1); // only the sentinel: the elicitation raised nothing
    expect(proxy.requests.filter((r) => r.includes("/form"))).toEqual([]);
    // ...but the user is told, once, why the turn may be waiting.
    proxy.inject({
      type: "form.created",
      data: { form: { id: "frm_elicit2", sessionID: sid, title: "Again", metadata: { kind: "mcp-elicitation" }, fields: [{ key: "a", type: "string" }] } },
    });
    proxy.inject({
      type: "form.created",
      data: { form: { id: "frm_sentinel2", sessionID: sid, title: "Questions", metadata: { kind: "question" }, fields: [{ key: "q0", description: "Again?", type: "string" }] } },
    });
    await waitFor(() => pending(run.taskId).length === 2, 10_000, "the second sentinel card");
    expect(statusesOf(run).filter((s) => s.startsWith("OpenCode is waiting on a form"))).toEqual([
      "OpenCode is waiting on a form that can't be shown here (mcp-elicitation): answer it in another OpenCode client, or stop the turn",
    ]);
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
    proxy.inject({ type: "form.created", data: { form } }); // the same form again
    proxy.inject({ type: "form.created", data: { form: { ...form, id: "frm_q2" } } }); // a sentinel behind it
    await waitFor(() => pending(run.taskId).length >= 2, 5000, "the cards");
    expect(pending(run.taskId).length).toBe(2); // three events, two forms: the repeat raised nothing
    const q = (pending(run.taskId).find((r) => r.kind === "ask_questions" && r.questions[0]!.id === "q0" ) as import("./interactions.ts").AskQuestionsRequest).questions[0]!;
    expect(q.multiSelect).toBe(true);
    expect(q.allowCustom).toBe(false);
    // The server settled it elsewhere: the card closes and no reply goes out.
    proxy.inject({ type: "form.cancelled", data: { id: "frm_q1", sessionID: t.sessionId() } });
    proxy.inject({ type: "form.cancelled", data: { id: "frm_q2", sessionID: t.sessionId() } });
    await waitFor(() => pending(run.taskId).length === 0, 5000, "the cards to close");
    expect(proxy.requests.filter((r) => r.includes("/form"))).toEqual([]);
    t.kill();
    expect(await doneWithin(t)).toBe(130);
  });
});


describe("Stop on an attached turn", () => {
  test("a Stop right after attach interrupts the server (it does not just mark the run cancelled)", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const since = Date.now();
    const a = mk({ ...inprocArgs, prompt: `run ${M.slow}` });
    const first = start(a);
    await waitFor(() => a.chunks.some((c) => c.stream === "tool_use"), 15_000, "the tool step");
    const sid = first.sessionId()!;
    first.detach();
    const b = mk({ ...inprocArgs, taskId: a.taskId, runId: a.runId });
    const { prompt: _p, title: _t, resumeSessionId: _r, ...base } = b.args;
    const second = attachOpencodeServerTurn({ ...base, sessionId: sid, sinceMs: since, reason: "reattach" });
    liveTurns.push(second as Turn);
    second.kill(); // still connecting
    expect(await doneWithin(second, 10_000)).toBe(130);
    expect(proxy.requests).toContain(`POST /api/session/${sid}/interrupt`);
    expect(await inprocClient(fake).activeSessions()).toEqual({});
  });

  test("kill after detach settles 130 instead of leaving done pending", async () => {
    await inproc();
    const run = mk({ ...inprocArgs, prompt: `run ${M.slow}` });
    const t = start(run);
    await waitFor(() => run.chunks.some((c) => c.stream === "tool_use"), 15_000, "the tool step");
    t.detach();
    t.kill();
    expect(await doneWithin(t, 5000)).toBe(130);
  });
});

describe("client message ids and retries", () => {
  test("the prompt and a steer carry ascending msg_ ids; a timed-out prompt that landed is looked up, not sent again", async () => {
    const requeued = captureRequeue();
    const fake = await inproc(0.4);
    const proxy = flakyProxy(fake);
    proxy.hooks.delayFirstPromptMs = 1500; // forwarded, but the answer is held past the client's budget
    cleanups.push(__forTest.setTimings({ requestMs: 600 }));
    const run = mk({ ...inprocArgs, prompt: `go ${M.slow}` });
    const t = start(run);
    // Steering waits for the first prompt to be settled (here: by the lookup that finds it).
    expect(await t.steer("second thought")).toBe("accepted");
    const sid = t.sessionId()!;
    expect(proxy.gets).toContain(`/api/session/${sid}/message`); // the lookup
    t.kill();
    expect(await doneWithin(t, 10_000)).toBe(130);
    const ids = proxy.hooks.promptBodies.map((b) => (JSON.parse(b) as { id: string }).id);
    expect(ids.length).toBe(2); // the first try (landed) and the steer: no resend
    for (const id of ids) expect(id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(ids[1]! > ids[0]!).toBe(true);
    const msgs = await inprocClient(fake).listMessages(sid, { limit: 50, order: "asc" });
    const users = msgs.data.filter((m: { type: string }) => m.type === "user");
    // The steer was still parked behind the slow tool when the turn was stopped: handed back, not delivered.
    expect(users.map((m: { text: string }) => m.text)).toEqual([`go ${M.slow}`]);
    expect(users[0].id).toBe(ids[0]);
    expect(requeued.map((r) => r.texts)).toEqual([["second thought"]]);
  });

  test("a timed-out prompt that did NOT land is sent again once, with the same id", async () => {
    const fake = await inproc(0.4);
    const proxy = flakyProxy(fake);
    proxy.hooks.swallowFirstPromptMs = 1500; // never reaches the server; answered after the client gave up
    cleanups.push(__forTest.setTimings({ requestMs: 600 }));
    const run = mk({ ...inprocArgs, prompt: "only once" });
    const t = start(run);
    expect(await doneWithin(t)).toBe(0);
    const ids = proxy.hooks.promptBodies.map((b) => (JSON.parse(b) as { id: string }).id);
    expect(ids.length).toBe(2);
    expect(ids[0]).toBe(ids[1]);
    expect(proxy.gets).toContain(`/api/session/${t.sessionId()}/message`); // looked up before the resend
    expect(textOf(run)).toContain("ACK: only once");
    const msgs = await inprocClient(fake).listMessages(t.sessionId()!, { limit: 50, order: "asc" });
    expect(msgs.data.filter((m: { type: string }) => m.type === "user").map((m: { text: string }) => m.text)).toEqual(["only once"]);
  });

  test("a 409 on the prompt (the id clashes with another session's record) is an error, not a delivery", async () => {
    const fake = await inproc(0.4);
    const proxy = flakyProxy(fake);
    proxy.hooks.conflictFirstPrompt = true;
    const run = mk({ ...inprocArgs, prompt: "clash" });
    const t = start(run);
    expect(await doneWithin(t, 10_000)).toBe(1);
    expect(statusesOf(run).some((s) => s.startsWith("OpenCode didn't accept the message"))).toBe(true);
    expect(proxy.hooks.promptBodies.length).toBe(1); // not retried
  });
});

describe("catch-up rules", () => {
  test("an idle after the anchor settles the turn even though a newer execution is active; later content is not replayed", async () => {
    const fake = await inproc();
    const since = Date.now();
    const one = mk({ ...inprocArgs, prompt: "first turn" });
    const first = start(one);
    expect(await doneWithin(first)).toBe(0);
    // A second execution is now running on the same session (not ours).
    const sid = first.sessionId()!;
    await inprocClient(fake).prompt(sid, { text: `later ${M.slow}`, delivery: "steer" });
    const c = inprocClient(fake);
    const t0 = Date.now();
    while ((await c.activeSessions())[sid] === undefined) {
      if (Date.now() - t0 > 10_000) throw new Error("the second execution never started");
      await sleep(20);
    }
    const again = mk({ ...inprocArgs });
    const { prompt: _p, title: _t, resumeSessionId: _r, ...base } = again.args;
    const twin = attachOpencodeServerTurn({ ...base, sessionId: sid, sinceMs: since, reason: "reattach" });
    liveTurns.push(twin as Turn);
    expect(await doneWithin(twin, 10_000)).toBe(0);
    expect(textOf(again)).toContain("ACK: first turn");
    expect(textOf(again)).not.toContain("later");
    // The newer execution is untouched.
    expect(await c.interrupt(sid)).toBe(true); // still running: the attach did not touch it
  });

  test("a catch-up that cannot read the server is retried (capped backoff) and then settles the turn", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const since = Date.now();
    const one = mk({ ...inprocArgs, prompt: "already done" });
    const first = start(one);
    expect(await doneWithin(first)).toBe(0);
    cleanups.push(__forTest.setTimings({ catchRetryMs: 40, livenessMs: 60_000 }));
    proxy.hooks.failMessageLists = 2;
    const again = mk({ ...inprocArgs });
    const { prompt: _p, title: _t, resumeSessionId: _r, ...base } = again.args;
    const twin = attachOpencodeServerTurn({ ...base, sessionId: first.sessionId()!, sinceMs: since, reason: "reattach" });
    liveTurns.push(twin as Turn);
    expect(await doneWithin(twin, 10_000)).toBe(0);
    expect(proxy.hooks.failMessageLists).toBe(0);
    expect(textOf(again)).toContain("ACK: already done");
  });
});

describe("background subagents outlive the turn (real subagent rows)", () => {
  test("Auto: the turn settles, the driver lingers, the child row completes, the linger ends", async () => {
    await inproc(0.4, { realChildren: true });
    const { taskId, runId } = seedTask();
    const run = mk({ ...inprocArgs, taskId, runId, prompt: `launch ${M.wake}` });
    const t = start(run);
    expect(await doneWithin(t)).toBe(0);
    expect(t.lingering()).toBe(true);
    expect(childRows(taskId).map((r) => r.status)).toEqual(["running"]);
    await waitFor(() => childRows(taskId)[0]?.status === "completed", 20_000, "the background child to complete");
    await waitFor(() => !t.lingering(), 5000, "the linger to end");
    expect(hub.__forTest.probe(H_INPROC)?.subscribers ?? 0).toBe(0);
  });

  test("Ask: a child's permission card survives the turn's end and stays answerable", async () => {
    await inproc(0.4, { realChildren: true });
    const { taskId, runId } = seedTask();
    const run = mk({ ...inprocArgs, taskId, runId, prompt: `launch ${M.wake}`, mode: "ask" });
    const t = start(run);
    expect(await doneWithin(t)).toBe(0);
    expect(t.lingering()).toBe(true);
    await waitFor(() => pending(taskId).length === 1, 10_000, "the child's permission card");
    const card = pending(taskId)[0]! as import("./interactions.ts").FxPermissionRequest;
    expect(card.runId).toBe(runId);
    expect(card.toolCall.title).toContain("shell:");
    answerOpencodePermission(card.id, { decision: "once" });
    await waitFor(() => childRows(taskId)[0]?.status === "completed", 20_000, "the background child to complete");
    expect(pending(taskId).length).toBe(0);
    await waitFor(() => !t.lingering(), 5000, "the linger to end");
  });

  test("dispose ends the linger, closes the cards and unsubscribes", async () => {
    await inproc(0.4, { realChildren: true });
    const { taskId, runId } = seedTask();
    const run = mk({ ...inprocArgs, taskId, runId, prompt: `launch ${M.wake}`, mode: "ask" });
    const t = start(run);
    expect(await doneWithin(t)).toBe(0);
    await waitFor(() => pending(taskId).length === 1, 10_000, "the child's permission card");
    await t.dispose();
    expect(t.lingering()).toBe(false);
    expect(pending(taskId).length).toBe(0);
    expect(hub.__forTest.probe(H_INPROC)?.subscribers ?? 0).toBe(0);
    await t.dispose(); // idempotent
  });

  test("a wake attach also settles the children of an earlier turn whose row is still open", async () => {
    // Slow enough that the child began more than 2 s before the wake message: only the open-row rule finds it.
    const fake = await inproc(2.5, { realChildren: true });
    const { taskId, runId } = seedTask();
    const a = mk({ ...inprocArgs, taskId, runId, prompt: `launch ${M.wake}` });
    const first = start(a);
    expect(await doneWithin(first, 30_000)).toBe(0);
    closeOpencodeHub(); // the core is gone (no dispose: that would interrupt the child); the row stays running
    expect(childRows(taskId).map((r) => r.status)).toEqual(["running"]);
    const sid = first.sessionId()!;
    const c = inprocClient(fake);
    let syntheticAt = 0;
    const t0 = Date.now();
    while (syntheticAt === 0 && Date.now() - t0 < 30_000) {
      const msgs = await c.listMessages(sid, { limit: 50, order: "desc" });
      const syn = msgs.data.find((m: { type: string }) => m.type === "synthetic");
      if (syn) syntheticAt = syn.time.created;
      else await sleep(50);
    }
    expect(syntheticAt).toBeGreaterThan(0);
    const b = mk({ ...inprocArgs, taskId, runId });
    const { prompt: _p, title: _t, resumeSessionId: _r, ...base } = b.args;
    const woken = attachOpencodeServerTurn({ ...base, sessionId: sid, sinceMs: syntheticAt + 1, reason: "wake" });
    liveTurns.push(woken as Turn);
    expect(await doneWithin(woken, 30_000)).toBe(0);
    expect(childRows(taskId).map((r) => r.status)).toEqual(["completed"]);
  });
});


describe("Stop reaches the children", () => {
  function captureChildren() {
    const ids: string[] = [];
    cleanups.push(__forTest.setDeps({ registerChild: (a) => void ids.push(a.childSessionId) }));
    return ids;
  }

  test("kill on a lingering handle interrupts the background child (it would otherwise wake the stopped task)", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const children = captureChildren();
    const run = mk({ ...inprocArgs, prompt: `launch ${M.wake}`, mode: "ask" });
    const t = start(run);
    expect(await doneWithin(t)).toBe(0);
    expect(t.lingering()).toBe(true);
    await waitFor(() => pending(run.taskId).length === 1, 10_000, "the child's permission card");
    expect(children.length).toBe(1);
    t.kill();
    await waitFor(() => !t.lingering(), 10_000, "the linger to end");
    expect(proxy.requests).toContain(`POST /api/session/${children[0]}/interrupt`);
    expect(pending(run.taskId).length).toBe(0);
    void fake;
  });

  test("kill on a live turn interrupts the root and its running child", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const children = captureChildren();
    const run = mk({ ...inprocArgs, prompt: `delegate ${M.subagent}`, mode: "ask" });
    const t = start(run);
    await waitFor(() => pending(run.taskId).length === 1, 15_000, "the child's permission card");
    expect(children.length).toBe(1);
    const sid = t.sessionId()!;
    const settles: Array<{ childSessionId: string; outcome: string }> = [];
    cleanups.push(__forTest.setDeps({ settleChild: (a) => void settles.push({ childSessionId: a.childSessionId, outcome: a.outcome }) }));
    t.kill();
    expect(await doneWithin(t, 10_000)).toBe(130);
    expect(proxy.requests).toContain(`POST /api/session/${sid}/interrupt`);
    // A foreground subagent ends with its parent's interrupted tool call; anything still running after
    // the root's interrupt is interrupted on its own. Either way the child ends interrupted.
    const ownInterrupt = proxy.requests.includes(`POST /api/session/${children[0]}/interrupt`);
    expect(ownInterrupt || settles.some((x) => x.childSessionId === children[0] && x.outcome === "interrupted")).toBe(true);
    void fake;
  });

  test("dispose also interrupts the children", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const children = captureChildren();
    const run = mk({ ...inprocArgs, prompt: `launch ${M.wake}`, mode: "ask" });
    const t = start(run);
    expect(await doneWithin(t)).toBe(0);
    await waitFor(() => pending(run.taskId).length === 1, 10_000, "the child's permission card");
    await t.dispose();
    expect(proxy.requests).toContain(`POST /api/session/${children[0]}/interrupt`);
    void fake;
  });
});

describe("a boot-time lingering handle and re-raised child cards", () => {
  async function lingerThenRestart() {
    const fake = await inproc(0.4, { realChildren: true });
    const { taskId, runId } = seedTask();
    const a = mk({ ...inprocArgs, taskId, runId, prompt: `launch ${M.wake}`, mode: "ask" });
    const first = start(a);
    expect(await doneWithin(first)).toBe(0);
    await waitFor(() => pending(taskId).length === 1, 10_000, "the child's permission card");
    const oldCard = pending(taskId)[0]!.id;
    const sid = first.sessionId()!;
    // The core restarts: the stream and the in-memory card registry are gone; the server still holds the request.
    closeOpencodeHub();
    interactionsTest.reset();
    expect(first.lingering()).toBe(false);
    return { fake, taskId, runId, sid, oldCard, base: a.args };
  }

  test("attachOpencodeServerLinger: done 0 at once, the open child's card comes back, the child settles, the linger ends", async () => {
    const { taskId, runId, sid, oldCard, base } = await lingerThenRestart();
    const { prompt: _p, title: _t, resumeSessionId: _r, ...rest } = base;
    const h = attachOpencodeServerLinger({ ...rest, sessionId: sid });
    liveTurns.push(h);
    expect(await doneWithin(h, 2000)).toBe(0);
    expect(h.lingering()).toBe(true);
    expect(childRows(taskId).map((r) => r.status)).toEqual(["running"]);
    await waitFor(() => pending(taskId).length === 1 && pending(taskId)[0]!.id !== oldCard, 15_000, "the card to come back");
    expect((pending(taskId)[0] as import("./interactions.ts").FxPermissionRequest).runId).toBe(runId);
    answerOpencodePermission(pending(taskId)[0]!.id, { decision: "once" });
    await waitFor(() => childRows(taskId)[0]?.status === "completed", 20_000, "the background child to complete");
    await waitFor(() => !h.lingering(), 5000, "the linger to end");
  });

  test("attachOpencodeServerLinger with nothing open leaves the linger at once", async () => {
    await inproc(0.4, { realChildren: true });
    const { taskId, runId } = seedTask();
    const { prompt: _p, title: _t, resumeSessionId: _r, ...rest } = mk({ ...inprocArgs, taskId, runId }).args;
    const seeded = mk({ ...inprocArgs, taskId, runId, prompt: "plain" });
    const first = start(seeded);
    expect(await doneWithin(first)).toBe(0);
    const h = attachOpencodeServerLinger({ ...rest, sessionId: first.sessionId()! });
    liveTurns.push(h);
    expect(await doneWithin(h, 2000)).toBe(0);
    await waitFor(() => !h.lingering(), 10_000, "the linger to end");
    expect(hub.__forTest.probe(H_INPROC)?.subscribers ?? 0).toBe(0);
  });

  test("a new turn on the session re-raises a request the previous lingering driver closed without replying", async () => {
    const { taskId, sid, oldCard, base } = await lingerThenRestart();
    const next = mk({ ...inprocArgs, taskId, runId: base.runId, prompt: "carry on", mode: "ask", resumeSessionId: sid });
    const t = start(next);
    await waitFor(() => pending(taskId).length === 1 && pending(taskId)[0]!.id !== oldCard, 15_000, "the card to come back");
    answerOpencodePermission(pending(taskId)[0]!.id, { decision: "once" });
    expect(await doneWithin(t)).toBe(0);
    await waitFor(() => childRows(taskId)[0]?.status === "completed", 20_000, "the background child to complete");
  });
});

describe("cards shared between drivers, re-lists and stops (review round 2)", () => {
  const replies = (proxy: ReturnType<typeof flakyProxy>) => proxy.requests.filter((r) => /\/permission\/[^/]+\/reply$/.test(r));

  test("a lingering driver leaving for the next turn leaves the child's card to that turn; the answer reaches the server", async () => {
    const fake = await inproc(0.4, { realChildren: true });
    const proxy = flakyProxy(fake);
    const { taskId, runId } = seedTask();
    const a = mk({ ...inprocArgs, taskId, runId, prompt: `launch ${M.wake}`, mode: "ask" });
    const first = start(a);
    expect(await doneWithin(first)).toBe(0);
    expect(first.lingering()).toBe(true);
    await waitFor(() => pending(taskId).length === 1, 10_000, "the child's permission card");
    const cardId = pending(taskId)[0]!.id;
    const sid = first.sessionId()!;
    const b = mk({ ...inprocArgs, taskId, runId, prompt: "carry on", mode: "ask", resumeSessionId: sid });
    const second = start(b);
    // The next execution starts: the first driver stops lingering...
    await waitFor(() => !first.lingering(), 15_000, "the first driver to leave its linger");
    // ...without closing the card the new turn now waits on.
    expect(pending(taskId).map((r) => r.id)).toEqual([cardId]);
    expect(answerOpencodePermission(cardId, { decision: "once" })).toBe(true);
    await waitFor(() => childRows(taskId)[0]?.status === "completed", 20_000, "the background child to complete");
    expect(await doneWithin(second)).toBe(0);
    expect(replies(proxy).length).toBe(1);
  });

  test("a permission card closed by someone else while the turn can act is raised again and answered", async () => {
    const run = mk({ prompt: `do it ${M.permission}`, mode: "ask" });
    const t = start(run);
    await waitFor(() => pending(run.taskId).length === 1, 15_000, "the permission card");
    const firstCard = pending(run.taskId)[0]!.id;
    const [perm] = await stubClient().listPermissions(t.sessionId()!);
    // What another driver's close does: the card is resolved as cancelled, the server still waits.
    __forTest.closeCardAsDriver(run.taskId, { requestId: perm.id });
    await waitFor(() => pending(run.taskId).length === 1 && pending(run.taskId)[0]!.id !== firstCard, 15_000, "the card to come back");
    answerOpencodePermission(pending(run.taskId)[0]!.id, { decision: "once" });
    expect(await doneWithin(t)).toBe(0);
    expect(textOf(run)).toContain("The command ran: hi");
  });

  test("a question card closed by someone else while the turn can act is raised again and answered", async () => {
    const run = mk({ prompt: `ask me ${M.question}` });
    const t = start(run);
    await waitFor(() => pending(run.taskId).length === 1, 15_000, "the question card");
    const firstCard = pending(run.taskId)[0]!.id;
    const [form] = await stubClient().listForms(t.sessionId()!);
    __forTest.closeCardAsDriver(run.taskId, { formId: form.id });
    await waitFor(() => pending(run.taskId).length === 1 && pending(run.taskId)[0]!.id !== firstCard, 15_000, "the card to come back");
    answerOpencodeAsk(pending(run.taskId)[0]!.id, { outcome: "answered", answer: { q0: "Blue" } });
    expect(await doneWithin(t)).toBe(0);
    expect(textOf(run)).toContain("You picked **Blue**");
  });

  test("a re-list does not close a card raised while its request was in flight", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const run = mk({ ...inprocArgs, prompt: `run ${M.slow}`, mode: "plan" });
    // The start sequence's re-list: its (empty) answer is read upstream first, then a request is asked live.
    proxy.hooks.onPermissionList = async () => {
      const sid = run.sessionIds[0]!;
      proxy.inject({ type: "permission.asked", data: { id: "per_inflight", sessionID: sid, action: "shell", resources: ["echo inflight"] } });
      await waitFor(() => pending(run.taskId).length === 1, 10_000, "the card raised mid-list");
    };
    const t = start(run);
    // The form listing comes after the permission list was handled.
    await waitFor(() => proxy.gets.includes(`/api/session/${run.sessionIds[0]}/form`), 15_000, "the form listing");
    expect(pending(run.taskId).length).toBe(1);
    t.kill();
    expect(await doneWithin(t)).toBe(130);
  });

  test("children whose subagent row settled are not re-listed, nor interrupted on Stop", async () => {
    const fake = await inproc(0.4, { realChildren: true });
    const proxy = flakyProxy(fake);
    const { taskId, runId } = seedTask();
    const one = mk({ ...inprocArgs, taskId, runId, prompt: `delegate ${M.subagent}` });
    const first = start(one);
    expect(await doneWithin(first)).toBe(0);
    expect(childRows(taskId).map((r) => r.status)).toEqual(["completed"]);
    const childId = opencodeChildSessionOf(childRows(taskId)[0]!)!;
    expect(childId).toBeTruthy();
    const getsBefore = proxy.gets.length;
    const two = mk({ ...inprocArgs, taskId, runId, prompt: `run ${M.slow}`, resumeSessionId: first.sessionId()! });
    const t = start(two);
    await waitFor(() => two.chunks.some((c) => c.stream === "tool_use"), 15_000, "the tool step");
    // The hub does know the old child (it is seeded from the session tree): the skip is the row rule.
    expect(hub.opencodeOwnedSessions(H_INPROC, first.sessionId()!).some((o) => o.sessionId === childId)).toBe(true);
    await t.dispose();
    const later = proxy.gets.slice(getsBefore);
    expect(later.some((g) => g === `/api/session/${first.sessionId()}/permission`)).toBe(true); // the root was re-listed
    expect(later.filter((g) => g.includes(childId))).toEqual([]);
    expect(proxy.requests).toContain(`POST /api/session/${first.sessionId()}/interrupt`);
    expect(proxy.requests).not.toContain(`POST /api/session/${childId}/interrupt`);
  });

  test("Stop settles a child `interrupted` only when the server says it interrupted it", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const settles: Array<{ childSessionId: string; outcome: string }> = [];
    const registered: string[] = [];
    cleanups.push(
      __forTest.setDeps({
        registerChild: (a) => void registered.push(a.childSessionId),
        settleChild: (a) => void settles.push({ childSessionId: a.childSessionId, outcome: a.outcome }),
      }),
    );
    const one = mk({ ...inprocArgs, prompt: `delegate ${M.subagent}` });
    const first = start(one);
    expect(await doneWithin(first)).toBe(0);
    expect(registered.length).toBe(1);
    const childId = registered[0]!;
    // A new turn on the session: it does not know the old child, the hub does (no subagent rows here).
    const two = mk({ ...inprocArgs, taskId: one.taskId, runId: "run-n3", prompt: `run ${M.slow}`, resumeSessionId: first.sessionId()! });
    const t = start(two);
    await waitFor(() => two.chunks.some((c) => c.stream === "tool_use"), 15_000, "the tool step");
    await t.dispose();
    expect(proxy.requests).toContain(`POST /api/session/${childId}/interrupt`); // it was asked...
    // ...the server had nothing running for it: its earlier `completed` stands.
    expect(settles.filter((s) => s.childSessionId === childId)).toEqual([{ childSessionId: childId, outcome: "completed" }]);
  });

  test("an interruption this driver did not issue: `shutdown` is a failure with a status line, never a user stop", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const run = mk({ ...inprocArgs, prompt: `run ${M.slow}` });
    const t = start(run);
    await waitFor(() => run.chunks.some((c) => c.stream === "tool_use"), 15_000, "the tool step");
    proxy.inject({ type: "session.execution.interrupted", data: { sessionID: t.sessionId(), reason: "shutdown" } });
    expect(await doneWithin(t)).toBe(1);
    expect(run.userStops).toBe(0);
    expect(statusesOf(run)).toContain("opencode: the turn was interrupted (shutdown)");
  });

  test("another client's Stop (`interrupted{reason:\"user\"}`) reports the user stop first, once, then 130", async () => {
    const fake = await inproc();
    const run = mk({ ...inprocArgs, prompt: `run ${M.slow}` });
    const t = start(run);
    void t.done.then(() => run.events.push("done"));
    await waitFor(() => run.chunks.some((c) => c.stream === "tool_use"), 15_000, "the tool step");
    expect(await inprocClient(fake).interrupt(t.sessionId()!)).toBe(true);
    expect(await doneWithin(t)).toBe(130);
    await Promise.resolve();
    expect(run.userStops).toBe(1);
    expect(run.events).toEqual(["userStop", "done"]);
  });

  test("children this driver interrupts are noted as stopped by agetor, durably, before their interrupt goes out", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const children: string[] = [];
    const notes: Array<{ taskId: string; childSessionId: string }> = [];
    cleanups.push(
      __forTest.setDeps({
        registerChild: (a) => void children.push(a.childSessionId),
        noteChildStoppedByAgetor: (a) => {
          notes.push(a);
          proxy.hooks.interruptLog.push(`note:${a.childSessionId}`);
        },
      }),
    );
    const run = mk({ ...inprocArgs, prompt: `launch ${M.wake}`, mode: "ask" });
    const t = start(run);
    expect(await doneWithin(t)).toBe(0);
    await waitFor(() => pending(run.taskId).length === 1, 10_000, "the child's permission card");
    expect(children.length).toBe(1);
    await t.dispose();
    expect(notes).toEqual([{ taskId: run.taskId, childSessionId: children[0]! }]);
    const log = proxy.hooks.interruptLog;
    expect(log.indexOf(`note:${children[0]}`)).toBeGreaterThanOrEqual(0);
    expect(log.indexOf(`note:${children[0]}`)).toBeLessThan(log.indexOf(`start:${children[0]}`));
    expect(notes.some((n) => n.childSessionId === t.sessionId())).toBe(false); // the root is not a stopped child
  });

  test("the default note lands in the durable store the orchestrator reads", async () => {
    const fake = await inproc();
    const children: string[] = [];
    cleanups.push(__forTest.setDeps({ registerChild: (a) => void children.push(a.childSessionId) }));
    // inproc() stubs the subagent storage; the stopped-child note keeps its production default here.
    const { taskId, runId } = seedTask();
    const run = mk({ ...inprocArgs, taskId, runId, prompt: `launch ${M.wake}`, mode: "ask" });
    const t = start(run);
    expect(await doneWithin(t)).toBe(0);
    await waitFor(() => pending(taskId).length === 1, 10_000, "the child's permission card");
    expect(wasOpencodeChildStoppedByAgetor(children[0]!)).toBe(false);
    await t.dispose();
    expect(wasOpencodeChildStoppedByAgetor(children[0]!)).toBe(true);
    expect(wasOpencodeChildStoppedByAgetor(t.sessionId()!)).toBe(false);
    void fake;
  });

  test("steers are sent one at a time, in call order; a Stop hands the undelivered ones back in that order", async () => {
    const requeued = captureRequeue();
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const run = mk({ ...inprocArgs, prompt: `go ${M.slow}` });
    const t = start(run);
    await waitFor(() => run.chunks.some((c) => c.stream === "tool_use"), 15_000, "the tool step");
    // The first steer's answer is held until the second steer's POST shows up (it must not, while held).
    proxy.hooks.holdPrompt = { text: "one", until: "two", maxMs: 1500 };
    const [r1, r2] = await Promise.all([t.steer("one"), t.steer("two")]);
    expect([r1, r2]).toEqual(["accepted", "accepted"]);
    const log = proxy.hooks.promptLog.filter((l) => l.endsWith(":one") || l.endsWith(":two"));
    expect(log).toEqual(["start:one", "end:one", "start:two", "end:two"]);
    t.kill();
    expect(await doneWithin(t)).toBe(130);
    // The steers waited in the inbox behind the slow tool; the interrupt parks them (r3 spike), and the
    // Stop takes them back out and hands them to the orchestrator in the order they were sent.
    expect(requeued).toEqual([{ taskId: run.taskId, runId: run.runId, texts: ["one", "two"] }]);
    const msgs = await inprocClient(fake).listMessages(t.sessionId()!, { limit: 50, order: "asc" });
    expect(msgs.data.filter((m: { type: string }) => m.type === "user").map((m: { text: string }) => m.text)).toEqual([`go ${M.slow}`]);
    expect(await inprocClient(fake).listInbox(t.sessionId()!)).toEqual([]);
  });

  test("detach on a lingering handle stops lingering silently: no interrupt, the child's card stays open", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const run = mk({ ...inprocArgs, prompt: `launch ${M.wake}`, mode: "ask" });
    const t = start(run);
    expect(await doneWithin(t)).toBe(0);
    await waitFor(() => pending(run.taskId).length === 1, 10_000, "the child's permission card");
    const cardId = pending(run.taskId)[0]!.id;
    expect(t.lingering()).toBe(true);
    t.detach();
    expect(t.lingering()).toBe(false);
    expect(hub.__forTest.probe(H_INPROC)?.subscribers ?? 0).toBe(0);
    expect(pending(run.taskId).map((r) => r.id)).toEqual([cardId]);
    // A later dispose of the detached handle (the orchestrator's teardown) does not close it either.
    await t.dispose();
    expect(pending(run.taskId).map((r) => r.id)).toEqual([cardId]);
    expect(proxy.requests.filter((r) => r.endsWith("/interrupt"))).toEqual([]);
  });

  test("a server that never answers: the turn's own connect deadline posts a status line and settles 1", async () => {
    cleanups.push(__forTest.setDeps({ ensureServer: () => new Promise(() => {}) }));
    cleanups.push(__forTest.setTimings({ connectMs: 200 }));
    const run = mk({ prompt: "hi" });
    expect(await doneWithin(start(run), 5000)).toBe(1);
    expect(statusesOf(run).some((s) => s.startsWith("couldn't start the OpenCode server") && s.includes("no answer within"))).toBe(true);
  });

  test("catch-up: events of the root's NEXT execution held during the snapshot do not reach this run", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const since = Date.now();
    const one = mk({ ...inprocArgs, prompt: "first turn" });
    const first = start(one);
    expect(await doneWithin(first)).toBe(0);
    const sid = first.sessionId()!;
    // While the attach reads the snapshot (which ends with this turn's idle), the next execution streams in.
    proxy.hooks.onMessageList = async () => {
      proxy.inject({ type: "session.execution.started", data: { sessionID: sid } });
      proxy.inject({ type: "session.execution.failed", data: { sessionID: sid, error: { type: "unknown", message: "LATER FAILURE" } } });
      // Frames are dispatched in order: once the hub owns this sentinel child, the two above were handed over.
      proxy.inject({ type: "session.created", data: { sessionID: "ses_sentinel_s11", parentID: sid } });
      await waitFor(() => hub.opencodeOwnedSessions(H_INPROC, sid).some((o) => o.sessionId === "ses_sentinel_s11"), 10_000, "the sentinel frame");
    };
    const again = mk({ ...inprocArgs });
    const { prompt: _p, title: _t, resumeSessionId: _r, ...base } = again.args;
    const twin = attachOpencodeServerTurn({ ...base, sessionId: sid, sinceMs: since, reason: "reattach" });
    liveTurns.push(twin as Turn);
    expect(await doneWithin(twin, 10_000)).toBe(0);
    expect(proxy.hooks.onMessageList).toBeNull(); // the hook ran
    expect(textOf(again)).toContain("ACK: first turn");
    expect(statusesOf(again).some((s) => s.includes("LATER FAILURE"))).toBe(false);
  });
});

describe("Stop order, wake take-over, sends and child syncs (review round 3)", () => {
  const replies = (proxy: ReturnType<typeof flakyProxy>) => proxy.requests.filter((r) => /\/permission\/[^/]+\/reply$/.test(r));
  /** A request straight to the in-process fake (sessions the client cannot make, such as children). */
  async function rawPost(fake: FakeServer, p: string, body: unknown): Promise<any> {
    const res = await fetch(`${fake.url}${p}`, {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`opencode:${fake.password}`)}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  /** Wrap the driver's HTTP clients: every `prompt` call is recorded, and a test can override calls. */
  function watchClients(over: { prompt?: (orig: (id: string, a: any) => Promise<any>, id: string, a: any) => Promise<any>; [k: string]: unknown } = {}) {
    const prompts: any[] = [];
    cleanups.push(
      __forTest.setDeps({
        createClient: (ref, opts) => {
          const real = createOpencodeClient(ref, opts);
          const wrapped: any = { ...real };
          const origPrompt = real.prompt.bind(real);
          wrapped.prompt = (id: string, a: any) => {
            prompts.push({ ...a });
            return over.prompt ? over.prompt(origPrompt, id, a) : origPrompt(id, a);
          };
          for (const [k, fn] of Object.entries(over)) {
            if (k === "prompt" || typeof fn !== "function") continue;
            const orig = (real as any)[k].bind(real);
            wrapped[k] = (...args: unknown[]) => (fn as (o: unknown, ...r: unknown[]) => unknown)(orig, ...args);
          }
          return wrapped;
        },
      }),
    );
    return prompts;
  }
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };

  test("C3: a Stop on a live turn with a background child answers the root's interrupt before the child's goes out", async () => {
    const fake = await inproc(0.4, { realChildren: true });
    const proxy = flakyProxy(fake);
    const { taskId, runId } = seedTask();
    const first = start(mk({ ...inprocArgs, taskId, runId, prompt: `launch ${M.wake}`, mode: "ask" }));
    expect(await doneWithin(first)).toBe(0);
    await waitFor(() => pending(taskId).length === 1, 10_000, "the child's permission card");
    const sid = first.sessionId()!;
    const childId = opencodeChildSessionOf(childRows(taskId)[0]!)!;
    const second = mk({ ...inprocArgs, taskId, runId, prompt: `run ${M.slow}`, mode: "ask", resumeSessionId: sid });
    const t = start(second);
    await waitFor(() => second.chunks.some((c) => c.stream === "tool_use"), 15_000, "the tool step");
    // The root's interrupt is answered late: a child's interrupt sent in parallel would arrive inside it.
    proxy.hooks.holdInterrupt = { sessionId: sid, ms: 400 };
    t.kill();
    expect(await doneWithin(t, 10_000)).toBe(130);
    await waitFor(() => proxy.hooks.interruptLog.includes(`start:${childId}`), 10_000, "the child's interrupt");
    const log = proxy.hooks.interruptLog;
    expect(log.indexOf(`end:${sid}`)).toBeGreaterThanOrEqual(0);
    expect(log.indexOf(`end:${sid}`)).toBeLessThan(log.indexOf(`start:${childId}`));
  });

  test("MF3: after a wake, a background child's card the linger left open is taken over and its answer reaches the server", async () => {
    const fake = await inproc(0.4, { realChildren: true });
    const proxy = flakyProxy(fake);
    const { taskId, runId } = seedTask();
    const a = mk({ ...inprocArgs, taskId, runId, prompt: `launch ${M.wake}`, mode: "ask" });
    const first = start(a);
    expect(await doneWithin(first)).toBe(0);
    expect(first.lingering()).toBe(true);
    await waitFor(() => pending(taskId).length === 1, 10_000, "the child's permission card");
    const cardId = pending(taskId)[0]!.id;
    const sid = first.sessionId()!;
    const childId = opencodeChildSessionOf(childRows(taskId)[0]!)!;
    // The root's next execution, started by the server itself (a wake): the linger leaves, the card stays.
    proxy.inject({ type: "session.execution.started", data: { sessionID: sid } });
    await waitFor(() => !first.lingering(), 15_000, "the first driver to leave its linger");
    expect(pending(taskId).map((r) => r.id)).toEqual([cardId]);
    const getsBefore = proxy.gets.length;
    const b = mk({ ...inprocArgs, taskId, runId, mode: "ask" });
    const { prompt: _p, title: _t, resumeSessionId: _r, ...base } = b.args;
    const wake = attachOpencodeServerTurn({ ...base, sessionId: sid, sinceMs: Date.now(), reason: "wake" });
    liveTurns.push(wake as Turn);
    // The wake driver re-lists the child's requests (the form listing follows the permission one).
    await waitFor(() => proxy.gets.slice(getsBefore).includes(`/api/session/${childId}/form`), 15_000, "the wake driver's re-list of the child");
    expect(pending(taskId).map((r) => r.id)).toEqual([cardId]);
    expect(answerOpencodePermission(cardId, { decision: "once" })).toBe(true);
    await waitFor(() => replies(proxy).length === 1, 10_000, "the reply to reach the server");
    await waitFor(() => childRows(taskId)[0]?.status === "completed", 20_000, "the background child to complete");
  });

  test("SF4: a lookup that fails once is retried and finds the landed prompt: no resend", async () => {
    const fake = await inproc(0.4);
    const proxy = flakyProxy(fake);
    proxy.hooks.delayFirstPromptMs = 1500; // forwarded, answered past the client's budget
    proxy.hooks.failMessageLists = 1;
    cleanups.push(__forTest.setTimings({ requestMs: 600, lookupRetryMs: 50 }));
    const run = mk({ ...inprocArgs, prompt: "only once" });
    const t = start(run);
    expect(await doneWithin(t)).toBe(0);
    expect(proxy.hooks.failMessageLists).toBe(0); // the failed read happened
    expect(proxy.hooks.promptBodies.length).toBe(1);
    expect(textOf(run)).toContain("ACK: only once");
  });

  test("SF4: the lookup pages back past newer messages (more than 20) and finds the landed prompt", async () => {
    const fake = await inproc(0.4);
    const proxy = flakyProxy(fake);
    proxy.hooks.delayFirstPromptMs = 1500;
    cleanups.push(__forTest.setTimings({ requestMs: 600 }));
    const run = mk({ ...inprocArgs, prompt: "buried" });
    // Before the lookup is answered, 25 more messages land after ours.
    proxy.hooks.beforeMessageList = async () => {
      const sid = run.sessionIds[0]!;
      const c = inprocClient(fake);
      await Promise.all(Array.from({ length: 25 }, (_, i) => c.prompt(sid, { text: `extra ${i}`, delivery: "steer" })));
      const t0 = Date.now();
      for (;;) {
        const users = (await c.listMessages(sid, { limit: 200, order: "asc" })).data.filter((m: { type: string }) => m.type === "user");
        if (users.length >= 26 && Object.keys(await c.activeSessions()).length === 0) break;
        if (Date.now() - t0 > 20_000) throw new Error("the extra messages never landed");
        await sleep(20);
      }
    };
    const t = start(run);
    expect(await doneWithin(t, 30_000)).toBe(0);
    expect(proxy.hooks.beforeMessageList).toBeNull(); // the hook ran
    expect(proxy.hooks.promptBodies.filter((b) => b.includes('"buried"')).length).toBe(1); // not resent
  });

  test("SF4: an unreadable lookup on an idle session resends with resume:false, and starts nothing when the prompt had landed", async () => {
    const fake = await inproc(0.4);
    const proxy = flakyProxy(fake);
    const prompts = watchClients();
    proxy.hooks.delayFirstPromptMs = 1500;
    cleanups.push(__forTest.setTimings({ requestMs: 600, lookupRetryMs: 50 }));
    const run = mk({ ...inprocArgs, prompt: "landed quietly" });
    // Every read of the first lookup fails, and the turn is over (idle) by then.
    proxy.hooks.beforeMessageList = async () => {
      const c = inprocClient(fake);
      await waitFor(() => run.chunks.some((x) => x.data.includes("ACK: landed quietly")), 10_000, "the turn's answer");
      const t0 = Date.now();
      while (Object.keys(await c.activeSessions()).length > 0 && Date.now() - t0 < 10_000) await sleep(20);
    };
    proxy.hooks.failMessageLists = 3;
    const t = start(run);
    expect(await doneWithin(t)).toBe(0);
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toMatchObject({ id: prompts[0].id, text: "landed quietly", resume: false });
    expect(prompts[0].resume).toBeUndefined();
  });

  test("SF4: a park-only resend whose id is then absent starts the execution with one more post", async () => {
    const fake = await inproc(0.4);
    const proxy = flakyProxy(fake);
    // The park-only post is admitted without running (the real server's resume:false; the fake ignores it
    // for a new id, so the test answers it here without forwarding).
    const prompts = watchClients({
      prompt: (orig, id, a) => (a.resume === false ? Promise.resolve({ id: a.id }) : orig(id, a)),
    });
    proxy.hooks.swallowFirstPromptMs = 1500; // never reaches the server
    proxy.hooks.failMessageLists = 3;
    cleanups.push(__forTest.setTimings({ requestMs: 600, lookupRetryMs: 50 }));
    const run = mk({ ...inprocArgs, prompt: "never got there" });
    const t = start(run);
    expect(await doneWithin(t)).toBe(0);
    expect(prompts.map((p) => p.resume)).toEqual([undefined, false, undefined]);
    expect(new Set(prompts.map((p) => p.id)).size).toBe(1);
    expect(textOf(run)).toContain("ACK: never got there");
  });

  test("SF8: settled children do not count toward the sync cap: a running child after 60 settled ones is followed", async () => {
    const fake = await inproc(0.4);
    const seeded = mk({ ...inprocArgs, prompt: "plain" });
    const first = start(seeded);
    expect(await doneWithin(first)).toBe(0);
    const sid = first.sessionId()!;
    // Keep the hub's view live so it learns the children in creation order (the settled ones first).
    const sub = hub.subscribeOpencodeSession({ key: H_INPROC, url: fake.url, password: fake.password }, sid, { onEvent() {}, onResync() {} });
    cleanups.push(() => sub.unsubscribe());
    await sub.ready;
    const settledIds: string[] = [];
    for (let i = 0; i < 60; i++) settledIds.push((await rawPost(fake, "/api/session", { parentID: sid, title: `done ${i}` })).data?.id ?? "");
    expect(settledIds.every((x) => x.startsWith("ses_"))).toBe(true);
    const live = (await rawPost(fake, "/api/session", { parentID: sid, title: "live", permissions: [{ action: "*", resource: "*", effect: "ask" }] })).data.id as string;
    await rawPost(fake, `/api/session/${live}/prompt`, { text: `do it ${M.permission}` });
    await waitFor(() => hub.opencodeOwnedSessions(H_INPROC, sid).length >= 61, 10_000, "the hub to own every child");
    const c = inprocClient(fake);
    const t0 = Date.now();
    while ((await c.listPermissions(live)).length === 0) {
      if (Date.now() - t0 > 10_000) throw new Error("the live child never asked");
      await sleep(20);
    }
    const h0 = mk({ ...inprocArgs, mode: "ask" });
    let openCalls = 0;
    cleanups.push(
      __forTest.setDeps({
        openChildSessions: (tid) => {
          if (tid !== h0.taskId) return [];
          openCalls++;
          return [live];
        },
        settledChildSessions: (tid) => (tid === h0.taskId ? settledIds : []),
      }),
    );
    const { prompt: _p, title: _t, resumeSessionId: _r, ...rest } = h0.args;
    const h = attachOpencodeServerLinger({ ...rest, sessionId: sid });
    liveTurns.push(h);
    expect(await doneWithin(h, 2000)).toBe(0);
    // The sync reads the open rows at its start and again at its end: then the linger decides.
    await waitFor(() => openCalls >= 2, 15_000, "the child sync to finish");
    await flush();
    expect(h.lingering()).toBe(true);
    expect(pending(h0.taskId).length).toBe(1);
  });

  test("a child that moved to the front while the children were paged is still followed", async () => {
    const fake = await inproc(0.4);
    const seeded = mk({ ...inprocArgs, prompt: "plain" });
    const first = start(seeded);
    expect(await doneWithin(first)).toBe(0);
    const sid = first.sessionId()!;
    const old = Array.from({ length: 200 }, (_, i) => ({ id: `ses_old${i}`, outcome: "succeeded", time: { created: 1, updated: 1 } }));
    const moved = { id: "ses_moved_front", time: { created: Date.now(), updated: Date.now() } };
    let listings = 0;
    watchClients({
      listChildren: (orig: (id: string) => Promise<unknown[]>, id: unknown) => {
        if (id !== sid) return orig(id as string);
        listings++;
        // The first full listing missed it (it moved across a page boundary); the page-one re-read has it.
        return Promise.resolve(listings === 1 ? old : [moved, ...old]);
      },
    });
    const registered: string[] = [];
    cleanups.push(__forTest.setDeps({ registerChild: (a) => void registered.push(a.childSessionId) }));
    const { prompt: _p, title: _t, resumeSessionId: _r, ...rest } = mk({ ...inprocArgs }).args;
    const h = attachOpencodeServerLinger({ ...rest, sessionId: sid });
    liveTurns.push(h);
    await waitFor(() => registered.includes("ses_moved_front"), 10_000, "the moved child to be followed");
    expect(listings).toBe(2);
  });

  test("a subagent's quota hint follows the child's own model, not the parent's", async () => {
    const fake = await inproc();
    const proxy = flakyProxy(fake);
    const ingested: Array<{ childSessionId: string; data: string }> = [];
    cleanups.push(
      __forTest.setDeps({
        ingestChildChunks: (a) => {
          for (const ch of a.chunks) ingested.push({ childSessionId: a.childSessionId, data: ch.data });
        },
      }),
    );
    const run = mk({ ...inprocArgs, prompt: `run ${M.slow}`, model: "opencode-go/deepseek-v4.1-flash" });
    const t = start(run);
    await waitFor(() => run.chunks.some((c) => c.stream === "tool_use"), 15_000, "the tool step");
    const sid = t.sessionId()!;
    const quota = { type: "provider.quota", message: "Upstream request failed: Insufficient account funds", status: 402 };
    // A Zen child under a Go parent, and a child whose model nobody tells (it falls back to the parent's).
    proxy.inject({ type: "session.created", data: { sessionID: "ses_zen_child", parentID: sid, model: { providerID: "opencode", id: "zen-x" } } });
    proxy.inject({ type: "session.created", data: { sessionID: "ses_quiet_child", parentID: sid } });
    await waitFor(() => hub.opencodeOwnedSessions(H_INPROC, sid).filter((o) => o.sessionId.endsWith("_child")).length === 2, 10_000, "the children to be owned");
    for (const child of ["ses_zen_child", "ses_quiet_child"]) {
      proxy.inject({ type: "session.execution.started", data: { sessionID: child } });
      proxy.inject({ type: "session.execution.failed", data: { sessionID: child, error: quota } });
    }
    const lineOf = (child: string) => ingested.find((x) => x.childSessionId === child && x.data.includes("Upstream request failed"))?.data;
    await waitFor(() => !!lineOf("ses_zen_child") && !!lineOf("ses_quiet_child"), 10_000, "both children's error lines");
    expect(lineOf("ses_zen_child")).toContain("Go subscription");
    expect(lineOf("ses_quiet_child")).not.toContain("Go subscription");
    t.kill();
    expect(await doneWithin(t)).toBe(130);
  });

  test("N4: a card a Stop sweep closed is not raised again by a lingering handle that can still act", async () => {
    const fake = await inproc(0.4, { realChildren: true });
    const proxy = flakyProxy(fake);
    const { taskId, runId } = seedTask();
    const t = start(mk({ ...inprocArgs, taskId, runId, prompt: `launch ${M.wake}`, mode: "ask" }));
    expect(await doneWithin(t)).toBe(0);
    await waitFor(() => pending(taskId).length === 1, 10_000, "the child's permission card");
    const childId = opencodeChildSessionOf(childRows(taskId)[0]!)!;
    // The Stop's sweep (the handle itself is not killed: it belongs to an earlier run).
    cancelPendingForTask(taskId, "cancelled by user");
    expect(pending(taskId).length).toBe(0);
    // A resync re-lists the child's requests: the server still holds it, but the card stays closed.
    const getsBefore = proxy.gets.length;
    fake.dropEventStreams();
    await waitFor(() => proxy.gets.slice(getsBefore).includes(`/api/session/${childId}/form`), 15_000, "the resync's re-list of the child");
    await flush();
    expect(pending(taskId).length).toBe(0);
    expect(t.lingering()).toBe(true);
    expect(replies(proxy)).toEqual([]);
  });

  /** A task with a finished turn, plus a child session of it the server holds with no outcome and an orphaned row (a crash's leftover). */
  async function crashLeftover(fake: FakeServer, live: boolean) {
    const { taskId, runId } = seedTask();
    const first = start(mk({ ...inprocArgs, taskId, runId, prompt: "before the crash" }));
    expect(await doneWithin(first)).toBe(0);
    const sid = first.sessionId()!;
    const child = (await rawPost(fake, "/api/session", { parentID: sid, title: "cut off", permissions: [{ action: "*", resource: "*", effect: "ask" }] })).data.id as string;
    if (live) {
      // Still executing on the server: it waits on a permission.
      await rawPost(fake, `/api/session/${child}/prompt`, { text: `do it ${M.permission}` });
      const c = inprocClient(fake);
      const t0 = Date.now();
      while ((await c.listPermissions(child)).length === 0) {
        if (Date.now() - t0 > 10_000) throw new Error("the child never asked");
        await sleep(20);
      }
    }
    registerOpencodeChildSession({ taskId, runId, parentSessionId: sid, childSessionId: child, depth: 1, background: true });
    expect(orphanRunningOpencodeChildrenOfTask(taskId)).toBe(1);
    return { taskId, runId, sid, child };
  }

  test("an orphaned child row the server does not list as executing is not adopted: the next turn does not linger, the row is retired", async () => {
    const fake = await inproc(0.4, { realChildren: true });
    const { taskId, runId, sid } = await crashLeftover(fake, false);
    const t = start(mk({ ...inprocArgs, taskId, runId, prompt: "after the crash", resumeSessionId: sid }));
    expect(await doneWithin(t)).toBe(0);
    expect(t.lingering()).toBe(false);
    await waitFor(() => !["running", "orphaned"].includes(childRows(taskId)[0]!.status), 10_000, "the orphan's row to be retired");
  });

  test("an orphaned child row the server lists as executing is adopted: the next turn lingers for it", async () => {
    const fake = await inproc(0.4, { realChildren: true });
    const { taskId, runId, sid } = await crashLeftover(fake, true);
    const t = start(mk({ ...inprocArgs, taskId, runId, prompt: "after the crash", mode: "ask", resumeSessionId: sid }));
    expect(await doneWithin(t)).toBe(0);
    expect(t.lingering()).toBe(true);
    await waitFor(() => pending(taskId).length === 1, 10_000, "the live child's card");
  });

  test("when the server's active sessions can't be read, an adopted orphan holding an open card still holds the linger; one without a card does not", async () => {
    const fake = await inproc(0.4, { realChildren: true });
    watchClients({ activeSessions: () => Promise.reject(Object.assign(new Error("activeSessions failed: boom"), { status: 500 })) });
    const carded = await crashLeftover(fake, true);
    const t = start(mk({ ...inprocArgs, taskId: carded.taskId, runId: carded.runId, prompt: "after the crash", mode: "ask", resumeSessionId: carded.sid }));
    expect(await doneWithin(t)).toBe(0);
    expect(t.lingering()).toBe(true);
    expect(pending(carded.taskId).length).toBe(1); // still answerable
    const bare = await crashLeftover(fake, false);
    const u = start(mk({ ...inprocArgs, taskId: bare.taskId, runId: bare.runId, prompt: "after the crash", mode: "ask", resumeSessionId: bare.sid }));
    expect(await doneWithin(u)).toBe(0);
    expect(u.lingering()).toBe(false);
  });

  test("C7: a removal the server does not confirm hands nothing back (the item stays parked)", async () => {
    const requeued = captureRequeue();
    const fake = await inproc();
    flakyProxy(fake);
    // The delete is "accepted" (true) but never reaches the server: the item is still in the inbox.
    watchClients({ cancelInboxItem: () => Promise.resolve(true) });
    const run = mk({ ...inprocArgs, prompt: `go ${M.slow}` });
    const t = start(run);
    await waitFor(() => run.chunks.some((c) => c.stream === "tool_use"), 15_000, "the tool step");
    expect(await t.steer("keep me")).toBe("accepted");
    t.kill();
    expect(await doneWithin(t)).toBe(130); // done waits for the hand-back attempt
    expect(requeued).toEqual([]);
    expect((await inprocClient(fake).listInbox(t.sessionId()!)).map((i) => i.text)).toEqual(["keep me"]);
  });
});

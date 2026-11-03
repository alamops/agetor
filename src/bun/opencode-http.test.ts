import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  OpencodeHttpError,
  createOpencodeClient,
  isLoopbackOpencodeUrl,
  openOpencodeEventStream,
  opencodeAuthHeader,
  type OpencodeEnvelope,
  type OpencodeServerRef,
} from "./opencode-http.ts";

// Plan: docs/plans/opencode-server-driver.md (T1). A local Bun.serve stub on
// port 0 stands in for `opencode serve`; the real binary is never run.

const PASSWORD = "s3cr3t-pw-do-not-leak";
const AUTH = opencodeAuthHeader(PASSWORD);

interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  auth: string | null;
  contentType: string | null;
}

let server: ReturnType<typeof Bun.serve>;
let ref: OpencodeServerRef;
let seen: Seen[] = [];
/** Per-test response script keyed by "METHOD path". */
let script: Record<string, (req: Request, url: URL) => Response | Promise<Response>> = {};
const enc = new TextEncoder();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      let body: unknown = undefined;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      seen.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
        auth: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
      });
      const h = script[`${req.method} ${url.pathname}`];
      if (!h) return json({ _tag: "NotFoundError", message: "no route" }, 404);
      return h(req, url);
    },
  });
  ref = { url: `http://127.0.0.1:${server.port}`, password: PASSWORD };
});

afterAll(() => {
  server.stop(true);
});

function reset(s: typeof script = {}) {
  seen = [];
  script = s;
}

describe("opencodeAuthHeader / isLoopbackOpencodeUrl", () => {
  test("builds Basic auth with the opencode username", () => {
    expect(opencodeAuthHeader("pw")).toBe("Basic " + Buffer.from("opencode:pw").toString("base64"));
  });

  test("accepts only http loopback origins", () => {
    for (const ok of ["http://127.0.0.1:4096", "http://localhost:4096", "http://[::1]:4096", "http://127.0.0.1:1/"]) {
      expect(isLoopbackOpencodeUrl(ok)).toBe(true);
    }
    for (const bad of [
      "https://127.0.0.1:4096",
      "http://0.0.0.0:4096",
      "http://192.168.1.5:4096",
      "http://example.com",
      "http://localhost.evil.com:4096",
      "http://127.0.0.1.evil.com",
      "http://user:pw@127.0.0.1:4096",
      "ftp://127.0.0.1",
      "127.0.0.1:4096",
      "",
    ]) {
      expect(isLoopbackOpencodeUrl(bad)).toBe(false);
    }
  });

  test("both constructors refuse a non-loopback url or an empty password", () => {
    const noop = { onEvent() {}, onClose() {} };
    expect(() => createOpencodeClient({ url: "http://example.com", password: "x" })).toThrow(/loopback/);
    expect(() => createOpencodeClient({ url: "https://127.0.0.1:1", password: "x" })).toThrow(/loopback/);
    expect(() => createOpencodeClient({ url: "http://127.0.0.1:1", password: "" })).toThrow(/password/);
    expect(() => openOpencodeEventStream({ url: "http://10.0.0.1:1", password: "x" }, noop)).toThrow(/loopback/);
    expect(() => openOpencodeEventStream({ url: "http://127.0.0.1:1", password: "" }, noop)).toThrow(/password/);
  });

  test("a loopback url with a path is reduced to its origin", async () => {
    reset({ "GET /api/info": () => json({ version: "2.1.3", pid: 7, urls: [], paths: { tmp: "/t" } }) });
    const c = createOpencodeClient({ url: `${ref.url}/some/prefix/`, password: PASSWORD });
    expect(await c.info()).toEqual({ version: "2.1.3", pid: 7 });
    expect(seen[0]!.path).toBe("/api/info");
  });
});

describe("request ops: method, path, body, auth", () => {
  const sess = { id: "ses_abc", title: "t" };

  test("info", async () => {
    reset({ "GET /api/info": () => json({ version: "2.1.3", pid: 4242, urls: [], paths: { tmp: "/t" } }) });
    const c = createOpencodeClient(ref);
    expect(await c.info()).toEqual({ version: "2.1.3", pid: 4242 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "GET", path: "/api/info", auth: AUTH, body: undefined });
    expect(seen[0]!.contentType).toBeNull();
  });

  test("createSession sends location.directory and drops undefined fields", async () => {
    reset({ "POST /api/session": () => json({ data: sess }) });
    const c = createOpencodeClient(ref);
    const out = await c.createSession({
      directory: "/work/repo",
      title: "My task",
      agent: "build",
      model: { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "max" },
      permissions: [{ action: "*", resource: "*", effect: "ask" }],
    });
    expect(out).toEqual(sess);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/api/session", auth: AUTH, contentType: "application/json" });
    expect(seen[0]!.body).toEqual({
      title: "My task",
      agent: "build",
      model: { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "max" },
      location: { directory: "/work/repo" },
      permissions: [{ action: "*", resource: "*", effect: "ask" }],
    });

    reset({ "POST /api/session": () => json({ data: sess }) });
    await c.createSession({ directory: "/w", model: { providerID: "p", id: "m" } });
    expect(seen[0]!.body).toEqual({ model: { providerID: "p", id: "m" }, location: { directory: "/w" } });
  });

  test("createSession without an id in the reply is a BadResponse", async () => {
    reset({ "POST /api/session": () => json({ data: {} }) });
    const c = createOpencodeClient(ref);
    const err = await c.createSession({ directory: "/w" }).catch((e) => e);
    expect(err).toBeInstanceOf(OpencodeHttpError);
    expect(err.tag).toBe("BadResponse");
  });

  test("getSession returns the session, and null on 404", async () => {
    reset({
      "GET /api/session/ses_abc": () => json({ data: sess }),
      "GET /api/session/ses_gone": () => json({ _tag: "SessionNotFoundError", sessionID: "ses_gone", message: "nope" }, 404),
    });
    const c = createOpencodeClient(ref);
    expect(await c.getSession("ses_abc")).toEqual(sess);
    expect(await c.getSession("ses_gone")).toBeNull();
    expect(seen[0]).toMatchObject({ method: "GET", path: "/api/session/ses_abc", auth: AUTH });
  });

  test("getSession still throws for non-404 failures", async () => {
    reset({ "GET /api/session/ses_x": () => json({ _tag: "Boom", message: "server fell over" }, 500) });
    const err = await createOpencodeClient(ref).getSession("ses_x").catch((e) => e);
    expect(err).toBeInstanceOf(OpencodeHttpError);
    expect(err.status).toBe(500);
  });

  test("ids are path-encoded", async () => {
    reset({ "GET /api/session/a%2Fb": () => json({ data: sess }) });
    await createOpencodeClient(ref).getSession("a/b");
    // Bun.serve keeps the escaped form in url.pathname.
    expect(seen[0]!.path).toBe("/api/session/a%2Fb");
  });

  test("updateSession PATCHes title and permissions only", async () => {
    reset({ "PATCH /api/session/ses_abc": () => new Response(null, { status: 204 }) });
    const c = createOpencodeClient(ref);
    await c.updateSession("ses_abc", { title: "renamed" });
    expect(seen[0]).toMatchObject({ method: "PATCH", path: "/api/session/ses_abc", body: { title: "renamed" }, auth: AUTH });
    reset({ "PATCH /api/session/ses_abc": () => new Response(null, { status: 204 }) });
    await c.updateSession("ses_abc", { permissions: [{ action: "shell", resource: "*", effect: "deny" }] });
    expect(seen[0]!.body).toEqual({ permissions: [{ action: "shell", resource: "*", effect: "deny" }] });
  });

  test("switchModel and switchAgent", async () => {
    reset({
      "POST /api/session/ses_abc/model": () => new Response(null, { status: 204 }),
      "POST /api/session/ses_abc/agent": () => new Response(null, { status: 204 }),
    });
    const c = createOpencodeClient(ref);
    await c.switchModel("ses_abc", { providerID: "p", id: "m", variant: "high" });
    await c.switchAgent("ses_abc", "build");
    expect(seen[0]).toMatchObject({ method: "POST", path: "/api/session/ses_abc/model", body: { model: { providerID: "p", id: "m", variant: "high" } } });
    expect(seen[1]).toMatchObject({ method: "POST", path: "/api/session/ses_abc/agent", body: { agent: "build" } });
    expect(seen.every((s) => s.auth === AUTH)).toBe(true);
  });

  test("prompt sends text, id and delivery verbatim and returns the inbox item", async () => {
    reset({
      "POST /api/session/ses_abc/prompt": () =>
        json({ data: { id: "msg_1", type: "user", payload: { text: "hi" }, delivery: "steer" } }),
    });
    const c = createOpencodeClient(ref);
    const text = "  keep   my\nwhitespace <b>as is</b>  ";
    const out = await c.prompt("ses_abc", { id: "msg_1", text, delivery: "steer" });
    expect(out).toEqual({ id: "msg_1", delivery: "steer" });
    expect(seen[0]).toMatchObject({ method: "POST", path: "/api/session/ses_abc/prompt", auth: AUTH });
    expect(seen[0]!.body).toEqual({ id: "msg_1", text, delivery: "steer" });

    reset({ "POST /api/session/ses_abc/prompt": () => json({ data: { id: "msg_2", delivery: "queue" } }) });
    await c.prompt("ses_abc", { text: "x" });
    expect(seen[0]!.body).toEqual({ text: "x" });
  });

  test("prompt 409 maps to a typed error", async () => {
    reset({ "POST /api/session/ses_abc/prompt": () => json({ _tag: "ConflictError", message: "busy" }, 409) });
    const err = await createOpencodeClient(ref).prompt("ses_abc", { text: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(OpencodeHttpError);
    expect(err).toMatchObject({ status: 409, tag: "ConflictError", op: "prompt" });
    expect(err.message).toContain("busy");
  });

  test("interrupt returns the server's flag", async () => {
    reset({ "POST /api/session/ses_abc/interrupt": () => json({ interrupted: true }) });
    const c = createOpencodeClient(ref);
    expect(await c.interrupt("ses_abc")).toBe(true);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/api/session/ses_abc/interrupt", body: undefined });
    reset({ "POST /api/session/ses_abc/interrupt": () => json({ interrupted: false }) });
    expect(await c.interrupt("ses_abc")).toBe(false);
  });

  test("activeSessions", async () => {
    reset({ "GET /api/session/active": () => json({ data: { ses_a: { type: "running" } } }) });
    expect(await createOpencodeClient(ref).activeSessions()).toEqual({ ses_a: { type: "running" } });
    expect(seen[0]).toMatchObject({ method: "GET", path: "/api/session/active", auth: AUTH });
  });

  test("listMessages passes limit and order, and normalizes null cursors", async () => {
    reset({
      "GET /api/session/ses_abc/message": () => json({ data: [{ id: "m1" }], cursor: { previous: null, next: "cur2" } }),
    });
    const c = createOpencodeClient(ref);
    const out = await c.listMessages("ses_abc", { limit: 50, order: "desc" });
    expect(out).toEqual({ data: [{ id: "m1" }], cursor: { next: "cur2", previous: undefined } });
    expect(seen[0]!.query).toEqual({ limit: "50", order: "desc" });
  });

  test("listMessages never sends order together with a cursor", async () => {
    reset({ "GET /api/session/ses_abc/message": () => json({ data: [], cursor: {} }) });
    await createOpencodeClient(ref).listMessages("ses_abc", { cursor: "cur2", order: "asc", limit: 200 });
    expect(seen[0]!.query).toEqual({ cursor: "cur2", limit: "200" });
  });

  test("listPermissions / listForms", async () => {
    reset({
      "GET /api/session/ses_abc/permission": () => json({ data: [{ id: "per_1" }] }),
      "GET /api/session/ses_abc/form": () => json({ data: [{ id: "frm_1" }] }),
    });
    const c = createOpencodeClient(ref);
    expect(await c.listPermissions("ses_abc")).toEqual([{ id: "per_1" }]);
    expect(await c.listForms("ses_abc")).toEqual([{ id: "frm_1" }]);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "GET /api/session/ses_abc/permission",
      "GET /api/session/ses_abc/form",
    ]);
  });

  test("replyPermission sends decision and the user's message verbatim", async () => {
    reset({ "POST /api/session/ses_abc/permission/per_1/reply": () => new Response(null, { status: 204 }) });
    const c = createOpencodeClient(ref);
    await c.replyPermission("ses_abc", "per_1", { decision: "reject", message: "no thanks" });
    expect(seen[0]).toMatchObject({
      method: "POST",
      path: "/api/session/ses_abc/permission/per_1/reply",
      body: { decision: "reject", message: "no thanks" },
      auth: AUTH,
    });
    reset({ "POST /api/session/ses_abc/permission/per_1/reply": () => new Response(null, { status: 204 }) });
    await c.replyPermission("ses_abc", "per_1", { decision: "once" });
    expect(seen[0]!.body).toEqual({ decision: "once" });
  });

  test("replyForm wraps the answer; cancelForm DELETEs with an optional message query", async () => {
    reset({
      "POST /api/session/ses_abc/form/frm_1/reply": () => new Response(null, { status: 204 }),
      "DELETE /api/session/ses_abc/form/frm_1": () => new Response(null, { status: 204 }),
    });
    const c = createOpencodeClient(ref);
    await c.replyForm("ses_abc", "frm_1", { q0: ["a"], q1: "" });
    expect(seen[0]).toMatchObject({ method: "POST", path: "/api/session/ses_abc/form/frm_1/reply", body: { answer: { q0: ["a"], q1: "" } } });
    await c.cancelForm("ses_abc", "frm_1", "skip & go");
    await c.cancelForm("ses_abc", "frm_1");
    expect(seen[1]).toMatchObject({ method: "DELETE", path: "/api/session/ses_abc/form/frm_1", query: { message: "skip & go" } });
    expect(seen[2]!.query).toEqual({});
    expect(seen[2]!.body).toBeUndefined();
  });

  test("listChildren filters by parentID, follows the cursor, dedupes and caps pages", async () => {
    let calls = 0;
    reset({
      "GET /api/session": (_req, url) => {
        calls++;
        if (!url.searchParams.get("cursor")) return json({ data: [{ id: "ses_c1" }, { id: "ses_c2" }], cursor: { next: "p2" } });
        return json({ data: [{ id: "ses_c2" }, { id: "ses_c3" }], cursor: { next: null } });
      },
    });
    const c = createOpencodeClient(ref);
    expect(await c.listChildren("ses_parent")).toEqual([{ id: "ses_c1" }, { id: "ses_c2" }, { id: "ses_c3" }]);
    expect(seen[0]!.query).toMatchObject({ parentID: "ses_parent", limit: "200" });
    expect(seen[1]!.query).toMatchObject({ parentID: "ses_parent", cursor: "p2" });
    expect(calls).toBe(2);

    // A server that never stops paging cannot loop the client forever.
    calls = 0;
    reset({
      "GET /api/session": () => {
        calls++;
        return json({ data: [{ id: `ses_${calls}` }], cursor: { next: `p${calls + 1}` } });
      },
    });
    const all = await c.listChildren("ses_parent");
    expect(calls).toBe(10);
    expect(all).toHaveLength(10);
  });
});

describe("errors", () => {
  test("401, 404 and 409 become OpencodeHttpError with status, tag and op", async () => {
    reset({
      "GET /api/session/active": () => new Response("Unauthorized", { status: 401 }),
      "POST /api/session/ses_x/interrupt": () => json({ _tag: "SessionNotFoundError", sessionID: "ses_x", message: "no such session" }, 404),
      "POST /api/session/ses_x/form/f/reply": () => json({ _tag: "FormAlreadySettledError", message: "settled" }, 409),
    });
    const c = createOpencodeClient(ref);
    const e401 = await c.activeSessions().catch((e) => e);
    expect(e401).toBeInstanceOf(OpencodeHttpError);
    expect(e401).toMatchObject({ status: 401, op: "activeSessions", name: "OpencodeHttpError" });
    expect(e401.tag).toBeUndefined();

    const e404 = await c.interrupt("ses_x").catch((e) => e);
    expect(e404).toMatchObject({ status: 404, tag: "SessionNotFoundError", op: "interrupt" });
    expect(e404.message).toContain("no such session");

    const e409 = await c.replyForm("ses_x", "f", {}).catch((e) => e);
    expect(e409).toMatchObject({ status: 409, tag: "FormAlreadySettledError", op: "replyForm" });
  });

  test("an error message never contains the password or the auth header, even if the server echoes it", async () => {
    reset({
      "GET /api/info": () =>
        json({ _tag: "Echo", message: `bad creds ${PASSWORD} header ${AUTH} \u0007bell` }, 401),
    });
    const err = await createOpencodeClient(ref).info().catch((e) => e);
    expect(err).toBeInstanceOf(OpencodeHttpError);
    const all = `${err.message} ${err.tag ?? ""} ${err.stack ?? ""}`;
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(AUTH);
    expect(all).not.toContain(AUTH.slice("Basic ".length));
    expect(err.message).toContain("[redacted]");
    // eslint-disable-next-line no-control-regex
    expect(err.message).not.toMatch(/[\u0000-\u001f]/);
  });

  test("a server-supplied message is length-capped", async () => {
    reset({ "GET /api/info": () => json({ _tag: "Big", message: "x".repeat(5000) }, 500) });
    const err = await createOpencodeClient(ref).info().catch((e) => e);
    expect(err.message.length).toBeLessThan(500);
  });

  test("a 2xx non-JSON body is a BadResponse", async () => {
    reset({ "GET /api/info": () => new Response("<html>nope</html>", { status: 200 }) });
    const err = await createOpencodeClient(ref).info().catch((e) => e);
    expect(err).toMatchObject({ status: 200, tag: "BadResponse" });
  });

  test("a transport failure is a status-0 NetworkError without the password", async () => {
    const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const url = `http://127.0.0.1:${dead.port}`;
    dead.stop(true);
    const err = await createOpencodeClient({ url, password: PASSWORD }).info().catch((e) => e);
    expect(err).toBeInstanceOf(OpencodeHttpError);
    expect(err).toMatchObject({ status: 0, tag: "NetworkError", op: "info" });
    expect(err.message).not.toContain(PASSWORD);
  });

  test("a redirect is refused rather than followed with the credentials", async () => {
    reset({ "GET /api/info": () => new Response(null, { status: 302, headers: { location: "http://example.invalid/" } }) });
    const err = await createOpencodeClient(ref).info().catch((e) => e);
    expect(err).toBeInstanceOf(OpencodeHttpError);
    expect(err.status).toBe(0);
  });

  test("the per-call timeout fires, for a stalled reply and a stalled body", async () => {
    reset({
      "GET /api/info": () => new Promise<Response>(() => {}),
      "GET /api/session/active": () =>
        new Response(
          new ReadableStream({
            start(ctrl) {
              ctrl.enqueue(enc.encode('{"data":'));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const c = createOpencodeClient(ref, { timeoutMs: 150 });
    const t0 = Date.now();
    const e1 = await c.info().catch((e) => e);
    expect(e1).toMatchObject({ status: 0, tag: "Timeout", op: "info" });
    expect(Date.now() - t0).toBeLessThan(2000);
    const e2 = await c.activeSessions().catch((e) => e);
    expect(e2).toMatchObject({ status: 0, tag: "Timeout", op: "activeSessions" });
  });

  test("fetchImpl is injectable and receives the Authorization header", async () => {
    let got: Headers | null = null;
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      got = new Headers(init?.headers);
      return json({ version: "9.9.9", pid: 1 });
    }) as unknown as typeof fetch;
    const c = createOpencodeClient(ref, { fetchImpl });
    expect((await c.info()).version).toBe("9.9.9");
    expect(got!.get("authorization")).toBe(AUTH);
  });
});

describe("openOpencodeEventStream", () => {
  interface Handle {
    ctrl: ReadableStreamDefaultController<Uint8Array>;
  }
  let handles: Handle[] = [];
  let sseHits: Seen[] = [];

  function sseRoute(): void {
    handles = [];
    sseHits = [];
    script["GET /api/event"] = () => {
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          handles.push({ ctrl });
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    };
  }

  function collect() {
    const events: OpencodeEnvelope[] = [];
    const closes: Array<{ reason: string; err?: unknown }> = [];
    let opened = 0;
    return {
      events,
      closes,
      get opened() {
        return opened;
      },
      h: {
        onEvent: (e: OpencodeEnvelope) => events.push(e),
        onOpen: () => {
          opened++;
        },
        onClose: (reason: string, err?: unknown) => closes.push({ reason, err }),
      },
    };
  }

  async function until(pred: () => boolean, ms = 3000) {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error("until: timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  const push = (i: number, s: string) => handles[i]!.ctrl.enqueue(enc.encode(s));

  test("sends Basic auth + accept, parses frames, and skips comments", async () => {
    reset();
    sseRoute();
    const c = collect();
    const s = openOpencodeEventStream(ref, c.h);
    await until(() => handles.length === 1);
    expect(seen[0]).toMatchObject({ method: "GET", path: "/api/event", auth: AUTH });
    push(0, 'data: {"id":"evt_1","type":"server.connected","data":{}}\n\n');
    push(0, ": heartbeat\n\n");
    push(0, 'data: {"type":"session.text.delta","data":{"sessionID":"ses_a","delta":"hi"},"durable":{"aggregateID":"ses_a","seq":3}}\n\n');
    await until(() => c.events.length === 2);
    expect(c.opened).toBe(1);
    expect(c.events[0]).toMatchObject({ id: "evt_1", type: "server.connected" });
    expect(c.events[1]).toMatchObject({ type: "session.text.delta", durable: { aggregateID: "ses_a", seq: 3 } });
    expect(s.stats()).toEqual({ events: 2, dropped: 0 });
    s.close();
  });

  test("frames split across arbitrary byte boundaries (even mid-UTF-8) and multi-line data reassemble", async () => {
    reset();
    sseRoute();
    const c = collect();
    const s = openOpencodeEventStream(ref, c.h);
    await until(() => handles.length === 1);
    const frame1 = enc.encode('data: {"type":"a","data":{"t":"héllo wörld ✓"}}\n\n');
    // Feed one byte at a time: splits inside multi-byte characters and between "\n" "\n".
    for (const b of frame1) handles[0]!.ctrl.enqueue(new Uint8Array([b]));
    // A frame whose JSON spans two data: lines is joined with "\n" before parsing.
    push(0, 'data: {"type":"b",\ndata: "data":{"n":1}}\n\n');
    // CRLF line endings, with the CR and LF split across chunks.
    push(0, 'data: {"type":"c"}\r');
    push(0, "\n\r");
    push(0, "\n");
    await until(() => c.events.length === 3);
    expect(c.events.map((e) => e.type)).toEqual(["a", "b", "c"]);
    expect(c.events[0]!.data.t).toBe("héllo wörld ✓");
    expect(c.events[1]!.data).toEqual({ n: 1 });
    s.close();
  });

  test("ignores and counts unparsable frames, and non-event JSON", async () => {
    reset();
    sseRoute();
    const c = collect();
    const s = openOpencodeEventStream(ref, c.h);
    await until(() => handles.length === 1);
    push(0, "data: {not json\n\n");
    push(0, "data: 42\n\n");
    push(0, 'data: {"no":"type"}\n\n');
    push(0, "event: ping\nid: 9\nretry: 1000\n\n"); // fields we ignore, no data → not a frame
    push(0, 'data: {"type":"ok"}\n\n');
    await until(() => c.events.length === 1);
    expect(c.events[0]!.type).toBe("ok");
    expect(s.stats()).toEqual({ events: 1, dropped: 3 });
    expect(c.closes).toHaveLength(0);
    s.close();
  });

  test("reports a stalled stream after stallMs without bytes; heartbeats keep it alive", async () => {
    reset();
    sseRoute();
    const c = collect();
    const s = openOpencodeEventStream(ref, c.h, { stallMs: 200 });
    await until(() => handles.length === 1);
    // Heartbeats every 80 ms for ~400 ms: no stall.
    for (let i = 0; i < 5; i++) {
      push(0, ": heartbeat\n\n");
      await new Promise((r) => setTimeout(r, 80));
    }
    expect(c.closes).toHaveLength(0);
    const t0 = Date.now();
    await until(() => c.closes.length === 1);
    expect(c.closes[0]!.reason).toBe("stalled");
    expect(Date.now() - t0).toBeLessThan(1500);
    s.close(); // after the fact: no second onClose
    await new Promise((r) => setTimeout(r, 30));
    expect(c.closes).toHaveLength(1);
  });

  test("the watchdog also covers a connect that never answers", async () => {
    reset({ "GET /api/event": () => new Promise<Response>(() => {}) });
    const c = collect();
    openOpencodeEventStream(ref, c.h, { stallMs: 150 });
    await until(() => c.closes.length === 1);
    expect(c.closes[0]!.reason).toBe("stalled");
    expect(c.opened).toBe(0);
  });

  test("close() aborts and fires onClose('aborted') exactly once", async () => {
    reset();
    sseRoute();
    const c = collect();
    const s = openOpencodeEventStream(ref, c.h);
    await until(() => handles.length === 1);
    push(0, 'data: {"type":"x"}\n\n');
    await until(() => c.events.length === 1);
    s.close();
    s.close();
    push(0, 'data: {"type":"late"}\n\n'); // after close: dropped
    await new Promise((r) => setTimeout(r, 50));
    expect(c.closes.map((x) => x.reason)).toEqual(["aborted"]);
    expect(c.events).toHaveLength(1);
  });

  test("close() before the response arrives is also single-shot", async () => {
    reset({ "GET /api/event": () => new Promise<Response>(() => {}) });
    const c = collect();
    const s = openOpencodeEventStream(ref, c.h);
    s.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(c.closes.map((x) => x.reason)).toEqual(["aborted"]);
    expect(c.opened).toBe(0);
  });

  test("a server that closes the stream reports 'ended'", async () => {
    reset();
    sseRoute();
    const c = collect();
    openOpencodeEventStream(ref, c.h);
    await until(() => handles.length === 1);
    push(0, 'data: {"type":"last"}\n\n');
    handles[0]!.ctrl.close();
    await until(() => c.closes.length === 1);
    expect(c.closes[0]!.reason).toBe("ended");
    expect(c.events.map((e) => e.type)).toEqual(["last"]);
  });

  test("a non-2xx connect reports 'error' with a typed, password-free error", async () => {
    reset({ "GET /api/event": () => new Response("nope", { status: 401 }) });
    const c = collect();
    openOpencodeEventStream(ref, c.h);
    await until(() => c.closes.length === 1);
    expect(c.closes[0]!.reason).toBe("error");
    const err = c.closes[0]!.err;
    expect(err).toBeInstanceOf(OpencodeHttpError);
    expect((err as OpencodeHttpError).status).toBe(401);
    expect(String((err as Error).message)).not.toContain(PASSWORD);
    expect(c.opened).toBe(0);
  });

  test("a connection error reports 'error' without leaking the password", async () => {
    const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const url = `http://127.0.0.1:${dead.port}`;
    dead.stop(true);
    const c = collect();
    openOpencodeEventStream({ url, password: PASSWORD }, c.h);
    await until(() => c.closes.length === 1);
    expect(c.closes[0]!.reason).toBe("error");
    expect(String((c.closes[0]!.err as Error)?.message)).not.toContain(PASSWORD);
  });

  test("an onEvent that throws ends the stream with 'error' so the hub can resync", async () => {
    reset();
    sseRoute();
    const closes: Array<{ reason: string; err?: unknown }> = [];
    let n = 0;
    openOpencodeEventStream(ref, {
      onEvent() {
        n++;
        throw new Error("mapper blew up");
      },
      onClose: (reason, err) => closes.push({ reason, err }),
    });
    await until(() => handles.length === 1);
    push(0, 'data: {"type":"a"}\n\ndata: {"type":"b"}\n\n');
    await until(() => closes.length === 1);
    expect(closes[0]!.reason).toBe("error");
    expect((closes[0]!.err as Error).message).toBe("mapper blew up");
    expect(n).toBe(1); // the second frame in the same chunk is not delivered
  });
});

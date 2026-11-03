import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startFakeOpencodeServer, type FakeOpencodeOptions, type FakeOpencodeServer } from "./fake-serve.ts";

// The fake's event orders mirror the live OpenCode 2.1.3 transcripts recorded
// while verifying plan assumptions A1-A5 (docs/plans/opencode-server-driver.md
// section 8); each test names the transcript behaviour it pins.

type Ev = { id: string; type: string; data: any; durable?: any; location?: any; created?: number };

interface Collector {
  events: Ev[];
  heartbeats: number;
  ended: Promise<void>;
  waitFor(pred: (e: Ev) => boolean, ms?: number): Promise<Ev>;
  /** Event types of one session (or all), without the high-volume delta events. */
  types(sessionID?: string): string[];
  close(): void;
}

class Client {
  constructor(
    readonly url: string,
    readonly password: string,
  ) {}
  get auth(): string {
    return `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`;
  }
  async req(method: string, p: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
    const r = await fetch(this.url + p, {
      method,
      headers: { authorization: this.auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: r.status, json, text };
  }
  async session(extra: Record<string, unknown> = {}): Promise<string> {
    const r = await this.req("POST", "/api/session", {
      title: "t",
      location: { directory: "/tmp/project" },
      model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      agent: "build",
      ...extra,
    });
    expect(r.status).toBe(200);
    return r.json.data.id as string;
  }
  prompt(sid: string, text: string, delivery?: "steer" | "queue") {
    return this.req("POST", `/api/session/${sid}/prompt`, { text, ...(delivery ? { delivery } : {}) });
  }
  subscribe(): Collector {
    const ac = new AbortController();
    const events: Ev[] = [];
    const waiters: Array<{ pred: (e: Ev) => boolean; res: (e: Ev) => void }> = [];
    const out: Collector = {
      events,
      heartbeats: 0,
      ended: Promise.resolve(),
      waitFor(pred, ms = 5000) {
        const hit = events.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise<Ev>((res, rej) => {
          const t = setTimeout(() => rej(new Error(`waitFor timed out; saw ${events.map((e) => e.type).join(",")}`)), ms);
          waiters.push({
            pred,
            res: (e) => {
              clearTimeout(t);
              res(e);
            },
          });
        });
      },
      types(sessionID) {
        return events
          .filter((e) => !e.type.endsWith(".delta") && (!sessionID || e.data?.sessionID === sessionID))
          .map((e) => e.type);
      },
      close: () => ac.abort(),
    };
    let ready!: () => void;
    const connected = new Promise<void>((r) => (ready = r));
    out.ended = (async () => {
      const r = await fetch(this.url + "/api/event", { headers: { authorization: this.auth, accept: "text/event-stream" }, signal: ac.signal });
      const dec = new TextDecoder();
      let buf = "";
      try {
        for await (const chunk of r.body as any) {
          buf += dec.decode(chunk, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (block.startsWith(":")) {
              out.heartbeats++;
              continue;
            }
            const line = block.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            const ev = JSON.parse(line.slice(5).trim()) as Ev;
            events.push(ev);
            if (ev.type === "server.connected") ready();
            for (let k = waiters.length - 1; k >= 0; k--) {
              if (waiters[k]!.pred(ev)) waiters.splice(k, 1)[0]!.res(ev);
            }
          }
        }
      } catch {
        // aborted
      }
    })();
    (out as any).connected = connected;
    return out;
  }
}

const open: FakeOpencodeServer[] = [];
const collectors: Collector[] = [];
afterEach(async () => {
  for (const c of collectors.splice(0)) c.close();
  for (const s of open.splice(0)) await s.stop();
});

async function boot(opts: FakeOpencodeOptions = {}) {
  const srv = await startFakeOpencodeServer({ password: "pw-test", speed: 0.02, heartbeatMs: 40, ...opts });
  open.push(srv);
  const client = new Client(srv.url, srv.password);
  const sub = client.subscribe();
  collectors.push(sub);
  await (sub as any).connected;
  return { srv, client, sub };
}
const finished = (sid: string, nth = 1) => (e: Ev) => e.data?.sessionID === sid && /^session\.execution\.(succeeded|failed|interrupted)$/.test(e.type) && e.type !== "session.execution.started";
/** Wait for the nth terminal execution event of a session. */
async function terminal(sub: Collector, sid: string, nth = 1): Promise<Ev> {
  const start = Date.now();
  for (;;) {
    const hits = sub.events.filter(finished(sid));
    if (hits.length >= nth) return hits[nth - 1]!;
    if (Date.now() - start > 8000) throw new Error(`no terminal #${nth}: ${sub.types(sid).join(",")}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
/** Index of the nth (1-based) occurrence of `type`, or -1. */
function nth(got: string[], type: string, n: number): number {
  let at = -1;
  for (let k = 0; k < n; k++) {
    at = got.indexOf(type, at + 1);
    if (at < 0) return -1;
  }
  return at;
}
/** `want` must occur in `got` in order (not necessarily adjacent). */
function inOrder(got: string[], want: string[]): void {
  let at = -1;
  for (const w of want) {
    const i = got.indexOf(w, at + 1);
    if (i < 0) throw new Error(`expected ${w} after index ${at} in ${got.join(",")}`);
    at = i;
  }
}
async function messages(client: Client, sid: string): Promise<any[]> {
  const r = await client.req("GET", `/api/session/${sid}/message?order=asc`);
  expect(r.status).toBe(200);
  return r.json.data;
}
const finalText = (msgs: any[]): string => {
  const a = msgs.filter((m) => m.type === "assistant").at(-1);
  return (a?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
};

describe("auth, info and the event stream", () => {
  test("every route needs Basic auth opencode:<password>; /api/info reports the version", async () => {
    const { srv, client } = await boot();
    const bare = await fetch(srv.url + "/api/info");
    expect(bare.status).toBe(401);
    expect(await bare.json()).toEqual({ _tag: "UnauthorizedError", message: "Authentication required" });
    const wrong = await fetch(srv.url + "/api/info", { headers: { authorization: `Basic ${Buffer.from("opencode:nope").toString("base64")}` } });
    expect(wrong.status).toBe(401);
    const info = await client.req("GET", "/api/info");
    expect(info.status).toBe(200);
    expect(info.json.version).toBe("2.1.3");
    expect(info.json.urls).toEqual([srv.url]);
    expect((await fetch(srv.url + "/api/event")).status).toBe(401);
    expect((await fetch(srv.url + "/api/session")).status).toBe(401);
  });

  test("/api/event starts with server.connected, sends `: heartbeat` comments, and can be dropped", async () => {
    const { srv, sub } = await boot({ heartbeatMs: 25 });
    expect(sub.events[0]!.type).toBe("server.connected");
    expect(sub.events[0]!.id).toMatch(/^evt_/);
    const start = Date.now();
    while (sub.heartbeats < 2 && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 10));
    expect(sub.heartbeats).toBeGreaterThanOrEqual(2);
    srv.dropEventStreams();
    await sub.ended;
  });
});

describe("sessions and the plain turn", () => {
  test("a plain prompt emits the recorded event order and a snapshot built from it (A4 baseline, q5/q6)", async () => {
    const { client, sub } = await boot();
    const sid = await client.session();
    const created = sub.events.find((e) => e.type === "session.created")!;
    expect(created.data.sessionID).toBe(sid);
    expect(created.data.parentID).toBeUndefined();

    const p = await client.prompt(sid, "hello there");
    expect(p.status).toBe(200);
    expect(p.json.data).toMatchObject({ sessionID: sid, type: "user", payload: { text: "hello there" }, delivery: "steer" });
    expect((await client.req("GET", `/api/session/active`)).json.data[sid]).toEqual({ type: "running" });
    await terminal(sub, sid);

    expect(sub.types(sid).filter((t) => t !== "session.created" && t !== "session.instructions.updated")).toEqual([
      "session.inbox.enqueued",
      "session.execution.started",
      "session.inbox.delivered",
      "session.step.started",
      "session.text.started",
      "session.text.ended",
      "session.step.streamed",
      "session.step.ended",
      "session.usage.updated",
      "session.execution.succeeded",
    ]);
    const ended = sub.events.find((e) => e.type === "session.step.ended")!;
    expect(ended.data).toMatchObject({ finish: "stop", rawFinish: "stop", files: [] });
    expect(ended.data.tokens.cache).toBeDefined();
    expect(typeof ended.data.cost).toBe("number");
    const usage = sub.events.find((e) => e.type === "session.usage.updated")!;
    expect(usage.data.cost).toBeCloseTo(ended.data.cost, 12);
    // durable seq is per session and increasing
    const seqs = sub.events.filter((e) => e.durable?.aggregateID === sid).map((e) => e.durable.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    const msgs = await messages(client, sid);
    expect(msgs.map((m) => m.type)).toEqual(["user", "assistant", "idle"]);
    expect(msgs[0].id).toBe(p.json.data.id);
    expect(msgs[1].finish).toBe("stop");
    expect(finalText(msgs)).toBe("ACK: hello there");
    expect(msgs[2].outcome).toBe("succeeded");
    const s = (await client.req("GET", `/api/session/${sid}`)).json.data;
    expect(s.outcome).toBe("succeeded");
    expect(s.time.idle).toBeGreaterThan(0);
    expect(s.model.variant).toBe("default");
    expect((await client.req("GET", `/api/session/active`)).json.data[sid]).toBeUndefined();
    // the session is reusable
    await client.prompt(sid, "again");
    await terminal(sub, sid, 2);
    expect((await messages(client, sid)).map((m) => m.type)).toEqual(["user", "assistant", "idle", "user", "assistant", "idle"]);
  });

  test("error shapes match the API: 404 SessionNotFoundError, 400 Missing key, 409 on a reused message id", async () => {
    const { client } = await boot();
    const nf = await client.req("GET", "/api/session/ses_nope");
    expect(nf.status).toBe(404);
    expect(nf.json).toEqual({ _tag: "SessionNotFoundError", sessionID: "ses_nope", message: "Session not found: ses_nope" });
    expect((await client.prompt("ses_nope", "x")).status).toBe(404);
    const sid = await client.session();
    const bad = await client.req("POST", `/api/session/${sid}/prompt`, {});
    expect(bad.status).toBe(400);
    expect(bad.json._tag).toBe("InvalidRequestError");
    const first = await client.req("POST", `/api/session/${sid}/prompt`, { id: "msg_fixed", text: "a" });
    expect(first.status).toBe(200);
    const dup = await client.req("POST", `/api/session/${sid}/prompt`, { id: "msg_fixed", text: "b" });
    expect(dup.status).toBe(409);
    expect(dup.json._tag).toBe("ConflictError");
    expect((await client.req("POST", `/api/session/${sid}/permission/per_nope/reply`, { decision: "once" })).status).toBe(404);
    expect((await client.req("POST", `/api/session/${sid}/form/frm_nope/reply`, { answer: {} })).status).toBe(404);
    expect((await client.req("DELETE", `/api/session/${sid}/form/frm_nope`)).status).toBe(404);
  });

  test("list by parentID, PATCH, model and agent switches, and message paging", async () => {
    const { client, sub } = await boot();
    const sid = await client.session({ title: "root" });
    expect((await client.req("PATCH", `/api/session/${sid}`, { title: "renamed" })).status).toBe(204);
    expect((await client.req("GET", `/api/session/${sid}`)).json.data.title).toBe("renamed");
    const child = await client.session({ parentID: sid, title: "kid" });
    expect((await client.req("GET", `/api/session?parentID=${sid}`)).json.data.map((s: any) => s.id)).toEqual([child]);
    expect(sub.events.find((e) => e.type === "session.created" && e.data.sessionID === child)!.data.parentID).toBe(sid);

    expect((await client.req("POST", `/api/session/${sid}/model`, { model: { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "max" } })).status).toBe(204);
    expect((await client.req("POST", `/api/session/${sid}/model`, { model: { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "max" } })).status).toBe(204);
    expect((await client.req("POST", `/api/session/${sid}/agent`, { agent: "plan" })).status).toBe(204);
    expect(sub.events.filter((e) => e.type === "session.model.selected")).toHaveLength(1);
    expect(sub.events.find((e) => e.type === "session.agent.selected")!.data).toMatchObject({ agent: "plan", previous: "build" });
    expect((await client.req("GET", `/api/session/${sid}`)).json.data).toMatchObject({ agent: "plan", model: { variant: "max" } });
    expect((await messages(client, sid)).map((m) => m.type)).toEqual(["model-switched", "agent-switched"]);

    for (let n = 0; n < 3; n++) {
      await client.prompt(sid, `turn ${n}`);
      await terminal(sub, sid, n + 1);
    }
    const all = await messages(client, sid);
    const page1 = await client.req("GET", `/api/session/${sid}/message?order=asc&limit=4`);
    expect(page1.json.data.map((m: any) => m.id)).toEqual(all.slice(0, 4).map((m) => m.id));
    const page2 = await client.req("GET", `/api/session/${sid}/message?cursor=${page1.json.cursor.next}&limit=4`);
    expect(page2.json.data.map((m: any) => m.id)).toEqual(all.slice(4, 8).map((m) => m.id));
    expect((await client.req("GET", `/api/session/${sid}/message?cursor=${page1.json.cursor.next}&order=asc`)).status).toBe(400);
    const desc = await client.req("GET", `/api/session/${sid}/message`);
    expect(desc.json.data[0].id).toBe(all.at(-1)!.id);
  });
});

describe("scenario: steer", () => {
  test("a steer arriving mid-step is delivered at the step boundary and answered in the same execution (q4)", async () => {
    const { client, sub } = await boot({ speed: 0.1 });
    const sid = await client.session();
    await client.prompt(sid, "go __agetor_fake_oc_steer__");
    await sub.waitFor((e) => e.type === "shell.created");
    const steer = await client.prompt(sid, "also say BANANA", "steer");
    await terminal(sub, sid);
    const t = sub.types(sid);
    expect(t.filter((x) => x === "session.execution.started")).toHaveLength(1);
    const enq = nth(t, "session.inbox.enqueued", 2);
    const success = t.indexOf("session.tool.success");
    const stepEnded = t.indexOf("session.step.ended");
    const delivered = nth(t, "session.inbox.delivered", 2);
    const secondStep = nth(t, "session.step.started", 2);
    expect(enq).toBeGreaterThan(0);
    expect(enq).toBeLessThan(success);
    inOrder(t, ["session.tool.success", "session.step.ended", "session.usage.updated", "session.inbox.delivered"]);
    expect(delivered).toBeGreaterThan(stepEnded);
    expect(delivered).toBeLessThan(secondStep);
    const inboxEv = sub.events.filter((e) => e.type === "session.inbox.delivered");
    expect(inboxEv[1]!.data.inboxID).toBe(steer.json.data.id);
    const msgs = await messages(client, sid);
    expect(msgs.map((m) => m.type)).toEqual(["user", "assistant", "user", "assistant", "idle"]);
    expect(finalText(msgs)).toContain("BANANA");
    expect(msgs[2].id).toBe(steer.json.data.id);
  });

  test("a snapshot taken mid-step contains the running tool part (q3)", async () => {
    const { client, sub } = await boot({ speed: 0.1 });
    const sid = await client.session();
    await client.prompt(sid, "__agetor_fake_oc_steer__");
    await sub.waitFor((e) => e.type === "shell.created");
    const during = await messages(client, sid);
    const tool = during.flatMap((m) => m.content ?? []).find((c: any) => c.type === "tool");
    expect(tool).toMatchObject({ name: "shell", state: { status: "running", input: { command: "sleep 2" } } });
    await terminal(sub, sid);
    const after = (await messages(client, sid)).flatMap((m) => m.content ?? []).find((c: any) => c.type === "tool");
    expect(after.state.status).toBe("completed");
  });

  test("a queue prompt waits for the idle boundary of the same execution", async () => {
    const { client, sub } = await boot({ speed: 0.1 });
    const sid = await client.session();
    await client.prompt(sid, "__agetor_fake_oc_steer__ first");
    await sub.waitFor((e) => e.type === "shell.created");
    const queued = await client.prompt(sid, "second one", "queue");
    await terminal(sub, sid);
    const t = sub.types(sid);
    expect(t.filter((x) => x === "session.execution.started")).toHaveLength(1);
    const deliveredIds = sub.events.filter((e) => e.type === "session.inbox.delivered").map((e) => e.data.inboxID);
    expect(deliveredIds[1]).toBe(queued.json.data.id);
    // Delivered only after the final answer's step ended: two step.ended come first (tool step, answer step).
    const delivered = nth(t, "session.inbox.delivered", 2);
    expect(t.slice(0, delivered).filter((x) => x === "session.step.ended")).toHaveLength(2);
    expect(finalText(await messages(client, sid))).toContain("second one");
  });
});

describe("scenario: permissions", () => {
  async function askOnce(decision: string, message?: string) {
    const ctx = await boot();
    const sid = await ctx.client.session();
    await ctx.client.prompt(sid, "run __agetor_fake_oc_permission__");
    const asked = await ctx.sub.waitFor((e) => e.type === "permission.asked");
    expect(asked.data).toMatchObject({ sessionID: sid, action: "shell", resources: ["echo hi"], save: ["echo *"], source: { type: "tool" } });
    const pending = await ctx.client.req("GET", `/api/session/${sid}/permission`);
    expect(pending.json.data.map((p: any) => p.id)).toEqual([asked.data.id]);
    const reply = await ctx.client.req("POST", `/api/session/${sid}/permission/${asked.data.id}/reply`, { decision, ...(message ? { message } : {}) });
    expect(reply.status).toBe(204);
    expect((await ctx.client.req("GET", `/api/session/${sid}/permission`)).json.data).toEqual([]);
    return { ...ctx, sid, asked };
  }

  test("once: asked, replied, tool runs, turn succeeds (q5)", async () => {
    const { sub, sid, client } = await askOnce("once");
    await terminal(sub, sid);
    inOrder(sub.types(), ["permission.asked", "permission.replied", "shell.created", "session.tool.success", "session.execution.succeeded"]);
    expect(sub.events.find((e) => e.type === "permission.replied")!.data).toMatchObject({ requestID: expect.any(String), reply: "once" });
    expect(finalText(await messages(client, sid))).toContain("hi");
  });

  test("always adds an allow rule for the saved pattern", async () => {
    const { sub, sid, client } = await askOnce("always");
    await terminal(sub, sid);
    const s = (await client.req("GET", `/api/session/${sid}`)).json.data;
    expect(s.permissions).toContainEqual({ action: "shell", resource: "echo *", effect: "allow" });
  });

  test("reject with a message fails the tool as permission.rejected and the model continues (q5b)", async () => {
    const { sub, sid, client } = await askOnce("reject", "no thanks");
    await terminal(sub, sid);
    const failed = sub.events.find((e) => e.type === "session.tool.failed")!;
    expect(failed.data.error).toEqual({ type: "permission.rejected", message: "no thanks" });
    inOrder(sub.types(sid), ["session.tool.failed", "session.step.ended", "session.usage.updated", "session.step.started", "session.execution.succeeded"]);
    expect(finalText(await messages(client, sid))).toContain("no thanks");
  });

  test("reject without a message ends the turn: tool.failed aborted, step.failed, interrupted/shutdown (A6)", async () => {
    const { sub, sid, client } = await askOnce("reject");
    const end = await terminal(sub, sid);
    expect(end.type).toBe("session.execution.interrupted");
    expect(end.data.reason).toBe("shutdown");
    expect(sub.events.find((e) => e.type === "session.tool.failed")!.data.error).toEqual({ type: "aborted", message: "The user declined this tool call" });
    expect(sub.events.find((e) => e.type === "session.step.failed")!.data.error).toEqual({ type: "aborted", message: "Step interrupted" });
    inOrder(sub.types(sid), ["session.tool.failed", "session.step.failed", "session.usage.updated", "session.execution.interrupted"]);
    const s = (await client.req("GET", `/api/session/${sid}`)).json.data;
    expect(s.outcome).toBe("interrupted");
  });

  test("an all-ask session raises read, edit (for write) and shell together (A1)", async () => {
    const { client, sub } = await boot();
    const sid = await client.session({ permissions: [{ action: "*", resource: "*", effect: "ask" }] });
    await client.prompt(sid, "go __agetor_fake_oc_files__");
    const asks: any[] = [];
    while (asks.length < 3) {
      const e = await sub.waitFor((x) => x.type === "permission.asked" && !asks.includes(x.data), 5000);
      asks.push(e.data);
    }
    expect(asks.map((a) => a.action).sort()).toEqual(["edit", "read", "shell"]);
    const edit = asks.find((a) => a.action === "edit");
    expect(edit.resources).toEqual(["note.txt"]);
    expect(edit.metadata.files[0]).toMatchObject({ file: "note.txt", status: "added" });
    expect(((await client.req("GET", `/api/session/${sid}/permission`)).json.data as any[]).length).toBe(3);
    for (const a of asks) expect((await client.req("POST", `/api/session/${sid}/permission/${a.id}/reply`, { decision: "once" })).status).toBe(204);
    await terminal(sub, sid);
    expect(sub.events.filter((e) => e.type === "session.tool.success")).toHaveLength(3);
    expect(finalText(await messages(client, sid))).toBe("FINISHED");
  });

  test("a session without ask rules never asks for the files scenario", async () => {
    const { client, sub } = await boot();
    const sid = await client.session();
    await client.prompt(sid, "__agetor_fake_oc_files__");
    await terminal(sub, sid);
    expect(sub.events.some((e) => e.type === "permission.asked")).toBe(false);
  });
});

describe("scenario: question forms", () => {
  async function ask(act: (c: Client, sid: string, form: any) => Promise<void>) {
    const ctx = await boot();
    const sid = await ctx.client.session();
    await ctx.client.prompt(sid, "pick __agetor_fake_oc_question__");
    const created = await ctx.sub.waitFor((e) => e.type === "form.created");
    const form = created.data.form;
    expect(form).toMatchObject({
      sessionID: sid,
      title: "Questions",
      metadata: { kind: "question" },
      fields: [{ key: "q0", type: "string", custom: true, options: [{ value: "Red", label: "Red" }, { value: "Blue", label: "Blue" }] }],
    });
    expect((await ctx.client.req("GET", `/api/session/${sid}/form`)).json.data.map((f: any) => f.id)).toEqual([form.id]);
    await act(ctx.client, sid, form);
    const end = await terminal(ctx.sub, sid);
    return { ...ctx, sid, end, form };
  }

  test("an answer completes the tool and the model names it (q6b)", async () => {
    const { sub, client, sid, end, form } = await ask(async (c, s, f) => {
      expect((await c.req("POST", `/api/session/${s}/form/${f.id}/reply`, { answer: { q0: "Blue" } })).status).toBe(204);
    });
    expect(end.type).toBe("session.execution.succeeded");
    expect(sub.events.find((e) => e.type === "form.replied")!.data).toEqual({ id: form.id, sessionID: sid, answer: { q0: "Blue" } });
    const success = sub.events.find((e) => e.type === "session.tool.success")!;
    expect(success.data.content[0].text).toContain('"Which color do you pick?"="Blue"');
    expect(success.data.metadata.answers).toEqual([["Blue"]]);
    expect(finalText(await messages(client, sid))).toContain("Blue");
    const state = (await client.req("GET", `/api/session/${sid}/form/${form.id}`)).json.data.state;
    expect(state).toEqual({ status: "answered", answer: { q0: "Blue" } });
    expect((await client.req("POST", `/api/session/${sid}/form/${form.id}/reply`, { answer: { q0: "Red" } })).status).toBe(409);
    expect((await client.req("DELETE", `/api/session/${sid}/form/${form.id}`)).status).toBe(409);
  });

  test("an empty answer {} is accepted and the model continues with 'Unanswered' (A2)", async () => {
    const { sub, client, sid, end } = await ask(async (c, s, f) => {
      expect((await c.req("POST", `/api/session/${s}/form/${f.id}/reply`, { answer: {} })).status).toBe(204);
    });
    expect(end.type).toBe("session.execution.succeeded");
    const success = sub.events.find((e) => e.type === "session.tool.success")!;
    expect(success.data.content[0].text).toContain('="Unanswered"');
    expect(success.data.metadata.answers).toEqual([[]]);
    expect(finalText(await messages(client, sid))).toBe("You gave no answer.");
  });

  test("{q0:''} is accepted too and keeps the turn going (A2)", async () => {
    const { sub, client, sid, end } = await ask(async (c, s, f) => {
      expect((await c.req("POST", `/api/session/${s}/form/${f.id}/reply`, { answer: { q0: "" } })).status).toBe(204);
    });
    expect(end.type).toBe("session.execution.succeeded");
    expect(sub.events.find((e) => e.type === "session.tool.success")!.data.content[0].text).toContain('="". You can now');
    expect(finalText(await messages(client, sid))).toBe("You gave no answer.");
  });

  test("a non-object or non-string answer is a 400, and the form stays pending", async () => {
    const ctx = await boot();
    const sid = await ctx.client.session();
    await ctx.client.prompt(sid, "__agetor_fake_oc_question__");
    const created = await ctx.sub.waitFor((e) => e.type === "form.created");
    const fid = created.data.form.id;
    expect((await ctx.client.req("POST", `/api/session/${sid}/form/${fid}/reply`, { answer: "Blue" })).status).toBe(400);
    const badValue = await ctx.client.req("POST", `/api/session/${sid}/form/${fid}/reply`, { answer: { q0: 3 } });
    expect(badValue.status).toBe(400);
    expect(badValue.json._tag).toBe("FormInvalidAnswerError");
    expect((await ctx.client.req("GET", `/api/session/${sid}/form/${fid}`)).json.data.state).toEqual({ status: "pending" });
    await ctx.client.req("DELETE", `/api/session/${sid}/form/${fid}?message=bye`);
    await terminal(ctx.sub, sid);
  });

  test("DELETE with a message fails the tool with that message and the model continues (A6)", async () => {
    const { sub, client, sid, end, form } = await ask(async (c, s, f) => {
      expect((await c.req("DELETE", `/api/session/${s}/form/${f.id}?message=${encodeURIComponent("not now")}`)).status).toBe(204);
    });
    expect(end.type).toBe("session.execution.succeeded");
    expect(sub.events.find((e) => e.type === "form.cancelled")!.data).toEqual({ id: form.id, sessionID: sid });
    expect(sub.events.find((e) => e.type === "session.tool.failed")!.data.error).toEqual({ type: "tool.execution", message: "not now" });
    expect(sub.types(sid)).not.toContain("session.step.failed");
    expect(finalText(await messages(client, sid))).toContain("not now");
    expect((await client.req("GET", `/api/session/${sid}/form/${form.id}`)).json.data.state).toEqual({ status: "cancelled", message: "not now" });
  });

  test("DELETE without a message interrupts the turn (q6b-cancel)", async () => {
    const { sub, sid, end } = await ask(async (c, s, f) => {
      expect((await c.req("DELETE", `/api/session/${s}/form/${f.id}`)).status).toBe(204);
    });
    expect(end.type).toBe("session.execution.interrupted");
    expect(end.data.reason).toBe("shutdown");
    expect(sub.events.find((e) => e.type === "session.tool.failed")!.data.error).toEqual({ type: "aborted", message: "The user dismissed this question" });
    inOrder(sub.types(sid), ["form.cancelled", "session.tool.failed", "session.step.failed", "session.usage.updated", "session.execution.interrupted"]);
  });
});

describe("scenario: subagents", () => {
  test("a foreground child streams its own events and completes the parent tool with <subagent …> (q7)", async () => {
    const { client, sub } = await boot();
    const sid = await client.session();
    await client.prompt(sid, "do __agetor_fake_oc_subagent__");
    await terminal(sub, sid);
    const created = sub.events.find((e) => e.type === "session.created" && e.data.parentID === sid)!;
    const cid = created.data.sessionID as string;
    expect(created.data).toMatchObject({ agent: "general", title: "Run echo CHILD", version: "2.1.3" });
    const childTypes = sub.types(cid);
    expect(childTypes).toContain("session.tool.called");
    expect(childTypes).toContain("session.execution.succeeded");
    expect(sub.events.find((e) => e.type === "session.inbox.enqueued" && e.data.sessionID === cid)!.data.item.payload.text).toMatch(/^You are a subagent spawned by another session\./);
    const progress = sub.events.find((e) => e.type === "session.tool.progress" && e.data.metadata?.status === "running")!;
    expect(progress.data).toMatchObject({ sessionID: sid, metadata: { sessionID: cid, status: "running" } });
    const parentSuccess = sub.events.find((e) => e.type === "session.tool.success" && e.data.sessionID === sid)!;
    expect(parentSuccess.data.content[0].text).toMatch(new RegExp(`^<subagent sessionID="${cid}" state="completed">\\n[\\s\\S]*CHILD[\\s\\S]*</subagent>$`));
    expect(parentSuccess.data.metadata).toEqual({ sessionID: cid, status: "completed", truncated: false });
    // the child finished before the parent tool completed, and both are in the log in order
    const all = sub.events.map((e) => `${e.data?.sessionID === cid ? "child" : "parent"}:${e.type}`);
    expect(all.indexOf("child:session.execution.succeeded")).toBeLessThan(all.indexOf("parent:session.tool.success"));
    expect((await client.req("GET", `/api/session?parentID=${sid}`)).json.data.map((s: any) => s.id)).toEqual([cid]);
    const childMsgs = await messages(client, cid);
    expect(childMsgs.map((m) => m.type)).toEqual(["user", "assistant", "assistant", "idle"]);
    expect(finalText(await messages(client, sid))).toContain("CHILD");
  });

  test("an all-ask parent makes the child's shell tool ask in the child session", async () => {
    const { client, sub } = await boot();
    const sid = await client.session({ permissions: [{ action: "*", resource: "*", effect: "ask" }] });
    await client.prompt(sid, "__agetor_fake_oc_subagent__");
    const asked = await sub.waitFor((e) => e.type === "permission.asked");
    expect(asked.data.sessionID).not.toBe(sid);
    expect(asked.data.action).toBe("shell");
    await client.req("POST", `/api/session/${asked.data.sessionID}/permission/${asked.data.id}/reply`, { decision: "once" });
    await terminal(sub, sid);
  });

  test("a background child finishes after the parent turn and wakes the parent with a synthetic item (A5)", async () => {
    const { client, sub } = await boot();
    const sid = await client.session();
    await client.prompt(sid, "go __agetor_fake_oc_wake__");
    const first = await terminal(sub, sid, 1);
    expect(first.type).toBe("session.execution.succeeded");
    const second = await terminal(sub, sid, 2);
    expect(second.type).toBe("session.execution.succeeded");

    const cid = sub.events.find((e) => e.type === "session.created" && e.data.parentID === sid)!.data.sessionID as string;
    const seq = sub.events.map((e) => `${e.data?.sessionID === cid ? "child" : e.data?.sessionID === sid ? "parent" : "other"}:${e.type}`);
    const parentFirstDone = seq.indexOf("parent:session.execution.succeeded");
    const childDone = seq.indexOf("child:session.execution.succeeded");
    expect(childDone).toBeGreaterThan(parentFirstDone);
    const synthetic = sub.events.find((e) => e.type === "session.inbox.enqueued" && e.data.sessionID === sid && e.data.item.type === "synthetic")!;
    expect(sub.events.indexOf(synthetic)).toBeGreaterThan(sub.events.findIndex((e) => e.type === "session.execution.succeeded" && e.data.sessionID === cid));
    expect(synthetic.data.item.payload.metadata).toEqual({ source: "subagent", childID: cid, agent: "General", state: "completed" });
    expect(synthetic.data.item.payload.text).toContain(`<subagent sessionID="${cid}" state="completed"`);
    expect(synthetic.data.item.delivery).toBe("steer");
    // new execution on the parent: enqueued -> started -> delivered
    const parentTypes = sub.types(sid);
    const enq = parentTypes.lastIndexOf("session.inbox.enqueued");
    expect(parentTypes[enq + 1]).toBe("session.execution.started");
    expect(parentTypes.filter((t) => t === "session.execution.started")).toHaveLength(2);
    inOrder(parentTypes.slice(enq), ["session.inbox.enqueued", "session.execution.started", "session.inbox.delivered", "session.step.started", "session.execution.succeeded"]);
    expect(sub.events.filter((e) => e.type === "session.inbox.delivered" && e.data.sessionID === sid)[1]!.data.inboxID).toBe(synthetic.data.inboxID);
    const msgs = await messages(client, sid);
    expect(msgs.map((m) => m.type)).toEqual(["user", "assistant", "assistant", "idle", "synthetic", "assistant", "idle"]);
    expect(msgs[4].metadata).toEqual({ source: "subagent", childID: cid, agent: "General", state: "completed" });
    expect(finalText(msgs)).toContain("background subagent finished");
    // the child has not been orphaned: its own snapshot is complete
    expect((await messages(client, cid)).map((m) => m.type)).toEqual(["user", "assistant", "assistant", "idle"]);
  });
});

describe("scenario: failures, interrupts, todo, retry", () => {
  test("the error marker emits step.failed then execution.failed with the 402 provider.quota envelope (A4)", async () => {
    const { client, sub } = await boot();
    const sid = await client.session();
    await client.prompt(sid, "x __agetor_fake_oc_error__");
    const end = await terminal(sub, sid);
    expect(end.type).toBe("session.execution.failed");
    expect(end.data.error).toMatchObject({ type: "provider.quota", status: 402, message: "Upstream request failed: Insufficient account funds" });
    expect(JSON.parse(end.data.error.response.body).error.type).toBe("server_error");
    expect(sub.types(sid).filter((t) => t !== "session.created" && t !== "session.instructions.updated")).toEqual([
      "session.inbox.enqueued",
      "session.execution.started",
      "session.inbox.delivered",
      "session.step.started",
      "session.step.failed",
      "session.execution.failed",
    ]);
    expect(sub.events.find((e) => e.type === "session.step.failed")!.data.error).toEqual(end.data.error);
    const s = (await client.req("GET", `/api/session/${sid}`)).json.data;
    expect(s.outcome).toBe("failed");
    const msgs = await messages(client, sid);
    expect(msgs[1]).toMatchObject({ type: "assistant", finish: "error", content: [], error: { type: "provider.quota", status: 402 } });
    expect(msgs[2]).toMatchObject({ type: "idle", outcome: "failed", error: { type: "provider.quota" } });
    expect((await client.req("GET", "/api/session/active")).json.data).toEqual({});
  });

  test("a configured quota model fails every turn the same way, with no marker", async () => {
    const { client, sub } = await boot();
    const sid = await client.session({ model: { providerID: "opencode", id: "deepseek-v4.1-flash" } });
    await client.prompt(sid, "plain");
    expect((await terminal(sub, sid)).type).toBe("session.execution.failed");
  });

  test("the slow marker runs until interrupted: tool.failed aborted, step.failed, execution.interrupted/user (q9)", async () => {
    const { client, sub } = await boot({ speed: 0 });
    const sid = await client.session();
    await client.prompt(sid, "__agetor_fake_oc_slow__");
    await sub.waitFor((e) => e.type === "shell.created");
    await new Promise((r) => setTimeout(r, 60));
    expect(sub.types(sid)).not.toContain("session.execution.succeeded");
    expect((await client.req("GET", "/api/session/active")).json.data[sid]).toEqual({ type: "running" });
    const intr = await client.req("POST", `/api/session/${sid}/interrupt`);
    expect(intr.json).toEqual({ interrupted: true });
    const end = await terminal(sub, sid);
    expect(end.type).toBe("session.execution.interrupted");
    expect(end.data.reason).toBe("user");
    expect(sub.events.find((e) => e.type === "session.tool.failed")!.data).toMatchObject({ error: { type: "aborted", message: "Tool execution interrupted" }, metadata: { shellID: expect.any(String) } });
    expect(sub.events.find((e) => e.type === "session.step.failed")!.data.error).toEqual({ type: "aborted", message: "Step interrupted" });
    inOrder(sub.types(sid), ["session.tool.failed", "session.step.failed", "session.usage.updated", "session.execution.interrupted"]);
    expect((await client.req("POST", `/api/session/${sid}/interrupt`)).json).toEqual({ interrupted: false });
    expect((await client.req("GET", `/api/session/${sid}`)).json.data.outcome).toBe("interrupted");
    const msgs = await messages(client, sid);
    expect(msgs.at(-1)).toMatchObject({ type: "idle", outcome: "interrupted" });
    // reusable afterwards
    await client.prompt(sid, "after");
    expect((await terminal(sub, sid, 2)).type).toBe("session.execution.succeeded");
  });

  test("interrupting a turn that waits on a form cancels the form", async () => {
    const { client, sub } = await boot();
    const sid = await client.session();
    await client.prompt(sid, "__agetor_fake_oc_question__");
    await sub.waitFor((e) => e.type === "form.created");
    await client.req("POST", `/api/session/${sid}/interrupt`);
    expect((await terminal(sub, sid)).type).toBe("session.execution.interrupted");
    expect(sub.types()).toContain("form.cancelled");
    expect((await client.req("GET", `/api/session/${sid}/form`)).json.data).toEqual([]);
  });

  test("the todo marker calls todowrite with three todos (v2-run-tools-todowrite)", async () => {
    const { client, sub } = await boot();
    const sid = await client.session();
    await client.prompt(sid, "__agetor_fake_oc_todo__");
    await terminal(sub, sid);
    const called = sub.events.find((e) => e.type === "session.tool.called")!;
    expect(called.data.input.todos).toHaveLength(3);
    expect(called.data.input.todos[0]).toMatchObject({ content: "alpha", status: "completed", priority: "high" });
    const input = sub.events.find((e) => e.type === "session.tool.input.started")!;
    expect(input.data.name).toBe("todowrite");
    inOrder(sub.types(sid), ["session.reasoning.started", "session.tool.input.started", "session.tool.input.ended", "session.tool.called", "session.step.streamed", "session.tool.success", "session.step.ended"]);
    expect(sub.events.find((e) => e.type === "session.tool.success")!.data.metadata.todos).toHaveLength(3);
  });

  test("the retry marker emits session.retry.scheduled twice before the text", async () => {
    const { client, sub } = await boot();
    const sid = await client.session();
    await client.prompt(sid, "__agetor_fake_oc_retry__");
    await terminal(sub, sid);
    const retries = sub.events.filter((e) => e.type === "session.retry.scheduled");
    expect(retries.map((e) => e.data.attempt)).toEqual([1, 2]);
    expect(retries[0]!.data.error).toMatchObject({ type: "provider.rate-limit", status: 429, retryAfterMs: 5000 });
  });
});

describe("event order matches the live transcripts", () => {
  // T4 acceptance: "each scenario's event order matches the live spike
  // transcripts". The reference is either a recorded v2-http-*.jsonl fixture or
  // an ordering list copied (sanitized) from the T4 verification runs, whose
  // raw files live in the spike scratchpad and not in the repo.
  //
  // Both sides go through `normalize`. What it drops, and why, is the complete
  // allow-list of orderings known to vary between runs:
  //   1. *.delta, server.connected, session.instructions.updated and the
  //      session.created of a top-level session: high-volume or per-connection
  //      noise that the recorded fixtures were already stripped of.
  //   2. session.reasoning.*: reasoning is optional per model turn, and its
  //      position against text and tool-input events is token-stream timing
  //      (reasoning.started, tool.input.started, reasoning.ended was seen live).
  //   3. session.text.* inside a step that calls a tool: preamble text is
  //      model-optional and interleaves with tool.input.* (a2-empty: text.started,
  //      tool.input.*, tool.called, text.ended). Text in a final step is kept.
  //   4. shell.exited and session.tool.success are a race: both orders were seen
  //      live (v2-http-tool-turn: exited first; v2-http-steer: success first).
  //      They are compared as success, then exited.
  //   5. shell.* altogether where the reference has none (v2-http-subagent and the
  //      T4 transcripts record sessions only; shell events are not session-tagged).
  // Everything else, including cross-session order in the subagent fixture, is exact.

  type Opt = { shell: boolean; session?: string };
  const sessionOf = (e: Ev): string | undefined => e.data?.sessionID ?? e.data?.form?.sessionID ?? e.data?.info?.metadata?.sessionID;

  function normalize(events: Ev[], opt: Opt): string[] {
    const items: Array<{ type: string; session: string | undefined; keep: boolean }> = [];
    const stepText = new Map<string, number[]>();
    const stepTool = new Set<string>();
    for (const e of events) {
      const session = sessionOf(e);
      if (opt.session && session !== opt.session) continue;
      const t = e.type;
      let keep = true;
      if (t.endsWith(".delta") || t === "server.connected" || t === "session.instructions.updated") keep = false;
      else if (t === "session.created" && !e.data?.parentID) keep = false;
      else if (t.startsWith("session.reasoning.")) keep = false;
      else if (t.startsWith("shell.") && !opt.shell) keep = false;
      items.push({ type: t, session, keep });
      const key = session ?? "";
      if (t === "session.text.started" || t === "session.text.ended") {
        const list = stepText.get(key) ?? [];
        list.push(items.length - 1);
        stepText.set(key, list);
      } else if (t === "session.tool.called") {
        stepTool.add(key);
      } else if (t === "session.step.ended" || t === "session.step.failed") {
        if (stepTool.has(key)) for (const i of stepText.get(key) ?? []) items[i]!.keep = false;
        stepTool.delete(key);
        stepText.delete(key);
      }
    }
    const out = items.filter((i) => i.keep).map((i) => i.type);
    for (let i = 0; i + 1 < out.length; i++) {
      if (out[i] === "shell.exited" && out[i + 1] === "session.tool.success") [out[i], out[i + 1]] = [out[i + 1]!, out[i]!];
    }
    return out;
  }
  const fixture = (name: string): Ev[] =>
    readFileSync(path.join(import.meta.dir, name), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Ev);
  const words = (s: string): string[] => s.split(/\s+/).filter(Boolean);
  const expectSeq = (got: string[], want: string[]): void => {
    expect(want.length).toBeGreaterThan(5); // a reference that normalized to nothing would pass vacuously
    expect(got.join("\n")).toBe(want.join("\n"));
  };

  test("the normalizer is not vacuous: it keeps order-sensitive events and applies the swap", () => {
    const evs = (types: string[]): Ev[] => types.map((type) => ({ id: "e", type, data: { sessionID: "s" } }));
    expect(normalize(evs(["session.step.started", "shell.exited", "session.tool.success", "session.step.ended"]), { shell: true })).toEqual(["session.step.started", "session.tool.success", "shell.exited", "session.step.ended"]);
    expect(normalize(evs(["session.step.started", "session.text.started", "session.tool.called", "session.text.ended", "session.step.ended", "session.step.started", "session.text.started", "session.step.ended"]), { shell: false })).toEqual(["session.step.started", "session.tool.called", "session.step.ended", "session.step.started", "session.text.started", "session.step.ended"]);
    expect(normalize(evs(["session.tool.success", "session.step.ended"]), { shell: true })).not.toEqual(normalize(evs(["session.step.ended", "session.tool.success"]), { shell: true }));
  });

  test("tool turn matches v2-http-tool-turn.jsonl", async () => {
    const { client, sub } = await boot();
    const sid = await client.session();
    await client.prompt(sid, "go __agetor_fake_oc_tool__");
    await terminal(sub, sid);
    expectSeq(normalize(sub.events, { shell: true }), normalize(fixture("v2-http-tool-turn.jsonl"), { shell: true }));
  });

  test("steer matches v2-http-steer.jsonl", async () => {
    const { client, sub } = await boot({ speed: 0.1 });
    const sid = await client.session();
    await client.prompt(sid, "__agetor_fake_oc_steer__");
    await sub.waitFor((e) => e.type === "shell.created");
    await client.prompt(sid, "also say BANANA", "steer");
    await terminal(sub, sid);
    expectSeq(normalize(sub.events, { shell: true }), normalize(fixture("v2-http-steer.jsonl"), { shell: true }));
  });

  test("interrupt (slow marker) matches v2-http-interrupt.jsonl, including the second execution", async () => {
    const { client, sub } = await boot({ speed: 0 });
    const sid = await client.session();
    await client.prompt(sid, "__agetor_fake_oc_slow__");
    await sub.waitFor((e) => e.type === "shell.created");
    await client.req("POST", `/api/session/${sid}/interrupt`);
    await terminal(sub, sid);
    await client.prompt(sid, "next");
    await terminal(sub, sid, 2);
    const got = normalize(sub.events, { shell: true });
    expect(got).toContain("shell.deleted");
    expectSeq(got, normalize(fixture("v2-http-interrupt.jsonl"), { shell: true }));
    expect(sub.events.find((e) => e.type === "shell.exited")!.data.status).toBe("killed");
  });

  test("subagent matches v2-http-subagent.jsonl (parent and child interleaved)", async () => {
    const { client, sub } = await boot();
    const sid = await client.session();
    await client.prompt(sid, "__agetor_fake_oc_subagent__");
    await terminal(sub, sid);
    expectSeq(normalize(sub.events, { shell: false }), normalize(fixture("v2-http-subagent.jsonl"), { shell: false }));
  });

  test("the 402 quota failure matches v2-http-quota-402.jsonl and the A4 transcript", async () => {
    const { client, sub } = await boot();
    const sid = await client.session();
    await client.prompt(sid, "__agetor_fake_oc_error__");
    await terminal(sub, sid);
    const got = normalize(sub.events, { shell: false });
    expectSeq(got, normalize(fixture("v2-http-quota-402.jsonl"), { shell: false }));
    // T4 A4 (live, opencode/deepseek-v4.1-flash): the same six events, no usage.updated, no retry.
    expectSeq(got, words("session.inbox.enqueued session.execution.started session.inbox.delivered session.step.started session.step.failed session.execution.failed"));
  });

  // Ordering lists copied from the T4 live runs (a6-perm, a6-form, a2-empty, a5).
  const A6_PERM_REJECT = words(
    "session.inbox.enqueued session.execution.started session.inbox.delivered session.step.started session.tool.input.started session.tool.input.ended session.tool.called session.step.streamed permission.asked permission.replied session.tool.failed session.step.failed session.usage.updated session.execution.interrupted",
  );
  const A6_FORM_CANCEL_MESSAGE = words(
    "session.inbox.enqueued session.execution.started session.inbox.delivered session.step.started session.tool.input.started session.tool.input.ended session.tool.called session.step.streamed form.created form.cancelled session.tool.failed session.step.ended session.usage.updated session.step.started session.text.started session.text.ended session.step.streamed session.step.ended session.usage.updated session.execution.succeeded",
  );
  const A2_FORM_EMPTY_ANSWER = words(
    "session.inbox.enqueued session.execution.started session.inbox.delivered session.step.started session.tool.input.started session.tool.input.ended session.tool.called session.step.streamed form.created form.replied session.tool.success session.step.ended session.usage.updated session.step.started session.text.started session.text.ended session.step.streamed session.step.ended session.usage.updated session.execution.succeeded",
  );
  const A5_PARENT = words(
    "session.inbox.enqueued session.execution.started session.inbox.delivered session.step.started session.tool.input.started session.tool.input.ended session.tool.called session.step.streamed session.tool.progress session.tool.success session.step.ended session.usage.updated session.step.started session.text.started session.text.ended session.step.streamed session.step.ended session.usage.updated session.execution.succeeded " +
      "session.inbox.enqueued session.execution.started session.inbox.delivered session.step.started session.text.started session.text.ended session.step.streamed session.step.ended session.usage.updated session.execution.succeeded",
  );
  const A5_CHILD = words(
    "session.created session.inbox.enqueued session.execution.started session.inbox.delivered session.step.started session.tool.input.started session.tool.input.ended session.tool.called session.step.streamed session.tool.progress session.tool.success session.step.ended session.usage.updated session.step.started session.text.started session.text.ended session.step.streamed session.step.ended session.usage.updated session.execution.succeeded",
  );

  test("permission reject without a message matches the A6 transcript", async () => {
    const { client, sub } = await boot();
    const sid = await client.session();
    await client.prompt(sid, "__agetor_fake_oc_permission__");
    const asked = await sub.waitFor((e) => e.type === "permission.asked");
    await client.req("POST", `/api/session/${sid}/permission/${asked.data.id}/reply`, { decision: "reject" });
    await terminal(sub, sid);
    expectSeq(normalize(sub.events, { shell: false }), A6_PERM_REJECT);
  });

  test("question cancelled with a message matches the A6 transcript", async () => {
    const { client, sub } = await boot();
    const sid = await client.session();
    await client.prompt(sid, "__agetor_fake_oc_question__");
    const created = await sub.waitFor((e) => e.type === "form.created");
    await client.req("DELETE", `/api/session/${sid}/form/${created.data.form.id}?message=${encodeURIComponent("not now")}`);
    await terminal(sub, sid);
    expectSeq(normalize(sub.events, { shell: false }), A6_FORM_CANCEL_MESSAGE);
  });

  test("question answered with {} matches the A2 transcript", async () => {
    const { client, sub } = await boot();
    const sid = await client.session();
    await client.prompt(sid, "__agetor_fake_oc_question__");
    const created = await sub.waitFor((e) => e.type === "form.created");
    await client.req("POST", `/api/session/${sid}/form/${created.data.form.id}/reply`, { answer: {} });
    await terminal(sub, sid);
    expectSeq(normalize(sub.events, { shell: false }), A2_FORM_EMPTY_ANSWER);
  });

  test("the background-subagent wake matches the A5 transcript, per session", async () => {
    const { client, sub } = await boot();
    const sid = await client.session();
    await client.prompt(sid, "__agetor_fake_oc_wake__");
    await terminal(sub, sid, 2);
    const cid = sub.events.find((e) => e.type === "session.created" && e.data.parentID === sid)!.data.sessionID as string;
    // Cross-session interleaving is timing, so each session is compared on its own.
    expectSeq(normalize(sub.events, { shell: false, session: sid }), A5_PARENT);
    expectSeq(normalize(sub.events, { shell: false, session: cid }), A5_CHILD);
  });
});

describe("snapshots of a streaming message", () => {
  // Verified against live OpenCode 2.1.3 (T4 fix round, a polled turn of 150 lines) and
  // against core/src/session/message-updater.ts: there is no delta handler, so a text or
  // reasoning part is pushed as `text: ""` on *.started and only filled by *.ended.
  test("a part streamed so far has text '' until its .ended event; the assistant has no tokens or finish yet", async () => {
    const { client, sub } = await boot({ speed: 20 });
    const sid = await client.session();
    await client.prompt(sid, "a prompt long enough for the answer to stream for a while okay");
    await sub.waitFor((e) => e.type === "session.text.started");
    const mid = (await messages(client, sid)).filter((m) => m.type === "assistant").at(-1)!;
    expect(mid.content).toEqual([{ type: "text", text: "" }]);
    expect(mid.finish).toBeUndefined();
    expect(mid.tokens).toBeUndefined();
    expect(mid.cost).toBeUndefined();
    expect(mid.time.completed).toBeUndefined();
    expect(mid.time.streamed).toBeUndefined();
    await terminal(sub, sid);
    const done = (await messages(client, sid)).filter((m) => m.type === "assistant").at(-1)!;
    expect(done.content[0].text).toMatch(/^ACK: a prompt long enough/);
    expect(done.finish).toBe("stop");
    expect(done.time.streamed).toBeGreaterThan(0);
  });

  test("a reasoning part is the same: text '' with time.created only, until reasoning.ended", async () => {
    const { client, sub } = await boot({ speed: 20 });
    const sid = await client.session();
    await client.prompt(sid, "__agetor_fake_oc_todo__");
    await sub.waitFor((e) => e.type === "session.reasoning.started");
    const mid = (await messages(client, sid)).filter((m) => m.type === "assistant").at(-1)!;
    expect(mid.content[0]).toMatchObject({ type: "reasoning", text: "", native: { reasoningField: "reasoning_content" } });
    expect(mid.content[0].time.completed).toBeUndefined();
    await terminal(sub, sid);
    const done = (await messages(client, sid)).find((m) => m.type === "assistant")!;
    expect(done.content[0].text).toBe("Write the todo list, then reply OK.");
    expect(done.content[0].time.completed).toBeGreaterThan(0);
  });
});

describe("state file", () => {
  test("sessions and messages survive a server restart and the session can be prompted again", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-oc-state-"));
    try {
      const stateFile = path.join(dir, "state.json");
      const a = await boot({ stateFile });
      const sid = await a.client.session({ title: "persisted" });
      await a.client.prompt(sid, "remember me");
      await terminal(a.sub, sid);
      const before = await messages(a.client, sid);
      a.sub.close();
      await a.srv.stop();

      const b = await boot({ stateFile });
      expect((await b.client.req("GET", `/api/session/${sid}`)).json.data.title).toBe("persisted");
      expect(await messages(b.client, sid)).toEqual(before);
      await b.client.prompt(sid, "welcome back");
      await terminal(b.sub, sid);
      const after = await messages(b.client, sid);
      expect(after.map((m) => m.type)).toEqual(["user", "assistant", "idle", "user", "assistant", "idle"]);
      expect(finalText(after)).toBe("ACK: welcome back");
      expect((await b.client.req("GET", "/api/session/ses_unknown")).status).toBe(404);
      b.sub.close();
      await b.srv.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stub-opencode.sh", () => {
  const stub = path.join(import.meta.dir, "stub-opencode.sh");
  const env = { ...process.env, FAKE_OC_BUN: process.execPath, OPENCODE_PASSWORD: "stub-pw", FAKE_OC_SPEED: "0.02" };
  const run = (...args: string[]) => {
    const r = Bun.spawnSync([stub, ...args], { cwd: tmpdir(), env, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };

  test("answers the probes the status and discovery code make", () => {
    expect(run("--version")).toMatchObject({ code: 0, out: "opencode v2.1.3\n" });
    const models = run("models", "--standalone");
    expect(models.code).toBe(0);
    expect(models.out.trim().split("\n")).toEqual(["opencode-go/deepseek-v4.1-flash", "opencode/deepseek-v4.1-flash-free"]);
    const api = run("api", "--standalone", "model.list");
    expect(api.code).toBe(0);
    const catalog = JSON.parse(api.out);
    expect(catalog.data.map((m: any) => `${m.providerID}/${m.id}`)).toContain("opencode-go/deepseek-v4.1-flash");
    const auth = run("auth", "list", "--standalone", "--format", "json");
    expect(auth.code).toBe(0);
    expect(JSON.parse(auth.out).length).toBeGreaterThan(0);
    const bad = run("session", "list");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("unsupported");
    expect(run("api", "--standalone", "nope").code).toBe(1);
  });

  test("`serve` execs the fake server: prints the URL, honours OPENCODE_PASSWORD, never prints it", async () => {
    const proc = Bun.spawn([stub, "serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: tmpdir(), env, stdout: "pipe", stderr: "pipe" });
    try {
      const dec = new TextDecoder();
      let out = "";
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const deadline = Date.now() + 8000;
      while (!/server listening on http:\/\/127\.0\.0\.1:\d+/.test(out) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        out += dec.decode(value);
      }
      const url = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out)?.[1];
      expect(url).toBeDefined();
      expect(out).not.toContain("stub-pw");
      expect(out).not.toContain("server password");
      expect((await fetch(`${url}/api/info`)).status).toBe(401);
      const ok = await fetch(`${url}/api/info`, { headers: { authorization: `Basic ${Buffer.from("opencode:stub-pw").toString("base64")}` } });
      expect(ok.status).toBe(200);
      reader.releaseLock();
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test("without OPENCODE_PASSWORD the server prints a random one, like the real serve", async () => {
    const { OPENCODE_PASSWORD: _unused, ...noPw } = env;
    void _unused;
    const proc = Bun.spawn([stub, "serve", "--port", "0"], { cwd: tmpdir(), env: noPw, stdout: "pipe", stderr: "pipe" });
    try {
      const dec = new TextDecoder();
      let out = "";
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const deadline = Date.now() + 8000;
      while (!/server password \S+/.test(out) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        out += dec.decode(value);
      }
      expect(out).toMatch(/server listening on http:\/\/127\.0\.0\.1:\d+\nserver password [0-9a-f]{32}\n/);
      reader.releaseLock();
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});

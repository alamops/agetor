import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { startFakeOpencodeServer, type FakeOpencodeOptions, type FakeOpencodeServer } from "./fixtures/opencode/fake-serve.ts";
import {
  __forTest,
  closeOpencodeHub,
  opencodeOwnedSessions,
  setOpencodeWakeHandler,
  setOpencodeWatchLostHandler,
  subscribeOpencodeSession,
  watchOpencodeSessionsForWake,
  type OpencodeHubOrigin,
  type OpencodeHubSubscriber,
  type OpencodeWakeInput,
} from "./opencode-hub.ts";
import { createOpencodeClient, openOpencodeEventStream, type OpencodeEnvelope } from "./opencode-http.ts";

// Tests run against the in-process fake OpenCode server. The machine can be
// heavily loaded, so every wait is generous and nothing asserts a tight timing.

const KEY = "hub-test-harness";
const servers: FakeOpencodeServer[] = [];
let warnSpy: ReturnType<typeof spyOn>;

async function boot(opts: FakeOpencodeOptions = {}): Promise<FakeOpencodeServer> {
  const srv = await startFakeOpencodeServer({ password: "pw-hub-test", speed: 0.05, heartbeatMs: 1000, ...opts });
  servers.push(srv);
  return srv;
}

beforeEach(() => {
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  setOpencodeWakeHandler(null);
  __forTest.resetStreamStats();
});

afterEach(async () => {
  closeOpencodeHub();
  setOpencodeWakeHandler(null);
  setOpencodeWatchLostHandler(null);
  __forTest.clearHooks();
  __forTest.resetBackoff();
  __forTest.resetPendingCaps();
  warnSpy.mockRestore();
  for (const s of servers.splice(0)) await s.stop();
});

function authOf(srv: FakeOpencodeServer): string {
  return `Basic ${Buffer.from(`opencode:${srv.password}`).toString("base64")}`;
}

async function api(srv: FakeOpencodeServer, method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(srv.url + path, {
    method,
    headers: { authorization: authOf(srv), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return text ? JSON.parse(text) : undefined;
}

async function newSession(srv: FakeOpencodeServer, parentID?: string, permissions?: unknown[]): Promise<string> {
  const j = await api(srv, "POST", "/api/session", {
    title: "t",
    location: { directory: "/tmp/hub-project" },
    model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
    agent: "build",
    ...(parentID ? { parentID } : {}),
    ...(permissions ? { permissions } : {}),
  });
  return j.data.id as string;
}

async function prompt(srv: FakeOpencodeServer, sid: string, text: string): Promise<void> {
  await api(srv, "POST", `/api/session/${sid}/prompt`, { text });
}

async function until(pred: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(10);
  }
}

/**
 * An event stream of the test's own on a fake server (not through the hub).
 * The fake publishes each event to every open stream at once, so once the
 * observer has seen an event, anything the test triggers afterwards reaches the
 * hub's stream on that server after it: a positive barrier for "X never
 * reached the hub".
 */
async function observe(srv: FakeOpencodeServer): Promise<{ saw(type: string, sid: string): boolean; close(): void }> {
  const seen: Array<{ type: string; sid?: string }> = [];
  let up = false;
  const stream = openOpencodeEventStream(
    { url: srv.url, password: srv.password },
    {
      onEvent: (e) => {
        if (e.type === "server.connected") up = true;
        else seen.push({ type: e.type, sid: typeof e.data?.sessionID === "string" ? e.data.sessionID : undefined });
      },
      onClose: () => {},
    },
  );
  await until(() => up, "observer stream connected");
  return { saw: (type, sid) => seen.some((x) => x.type === type && x.sid === sid), close: () => stream.close() };
}

class Rec implements OpencodeHubSubscriber {
  events: Array<{ e: OpencodeEnvelope; origin: OpencodeHubOrigin }> = [];
  resyncs = 0;
  owned: OpencodeHubOrigin[][] = [];
  lost: unknown[] = [];
  onEventHook?: (e: OpencodeEnvelope, o: OpencodeHubOrigin) => void;
  onEvent(e: OpencodeEnvelope, origin: OpencodeHubOrigin): void {
    this.events.push({ e, origin });
    this.onEventHook?.(e, origin);
  }
  onResync(owned: ReadonlyArray<OpencodeHubOrigin>): void {
    this.resyncs++;
    this.owned.push([...owned]);
  }
  onServerLost(err?: unknown): void {
    this.lost.push(err ?? "lost");
  }
  types(sessionId?: string): string[] {
    return this.events.filter((x) => !sessionId || x.origin.sessionId === sessionId).map((x) => x.e.type);
  }
  count(type: string, sessionId?: string): number {
    return this.types(sessionId).filter((t) => t === type).length;
  }
}

describe("routing", () => {
  test("two root sessions on one server each receive only their own events, over one stream", async () => {
    const srv = await boot();
    const a = await newSession(srv);
    const b = await newSession(srv);
    const ra = new Rec();
    const rb = new Rec();
    const subA = subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, a, ra);
    const subB = subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, b, rb);
    await Promise.all([subA.ready, subB.ready]);

    await prompt(srv, a, "hello a");
    await prompt(srv, b, "hello b");
    await until(() => ra.count("session.execution.succeeded") === 1 && rb.count("session.execution.succeeded") === 1, "both turns done");

    expect(ra.events.length).toBeGreaterThan(3);
    for (const x of ra.events) {
      expect(x.origin).toEqual({ sessionId: a, isChild: false, depth: 0 });
      expect(x.e.data.sessionID).toBe(a);
    }
    for (const x of rb.events) {
      expect(x.origin.sessionId).toBe(b);
      expect(x.e.data.sessionID).toBe(b);
    }
    expect(__forTest.streamStats()).toEqual({ opened: 1, maxConcurrent: 1, open: 1 });
    expect(__forTest.probe(KEY)?.subscribers).toBe(2);
  });

  test("a subagent's events reach the parent subscriber tagged isChild/childOf, and session.created registers it", async () => {
    const srv = await boot();
    const root = await newSession(srv);
    const rec = new Rec();
    const sub = subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, root, rec);
    await sub.ready;

    await prompt(srv, root, "go __agetor_fake_oc_subagent__");
    await until(() => rec.count("session.execution.succeeded", root) === 1, "root turn done");

    const created = rec.events.find((x) => x.e.type === "session.created" && x.e.data.parentID === root);
    expect(created).toBeTruthy();
    const child = created!.e.data.sessionID as string;
    expect(created!.origin).toEqual({ sessionId: child, isChild: true, childOf: root, depth: 1 });
    expect(rec.events.some((x) => x.origin.sessionId === child && x.e.type === "session.text.ended")).toBe(true);
    for (const x of rec.events) {
      if (x.origin.sessionId === child) {
        expect(x.origin.isChild).toBe(true);
        expect(x.origin.childOf).toBe(root);
      } else {
        expect(x.origin.isChild).toBe(false);
        expect(x.origin.sessionId).toBe(root);
      }
    }
    expect(__forTest.probe(KEY)?.owned.sort()).toEqual([root, child].sort());
  });

  test("a child's permission request is routed to the parent subscriber by session ownership", async () => {
    const srv = await boot();
    const root = await newSession(srv, undefined);
    const rec = new Rec();
    const sub = subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, root, rec);
    await sub.ready;
    await api(srv, "PATCH", `/api/session/${root}`, { permissions: [{ action: "*", resource: "*", effect: "ask" }] });
    await prompt(srv, root, "__agetor_fake_oc_subagent__");
    await until(() => rec.events.some((x) => x.e.type === "permission.asked"), "permission.asked");
    const asked = rec.events.find((x) => x.e.type === "permission.asked")!;
    expect(asked.origin.sessionId).toBe(asked.e.data.sessionID);
    expect(asked.origin.isChild).toBe(asked.e.data.sessionID !== root);
    await api(srv, "POST", `/api/session/${asked.e.data.sessionID}/permission/${asked.e.data.id}/reply`, { decision: "once" });
    await until(() => rec.count("session.execution.succeeded", root) === 1, "root turn done");
  });

  test("children and grandchildren that already exist are seeded on subscribe (depth tagged)", async () => {
    const srv = await boot();
    const root = await newSession(srv);
    const child = await newSession(srv, root);
    const grand = await newSession(srv, child);
    const stranger = await newSession(srv);
    const rec = new Rec();
    const sub = subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, root, rec);
    await sub.ready;
    expect(__forTest.probe(KEY)?.owned.sort()).toEqual([root, child, grand].sort());

    // Barrier: another subscriber of the stranger on the same stream; once it has
    // the stranger's terminal event, every stranger event went past `rec` too.
    const strangerRec = new Rec();
    await subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, stranger, strangerRec).ready;
    await prompt(srv, grand, "from the grandchild");
    await prompt(srv, stranger, "unrelated");
    await until(() => rec.count("session.execution.succeeded", grand) === 1, "grandchild turn done");
    await until(() => strangerRec.count("session.execution.succeeded", stranger) === 1, "stranger turn done");
    const g = rec.events.find((x) => x.origin.sessionId === grand)!;
    expect(g.origin).toEqual({ sessionId: grand, isChild: true, childOf: child, depth: 2 });
    expect(rec.events.some((x) => x.e.data?.sessionID === stranger)).toBe(false);
  });
});

describe("reconnect and resync", () => {
  test("a dropped stream reconnects and each subscriber is resynced exactly once; a child created in the gap is still owned", async () => {
    __forTest.setBackoff({ baseMs: 200, maxMs: 400, maxFailures: 10, stableMs: 60_000 });
    const srv = await boot();
    const a = await newSession(srv);
    const b = await newSession(srv);
    const ra = new Rec();
    const rb = new Rec();
    const subA = subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, a, ra);
    const subB = subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, b, rb);
    await Promise.all([subA.ready, subB.ready]);
    expect(ra.resyncs + rb.resyncs).toBe(0);

    srv.dropEventStreams();
    // created while the hub is (probably) between streams: its session.created is not seen live
    const gapChild = await newSession(srv, a);
    await until(() => ra.resyncs >= 1 && rb.resyncs >= 1, "resync");
    expect(__forTest.probe(KEY)?.owned).toContain(gapChild);

    // events flow again, with one stream at a time
    await prompt(srv, a, "after the gap");
    await until(() => ra.count("session.execution.succeeded", a) === 1, "turn after reconnect");
    // the whole turn went by on the new stream and no second resync followed
    expect(ra.resyncs).toBe(1);
    expect(rb.resyncs).toBe(1);
    expect(__forTest.streamStats().maxConcurrent).toBe(1);
    expect(__forTest.streamStats().opened).toBe(2);
  });

  test("a subscriber added while connected is not resynced for a gap it did not live through, but is for the next one", async () => {
    __forTest.setBackoff({ baseMs: 20, maxMs: 40, maxFailures: 10, stableMs: 60_000 });
    const srv = await boot();
    const a = await newSession(srv);
    const ra = new Rec();
    await subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, a, ra).ready;
    srv.dropEventStreams();
    await until(() => ra.resyncs === 1, "first resync");
    const b = await newSession(srv);
    const rb = new Rec();
    await subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, b, rb).ready;
    expect(rb.resyncs).toBe(0);
    srv.dropEventStreams();
    await until(() => ra.resyncs === 2 && rb.resyncs === 1, "second resync");
  });

  test("the server going away exhausts the capped retries and every subscriber gets onServerLost", async () => {
    __forTest.setBackoff({ baseMs: 2, maxMs: 5, maxFailures: 4, stableMs: 60_000 });
    const srv = await boot();
    const a = await newSession(srv);
    const b = await newSession(srv);
    const ra = new Rec();
    const rb = new Rec();
    await Promise.all([
      subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, a, ra).ready,
      subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, b, rb).ready,
    ]);
    await srv.stop();
    await until(() => ra.lost.length === 1 && rb.lost.length === 1, "onServerLost");
    // nothing retries any more: the record (and with it any retry timer) is gone,
    // and a later subscribe for the key starts a fresh record with no old entries
    expect(__forTest.probe(KEY)).toBeNull();
    const fresh = await boot();
    const c = await newSession(fresh);
    await subscribeOpencodeSession({ key: KEY, url: fresh.url, password: fresh.password }, c, new Rec()).ready;
    expect(__forTest.probe(KEY)?.subscribers).toBe(1);
    expect(ra.lost).toHaveLength(1);
    expect(rb.lost).toHaveLength(1);
    expect(ra.resyncs + rb.resyncs).toBe(0);
  });

  test("a server that never answers rejects ready; a later subscribe to a live server starts afresh", async () => {
    __forTest.setBackoff({ baseMs: 2, maxMs: 5, maxFailures: 3, stableMs: 60_000 });
    const dead = await boot();
    const deadUrl = dead.url;
    await dead.stop();
    const rec = new Rec();
    const sub = subscribeOpencodeSession({ key: KEY, url: deadUrl, password: "pw-hub-test" }, "ses_dead", rec);
    await expect(sub.ready).rejects.toBeTruthy();
    await until(() => rec.lost.length === 1, "onServerLost");
    expect(__forTest.probe(KEY)).toBeNull();

    const live = await boot();
    const sid = await newSession(live);
    const rec2 = new Rec();
    await subscribeOpencodeSession({ key: KEY, url: live.url, password: live.password }, sid, rec2).ready;
    await prompt(live, sid, "hi");
    await until(() => rec2.count("session.execution.succeeded") === 1, "turn on the new server");
  });
});

describe("lifecycle", () => {
  test("unsubscribing the last subscriber closes the stream; a watched session keeps it open; reopened on demand", async () => {
    const srv = await boot();
    const a = await newSession(srv);
    const rec = new Rec();
    const sub = subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, a, rec);
    await sub.ready;
    expect(__forTest.probe(KEY)?.streamOpen).toBe(true);
    sub.unsubscribe();
    sub.unsubscribe(); // idempotent
    expect(__forTest.probe(KEY)).toBeNull();

    // watch alone opens (and keeps) a stream
    watchOpencodeSessionsForWake(KEY, { url: srv.url, password: srv.password }, [a]);
    await until(() => __forTest.probe(KEY)?.connected === true, "watch-only stream connected");
    const rec2 = new Rec();
    const sub2 = subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, a, rec2);
    await sub2.ready;
    sub2.unsubscribe();
    expect(__forTest.probe(KEY)?.streamOpen).toBe(true);
    watchOpencodeSessionsForWake(KEY, { url: srv.url, password: srv.password }, []);
    expect(__forTest.probe(KEY)).toBeNull();

    // reopened on demand
    const rec3 = new Rec();
    await subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, a, rec3).ready;
    await prompt(srv, a, "again");
    await until(() => rec3.count("session.execution.succeeded") === 1, "turn after reopen");
    expect(__forTest.streamStats().maxConcurrent).toBe(1);
  });

  test("a changed ref for the same key closes the old stream, opens one on the new server, and resyncs the subscribers", async () => {
    const srvA = await boot();
    const srvB = await boot({ password: "pw-other" });
    const a = await newSession(srvA);
    const b = await newSession(srvB);
    const ra = new Rec();
    const rb = new Rec();
    await subscribeOpencodeSession({ key: KEY, url: srvA.url, password: srvA.password }, a, ra).ready;
    const subB = subscribeOpencodeSession({ key: KEY, url: srvB.url, password: srvB.password }, b, rb);
    await subB.ready;
    // the first subscriber lived through the swap: told to refetch
    await until(() => ra.resyncs === 1, "resync after ref change");
    expect(rb.resyncs).toBe(0);
    expect(__forTest.streamStats().maxConcurrent).toBe(1);

    const aBefore = ra.events.length;
    // Barrier: an observer stream of our own on server A sees A's whole turn.
    const observer = await observe(srvA);
    try {
      await prompt(srvA, a, "ignored now"); // server A is no longer streamed by the hub
      await until(() => observer.saw("session.execution.succeeded", a), "A's turn ended (seen by the observer)");
      // and a later turn on B went through the hub's stream after it
      await prompt(srvB, b, "heard");
      await until(() => rb.count("session.execution.succeeded") === 1, "turn on B");
      expect(ra.events.length).toBe(aBefore);
    } finally {
      observer.close();
    }
  });

  test("an invalid server ref rejects ready and never opens a stream", async () => {
    const rec = new Rec();
    const sub = subscribeOpencodeSession({ key: KEY, url: "https://example.com", password: "x" }, "ses_x", rec);
    await expect(sub.ready).rejects.toBeTruthy();
    sub.unsubscribe();
    expect(__forTest.probe(KEY)).toBeNull();
    expect(__forTest.streamStats().opened).toBe(0);
  });

  test("closeOpencodeHub closes the stream, drops subscribers and rejects a pending ready", async () => {
    const dead = await boot();
    const url = dead.url;
    await dead.stop();
    __forTest.setBackoff({ baseMs: 5000, maxMs: 5000, maxFailures: 10, stableMs: 60_000 });
    const rec = new Rec();
    const sub = subscribeOpencodeSession({ key: KEY, url, password: "pw-hub-test" }, "ses_x", rec);
    await until(() => __forTest.probe(KEY)?.retryPending === true, "first attempt failed");
    closeOpencodeHub(KEY);
    await expect(sub.ready).rejects.toBeTruthy();
    expect(__forTest.probe(KEY)).toBeNull();
    expect(rec.lost).toHaveLength(0);
  });

  test("a throwing subscriber breaks neither the stream nor the other subscribers", async () => {
    __forTest.setBackoff({ baseMs: 20, maxMs: 40, maxFailures: 10, stableMs: 60_000 });
    const srv = await boot();
    const a = await newSession(srv);
    const b = await newSession(srv);
    const bad = new Rec();
    bad.onEventHook = () => {
      throw new Error("boom in onEvent");
    };
    bad.onResync = () => {
      throw new Error("boom in onResync");
    };
    const good = new Rec();
    await Promise.all([
      subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, a, bad).ready,
      subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, b, good).ready,
    ]);
    await prompt(srv, a, "bad");
    await prompt(srv, b, "good");
    await until(() => good.count("session.execution.succeeded") === 1 && bad.count("session.execution.succeeded") === 1, "both turns");
    // the throwing subscriber still received every event after its first throw
    expect(bad.events.length).toBeGreaterThan(3);
    expect(warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes(a))).toBe(true);

    srv.dropEventStreams();
    await until(() => good.resyncs === 1, "resync of the healthy subscriber");
    expect(__forTest.probe(KEY)?.connects).toBe(2);
    await prompt(srv, b, "good again");
    await until(() => good.count("session.execution.succeeded") === 2, "second turn");
  });
});

describe("wake", () => {
  test("a server-initiated execution on a watched root with no subscriber calls the wake handler once", async () => {
    const srv = await boot({ speed: 0.15 });
    const root = await newSession(srv);
    const woke: Array<{ key: string; sid: string; e: OpencodeEnvelope; input: OpencodeWakeInput }> = [];
    setOpencodeWakeHandler((key, sid, e, input) => woke.push({ key, sid, e, input }));
    const ref = { url: srv.url, password: srv.password };
    watchOpencodeSessionsForWake(KEY, ref, [root]);

    // The first turn runs with a subscriber attached (its driver handles it); the
    // subagent finishes after the turn ends and wakes the unsubscribed parent.
    const rec = new Rec();
    const sub = subscribeOpencodeSession({ key: KEY, ...ref }, root, rec);
    await sub.ready;
    rec.onEventHook = (e) => {
      if (e.type === "session.execution.succeeded" && e.data.sessionID === root) sub.unsubscribe();
    };
    await prompt(srv, root, "go __agetor_fake_oc_wake__");
    await until(() => woke.length >= 1, "wake handler called");
    // The second execution runs to its end (the hub sees its terminal event and
    // the server has nothing active); only then can "no second wake" be asserted.
    await until(() => !__forTest.probe(KEY)!.openExec.includes(root), "the woken execution ended on the hub");
    expect((await api(srv, "GET", "/api/session/active")).data[root]).toBeUndefined();
    expect(woke).toHaveLength(1);
    expect(woke[0]!.key).toBe(KEY);
    expect(woke[0]!.sid).toBe(root);
    expect(woke[0]!.e.type).toBe("session.execution.started");
    expect(woke[0]!.e.data.sessionID).toBe(root);
    // the fake wakes the parent through a synthetic inbox item for the finished background child
    expect(woke[0]!.input.known).toBe(true);
    expect(woke[0]!.input.items).toHaveLength(1);
    expect(woke[0]!.input.items[0]).toMatchObject({ synthetic: true, source: "subagent", state: "completed" });
    expect(typeof woke[0]!.input.items[0]!.childID).toBe("string");
    expect(typeof woke[0]!.input.items[0]!.inboxId).toBe("string");
    expect(rec.count("session.execution.started", root)).toBe(1); // only the subscribed turn
  });

  describe("wake input (C1)", () => {
    // A scripted event stream: the test pushes SSE envelopes by hand. `active`
    // is what GET /api/session/active answers.
    function scripted() {
      let ctl!: ReadableStreamDefaultController<Uint8Array>;
      const enc = new TextEncoder();
      const state = { active: {} as Record<string, unknown>, activeCalls: 0 };
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          const u = new URL(req.url);
          if (u.pathname === "/api/event") {
            const body = new ReadableStream<Uint8Array>({
              start(c) {
                ctl = c;
                c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "server.connected" })}\n\n`));
              },
            });
            return new Response(body, { headers: { "content-type": "text/event-stream" } });
          }
          if (u.pathname === "/api/session/active") {
            state.activeCalls++;
            return Response.json({ data: state.active });
          }
          return new Response("nf", { status: 404 });
        },
      });
      let n = 0;
      const push = (type: string, data: Record<string, unknown>) =>
        ctl.enqueue(enc.encode(`data: ${JSON.stringify({ id: `evt_${++n}`, created: n, type, data })}\n\n`));
      const drop = () => ctl.close();
      return { server, push, drop, state, ref: { url: `http://127.0.0.1:${server.port}`, password: "pw-scripted" } };
    }
    type Push = (type: string, data: Record<string, unknown>) => void;
    const enqueueSynthetic = (push: Push, sid: string, inboxID: string, metadata: Record<string, unknown>) =>
      push("session.inbox.enqueued", { inboxID, sessionID: sid, item: { type: "synthetic", payload: { text: "t", metadata }, delivery: "steer" } });
    const enqueueUser = (push: Push, sid: string, inboxID: string) =>
      push("session.inbox.enqueued", { inboxID, sessionID: sid, item: { type: "user", payload: { text: "hi" }, delivery: "queue" } });
    const delivered = (push: Push, sid: string, inboxID: string) => push("session.inbox.delivered", { sessionID: sid, inboxID });
    const cancelled = (childID: string) => ({ source: "subagent", childID, state: "cancelled", agent: "General" });
    const cancelledItem = (inboxId: string, childID: string) => ({ inboxId, synthetic: true, source: "subagent", childID, state: "cancelled" });

    type Woke = { sid: string; id?: string; input: OpencodeWakeInput };
    function recordWakes(): Woke[] {
      const woke: Woke[] = [];
      setOpencodeWakeHandler((_k, sid, e, input) => woke.push({ sid, id: e.id, input }));
      return woke;
    }
    /** Watch, connect, and wait until the connect snapshot found the sessions idle (from then on the hub sees every enqueue). */
    async function watchSeen(ref: { url: string; password: string }, ids: string[]): Promise<void> {
      watchOpencodeSessionsForWake(KEY, ref, ids);
      await until(() => {
        const p = __forTest.probe(KEY);
        return !!p && p.connected && ids.every((id) => !p.blind.includes(id));
      }, "connected and every watched session seen idle");
    }
    /** A positive barrier for the scripted stream: a wake on a marker session pushed after everything before it. */
    async function marker(push: Push, woke: Woke[], sid = "ses_marker"): Promise<void> {
      const before = woke.filter((w) => w.sid === sid).length;
      push("session.execution.started", { sessionID: sid });
      await until(() => woke.filter((w) => w.sid === sid).length === before + 1, `marker wake on ${sid}`);
      push("session.execution.succeeded", { sessionID: sid });
    }

    test("a synthetic(cancelled) item enqueued before the execution is in its wake input, known", async () => {
      const { server, push, ref } = scripted();
      try {
        const woke = recordWakes();
        await watchSeen(ref, ["ses_root"]);
        enqueueSynthetic(push, "ses_root", "inb_1", cancelled("ses_kid"));
        push("session.execution.started", { sessionID: "ses_root" });
        await until(() => woke.length === 1, "wake");
        expect(woke[0]!.sid).toBe("ses_root");
        expect(woke[0]!.input).toEqual({ items: [cancelledItem("inb_1", "ses_kid")], known: true });
      } finally {
        server.stop(true);
      }
    });

    test("(c) a delivered item is not carried into the next execution's wake", async () => {
      const { server, push, ref } = scripted();
      try {
        const woke = recordWakes();
        await watchSeen(ref, ["ses_root"]);
        enqueueSynthetic(push, "ses_root", "inb_1", cancelled("ses_kid"));
        push("session.execution.started", { sessionID: "ses_root" });
        delivered(push, "ses_root", "inb_1");
        push("session.execution.succeeded", { sessionID: "ses_root" });
        await until(() => woke.length === 1 && !__forTest.probe(KEY)!.woken.includes("ses_root"), "first execution woken and ended");
        expect(__forTest.probe(KEY)!.pending).toEqual({});
        push("session.execution.started", { sessionID: "ses_root" });
        await until(() => woke.length === 2, "second wake");
        expect(woke[1]!.input).toEqual({ items: [], known: true });
      } finally {
        server.stop(true);
      }
    });

    test("a cancelled item (session.inbox.cancelled) is not carried; the others are", async () => {
      const { server, push, ref } = scripted();
      try {
        const woke = recordWakes();
        await watchSeen(ref, ["ses_root", "ses_marker"]);
        push("session.execution.started", { sessionID: "ses_root" });
        await until(() => woke.length === 1, "first wake");
        enqueueUser(push, "ses_root", "inb_keep");
        enqueueUser(push, "ses_root", "inb_drop");
        push("session.inbox.cancelled", { sessionID: "ses_root", inboxID: "inb_drop" });
        push("session.execution.interrupted", { sessionID: "ses_root" });
        push("session.execution.started", { sessionID: "ses_root" });
        await until(() => woke.length === 2, "second wake");
        expect(woke[1]!.input).toEqual({ items: [{ inboxId: "inb_keep", synthetic: false }], known: true });
        // cancelling the last pending item empties the set
        push("session.inbox.cancelled", { sessionID: "ses_root", inboxID: "inb_keep" });
        await marker(push, woke);
        expect(__forTest.probe(KEY)!.pending).toEqual({});
      } finally {
        server.stop(true);
      }
    });

    test("(b) an item enqueued during an execution that ends interrupted, never delivered, is carried into the next execution's wake", async () => {
      const { server, push, ref } = scripted();
      try {
        const woke = recordWakes();
        await watchSeen(ref, ["ses_root"]);
        push("session.execution.started", { sessionID: "ses_root" });
        await until(() => woke.length === 1, "first wake");
        expect(woke[0]!.input).toEqual({ items: [], known: true });
        enqueueSynthetic(push, "ses_root", "inb_c", { source: "subagent", childID: "ses_kid", state: "completed" });
        push("session.execution.interrupted", { sessionID: "ses_root" });
        push("session.execution.started", { sessionID: "ses_root" });
        await until(() => woke.length === 2, "second wake");
        expect(woke[1]!.input).toEqual({
          items: [{ inboxId: "inb_c", synthetic: true, source: "subagent", childID: "ses_kid", state: "completed" }],
          known: true,
        });
      } finally {
        server.stop(true);
      }
    });

    test("(a) review scenario B: enqueue A, E1 started, enqueue B, E1 interrupted, E2 started: E2 carries B, and A only if A was not delivered", async () => {
      const { server, push, ref } = scripted();
      try {
        const woke = recordWakes();
        await watchSeen(ref, ["ses_d", "ses_n"]);
        for (const sid of ["ses_d", "ses_n"]) {
          enqueueSynthetic(push, sid, `${sid}_A`, cancelled("ses_kidA"));
          push("session.execution.started", { sessionID: sid }); // E1
          if (sid === "ses_d") delivered(push, sid, `${sid}_A`);
          enqueueSynthetic(push, sid, `${sid}_B`, cancelled("ses_kidB"));
          push("session.execution.interrupted", { sessionID: sid });
          push("session.execution.started", { sessionID: sid }); // E2
        }
        await until(() => woke.length === 4, "two wakes per session");
        const of = (sid: string) => woke.filter((w) => w.sid === sid).map((w) => w.input);
        expect(of("ses_d")).toEqual([
          { items: [cancelledItem("ses_d_A", "ses_kidA")], known: true },
          { items: [cancelledItem("ses_d_B", "ses_kidB")], known: true },
        ]);
        expect(of("ses_n")).toEqual([
          { items: [cancelledItem("ses_n_A", "ses_kidA")], known: true },
          { items: [cancelledItem("ses_n_A", "ses_kidA"), cancelledItem("ses_n_B", "ses_kidB")], known: true },
        ]);
      } finally {
        server.stop(true);
      }
    });

    test("(a) scenario B under a driver: the wake on the last unsubscribe carries what E2 started with", async () => {
      const { server, push, ref } = scripted();
      try {
        const woke = recordWakes();
        await watchSeen(ref, ["ses_root"]);
        const rec = new Rec();
        const sub = subscribeOpencodeSession({ key: KEY, ...ref }, "ses_root", rec);
        await sub.ready;
        enqueueSynthetic(push, "ses_root", "inb_A", cancelled("ses_kidA"));
        push("session.execution.started", { sessionID: "ses_root" }); // E1, the driver's
        delivered(push, "ses_root", "inb_A");
        enqueueSynthetic(push, "ses_root", "inb_B", cancelled("ses_kidB"));
        push("session.execution.interrupted", { sessionID: "ses_root" });
        push("session.execution.started", { sessionID: "ses_root" }); // E2
        delivered(push, "ses_root", "inb_B"); // delivered after E2 started: still what E2 started with
        await until(() => rec.count("session.inbox.delivered", "ses_root") === 2, "the driver saw E2 take B");
        expect(woke).toHaveLength(0); // attached: its driver owns the execution
        sub.unsubscribe(); // E2 is still open
        expect(woke).toHaveLength(1);
        expect(woke[0]!.input).toEqual({ items: [cancelledItem("inb_B", "ses_kidB")], known: true });
      } finally {
        server.stop(true);
      }
    });

    test("(d) a user item is carried with synthetic:false, in enqueue order with the synthetic ones", async () => {
      const { server, push, ref } = scripted();
      try {
        const woke = recordWakes();
        await watchSeen(ref, ["ses_root"]);
        enqueueUser(push, "ses_root", "inb_u");
        enqueueSynthetic(push, "ses_root", "inb_s", cancelled("ses_kid"));
        push("session.inbox.enqueued", { inboxID: "inb_nometa", sessionID: "ses_root", item: { type: "synthetic", payload: { text: "x" } } });
        push("session.execution.started", { sessionID: "ses_root" });
        await until(() => woke.length === 1, "wake");
        expect(woke[0]!.input).toEqual({
          items: [{ inboxId: "inb_u", synthetic: false }, cancelledItem("inb_s", "ses_kid"), { inboxId: "inb_nometa", synthetic: true }],
          known: true,
        });
      } finally {
        server.stop(true);
      }
    });

    test("(e) a wake from the connect snapshot is not known; after its end an idle re-check makes the next one known", async () => {
      const { server, push, state, ref } = scripted();
      try {
        const woke = recordWakes();
        state.active = { ses_root: { type: "busy" } };
        watchOpencodeSessionsForWake(KEY, ref, ["ses_root"]);
        await until(() => woke.length === 1, "snapshot wake");
        expect(woke[0]!.id).toMatch(/^resync:1:/);
        expect(woke[0]!.input).toEqual({ items: [], known: false });
        expect(__forTest.probe(KEY)!.blind).toEqual(["ses_root"]);
        // it ends and the server still reports it busy: the post-end check keeps it blind
        push("session.execution.succeeded", { sessionID: "ses_root" });
        await until(() => state.activeCalls === 2, "the post-end check asked the server");
        // a live item the hub did see is carried, but the set is still not known complete
        enqueueSynthetic(push, "ses_root", "inb_1", cancelled("ses_kid"));
        push("session.execution.started", { sessionID: "ses_root" });
        await until(() => woke.length === 2, "second wake");
        expect(woke[1]!.input).toEqual({ items: [cancelledItem("inb_1", "ses_kid")], known: false });
        // this time the session is idle after the end: from now on every enqueue is seen
        delivered(push, "ses_root", "inb_1");
        state.active = {};
        push("session.execution.succeeded", { sessionID: "ses_root" });
        await until(() => !__forTest.probe(KEY)!.blind.includes("ses_root"), "the post-end check saw the session idle");
        push("session.execution.started", { sessionID: "ses_root" });
        await until(() => woke.length === 3, "live wake");
        expect(woke[2]!.input).toEqual({ items: [], known: true });
      } finally {
        server.stop(true);
      }
    });

    test("(e) a live execution of a newly watched session, before its snapshot came back, is not known", async () => {
      const { server, push, ref } = scripted();
      try {
        const woke = recordWakes();
        await watchSeen(ref, ["ses_a"]);
        const gate = hold();
        let entered = false;
        __forTest.setHooks({
          afterActiveSessions: async () => {
            entered = true;
            await gate.wait;
          },
        });
        watchOpencodeSessionsForWake(KEY, ref, ["ses_a", "ses_new"]);
        await until(() => entered, "the snapshot for the new id is held");
        enqueueSynthetic(push, "ses_new", "inb_1", cancelled("ses_kid"));
        push("session.execution.started", { sessionID: "ses_new" });
        push("session.execution.started", { sessionID: "ses_a" });
        await until(() => woke.length === 2, "both live wakes");
        expect(woke.find((w) => w.sid === "ses_new")!.input).toEqual({ items: [cancelledItem("inb_1", "ses_kid")], known: false });
        expect(woke.find((w) => w.sid === "ses_a")!.input).toEqual({ items: [], known: true });
        gate.release();
      } finally {
        server.stop(true);
      }
    });

    test("(e) after a reconnect, an execution before the snapshot came back is not known", async () => {
      __forTest.setBackoff({ baseMs: 20, maxMs: 40, maxFailures: 10, stableMs: 60_000 });
      const { server, push, drop, ref } = scripted();
      try {
        const woke = recordWakes();
        await watchSeen(ref, ["ses_root"]);
        const gate = hold();
        let entered = false;
        __forTest.setHooks({
          afterActiveSessions: async () => {
            entered = true;
            await gate.wait;
          },
        });
        drop();
        await until(() => entered && __forTest.probe(KEY)!.connects === 2, "reconnected, snapshot held");
        expect(__forTest.probe(KEY)!.blind).toEqual(["ses_root"]);
        push("session.execution.started", { sessionID: "ses_root" });
        await until(() => woke.length === 1, "live wake on the new stream");
        expect(woke[0]!.input).toEqual({ items: [], known: false });
        gate.release();
      } finally {
        server.stop(true);
      }
    });

    test("(f) a pending set trimmed by the per-session cap is not known until a delivery empties it", async () => {
      __forTest.setPendingCaps({ perSession: 2 });
      const { server, push, ref } = scripted();
      try {
        const woke = recordWakes();
        await watchSeen(ref, ["ses_root"]);
        for (const id of ["inb_1", "inb_2", "inb_3"]) enqueueSynthetic(push, "ses_root", id, cancelled(`kid_${id}`));
        push("session.execution.started", { sessionID: "ses_root" });
        await until(() => woke.length === 1, "first wake");
        expect(woke[0]!.input).toEqual({ items: [cancelledItem("inb_2", "kid_inb_2"), cancelledItem("inb_3", "kid_inb_3")], known: false });
        delivered(push, "ses_root", "inb_2");
        delivered(push, "ses_root", "inb_3");
        push("session.execution.succeeded", { sessionID: "ses_root" });
        await until(() => !__forTest.probe(KEY)!.woken.includes("ses_root"), "first execution ended");
        push("session.execution.started", { sessionID: "ses_root" });
        await until(() => woke.length === 2, "second wake");
        expect(woke[1]!.input).toEqual({ items: [], known: true });
      } finally {
        server.stop(true);
      }
    });

    test("(f) the total cap trims the oldest item of all sessions; that session is not known until an idle check", async () => {
      __forTest.setPendingCaps({ total: 2 });
      const { server, push, ref } = scripted();
      try {
        const woke = recordWakes();
        await watchSeen(ref, ["ses_x", "ses_y"]);
        enqueueSynthetic(push, "ses_x", "x1", cancelled("kx"));
        enqueueSynthetic(push, "ses_y", "y1", cancelled("ky1"));
        enqueueSynthetic(push, "ses_y", "y2", cancelled("ky2"));
        push("session.execution.started", { sessionID: "ses_x" });
        push("session.execution.started", { sessionID: "ses_y" });
        await until(() => woke.length === 2, "both wakes");
        expect(woke.find((w) => w.sid === "ses_x")!.input).toEqual({ items: [], known: false });
        expect(woke.find((w) => w.sid === "ses_y")!.input).toEqual({ items: [cancelledItem("y1", "ky1"), cancelledItem("y2", "ky2")], known: true });
        // its end asks the server; idle clears the trim
        push("session.execution.succeeded", { sessionID: "ses_x" });
        await until(() => __forTest.probe(KEY)!.pending.ses_x === undefined, "the trimmed set was cleared by the idle check");
        push("session.execution.started", { sessionID: "ses_x" });
        await until(() => woke.length === 3, "third wake");
        expect(woke[2]!.input).toEqual({ items: [], known: true });
      } finally {
        server.stop(true);
      }
    });

    test("(g) leaving the watch set prunes the session's pending items; coming back starts blind", async () => {
      const { server, push, ref } = scripted();
      try {
        const woke = recordWakes();
        await watchSeen(ref, ["ses_a", "ses_b", "ses_marker"]);
        enqueueSynthetic(push, "ses_a", "a1", cancelled("ka"));
        enqueueSynthetic(push, "ses_b", "b1", cancelled("kb"));
        await marker(push, woke);
        expect(__forTest.probe(KEY)!.pending).toEqual({ ses_a: ["a1"], ses_b: ["b1"] });
        watchOpencodeSessionsForWake(KEY, ref, ["ses_a", "ses_marker"]);
        expect(__forTest.probe(KEY)!.pending).toEqual({ ses_a: ["a1"] });
        // an enqueue for an unwatched session is not tracked
        enqueueSynthetic(push, "ses_b", "b2", cancelled("kb2"));
        await marker(push, woke);
        expect(__forTest.probe(KEY)!.pending).toEqual({ ses_a: ["a1"] });
        // back in the set: blind until its snapshot, and nothing from before is carried
        const gate = hold();
        __forTest.setHooks({ afterActiveSessions: () => gate.wait });
        watchOpencodeSessionsForWake(KEY, ref, ["ses_a", "ses_b", "ses_marker"]);
        expect(__forTest.probe(KEY)!.blind).toEqual(["ses_b"]);
        push("session.execution.started", { sessionID: "ses_b" });
        await until(() => woke.some((w) => w.sid === "ses_b"), "wake for ses_b");
        expect(woke.find((w) => w.sid === "ses_b")!.input).toEqual({ items: [], known: false });
        gate.release();
        // an empty watch clears everything
        watchOpencodeSessionsForWake(KEY, ref, []);
        expect(__forTest.probe(KEY)).toBeNull();
      } finally {
        server.stop(true);
      }
    });
  });

  test("a subscribed session never triggers the wake handler", async () => {
    const srv = await boot({ speed: 0.15 });
    const root = await newSession(srv);
    const woke: string[] = [];
    setOpencodeWakeHandler((_k, sid) => woke.push(sid));
    const ref = { url: srv.url, password: srv.password };
    watchOpencodeSessionsForWake(KEY, ref, [root]);
    const rec = new Rec();
    await subscribeOpencodeSession({ key: KEY, ...ref }, root, rec).ready;
    await prompt(srv, root, "go __agetor_fake_oc_wake__");
    await until(() => rec.count("session.execution.succeeded", root) === 2, "both executions seen by the subscriber", 15_000);
    expect(rec.count("session.execution.started", root)).toBe(2);
    expect(woke).toHaveLength(0);
  });

  test("an unwatched session never triggers the wake handler, and a throwing handler does not break the stream", async () => {
    const srv = await boot();
    const watched = await newSession(srv);
    const other = await newSession(srv);
    const woke: string[] = [];
    setOpencodeWakeHandler((_k, sid) => {
      woke.push(sid);
      throw new Error("handler boom");
    });
    const ref = { url: srv.url, password: srv.password };
    watchOpencodeSessionsForWake(KEY, ref, [watched]);
    await until(() => __forTest.probe(KEY)?.connected === true, "connected");
    const observer = await observe(srv);
    try {
      await prompt(srv, other, "not watched");
      await until(() => observer.saw("session.execution.succeeded", other), "the unwatched turn ended");
    } finally {
      observer.close();
    }
    expect(woke).toHaveLength(0);
    // the watched turn's started reaches the hub after every event of the unwatched one
    await prompt(srv, watched, "watched, nobody attached");
    await until(() => woke.length === 1, "wake");
    expect(woke).toEqual([watched]);
    expect(__forTest.probe(KEY)?.connected).toBe(true);
  });

  test("a turn that starts while the stream is down is still woken after the reconnect", async () => {
    __forTest.setBackoff({ baseMs: 300, maxMs: 300, maxFailures: 10, stableMs: 60_000 });
    const srv = await boot();
    const root = await newSession(srv);
    const woke: Array<{ sid: string; id?: string }> = [];
    setOpencodeWakeHandler((_k, sid, e) => woke.push({ sid, id: e.id }));
    watchOpencodeSessionsForWake(KEY, { url: srv.url, password: srv.password }, [root]);
    await until(() => __forTest.probe(KEY)?.connected === true, "connected");
    srv.dropEventStreams();
    await prompt(srv, root, "__agetor_fake_oc_slow__"); // runs until interrupted
    await until(() => woke.length >= 1, "wake after reconnect");
    expect(__forTest.probe(KEY)!.openExec).toEqual([root]);
    // Barrier: the execution's end reached the hub, so no later event of it can wake again.
    await api(srv, "POST", `/api/session/${root}/interrupt`);
    await until(() => !__forTest.probe(KEY)!.openExec.includes(root), "the woken execution ended on the hub");
    expect(woke).toHaveLength(1);
    expect(woke[0]!.sid).toBe(root);
  });
});

function hold(): { wait: Promise<void>; release(): void } {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  return { wait, release };
}

describe("wake: executions that begin under a subscribed driver (M1)", () => {
  test("unsubscribing after an await while the next execution is still open wakes, once", async () => {
    const srv = await boot();
    const root = await newSession(srv);
    const woke: Array<{ sid: string; e: OpencodeEnvelope }> = [];
    setOpencodeWakeHandler((_k, sid, e) => woke.push({ sid, e }));
    const ref = { url: srv.url, password: srv.password };
    watchOpencodeSessionsForWake(KEY, ref, [root]);
    const rec = new Rec();
    const sub = subscribeOpencodeSession({ key: KEY, ...ref }, root, rec);
    await sub.ready;
    await prompt(srv, root, "__agetor_fake_oc_slow__"); // runs until interrupted
    await until(() => rec.count("session.execution.started", root) === 1, "execution started");
    // the driver's await (a round trip); the started was routed (and any wake fired) before rec saw it
    await api(srv, "GET", "/api/session/active");
    expect(woke).toHaveLength(0);
    expect(__forTest.probe(KEY)?.openExec).toEqual([root]);
    sub.unsubscribe();
    expect(woke).toHaveLength(1);
    expect(woke[0]!.sid).toBe(root);
    expect(woke[0]!.e.id).toBe(rec.events.find((x) => x.e.type === "session.execution.started")!.e.id);
    // attaching and detaching again must not wake a second time for the same execution
    const again = subscribeOpencodeSession({ key: KEY, ...ref }, root, new Rec());
    await again.ready;
    again.unsubscribe();
    expect(woke).toHaveLength(1);
    await api(srv, "POST", `/api/session/${root}/interrupt`);
  });

  test("a driver that unsubscribes from inside the onEvent of the next execution.started wakes once", async () => {
    const srv = await boot({ speed: 0.15 });
    const root = await newSession(srv);
    const woke: string[] = [];
    setOpencodeWakeHandler((_k, sid, e) => woke.push(`${sid}:${e.type}`));
    const ref = { url: srv.url, password: srv.password };
    watchOpencodeSessionsForWake(KEY, ref, [root]);
    const rec = new Rec();
    const sub = subscribeOpencodeSession({ key: KEY, ...ref }, root, rec);
    await sub.ready;
    rec.onEventHook = (e) => {
      if (e.type === "session.execution.started" && rec.count("session.execution.started", root) === 2) sub.unsubscribe();
    };
    await prompt(srv, root, "go __agetor_fake_oc_wake__");
    await until(() => woke.length >= 1, "wake");
    // Barrier: the woken execution ran to its end on the hub, and the server has nothing active.
    await until(() => !__forTest.probe(KEY)!.openExec.includes(root), "the woken execution ended on the hub");
    expect((await api(srv, "GET", "/api/session/active")).data[root]).toBeUndefined();
    expect(woke).toEqual([`${root}:session.execution.started`]);
  });

  test("unsubscribing after the turn ended does not wake", async () => {
    const srv = await boot();
    const root = await newSession(srv);
    const woke: string[] = [];
    setOpencodeWakeHandler((_k, sid) => woke.push(sid));
    const ref = { url: srv.url, password: srv.password };
    watchOpencodeSessionsForWake(KEY, ref, [root]);
    const rec = new Rec();
    const sub = subscribeOpencodeSession({ key: KEY, ...ref }, root, rec);
    await sub.ready;
    await prompt(srv, root, "plain turn");
    await until(() => rec.count("session.execution.succeeded", root) === 1, "turn done");
    await api(srv, "GET", "/api/session/active"); // the driver's await
    sub.unsubscribe();
    expect(woke).toHaveLength(0);
    expect(__forTest.probe(KEY)?.openExec).toEqual([]);
  });
});

describe("resync carries the owned sessions (M2)", () => {
  test("a child permission raised while the stream was down is discoverable from the owned list after resync", async () => {
    __forTest.setBackoff({ baseMs: 250, maxMs: 400, maxFailures: 10, stableMs: 60_000 });
    const srv = await boot();
    const root = await newSession(srv);
    const rec = new Rec();
    await subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, root, rec).ready;
    expect(opencodeOwnedSessions(KEY, root)).toEqual([{ sessionId: root, isChild: false, depth: 0 }]);

    srv.dropEventStreams();
    const child = await newSession(srv, root, [{ action: "*", resource: "*", effect: "ask" }]);
    await prompt(srv, child, "__agetor_fake_oc_permission__"); // asks, with nobody listening
    await until(() => rec.resyncs === 1, "resync");

    const owned = rec.owned[0]!;
    expect(owned.map((o) => o.sessionId).sort()).toEqual([root, child].sort());
    expect(owned.find((o) => o.sessionId === child)).toEqual({ sessionId: child, isChild: true, childOf: root, depth: 1 });
    expect(opencodeOwnedSessions(KEY, root).map((o) => o.sessionId).sort()).toEqual([root, child].sort());
    // what the driver does with it: refetch the pending requests of every owned session
    const client = createOpencodeClient({ url: srv.url, password: srv.password });
    const pending: Array<{ sid: string; action: string }> = [];
    for (const o of owned) for (const p of await client.listPermissions(o.sessionId)) pending.push({ sid: o.sessionId, action: p.action });
    expect(pending).toEqual([{ sid: child, action: "shell" }]);
    expect(opencodeOwnedSessions(KEY, "ses_unknown")).toEqual([]);
    await api(srv, "POST", `/api/session/${child}/interrupt`);
  });
});

describe("wake checks on connect, watch loss, close (S1, S2, S3, S6)", () => {
  test("a fresh watch on a session that is already running with nobody attached wakes (first connect)", async () => {
    const srv = await boot();
    const root = await newSession(srv);
    await prompt(srv, root, "__agetor_fake_oc_slow__");
    const woke: Array<{ sid: string; id?: string }> = [];
    setOpencodeWakeHandler((_k, sid, e) => woke.push({ sid, id: e.id }));
    watchOpencodeSessionsForWake(KEY, { url: srv.url, password: srv.password }, [root]);
    await until(() => woke.length >= 1, "wake from the active-session check");
    // Barrier: the execution's end reached the hub, so nothing of it can wake again.
    await api(srv, "POST", `/api/session/${root}/interrupt`);
    await until(() => __forTest.probe(KEY)!.execSeen.includes(root) && !__forTest.probe(KEY)!.openExec.includes(root), "the execution ended on the hub");
    expect(woke).toHaveLength(1);
    expect(woke[0]!.id).toMatch(/^resync:1:/);
  });

  test("the active-session snapshot is discarded when a live execution event arrived after it was requested (stale snapshot)", async () => {
    const srv = await boot();
    const root = await newSession(srv);
    const idle = await newSession(srv); // watched after root: the check reaches it last
    await prompt(srv, root, "__agetor_fake_oc_slow__");
    const gate = hold();
    let entered = false;
    __forTest.setHooks({
      afterActiveSessions: async () => {
        entered = true;
        // the snapshot says "active"; the turn ends (live) before the hub looks at it
        await api(srv, "POST", `/api/session/${root}/interrupt`);
        await until(() => __forTest.probe(KEY)!.execSeen.includes(root), "the live end reached the hub");
        await gate.wait;
      },
    });
    const woke: string[] = [];
    setOpencodeWakeHandler((_k, sid) => woke.push(sid));
    watchOpencodeSessionsForWake(KEY, { url: srv.url, password: srv.password }, [root, idle]);
    await until(() => entered, "the wake check reached its hook");
    gate.release();
    // Barrier: the check got past root to the idle session after it
    await until(() => !__forTest.probe(KEY)!.blind.includes(idle), "the wake check finished its loop");
    expect(woke).toHaveLength(0);
  });

  test("a live execution.started during the wake check wins: no duplicate wake and the woken mark survives", async () => {
    const srv = await boot();
    const root = await newSession(srv);
    const idle = await newSession(srv); // watched after root: the check reaches it last
    const woke: string[] = [];
    setOpencodeWakeHandler((_k, sid, e) => woke.push(`${sid}:${e.id}`));
    const gate = hold();
    __forTest.setHooks({
      afterActiveSessions: async () => {
        await prompt(srv, root, "__agetor_fake_oc_slow__"); // the snapshot (idle) is now stale
        await until(() => woke.length === 1, "live wake");
        await gate.wait;
      },
    });
    watchOpencodeSessionsForWake(KEY, { url: srv.url, password: srv.password }, [root, idle]);
    await until(() => woke.length === 1, "live wake");
    gate.release();
    // Barrier: the check got past root to the idle session after it
    await until(() => !__forTest.probe(KEY)!.blind.includes(idle), "the wake check finished its loop");
    expect(woke).toHaveLength(1);
    expect(woke[0]).not.toContain("resync:");
    expect(__forTest.probe(KEY)?.woken).toEqual([root]);
    await api(srv, "POST", `/api/session/${root}/interrupt`);
  });

  test("giving up on a watched-only server tells the watch-lost handler and deletes the watch", async () => {
    __forTest.setBackoff({ baseMs: 2, maxMs: 5, maxFailures: 3, stableMs: 60_000 });
    const srv = await boot();
    const root = await newSession(srv);
    const lost: string[] = [];
    setOpencodeWatchLostHandler((k) => lost.push(k));
    watchOpencodeSessionsForWake(KEY, { url: srv.url, password: srv.password }, [root]);
    await until(() => __forTest.probe(KEY)?.connected === true, "connected");
    await srv.stop();
    await until(() => lost.length === 1, "watch-lost handler");
    expect(lost).toEqual([KEY]);
    expect(__forTest.probe(KEY)).toBeNull();
    // re-watching starts afresh
    const live = await boot();
    const sid = await newSession(live);
    watchOpencodeSessionsForWake(KEY, { url: live.url, password: live.password }, [sid]);
    await until(() => __forTest.probe(KEY)?.connected === true, "re-watched");
  });

  test("closeOpencodeHub tells ready subscribers via onServerLost and rejects pending ones", async () => {
    const live = await boot();
    const sid = await newSession(live);
    const readyRec = new Rec();
    await subscribeOpencodeSession({ key: KEY, url: live.url, password: live.password }, sid, readyRec).ready;
    const dead = await boot();
    const deadUrl = dead.url;
    await dead.stop();
    __forTest.setBackoff({ baseMs: 5000, maxMs: 5000, maxFailures: 10, stableMs: 60_000 });
    const pendingRec = new Rec();
    const pending = subscribeOpencodeSession({ key: "other-key", url: deadUrl, password: "pw-hub-test" }, "ses_p", pendingRec);
    await until(() => __forTest.probe("other-key")?.retryPending === true, "pending attempt failed");
    closeOpencodeHub();
    expect(readyRec.lost).toHaveLength(1);
    await expect(pending.ready).rejects.toBeTruthy();
    expect(pendingRec.lost).toHaveLength(0);
    expect(__forTest.serverKeys()).toEqual([]);
  });
});

describe("ref epochs and failure accounting (S4, S7)", () => {
  test("a ref with an older epoch is ignored; a newer one swaps the stream and reports the restart", async () => {
    const srvA = await boot();
    const srvB = await boot({ password: "pw-other" });
    const a = await newSession(srvA);
    const b = await newSession(srvB);
    const rb = new Rec();
    await subscribeOpencodeSession({ key: KEY, url: srvB.url, password: srvB.password, epoch: 5 }, b, rb).ready;
    const stale = subscribeOpencodeSession({ key: KEY, url: srvA.url, password: srvA.password, epoch: 3 }, a, new Rec());
    await stale.ready;
    expect(__forTest.streamStats().opened).toBe(1); // no swap
    expect(rb.resyncs).toBe(0);
    await prompt(srvB, b, "still heard");
    await until(() => rb.count("session.execution.succeeded") === 1, "turn on B");

    const rbNew = new Rec();
    await subscribeOpencodeSession({ key: KEY, url: srvA.url, password: srvA.password, epoch: 7 }, a, rbNew).ready;
    await until(() => rb.lost.length === 1, "restart reported after the newer ref");
    expect(rb.resyncs).toBe(0);
    expect(__forTest.streamStats().opened).toBe(2);
    expect(__forTest.streamStats().maxConcurrent).toBe(1);
  });

  test("a ref swap does not reset the failure count; connecting does", async () => {
    __forTest.setBackoff({ baseMs: 5000, maxMs: 5000, maxFailures: 10, stableMs: 60_000 });
    const dead = await boot();
    const deadUrl = dead.url;
    await dead.stop();
    const live = await boot();
    const sid = await newSession(live);
    const first = subscribeOpencodeSession({ key: KEY, url: deadUrl, password: "pw-hub-test" }, sid, new Rec());
    await until(() => __forTest.probe(KEY)?.failures === 1, "one failed attempt");
    const rec = new Rec();
    const second = subscribeOpencodeSession({ key: KEY, url: live.url, password: live.password }, sid, rec);
    expect(__forTest.probe(KEY)?.failures).toBe(1);
    await second.ready;
    expect(__forTest.probe(KEY)?.failures).toBe(0);
    first.unsubscribe();
  });

  test("a reachable but flapping server is declared lost after the drop cap, not before", async () => {
    __forTest.setBackoff({ baseMs: 5, maxMs: 10, maxFailures: 2, maxDrops: 3, stableMs: 60_000 });
    const srv = await boot();
    const a = await newSession(srv);
    const rec = new Rec();
    await subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, a, rec).ready;
    for (let i = 1; i <= 2; i++) {
      srv.dropEventStreams();
      await until(() => rec.resyncs === i, `resync ${i}`);
    }
    expect(rec.lost).toHaveLength(0);
    srv.dropEventStreams(); // the third short-lived stream
    await until(() => rec.lost.length === 1, "lost after the drop cap");
    expect(rec.resyncs).toBe(2);
  });

  test("streams that stayed up past stableMs never count toward the drop cap", async () => {
    __forTest.setBackoff({ baseMs: 5, maxMs: 10, maxFailures: 2, maxDrops: 2, stableMs: 0 });
    const srv = await boot();
    const a = await newSession(srv);
    const rec = new Rec();
    await subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, a, rec).ready;
    for (let i = 1; i <= 4; i++) {
      srv.dropEventStreams();
      await until(() => rec.resyncs === i, `resync ${i}`);
    }
    expect(rec.lost).toHaveLength(0);
    expect(__forTest.probe(KEY)?.drops).toBe(0);
  });
});

describe("stream open edge cases (S8)", () => {
  test("a fetch that throws synchronously cannot wedge the hub: the cap is reached and the subscriber told", async () => {
    __forTest.setBackoff({ baseMs: 2, maxMs: 4, maxFailures: 3, stableMs: 60_000 });
    __forTest.setFetchImpl((() => {
      throw new Error("sync boom");
    }) as unknown as typeof fetch);
    const rec = new Rec();
    const sub = subscribeOpencodeSession({ key: KEY, url: "http://127.0.0.1:9", password: "pw" }, "ses_x", rec);
    await expect(sub.ready).rejects.toBeTruthy();
    await until(() => rec.lost.length === 1, "onServerLost");
    expect(__forTest.probe(KEY)).toBeNull();
    expect(__forTest.streamStats().maxConcurrent).toBeLessThanOrEqual(1);
  });

  test("a fetch that throws synchronously a couple of times, then works, still connects", async () => {
    __forTest.setBackoff({ baseMs: 2, maxMs: 4, maxFailures: 10, stableMs: 60_000 });
    const srv = await boot();
    const sid = await newSession(srv);
    let calls = 0;
    __forTest.setFetchImpl(((...args: Parameters<typeof fetch>) => {
      if (calls++ < 2) throw new Error("sync boom");
      return fetch(...args);
    }) as unknown as typeof fetch);
    const rec = new Rec();
    await subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, sid, rec).ready;
    expect(calls).toBe(3);
    await prompt(srv, sid, "hello");
    await until(() => rec.count("session.execution.succeeded") === 1, "turn after the retries");
    expect(__forTest.streamStats().maxConcurrent).toBe(1);
  });
});

describe("re-seeding on reconnect (S9)", () => {
  async function twoRoots() {
    __forTest.setBackoff({ baseMs: 20, maxMs: 40, maxFailures: 10, stableMs: 60_000 });
    const srv = await boot();
    const a = await newSession(srv);
    const b = await newSession(srv);
    const ra = new Rec();
    const rb = new Rec();
    const ref = { key: KEY, url: srv.url, password: srv.password };
    const subA = subscribeOpencodeSession(ref, a, ra);
    const subB = subscribeOpencodeSession(ref, b, rb);
    await Promise.all([subA.ready, subB.ready]);
    return { srv, a, b, ra, rb, subA, subB };
  }
  function holdRoot(root: string) {
    const gate = hold();
    let held = false;
    __forTest.setHooks({
      beforeSeed: async (_k, r) => {
        if (r !== root || held) return;
        held = true;
        await gate.wait;
      },
    });
    return gate;
  }
  /**
   * Barrier: subscribe a fresh root on the current stream and wait for its
   * ready (a seed round trip to the server). A released seed continues in
   * microtasks, or with a request sent before this one, so it is done by then.
   */
  async function seedBarrier(srv: FakeOpencodeServer): Promise<void> {
    const c = await newSession(srv);
    const sub = subscribeOpencodeSession({ key: KEY, url: srv.url, password: srv.password }, c, new Rec());
    await sub.ready;
    sub.unsubscribe();
  }

  test("roots re-seed independently: a slow tree does not delay another root's resync", async () => {
    const { srv, a, rb, ra } = await twoRoots();
    const gate = holdRoot(a);
    srv.dropEventStreams();
    await until(() => rb.resyncs === 1, "root B resynced");
    expect(ra.resyncs).toBe(0);
    gate.release();
    await until(() => ra.resyncs === 1, "root A resynced after its own seed");
    await seedBarrier(srv);
    expect(__forTest.probe(KEY)?.connects).toBe(2);
    expect(ra.resyncs).toBe(1);
    expect(rb.resyncs).toBe(1);
  });

  test("unsubscribing while its root is re-seeding: no resync and nothing left owned", async () => {
    const { srv, a, rb, ra, subA } = await twoRoots();
    const gate = holdRoot(a);
    srv.dropEventStreams();
    await until(() => rb.resyncs === 1, "root B resynced");
    subA.unsubscribe();
    gate.release();
    await seedBarrier(srv);
    expect(ra.resyncs).toBe(0);
    expect(__forTest.probe(KEY)?.owned).not.toContain(a);
  });

  test("a ref change while re-seeding: the old seed is abandoned and the subscriber resyncs once, from the new connection", async () => {
    const { srv, a, ra } = await twoRoots();
    const other = await boot({ password: "pw-other" });
    const gate = holdRoot(a);
    srv.dropEventStreams();
    await until(() => __forTest.probe(KEY)?.connects === 2, "reconnected, seed held");
    const c = await newSession(other);
    await subscribeOpencodeSession({ key: KEY, url: other.url, password: other.password }, c, new Rec()).ready;
    await until(() => ra.resyncs === 1, "resync from the new connection");
    gate.release();
    await seedBarrier(other);
    expect(ra.resyncs).toBe(1);
    expect(__forTest.streamStats().maxConcurrent).toBe(1);
  });
});

describe("server restart and late watches", () => {
  test("a newer epoch tells existing subscribers the server was lost and drops them; the new subscriber continues", async () => {
    const srvA = await boot();
    const srvB = await boot({ password: "pw-restarted" });
    const a = await newSession(srvA);
    const b = await newSession(srvB);
    const ra = new Rec();
    const rb = new Rec();
    await subscribeOpencodeSession({ key: KEY, url: srvA.url, password: srvA.password, epoch: 1 }, a, ra).ready;
    const subB = subscribeOpencodeSession({ key: KEY, url: srvB.url, password: srvB.password, epoch: 2 }, b, rb);
    await until(() => ra.lost.length === 1, "the lost notification (delivered after the new subscriber registered)");
    expect(String((ra.lost[0] as Error).message)).toBe("OpenCode server restarted");
    expect(ra.resyncs).toBe(0);
    await subB.ready;
    expect(__forTest.probe(KEY)?.subscribers).toBe(1);
    expect(opencodeOwnedSessions(KEY, a)).toEqual([]);
    await prompt(srvB, b, "on the new server");
    // the turn on the new server is the barrier: the restart's notifications went out long before
    await until(() => rb.count("session.execution.succeeded") === 1, "turn on the new server");
    expect(ra.lost).toHaveLength(1);
    expect(rb.lost).toHaveLength(0);
    expect(__forTest.streamStats().maxConcurrent).toBe(1);
  });

  test("a lost driver that unsubscribes inside onServerLost does not orphan the new subscriber (S3)", async () => {
    const srvA = await boot();
    const srvB = await boot({ password: "pw-restarted" });
    const a = await newSession(srvA);
    const b = await newSession(srvB);
    const ra = new Rec();
    let subA!: { unsubscribe(): void; ready: Promise<void> };
    // what the driver's settle() does when told the server is gone
    ra.onServerLost = (err?: unknown) => {
      ra.lost.push(err ?? "lost");
      subA.unsubscribe();
    };
    subA = subscribeOpencodeSession({ key: KEY, url: srvA.url, password: srvA.password, epoch: 1 }, a, ra);
    await subA.ready;
    const rb = new Rec();
    const subB = subscribeOpencodeSession({ key: KEY, url: srvB.url, password: srvB.password, epoch: 2 }, b, rb);
    const verdict = await Promise.race([subB.ready.then(() => "ready"), Bun.sleep(5000).then(() => "timeout")]);
    expect(verdict).toBe("ready");
    expect(ra.lost).toHaveLength(1);
    // the record survived the old driver's unsubscribe: B's stream is the live one
    expect(__forTest.probe(KEY)?.subscribers).toBe(1);
    expect(__forTest.probe(KEY)?.streamOpen).toBe(true);
    await prompt(srvB, b, "heard on the new server");
    await until(() => rb.count("session.execution.succeeded") === 1, "turn on the new server");
    subB.unsubscribe();
    // nothing leaked: the record is gone and so is its stream
    expect(__forTest.probe(KEY)).toBeNull();
    expect(__forTest.streamStats().open).toBe(0);
  });

  test("a newer epoch resets the failure count (S3)", async () => {
    __forTest.setBackoff({ baseMs: 5000, maxMs: 5000, maxFailures: 10, stableMs: 60_000 });
    const dead = await boot();
    const deadUrl = dead.url;
    await dead.stop();
    const deadB = await boot();
    const deadBUrl = deadB.url;
    await deadB.stop();
    const live = await boot({ password: "pw-restarted" });
    const sid = await newSession(live);
    const first = subscribeOpencodeSession({ key: KEY, url: deadUrl, password: "pw-hub-test", epoch: 1 }, "ses_old", new Rec());
    await until(() => __forTest.probe(KEY)?.failures === 1, "one failed attempt");
    // a newer epoch whose server is unreachable too: the count restarts from this attempt, not 2
    const second = subscribeOpencodeSession({ key: KEY, url: deadBUrl, password: "pw-hub-test", epoch: 2 }, "ses_mid", new Rec());
    await until(() => __forTest.probe(KEY)?.retryPending === true, "the new epoch's first attempt failed");
    expect(__forTest.probe(KEY)?.failures).toBe(1);
    await subscribeOpencodeSession({ key: KEY, url: live.url, password: live.password, epoch: 3 }, sid, new Rec()).ready;
    first.unsubscribe();
    second.unsubscribe();
  });

  test("a pending subscriber of the old server gets its ready rejected by the restart", async () => {
    __forTest.setBackoff({ baseMs: 5000, maxMs: 5000, maxFailures: 10, stableMs: 60_000 });
    const dead = await boot();
    const deadUrl = dead.url;
    await dead.stop();
    const live = await boot({ password: "pw-restarted" });
    const sid = await newSession(live);
    const old = new Rec();
    const pending = subscribeOpencodeSession({ key: KEY, url: deadUrl, password: "pw-hub-test", epoch: 1 }, "ses_old", old);
    await until(() => __forTest.probe(KEY)?.retryPending === true, "first attempt failed");
    const fresh = new Rec();
    await subscribeOpencodeSession({ key: KEY, url: live.url, password: live.password, epoch: 2 }, sid, fresh).ready;
    await expect(pending.ready).rejects.toBeTruthy();
    expect(old.lost).toHaveLength(1);
  });

  test("an equal or unknown epoch keeps existing subscribers and resyncs them (today's behavior)", async () => {
    const srvA = await boot();
    const srvB = await boot({ password: "pw-other" });
    const a = await newSession(srvA);
    const b = await newSession(srvB);
    const ra = new Rec();
    await subscribeOpencodeSession({ key: KEY, url: srvA.url, password: srvA.password, epoch: 4 }, a, ra).ready;
    await subscribeOpencodeSession({ key: KEY, url: srvB.url, password: srvB.password, epoch: 4 }, b, new Rec()).ready;
    await until(() => ra.resyncs === 1, "resync");
    expect(ra.lost).toHaveLength(0);
  });

  test("watching more sessions on a connected stream wakes for one that is already running; the old ids are not re-woken", async () => {
    const srv = await boot();
    const x = await newSession(srv);
    const y = await newSession(srv);
    const woke: Array<{ sid: string; id?: string }> = [];
    setOpencodeWakeHandler((_k, sid, e) => woke.push({ sid, id: e.id }));
    const ref = { url: srv.url, password: srv.password };
    watchOpencodeSessionsForWake(KEY, ref, [x]);
    await until(() => __forTest.probe(KEY)?.connected === true, "connected");
    await prompt(srv, y, "__agetor_fake_oc_slow__"); // y is not watched yet: no wake
    await prompt(srv, x, "__agetor_fake_oc_slow__"); // x is watched: live wake
    await until(() => woke.length === 1, "live wake for x");
    watchOpencodeSessionsForWake(KEY, ref, [x, y]);
    await until(() => woke.length === 2, "wake for the newly watched, running y");
    expect(woke.map((w) => w.sid).sort()).toEqual([x, y].sort());
    expect(woke.find((w) => w.sid === y)!.id).toMatch(/^resync:/);
    watchOpencodeSessionsForWake(KEY, ref, [x, y]); // nothing new
    // Barrier: a later watch adding an idle z; its check (the only one started after
    // the no-op watch) has run through once z is no longer blind.
    const z = await newSession(srv);
    watchOpencodeSessionsForWake(KEY, ref, [x, y, z]);
    await until(() => !__forTest.probe(KEY)!.blind.includes(z), "the check for z ran");
    expect(woke).toHaveLength(2);
    // and the two executions end without waking again
    await api(srv, "POST", `/api/session/${x}/interrupt`);
    await api(srv, "POST", `/api/session/${y}/interrupt`);
    await until(() => __forTest.probe(KEY)!.openExec.length === 0, "both executions ended on the hub");
    expect(woke).toHaveLength(2);
  });

  test("a newly watched session that is idle does not wake", async () => {
    const srv = await boot();
    const x = await newSession(srv);
    const y = await newSession(srv);
    const woke: string[] = [];
    setOpencodeWakeHandler((_k, sid) => woke.push(sid));
    const ref = { url: srv.url, password: srv.password };
    watchOpencodeSessionsForWake(KEY, ref, [x]);
    await until(() => __forTest.probe(KEY)?.connected === true, "connected");
    let seen = false;
    __forTest.setHooks({ afterActiveSessions: () => void (seen = true) });
    watchOpencodeSessionsForWake(KEY, ref, [x, y]);
    await until(() => seen, "the check for the new ids ran");
    // Barrier: the check found y idle (it clears y's blind mark in the same pass that would wake)
    await until(() => !__forTest.probe(KEY)!.blind.includes(y), "the check for y finished");
    expect(woke).toHaveLength(0);
  });
});

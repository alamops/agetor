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
} from "./opencode-hub.ts";
import { createOpencodeClient, type OpencodeEnvelope } from "./opencode-http.ts";

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
    expect(__forTest.streamStats()).toEqual({ opened: 1, maxConcurrent: 1 });
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

    await prompt(srv, grand, "from the grandchild");
    await prompt(srv, stranger, "unrelated");
    await until(() => rec.count("session.execution.succeeded", grand) === 1, "grandchild turn done");
    await Bun.sleep(100);
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
    await Bun.sleep(300); // no second resync may follow
    expect(ra.resyncs).toBe(1);
    expect(rb.resyncs).toBe(1);
    expect(__forTest.probe(KEY)?.owned).toContain(gapChild);

    // events flow again, with one stream at a time
    await prompt(srv, a, "after the gap");
    await until(() => ra.count("session.execution.succeeded", a) === 1, "turn after reconnect");
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
    await Bun.sleep(100);
    expect(ra.lost).toHaveLength(1);
    expect(rb.lost).toHaveLength(1);
    // nothing retries any more and the record is gone
    expect(__forTest.probe(KEY)).toBeNull();
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
    await prompt(srvA, a, "ignored now"); // server A is no longer streamed
    await prompt(srvB, b, "heard");
    await until(() => rb.count("session.execution.succeeded") === 1, "turn on B");
    await Bun.sleep(150);
    expect(ra.events.length).toBe(aBefore);
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
    const woke: Array<{ key: string; sid: string; e: OpencodeEnvelope }> = [];
    setOpencodeWakeHandler((key, sid, e) => woke.push({ key, sid, e }));
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
    await Bun.sleep(600); // the second execution runs to its end; no second wake may follow
    expect(woke).toHaveLength(1);
    expect(woke[0]!.key).toBe(KEY);
    expect(woke[0]!.sid).toBe(root);
    expect(woke[0]!.e.type).toBe("session.execution.started");
    expect(woke[0]!.e.data.sessionID).toBe(root);
    expect(rec.count("session.execution.started", root)).toBe(1); // only the subscribed turn
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
    await prompt(srv, other, "not watched");
    await Bun.sleep(300);
    expect(woke).toHaveLength(0);
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
    await Bun.sleep(500);
    expect(woke).toHaveLength(1);
    expect(woke[0]!.sid).toBe(root);
    await api(srv, "POST", `/api/session/${root}/interrupt`);
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
    await Bun.sleep(30); // the driver's await
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
    await Bun.sleep(500);
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
    await Bun.sleep(30);
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
    await Bun.sleep(200);
    expect(woke).toHaveLength(1);
    expect(woke[0]!.id).toMatch(/^resync:1:/);
    await api(srv, "POST", `/api/session/${root}/interrupt`);
  });

  test("the active-session snapshot is discarded when a live execution event arrived after it was requested (stale snapshot)", async () => {
    const srv = await boot();
    const root = await newSession(srv);
    await prompt(srv, root, "__agetor_fake_oc_slow__");
    const gate = hold();
    __forTest.setHooks({
      afterActiveSessions: async () => {
        // the snapshot says "active"; the turn ends (live) before the hub looks at it
        await api(srv, "POST", `/api/session/${root}/interrupt`);
        await Bun.sleep(300);
        await gate.wait;
      },
    });
    const woke: string[] = [];
    setOpencodeWakeHandler((_k, sid) => woke.push(sid));
    watchOpencodeSessionsForWake(KEY, { url: srv.url, password: srv.password }, [root]);
    await Bun.sleep(600);
    gate.release();
    await Bun.sleep(300);
    expect(woke).toHaveLength(0);
  });

  test("a live execution.started during the wake check wins: no duplicate wake and the woken mark survives", async () => {
    const srv = await boot();
    const root = await newSession(srv);
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
    watchOpencodeSessionsForWake(KEY, { url: srv.url, password: srv.password }, [root]);
    await until(() => woke.length === 1, "live wake");
    gate.release();
    await Bun.sleep(300);
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
  test("a ref with an older epoch is ignored; a newer one swaps the stream", async () => {
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
    await until(() => rb.resyncs === 1, "resync after the newer ref");
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

  test("roots re-seed independently: a slow tree does not delay another root's resync", async () => {
    const { srv, a, rb, ra } = await twoRoots();
    const gate = holdRoot(a);
    srv.dropEventStreams();
    await until(() => rb.resyncs === 1, "root B resynced");
    expect(ra.resyncs).toBe(0);
    gate.release();
    await until(() => ra.resyncs === 1, "root A resynced after its own seed");
    await Bun.sleep(100);
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
    await Bun.sleep(150);
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
    await Bun.sleep(150);
    expect(ra.resyncs).toBe(1);
    expect(__forTest.streamStats().maxConcurrent).toBe(1);
  });
});

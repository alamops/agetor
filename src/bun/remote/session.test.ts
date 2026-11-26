// The session manager against the local test relay, the real relay link, the fake key helper and the headless test phone.
import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes, toHex } from "@agetor/remote-protocol/bytes";
import { mailboxKey, utcDate } from "@agetor/remote-protocol/derive";
import { TestPhone } from "@agetor/remote-protocol/test-client";
import { startTestRelay, type TestRelay } from "@agetor/remote-protocol/test-relay";
import type { RemoteLevel } from "@agetor/remote-protocol/levels";
import type { RemoteDeviceRow } from "../../shared/remote-types.ts";
import { FakeKeyHelper } from "./key-helper-fake.ts";
import { RateLimiter } from "./rate-limit.ts";
import { RelayLink } from "./relay-link.ts";
import { MAX_INFLIGHT_OPS, REMOVAL_HEADROOM_OPS, createSessionManager, type SessionManager, type SessionManagerDeps } from "./session.ts";
import { bindSessionEnder, registerSessionOp } from "./session-dispatch.ts";
import type { PhoneChannel } from "./types.ts";

let relay: TestRelay | null = null;
let link: RelayLink | null = null;
let helper: FakeKeyHelper | null = null;
let manager: SessionManager | null = null;
const phones: TestPhone[] = [];
const unregister: Array<() => void> = [];

afterEach(() => {
  for (const u of unregister.splice(0)) u();
  for (const p of phones.splice(0)) p.close();
  manager?.stop();
  manager = null;
  link?.closeAll();
  link = null;
  helper?.close();
  helper = null;
  relay?.stop();
  relay = null;
  bindSessionEnder(null);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
}

interface Rig {
  manager: SessionManager;
  phone: TestPhone;
  deviceId: string;
  linkSecret: Uint8Array;
  corePub: Uint8Array;
  audit: Array<{ action: string; fields: Record<string, unknown> }>;
  setTrusted(v: boolean): void;
  ended: string[];
  connect(over?: { bindingSecret?: Uint8Array }): Promise<Record<string, unknown>>;
  newPhone(): TestPhone;
  link: RelayLink;
}

async function rig(opts: { level?: RemoteLevel; deps?: Partial<SessionManagerDeps>; limiterRate?: number } = {}): Promise<Rig> {
  relay = startTestRelay({ limits: { framesPerSecond: 10_000 } });
  helper = new FakeKeyHelper();
  const phone = new TestPhone({ relayUrl: relay.url, timeoutMs: 4000 });
  phones.push(phone);
  const deviceId = toHex(randomBytes(16));
  const linkSecret = randomBytes(32);
  let trusted = true;
  const row = (): RemoteDeviceRow => ({
    id: deviceId, name: "Ana's iPhone", platform: "ios", appVersion: "1", sessionPub: phone.sessionPub, approvePub: phone.approvePub, pushPub: phone.pushPub, linkSecret,
    level: opts.level ?? "respond", status: "active", enrolledAt: 1, lastSeenAt: null, pushRef: null, pushSendKey: null, pushDead: false, sig: new Uint8Array(64),
  });
  const audit: Array<{ action: string; fields: Record<string, unknown> }> = [];
  const ended: string[] = [];
  manager = createSessionManager({
    link: {
      send: (n, m, t, p, o) => link!.send(n, m, t, p, o),
      queuedBytes: (n) => link!.queuedBytes(n),
    },
    helper: () => helper!,
    registry: { trustedDevice: async (id) => (trusted && id === deviceId ? row() : null) },
    audit: {
      event: async (action, fields) => (audit.push({ action, fields: (fields ?? {}) as Record<string, unknown> }), { seq: audit.length, hash: "" }),
      refusal: async (_d, code) => (audit.push({ action: "refusal", fields: { resultCode: code } }), true),
      head: async () => ({ seq: 7, hash: "ab".repeat(32) }),
    },
    limiter: new RateLimiter(),
    decisions: { endSession: (id) => void ended.push(id) },
    macName: async () => "Test Mac",
    routes: (level) => [{ method: "GET", route: "/tasks", policy: { level: "observe", stepUp: "none", rate: "normal", since: 1 } }, ...(level === "observe" ? [] : [{ method: "POST" as const, route: "/runs/:id/cancel", policy: { level: "respond" as const, stepUp: "none" as const, rate: "stop" as const, since: 1 as const } }])],
    ...opts.deps,
  });
  link = new RelayLink({
    url: relay.url,
    backoff: { baseMs: 20, maxMs: 100 },
    handlers: {
      onDeliver: (n, d) => manager!.onFrame(n, d),
      onPeer: (n, _m, present) => manager!.setPeer(n, present),
      isStaleTag: (n, t) => manager!.isStaleTag(n, t),
    },
  });
  link.open({ name: deviceId, keys: (t) => [mailboxKey(linkSecret, utcDate(t)), mailboxKey(linkSecret, utcDate(t - 86_400_000))] });
  await until(() => link!.state(deviceId) === "up");
  const corePub = (await helper.status()).corePub;
  return {
    manager: manager!, phone, deviceId, linkSecret, corePub, audit, ended, link: link!,
    setTrusted: (v) => void (trusted = v),
    connect: (over = {}) => phone.connect({ corePub, deviceId, linkSecret, ...over }),
    newPhone: () => {
      const p = new TestPhone({ relayUrl: relay!.url, timeoutMs: 4000 });
      phones.push(p);
      return p;
    },
  };
}

describe("a session opens", () => {
  test("handshake, binding, then a hello with the device's level, the routes it may call, the audit head, the clock and the Mac's name", async () => {
    const r = await rig({ level: "operate" });
    const t0 = Date.now();
    const hello = await r.connect();
    expect(hello).toMatchObject({ protocolVersion: 1, minProtocolVersion: 1, deviceId: r.deviceId, level: "operate", macName: "Test Mac", auditHead: { seq: 7, hash: "ab".repeat(32) } });
    expect(Math.abs((hello.clock as number) - t0)).toBeLessThan(5000);
    expect((hello.routes as Array<{ route: string }>).map((x) => x.route).sort()).toEqual(["/runs/:id/cancel", "/tasks"]);
    expect(r.audit.map((a) => a.action)).toContain("session-open");
    expect(r.manager.activeSessions()).toEqual([expect.objectContaining({ deviceId: r.deviceId, level: "operate" })]);
    expect(helper!.dhCalls).toBe(1);
  });

  test("an observe device is told only the routes it can call", async () => {
    const r = await rig({ level: "observe" });
    const hello = await r.connect();
    expect((hello.routes as Array<{ route: string }>).map((x) => x.route)).toEqual(["/tasks"]);
  });

  test("a device that is not trusted gets no answer at all (and no Diffie-Hellman is spent)", async () => {
    const r = await rig();
    r.setTrusted(false);
    await expect(r.phone.connect({ corePub: r.corePub, deviceId: r.deviceId, linkSecret: r.linkSecret })).rejects.toThrow();
    expect(helper!.dhCalls).toBe(0);
    expect(r.audit.some((a) => a.action === "refusal" && a.fields.resultCode === "untrusted-device")).toBe(true);
    expect(r.manager.activeSessions()).toEqual([]);
  });

  test("a binding signed by another key ends the session and is audited; no hello", async () => {
    const r = await rig();
    await expect(r.connect({ bindingSecret: new TestPhone({ relayUrl: relay!.url }).sessionSecret })).rejects.toThrow();
    expect(r.manager.activeSessions()).toEqual([]);
    expect(r.audit.some((a) => a.fields.resultCode === "binding-refused")).toBe(true);
    expect(r.audit.some((a) => a.action === "session-open")).toBe(false);
  });

  test("a binding that arrives after the deadline finds the session gone (the deadline is 10 s; scaled to 1 ms here)", async () => {
    const r = await rig({ deps: { limits: { bindingMs: 1 } } });
    await expect(r.connect()).rejects.toThrow();
    expect(r.manager.activeSessions()).toEqual([]);
    expect(r.audit.some((a) => a.action === "session-open")).toBe(false);
  });
});

describe("a session that ends while its binding is still being recorded", () => {
  test("no hello, no intervals, no touch and no open callback: nothing is armed on a dead session", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => void (release = res));
    let eventStarted = false;
    let opened = 0;
    let touched = 0;
    let intervals = 0;
    const r = await rig({
      deps: {
        audit: {
          event: async () => {
            eventStarted = true;
            await gate;
            return { seq: 1, hash: "" };
          },
          refusal: async () => true,
          head: async () => ({ seq: 7, hash: "ab".repeat(32) }),
        },
        onOpen: () => void opened++,
        touch: async () => void touched++,
        setInterval: (fn: () => void, ms: number) => (intervals++, setInterval(fn, ms)),
      },
    });
    const outcome = r.connect().then(() => "hello", () => "closed");
    await until(() => eventStarted);
    r.manager.endDeviceSessions(r.deviceId, "revoked"); // the session ends while audit.event is pending
    release();
    await sleep(100);
    expect(r.manager.activeSessions()).toEqual([]);
    expect(intervals).toBe(0);
    expect(touched).toBe(0);
    expect(opened).toBe(0);
    expect(await outcome).toBe("closed");
  });
});

describe("the transport fails closed (invariants 13 and 14)", () => {
  for (const [what, tamper] of [["a flipped bit", { flipBit: true }], ["a replayed frame", { replay: true }], ["reordered frames", { reorder: true }]] as const) {
    test(`${what} ends the session`, async () => {
      const r = await rig();
      await r.connect();
      await r.phone.sendMessage("unsubscribe", { sub: "a" });
      r.phone.tamper = { ...tamper };
      void r.phone.sendMessage("unsubscribe", { sub: "b" }).catch(() => undefined);
      void r.phone.sendMessage("unsubscribe", { sub: "c" }).catch(() => undefined);
      await until(() => r.manager.activeSessions().length === 0);
      expect(r.audit.some((a) => a.action === "session-close")).toBe(true);
      expect(r.ended).toHaveLength(1);
    });
  }

  test("a frame over 64 KB ends the session before it is decrypted", async () => {
    const r = await rig();
    await r.connect();
    const d = { mailbox: new Uint8Array(16), tag: new Uint8Array(8), payload: new Uint8Array(70_000), seq: 1n };
    // The relay would refuse such a frame; delivered straight to the manager it ends the live session.
    await r.manager.onFrame(r.deviceId, d);
    expect(r.manager.activeSessions()).toEqual([]);
    expect(r.audit.some((a) => a.action === "session-close" && a.fields.resultCode === "oversize-frame")).toBe(true);
  });

  test("a frame of an ended session is dropped without being decrypted", async () => {
    const r = await rig();
    await r.connect();
    const tag = r.phone["tag" as keyof TestPhone] as unknown as Uint8Array;
    r.manager.endDeviceSessions(r.deviceId, "test");
    expect(r.manager.isStaleTag(r.deviceId, tag)).toBe(true);
    expect(r.manager.isStaleTag(r.deviceId, new Uint8Array(8))).toBe(false);
  });

  test("a new handshake from the same device replaces its session, and the old one is closed", async () => {
    const r = await rig();
    await r.connect();
    const first = r.manager.channelFor(r.deviceId)!;
    let closedReason = "";
    first.onClose((reason) => void (closedReason = reason));
    // The same device (same keys) connects again: a fresh handshake on a fresh tag.
    await r.phone.connect({ corePub: r.corePub, deviceId: r.deviceId, linkSecret: r.linkSecret });
    expect(closedReason).toBe("replaced");
    expect(r.manager.activeSessions()).toHaveLength(1);
    expect(r.ended.length).toBeGreaterThanOrEqual(1);
  });

  test("handshakes pass the six-a-minute bucket: the seventh is refused", async () => {
    const r = await rig();
    for (let i = 0; i < 6; i++) await r.phone.connect({ corePub: r.corePub, deviceId: r.deviceId, linkSecret: r.linkSecret });
    await expect(r.phone.connect({ corePub: r.corePub, deviceId: r.deviceId, linkSecret: r.linkSecret })).rejects.toThrow();
    expect(r.audit.some((a) => a.fields.resultCode === "handshake-rate")).toBe(true);
  });
});

describe("dispatch", () => {
  test("a registered op receives the strictly parsed body and the channel", async () => {
    const r = await rig();
    const seen: Array<{ ch: PhoneChannel; body: unknown }> = [];
    unregister.push(registerSessionOp("subscribe-global", async (ch, body) => void seen.push({ ch, body })));
    await r.connect();
    await r.phone.subscribeGlobal("g1");
    await until(() => seen.length === 1);
    expect(seen[0]!.body).toEqual({ sub: "g1" });
    expect(seen[0]!.ch.principal).toMatchObject({ deviceId: r.deviceId, level: "respond", deviceName: "Ana's iPhone" });
  });

  test("an op nobody registered is answered with an error, and the session lives on", async () => {
    const r = await rig();
    await r.connect();
    await r.phone.subscribeGlobal("g1");
    const err = await r.phone.next<{ code: string }>("error");
    expect(err.code).toBe("unsupported");
    expect(r.manager.activeSessions()).toHaveLength(1);
  });

  test("a message that fails its schema is refused with an error and never reaches a handler", async () => {
    const r = await rig();
    let called = 0;
    unregister.push(registerSessionOp("subscribe-global", async () => void called++));
    await r.connect();
    await r.phone.sendRaw("subscribe-global", { sub: "g1", extra: 1 });
    const err = await r.phone.next<{ code: string }>("error");
    expect(err.code).toBe("bad-message");
    expect(called).toBe(0);
    expect(r.manager.activeSessions()).toHaveLength(1);
  });

  test("a phone sending a core-to-phone message, or `binding` twice, gets unknown-op", async () => {
    const r = await rig();
    await r.connect();
    await r.phone.sendRaw("hello", {});
    expect((await r.phone.next<{ code: string }>("error")).code).toBe("unknown-op");
    await r.phone.sendRaw("binding", { deviceId: r.deviceId, sig: "00".repeat(64) });
    expect((await r.phone.next<{ code: string }>("error")).code).toBe("unknown-op");
  });

  test("a handler that throws is an internal error to the phone, not a crash", async () => {
    const r = await rig();
    unregister.push(registerSessionOp("subscribe-global", async () => { throw new Error("secret detail"); }));
    await r.connect();
    await r.phone.subscribeGlobal("g1");
    const err = await r.phone.next<{ code: string; message: string }>("error");
    expect(err.code).toBe("internal");
    expect(err.message).not.toContain("secret");
  });
});

describe("S1/S2: a slow op does not hold the frames behind it, and a redelivered frame is not a replay", () => {
  test("S1: an op that has not finished does not delay the next frame of the same session", async () => {
    const r = await rig();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => void (release = res));
    const seen: string[] = [];
    unregister.push(registerSessionOp("subscribe-global", async (_ch, body) => {
      seen.push((body as { sub: string }).sub);
      if ((body as { sub: string }).sub === "slow") await gate;
    }));
    await r.connect();
    await r.phone.subscribeGlobal("slow");
    await until(() => seen.includes("slow"));
    // the slow op is still running; a frame behind it must be taken and handled now
    await r.phone.subscribeGlobal("fast");
    await until(() => seen.includes("fast"), 1500);
    expect(seen).toEqual(["slow", "fast"]);
    release();
  });

  test("S2: the same relay frame delivered twice is dropped, and the session lives on", async () => {
    const r = await rig();
    const seen: string[] = [];
    unregister.push(registerSessionOp("subscribe-global", async (_ch, body) => void seen.push((body as { sub: string }).sub)));
    // Capture the frames the manager is handed, then hand the first one in again with the same relay seq.
    const frames: Array<Parameters<SessionManager["onFrame"]>[1]> = [];
    const orig = r.manager.onFrame.bind(r.manager);
    r.manager.onFrame = (n, d) => (frames.push(d), orig(n, d));
    await r.connect();
    await r.phone.subscribeGlobal("a");
    await until(() => seen.includes("a"));
    const last = frames[frames.length - 1]!;
    await r.manager.onFrame(r.deviceId, last);
    await r.phone.subscribeGlobal("b");
    await until(() => seen.includes("b"));
    expect(seen).toEqual(["a", "b"]);
    expect(r.manager.activeSessions()).toHaveLength(1);
  });
});

describe("the in-flight cap", () => {
  test("an op past MAX_INFLIGHT_OPS is refused as busy and audited, never run; once the held ops finish the session takes ops again", async () => {
    const r = await rig();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => void (release = res));
    const started: string[] = [];
    unregister.push(registerSessionOp("subscribe-global", async (_ch, body) => {
      const sub = (body as { sub: string }).sub;
      started.push(sub);
      if (sub.startsWith("held")) await gate;
    }));
    await r.connect();
    for (let i = 0; i < MAX_INFLIGHT_OPS; i++) await r.phone.subscribeGlobal(`held${i}`);
    // every op up to the cap runs at once (none waits for another) ...
    await until(() => started.length === MAX_INFLIGHT_OPS);
    // The relay holds up to 64 frames until the core acknowledges them, and the core's acks are paced (45 a second): wait until every held
    // frame is acknowledged, so the next one is not answered `full` by the relay before it ever reaches the session.
    await until(() => relay!.mailboxes().every((m) => m.queuedForCore === 0));
    // ... and the one past it is refused, not queued
    await r.phone.subscribeGlobal("over");
    const err = await r.phone.next<{ code: string; id: string | null }>("error");
    expect(err).toMatchObject({ code: "busy", id: null });
    expect(started).not.toContain("over");
    expect(r.audit.filter((a) => a.action === "refusal" && a.fields.resultCode === "busy")).toHaveLength(1);
    expect(r.manager.activeSessions()).toHaveLength(1);
    release();
    await r.phone.subscribeGlobal("after");
    await until(() => started.includes("after"));
    expect(r.phone.ended).toBe(false);
    expect(r.phone.received("error")).toHaveLength(1);
  });
});

describe("R5-S2: removals past the in-flight cap", () => {
  test("with the cap full, a removal (an unsubscribe here) still runs; a non-removal is still refused busy", async () => {
    const r = await rig({ deps: { isRemoval: (type) => type === "unsubscribe" } });
    expect(REMOVAL_HEADROOM_OPS).toBeGreaterThan(0);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => void (release = res));
    const started: string[] = [];
    const removed: string[] = [];
    unregister.push(registerSessionOp("subscribe-global", async (_ch, body) => {
      const sub = (body as { sub: string }).sub;
      started.push(sub);
      if (sub.startsWith("held")) await gate;
    }));
    unregister.push(registerSessionOp("unsubscribe", async (_ch, body) => void removed.push((body as { sub: string }).sub)));
    await r.connect();
    try {
      for (let i = 0; i < MAX_INFLIGHT_OPS; i++) await r.phone.subscribeGlobal(`held${i}`);
      await until(() => started.length === MAX_INFLIGHT_OPS);
      await until(() => relay!.mailboxes().every((m) => m.queuedForCore === 0));
      await r.phone.unsubscribe("held0");
      await until(() => removed.includes("held0"));
      expect(r.phone.received("error")).toHaveLength(0);
      await until(() => relay!.mailboxes().every((m) => m.queuedForCore === 0));
      await r.phone.subscribeGlobal("over");
      expect(await r.phone.next<{ code: string }>("error")).toMatchObject({ code: "busy" });
      expect(started).not.toContain("over");
    } finally {
      release();
    }
  });
});

describe("R5-S3: an op already dispatched when its session ends", () => {
  test("an ordered op waiting behind a slow one never runs once the session has ended", async () => {
    const r = await rig();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => void (release = res));
    let resizeStarted = false;
    let resizeDone = false;
    const detached: string[] = [];
    unregister.push(registerSessionOp("terminal-resize", async () => {
      resizeStarted = true;
      await gate;
      resizeDone = true;
    }));
    unregister.push(registerSessionOp("terminal-detach", async (_ch, body) => void detached.push((body as { taskId: string }).taskId)));
    await r.connect();
    await r.phone.terminal.resize("t1", 80, 24);
    await until(() => resizeStarted);
    await r.phone.terminal.detach("t1");
    // The detach frame is decrypted and dispatched (queued behind the resize) once the relay has it acknowledged.
    await until(() => relay!.mailboxes().every((m) => m.queuedForCore === 0));
    r.manager.endDeviceSessions(r.deviceId, "revoked");
    expect(r.manager.activeSessions()).toHaveLength(0);
    release();
    await until(() => resizeDone);
    // The queued op would run in the microtasks right after the resize settles; give them every chance to.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await sleep(20);
    expect(detached).toEqual([]);
  });
});

describe("R2: a redelivered handshake frame, and ordered terminal ops", () => {
  test("R2-S1: the handshake frame delivered again after the session opened is dropped, and the session lives on", async () => {
    const r = await rig();
    const seen: string[] = [];
    unregister.push(registerSessionOp("subscribe-global", async (_ch, body) => void seen.push((body as { sub: string }).sub)));
    const frames: Array<Parameters<SessionManager["onFrame"]>[1]> = [];
    const orig = r.manager.onFrame.bind(r.manager);
    r.manager.onFrame = (n, d) => (frames.push(d), orig(n, d));
    await r.connect();
    // The first frame the manager took was the phone's handshake message; the relay hands it over again (a reconnect before the ack).
    const handshake = frames[0]!;
    await r.manager.onFrame(r.deviceId, handshake);
    expect(r.manager.activeSessions()).toHaveLength(1);
    await r.phone.subscribeGlobal("after");
    await until(() => seen.includes("after"));
    expect(seen).toEqual(["after"]);
    expect(r.phone.ended).toBe(false);
    expect(r.manager.activeSessions()).toHaveLength(1);
  });

  test("R2-S2: terminal ops of one session run one at a time, in arrival order, while other ops stay concurrent", async () => {
    const r = await rig();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => void (release = res));
    const order: string[] = [];
    unregister.push(
      registerSessionOp("terminal-resize", async (_ch, body) => {
        const b = body as { cols: number };
        order.push(`resize-${b.cols}-start`);
        if (b.cols === 100) await gate;
        order.push(`resize-${b.cols}-end`);
      }),
      registerSessionOp("terminal-detach", async () => void order.push("detach")),
      registerSessionOp("subscribe-global", async (_ch, body) => void order.push(`sub-${(body as { sub: string }).sub}`)),
    );
    await r.connect();
    await r.phone.terminal.resize("t1", 100, 30); // blocked, like an attach still awaiting its lookup
    await until(() => order.includes("resize-100-start"));
    await r.phone.terminal.detach("t1"); // arrives while the first is in flight: it must wait its turn
    await r.phone.subscribeGlobal("x"); // a different kind of op is not held
    await until(() => order.includes("sub-x"), 1500);
    expect(order).toEqual(["resize-100-start", "sub-x"]);
    release();
    await until(() => order.includes("detach"));
    expect(order).toEqual(["resize-100-start", "sub-x", "resize-100-end", "detach"]);
  });

  test("R2-S2: a listener added to a session that already ended is told at once, so what it set up is torn down", async () => {
    const r = await rig();
    await r.connect();
    const ch = r.manager.channelFor(r.deviceId)!;
    r.manager.endDeviceSessions(r.deviceId, "revoked");
    const reasons: string[] = [];
    ch.onClose((reason) => void reasons.push(reason));
    expect(reasons).toEqual(["ended"]);
  });
});

describe("sending", () => {
  test("a channel sends chunked, padded messages the phone reassembles (a 300 KB response)", async () => {
    const r = await rig();
    await r.connect();
    const ch = r.manager.channelFor(r.deviceId)!;
    ch.send("response", { id: "x1", status: 200, contentType: "text/plain", encoding: "utf8", body: "z".repeat(300_000) }, { heavy: true });
    const res = await r.phone.next<{ body: string }>("response");
    expect(res.body.length).toBe(300_000);
  });

  test("messages keep their order", async () => {
    const r = await rig();
    await r.connect();
    const ch = r.manager.channelFor(r.deviceId)!;
    for (let i = 0; i < 20; i++) ch.send("ok", { id: `m${i}` });
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push((await r.phone.next<{ id: string }>("ok")).id);
    expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`));
  });

  test("a short control message queued behind a bulk one never overtakes it (the ciphertexts are one ordered stream)", async () => {
    const r = await rig();
    await r.connect();
    const ch = r.manager.channelFor(r.deviceId)!;
    ch.send("response", { id: "big", status: 200, contentType: "text/plain", encoding: "utf8", body: "z".repeat(200_000) }, { heavy: true });
    ch.send("ok", { id: "after-big" });
    ch.send("error", { id: null, code: "x", message: "y" });
    expect((await r.phone.next<{ id: string }>("response")).id).toBe("big");
    expect((await r.phone.next<{ id: string }>("ok")).id).toBe("after-big");
    expect(r.manager.activeSessions()).toHaveLength(1);
    expect(r.phone.ended).toBe(false);
  });

  test("a message the core's own schema refuses throws (a bug, never sent)", async () => {
    const r = await rig();
    await r.connect();
    const ch = r.manager.channelFor(r.deviceId)!;
    expect(() => ch.send("response", { nope: true })).toThrow();
  });

  test("queuedBytes reflects what is waiting, and drops to zero once sent", async () => {
    const r = await rig();
    await r.connect();
    const ch = r.manager.channelFor(r.deviceId)!;
    ch.send("response", { id: "x1", status: 200, contentType: "text/plain", encoding: "utf8", body: "z".repeat(200_000) });
    expect(ch.queuedBytes()).toBeGreaterThan(0);
    await r.phone.next("response");
    await until(() => ch.queuedBytes() === 0);
  });
});

describe("rekey", () => {
  test("after the message budget both directions keep working (core → phone and phone → core)", async () => {
    const r = await rig({ deps: { limits: { rekeyMessages: 4 } } });
    const got: string[] = [];
    unregister.push(registerSessionOp("unsubscribe", async (_ch, body) => void got.push((body as { sub: string }).sub)));
    await r.connect();
    const ch = r.manager.channelFor(r.deviceId)!;
    for (let i = 0; i < 12; i++) ch.send("ok", { id: `m${i}` });
    for (let i = 0; i < 12; i++) expect((await r.phone.next<{ id: string }>("ok")).id).toBe(`m${i}`);
    await r.phone.rekey();
    for (let i = 0; i < 5; i++) await r.phone.sendMessage("unsubscribe", { sub: `u${i}` });
    await until(() => got.length === 5);
    expect(got).toEqual(["u0", "u1", "u2", "u3", "u4"]);
    expect(r.manager.activeSessions()).toHaveLength(1);
  });

  test("on the time interval too", async () => {
    const r = await rig({ deps: { limits: { rekeyMs: 60 } } });
    await r.connect();
    const ch = r.manager.channelFor(r.deviceId)!;
    // The interval sends the rekeys (no message budget is near); messages under the new keys still arrive.
    await until(() => r.phone.rekeysReceived >= 2, 3000);
    ch.send("ok", { id: "after" });
    expect((await r.phone.next<{ id: string }>("ok")).id).toBe("after");
    expect(r.manager.activeSessions()).toHaveLength(1);
  });
});

describe("lifetimes and the kill switches", () => {
  test("15 idle minutes (scaled down) end it; activity keeps it", async () => {
    // The session's clock is the test's: wall-clock gaps under load can neither end it early nor keep it alive.
    let t = Date.now();
    let ticks = 0;
    const r = await rig({ deps: { limits: { idleMs: 400 }, now: () => t, setInterval: (fn: () => void, ms: number) => setInterval(() => (ticks++, fn()), ms) } });
    const got: string[] = [];
    unregister.push(registerSessionOp("unsubscribe", async (_ch, body) => void got.push((body as { sub: string }).sub)));
    await r.connect();
    const twoTicks = async () => {
      const n = ticks;
      await until(() => ticks >= n + 2, 3000);
    };
    for (let i = 0; i < 3; i++) {
      t += 300; // under the idle limit since the last activity
      await r.phone.sendMessage("unsubscribe", { sub: `k${i}` });
      await until(() => got.includes(`k${i}`));
      await twoTicks();
    }
    // 900 ms of session time have passed, more than the idle limit, but never 400 without activity
    expect(r.manager.activeSessions()).toHaveLength(1);
    t += 500;
    await until(() => r.manager.activeSessions().length === 0, 3000);
    expect(r.audit.some((a) => a.action === "session-close" && a.fields.resultCode === "idle")).toBe(true);
  });

  test("12 hours (scaled down) is the ceiling", async () => {
    const r = await rig({ deps: { limits: { maxMs: 300, idleMs: 60_000 } } });
    await r.connect();
    await until(() => r.manager.activeSessions().length === 0, 3000);
    expect(r.audit.some((a) => a.fields.resultCode === "max-lifetime")).toBe(true);
  });

  test("endDeviceSessions closes within a second and audits session-close; the phone sees the session end", async () => {
    const r = await rig();
    await r.connect();
    const t0 = Date.now();
    r.manager.endDeviceSessions(r.deviceId, "revoked");
    expect(r.manager.activeSessions()).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1000);
    await until(() => r.audit.some((a) => a.action === "session-close" && a.fields.resultCode === "revoked"), 1000);
    expect(r.ended).toHaveLength(1);
  });

  test("endAllSessions ends every device's session", async () => {
    const r = await rig();
    await r.connect();
    r.manager.endAllSessions("remote-off");
    expect(r.manager.activeSessions()).toEqual([]);
  });

  test("closing listeners run once, with the reason, and a throwing one does not stop the others", async () => {
    const r = await rig();
    await r.connect();
    const ch = r.manager.channelFor(r.deviceId)!;
    const reasons: string[] = [];
    ch.onClose(() => { throw new Error("listener bug"); });
    ch.onClose((x) => void reasons.push(x));
    r.manager.endDeviceSessions(r.deviceId, "why");
    r.manager.endDeviceSessions(r.deviceId, "again");
    expect(reasons).toEqual(["why"]);
  });

  test("peer presence is reported to the channel", async () => {
    const r = await rig();
    await r.connect();
    const ch = r.manager.channelFor(r.deviceId)!;
    const seen: boolean[] = [];
    ch.onPeerChange((p) => void seen.push(p));
    r.manager.setPeer(r.deviceId, false);
    r.manager.setPeer(r.deviceId, true);
    expect(seen).toEqual([false, true]);
    expect(ch.peerPresent()).toBe(true);
  });
});

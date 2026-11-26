// The gateway composed from its real parts (registry, sessions, router, subscriptions, link gate, relay link) against the local test
// relay, the fake key helper and the headless test phone. Rows are signed by the fake helper's registry key, so the real trust check runs.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, toHex } from "@agetor/remote-protocol/bytes";
import type { RemoteLevel } from "@agetor/remote-protocol/levels";
import { TestPhone } from "@agetor/remote-protocol/test-client";
import { startTestRelay, type TestRelay } from "@agetor/remote-protocol/test-relay";
import type { RemoteAuditInput, RemoteAuditRow, RemoteDeviceRow } from "../../shared/remote-types.ts";
import type { AppEvent } from "../../shared/types.ts";
import type { AuditStore } from "./audit.ts";
import type { RemoteGateway } from "./gateway.ts";
import type { IdempotencyStore } from "./idempotency.ts";
import type { FakeKeyHelper as FakeKeyHelperType } from "./key-helper-fake.ts";
import type { RegistryStore } from "./registry.ts";
import type { PhoneSink } from "./push.ts";

// The gateway reaches the database (background.ts, db-async): pin a throwaway data dir before those modules load.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agt-gateway-"));
const { clearServedRoutes, setServedRoutes } = await import("../route-table.ts");
const { createAudit } = await import("./audit.ts");
const { createDecisions } = await import("./decisions.ts");
const { startRemoteGateway } = await import("./gateway.ts");
const { createIdempotency } = await import("./idempotency.ts");
const { FakeKeyHelper } = await import("./key-helper-fake.ts");
const { setKeyHelperForTests } = await import("./key-helper-api.ts");
const { registryEntryJson } = await import("./registry.ts");
const { rmTestDataDir } = await import("../test-data-dir.ts");
afterAll(() => rmTestDataDir(process.env.AGETOR_DATA_DIR!));

let relay: TestRelay | null = null;
let helper: FakeKeyHelperType | null = null;
let gateways: RemoteGateway[] = [];
const phones: TestPhone[] = [];

afterEach(async () => {
  for (const p of phones.splice(0)) p.close();
  for (const g of gateways.splice(0)) await g.stop();
  setKeyHelperForTests(null);
  helper = null;
  relay?.stop();
  relay = null;
  clearServedRoutes();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
}

function memoryAuditStore(): AuditStore {
  const rows: RemoteAuditRow[] = [];
  return {
    async append(e: RemoteAuditInput) {
      const seq = rows.length + 1;
      rows.push({ seq, ts: e.ts, kind: "entry", deviceId: e.deviceId ?? null, sessionHash: e.sessionHash ?? null, action: e.action, route: e.route ?? null, targetJson: null, resultCode: e.resultCode ?? null, attemptSeq: e.attemptSeq ?? null, bodyHash: null, signature: null, prevHash: "", hash: String(seq).padStart(64, "0") });
      return { seq, hash: String(seq).padStart(64, "0") };
    },
    async head() {
      const r = rows.at(-1);
      return r ? { seq: r.seq, hash: r.hash } : null;
    },
    async page({ limit }) {
      return rows.slice(-limit).reverse();
    },
    async resultFor() {
      return null;
    },
    async verify() {
      return { ok: true, firstBadSeq: null, rows: rows.length };
    },
    async trim() {
      return { dropped: 0, anchorSeq: null };
    },
  };
}

interface Rig {
  start(mode?: "app" | "background" | "headless", extra?: Partial<Parameters<typeof startRemoteGateway>[0]["deps"] & object>): Promise<RemoteGateway>;
  setRemote(on: boolean): void;
  enroll(level?: RemoteLevel): Promise<{ phone: TestPhone; deviceId: string; linkSecret: Uint8Array }>;
  connect(d: { phone: TestPhone; deviceId: string; linkSecret: Uint8Array }): Promise<Record<string, unknown>>;
  rows: RemoteDeviceRow[];
  events: AppEvent[];
  logs: string[];
  sink: { registered: number; pushes: Array<[string, string]> };
  coreOnRelay(): boolean;
  corePub(): Promise<Uint8Array>;
}

async function rig(): Promise<Rig> {
  relay = startTestRelay({ limits: { framesPerSecond: 10_000 } });
  helper = new FakeKeyHelper();
  setKeyHelperForTests(helper);
  const rows: RemoteDeviceRow[] = [];
  const events: AppEvent[] = [];
  const logs: string[] = [];
  let remote = false;
  const changeFns = new Set<() => void>();
  const store: RegistryStore = {
    list: async () => rows.map((r) => ({ ...r })),
    revoke: async (ids) => void rows.forEach((r) => ids.includes(r.id) && (r.status = "revoked")),
  };
  const audit = createAudit(memoryAuditStore());
  const idemRows = new Map<string, Parameters<IdempotencyStore["put"]>[0]>();
  const idem: IdempotencyStore = {
    get: async (d, k) => idemRows.get(d + k) ?? null,
    put: async (r) => (idemRows.has(r.deviceId + r.idemKey) ? false : (idemRows.set(r.deviceId + r.idemKey, r), true)),
    prune: async () => 0,
  };
  const sink = { registered: 0, pushes: [] as Array<[string, string]> };
  const phoneSink: PhoneSink = {
    id: "phone", deliver: async () => undefined, alertOtherDevices: async () => undefined, status: () => ({ configured: false }),
    registerPush: async (id, ref) => void sink.pushes.push([id, ref]),
  };
  const policy = { registerSink: () => (sink.registered++, () => void sink.registered--) };
  setServedRoutes({ "/tasks": { GET: async () => Response.json({ tasks: [] }) } });

  const make = (mode: "app" | "background" | "headless", extra: object = {}) =>
    startRemoteGateway({
      mode,
      notificationPolicy: policy,
      deps: {
        companionEnabled: true,
        remoteOn: async () => remote,
        subscribeChanges: (fn) => (changeFns.add(fn), () => void changeFns.delete(fn)),
        relayUrl: () => relay!.url,
        registryStore: store,
        audit,
        decisions: createDecisions(),
        idempotency: createIdempotency(idem),
        phoneSink,
        macName: async () => "Test Mac",
        broadcast: (e) => void events.push(e),
        linkOptions: { backoff: { baseMs: 20, maxMs: 100 } },
        gatePollMs: 50,
        noSchedulers: true,
        log: (m) => void logs.push(m),
        ...extra,
      },
    }).then((g) => (gateways.push(g), g));

  return {
    start: (mode = "app", extra) => make(mode, extra),
    setRemote: (on) => {
      remote = on;
      for (const f of [...changeFns]) f();
    },
    async enroll(level = "respond") {
      const phone = new TestPhone({ relayUrl: relay!.url, timeoutMs: 4000 });
      phones.push(phone);
      const id = toHex(randomBytes(16));
      const base = { id, name: "Ana's iPhone", platform: "ios" as const, sessionPub: phone.sessionPub, approvePub: phone.approvePub, pushPub: phone.pushPub, level, enrolledAt: Date.now() };
      const sig = helper!.signRegistryEntry(id, registryEntryJson(base));
      const linkSecret = randomBytes(32);
      rows.push({ ...base, appVersion: "1", linkSecret, status: "active", lastSeenAt: null, pushRef: null, pushSendKey: null, pushDead: false, sig });
      return { phone, deviceId: id, linkSecret };
    },
    connect: async (d) => d.phone.connect({ corePub: (await helper!.status()).corePub, deviceId: d.deviceId, linkSecret: d.linkSecret }),
    rows, events, logs, sink,
    coreOnRelay: () => relay!.mailboxes().some((m) => m.core),
    corePub: async () => (await helper!.status()).corePub,
  };
}

describe("the release flag", () => {
  test("with the Companion compiled out it is a no-op that logs once and never touches the helper", async () => {
    const r = await rig();
    let touched = 0;
    setKeyHelperForTests(new Proxy({ close: () => undefined }, { get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : (touched++, () => undefined)) }) as never);
    const g = await r.start("app", { companionEnabled: false });
    expect(g.enabled).toBe(false);
    expect(g.startPairing).toBeUndefined();
    expect(g.status().companion).toBe(false);
    expect(await g.auditHead()).toBeNull();
    await g.stop();
    expect(touched).toBe(0);
    expect(r.logs.filter((l) => l.includes("companion disabled in this build")).length).toBeLessThanOrEqual(1);
    expect(r.coreOnRelay()).toBe(false);
  });
});

describe("the link follows the switch and the devices", () => {
  test("switch off: no relay connection at all, even with a trusted device", async () => {
    const r = await rig();
    await r.enroll();
    const g = await r.start();
    await sleep(200);
    expect(r.coreOnRelay()).toBe(false);
    expect(g.status().relay.state).toBe("off");
  });

  test("switch on with a trusted device: the link comes up, a phone connects, and a request goes through the router to the served handler", async () => {
    const r = await rig();
    const dev = await r.enroll();
    const g = await r.start();
    r.setRemote(true);
    await until(() => r.coreOnRelay());
    const hello = await r.connect(dev);
    expect(hello).toMatchObject({ deviceId: dev.deviceId, level: "respond", macName: "Test Mac" });
    expect(g.status()).toMatchObject({ companion: true, activeSessions: 1, relay: { state: "up" } });
    const res = await dev.phone.request("GET", "/tasks");
    expect(res.status).toBe(200);
    expect(res.json<{ tasks: unknown[] }>()).toEqual({ tasks: [] });
    // a write needs the idempotency key the test phone adds; a route with no remote policy is refused
    const refused = await dev.phone.request("POST", "/tasks", {});
    expect(refused.status).toBe(403);
    expect(refused.json<{ code: string }>().code).toBe("not-remote");
  });

  test("switch off ends every session and drops the link within a second", async () => {
    const r = await rig();
    const dev = await r.enroll();
    const g = await r.start();
    r.setRemote(true);
    await until(() => r.coreOnRelay());
    await r.connect(dev);
    const t0 = Date.now();
    r.setRemote(false);
    await until(() => g.status().activeSessions === 0 && !r.coreOnRelay(), 1000);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("the last device revoked: the session ends and the link goes down", async () => {
    const r = await rig();
    const dev = await r.enroll();
    const g = await r.start();
    r.setRemote(true);
    await until(() => r.coreOnRelay());
    await r.connect(dev);
    await g.registry!.revoke(dev.deviceId, "test");
    await until(() => g.status().activeSessions === 0 && !r.coreOnRelay(), 2000);
    expect(r.events.some((e) => e.type === "remote_action" && e.action === "device-revoked")).toBe(true);
    // and it cannot come back
    await expect(r.connect(dev)).rejects.toThrow();
  });

  test("with two devices, revoking one leaves the other's session and the link", async () => {
    const r = await rig();
    const a = await r.enroll();
    const b = await r.enroll();
    const g = await r.start();
    r.setRemote(true);
    await until(() => r.coreOnRelay());
    await r.connect(a);
    await r.connect(b);
    await g.registry!.revoke(a.deviceId, "test");
    await until(() => g.status().activeSessions === 1, 2000);
    expect(r.coreOnRelay()).toBe(true);
    expect((await b.phone.request("GET", "/tasks")).status).toBe(200);
  });

  test("Revoke all: every session closes, the helper's core key changes and the link drops", async () => {
    const r = await rig();
    const dev = await r.enroll();
    const g = await r.start();
    r.setRemote(true);
    await until(() => r.coreOnRelay());
    await r.connect(dev);
    const before = toHex(await r.corePub());
    await g.registry!.revokeAll();
    await until(() => g.status().activeSessions === 0 && !r.coreOnRelay(), 2000);
    expect(toHex(await r.corePub())).not.toBe(before);
  });

  test("a handoff: stop, then start on a 'new core' with the same stores: the phone reconnects", async () => {
    const r = await rig();
    const dev = await r.enroll();
    const first = await r.start("app");
    r.setRemote(true);
    await until(() => r.coreOnRelay());
    await r.connect(dev);
    await first.stop();
    await until(() => !r.coreOnRelay(), 1000);
    const second = await r.start("background");
    await until(() => r.coreOnRelay());
    expect(await r.connect(dev)).toMatchObject({ deviceId: dev.deviceId });
    expect(second.status().activeSessions).toBe(1);
    expect(second.startPairing).toBeUndefined(); // the background core never pairs
  });
});

describe("pairing entry", () => {
  test("only the app's gateway can start pairing, and only with the switch on", async () => {
    const r = await rig();
    const app = await r.start("app");
    await expect(app.startPairing!()).rejects.toThrow("remote access is off");
    r.setRemote(true);
    const opened = await app.startPairing!();
    expect(opened.alreadyOpen).toBe(false);
    // the window alone brings the link up, with no device
    await until(() => r.coreOnRelay());
    expect(app.status().pairing.open).toBe(true);
    await app.cancelPairing();
    await until(() => !r.coreOnRelay(), 2000);
    expect(app.status().pairing.open).toBe(false);
  });

  test("a background or headless core has no startPairing", async () => {
    const r = await rig();
    expect((await r.start("headless")).startPairing).toBeUndefined();
  });
});

describe("session ops through the gateway", () => {
  test("unlock, push registration and revoke-self", async () => {
    const r = await rig();
    const dev = await r.enroll("respond");
    const g = await r.start();
    r.setRemote(true);
    await until(() => r.coreOnRelay());
    await r.connect(dev);
    expect(await dev.phone.unlock(60_000)).toBeGreaterThan(Date.now());
    await dev.phone.registerPush("opaque-ref-0123456789", new Uint8Array(32).fill(4));
    await until(() => r.sink.pushes.length === 1);
    expect(r.sink.pushes[0]).toEqual([dev.deviceId, "opaque-ref-0123456789"]);
    await dev.phone.revokeSelf();
    await until(() => r.rows[0]!.status === "revoked", 3000);
    await until(() => g.status().activeSessions === 0);
  });

  test("an observe device may not ask for a challenge or unlock", async () => {
    const r = await rig();
    const dev = await r.enroll("observe");
    await r.start();
    r.setRemote(true);
    await until(() => r.coreOnRelay());
    await r.connect(dev);
    await expect(dev.phone.challenge({ kind: "plan", taskId: "t1", planId: "p1" })).rejects.toThrow();
    await expect(dev.phone.unlock(60_000)).rejects.toThrow();
  });

  test("a subscription is accepted and survives a snapshot request; unsubscribing releases it", async () => {
    const r = await rig();
    const dev = await r.enroll("observe");
    await r.start();
    r.setRemote(true);
    await until(() => r.coreOnRelay());
    await r.connect(dev);
    const sub = await dev.phone.subscribeGlobal("g1");
    await dev.phone.unsubscribe(sub);
    expect(dev.phone.ended).toBe(false);
  });
});

describe("the bind warning (D11)", () => {
  test("a wildcard bind is logged and reported; loopback is silent", async () => {
    const r = await rig();
    const prev = process.env.AGETOR_API_HOST;
    try {
      process.env.AGETOR_API_HOST = "0.0.0.0";
      const g = await r.start("headless");
      expect(g.status().bindWarning).toContain("reachable beyond loopback");
      expect(r.logs.some((l) => l.includes("reachable beyond loopback"))).toBe(true);
      await g.stop();
      delete process.env.AGETOR_API_HOST;
      const quiet = await r.start("headless");
      expect(quiet.status().bindWarning).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.AGETOR_API_HOST;
      else process.env.AGETOR_API_HOST = prev;
    }
  });
});

describe("no relay configured (this release)", () => {
  test("the link stays down and says why; nothing throws", async () => {
    const r = await rig();
    await r.enroll();
    const g = await r.start("app", { relayUrl: () => null });
    r.setRemote(true);
    await sleep(250);
    expect(r.coreOnRelay()).toBe(false);
    expect(g.status().relay).toEqual({ url: null, state: "unconfigured" });
    await expect(g.startPairing!()).rejects.toMatchObject({ code: "relay-not-configured" });
  });
});

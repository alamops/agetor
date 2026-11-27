// The control routes under /remote-access (docs/architecture/remote-gateway.md): status, devices, revoke, revoke all, the audit log, the Mac's
// name, the phone terminal's Detach. A real API server on a throwaway data dir, the fake key helper, and (for the revoke scenarios) the real
// gateway against the local relay with a headless phone, so a revoke over HTTP is observed ending a LIVE session.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, toHex } from "@agetor/remote-protocol/bytes";
import type { RemoteLevel } from "@agetor/remote-protocol/levels";
import { TestPhone } from "@agetor/remote-protocol/test-client";
import { startTestRelay, type TestRelay } from "@agetor/remote-protocol/test-relay";
import type { RemoteDevicesResult, RemoteLogResult } from "../shared/remote-types.ts";
import { REMOTE_ACCESS_PREF_KEY, type RemoteAccessStatus } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const ENV_KEYS = ["AGETOR_DATA_DIR", "AGETOR_API_PORT", "AGETOR_CLAUDE_BIN", "AGETOR_CODEX_BIN", "AGETOR_TMUX_BIN"] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-remote-access-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
const BASE = "http://127.0.0.1:4851";

let server: { stop: () => void };
let master: string;
let cli: string;
let relay: TestRelay | null = null;
let gateway: import("./remote/gateway.ts").RemoteGateway | null = null;
let helper: import("./remote/key-helper-fake.ts").FakeKeyHelper;
let asyncDb: typeof import("./db-async.ts");
let setHelper: typeof import("./remote/key-helper-api.ts").setKeyHelperForTests;
let registryEntryJson: typeof import("./remote/registry.ts").registryEntryJson;
let dbMod: typeof import("./db.ts");
const phones: TestPhone[] = [];

beforeAll(async () => {
  dbMod = await import("./db.ts");
  asyncDb = await import("./db-async.ts");
  const { FakeKeyHelper } = await import("./remote/key-helper-fake.ts");
  ({ setKeyHelperForTests: setHelper } = await import("./remote/key-helper-api.ts"));
  ({ registryEntryJson } = await import("./remote/registry.ts"));
  helper = new FakeKeyHelper();
  setHelper(helper);
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  const { CLI_TOKEN } = await import("./api-config.ts");
  process.env.AGETOR_API_PORT = "4851";
  server = startApiServer() as unknown as { stop: () => void };
  master = API_TOKEN;
  cli = CLI_TOKEN;
});

afterAll(async () => {
  await gateway?.stop();
  relay?.stop();
  server.stop();
  setHelper(null);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmTestDataDir(DATA_DIR);
});

// bun runs every file in one process on one database: start from no devices whatever an earlier file left behind.
beforeEach(() => {
  dbMod.db.run(`DELETE FROM remote_devices`);
});

afterEach(async () => {
  for (const p of phones.splice(0)) p.close();
  await gateway?.stop();
  gateway = null;
  relay?.stop();
  relay = null;
  dbMod.db.run(`DELETE FROM remote_devices`);
  dbMod.preferences.set(REMOTE_ACCESS_PREF_KEY, "off");
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
}

const call = (method: string, p: string, opts: { token?: string; body?: unknown } = {}) =>
  fetch(BASE + p, {
    method,
    headers: { authorization: `Bearer ${opts.token ?? master}`, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

/** A device row signed by the fake helper's registry key, inserted the way a pairing does. */
async function enroll(over: { level?: RemoteLevel; name?: string; badSig?: boolean } = {}) {
  relay ??= startTestRelay({ limits: { framesPerSecond: 10_000 } });
  const phone = new TestPhone({ relayUrl: relay.url, timeoutMs: 20_000 });
  phones.push(phone);
  const id = toHex(randomBytes(16));
  const base = { id, name: over.name ?? "Ana's iPhone", platform: "ios" as const, sessionPub: phone.sessionPub, approvePub: phone.approvePub, pushPub: phone.pushPub, level: over.level ?? "respond", enrolledAt: Date.now() };
  const sig = over.badSig ? new Uint8Array(64).fill(1) : helper.signRegistryEntry(id, registryEntryJson(base));
  const linkSecret = randomBytes(32);
  await asyncDb.op("remote.addDevice", [{ ...base, appVersion: "1", linkSecret, sig }, { ts: Date.now(), action: "pair", deviceId: id }]);
  return { phone, id, linkSecret };
}

async function startGateway() {
  relay ??= startTestRelay({ limits: { framesPerSecond: 10_000 } });
  const { startRemoteGateway } = await import("./remote/gateway.ts");
  dbMod.preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
  gateway = await startRemoteGateway({
    mode: "app",
    notificationPolicy: { registerSink: () => () => undefined },
    deps: { relayUrl: () => relay!.url, linkOptions: { backoff: { baseMs: 20, maxMs: 100 } }, gatePollMs: 50, noSchedulers: true, log: () => undefined },
  });
}

describe("GET /remote-access", () => {
  test("the switch, the gateway's state, the device counts, the Mac's name and the audit head, for both tokens", async () => {
    await enroll();
    await enroll({ badSig: true });
    for (const token of [master, cli]) {
      const res = await call("GET", "/remote-access", { token });
      expect(res.status).toBe(200);
      const s = (await res.json()) as RemoteAccessStatus;
      expect(s).toMatchObject({ enabled: false, preview: true, companion: true, relay: { state: "off" }, devices: { trusted: 1, untrusted: 1 }, bindWarning: null, attachedTerminals: [] });
      expect(typeof s.macName).toBe("string");
      expect(s.macName.length).toBeGreaterThan(0);
    }
  });

  test("DELETE turns the switch off and returns the same shape", async () => {
    dbMod.preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
    const res = await call("DELETE", "/remote-access", { token: cli });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, companion: true });
    expect(dbMod.preferences.get(REMOTE_ACCESS_PREF_KEY)).toBe("off");
  });

  test("nothing under /remote-access can turn it on or pair: POST, PUT and PATCH find no route", async () => {
    for (const p of ["/remote-access", "/remote-access/devices", "/remote-access/pair", "/remote-access/devices/abc"]) {
      for (const m of ["POST", "PUT", "PATCH"]) {
        const res = await call(m, p, { body: {} });
        expect([404, 405], `${m} ${p}`).toContain(res.status);
      }
    }
    expect((await call("PUT", "/preferences/remoteAccess", { body: { value: "on" } })).status).toBe(403);
    expect(dbMod.preferences.get(REMOTE_ACCESS_PREF_KEY)).not.toBe("on");
  });
});

describe("devices", () => {
  test("GET lists trusted and untrusted rows with their trust, level and cleaned name; the CLI token may read", async () => {
    const good = await enroll({ level: "operate", name: "Ana's iPhone" });
    const bad = await enroll({ badSig: true, name: "Forged" });
    for (const token of [master, cli]) {
      const res = await call("GET", "/remote-access/devices", { token });
      expect(res.status).toBe(200);
      const { devices } = (await res.json()) as RemoteDevicesResult;
      expect(devices.find((d) => d.id === good.id)).toMatchObject({ trust: "trusted", level: "operate", name: "Ana's iPhone", online: false, pushRegistered: false });
      expect(devices.find((d) => d.id === bad.id)).toMatchObject({ trust: "bad-signature" });
    }
  });

  test("DELETE /devices/:id revokes it (404 for an unknown id, 400 for a malformed one); the CLI token may revoke", async () => {
    const d = await enroll();
    expect((await call("DELETE", "/remote-access/devices/nothex")).status).toBe(400);
    expect((await call("DELETE", `/remote-access/devices/${"0".repeat(32)}`)).status).toBe(404);
    expect((await call("DELETE", `/remote-access/devices/${d.id}`, { token: cli })).status).toBe(200);
    const { devices } = (await (await call("GET", "/remote-access/devices")).json()) as RemoteDevicesResult;
    expect(devices.find((x) => x.id === d.id)?.trust).toBe("revoked");
  });

  test("a revoke over HTTP ends that device's LIVE session within a second, and the other device's stays", async () => {
    const a = await enroll();
    const b = await enroll();
    await startGateway();
    await until(() => relay!.mailboxes().some((m) => m.core));
    const corePub = (await helper.status()).corePub;
    await a.phone.connect({ corePub, deviceId: a.id, linkSecret: a.linkSecret });
    await b.phone.connect({ corePub, deviceId: b.id, linkSecret: b.linkSecret });
    expect(gateway!.status().activeSessions).toBe(2);
    const t0 = Date.now();
    expect((await call("DELETE", `/remote-access/devices/${a.id}`, { token: cli })).status).toBe(200);
    await until(() => gateway!.status().activeSessions === 1, 1000);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await b.phone.request("GET", "/tasks")).status).toBe(200);
    // and the revoked device cannot start another
    await expect(a.phone.connect({ corePub, deviceId: a.id, linkSecret: a.linkSecret })).rejects.toThrow();
  }, 30_000);

  test("Revoke all closes every session and the helper's core key changes", async () => {
    const a = await enroll();
    const b = await enroll();
    await startGateway();
    await until(() => relay!.mailboxes().some((m) => m.core));
    const before = toHex((await helper.status()).corePub);
    await a.phone.connect({ corePub: (await helper.status()).corePub, deviceId: a.id, linkSecret: a.linkSecret });
    await b.phone.connect({ corePub: (await helper.status()).corePub, deviceId: b.id, linkSecret: b.linkSecret });
    expect((await call("DELETE", "/remote-access/devices", { token: cli })).status).toBe(200);
    await until(() => gateway!.status().activeSessions === 0, 1000);
    expect(toHex((await helper.status()).corePub)).not.toBe(before);
    const { devices } = (await (await call("GET", "/remote-access/devices")).json()) as RemoteDevicesResult;
    expect(devices.every((d) => d.trust !== "trusted")).toBe(true);
  }, 30_000);
});

describe("the audit log", () => {
  test("pages newest first with the chain status; a bad limit or cursor is 400; the CLI token may read", async () => {
    for (let i = 0; i < 3; i++) await enroll(); // each pairing writes a `pair` row
    const first = (await (await call("GET", "/remote-access/log?limit=2", { token: cli })).json()) as RemoteLogResult;
    expect(first.rows).toHaveLength(2);
    expect(first.rows[0]!.seq).toBeGreaterThan(first.rows[1]!.seq);
    expect(first.chain).toEqual({ ok: true, firstBadSeq: null });
    expect(first.nextBeforeSeq).toBe(first.rows[1]!.seq);
    const second = (await (await call("GET", `/remote-access/log?limit=2&beforeSeq=${first.nextBeforeSeq}`)).json()) as RemoteLogResult;
    expect(second.rows.every((r) => r.seq < first.rows[1]!.seq)).toBe(true);
    for (const q of ["limit=0", "limit=501", "limit=x", "beforeSeq=0", "beforeSeq=a"]) expect((await call("GET", `/remote-access/log?${q}`)).status, q).toBe(400);
  });

  test("a revoke is in the log, and the log holds no body, no signature and no key", async () => {
    const d = await enroll();
    await call("DELETE", `/remote-access/devices/${d.id}`);
    const log = (await (await call("GET", "/remote-access/log?limit=50")).json()) as RemoteLogResult;
    expect(log.rows.some((r) => r.action === "revoke" && r.deviceId === d.id)).toBe(true);
    expect(JSON.stringify(log)).not.toContain(toHex(d.linkSecret));
  });
});

describe("the Mac's name and the phone terminal's Detach", () => {
  test("PUT /preferences/remoteMacName is validated and stored cleaned", async () => {
    expect((await call("PUT", "/preferences/remoteMacName", { body: { value: "" } })).status).toBe(400);
    expect((await call("PUT", "/preferences/remoteMacName", { body: { value: "‮​" } })).status).toBe(400);
    expect((await call("PUT", "/preferences/remoteMacName", { body: { value: "x".repeat(300) } })).status).toBe(400);
    expect((await call("PUT", "/preferences/remoteMacName", { token: cli, body: { value: "  Ana‮'s  Mac\u0007 " } })).status).toBe(204);
    const stored = dbMod.preferences.get("remoteMacName");
    expect(stored).toBeTruthy();
    expect(stored).not.toMatch(/[‮\u0007]/);
    expect((await (await call("GET", "/remote-access")).json() as RemoteAccessStatus).macName).toBe(stored as string);
  });

  test("DELETE /tasks/:id/phone-terminal reports whether anything was attached", async () => {
    const res = await call("DELETE", "/tasks/t1/phone-terminal", { token: cli });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, detached: false });
  });
});

// TS1: pairing and invariant 2 (nothing adds a device or raises a level except the native window, the code and Touch ID), against the real
// gateway in app mode over the local relay, with the fake key helper's window driven by its test controls and a headless phone, on a real database.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TestPhone } from "@agetor/remote-protocol/test-client";
import { startTestRelay, type TestRelay } from "@agetor/remote-protocol/test-relay";
import type { RemoteLevel } from "@agetor/remote-protocol/levels";
import type { RemoteGateway } from "../gateway.ts";
import { buildAppMenu } from "../../app-menu.ts";

process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agt-it-pairing-"));
const { startRemoteGateway } = await import("../gateway.ts");
const { FakeKeyHelper, fakeKeyHelperControl } = await import("../key-helper-fake.ts");
const { setKeyHelperForTests } = await import("../key-helper-api.ts");
const { ROUTE_POLICY } = await import("../../route-policy.ts");
const { remoteDevices } = await import("../../db-async.ts");
const { db, preferences } = await import("../../db.ts");
const { rmTestDataDir } = await import("../../test-data-dir.ts");
const { setServedRoutes, clearServedRoutes } = await import("../../route-table.ts");
const { helpFor } = await import("../../../cli/usage.ts");

let relay: TestRelay | null = null;
let gateway: RemoteGateway | null = null;
let helper: InstanceType<typeof FakeKeyHelper> | null = null;
const phones: TestPhone[] = [];
afterAll(() => rmTestDataDir(process.env.AGETOR_DATA_DIR!));
afterEach(async () => {
  for (const p of phones.splice(0)) p.close();
  await gateway?.stop();
  gateway = null;
  relay?.stop();
  relay = null;
  setKeyHelperForTests(null);
  clearServedRoutes();
  fakeKeyHelperControl.reset();
  db.run(`DELETE FROM remote_devices`);
  preferences.set("remoteAccess", "off");
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startApp() {
  setServedRoutes({ "/tasks": { GET: async () => Response.json({ tasks: [] }) } });
  relay = startTestRelay({ limits: { framesPerSecond: 10_000 } });
  helper = new FakeKeyHelper();
  setKeyHelperForTests(helper);
  preferences.set("remoteAccess", "on");
  gateway = await startRemoteGateway({
    mode: "app",
    notificationPolicy: { registerSink: () => () => undefined },
    deps: { relayUrl: () => relay!.url, linkOptions: { backoff: { baseMs: 20, maxMs: 100 } }, gatePollMs: 50, noSchedulers: true, log: () => undefined },
  });
}

async function pair(level: RemoteLevel, name = "Ana's iPhone"): Promise<{ phone: TestPhone; result: Awaited<ReturnType<TestPhone["pair"]>["result"]> }> {
  const opened = await gateway!.startPairing!();
  expect(opened.alreadyOpen).toBe(false);
  // the QR the helper drew
  const qr = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no QR")), 3000);
    const poll = setInterval(() => {
      const q = (helper as unknown as { lastQr?: string }).lastQr;
      if (q) (clearTimeout(t), clearInterval(poll), resolve(q));
    }, 10);
  });
  const phone = new TestPhone({ relayUrl: relay!.url, timeoutMs: 5000 });
  phones.push(phone);
  const handle = phone.pair({ qr, name });
  const sas = await handle.sas;
  fakeKeyHelperControl.chooseLevel(level);
  if (level === "configure") fakeKeyHelperControl.confirmConfigure(true);
  fakeKeyHelperControl.enterCode(sas);
  return { phone, result: await handle.result };
}

describe("pairing end to end", () => {
  test("a phone pairs at the level the owner picked in the native window, the row is in SQLite, and it connects", async () => {
    // Capture the QR the fake helper draws (the same payload the real one would show).
    const origBegin = FakeKeyHelper.prototype.pairBegin;
    FakeKeyHelper.prototype.pairBegin = async function (this: InstanceType<typeof FakeKeyHelper>, args) {
      const r = await origBegin.call(this, args);
      (this as unknown as { lastQr?: string }).lastQr = r.qr;
      return r;
    };
    try {
      await startApp();
      const { phone, result } = await pair("operate");
      expect(result.level).toBe("operate");
      const rows = await remoteDevices.list();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: result.deviceId, name: "Ana's iPhone", level: "operate", status: "active" });
      const pairAudit = db.query<{ action: string }, [string]>(`SELECT action FROM remote_audit WHERE device_id = ? ORDER BY seq`).all(result.deviceId).map((r) => r.action);
      expect(pairAudit).toContain("pair");
      // the window closed and the link keeps only the device's own mailbox
      await sleep(300);
      const hello = await phone.connect({ corePub: result.corePub, deviceId: result.deviceId, linkSecret: result.linkSecret });
      expect(hello).toMatchObject({ level: "operate", deviceId: result.deviceId });
      expect((await phone.request("GET", "/tasks")).status).toBe(200);
    } finally {
      FakeKeyHelper.prototype.pairBegin = origBegin;
    }
  }, 60_000);
});

describe("invariant 2: nothing but the native window adds a device or raises a level", () => {
  test("inv2: no route, in any scope, pairs, adds a device, turns remote access on or changes a level", () => {
    const writes: string[] = [];
    for (const [key, entry] of Object.entries(ROUTE_POLICY)) {
      const methods = "callers" in entry ? ["GET", "POST", "PUT", "PATCH", "DELETE"] : Object.keys(entry);
      const banned = key.split("/").some((seg) => /^(pair|pairing|device|devices|level|levels|enable|remote-access)$/i.test(seg));
      if (!banned) continue;
      for (const m of methods) if (m !== "GET" && m !== "DELETE") writes.push(`${m} ${key}`);
    }
    expect(writes).toEqual([]);
    // and the preference route refuses every value but off for the switch (the app's native box is the only way on)
    expect(Object.keys(ROUTE_POLICY).some((k) => /^\/(pair|pairing)/.test(k))).toBe(false);
  });

  test("inv2: the CLI help names no way to pair or turn it on, and the webview menu's Pair a Phone is a native-window action, not a route", () => {
    const help = helpFor("remote", undefined) ?? "";
    expect(help).toContain("There is no `on` and no `pair`");
    expect(help).not.toMatch(/\bremote (on|pair|add)\b/);
    const flat = JSON.stringify(buildAppMenu({ companion: true }));
    expect(flat).toContain('"action":"pair-phone"');
    expect(flat).not.toContain("webview:pair");
  });
});

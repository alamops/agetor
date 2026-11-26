// Pairing end to end without a core: the real pairing module, the real relay link and the local test relay, the fake key helper (its window
// is driven by `fakeKeyHelperControl`) and the headless test phone.
import { afterEach, describe, expect, test } from "bun:test";
import { toHex } from "@agetor/remote-protocol/bytes";
import { TestPhone } from "@agetor/remote-protocol/test-client";
import { startTestRelay, type TestRelay } from "@agetor/remote-protocol/test-relay";
import type { RemoteDeviceInsert } from "../../shared/remote-types.ts";
import type { AppEvent } from "../../shared/types.ts";
import { KeyHelperError, type KeyHelper } from "./key-helper-api.ts";
import { FakeKeyHelper, fakeKeyHelperControl } from "./key-helper-fake.ts";
import { PairingError, createPairing, type Pairing, type PairingDeps } from "./pairing.ts";
import { RelayLink } from "./relay-link.ts";

let relay: TestRelay | null = null;
let link: RelayLink | null = null;
let helper: FakeKeyHelper | null = null;
const phones: TestPhone[] = [];

afterEach(() => {
  for (const p of phones.splice(0)) p.close();
  link?.closeAll();
  link = null;
  helper?.close();
  helper = null;
  relay?.stop();
  relay = null;
  fakeKeyHelperControl.reset();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
}

/** A helper that behaves as `h` (all methods bound to it, so its window state stays in one place) with some methods replaced. */
function wrap(h: FakeKeyHelper, overrides: Partial<KeyHelper>): KeyHelper {
  return {
    status: h.status.bind(h), dh: h.dh.bind(h), revoked: h.revoked.bind(h), revoke: h.revoke.bind(h), revokeAll: h.revokeAll.bind(h), pairBegin: h.pairBegin.bind(h),
    pairComplete: h.pairComplete.bind(h), pairCancel: h.pairCancel.bind(h), onEvent: h.onEvent.bind(h), close: h.close.bind(h), ...overrides,
  };
}

function rig(over: Partial<PairingDeps> = {}, helperOverride?: (h: FakeKeyHelper) => KeyHelper) {
  relay = startTestRelay({ limits: { framesPerSecond: 10_000 } });
  helper = new FakeKeyHelper();
  const added: Array<{ device: RemoteDeviceInsert; audit: unknown }> = [];
  const audit: Array<{ action: string; fields: Record<string, unknown> }> = [];
  const events: AppEvent[] = [];
  const notes: Array<{ deviceId: string; title: string; body: string }> = [];
  const windows: boolean[] = [];
  const alerts: string[] = [];
  const secrets: string[] = [];
  // eslint-disable-next-line prefer-const
  let pairing: Pairing;
  link = new RelayLink({
    url: relay.url,
    backoff: { baseMs: 20, maxMs: 100 },
    handlers: { onDeliver: (name, d) => (name === "pairing" ? pairing.onFrame(d) : undefined) },
  });
  const qrs: string[] = [];
  const base = helperOverride ? helperOverride(helper) : helper;
  const activeHelper = wrap(helper, {
    ...base === helper ? {} : base,
    pairBegin: async (args) => {
      const out = await base.pairBegin(args);
      qrs.push(out.qr);
      return out;
    },
  });
  pairing = createPairing({
    helper: () => activeHelper,
    link,
    audit: {
      event: async (action, fields) => (audit.push({ action, fields: (fields ?? {}) as Record<string, unknown> }), { seq: audit.length, hash: "" }),
      refusal: async (_d, code) => (audit.push({ action: "refusal", fields: { resultCode: code } }), true),
    },
    addDevice: async (device, a) => void added.push({ device, audit: a }),
    macName: async () => "Test Mac",
    relayUrl: () => relay!.url,
    enabled: () => true,
    mode: () => "app",
    onWindowChange: (open) => void windows.push(open),
    notify: (n) => void notes.push(n),
    alertOthers: async (id) => void alerts.push(id),
    broadcast: (e) => void events.push(e),
    registerSecret: (s) => void secrets.push(s),
    ...over,
  });
  return { pairing, added, audit, events, notes, windows, alerts, secrets, helper: helper!, relayUrl: relay.url, lastQr: () => qrs.at(-1) ?? null };
}

async function openPhone(timeoutMs = 5000): Promise<TestPhone> {
  const p = new TestPhone({ relayUrl: relay!.url, timeoutMs });
  phones.push(p);
  return p;
}

describe("a successful pairing", () => {
  for (const level of ["respond", "operate", "configure"] as const) {
    test(`at ${level}: the device is stored at the level the owner chose, the phone is told, the Mac is told`, async () => {
      const r = rig();
      const { expiresAt, alreadyOpen } = await r.pairing.start();
      expect(alreadyOpen).toBe(false);
      expect(expiresAt).toBeGreaterThan(Date.now());
      expect(r.pairing.isOpen()).toBe(true);
      expect(r.windows).toEqual([true]);
      expect(r.secrets.length).toBe(2); // the secret and the QR

      const phone = await openPhone();
      const qr = r.lastQr()!;
      const handle = phone.pair({ qr, name: "Ana's iPhone‮", platform: "ios", appVersion: "1.4.2" });
      const sas = await handle.sas;
      fakeKeyHelperControl.chooseLevel(level);
      if (level === "configure") fakeKeyHelperControl.confirmConfigure(true);
      fakeKeyHelperControl.enterCode(sas);
      const result = await handle.result;

      expect(result.level).toBe(level);
      expect(r.added).toHaveLength(1);
      const device = r.added[0]!.device;
      expect(device).toMatchObject({ id: result.deviceId, name: "Ana's iPhone", platform: "ios", appVersion: "1.4.2", level });
      expect(toHex(device.linkSecret)).toBe(toHex(result.linkSecret));
      expect(device.sig).toHaveLength(64);
      expect(r.notes).toEqual([{ deviceId: result.deviceId, title: "Phone paired", body: "Ana's iPhone was paired" }]);
      expect(r.events).toEqual([expect.objectContaining({ type: "remote_action", action: "device-paired", deviceName: "Ana's iPhone" })]);
      await until(() => r.alerts.length === 1);
      expect(r.alerts).toEqual([result.deviceId]);

      // the window closes, the mailbox is retired and the gate recomputes
      await until(() => !r.pairing.isOpen());
      expect(r.windows).toEqual([true, false]);
      await until(() => link!.names().length === 0, 2000);
    });
  }

  test("a second start while one is open returns the open one, and does not open another window", async () => {
    const r = rig();
    const a = await r.pairing.start();
    const b = await r.pairing.start();
    expect(b).toEqual({ expiresAt: a.expiresAt, alreadyOpen: true });
    expect(r.windows).toEqual([true]);
    await r.pairing.cancel();
  });
});

describe("what writes nothing", () => {
  test("a code typed wrong three times", async () => {
    const r = rig();
    await r.pairing.start();
    const phone = await openPhone();
    const handle = phone.pair({ qr: r.lastQr()!, name: "Ana" });
    await handle.sas;
    for (const c of ["000000", "111111", "222222"]) fakeKeyHelperControl.enterCode(c);
    await expect(handle.result).rejects.toThrow();
    expect(r.added).toHaveLength(0);
    expect(r.audit.some((a) => a.action === "refusal" && a.fields.resultCode === "wrong-code")).toBe(true);
    await until(() => !r.pairing.isOpen());
    expect(r.windows.at(-1)).toBe(false);
  });

  test("Touch ID refused", async () => {
    const r = rig();
    await r.pairing.start();
    const phone = await openPhone();
    const handle = phone.pair({ qr: r.lastQr()!, name: "Ana" });
    fakeKeyHelperControl.deny();
    fakeKeyHelperControl.enterCode(await handle.sas);
    await expect(handle.result).rejects.toThrow();
    expect(r.added).toHaveLength(0);
    expect(r.audit.some((a) => a.fields.resultCode === "auth-failed")).toBe(true);
  });

  test("the window expires before the owner finishes", async () => {
    const r = rig({ ttlMs: 400 });
    await r.pairing.start();
    expect(r.pairing.isOpen()).toBe(true);
    await until(() => !r.pairing.isOpen(), 3000);
    // The helper's own window times out at the same moment as ours: whichever is first is recorded.
    expect(r.audit.some((a) => a.action === "refusal" && ["expired", "pairing-cancelled"].includes(String(a.fields.resultCode)))).toBe(true);
    expect(r.windows).toEqual([true, false]);
    // a phone that arrives afterwards finds the mailbox gone
    const phone = await openPhone(1000);
    const handle = phone.pair({ qr: r.lastQr()!, name: "Ana" });
    await expect(handle.result).rejects.toThrow();
    expect(r.added).toHaveLength(0);
  });

  test("the owner closes the helper's window", async () => {
    const r = rig();
    await r.pairing.start();
    const phone = await openPhone();
    const handle = phone.pair({ qr: r.lastQr()!, name: "Ana" });
    await handle.sas;
    fakeKeyHelperControl.closeWindow();
    await expect(handle.result).rejects.toThrow();
    expect(r.added).toHaveLength(0);
    await until(() => !r.pairing.isOpen());
  });

  for (const which of ["session", "approve"] as const) {
    test(`a phone whose ${which} proof is signed by another key`, async () => {
      const r = rig();
      await r.pairing.start();
      const phone = await openPhone();
      const handle = phone.pair({ qr: r.lastQr()!, name: "Ana", badSignature: which });
      await expect(handle.result).rejects.toThrow();
      expect(r.added).toHaveLength(0);
      expect(r.audit.some((a) => a.fields.resultCode === "bad-phone-signature")).toBe(true);
      await until(() => !r.pairing.isOpen());
    });
  }

  test("a helper answer that does not match what was asked (another level in the entry) is refused and nothing is stored", async () => {
    const r = rig({}, (h) => wrap(h, { pairComplete: async (args) => {
      const out = await h.pairComplete(args);
      return { ...out, entry: out.entry.replace('"level":"respond"', '"level":"configure"') };
    } }));
    await r.pairing.start();
    const phone = await openPhone();
    const handle = phone.pair({ qr: r.lastQr()!, name: "Ana" });
    fakeKeyHelperControl.enterCode(await handle.sas);
    await expect(handle.result).rejects.toThrow();
    expect(r.added).toHaveLength(0);
    expect(r.audit.some((a) => a.fields.resultCode === "bad-helper-signature")).toBe(true);
  });

  test("a helper signature that does not verify with the registry key is refused", async () => {
    const r = rig({}, (h) => wrap(h, { pairComplete: async (args) => {
      const out = await h.pairComplete(args);
      const sig = out.sig.slice();
      sig[0] = sig[0]! ^ 1;
      return { ...out, sig };
    } }));
    await r.pairing.start();
    const phone = await openPhone();
    const handle = phone.pair({ qr: r.lastQr()!, name: "Ana" });
    fakeKeyHelperControl.enterCode(await handle.sas);
    await expect(handle.result).rejects.toThrow();
    expect(r.added).toHaveLength(0);
  });

  test("a database failure stores nothing, tells nobody it worked, and closes", async () => {
    const r = rig({ addDevice: async () => { throw new Error("disk full"); } });
    await r.pairing.start();
    const phone = await openPhone();
    const handle = phone.pair({ qr: r.lastQr()!, name: "Ana" });
    fakeKeyHelperControl.enterCode(await handle.sas);
    await expect(handle.result).rejects.toThrow();
    expect(r.notes).toHaveLength(0);
    expect(r.events).toHaveLength(0);
    await until(() => !r.pairing.isOpen());
  });

  test("a stranger without the pairing secret is ignored, and the real phone can still pair", async () => {
    const r = rig();
    await r.pairing.start();
    const stranger = await openPhone();
    const qr = r.lastQr()!;
    // the stranger knows the mailbox (a QR photo of the mailbox half) but not the secret
    const forged = Buffer.from(qr, "base64url").toString("utf8").replace(/"pairingSecret":"[0-9a-f]{64}"/, `"pairingSecret":"${"ab".repeat(32)}"`);
    void stranger.pair({ qr: Buffer.from(forged).toString("base64url"), name: "Evil" }).result.catch(() => undefined);
    await sleep(300);
    expect(r.pairing.isOpen()).toBe(true);
    expect(r.added).toHaveLength(0);
    const phone = await openPhone();
    const handle = phone.pair({ qr, name: "Ana" });
    fakeKeyHelperControl.enterCode(await handle.sas);
    expect((await handle.result).level).toBe("respond");
    expect(r.added).toHaveLength(1);
  });
});

describe("a redelivered frame", () => {
  test("R2: every frame the relay hands over twice (the handshake and the request) is dropped, and the pairing still completes", async () => {
    const r = rig();
    await r.pairing.start();
    const orig = r.pairing.onFrame.bind(r.pairing);
    // The relay redelivers each frame it has not seen acknowledged, e.g. after a reconnect: hand every frame over twice, back to back.
    r.pairing.onFrame = (d) => {
      void orig(d);
      return orig(d);
    };
    const phone = await openPhone();
    const handle = phone.pair({ qr: r.lastQr()!, name: "Ana" });
    fakeKeyHelperControl.enterCode(await handle.sas);
    expect((await handle.result).level).toBe("respond");
    expect(r.added).toHaveLength(1);
  });
});

describe("cancel and refusals to start", () => {
  test("cancel closes the helper's window and the link within a second, and the gate recomputes", async () => {
    const r = rig();
    await r.pairing.start();
    await until(() => link!.state("pairing") === "up");
    const t0 = Date.now();
    await r.pairing.cancel();
    expect(r.pairing.isOpen()).toBe(false);
    expect(link!.names()).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.windows).toEqual([true, false]);
    await until(() => relay!.mailboxes().every((m) => !m.core), 1000);
  });

  test("not enabled, not the app's core, and no relay are refused before the helper is touched", async () => {
    for (const [over, code] of [
      [{ enabled: () => false }, "disabled"],
      [{ mode: () => "headless" as const }, "not-app-core"],
      [{ relayUrl: () => null }, "relay-not-configured"],
    ] as const) {
      const r = rig(over);
      await expect(r.pairing.start()).rejects.toMatchObject({ code });
      expect(r.windows).toEqual([]);
      expect(r.lastQr()).toBeNull();
      relay?.stop();
    }
  });

  test("a helper that cannot open the window is reported with its code", async () => {
    const r = rig({}, (h) => wrap(h, { pairBegin: async () => { throw new KeyHelperError("no-secure-enclave", "no secure enclave"); } }));
    const err = await r.pairing.start().catch((e) => e);
    expect(err).toBeInstanceOf(PairingError);
    expect(err.code).toBe("no-secure-enclave");
    expect(r.pairing.isOpen()).toBe(false);
    expect(r.windows).toEqual([]);
  });
});

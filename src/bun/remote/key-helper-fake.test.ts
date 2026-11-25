import { afterEach, describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fromHex, toHex, utf8 } from "@agetor/remote-protocol/bytes";
import { mailboxId, pairingMailboxKey, sasCode } from "@agetor/remote-protocol/derive";
import { verifyEs256 } from "@agetor/remote-protocol/es256";
import { decodeQr } from "@agetor/remote-protocol/qr";
import { KeyHelperError, type PairCompleteArgs } from "./key-helper-api.ts";
import { FakeKeyHelper, createFakeKeyHelper, fakeKeyHelperControl } from "./key-helper-fake.ts";

const dirs: string[] = [];
const helpers: FakeKeyHelper[] = [];
afterEach(() => {
  for (const h of helpers.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  fakeKeyHelperControl.reset();
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "agt-fakekh-"));
  dirs.push(d);
  return d;
};
const make = (opts: ConstructorParameters<typeof FakeKeyHelper>[0] = {}) => {
  const h = new FakeKeyHelper(opts);
  helpers.push(h);
  return h;
};

const hash = new Uint8Array(32).map((_, i) => i + 1);
const args = (over: Partial<PairCompleteArgs> = {}): PairCompleteArgs => ({
  handshakeHash: hash, deviceId: "ab".repeat(16), name: "Ana's iPhone", platform: "ios", appVersion: "1.0",
  sessionPub: new Uint8Array(65).fill(2), approvePub: new Uint8Array(65).fill(3), pushPub: new Uint8Array(32).fill(4), enrolledAt: 1_800_000_000_000, ...over,
});
const soon = () => Date.now() + 60_000;

describe("keys", () => {
  test("status returns stable keys of the right sizes, and dh is the real X25519", async () => {
    const h = make();
    const s = await h.status();
    expect(s.corePub.length).toBe(32);
    expect(s.registryPub.length).toBe(65);
    expect(s.registryPub[0]).toBe(4);
    expect(toHex((await h.status()).corePub)).toBe(toHex(s.corePub));
    const e = x25519.utils.randomSecretKey();
    expect(toHex(await h.dh(x25519.getPublicKey(e)))).toBe(toHex(x25519.getSharedSecret(e, s.corePub)));
    expect(h.dhCalls).toBe(1);
  });

  test("dh refuses a low-order or malformed key", async () => {
    const h = make();
    await expect(h.dh(new Uint8Array(32))).rejects.toMatchObject({ code: "bad-args" });
    await expect(h.dh(new Uint8Array(5))).rejects.toBeInstanceOf(KeyHelperError);
  });

  test("keys persist in the dir and are shared by a second helper over it", async () => {
    const dir = tmp();
    const a = make({ dir });
    const b = make({ dir });
    expect(toHex((await a.status()).corePub)).toBe(toHex((await b.status()).corePub));
    expect(toHex((await a.status()).registryPub)).toBe(toHex((await b.status()).registryPub));
    expect(toHex((await make().status()).corePub)).not.toBe(toHex((await a.status()).corePub));
  });
});

describe("revocation", () => {
  test("the list is append-only and idempotent; a bad id is refused", async () => {
    const h = make();
    expect(await h.revoke("aa".repeat(16))).toEqual(["aa".repeat(16)]);
    expect(await h.revoke("aa".repeat(16))).toEqual(["aa".repeat(16)]);
    expect(await h.revoke("bb".repeat(16))).toEqual(["aa".repeat(16), "bb".repeat(16)]);
    expect(await h.revoked()).toEqual(["aa".repeat(16), "bb".repeat(16)]);
    await expect(h.revoke("nope")).rejects.toMatchObject({ code: "bad-args" });
    expect(h).not.toHaveProperty("unrevoke");
  });

  test("revoke all revokes every id it ever signed and replaces the core key", async () => {
    const h = make();
    await h.pairBegin({ relayUrl: "ws://127.0.0.1:1", macName: "Mac", expiresAt: soon() });
    fakeKeyHelperControl.enterCode(sasCode(hash));
    await h.pairComplete(args());
    const before = (await h.status()).corePub;
    const r = await h.revokeAll();
    expect(r.ids).toContain("ab".repeat(16));
    expect(toHex(r.corePub)).not.toBe(toHex(before));
    expect(toHex((await h.status()).corePub)).toBe(toHex(r.corePub));
  });
});

describe("the pairing window", () => {
  const begin = (h: FakeKeyHelper, expiresAt = soon()) => h.pairBegin({ relayUrl: "ws://127.0.0.1:9", macName: "Ana's Mac", expiresAt });

  test("begin returns the secret and a QR that names the core key, the relay and the pairing mailbox", async () => {
    const h = make();
    const r = await begin(h);
    const qr = decodeQr(r.qr);
    expect(qr.corePub).toBe(toHex((await h.status()).corePub));
    expect(qr.relayUrl).toBe("ws://127.0.0.1:9");
    expect(qr.pairingSecret).toBe(toHex(r.pairingSecret));
    expect(qr.mailbox).toBe(toHex(mailboxId(pairingMailboxKey(r.pairingSecret))));
    await expect(begin(h)).rejects.toMatchObject({ code: "busy" });
    await expect(make().pairBegin({ relayUrl: "ws://x", macName: "m", expiresAt: Date.now() - 1 })).rejects.toMatchObject({ code: "bad-args" });
    await expect(make().pairBegin({ relayUrl: "ws://x", macName: "m", expiresAt: Date.now() + 11 * 60_000 })).rejects.toMatchObject({ code: "bad-args" });
  });

  test("a right code completes at the default level and the signature verifies over the canonical entry", async () => {
    const h = make();
    await begin(h);
    fakeKeyHelperControl.enterCode(sasCode(hash));
    const r = await h.pairComplete(args());
    expect(r.level).toBe("respond");
    expect(JSON.parse(r.entry)).toEqual({
      id: "ab".repeat(16), name: "Ana's iPhone", platform: "ios", session_pub: "02".repeat(65), approve_pub: "03".repeat(65),
      push_pub: "04".repeat(32), level: "respond", enrolled_at: 1_800_000_000_000,
    });
    expect(Object.keys(JSON.parse(r.entry))).toEqual(Object.keys(JSON.parse(r.entry)).slice().sort());
    expect(verifyEs256((await h.status()).registryPub, utf8(r.entry), r.sig)).toBe(true);
    // the window is gone
    await expect(h.pairComplete(args())).rejects.toMatchObject({ code: "cancelled" });
  });

  test("operate and configure are signed into the entry; configure needs its second confirmation", async () => {
    const h = make();
    await begin(h);
    fakeKeyHelperControl.chooseLevel("operate");
    fakeKeyHelperControl.enterCode(sasCode(hash));
    expect(JSON.parse((await h.pairComplete(args())).entry).level).toBe("operate");
    await begin(h);
    fakeKeyHelperControl.chooseLevel("configure");
    fakeKeyHelperControl.confirmConfigure(true);
    fakeKeyHelperControl.enterCode(sasCode(hash));
    const r = await h.pairComplete(args({ deviceId: "cd".repeat(16) }));
    expect(r.level).toBe("configure");
    expect(JSON.parse(r.entry).level).toBe("configure");
  });

  test("Configure declined cancels the pairing", async () => {
    const h = make();
    await begin(h);
    fakeKeyHelperControl.chooseLevel("configure");
    fakeKeyHelperControl.confirmConfigure(false);
    fakeKeyHelperControl.enterCode(sasCode(hash));
    await expect(h.pairComplete(args())).rejects.toMatchObject({ code: "cancelled" });
  });

  test("three wrong codes end it with wrong-code, and nothing is signed", async () => {
    const h = make();
    await begin(h);
    for (const c of ["000000", "111111", "222222"]) fakeKeyHelperControl.enterCode(c === sasCode(hash) ? "999999" : c);
    await expect(h.pairComplete(args())).rejects.toMatchObject({ code: "wrong-code" });
    expect(await h.revokeAll().then((r) => r.ids)).not.toContain("ab".repeat(16));
  });

  test("two wrong codes then the right one still completes", async () => {
    const h = make();
    await begin(h);
    fakeKeyHelperControl.enterCode("000000");
    fakeKeyHelperControl.enterCode("111111");
    fakeKeyHelperControl.enterCode(sasCode(hash));
    expect((await h.pairComplete(args())).level).toBe("respond");
  });

  test("Touch ID denied, the window closed and expiry each fail with their own code", async () => {
    let h = make();
    await begin(h);
    fakeKeyHelperControl.enterCode(sasCode(hash));
    fakeKeyHelperControl.deny();
    await expect(h.pairComplete(args())).rejects.toMatchObject({ code: "auth-failed" });

    h = make();
    const events: string[] = [];
    h.onEvent((e) => events.push(e));
    await begin(h);
    fakeKeyHelperControl.closeWindow();
    await expect(h.pairComplete(args())).rejects.toMatchObject({ code: "cancelled" });
    expect(events).toEqual(["window-closed"]);

    h = make();
    h.onEvent((e) => events.push(e));
    await begin(h, Date.now() + 40);
    const pending = h.pairComplete(args());
    await expect(pending).rejects.toMatchObject({ code: "expired" });
    expect(events).toContain("pairing-cancelled");
    await expect(h.pairComplete(args())).rejects.toMatchObject({ code: "cancelled" });
  });

  test("pairCancel closes the window and fails the pairing in flight", async () => {
    const h = make();
    await begin(h);
    const pending = h.pairComplete(args());
    await h.pairCancel();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await begin(h); // the window can open again
  });

  test("the control file drives a helper in another process", async () => {
    const dir = tmp();
    const h = make({ dir });
    await begin(h);
    const pending = h.pairComplete(args());
    writeFileSync(path.join(dir, "pairing-control.json"), JSON.stringify({ code: sasCode(hash), level: "operate" }));
    const r = await pending;
    expect(r.level).toBe("operate");
    expect(existsSync(path.join(dir, "pairing-control.json"))).toBe(false);
  });

  test("a closed helper rejects further calls", async () => {
    const h = make();
    h.close();
    await expect(h.status()).rejects.toMatchObject({ code: "closed" });
  });

  test("createFakeKeyHelper reads AGETOR_FAKE_KEY_HELPER_DIR", async () => {
    const dir = tmp();
    process.env.AGETOR_FAKE_KEY_HELPER_DIR = dir;
    try {
      const a = createFakeKeyHelper();
      helpers.push(a);
      const b = createFakeKeyHelper();
      helpers.push(b);
      expect(toHex((await a.status()).corePub)).toBe(toHex((await b.status()).corePub));
    } finally {
      delete process.env.AGETOR_FAKE_KEY_HELPER_DIR;
    }
    expect(fromHex("00").length).toBe(1);
  });
});

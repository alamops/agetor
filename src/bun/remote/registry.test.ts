import { afterEach, describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { toHex, utf8 } from "@agetor/remote-protocol/bytes";
import { sasCode } from "@agetor/remote-protocol/derive";
import { signEs256 } from "@agetor/remote-protocol/es256";
import type { RemoteDeviceRow } from "../../shared/remote-types.ts";
import { FakeKeyHelper, fakeKeyHelperControl } from "./key-helper-fake.ts";
import { EXPIRY_MS, createRegistry, registryEntryJson, type RegistryStore } from "./registry.ts";

const helpers: FakeKeyHelper[] = [];
afterEach(() => {
  for (const h of helpers.splice(0)) h.close();
  fakeKeyHelperControl.reset();
});

function memoryStore(): RegistryStore & { rows: RemoteDeviceRow[]; revokes: Array<{ ids: string[]; reason: string }> } {
  const rows: RemoteDeviceRow[] = [];
  const revokes: Array<{ ids: string[]; reason: string }> = [];
  return {
    rows,
    revokes,
    list: async () => rows.map((r) => ({ ...r })),
    revoke: async (ids, reason) => {
      revokes.push({ ids, reason });
      for (const r of rows) if (ids.includes(r.id)) r.status = "revoked";
    },
  };
}

/** Pair a device through the fake helper's window and return the signed row the core would store. */
async function pairDevice(helper: FakeKeyHelper, n: number, level: "respond" | "operate" | "configure" = "respond", enrolledAt = 1_800_000_000_000): Promise<RemoteDeviceRow> {
  const id = n.toString(16).padStart(32, "0");
  const hash = new Uint8Array(32).fill(n);
  await helper.pairBegin({ relayUrl: "ws://127.0.0.1:9", macName: "Mac", expiresAt: Date.now() + 60_000 });
  fakeKeyHelperControl.chooseLevel(level);
  if (level === "configure") fakeKeyHelperControl.confirmConfigure(true);
  fakeKeyHelperControl.enterCode(sasCode(hash));
  const r = await helper.pairComplete({
    handshakeHash: hash, deviceId: id, name: `Phone ${n}`, platform: "ios", appVersion: "1.0",
    sessionPub: p256.getPublicKey(p256.utils.randomSecretKey(), false), approvePub: p256.getPublicKey(p256.utils.randomSecretKey(), false),
    pushPub: x25519.getPublicKey(x25519.utils.randomSecretKey()), enrolledAt,
  });
  const e = JSON.parse(r.entry) as Record<string, string | number>;
  const hex = (k: string) => Uint8Array.from(String(e[k]).match(/../g)!.map((h) => parseInt(h, 16)));
  return {
    id, name: String(e.name), platform: "ios", appVersion: "1.0", sessionPub: hex("session_pub"), approvePub: hex("approve_pub"), pushPub: hex("push_pub"),
    linkSecret: new Uint8Array(32).fill(5), level: e.level as RemoteDeviceRow["level"], status: "active", enrolledAt: Number(e.enrolled_at), lastSeenAt: null,
    pushRef: null, pushSendKey: null, pushDead: false, sig: r.sig,
  };
}

function rig() {
  const helper = new FakeKeyHelper();
  helpers.push(helper);
  const store = memoryStore();
  const audited: Array<{ action: string; deviceId?: string | null }> = [];
  const notices: string[] = [];
  const registry = createRegistry({
    helper: () => helper, store, audit: { event: async (action, f) => (audited.push({ action, deviceId: f?.deviceId }), { seq: 1, hash: "" }) },
    notify: (n) => void notices.push(n.title),
  });
  return { helper, store, registry, audited, notices };
}

describe("trust", () => {
  test("a row the helper signed is trusted, at the level that was signed", async () => {
    const r = rig();
    r.store.rows.push(await pairDevice(r.helper, 1, "operate"));
    const t = await r.registry.trustedDevices();
    expect(t.trusted.map((d) => [d.id, d.level])).toEqual([["00000000000000000000000000000001", "operate"]]);
    expect(t.untrusted).toEqual([]);
    expect(await r.registry.hasTrustedDevice()).toBe(true);
    expect((await r.registry.trustedDevice(r.store.rows[0]!.id))?.name).toBe("Phone 1");
  });

  test("a row written straight into the database with a made-up signature is untrusted, and audited once", async () => {
    const r = rig();
    const real = await pairDevice(r.helper, 1);
    r.store.rows.push({ ...real, id: "ff".repeat(16), sig: new Uint8Array(64).fill(9) });
    for (let i = 0; i < 3; i++) {
      const t = await r.registry.trustedDevices();
      expect(t.trusted).toEqual([]);
      expect(t.untrusted.map((u) => u.reason)).toEqual(["bad-signature"]);
    }
    await new Promise((res) => setTimeout(res, 10));
    expect(r.audited.filter((a) => a.action === "refusal")).toHaveLength(1);
  });

  test("a signed row whose level was edited is untrusted", async () => {
    const r = rig();
    const row = await pairDevice(r.helper, 1, "respond");
    r.store.rows.push({ ...row, level: "configure" });
    expect((await r.registry.trustedDevices()).untrusted[0]?.reason).toBe("bad-signature");
  });

  test("a signed row with any other field edited (name, keys, enrolment time) is untrusted", async () => {
    const r = rig();
    const row = await pairDevice(r.helper, 1);
    for (const edit of [{ name: "Evil" }, { enrolledAt: row.enrolledAt + 1 }, { approvePub: new Uint8Array(65).fill(4) }, { pushPub: new Uint8Array(32).fill(4) }]) {
      r.store.rows.splice(0, r.store.rows.length, { ...row, ...edit });
      expect((await r.registry.trustedDevices()).trusted).toEqual([]);
    }
  });

  test("an old signed row re-inserted after a revoke is untrusted: the helper's list wins", async () => {
    const r = rig();
    const row = await pairDevice(r.helper, 1);
    r.store.rows.push(row);
    await r.registry.revoke(row.id);
    r.store.rows[0] = { ...row, status: "active" }; // an agent resets the row exactly as it was signed
    const t = await r.registry.trustedDevices();
    expect(t.trusted).toEqual([]);
    expect(t.untrusted[0]?.reason).toBe("revoked");
  });

  test("the status column alone untrusts a row; and trust is re-read every call (no cache)", async () => {
    const r = rig();
    const row = await pairDevice(r.helper, 1);
    r.store.rows.push(row);
    expect(await r.registry.hasTrustedDevice()).toBe(true);
    r.store.rows[0]!.status = "revoked";
    expect(await r.registry.hasTrustedDevice()).toBe(false);
    expect((await r.registry.trustedDevices()).untrusted[0]?.reason).toBe("status");
    await r.helper.revoke(row.id);
    r.store.rows[0]!.status = "active";
    expect((await r.registry.trustedDevices()).untrusted[0]?.reason).toBe("revoked");
  });

  test("a device signed by another registry key is untrusted (a replaced helper)", async () => {
    const r = rig();
    const other = new FakeKeyHelper();
    helpers.push(other);
    r.store.rows.push(await pairDevice(other, 1));
    expect((await r.registry.trustedDevices()).untrusted[0]?.reason).toBe("bad-signature");
  });

  test("with no helper nothing is trusted: the call fails rather than guessing", async () => {
    const store = memoryStore();
    store.rows.push(await pairDevice(helpers[helpers.push(new FakeKeyHelper()) - 1]!, 1));
    const dead = new FakeKeyHelper();
    dead.close();
    const reg = createRegistry({ helper: () => dead, store });
    await expect(reg.trustedDevices()).rejects.toMatchObject({ code: "closed" });
  });
});

describe("revoking", () => {
  test("revoke: the helper's list, the row, the session end callback and a Mac notice", async () => {
    const r = rig();
    const row = await pairDevice(r.helper, 1);
    r.store.rows.push(row);
    const seen: string[] = [];
    r.registry.onRevoked((id, reason) => void seen.push(`${id}:${reason}`));
    await r.registry.revoke(row.id, "settings");
    expect(await r.helper.revoked()).toEqual([row.id]);
    expect(r.store.revokes).toEqual([{ ids: [row.id], reason: "settings" }]);
    expect(seen).toEqual([`${row.id}:settings`]);
    expect(r.notices).toEqual(["Phone revoked"]);
    expect(await r.registry.hasTrustedDevice()).toBe(false);
  });

  test("revoke still ends sessions and marks the row when the helper is unreachable, then reports the failure", async () => {
    const store = memoryStore();
    const live = new FakeKeyHelper();
    helpers.push(live);
    const row = await pairDevice(live, 1);
    store.rows.push(row);
    const seen: string[] = [];
    const broken = { ...live, revoke: async () => { throw new Error("helper down"); }, status: () => live.status(), revoked: () => live.revoked() } as unknown as FakeKeyHelper;
    const reg = createRegistry({ helper: () => broken, store });
    reg.onRevoked((id) => void seen.push(id));
    await expect(reg.revoke(row.id)).rejects.toThrow("helper down");
    expect(seen).toEqual([row.id]);
    expect(store.rows[0]!.status).toBe("revoked");
  });

  test("S7: the sessions end even when the row's own write fails, and the failure is reported", async () => {
    const r = rig();
    const row = await pairDevice(r.helper, 1);
    r.store.rows.push(row);
    r.store.revoke = async () => {
      throw new Error("database is locked");
    };
    const seen: string[] = [];
    r.registry.onRevoked((id) => void seen.push(id));
    await expect(r.registry.revoke(row.id)).rejects.toThrow("database is locked");
    expect(await r.helper.revoked()).toEqual([row.id]);
    expect(seen).toEqual([row.id]);
    expect(r.notices).toEqual(["Phone revoked"]);
  });

  test("R5-S4: when neither the helper nor the row can be written, nothing claims the phone was revoked, and both failures surface", async () => {
    const r = rig();
    const row = await pairDevice(r.helper, 1);
    r.store.rows.push(row);
    const broken = { ...r.helper, revoke: async () => { throw new Error("helper down"); }, status: () => r.helper.status(), revoked: () => r.helper.revoked() } as unknown as FakeKeyHelper;
    r.store.revoke = async () => {
      throw new Error("database is locked");
    };
    const reg = createRegistry({ helper: () => broken, store: r.store, notify: (n) => void r.notices.push(n.title) });
    const seen: string[] = [];
    reg.onRevoked((id) => void seen.push(id));
    const err = await reg.revoke(row.id).then(() => null, (e: unknown) => e);
    expect(String(err)).toContain("helper down");
    expect(String(err)).toContain("database is locked");
    // The phone is still trusted (the helper's list lacks it and the row is active), so no session ends and no notice says otherwise.
    expect(seen).toEqual([]);
    expect(r.notices).toEqual([]);
    expect((await reg.trustedDevices()).trusted.map((x) => x.id)).toEqual([row.id]);
  });

  test("R5: revoke all audits itself even when the rows cannot be written (the helper has already replaced the core key)", async () => {
    const r = rig();
    for (const n of [1, 2]) r.store.rows.push(await pairDevice(r.helper, n));
    r.store.revoke = async () => {
      throw new Error("database is locked");
    };
    await expect(r.registry.revokeAll()).rejects.toThrow("database is locked");
    expect(r.audited.map((a) => a.action)).toContain("revoke-all");
  });

  test("R2: the sessions end even when the store cannot be read for the notice's name, and the revoke still lands", async () => {
    const r = rig();
    const row = await pairDevice(r.helper, 1);
    r.store.rows.push(row);
    const list = r.store.list;
    let reads = 0;
    r.store.list = async () => {
      if (++reads === 1) throw new Error("database is locked");
      return list();
    };
    const seen: string[] = [];
    r.registry.onRevoked((id) => void seen.push(id));
    await r.registry.revoke(row.id);
    expect(await r.helper.revoked()).toEqual([row.id]);
    expect(seen).toEqual([row.id]);
    expect(r.store.revokes).toHaveLength(1);
    expect(r.notices).toEqual(["Phone revoked"]);
  });

  test("a listener that throws does not stop the others or the revoke", async () => {
    const r = rig();
    const row = await pairDevice(r.helper, 1);
    r.store.rows.push(row);
    const seen: string[] = [];
    r.registry.onRevoked(() => { throw new Error("boom"); });
    r.registry.onRevoked((id) => void seen.push(id));
    await r.registry.revoke(row.id);
    expect(seen).toEqual([row.id]);
  });

  test("revoke all revokes every active device, replaces the core key, ends every session and reports the new key", async () => {
    const r = rig();
    for (const n of [1, 2, 3]) r.store.rows.push(await pairDevice(r.helper, n));
    const before = toHex((await r.helper.status()).corePub);
    const ended: string[] = [];
    let keyChanged = 0;
    r.registry.onRevoked((id) => void ended.push(id));
    r.registry.onKeyReplaced(() => void keyChanged++);
    const newPub = await r.registry.revokeAll();
    expect(toHex(newPub)).not.toBe(before);
    expect(toHex((await r.helper.status()).corePub)).toBe(toHex(newPub));
    expect(ended.sort()).toEqual(r.store.rows.map((x) => x.id).sort());
    expect(keyChanged).toBe(1);
    expect((await r.registry.trustedDevices()).trusted).toEqual([]);
    expect(r.audited.map((a) => a.action)).toContain("revoke-all");
  });

  test("S7: revoke all still ends every session, runs the key-replaced listeners and posts its notice when the rows cannot be written", async () => {
    const r = rig();
    for (const n of [1, 2]) r.store.rows.push(await pairDevice(r.helper, n));
    r.store.revoke = async () => {
      throw new Error("database is locked");
    };
    const ended: string[] = [];
    let keyChanged = 0;
    r.registry.onRevoked((id) => void ended.push(id));
    r.registry.onKeyReplaced(() => void keyChanged++);
    await expect(r.registry.revokeAll()).rejects.toThrow("database is locked");
    expect(ended.sort()).toEqual(r.store.rows.map((x) => x.id).sort());
    expect(keyChanged).toBe(1);
    expect(r.notices).toEqual(["All phones revoked"]);
    // trust follows the helper, which already revoked them: nothing is trusted even though the rows still say active
    expect(r.store.rows.every((x) => x.status === "active")).toBe(true);
    expect((await r.registry.trustedDevices()).trusted).toEqual([]);
  });

  test("expiry revokes devices unused for 60 days through the same path, and leaves the rest", async () => {
    const r = rig();
    const old = await pairDevice(r.helper, 1, "respond", 1_000);
    const fresh = await pairDevice(r.helper, 2, "respond", 1_000);
    old.lastSeenAt = 5_000;
    fresh.lastSeenAt = 5_000 + EXPIRY_MS;
    r.store.rows.push(old, fresh);
    const ended: string[] = [];
    r.registry.onRevoked((id, reason) => void ended.push(`${id}:${reason}`));
    const expired = await r.registry.expireStale(5_000 + EXPIRY_MS + 1);
    expect(expired).toEqual([old.id]);
    expect(ended).toEqual([`${old.id}:expired`]);
    expect((await r.registry.trustedDevices()).trusted.map((d) => d.id)).toEqual([fresh.id]);
  });

  test("a device never seen expires from its enrolment time", async () => {
    const r = rig();
    const d = await pairDevice(r.helper, 1, "respond", 1_000);
    r.store.rows.push(d);
    expect(await r.registry.expireStale(1_000 + EXPIRY_MS)).toEqual([]);
    expect(await r.registry.expireStale(1_000 + EXPIRY_MS + 1)).toEqual([d.id]);
  });
});

describe("the entry the helper signs", () => {
  test("the canonical JSON has exactly the eight fields, sorted", async () => {
    const r = rig();
    const row = await pairDevice(r.helper, 1);
    const entry = registryEntryJson(row);
    expect(Object.keys(JSON.parse(entry))).toEqual(["approve_pub", "enrolled_at", "id", "level", "name", "platform", "push_pub", "session_pub"]);
    expect(signEs256(p256.utils.randomSecretKey(), utf8(entry)).length).toBe(64);
  });
});

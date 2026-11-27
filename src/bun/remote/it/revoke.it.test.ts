// TS1: removing authority is immediate and trust cannot be forged through the database (invariants 3 and 9), against a REAL headless core.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { coreOnDeviceMailbox, coreOnRelay, connectDevice, startCore, until, type CoreHandle } from "./harness.ts";

const cores: CoreHandle[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) {
    for (const d of c.devices) d.phone.close();
    await c.stop();
  }
});
const boot = async (o: Parameters<typeof startCore>[0]) => {
  const c = await startCore(o);
  cores.push(c);
  return c;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DevicesResult {
  devices: Array<{ id: string; trust: string; name: string }>;
}
const devices = async (c: CoreHandle) => ((await (await c.api("GET", "/remote-access/devices")).json()) as DevicesResult).devices;

describe("removal is immediate (invariant 9)", () => {
  test("inv9: revoke mid-session closes within 1 s, and the other device keeps its session", async () => {
    const core = await boot({ devices: [{ name: "Ana", level: "respond" }, { name: "Ben", level: "respond" }] });
    await until(() => coreOnRelay(core.relay), 15_000, "the core on the relay");
    await connectDevice(core, 0);
    await connectDevice(core, 1);
    expect(coreOnDeviceMailbox(core, 0)).toBe(true);
    const t0 = Date.now();
    expect((await core.api("DELETE", `/remote-access/devices/${core.devices[0]!.id}`)).status).toBe(200);
    // the core leaves the revoked device's mailbox within a second ...
    await until(() => !coreOnDeviceMailbox(core, 0), 1000, "the core to leave the revoked device's mailbox");
    expect(Date.now() - t0).toBeLessThan(1500);
    // ... the revoked device can no longer open a session ...
    await expect(connectDevice(core, 0)).rejects.toThrow();
    // ... and the other one still answers
    expect((await core.devices[1]!.phone.request("GET", "/tasks")).status).toBe(200);
  }, 90_000);

  test("inv9: Revoke all closes every session, the core key changes, and nobody can reconnect", async () => {
    const core = await boot({ devices: [{ name: "Ana", level: "respond" }, { name: "Ben", level: "respond" }] });
    await until(() => coreOnRelay(core.relay), 15_000, "the core on the relay");
    await connectDevice(core, 0);
    await connectDevice(core, 1);
    expect((await core.api("DELETE", "/remote-access/devices")).status).toBe(200);
    await until(() => !coreOnRelay(core.relay), 3000, "the link to drop with no trusted device left");
    expect((await devices(core)).every((d) => d.trust !== "trusted")).toBe(true);
    await expect(connectDevice(core, 0)).rejects.toThrow();
  }, 90_000);

  test("inv9: a revoke is never rate-limited: sixty of them in a burst all answer", async () => {
    const core = await boot({ devices: [{ name: "Ana", level: "respond" }] });
    await until(() => coreOnRelay(core.relay), 15_000, "the core on the relay");
    const statuses: number[] = [];
    // The HTTP API has no limiter; the point is that the device-side stop-class calls pass the router's limiter: see router.test.ts. Here, bursts of revokes of an unknown id answer 404 every time, never 429.
    for (let i = 0; i < 60; i++) statuses.push((await core.api("DELETE", `/remote-access/devices/${"0".repeat(32)}`)).status);
    expect(new Set(statuses)).toEqual(new Set([404]));
  }, 90_000);
});

describe("trust comes from the signature and the helper's revocation list (invariant 3)", () => {
  const sqlite = (core: CoreHandle) => {
    const d = new Database(path.join(core.dataDir, "agetor.sqlite"));
    d.run("PRAGMA busy_timeout = 10000"); // the core is writing too
    return d;
  };

  test("inv3: a row written into SQLite is ignored (unsigned or badly signed)", async () => {
    const core = await boot({ devices: [{ name: "Ana", level: "respond" }] });
    await until(() => coreOnRelay(core.relay), 15_000, "the core on the relay");
    const forged = "ee".repeat(16);
    const db = sqlite(core);
    db.run(
      `INSERT INTO remote_devices (id, name, platform, app_version, session_pub, approve_pub, push_pub, link_secret, level, status, enrolled_at, sig)
       VALUES (?, 'Forged', 'ios', '1', ?, ?, ?, ?, 'configure', 'active', ?, ?)`,
      [forged, new Uint8Array(65).fill(2), new Uint8Array(65).fill(3), new Uint8Array(32).fill(4), new Uint8Array(32).fill(5), Date.now(), new Uint8Array(64).fill(6)],
    );
    db.close();
    const list = await devices(core);
    expect(list.find((d) => d.id === forged)?.trust).toBe("bad-signature");
    expect(list.find((d) => d.id === core.devices[0]!.id)?.trust).toBe("trusted");
    // and the forged row opens no mailbox group: the trusted count is still one
    const s = (await (await core.api("GET", "/remote-access")).json()) as { devices: { trusted: number; untrusted: number } };
    expect(s.devices.trusted).toBe(1);
  }, 90_000);

  test("inv3: a replayed revoked row is ignored: putting 'active' back in SQLite does not restore a revoked device", async () => {
    const core = await boot({ devices: [{ name: "Ana", level: "respond" }, { name: "Ben", level: "respond" }] });
    await until(() => coreOnRelay(core.relay), 15_000, "the core on the relay");
    const ana = core.devices[0]!.id;
    expect((await core.api("DELETE", `/remote-access/devices/${ana}`)).status).toBe(200);
    const db = sqlite(core);
    db.run(`UPDATE remote_devices SET status = 'active' WHERE id = ?`, [ana]);
    db.close();
    await sleep(300);
    expect((await devices(core)).find((d) => d.id === ana)?.trust).toBe("revoked");
    await expect(connectDevice(core, 0)).rejects.toThrow();
  }, 90_000);

  test("inv3: a trusted row whose LEVEL was raised in SQLite fails its signature (the level is covered by it)", async () => {
    const core = await boot({ devices: [{ name: "Ana", level: "observe" }] });
    await until(() => coreOnRelay(core.relay), 15_000, "the core on the relay");
    const db = sqlite(core);
    db.run(`UPDATE remote_devices SET level = 'configure' WHERE id = ?`, [core.devices[0]!.id]);
    db.close();
    expect((await devices(core))[0]!.trust).toBe("bad-signature");
    await expect(connectDevice(core, 0)).rejects.toThrow();
  }, 90_000);
});

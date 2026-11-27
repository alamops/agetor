// TS1: the link follows the switch and the devices, against a REAL headless core (src/bun/remote/it/harness.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { coreOnRelay, connectDevice, startCore, until, type CoreHandle } from "./harness.ts";

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

describe("the link (invariant 1)", () => {
  test("inv1: link stays down with switch on and no devices", async () => {
    const core = await boot({ devices: [], remoteOn: true });
    await sleep(1500);
    expect(coreOnRelay(core.relay)).toBe(false);
    const status = (await (await core.api("GET", "/remote-access")).json()) as { enabled: boolean; relay: { state: string }; devices: { trusted: number } };
    expect(status).toMatchObject({ enabled: true, devices: { trusted: 0 } });
    expect(status.relay.state).toBe("off");
  }, 60_000);

  test("inv1: the switch off keeps the link down even with a trusted device", async () => {
    const core = await boot({ devices: [{ name: "Ana's iPhone", level: "respond" }], remoteOn: false });
    await sleep(1500);
    expect(coreOnRelay(core.relay)).toBe(false);
  }, 60_000);

  test("switch on AND a trusted device: the link comes up, the phone connects, and the board answers through the real router", async () => {
    const core = await boot({ devices: [{ name: "Ana's iPhone", level: "observe" }] });
    await until(() => coreOnRelay(core.relay), 15_000, "the core to join the relay");
    const hello = await connectDevice(core);
    expect(hello).toMatchObject({ deviceId: core.devices[0]!.id, level: "observe", protocolVersion: 1 });
    const res = await core.devices[0]!.phone.request("GET", "/tasks");
    expect(res.status).toBe(200);
    // observe cannot call a respond route
    const denied = await core.devices[0]!.phone.request("POST", "/runs/r1/cancel", {});
    expect(denied.status).toBe(403);
    expect(denied.json<{ code: string }>().code).toBe("level");
  }, 60_000);

  test("inv9: turning remote access off over HTTP ends the session and drops the link within a second", async () => {
    const core = await boot({ devices: [{ name: "Ana's iPhone", level: "respond" }] });
    await until(() => coreOnRelay(core.relay), 15_000, "the core to join the relay");
    await connectDevice(core);
    const t0 = Date.now();
    expect((await core.api("DELETE", "/remote-access")).status).toBe(200);
    await until(() => !coreOnRelay(core.relay), 1000, "the link to drop");
    expect(Date.now() - t0).toBeLessThan(1000);
    // and it stays down: nothing reconnects a switch that is off
    await sleep(800);
    expect(coreOnRelay(core.relay)).toBe(false);
  }, 60_000);
});

describe("no downgrade (invariant 14)", () => {
  test("inv14: protocol version is bound into the handshake: a phone speaking another version fails against the real core", async () => {
    const core = await boot({ devices: [{ name: "Ana's iPhone", level: "respond" }] });
    await until(() => coreOnRelay(core.relay), 15_000, "the core to join the relay");
    const d = core.devices[0]!;
    await expect(d.phone.connect({ corePub: core.corePub, deviceId: d.id, linkSecret: d.linkSecret, prologuePrefix: "agetor-remote/2" })).rejects.toThrow();
    expect((await (await core.api("GET", "/remote-access")).json() as { devices: { trusted: number } }).devices.trusted).toBe(1);
    // the right version still works afterwards: a failed handshake costs nothing but the attempt
    expect(await connectDevice(core)).toMatchObject({ protocolVersion: 1, minProtocolVersion: 1 });
  }, 60_000);

  test("inv14: a handshake with another core's identity in the prologue fails (the core id is bound too)", async () => {
    const core = await boot({ devices: [{ name: "Ana's iPhone", level: "respond" }] });
    await until(() => coreOnRelay(core.relay), 15_000, "the core to join the relay");
    const d = core.devices[0]!;
    const wrongCore = Uint8Array.from(core.corePub);
    wrongCore[0] = wrongCore[0]! ^ 0xff;
    await expect(d.phone.connect({ corePub: wrongCore, deviceId: d.id, linkSecret: d.linkSecret })).rejects.toThrow();
  }, 60_000);
});

describe("a session is not a way to add a device (invariant 2)", () => {
  test("inv2: a `pairing-request` on an open session is an unknown op, a core message type too, and no device row appears", async () => {
    const core = await boot({ devices: [{ name: "Ana's iPhone", level: "respond" }] });
    await until(() => coreOnRelay(core.relay), 15_000, "the core to join the relay");
    await connectDevice(core);
    const phone = core.devices[0]!.phone;
    await phone.sendRaw("pairing-request", { name: "Evil", platform: "ios", appVersion: "1", sessionPub: "00", approvePub: "00", pushPub: "00", sessionSig: "00", approveSig: "00" });
    expect((await phone.next<{ code: string }>("error")).code).toBe("unknown-op");
    await phone.sendRaw("hello", {});
    expect((await phone.next<{ code: string }>("error")).code).toBe("unknown-op");
    const list = (await (await core.api("GET", "/remote-access/devices")).json()) as { devices: unknown[] };
    expect(list.devices).toHaveLength(1);
  }, 60_000);
});

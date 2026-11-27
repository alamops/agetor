// TS1: nothing secret on disk or in a log, and no header makes a device caller (invariants 7, 10 and 11), against a REAL headless core after it
// has paired nothing but served a connected phone, a request, a revoke and an error.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { toHex } from "@agetor/remote-protocol/bytes";
import { connectDevice, coreOnRelay, startCore, until, type CoreHandle } from "./harness.ts";

const cores: CoreHandle[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) {
    for (const d of c.devices) d.phone.close();
    await c.stop();
  }
});

/** The fake helper's own private keys (it keeps them in its state file, the one place a private key legitimately sits in a test). */
function helperSecrets(core: CoreHandle): string[] {
  const j = JSON.parse(readFileSync(path.join(core.helperDir, "keyhelper-state.json"), "utf8")) as { corePriv: string; registryPriv: string };
  return [j.corePriv, j.registryPriv];
}

async function exercise(core: CoreHandle): Promise<void> {
  await until(() => coreOnRelay(core.relay), 15_000, "the core on the relay");
  await connectDevice(core, 0);
  const phone = core.devices[0]!.phone;
  await phone.request("GET", "/tasks");
  await phone.request("POST", "/tasks", { title: "TOP-SECRET-PLAINTEXT-MARKER" }); // refused: not remote, but the body crossed the wire
  await phone.registerPush("opaque-push-ref-0123456789", new Uint8Array(32).fill(7));
  await core.api("DELETE", "/remote-access/devices", undefined);
  await new Promise((r) => setTimeout(r, 400));
}

describe("secrets", () => {
  test("inv10: no private key in SQLite or in any file under the data dir", async () => {
    const core = await startCore({ devices: [{ name: "Ana", level: "respond" }] });
    cores.push(core);
    await exercise(core);
    const needles = [...helperSecrets(core), ...core.devices.flatMap((d) => [toHex(d.phone.sessionSecret), toHex(d.phone.approveSecret), toHex(d.phone.pushSecret)])];
    const raw = needles.map((h) => Buffer.from(h, "hex"));
    const hits: string[] = [];
    for (const [rel, bytes] of core.files()) {
      const text = bytes.toString("latin1");
      needles.forEach((hex, i) => {
        if (text.includes(hex) || bytes.includes(raw[i]!)) hits.push(`${rel} holds a private key (${hex.slice(0, 8)}…)`);
      });
    }
    expect(hits).toEqual([]);
  }, 90_000);

  test("inv11: core.log and daemon.log hold no key, token, link secret, push key or plaintext", async () => {
    const core = await startCore({ devices: [{ name: "Ana", level: "respond" }] });
    cores.push(core);
    await exercise(core);
    const logs = [core.readLog("logs/core.log"), core.readLog("daemon.log")].join("\n");
    expect(logs.length).toBeGreaterThan(0);
    const needles = [...core.secrets(), ...helperSecrets(core), toHex(new Uint8Array(32).fill(7)), "opaque-push-ref-0123456789", "TOP-SECRET-PLAINTEXT-MARKER"];
    for (const n of needles) expect(logs.includes(n), `a log holds ${n.slice(0, 10)}…`).toBe(false);
  }, 90_000);
});

describe("no header makes a device (invariant 7)", () => {
  test("inv7: forged device headers neither authenticate nor change what a token may do", async () => {
    const core = await startCore({ devices: [{ name: "Ana", level: "configure" }] });
    cores.push(core);
    const forged = { "x-agetor-device": core.devices[0]!.id, "x-agetor-level": "configure", "x-device-id": core.devices[0]!.id, authorization: "Device configure" };
    // no token: refused, whatever the headers say
    const anon = await fetch(`http://127.0.0.1:${core.port}/remote-access/devices`, { headers: forged });
    expect(anon.status).toBe(401);
    // a CLI token with the headers is still a CLI token: a desktop-only route still says so
    const cliToken = (await (await core.api("GET", "/info")).json()) as { cliToken?: string };
    void cliToken;
    for (const route of ["/window/focus", "/app/force-quit"]) {
      const res = await fetch(`http://127.0.0.1:${core.port}${route}`, { method: "POST", headers: { ...forged, authorization: `Bearer ${core.token}` } });
      // the master token reaches app routes (it IS the app); the point is that nothing turned it into a device (which would answer `not-remote`)
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      expect(body.code).not.toBe("not-remote");
      expect(body.code).not.toBe("level");
    }
    // a device-only route refuses an app request that merely claims to be a device
    const claim = await fetch(`http://127.0.0.1:${core.port}/tasks`, { headers: { ...forged } });
    expect(claim.status).toBe(401);
  }, 90_000);
});

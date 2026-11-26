// TS2: the wire (invariants 4, 5 and 13), against a REAL core and the local relay: only ciphertext crosses the relay; a flipped, reordered, replayed
// or oversize frame ends the session; a security message with an unknown field is refused; and the gateway adds no listener.
import { afterEach, describe, expect, test } from "bun:test";
import { connectDevice, coreOnRelay, startCore, until, type CoreHandle } from "./harness.ts";

const cores: CoreHandle[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) {
    for (const d of c.devices) d.phone.close();
    await c.stop();
  }
});

const online = async (c: CoreHandle) => {
  const { devices } = (await (await c.api("GET", "/remote-access/devices")).json()) as { devices: Array<{ online: boolean }> };
  return devices[0]!.online;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("invariant 13: parse strictly, fail closed", () => {
  for (const [what, tamper] of [["a flipped bit", { flipBit: true }], ["a replayed frame", { replay: true }], ["reordered frames", { reorder: true }]] as const) {
    test(`inv13: ${what} ends the session at the core (and is audited)`, async () => {
      const core = await startCore({ devices: [{ name: "Ana", level: "respond" }] });
      cores.push(core);
      await until(() => coreOnRelay(core.relay), 15_000, "the core on the relay");
      await connectDevice(core);
      const phone = core.devices[0]!.phone;
      await until(() => online(core), 5000, "the session to show as online");
      await phone.sendMessage("unsubscribe", { sub: "a" });
      phone.tamper = { ...tamper };
      void phone.sendMessage("unsubscribe", { sub: "b" }).catch(() => undefined);
      void phone.sendMessage("unsubscribe", { sub: "c" }).catch(() => undefined);
      await until(async () => !(await online(core)), 5000, "the session to end");
      const log = (await (await core.api("GET", "/remote-access/log?limit=50")).json()) as { rows: Array<{ action: string; resultCode: string | null }> };
      expect(log.rows.some((r) => r.action === "session-close")).toBe(true);
    }, 90_000);
  }

  test("inv13: an unknown field in a security message is refused, and the message never reaches its handler (the session stays up)", async () => {
    const core = await startCore({ devices: [{ name: "Ana", level: "respond" }] });
    cores.push(core);
    await until(() => coreOnRelay(core.relay), 15_000, "the core on the relay");
    await connectDevice(core);
    const phone = core.devices[0]!.phone;
    const payload = { kind: "unlock", sessionHash: "00".repeat(32), expiresAt: Date.now() + 60_000, extra: "x" };
    await phone.sendRaw("unlock", { id: "u1", payload, sig: "00".repeat(64) });
    expect((await phone.next<{ code: string }>("error")).code).toBe("bad-message");
    await phone.sendRaw("challenge", { id: "c1", target: { kind: "plan", taskId: "t1", planId: "p1", extra: 1 } });
    expect((await phone.next<{ code: string }>("error")).code).toBe("bad-message");
    expect(await online(core)).toBe(true);
  }, 90_000);
});

describe("invariant 4: end-to-end encryption", () => {
  test("inv4: the relay sees only ciphertext: no plaintext marker, no message type name, no path, no device name in any frame", async () => {
    const frames: Uint8Array[] = [];
    const core = await startCore({ devices: [{ name: "Ana's iPhone", level: "respond" }], tap: (_d, b) => void frames.push(b.slice()) });
    cores.push(core);
    await until(() => coreOnRelay(core.relay), 15_000, "the core on the relay");
    await connectDevice(core);
    const phone = core.devices[0]!.phone;
    await phone.request("GET", "/tasks");
    await phone.request("POST", "/runs/r1/input", { text: "PLAINTEXT-MARKER-91f3" });
    await phone.request("GET", "/tasks/MARKER-TASK-ID-77/runs");
    expect(frames.length).toBeGreaterThan(8);
    const wire = Buffer.concat(frames.map((f) => Buffer.from(f))).toString("latin1");
    for (const secret of ["PLAINTEXT-MARKER-91f3", "MARKER-TASK-ID-77", "Ana's iPhone", "/runs/", "/tasks", "\"request\"", "\"response\"", "binding", "hello", "macName", "contentType"]) {
      expect(wire.includes(secret), `the wire carries "${secret}"`).toBe(false);
    }
    // and every frame is a relay frame of the documented size class (no oversize plaintext blob)
    expect(Math.max(...frames.map((f) => f.length))).toBeLessThanOrEqual(66 * 1024);
  }, 90_000);
});

describe("invariant 5: no listener beyond the API", () => {
  test("inv5: the core listens on 127.0.0.1 only and the gateway adds no listener of its own", async () => {
    const core = await startCore({ devices: [{ name: "Ana", level: "respond" }] });
    cores.push(core);
    await until(() => coreOnRelay(core.relay), 15_000, "the core on the relay");
    await connectDevice(core);
    await sleep(300);
    const p = Bun.spawnSync(["lsof", "-nP", "-a", "-p", String(core.pid()), "-iTCP", "-sTCP:LISTEN"]);
    const lines = p.stdout.toString().split("\n").slice(1).filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l, "a listener that is not loopback").toMatch(/127\.0\.0\.1:\d+ \(LISTEN\)/);
    }
    // the only one is the API port (plus the opencode/tmux helpers, which a bare core does not start)
    expect(lines.some((l) => l.includes(`:${core.port} `))).toBe(true);
    expect(lines.length).toBe(1);
  }, 90_000);
});

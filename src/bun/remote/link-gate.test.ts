import { afterEach, describe, expect, test } from "bun:test";
import { LinkGate } from "./link-gate.ts";

const gates: LinkGate[] = [];
afterEach(() => void gates.splice(0).forEach((g) => g.stop()));

function rig(init = { on: false, device: false, pairing: false }) {
  const s = { ...init, fail: false };
  const gate = new LinkGate({
    remoteOn: () => (s.fail ? Promise.reject(new Error("x")) : s.on),
    hasTrustedDevice: () => s.device,
    pairingWindowOpen: () => s.pairing,
  });
  gates.push(gate);
  const flips: boolean[] = [];
  gate.onChange((up) => void flips.push(up));
  return { s, gate, flips };
}

describe("invariant 1: the link is up only with the switch on AND (a trusted device OR the pairing window)", () => {
  const cases: Array<[boolean, boolean, boolean, boolean]> = [
    // on, device, pairing -> up
    [false, false, false, false],
    [false, true, false, false],
    [false, false, true, false],
    [false, true, true, false],
    [true, false, false, false],
    [true, true, false, true],
    [true, false, true, true],
    [true, true, true, true],
  ];
  for (const [on, device, pairing, up] of cases) {
    test(`switch=${on} device=${device} pairing=${pairing} -> ${up ? "up" : "down"}`, async () => {
      const r = rig({ on, device, pairing });
      expect(await r.gate.recompute()).toBe(up);
    });
  }

  test("each input flip is emitted as one transition, only on a change", async () => {
    const r = rig();
    await r.gate.recompute();
    expect(r.flips).toEqual([]);
    r.s.on = true;
    await r.gate.recompute(); // on, but no device and no window: still down
    expect(r.flips).toEqual([]);
    r.s.pairing = true;
    await r.gate.recompute();
    r.s.pairing = false;
    r.s.device = true;
    await r.gate.recompute(); // the window closed but a device exists: stays up, no new event
    r.s.device = false;
    await r.gate.recompute(); // the last device revoked: down
    r.s.device = true;
    await r.gate.recompute();
    r.s.on = false;
    await r.gate.recompute(); // switch off wins over everything
    expect(r.flips).toEqual([true, false, true, false]);
    expect(r.gate.up()).toBe(false);
  });

  test("the safety poll notices an input that changed without a recompute, within a second", async () => {
    const r = rig({ on: true, device: true, pairing: false });
    r.gate.start(20);
    await new Promise((res) => setTimeout(res, 60));
    expect(r.gate.up()).toBe(true);
    r.s.on = false; // an agent rewrote the switch's row: nobody called recompute
    await new Promise((res) => setTimeout(res, 120));
    expect(r.gate.up()).toBe(false);
    expect(r.flips).toEqual([true, false]);
  });

  test("a provider that fails reads as off (fail closed)", async () => {
    const r = rig({ on: true, device: true, pairing: false });
    await r.gate.recompute();
    expect(r.gate.up()).toBe(true);
    r.s.fail = true;
    expect(await r.gate.recompute()).toBe(false);
  });

  test("a recompute superseded by a newer one is dropped", async () => {
    let release!: (v: boolean) => void;
    const slow = new Promise<boolean>((res) => (release = res));
    let calls = 0;
    const gate = new LinkGate({ remoteOn: () => (calls++ === 0 ? slow : true), hasTrustedDevice: () => true, pairingWindowOpen: () => false });
    gates.push(gate);
    const first = gate.recompute();
    const second = gate.recompute();
    release(false);
    await first;
    expect(await second).toBe(true);
    expect(gate.up()).toBe(true);
  });

  test("stop takes the link down and a listener that throws does not break the others", async () => {
    const r = rig({ on: true, device: true, pairing: false });
    r.gate.onChange(() => { throw new Error("boom"); });
    await r.gate.recompute();
    r.gate.stop();
    expect(r.flips).toEqual([true, false]);
  });
});

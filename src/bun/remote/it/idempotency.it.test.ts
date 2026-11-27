// TS2: idempotency of remote mutations against a REAL core, including a repeat AFTER the core was killed and restarted (the stored result lives in
// SQLite, migration 096), so a phone that lost the answer and retries never makes a second change.
import { afterEach, describe, expect, test } from "bun:test";
import { connectDevice, coreOnRelay, startCore, until, type CoreHandle } from "./harness.ts";

const cores: CoreHandle[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) {
    for (const d of c.devices) d.phone.close();
    await c.stop();
  }
});

interface Log {
  rows: Array<{ action: string; resultCode: string | null }>;
}
const replays = async (c: CoreHandle) => ((await (await c.api("GET", "/remote-access/log?limit=200")).json()) as Log).rows.filter((r) => r.action === "replayed").length;
const IDEM = "5a".repeat(16);

describe("idempotency", () => {
  test("a repeat with the same key answers the stored result; the same key with another body is a 409; a write without a key is refused", async () => {
    const core = await startCore({ devices: [{ name: "Ana", level: "respond" }] });
    cores.push(core);
    await until(() => coreOnRelay(core.relay), 15_000, "the core on the relay");
    await connectDevice(core);
    const phone = core.devices[0]!.phone;
    const first = await phone.request("POST", "/tasks/x1/seen", {}, { idem: IDEM });
    const again = await phone.request("POST", "/tasks/x1/seen", {}, { idem: IDEM });
    expect(again.status).toBe(first.status);
    expect(again.text()).toBe(first.text());
    expect(await replays(core)).toBe(1);
    const mismatch = await phone.request("POST", "/tasks/x1/pipeline/cancel", {}, { idem: IDEM });
    expect(mismatch.status).toBe(409);
    expect(mismatch.json<{ code: string }>().code).toBe("idem-mismatch");
    const none = await phone.request("POST", "/tasks/x1/seen", {}, { idem: null });
    expect(none.status).toBe(400);
    expect(none.json<{ code: string }>().code).toBe("idem-required");
  }, 90_000);

  test("a repeat after a core restart (kill -9) answers the stored result instead of running again", async () => {
    const a = await startCore({ devices: [{ name: "Ana", level: "respond" }] });
    cores.push(a);
    await until(() => coreOnRelay(a.relay), 15_000, "core A on the relay");
    await connectDevice(a);
    const key = "7c".repeat(16);
    const first = await a.devices[0]!.phone.request("POST", "/tasks/x1/seen", {}, { idem: key });
    await a.kill9();
    const b = await startCore({ reuse: { dataDir: a.dataDir, helperDir: a.helperDir, relay: a.relay, devices: a.devices, corePub: a.corePub } });
    cores.push(b);
    await until(() => coreOnRelay(b.relay), 20_000, "core B on the relay");
    await connectDevice(b);
    const before = await replays(b);
    const again = await a.devices[0]!.phone.request("POST", "/tasks/x1/seen", {}, { idem: key });
    expect(again.status).toBe(first.status);
    expect(again.text()).toBe(first.text());
    expect(await replays(b)).toBe(before + 1);
  }, 120_000);
});

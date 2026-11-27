// TS3: pushes to a phone (SC8) through the REAL notification policy, the real phone sink, a real registry/device table and a stub push gateway:
// needs-you events only, nothing within two minutes of the window's focus, only sealed bodies on the wire, a 410 marks the device dead, and the
// collapse id is stable per task.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { fromBase64, randomBytes, toHex } from "@agetor/remote-protocol/bytes";
import { SEALED_PUSH_BYTES, openPush } from "@agetor/remote-protocol/push-payload";
import type { GlobalEvent, Task } from "../../../shared/types.ts";
import type { PushBody } from "../push.ts";
import { pinDataDir } from "./inproc.ts";

const DATA = pinDataDir("push");
const { installNotificationPolicy } = await import("../../notification-policy.ts");
const { createPhoneSink } = await import("../push.ts");
const { createRegistry, registryEntryJson } = await import("../registry.ts");
const { FakeKeyHelper } = await import("../key-helper-fake.ts");
const { setKeyHelperForTests } = await import("../key-helper-api.ts");
const asyncDb = await import("../../db-async.ts");
const { db } = await import("../../db.ts");
const presence = await import("../../presence.ts");
const { rmTestDataDir } = await import("../../test-data-dir.ts");

interface Received { headers: Record<string, string>; body: PushBody; raw: string }
let gateway: ReturnType<typeof Bun.serve>;
let received: Received[] = [];
let respondWith = 200;
const pushSecret = x25519.utils.randomSecretKey();
let helper: InstanceType<typeof FakeKeyHelper>;

beforeAll(() => {
  gateway = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const raw = await req.text();
      received.push({ headers: Object.fromEntries(req.headers), body: JSON.parse(raw) as PushBody, raw });
      return new Response(null, { status: respondWith });
    },
  });
  helper = new FakeKeyHelper();
  setKeyHelperForTests(helper);
});
afterAll(async () => {
  await gateway.stop(true);
  setKeyHelperForTests(null);
  rmTestDataDir(DATA);
});
afterEach(() => {
  received = [];
  respondWith = 200;
  db.run(`DELETE FROM remote_devices`);
  presence.setNativeWindowFocus(false);
  presence.setAppAttached(true);
});

async function addDevice(name: string, withPush = true): Promise<string> {
  const id = toHex(randomBytes(16));
  const row = { id, name, platform: "ios" as const, sessionPub: new Uint8Array(65).fill(2), approvePub: new Uint8Array(65).fill(3), pushPub: x25519.getPublicKey(pushSecret), level: "respond" as const, enrolledAt: Date.now() };
  const sig = helper.signRegistryEntry(id, registryEntryJson(row));
  await asyncDb.op("remote.addDevice", [{ ...row, appVersion: "1", linkSecret: randomBytes(32), sig }, { ts: Date.now(), action: "pair", deviceId: id }]);
  if (withPush) await asyncDb.remoteDevices.setPushRef(id, `ref-${id.slice(0, 8)}-0123456789`, randomBytes(32));
  return id;
}

function rig() {
  const registry = createRegistry({ helper: () => helper });
  const sink = createPhoneSink({
    devices: async () => (await registry.trustedDevices()).trusted,
    pushUrl: () => `http://127.0.0.1:${gateway.port}`,
    markDead: async (id) => void (await asyncDb.remoteDevices.markPushDead(id)),
  });
  const rows = new Map<string, Task | null>([["t1", { id: "t1", title: "SECRET-TITLE", agent: "claude-code" } as unknown as Task], ["t2", { id: "t2", title: "Other", agent: "claude-code" } as unknown as Task]]);
  const policy = installNotificationPolicy({ subscribe: () => () => {}, loadRows: async () => rows });
  // The policy fires a sink's delivery without awaiting it, so the rig tracks each one: `flush` waits until every push has been sent and
  // answered, rather than for a fixed time a loaded machine can overrun (a late push then lands in the next test).
  const pending = new Set<Promise<void>>();
  policy.registerSink({
    ...sink,
    deliver: (d) => {
      const p = Promise.resolve(sink.deliver(d));
      pending.add(p);
      void p.catch(() => undefined).finally(() => pending.delete(p));
      return p;
    },
  });
  const interaction = (taskId: string, id: string): GlobalEvent => ({ kind: "interaction", taskId, runId: "r1", state: "pending", interactionId: id, ts: Date.now() } as GlobalEvent);
  const runStatus = (taskId: string, status: "succeeded" | "failed"): GlobalEvent => ({ kind: "run-status", taskId, runId: "r1", status, ts: Date.now() } as unknown as GlobalEvent);
  const flush = async () => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  };
  return { policy, interaction, runStatus, flush };
}

describe("pushes", () => {
  test("a needs-you event is pushed to a device with a push address, sealed; a quiet one (a success) is not", async () => {
    const id = await addDevice("Ana");
    await addDevice("No push address", false);
    const r = rig();
    await r.policy.handleEvent(r.interaction("t1", "i1"));
    await r.flush();
    expect(received).toHaveLength(1);
    expect(received[0]!.body.push_ref).toContain(id.slice(0, 8));
    expect(received[0]!.body.kind).toBe("needs-you");
    const opened = openPush(fromBase64(received[0]!.body.sealed), pushSecret);
    expect(opened).toMatchObject({ taskId: "t1", kind: "waiting", title: "Waiting on you" });
    expect(opened.subtitle).toContain("SECRET-TITLE");
    received.length = 0;
    await r.policy.handleEvent(r.runStatus("t1", "succeeded"));
    await r.flush();
    expect(received).toHaveLength(0);
    await r.policy.handleEvent(r.runStatus("t2", "failed"));
    await r.flush();
    expect(received).toHaveLength(1);
    expect(openPush(fromBase64(received[0]!.body.sealed), pushSecret).kind).toBe("failed");
  }, 30_000);

  test("nothing readable leaves the Mac: the request holds no title, no task id and no kind in the clear, and every sealed body is the same size", async () => {
    await addDevice("Ana");
    const r = rig();
    await r.policy.handleEvent(r.interaction("t1", "i1"));
    await r.policy.handleEvent(r.runStatus("t2", "failed"));
    await r.flush();
    expect(received).toHaveLength(2);
    for (const x of received) {
      const wire = x.raw + JSON.stringify(x.headers);
      for (const secret of ["SECRET-TITLE", "Waiting on you", "Task failed", "\"t1\"", "\"t2\"", "waiting", "claude-code"]) expect(wire.includes(secret), secret).toBe(false);
      expect(fromBase64(x.body.sealed).length).toBe(SEALED_PUSH_BYTES);
    }
  }, 30_000);

  test("nothing is pushed while someone is at the Mac (the window has focus, or had it within two minutes)", async () => {
    await addDevice("Ana");
    const r = rig();
    presence.setNativeWindowFocus(true);
    await r.policy.handleEvent(r.runStatus("t2", "failed"));
    await r.flush();
    expect(received).toHaveLength(0);
    presence.setNativeWindowFocus(false); // just lost focus: still within the two minutes
    await r.policy.handleEvent(r.runStatus("t2", "failed"));
    await r.flush();
    expect(received).toHaveLength(0);
    presence.setAppAttached(false); // a background core with no window is always away
    await r.policy.handleEvent(r.runStatus("t2", "failed"));
    await r.flush();
    expect(received).toHaveLength(1);
  }, 30_000);

  test("the collapse id is stable for a task and different for another, and never contains the task id", async () => {
    await addDevice("Ana");
    const r = rig();
    presence.setAppAttached(false);
    await r.policy.handleEvent(r.interaction("t1", "i1"));
    await r.policy.handleEvent(r.runStatus("t1", "failed")); // a second, different event for the same task
    await r.policy.handleEvent(r.interaction("t2", "i3"));
    await r.flush();
    const c = received.map((x) => x.body.collapse);
    expect(c).toHaveLength(3);
    expect(c[0]).toBe(c[1]!);
    expect(c[0]).not.toBe(c[2]!);
    expect(c.some((x) => x.includes("t1"))).toBe(false);
  }, 30_000);

  test("a 410 from the gateway marks the device's push dead, and it is skipped afterwards", async () => {
    const id = await addDevice("Ana");
    const r = rig();
    respondWith = 410;
    presence.setAppAttached(false);
    await r.policy.handleEvent(r.interaction("t1", "i1"));
    await r.flush();
    expect(received).toHaveLength(1);
    expect((await asyncDb.remoteDevices.get(id))?.pushDead).toBe(true);
    await r.policy.handleEvent(r.interaction("t2", "i2"));
    await r.flush();
    expect(received).toHaveLength(1);
  }, 30_000);

  test("a revoked device gets nothing", async () => {
    const id = await addDevice("Ana");
    const registry = createRegistry({ helper: () => helper });
    await registry.revoke(id, "test");
    const r = rig();
    presence.setAppAttached(false);
    await r.policy.handleEvent(r.interaction("t1", "i1"));
    await r.flush();
    expect(received).toHaveLength(0);
  }, 30_000);
});

import { afterEach, describe, expect, jest, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { fromBase64, toBase64Url, toHex } from "@agetor/remote-protocol/bytes";
import { canonicalBytes } from "@agetor/remote-protocol/canonical-json";
import { collapseId, pushRequestMac } from "@agetor/remote-protocol/derive";
import { SEALED_PUSH_BYTES, openPush } from "@agetor/remote-protocol/push-payload";
import type { RemoteDeviceRow } from "../../shared/remote-types.ts";
import type { NotificationDecision } from "../notification-policy.ts";
import { PUSH_TIMEOUT_MS, createPhoneSink, type PushBody } from "./push.ts";

interface Received {
  headers: Record<string, string>;
  body: PushBody;
  raw: string;
}

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  void server?.stop(true);
  server = null;
});

function gateway(status = 200) {
  const received: Received[] = [];
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const raw = await req.text();
      received.push({ headers: Object.fromEntries(req.headers), body: JSON.parse(raw) as PushBody, raw });
      return new Response(null, { status });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, received };
}

const pushSecret = x25519.utils.randomSecretKey();
const sendKey = new Uint8Array(32).fill(9);
const linkSecret = new Uint8Array(32).fill(5);

function device(id: string, over: Partial<RemoteDeviceRow> = {}): RemoteDeviceRow {
  return {
    id, name: "Ana's iPhone", platform: "ios", appVersion: "1", sessionPub: new Uint8Array(65), approvePub: new Uint8Array(65), pushPub: x25519.getPublicKey(pushSecret),
    linkSecret, level: "respond", status: "active", enrolledAt: 1, lastSeenAt: null, pushRef: `ref-${id}`, pushSendKey: sendKey, pushDead: false, sig: new Uint8Array(64), ...over,
  };
}

const decision = (kind: NotificationDecision["kind"], taskId = "task-1"): NotificationDecision => ({
  notification: { title: "Waiting on you", body: "SECRET-TITLE · claude-code", taskId, kind },
  kind,
  urgency: kind === "succeeded" ? "quiet" : "needs-you",
  meta: {},
});

describe("the phone sink", () => {
  test("a needs-you decision sends one sealed push per device with a push address", async () => {
    const g = gateway();
    const sink = createPhoneSink({ devices: async () => [device("a1"), device("b2"), device("c3", { pushRef: null })], pushUrl: () => g.url, atTheMac: () => false, now: () => 1234 });
    await sink.deliver(decision("waiting"));
    expect(g.received).toHaveLength(2);
    const r = g.received[0]!;
    expect(r.body).toMatchObject({ push_ref: "ref-a1", kind: "needs-you", ts: 1234 });
    expect(fromBase64(r.body.sealed).length).toBe(SEALED_PUSH_BYTES);
    const opened = openPush(fromBase64(r.body.sealed), pushSecret);
    expect(opened).toMatchObject({ v: 1, taskId: "task-1", kind: "waiting", title: "Waiting on you", subtitle: "SECRET-TITLE · claude-code" });
  });

  test("nothing readable leaves in the clear: no title, path, kind or task id in the request", async () => {
    const g = gateway();
    const sink = createPhoneSink({ devices: async () => [device("a1")], pushUrl: () => g.url, atTheMac: () => false });
    await sink.deliver(decision("waiting", "task-9f3b"));
    const raw = g.received[0]!.raw + JSON.stringify(g.received[0]!.headers);
    for (const secret of ["SECRET-TITLE", "Waiting on you", "task-9f3b", "claude-code", '"waiting"']) expect(raw).not.toContain(secret);
  });

  test("the request is authenticated by an HMAC under the device's push send key, over the canonical body", async () => {
    const g = gateway();
    const sink = createPhoneSink({ devices: async () => [device("a1")], pushUrl: () => g.url, atTheMac: () => false });
    await sink.deliver(decision("failed"));
    const r = g.received[0]!;
    expect(r.headers["x-agetor-mac"]).toBe(toHex(pushRequestMac(sendKey, canonicalBytes(r.body))));
    expect(r.headers["x-agetor-mac"]).not.toBe(toHex(pushRequestMac(new Uint8Array(32).fill(1), canonicalBytes(r.body))));
  });

  test("the collapse id is stable per task and different per task, and never the task id", async () => {
    const g = gateway();
    const sink = createPhoneSink({ devices: async () => [device("a1")], pushUrl: () => g.url, atTheMac: () => false });
    await sink.deliver(decision("waiting", "task-1"));
    await sink.deliver(decision("blocked", "task-1"));
    await sink.deliver(decision("waiting", "task-2"));
    const [a, b, c] = g.received.map((r) => r.body.collapse);
    expect(a).toBe(b!);
    expect(a).not.toBe(c!);
    expect(a).toBe(toBase64Url(collapseId(linkSecret, "task-1")));
    expect(a).not.toContain("task-1");
  });

  test("quiet kinds are not pushed", async () => {
    const g = gateway();
    const sink = createPhoneSink({ devices: async () => [device("a1")], pushUrl: () => g.url, atTheMac: () => false });
    for (const kind of ["succeeded", "files-sent", "pipeline-finished", "harness-swap"] as const) await sink.deliver(decision(kind));
    expect(g.received).toHaveLength(0);
  });

  test("nothing is pushed while someone is at the Mac, and a background core with no app counts as away", async () => {
    const g = gateway();
    let atMac = true;
    const sink = createPhoneSink({ devices: async () => [device("a1")], pushUrl: () => g.url, atTheMac: () => atMac });
    await sink.deliver(decision("waiting"));
    expect(g.received).toHaveLength(0);
    atMac = false;
    await sink.deliver(decision("waiting"));
    expect(g.received).toHaveLength(1);
  });

  test("a 410 marks the device's push dead; a dead device is skipped afterwards", async () => {
    const g = gateway(410);
    const dead: string[] = [];
    const devices = [device("a1")];
    const sink = createPhoneSink({ devices: async () => devices, pushUrl: () => g.url, atTheMac: () => false, markDead: async (id) => { dead.push(id); devices[0] = { ...devices[0]!, pushDead: true }; } });
    await sink.deliver(decision("waiting"));
    await sink.deliver(decision("waiting"));
    expect(dead).toEqual(["a1"]);
    expect(g.received).toHaveLength(1);
  });

  test("with no gateway configured it sends nothing and says so; an unreachable gateway never throws", async () => {
    const sink = createPhoneSink({ devices: async () => [device("a1")], pushUrl: () => null, atTheMac: () => false });
    await sink.deliver(decision("waiting"));
    expect(sink.status()).toEqual({ configured: false });
    const down = createPhoneSink({ devices: async () => [device("a1")], pushUrl: () => "http://127.0.0.1:1", atTheMac: () => false });
    await down.deliver(decision("waiting"));
    expect(down.status()).toEqual({ configured: true });
  });

  test("a gateway that takes the request and never answers is given up after PUSH_TIMEOUT_MS: the delivery settles, nothing is marked dead", async () => {
    // A fetch that behaves like the real one with respect to its signal: it settles only when the signal aborts.
    let calls = 0;
    const hanging = ((_url: string, init?: RequestInit) => {
      calls++;
      return new Promise<Response>((_res, rej) => {
        const signal = init?.signal;
        if (!signal) return; // no deadline: this request would hang forever
        signal.addEventListener("abort", () => rej(signal.reason));
      });
    }) as unknown as typeof fetch;
    const dead: string[] = [];
    jest.useFakeTimers();
    try {
      const sink = createPhoneSink({ devices: async () => [device("a1")], pushUrl: () => "http://gateway.test", atTheMac: () => false, fetch: hanging, markDead: async (id) => void dead.push(id) });
      let settled = false;
      const delivered = Promise.resolve(sink.deliver(decision("waiting"))).then(() => void (settled = true));
      const flush = async () => {
        for (let i = 0; i < 50; i++) await Promise.resolve();
      };
      await flush();
      expect(calls).toBe(1);
      jest.advanceTimersByTime(PUSH_TIMEOUT_MS - 1);
      await flush();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(2);
      await flush();
      expect(settled).toBe(true);
      await delivered;
      expect(dead).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a decision with no task is not pushed", async () => {
    const g = gateway();
    const sink = createPhoneSink({ devices: async () => [device("a1")], pushUrl: () => g.url, atTheMac: () => false });
    await sink.deliver({ notification: { title: "x" }, kind: "waiting", urgency: "needs-you", meta: {} });
    expect(g.received).toHaveLength(0);
  });

  test("a title longer than fits is cut, never refused, and the size stays constant", async () => {
    const g = gateway();
    const sink = createPhoneSink({ devices: async () => [device("a1")], pushUrl: () => g.url, atTheMac: () => false });
    await sink.deliver({ ...decision("waiting"), notification: { title: "T".repeat(5000), body: "B".repeat(5000), taskId: "task-1", kind: "waiting" } });
    expect(fromBase64(g.received[0]!.body.sealed).length).toBe(SEALED_PUSH_BYTES);
  });
});

describe("alerts to the other devices", () => {
  test("a pairing alert goes to every device but the new one, sealed and generic", async () => {
    const g = gateway();
    const sink = createPhoneSink({ devices: async () => [device("a1"), device("b2"), device("c3")], pushUrl: () => g.url, atTheMac: () => true });
    await sink.alertOtherDevices("b2", "device-paired");
    expect(g.received.map((r) => r.body.push_ref).sort()).toEqual(["ref-a1", "ref-c3"]);
    expect(g.received[0]!.body.kind).toBe("alert");
    expect(openPush(fromBase64(g.received[0]!.body.sealed), pushSecret)).toMatchObject({ kind: "device-paired", title: "A phone was paired" });
  });
});

describe("push registration", () => {
  test("registers the address and the send key with the store, and keeps both out of the log", async () => {
    const calls: Array<[string, string, string]> = [];
    const sink = createPhoneSink({ devices: async () => [], setPushRef: async (id, ref, key) => void calls.push([id, ref, toHex(key)]) });
    await sink.registerPush("a1", "opaque-push-ref-0123456789", sendKey);
    expect(calls).toEqual([["a1", "opaque-push-ref-0123456789", toHex(sendKey)]]);
    const { redactLogText } = await import("../core-log.ts");
    expect(redactLogText(`registered ref opaque-push-ref-0123456789 key ${toHex(sendKey)}`)).not.toContain("opaque-push-ref-0123456789");
    expect(redactLogText(`key ${toHex(sendKey)}`)).not.toContain(toHex(sendKey));
  });
});

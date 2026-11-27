import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "./bytes.ts";
import { mailboxId } from "./derive.ts";
import { decodeFrame, encodeFrame, type RelayFrame, type RelayRole } from "./relay-frames.ts";
import { startTestRelay, type TestRelay } from "./test-relay.ts";

let relay: TestRelay | null = null;
afterEach(() => {
  relay?.stop();
  relay = null;
});

class Client {
  frames: RelayFrame[] = [];
  closed: { code: number; reason: string } | null = null;
  private ws: WebSocket;
  ready: Promise<void>;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ready = new Promise((r) => (this.ws.onopen = () => r()));
    this.ws.onmessage = (e) => this.frames.push(decodeFrame(new Uint8Array(e.data as ArrayBuffer)));
    this.ws.onclose = (e) => (this.closed = { code: e.code, reason: e.reason });
  }
  send(f: RelayFrame) {
    this.ws.send(encodeFrame(f));
  }
  sendRaw(b: Uint8Array) {
    this.ws.send(b);
  }
  close() {
    this.ws.close();
  }
  of<T extends RelayFrame["type"]>(type: T): Array<Extract<RelayFrame, { type: T }>> {
    return this.frames.filter((f) => f.type === type) as Array<Extract<RelayFrame, { type: T }>>;
  }
  async until(pred: () => boolean, ms = 2000): Promise<void> {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error("timed out waiting; frames: " + this.frames.map((f) => f.type).join(","));
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

const KEY = randomBytes(32);
const KEY2 = randomBytes(32);
const ID = mailboxId(KEY);
const tag = (n: number) => new Uint8Array(8).fill(n);

async function join(url: string, role: RelayRole, keys = [KEY]): Promise<Client> {
  const c = new Client(url);
  await c.ready;
  c.send({ type: "hello", role, keys });
  await c.until(() => c.of("welcome").length === 1);
  return c;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("test relay: mailboxes", () => {
  test("hello joins by key, welcome names the ids, and peers learn of each other", async () => {
    relay = startTestRelay();
    const core = await join(relay.url, "core", [KEY, KEY2]);
    expect(core.of("welcome")[0]!.ids.map((i) => Buffer.from(i).toString("hex"))).toEqual([mailboxId(KEY), mailboxId(KEY2)].map((i) => Buffer.from(i).toString("hex")));
    expect(core.of("peer").every((p) => !p.present)).toBe(true);
    const device = await join(relay.url, "device");
    await core.until(() => core.of("peer").some((p) => p.present));
    await device.until(() => device.of("peer").some((p) => p.present));
    device.close();
    await core.until(() => core.of("peer").some((p, i, a) => i === a.length - 1 && !p.present));
    core.close();
  });

  test("the relay keeps only mailbox ids, never keys", async () => {
    relay = startTestRelay();
    const c = await join(relay.url, "core");
    const boxes = relay.mailboxes();
    expect(boxes.map((b) => b.id)).toEqual([Buffer.from(ID).toString("hex")]);
    expect(JSON.stringify(boxes)).not.toContain(Buffer.from(KEY).toString("hex"));
    c.close();
  });

  test("a newer connection of the same role replaces the older, which is told and closed", async () => {
    relay = startTestRelay();
    const first = await join(relay.url, "device");
    const second = await join(relay.url, "device");
    await first.until(() => first.of("replaced").length === 1 && first.closed !== null);
    expect(relay.stats().replaced).toBe(1);
    expect(second.closed).toBeNull();
    second.close();
  });
});

describe("test relay: delivery", () => {
  test("frames reach the other side in order with a relay sequence number", async () => {
    relay = startTestRelay();
    const core = await join(relay.url, "core");
    const device = await join(relay.url, "device");
    for (let i = 1; i <= 5; i++) device.send({ type: "send", mailbox: ID, tag: tag(1), payload: new Uint8Array([i]) });
    await core.until(() => core.of("deliver").length === 5);
    expect(core.of("deliver").map((d) => d.payload[0])).toEqual([1, 2, 3, 4, 5]);
    expect(core.of("deliver").map((d) => d.seq)).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(core.of("deliver")[0]!.tag).toEqual(tag(1));
    core.close();
    device.close();
  });

  test("a frame for an absent side is held, and delivered when that side joins", async () => {
    relay = startTestRelay();
    const device = await join(relay.url, "device");
    device.send({ type: "send", mailbox: ID, tag: tag(2), payload: new Uint8Array([9]) });
    await sleep(30);
    const core = await join(relay.url, "core");
    await core.until(() => core.of("deliver").length === 1);
    expect(core.of("welcome")[0]!.queued).toBe(1);
    core.close();
    device.close();
  });

  test("at least once: an unacknowledged frame is delivered again on reconnect, an acknowledged one is not", async () => {
    relay = startTestRelay();
    const device = await join(relay.url, "device");
    const core = await join(relay.url, "core");
    device.send({ type: "send", mailbox: ID, tag: tag(1), payload: new Uint8Array([1]) });
    device.send({ type: "send", mailbox: ID, tag: tag(1), payload: new Uint8Array([2]) });
    await core.until(() => core.of("deliver").length === 2);
    core.send({ type: "ack", mailbox: ID, seq: 1n });
    await sleep(30);
    core.close();
    await sleep(30);
    const again = await join(relay.url, "core");
    await again.until(() => again.of("deliver").length === 1);
    expect(again.of("deliver")[0]!.payload[0]).toBe(2);
    expect(relay.stats().redelivered).toBe(1);
    again.close();
    device.close();
  });

  test("a restart of the relay's connections keeps the queued frames", async () => {
    relay = startTestRelay();
    const device = await join(relay.url, "device");
    device.send({ type: "send", mailbox: ID, tag: tag(1), payload: new Uint8Array([7]) });
    await sleep(30);
    relay.dropConnections();
    await device.until(() => device.closed !== null);
    const core = await join(relay.url, "core");
    await core.until(() => core.of("deliver").length === 1);
    core.close();
  });

  test("a frame is deleted after the retention time, even if nobody connects", async () => {
    let t = 1_000_000;
    relay = startTestRelay({ now: () => t });
    const device = await join(relay.url, "device");
    device.send({ type: "send", mailbox: ID, tag: tag(1), payload: new Uint8Array([1]) });
    await sleep(30);
    t += 10 * 60 * 1000 - 1;
    relay.sweep();
    expect(relay.mailboxes()[0]!.queuedForCore).toBe(1);
    t += 2;
    relay.sweep();
    expect(relay.mailboxes()[0]!.queuedForCore).toBe(0);
    expect(relay.stats().expired).toBe(1);
    device.close();
  });
});

describe("test relay: limits", () => {
  test("a queue holds 64 frames, then answers full and never evicts", async () => {
    relay = startTestRelay({ limits: { framesPerSecond: 10_000 } });
    const device = await join(relay.url, "device");
    for (let i = 0; i < 70; i++) device.send({ type: "send", mailbox: ID, tag: tag(1), payload: new Uint8Array([i]) });
    await device.until(() => device.of("full").length === 6);
    expect(relay.mailboxes()[0]!.queuedForCore).toBe(64);
    const core = await join(relay.url, "core");
    await core.until(() => core.of("deliver").length === 64);
    expect(core.of("deliver")[0]!.payload[0]).toBe(0);
    expect(core.of("deliver")[63]!.payload[0]).toBe(63);
    core.close();
    device.close();
  });

  test("a queue holds 256 KB, then answers full", async () => {
    relay = startTestRelay();
    const device = await join(relay.url, "device");
    const big = new Uint8Array(60 * 1024);
    for (let i = 0; i < 5; i++) device.send({ type: "send", mailbox: ID, tag: tag(1), payload: big });
    await device.until(() => device.of("full").length === 1);
    expect(relay.mailboxes()[0]!.queuedForCore).toBe(4);
    device.close();
  });

  test("throughput: more than 50 frames in a second are dropped and counted", async () => {
    let t = 5_000_000;
    relay = startTestRelay({ now: () => t, limits: { queueFrames: 10_000 } });
    const device = await join(relay.url, "device");
    for (let i = 0; i < 60; i++) device.send({ type: "send", mailbox: ID, tag: tag(1), payload: new Uint8Array([1]) });
    await sleep(150);
    const s = relay.stats();
    expect(s.droppedRate).toBeGreaterThan(0);
    expect(s.maxFramesInOneSecond).toBeGreaterThan(50);
    expect(relay.mailboxes()[0]!.queuedForCore).toBeLessThan(60);
    device.close();
  });

  test("throughput: more than 2 MB in ten seconds is dropped, and a quiet second later is accepted", async () => {
    let t = 7_000_000;
    relay = startTestRelay({ now: () => t, limits: { queueBytes: 100_000_000, queueFrames: 10_000 } });
    const device = await join(relay.url, "device");
    const chunk = new Uint8Array(60 * 1024);
    for (let i = 0; i < 40; i++) {
      device.send({ type: "send", mailbox: ID, tag: tag(1), payload: chunk });
      t += 100;
      await sleep(5);
    }
    await sleep(100);
    expect(relay.stats().droppedRate).toBeGreaterThan(0);
    const before = relay.mailboxes()[0]!.queuedForCore;
    t += 20_000;
    device.send({ type: "send", mailbox: ID, tag: tag(1), payload: new Uint8Array([1]) });
    await sleep(80);
    expect(relay.mailboxes()[0]!.queuedForCore).toBe(before + 1);
    device.close();
  });

  test("an idle connection is closed after five minutes", async () => {
    let t = 1_000;
    relay = startTestRelay({ now: () => t });
    const c = await join(relay.url, "core");
    t += 5 * 60 * 1000 - 1;
    relay.sweep();
    expect(c.closed).toBeNull();
    t += 2;
    relay.sweep();
    await c.until(() => c.closed !== null);
    expect(relay.stats().idleClosed).toBe(1);
  });

  test("a ping is answered with a pong and keeps the connection alive", async () => {
    relay = startTestRelay();
    const c = await join(relay.url, "core");
    c.send({ type: "ping" });
    await c.until(() => c.of("pong").length === 1);
    c.close();
  });

  test("a frame over 66 KB closes the connection", async () => {
    relay = startTestRelay();
    const c = await join(relay.url, "core");
    c.sendRaw(new Uint8Array(66 * 1024 + 10).fill(1));
    await c.until(() => c.closed !== null);
    // Bun enforces the limit itself: the socket is dropped (1006) or closed with 1009 depending on the client.
    expect([1006, 1009]).toContain(c.closed!.code);
  });

  test("a limit override applies", async () => {
    relay = startTestRelay({ limits: { queueFrames: 2 } });
    const device = await join(relay.url, "device");
    for (let i = 0; i < 3; i++) device.send({ type: "send", mailbox: ID, tag: tag(1), payload: new Uint8Array([i]) });
    await device.until(() => device.of("full").length === 1);
    expect(relay.limits.queueFrames).toBe(2);
    device.close();
  });
});

describe("test relay: protocol errors", () => {
  test("a first frame that is not hello, a malformed frame and a send to an unjoined mailbox close the connection", async () => {
    relay = startTestRelay();
    const a = new Client(relay.url);
    await a.ready;
    a.send({ type: "send", mailbox: ID, tag: tag(1), payload: new Uint8Array([1]) });
    await a.until(() => a.closed !== null);
    expect(a.closed!.code).toBe(4401);
    const b = new Client(relay.url);
    await b.ready;
    b.sendRaw(new Uint8Array([9, 9, 9]));
    await b.until(() => b.closed !== null);
    expect(b.closed!.code).toBe(4400);
    const c = await join(relay.url, "core");
    c.send({ type: "send", mailbox: mailboxId(KEY2), tag: tag(1), payload: new Uint8Array([1]) });
    await c.until(() => c.closed !== null);
    expect(c.closed!.code).toBe(4403);
  });
});

// The relay link against the local test relay (packages/remote-protocol/src/test-relay.ts): joining, delivery with acks, redelivery,
// replacement, peer and full frames, reconnects, the UTC-date re-join, stale session tags, pacing against the relay's own counters.
import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "@agetor/remote-protocol/bytes";
import { mailboxId, mailboxKey, utcDate } from "@agetor/remote-protocol/derive";
import { decodeFrame, encodeFrame, type RelayFrame } from "@agetor/remote-protocol/relay-frames";
import { startTestRelay, type TestRelay } from "@agetor/remote-protocol/test-relay";
import { RelayLink, nextUtcMidnight, type Delivered, type LinkState } from "./relay-link.ts";

let relay: TestRelay | null = null;
let link: RelayLink | null = null;
const peers: WebSocket[] = [];
afterEach(() => {
  link?.closeAll();
  link = null;
  for (const p of peers.splice(0)) p.close();
  relay?.stop();
  relay = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
}

const LINK = randomBytes(32);
const keysFor = (now: number) => [mailboxKey(LINK, utcDate(now)), mailboxKey(LINK, utcDate(now - 86_400_000))];

/** A phone-side peer on the relay, speaking raw frames. */
async function phone(url: string, keys = keysFor(Date.now())): Promise<{ ws: WebSocket; frames: RelayFrame[]; send(f: RelayFrame): void }> {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const frames: RelayFrame[] = [];
  ws.onmessage = (e) => frames.push(decodeFrame(new Uint8Array(e.data as ArrayBuffer)));
  await new Promise<void>((r) => (ws.onopen = () => r()));
  ws.send(encodeFrame({ type: "hello", role: "device", keys }));
  peers.push(ws);
  await until(() => frames.some((f) => f.type === "welcome"));
  return { ws, frames, send: (f) => ws.send(encodeFrame(f)) };
}

function rig(handlers: Partial<ConstructorParameters<typeof RelayLink>[0]["handlers"]> = {}, extra: Partial<ConstructorParameters<typeof RelayLink>[0]> = {}) {
  relay = startTestRelay({ limits: { framesPerSecond: 10_000 } });
  const delivered: Array<Delivered & { name: string }> = [];
  const states: LinkState[] = [];
  const peerEvents: boolean[] = [];
  link = new RelayLink({
    url: relay.url,
    backoff: { baseMs: 20, maxMs: 100, random: () => 0.5 },
    handlers: {
      onDeliver: (name, d) => void delivered.push({ ...d, name }),
      onState: (_n, s) => void states.push(s),
      onPeer: (_n, _m, present) => void peerEvents.push(present),
      ...handlers,
    },
    ...extra,
  });
  return { delivered, states, peerEvents };
}

describe("joining and delivery", () => {
  test("joins with today's and yesterday's keys and goes up on welcome", async () => {
    const r = rig();
    link!.open({ name: "dev1", keys: keysFor });
    await until(() => link!.state("dev1") === "up");
    expect(r.states).toEqual(["connecting", "up"]);
    expect(relay!.mailboxes().map((m) => m.id).sort()).toEqual(keysFor(Date.now()).map((k) => Buffer.from(mailboxId(k)).toString("hex")).sort());
    expect(link!.mailboxIds("dev1")).toHaveLength(2);
  });

  test("frames from the phone reach the handler in order, with their tag, and are acknowledged", async () => {
    const r = rig();
    link!.open({ name: "dev1", keys: keysFor });
    await until(() => link!.state("dev1") === "up");
    const p = await phone(relay!.url);
    const id = mailboxId(keysFor(Date.now())[0]!);
    for (let i = 1; i <= 3; i++) p.send({ type: "send", mailbox: id, tag: new Uint8Array(8).fill(7), payload: new Uint8Array([i]) });
    await until(() => r.delivered.length === 3);
    expect(r.delivered.map((d) => d.payload[0])).toEqual([1, 2, 3]);
    expect(r.delivered[0]!.tag).toEqual(new Uint8Array(8).fill(7));
    await sleep(60);
    expect(relay!.mailboxes().find((m) => m.id === Buffer.from(id).toString("hex"))!.queuedForCore).toBe(0);
  });

  test("send reaches the phone and is paced; a send while down is refused", async () => {
    rig();
    expect(link!.send("dev1", null, new Uint8Array(8), new Uint8Array([1]))).toBe(false);
    link!.open({ name: "dev1", keys: keysFor });
    await until(() => link!.state("dev1") === "up");
    const p = await phone(relay!.url);
    await until(() => p.frames.some((f) => f.type === "peer"));
    expect(link!.send("dev1", null, new Uint8Array(8).fill(3), new Uint8Array([9, 9]))).toBe(true);
    await until(() => p.frames.some((f) => f.type === "deliver"));
    const d = p.frames.find((f) => f.type === "deliver") as Extract<RelayFrame, { type: "deliver" }>;
    expect([...d.payload]).toEqual([9, 9]);
    expect([...d.tag]).toEqual(new Array(8).fill(3));
  });

  test("peer joining and leaving is surfaced", async () => {
    const r = rig();
    link!.open({ name: "dev1", keys: keysFor });
    await until(() => link!.state("dev1") === "up");
    const p = await phone(relay!.url);
    await until(() => r.peerEvents.includes(true));
    p.ws.close();
    await until(() => r.peerEvents.includes(false));
  });

  test("a full queue on the phone side is surfaced", async () => {
    let full = 0;
    rig({ onFull: () => void full++ });
    link!.open({ name: "dev1", keys: keysFor });
    await until(() => link!.state("dev1") === "up");
    // No phone connected: the relay holds frames for it, up to 64.
    for (let i = 0; i < 70; i++) link!.send("dev1", null, new Uint8Array(8), new Uint8Array([i]));
    await until(() => full > 0);
    expect(full).toBeGreaterThanOrEqual(1);
  });
});

describe("at-least-once and stale tags", () => {
  test("a frame whose handler never finished is delivered again after a reconnect", async () => {
    let first = true;
    const seen: number[] = [];
    rig({
      onDeliver: async (_n, d) => {
        seen.push(d.payload[0]!);
        if (first) {
          first = false;
          await new Promise(() => {}); // the handler hangs: the ack never goes
        }
      },
    });
    link!.open({ name: "dev1", keys: keysFor });
    await until(() => link!.state("dev1") === "up");
    const p = await phone(relay!.url);
    p.send({ type: "send", mailbox: mailboxId(keysFor(Date.now())[0]!), tag: new Uint8Array(8), payload: new Uint8Array([42]) });
    await until(() => seen.length === 1);
    relay!.dropConnections();
    await until(() => seen.length >= 2, 4000);
    expect(seen.slice(0, 2)).toEqual([42, 42]);
    expect(relay!.stats().redelivered).toBeGreaterThanOrEqual(1);
  });

  test("a frame tagged with an ended session never reaches the session layer, and is still acknowledged", async () => {
    const stale = new Uint8Array(8).fill(1);
    const r = rig({ isStaleTag: (_n, tag) => tag[0] === 1 });
    link!.open({ name: "dev1", keys: keysFor });
    await until(() => link!.state("dev1") === "up");
    const p = await phone(relay!.url);
    const id = mailboxId(keysFor(Date.now())[0]!);
    p.send({ type: "send", mailbox: id, tag: stale, payload: new Uint8Array([1]) });
    p.send({ type: "send", mailbox: id, tag: new Uint8Array(8).fill(2), payload: new Uint8Array([2]) });
    await until(() => r.delivered.length === 1);
    await sleep(60);
    expect(r.delivered.map((d) => d.payload[0])).toEqual([2]);
    expect(relay!.mailboxes().find((m) => m.id === Buffer.from(id).toString("hex"))!.queuedForCore).toBe(0);
  });

  test("a handler that throws does not stop delivery", async () => {
    const seen: number[] = [];
    rig({ onDeliver: (_n, d) => { seen.push(d.payload[0]!); throw new Error("boom"); } });
    link!.open({ name: "dev1", keys: keysFor });
    await until(() => link!.state("dev1") === "up");
    const p = await phone(relay!.url);
    const id = mailboxId(keysFor(Date.now())[0]!);
    p.send({ type: "send", mailbox: id, tag: new Uint8Array(8), payload: new Uint8Array([1]) });
    p.send({ type: "send", mailbox: id, tag: new Uint8Array(8), payload: new Uint8Array([2]) });
    await until(() => seen.length === 2);
  });
});

describe("reconnects and replacement", () => {
  test("when the relay goes away the link reconnects by itself", async () => {
    const r = rig();
    link!.open({ name: "dev1", keys: keysFor });
    await until(() => link!.state("dev1") === "up");
    relay!.dropConnections();
    await until(() => r.states.filter((s) => s === "up").length >= 2, 4000);
    expect(r.states).toContain("down");
  });

  test("a newer core taking the mailbox ends this link without a fight", async () => {
    let replaced = 0;
    rig({ onReplaced: () => void replaced++ });
    link!.open({ name: "dev1", keys: keysFor });
    await until(() => link!.state("dev1") === "up");
    // A second core (a handoff) joins the same mailbox as role core.
    const second = new WebSocket(relay!.url);
    second.binaryType = "arraybuffer";
    await new Promise<void>((r) => (second.onopen = () => r()));
    second.send(encodeFrame({ type: "hello", role: "core", keys: keysFor(Date.now()) }));
    peers.push(second);
    await until(() => replaced > 0);
    await until(() => link!.state("dev1") === "down");
    await sleep(300);
    // It stays down: the relay never saw a third connection from the replaced link.
    expect(link!.state("dev1")).toBe("down");
    expect(relay!.stats().replaced).toBe(2); // one per mailbox (today's and yesterday's)
  });

  test("closeAll closes within a second, cancels reconnects and refuses new groups", async () => {
    const r = rig();
    link!.open({ name: "a", keys: keysFor });
    link!.open({ name: "b", keys: () => [randomBytes(32)] });
    await until(() => link!.state("a") === "up" && link!.state("b") === "up");
    const t0 = Date.now();
    link!.closeAll();
    await until(() => relay!.mailboxes().every((m) => !m.core), 1000);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(link!.state("a")).toBe("down");
    await sleep(250);
    expect(r.states.filter((s) => s === "up")).toHaveLength(2); // nothing came back
    link!.open({ name: "c", keys: keysFor });
    expect(link!.names()).toEqual([]);
  });

  test("close(name) closes only that group", async () => {
    rig();
    link!.open({ name: "a", keys: keysFor });
    link!.open({ name: "b", keys: () => [randomBytes(32)] });
    await until(() => link!.state("a") === "up" && link!.state("b") === "up");
    link!.close("a");
    expect(link!.state("a")).toBe("down");
    expect(link!.state("b")).toBe("up");
  });

  test("opening the same name again replaces its keys and reconnects", async () => {
    rig();
    link!.open({ name: "a", keys: () => [randomBytes(32)] });
    await until(() => link!.state("a") === "up");
    const before = relay!.mailboxes().length;
    link!.open({ name: "a", keys: () => [randomBytes(32)] });
    await until(() => relay!.mailboxes().length > before);
    await until(() => link!.state("a") === "up");
  });
});

describe("pacing against the relay's own counters", () => {
  test("a flood of sends never makes the relay drop one for rate", async () => {
    // The default relay limits here (50 frames/s, 2 MB/10 s): the link's pacer must keep under them.
    relay = startTestRelay();
    link = new RelayLink({ url: relay.url, handlers: { onDeliver: () => undefined }, backoff: { baseMs: 20, maxMs: 100 } });
    link.open({ name: "dev1", keys: keysFor });
    await until(() => link!.state("dev1") === "up");
    const p = await phone(relay.url);
    await until(() => p.frames.some((f) => f.type === "peer"));
    let accepted = 0;
    for (let i = 0; i < 120; i++) if (link.send("dev1", null, new Uint8Array(8), new Uint8Array(200))) accepted++;
    expect(accepted).toBe(120);
    await sleep(3500);
    const s = relay.stats();
    expect(s.droppedRate).toBe(0);
    expect(s.maxFramesInOneSecond).toBeLessThanOrEqual(50);
    expect(s.maxBytesInTenSeconds).toBeLessThanOrEqual(2 * 1024 * 1024);
  }, 15_000);
});

describe("the UTC date change", () => {
  test("nextUtcMidnight is the start of the next UTC day", () => {
    expect(nextUtcMidnight(Date.UTC(2026, 10, 25, 23, 59, 59))).toBe(Date.UTC(2026, 10, 26));
    expect(nextUtcMidnight(Date.UTC(2026, 10, 25, 0, 0, 0))).toBe(Date.UTC(2026, 10, 26));
  });

  test("keys are asked for again on every (re)connect, so a new date brings new mailbox ids", async () => {
    rig();
    const asked: number[] = [];
    link!.open({ name: "a", keys: (now) => (asked.push(now), keysFor(now)) });
    await until(() => link!.state("a") === "up");
    relay!.dropConnections();
    await until(() => asked.length >= 2, 4000);
    expect(asked.length).toBeGreaterThanOrEqual(2);
  });
});

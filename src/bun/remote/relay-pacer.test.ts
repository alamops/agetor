import { describe, expect, test } from "bun:test";
import { PACER_BYTES_PER_10S, PACER_FRAMES_PER_SECOND, RelayPacer } from "./relay-pacer.ts";

/** A pacer on a fake clock: timers fire when the test advances time. */
function rig(opts: Partial<ConstructorParameters<typeof RelayPacer>[0]> = {}) {
  let t = 10_000;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sent: Array<{ t: number; len: number; first: number }> = [];
  const pacer = new RelayPacer({
    sendRaw: (f) => void sent.push({ t, len: f.length, first: f[0] ?? 0 }),
    now: () => t,
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (h) => void timers.delete(h as number),
    ...opts,
  });
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      t = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }
    t = end;
  };
  return { pacer, sent, advance, now: () => t };
}

const frame = (len: number, first = 0) => new Uint8Array(len).fill(first);

/** The most frames in any 1 s window and the most bytes in any 10 s window of the sends. */
function peaks(sent: Array<{ t: number; len: number }>) {
  let maxFrames = 0;
  let maxBytes = 0;
  for (const s of sent) {
    maxFrames = Math.max(maxFrames, sent.filter((x) => x.t >= s.t && x.t < s.t + 1000).length);
    maxBytes = Math.max(maxBytes, sent.filter((x) => x.t >= s.t && x.t < s.t + 10_000).reduce((n, x) => n + x.len, 0));
  }
  return { maxFrames, maxBytes };
}

describe("relay pacer", () => {
  test("sends at once while under the limits", () => {
    const r = rig();
    r.pacer.enqueue(frame(100));
    expect(r.sent).toHaveLength(1);
    expect(r.pacer.queuedBytes()).toBe(0);
  });

  test("frames go out evenly spaced, never in a burst, and the first goes at once", () => {
    const r = rig();
    for (let i = 0; i < 10; i++) r.pacer.enqueue(frame(50));
    expect(r.sent).toHaveLength(1);
    r.advance(1000);
    const gaps = r.sent.slice(1).map((x, i) => x.t - r.sent[i]!.t);
    expect(r.sent).toHaveLength(10);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(Math.floor(1000 / PACER_FRAMES_PER_SECOND));
  });

  test("never puts more than 192 KB on the wire in one second (the relay holds 256 KB the phone has not acknowledged)", () => {
    const r = rig({ maxQueuedBytes: 10 * 1024 * 1024 });
    for (let i = 0; i < 20; i++) r.pacer.enqueue(frame(60_000));
    r.advance(60_000);
    expect(r.sent).toHaveLength(20);
    for (const s of r.sent) {
      const inWindow = r.sent.filter((x) => x.t >= s.t && x.t < s.t + 1000).reduce((n, x) => n + x.len, 0);
      expect(inWindow).toBeLessThanOrEqual(192 * 1024);
    }
  });

  test("never exceeds 50 frames a second, however many are queued", () => {
    const r = rig();
    for (let i = 0; i < 400; i++) r.pacer.enqueue(frame(50));
    r.advance(15_000);
    expect(r.sent).toHaveLength(400);
    const p = peaks(r.sent);
    expect(p.maxFrames).toBeLessThanOrEqual(50);
    expect(p.maxFrames).toBeGreaterThanOrEqual(40);
  });

  test("never exceeds 2 MB in ten seconds", () => {
    const r = rig({ maxQueuedBytes: 10 * 1024 * 1024 });
    for (let i = 0; i < 100; i++) r.pacer.enqueue(frame(60_000), { priority: false });
    r.advance(200_000);
    expect(r.sent).toHaveLength(100);
    const p = peaks(r.sent);
    expect(p.maxBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(p.maxBytes).toBeLessThanOrEqual(PACER_BYTES_PER_10S);
  });

  test("a stop-class frame goes before queued bulk", () => {
    const r = rig({ framesPerSecond: 1 });
    r.pacer.enqueue(frame(10, 1)); // goes at once
    r.pacer.enqueue(frame(10, 2));
    r.pacer.enqueue(frame(10, 3));
    r.pacer.enqueue(frame(10, 9), { priority: true });
    r.advance(5000);
    expect(r.sent.map((s) => s.first)).toEqual([1, 9, 2, 3]);
  });

  test("the queue is bounded: bulk is refused past the cap, a priority frame always fits", () => {
    const r = rig({ framesPerSecond: 1, maxQueuedBytes: 1000 });
    r.pacer.enqueue(frame(10)); // sent
    expect(r.pacer.enqueue(frame(600))).toBe(true);
    expect(r.pacer.enqueue(frame(600))).toBe(false);
    expect(r.pacer.queuedBytes()).toBe(600);
    expect(r.pacer.enqueue(frame(900), { priority: true })).toBe(true);
    expect(r.pacer.queuedFrames()).toBe(2);
  });

  test("clear drops what is queued; close refuses more", () => {
    const r = rig({ framesPerSecond: 1 });
    r.pacer.enqueue(frame(10));
    r.pacer.enqueue(frame(10));
    r.pacer.clear();
    expect(r.pacer.queuedBytes()).toBe(0);
    r.advance(5000);
    expect(r.sent).toHaveLength(1);
    r.pacer.close();
    expect(r.pacer.enqueue(frame(10))).toBe(false);
  });

  test("a socket that throws does not break the pacer", () => {
    let n = 0;
    const r = rig({ sendRaw: () => { if (n++ === 0) throw new Error("closed"); } });
    r.pacer.enqueue(frame(10));
    r.pacer.enqueue(frame(10));
    r.advance(100);
    expect(n).toBe(2);
  });
});

/**
 * Pacing under the relay's per-connection limits (relay contract §2: 50 frames a second, 2 MB per 10 seconds; excess is dropped by the
 * relay, so the core never sends it). Stays a little under both so a clock skew or a burst on another path cannot cross them.
 *
 * Frames go out evenly spaced (one every 1000/45 ms), never in bursts: the relay counts frames in a sliding second at ITS end, so a burst
 * of 45 followed by a wait lets two bursts land inside one of its windows when the network or its event loop bunches them.
 *
 * Two queues: `stop`-class frames (a cancel, a reject, a revoke ack) go first and are always accepted; everything else is bounded
 * (`maxQueuedBytes`) so a slow relay can never grow memory on the Mac. `queuedBytes()` feeds the session's 4 MB backpressure cap.
 */

export const PACER_FRAMES_PER_SECOND = 45;
export const PACER_BYTES_PER_10S = 1_900_000;
export const PACER_MAX_QUEUED_BYTES = 4 * 1024 * 1024;
/**
 * The relay keeps up to 256 KB of frames the phone has not yet acknowledged and answers `full` (dropping the frame) past that. The core
 * cannot see the phone's acks, so it never puts more than this many bytes on the wire in any one second: a phone that acks within a second
 * never trips the relay's queue cap, and a bulk transfer (a file preview) runs at the sustained rate the 10-second budget allows anyway.
 */
export const PACER_BURST_BYTES_PER_SECOND = 192 * 1024;

export interface PacerDeps {
  /** Hand a frame to the socket. */
  sendRaw(frame: Uint8Array): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  framesPerSecond?: number;
  bytesPer10s?: number;
  burstBytesPerSecond?: number;
  maxQueuedBytes?: number;
}

interface Item {
  frame: Uint8Array;
}

export class RelayPacer {
  private readonly high: Item[] = [];
  private readonly low: Item[] = [];
  private queued = 0;
  private readonly sent: Array<{ t: number; bytes: number }> = [];
  private timer: unknown = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private closed = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  private readonly fps: number;
  private readonly bytes10: number;
  private readonly burst: number;
  private readonly cap: number;

  constructor(private readonly deps: PacerDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.fps = deps.framesPerSecond ?? PACER_FRAMES_PER_SECOND;
    this.bytes10 = deps.bytesPer10s ?? PACER_BYTES_PER_10S;
    this.burst = deps.burstBytesPerSecond ?? PACER_BURST_BYTES_PER_SECOND;
    this.cap = deps.maxQueuedBytes ?? PACER_MAX_QUEUED_BYTES;
  }

  /** Queue a frame. A non-priority frame that would push the queue past its cap is refused (false); a priority frame always fits. */
  enqueue(frame: Uint8Array, opts: { priority?: boolean } = {}): boolean {
    if (this.closed) return false;
    if (!opts.priority && this.queued + frame.length > this.cap) return false;
    (opts.priority ? this.high : this.low).push({ frame });
    this.queued += frame.length;
    this.pump();
    return true;
  }

  queuedBytes(): number {
    return this.queued;
  }

  queuedFrames(): number {
    return this.high.length + this.low.length;
  }

  /** Drop everything queued (the session ended). */
  clear(): void {
    this.high.length = 0;
    this.low.length = 0;
    this.queued = 0;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  close(): void {
    this.closed = true;
    this.clear();
  }

  private prune(t: number): void {
    while (this.sent.length && t - this.sent[0]!.t >= 10_000) this.sent.shift();
  }

  /** Milliseconds until `frame` may go, or 0 now. */
  private waitFor(t: number, size: number): number {
    this.prune(t);
    let wait = Math.max(0, Math.ceil(1000 / this.fps) - (t - this.lastSentAt));
    const inSecond = this.sent.filter((s) => t - s.t < 1000);
    if (inSecond.length >= this.fps) wait = Math.max(wait, 1000 - (t - inSecond[0]!.t));
    let inSecondBytes = inSecond.reduce((n, s) => n + s.bytes, 0);
    if (inSecondBytes + size > this.burst) {
      for (const s of inSecond) {
        inSecondBytes -= s.bytes;
        wait = Math.max(wait, 1000 - (t - s.t));
        if (inSecondBytes + size <= this.burst) break;
      }
    }
    let bytes = this.sent.reduce((n, s) => n + s.bytes, 0);
    if (bytes + size > this.bytes10) {
      // Free bytes by waiting for the oldest sends to leave the 10 s window.
      for (const s of this.sent) {
        bytes -= s.bytes;
        wait = Math.max(wait, 10_000 - (t - s.t));
        if (bytes + size <= this.bytes10) break;
      }
    }
    return wait > 0 ? wait + 1 : 0;
  }

  private pump(): void {
    if (this.timer !== null || this.closed) return;
    for (;;) {
      const q = this.high.length ? this.high : this.low;
      const item = q[0];
      if (!item) return;
      const t = this.now();
      const wait = this.waitFor(t, item.frame.length);
      if (wait > 0) {
        this.timer = this.setTimer(() => {
          this.timer = null;
          this.pump();
        }, wait);
        return;
      }
      q.shift();
      this.queued -= item.frame.length;
      this.sent.push({ t, bytes: item.frame.length });
      this.lastSentAt = t;
      try {
        this.deps.sendRaw(item.frame);
      } catch {
        /* the socket is gone: the link reconnects and the session layer ends the session */
      }
    }
  }
}

/**
 * The relay link: the core's side of the relay contract (docs/specs/remote-relay-contract.md §1, spec "Sessions and the relay link").
 *
 * One WebSocket per mailbox group, i.e. one per paired device and one for the pairing mailbox while its window is open. A group joins
 * as role `core` with the mailbox keys for today and yesterday (UTC), so a frame sent either side of midnight still lands; at the UTC
 * date change it reconnects with fresh keys. Frames arrive in order; each `deliver` goes to the handler and is acknowledged after it
 * returns, so a frame the handler never finished is delivered again (at least once). Every frame carries an 8-byte session tag
 * outside the encryption: `isStaleTag` lets the session layer drop frames of an ended session BEFORE any decryption, and they are still
 * acknowledged so the relay does not redeliver them.
 *
 * Reconnects use a jittered back-off (500 ms doubling to 30 s). A `replaced` frame means a newer core took the mailbox (a port handoff,
 * a second Mac process): this link stays down rather than replacing it back. `closeAll()` closes every socket at once (well within the
 * one second the gate promises), cancels every timer and never reconnects.
 */
import { MAILBOX_ID_BYTES, RELAY_PING_MS } from "@agetor/remote-protocol/constants";
import { mailboxId } from "@agetor/remote-protocol/derive";
import { FrameError, decodeFrame, encodeFrame, type RelayFrame } from "@agetor/remote-protocol/relay-frames";
import { RelayPacer, type PacerDeps } from "./relay-pacer.ts";

export type LinkState = "connecting" | "up" | "down";

export interface MailboxSpec {
  /** A stable name for this group: the device id, or "pairing". */
  name: string;
  /** The mailbox keys to join with: today's first, then yesterday's. Called on every (re)connect. */
  keys(now: number): Uint8Array[];
}

export interface Delivered {
  mailbox: Uint8Array;
  seq: bigint;
  tag: Uint8Array;
  payload: Uint8Array;
}

export interface RelayLinkHandlers {
  onDeliver(name: string, d: Delivered): void | Promise<void>;
  onPeer?(name: string, mailbox: Uint8Array, present: boolean): void;
  onFull?(name: string, mailbox: Uint8Array): void;
  onReplaced?(name: string, mailbox: Uint8Array): void;
  onState?(name: string, state: LinkState): void;
  /** True when the frame's session tag belongs to a session that has ended: drop it before the session layer. */
  isStaleTag?(name: string, tag: Uint8Array): boolean;
}

export interface RelayLinkOptions {
  url: string;
  handlers: RelayLinkHandlers;
  WebSocketImpl?: typeof WebSocket;
  now?: () => number;
  backoff?: { baseMs?: number; maxMs?: number; random?: () => number };
  pingMs?: number;
  pacer?: Partial<Pick<PacerDeps, "framesPerSecond" | "bytesPer10s" | "maxQueuedBytes" | "now" | "setTimer" | "clearTimer">>;
}

interface Group {
  spec: MailboxSpec;
  ws: WebSocket | null;
  pacer: RelayPacer | null;
  state: LinkState;
  attempts: number;
  closed: boolean;
  replaced: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  midnightTimer: ReturnType<typeof setTimeout> | null;
  lastRx: number;
  ids: Uint8Array[];
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function nextUtcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

export class RelayLink {
  private readonly groups = new Map<string, Group>();
  private readonly WS: typeof WebSocket;
  private readonly now: () => number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly random: () => number;
  private readonly pingMs: number;
  private stopped = false;

  constructor(private readonly opts: RelayLinkOptions) {
    this.WS = opts.WebSocketImpl ?? WebSocket;
    this.now = opts.now ?? Date.now;
    this.baseMs = opts.backoff?.baseMs ?? 500;
    this.maxMs = opts.backoff?.maxMs ?? 30_000;
    this.random = opts.backoff?.random ?? Math.random;
    this.pingMs = opts.pingMs ?? RELAY_PING_MS;
  }

  /** Join (or re-join) a mailbox group. A second `open` of the same name replaces its keys and reconnects. */
  open(spec: MailboxSpec): void {
    if (this.stopped) return;
    const existing = this.groups.get(spec.name);
    if (existing) this.teardown(existing);
    const g: Group = {
      spec, ws: null, pacer: null, state: "down", attempts: 0, closed: false, replaced: false,
      reconnectTimer: null, pingTimer: null, midnightTimer: null, lastRx: this.now(), ids: [],
    };
    this.groups.set(spec.name, g);
    this.connect(g);
  }

  close(name: string): void {
    const g = this.groups.get(name);
    if (!g) return;
    this.teardown(g);
    this.groups.delete(name);
  }

  /** Close every socket and cancel every timer. Nothing reconnects afterwards. */
  closeAll(): void {
    this.stopped = true;
    for (const g of [...this.groups.values()]) this.teardown(g);
    this.groups.clear();
  }

  state(name: string): LinkState {
    return this.groups.get(name)?.state ?? "down";
  }

  names(): string[] {
    return [...this.groups.keys()];
  }

  /** The mailbox ids of a group's current keys (today's first). */
  mailboxIds(name: string): Uint8Array[] {
    return (this.groups.get(name)?.ids ?? []).map((i) => i.slice());
  }

  /**
   * Send ciphertext on a group's mailbox (today's by default). False when the link is not up or the pacer's queue is full: nothing is
   * held across a reconnect, the session layer's retry and the idempotency key cover that.
   */
  send(name: string, mailbox: Uint8Array | null, tag: Uint8Array, payload: Uint8Array, opts: { priority?: boolean } = {}): boolean {
    const g = this.groups.get(name);
    if (!g || g.state !== "up" || !g.pacer) return false;
    const mb = mailbox ?? g.ids[0];
    if (!mb || mb.length !== MAILBOX_ID_BYTES) return false;
    return g.pacer.enqueue(encodeFrame({ type: "send", mailbox: mb, tag, payload }), opts);
  }

  /** Bytes queued for a group and not yet sent (the session's backpressure reads it). */
  queuedBytes(name: string): number {
    return this.groups.get(name)?.pacer?.queuedBytes() ?? 0;
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────────────────────────────

  private setState(g: Group, s: LinkState): void {
    if (g.state === s) return;
    g.state = s;
    try {
      this.opts.handlers.onState?.(g.spec.name, s);
    } catch {
      /* a handler must not break the link */
    }
  }

  private teardown(g: Group): void {
    g.closed = true;
    if (g.reconnectTimer) clearTimeout(g.reconnectTimer);
    if (g.pingTimer) clearInterval(g.pingTimer);
    if (g.midnightTimer) clearTimeout(g.midnightTimer);
    g.reconnectTimer = g.pingTimer = g.midnightTimer = null;
    g.pacer?.close();
    g.pacer = null;
    const ws = g.ws;
    g.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000, "closing");
      } catch {
        /* already closed */
      }
    }
    this.setState(g, "down");
  }

  private connect(g: Group): void {
    if (g.closed || this.stopped) return;
    const keys = g.spec.keys(this.now());
    g.ids = keys.map((k) => mailboxId(k));
    this.setState(g, "connecting");
    let ws: WebSocket;
    try {
      ws = new this.WS(this.opts.url);
    } catch {
      this.scheduleReconnect(g);
      return;
    }
    ws.binaryType = "arraybuffer";
    g.ws = ws;
    g.pacer = new RelayPacer({ ...this.opts.pacer, sendRaw: (f) => ws.send(f) });
    ws.onopen = () => {
      // The hello goes out directly (it is tiny and must be first); everything after it is paced.
      ws.send(encodeFrame({ type: "hello", role: "core", keys }));
      g.lastRx = this.now();
      this.armPing(g);
      this.armMidnight(g);
    };
    ws.onmessage = (ev) => {
      g.lastRx = this.now();
      let frame: RelayFrame;
      try {
        frame = decodeFrame(new Uint8Array(ev.data as ArrayBuffer));
      } catch (e) {
        if (e instanceof FrameError) return; // an undecodable frame from the relay is ignored, never trusted
        throw e;
      }
      void this.onFrame(g, frame);
    };
    ws.onerror = () => undefined;
    ws.onclose = () => {
      if (g.ws !== ws) return;
      g.ws = null;
      g.pacer?.close();
      g.pacer = null;
      if (g.pingTimer) clearInterval(g.pingTimer);
      g.pingTimer = null;
      this.setState(g, "down");
      if (!g.closed && !g.replaced) this.scheduleReconnect(g);
    };
  }

  private async onFrame(g: Group, f: RelayFrame): Promise<void> {
    const name = g.spec.name;
    switch (f.type) {
      case "welcome":
        g.attempts = 0;
        this.setState(g, "up");
        return;
      case "deliver": {
        const ack = () => {
          if (g.ws && g.pacer) g.pacer.enqueue(encodeFrame({ type: "ack", mailbox: f.mailbox, seq: f.seq }), { priority: true });
        };
        if (this.opts.handlers.isStaleTag?.(name, f.tag)) return ack();
        try {
          await this.opts.handlers.onDeliver(name, { mailbox: f.mailbox, seq: f.seq, tag: f.tag, payload: f.payload });
        } catch {
          // The session layer ends a session on any failure; the frame is acknowledged either way so it cannot loop.
        }
        ack();
        return;
      }
      case "peer":
        this.opts.handlers.onPeer?.(name, f.mailbox, f.present);
        return;
      case "full":
        this.opts.handlers.onFull?.(name, f.mailbox);
        return;
      case "replaced":
        g.replaced = true;
        this.opts.handlers.onReplaced?.(name, f.mailbox);
        return;
      case "ping":
        g.pacer?.enqueue(encodeFrame({ type: "pong" }), { priority: true });
        return;
      default:
        return; // pong, hello, send, ack, ...: nothing to do
    }
  }

  private armPing(g: Group): void {
    if (g.pingTimer) clearInterval(g.pingTimer);
    g.pingTimer = setInterval(() => {
      if (!g.ws) return;
      // Nothing heard for two ping intervals: the connection is dead, whatever the socket says.
      if (this.now() - g.lastRx > this.pingMs * 2.5) {
        try {
          g.ws.close(4000, "ping timeout");
        } catch {
          /* already closed */
        }
        return;
      }
      g.pacer?.enqueue(encodeFrame({ type: "ping" }), { priority: true });
    }, this.pingMs);
  }

  /** Re-join with fresh keys at the next UTC midnight (plus a little jitter so every Mac does not reconnect on the second). */
  private armMidnight(g: Group): void {
    if (g.midnightTimer) clearTimeout(g.midnightTimer);
    const wait = Math.max(1000, nextUtcMidnight(this.now()) - this.now() + Math.floor(this.random() * 5000));
    g.midnightTimer = setTimeout(() => {
      if (g.closed || this.stopped) return;
      g.attempts = 0;
      const ws = g.ws;
      g.ws = null;
      g.pacer?.close();
      g.pacer = null;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try {
          ws.close(1000, "date change");
        } catch {
          /* already closed */
        }
      }
      this.setState(g, "down");
      this.connect(g);
    }, wait);
  }

  private scheduleReconnect(g: Group): void {
    if (g.closed || this.stopped || g.reconnectTimer) return;
    const exp = Math.min(this.maxMs, this.baseMs * 2 ** Math.min(g.attempts, 10));
    const delay = Math.max(50, Math.floor(exp * (0.5 + this.random() * 0.5)));
    g.attempts++;
    g.reconnectTimer = setTimeout(() => {
      g.reconnectTimer = null;
      this.connect(g);
    }, delay);
  }
}

export { hex as mailboxHex };

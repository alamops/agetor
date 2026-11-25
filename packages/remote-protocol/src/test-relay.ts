/**
 * A local test relay that follows the relay contract (docs/specs/remote-relay-contract.md §1–2): binary WebSocket frames, mailbox ids
 * derived from the keys clients present, roles, replacement, `peer`, per-mailbox order, at-least-once delivery with acks, 10-minute
 * retention, queue limits that answer `full` and never evict, throughput limits that drop and count, an idle close and a 66 KB frame
 * limit. It never decrypts anything and keeps only mailbox ids (the keys live in nothing but the hello that is hashed on arrival).
 *
 * Used by the core's integration tests, the headless test client and the e2e specs. NEVER imported from `src/` production code,
 * and never started outside a test seam: the production relay is a separate service (the relay spec).
 */
import type { ServerWebSocket } from "bun";
import { toHex } from "./bytes.ts";
import {
  MAX_RELAY_FRAME_BYTES,
  RELAY_BYTES_PER_10S,
  RELAY_FRAMES_PER_SECOND,
  RELAY_IDLE_CLOSE_MS,
  RELAY_QUEUE_BYTES,
  RELAY_QUEUE_FRAMES,
  RELAY_RETENTION_MS,
} from "./constants.ts";
import { mailboxId } from "./derive.ts";
import { FrameError, decodeFrame, encodeFrame, type RelayRole } from "./relay-frames.ts";

export interface RelayLimits {
  queueBytes: number;
  queueFrames: number;
  retentionMs: number;
  framesPerSecond: number;
  bytesPer10s: number;
  idleCloseMs: number;
  maxFrameBytes: number;
}

export const DEFAULT_RELAY_LIMITS: RelayLimits = {
  queueBytes: RELAY_QUEUE_BYTES,
  queueFrames: RELAY_QUEUE_FRAMES,
  retentionMs: RELAY_RETENTION_MS,
  framesPerSecond: RELAY_FRAMES_PER_SECOND,
  bytesPer10s: RELAY_BYTES_PER_10S,
  idleCloseMs: RELAY_IDLE_CLOSE_MS,
  maxFrameBytes: MAX_RELAY_FRAME_BYTES,
};

export interface RelayStats {
  connections: number;
  framesIn: number;
  bytesIn: number;
  framesOut: number;
  bytesOut: number;
  /** Frames a client sent faster than the throughput limits allow (dropped). A client pacer that works keeps this at 0. */
  droppedRate: number;
  /** `send` frames answered `full` (queue limit). */
  full: number;
  replaced: number;
  /** Deliveries of a frame that was delivered before and not acknowledged (at-least-once). */
  redelivered: number;
  expired: number;
  idleClosed: number;
  /** The most frames any one connection sent within one second, and the most bytes within ten seconds (to assert pacing). */
  maxFramesInOneSecond: number;
  maxBytesInTenSeconds: number;
}

export interface TestRelay {
  readonly url: string;
  readonly port: number;
  readonly limits: RelayLimits;
  stats(): RelayStats;
  /** Delete frames past their retention and close idle connections. Runs every second on its own; tests with a fake clock call it. */
  sweep(): void;
  /** Ids of the mailboxes the relay knows (hex), and which roles are joined. Never keys. */
  mailboxes(): Array<{ id: string; core: boolean; device: boolean; queuedForCore: number; queuedForDevice: number }>;
  /** Close every connection (as a relay restart would). Queued frames are kept, like a relay that stores them. */
  dropConnections(): void;
  stop(): void;
}

interface Queued {
  seq: bigint;
  tag: Uint8Array;
  payload: Uint8Array;
  at: number;
  bytes: number;
  delivered: boolean;
}

interface Mailbox {
  id: Uint8Array;
  conns: { core: ServerWebSocket<ConnData> | null; device: ServerWebSocket<ConnData> | null };
  queue: { core: Queued[]; device: Queued[] };
  nextSeq: { core: bigint; device: bigint };
}

interface ConnData {
  hello: boolean;
  joined: Map<string, RelayRole>;
  lastFrameAt: number;
  recent: Array<{ t: number; bytes: number }>;
}

export function startTestRelay(opts: { port?: number; limits?: Partial<RelayLimits>; now?: () => number } = {}): TestRelay {
  const limits: RelayLimits = { ...DEFAULT_RELAY_LIMITS, ...opts.limits };
  const now = opts.now ?? Date.now;
  const boxes = new Map<string, Mailbox>();
  const conns = new Set<ServerWebSocket<ConnData>>();
  const stats: RelayStats = {
    connections: 0, framesIn: 0, bytesIn: 0, framesOut: 0, bytesOut: 0, droppedRate: 0, full: 0, replaced: 0, redelivered: 0,
    expired: 0, idleClosed: 0, maxFramesInOneSecond: 0, maxBytesInTenSeconds: 0,
  };

  const other = (r: RelayRole): RelayRole => (r === "core" ? "device" : "core");
  const out = (ws: ServerWebSocket<ConnData>, frame: Parameters<typeof encodeFrame>[0]): void => {
    const bytes = encodeFrame(frame);
    stats.framesOut++;
    stats.bytesOut += bytes.length;
    try {
      ws.send(bytes);
    } catch {
      /* the socket is gone; its close handler cleans up */
    }
  };

  const box = (id: Uint8Array): Mailbox => {
    const key = toHex(id);
    let b = boxes.get(key);
    if (!b) boxes.set(key, (b = { id, conns: { core: null, device: null }, queue: { core: [], device: [] }, nextSeq: { core: 1n, device: 1n } }));
    return b;
  };

  const deliver = (b: Mailbox, to: RelayRole, q: Queued): void => {
    const ws = b.conns[to];
    if (!ws) return;
    if (q.delivered) stats.redelivered++;
    q.delivered = true;
    out(ws, { type: "deliver", mailbox: b.id, seq: q.seq, tag: q.tag, payload: q.payload });
  };

  const leave = (ws: ServerWebSocket<ConnData>): void => {
    for (const [idHex, role] of ws.data.joined) {
      const b = boxes.get(idHex);
      if (!b || b.conns[role] !== ws) continue;
      b.conns[role] = null;
      const peer = b.conns[other(role)];
      if (peer) out(peer, { type: "peer", mailbox: b.id, present: false });
    }
    ws.data.joined.clear();
  };

  const rate = (ws: ServerWebSocket<ConnData>, bytes: number): boolean => {
    const t = now();
    const r = ws.data.recent;
    r.push({ t, bytes });
    while (r.length && t - r[0]!.t > 10_000) r.shift();
    const inSecond = r.filter((x) => t - x.t <= 1000).length;
    const inTen = r.reduce((n, x) => n + x.bytes, 0);
    stats.maxFramesInOneSecond = Math.max(stats.maxFramesInOneSecond, inSecond);
    stats.maxBytesInTenSeconds = Math.max(stats.maxBytesInTenSeconds, inTen);
    return inSecond <= limits.framesPerSecond && inTen <= limits.bytesPer10s;
  };

  const handle = (ws: ServerWebSocket<ConnData>, raw: Uint8Array): void => {
    ws.data.lastFrameAt = now();
    stats.framesIn++;
    stats.bytesIn += raw.length;
    if (raw.length > limits.maxFrameBytes) return void ws.close(1009, "frame too large");
    let frame;
    try {
      frame = decodeFrame(raw);
    } catch (e) {
      return void ws.close(4400, e instanceof FrameError ? e.message.slice(0, 100) : "bad frame");
    }
    if (!rate(ws, raw.length)) {
      stats.droppedRate++;
      return;
    }
    if (!ws.data.hello) {
      if (frame.type === "ping") return void out(ws, { type: "pong" });
      if (frame.type !== "hello") return void ws.close(4401, "hello first");
      ws.data.hello = true;
      const role = frame.role;
      const ids: Uint8Array[] = [];
      let queued = 0;
      for (const key of frame.keys) {
        const id = mailboxId(key); // the key is hashed here and never kept
        const b = box(id);
        const idHex = toHex(id);
        const old = b.conns[role];
        if (old && old !== ws) {
          stats.replaced++;
          out(old, { type: "replaced", mailbox: id });
          old.data.joined.delete(idHex);
          // The older connection is closed after the other joined mailboxes are told, below.
          setTimeout(() => old.close(1000, "replaced"), 0);
        }
        b.conns[role] = ws;
        ws.data.joined.set(idHex, role);
        ids.push(id);
        queued += b.queue[role].length;
      }
      out(ws, { type: "welcome", ids, queued });
      for (const id of ids) {
        const b = box(id);
        const peer = b.conns[other(role)];
        out(ws, { type: "peer", mailbox: id, present: peer !== null });
        if (peer) out(peer, { type: "peer", mailbox: id, present: true });
        for (const q of b.queue[role]) deliver(b, role, q);
      }
      return;
    }
    switch (frame.type) {
      case "ping":
        return void out(ws, { type: "pong" });
      case "pong":
      case "hello":
        return;
      case "send": {
        const idHex = toHex(frame.mailbox);
        const role = ws.data.joined.get(idHex);
        const b = boxes.get(idHex);
        if (!role || !b || b.conns[role] !== ws) return void ws.close(4403, "not joined");
        const to = other(role);
        const q = b.queue[to];
        const queuedBytes = q.reduce((n, x) => n + x.bytes, 0);
        if (q.length + 1 > limits.queueFrames || queuedBytes + frame.payload.length > limits.queueBytes) {
          // Full: tell the sender, drop this frame, never evict an older one.
          stats.full++;
          return void out(ws, { type: "full", mailbox: b.id });
        }
        const entry: Queued = { seq: b.nextSeq[to]++, tag: frame.tag, payload: frame.payload, at: now(), bytes: frame.payload.length, delivered: false };
        q.push(entry);
        deliver(b, to, entry);
        return;
      }
      case "ack": {
        const idHex = toHex(frame.mailbox);
        const role = ws.data.joined.get(idHex);
        const b = boxes.get(idHex);
        if (!role || !b) return;
        b.queue[role] = b.queue[role].filter((x) => x.seq > frame.seq);
        return;
      }
      default:
        // welcome, deliver, peer, full, replaced are relay-to-client only.
        return void ws.close(4402, "unexpected frame");
    }
  };

  const sweep = (): void => {
    const t = now();
    for (const b of boxes.values()) {
      for (const role of ["core", "device"] as const) {
        const before = b.queue[role].length;
        b.queue[role] = b.queue[role].filter((x) => t - x.at < limits.retentionMs);
        stats.expired += before - b.queue[role].length;
      }
    }
    for (const ws of [...conns]) {
      if (t - ws.data.lastFrameAt >= limits.idleCloseMs) {
        stats.idleClosed++;
        ws.close(1001, "idle");
      }
    }
  };
  const timer = setInterval(sweep, 1000);

  const server = Bun.serve<ConnData>({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req, { data: { hello: false, joined: new Map(), lastFrameAt: now(), recent: [] } })) return undefined;
      return new Response("agetor test relay", { status: 426 });
    },
    websocket: {
      maxPayloadLength: limits.maxFrameBytes,
      idleTimeout: 0,
      open(ws) {
        conns.add(ws);
        stats.connections++;
      },
      message(ws, message) {
        if (typeof message === "string") return void ws.close(4400, "binary only");
        handle(ws, new Uint8Array(message));
      },
      close(ws) {
        conns.delete(ws);
        leave(ws);
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}`,
    port: server.port as number,
    limits,
    stats: () => ({ ...stats }),
    sweep,
    mailboxes: () =>
      [...boxes.entries()].map(([id, b]) => ({ id, core: b.conns.core !== null, device: b.conns.device !== null, queuedForCore: b.queue.core.length, queuedForDevice: b.queue.device.length })),
    dropConnections() {
      for (const ws of [...conns]) ws.close(1012, "relay restart");
    },
    stop() {
      clearInterval(timer);
      for (const ws of [...conns]) ws.close(1001, "stop");
      void server.stop(true);
    },
  };
}

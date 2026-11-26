/**
 * Subscriptions over the session (docs/specs/remote-readiness-spec.md "Sync, streams and the inbox", plan A-8): a phone never opens an
 * SSE route (the router refuses `/events` and `/tasks/:id/events`). It sends `subscribe-task` / `subscribe-global` ops and this module
 * serves them in-process from the SAME broadcasters the SSE routes use.
 *
 *  - `subscribe-task {sub, taskId, afterId?, maxBytes?}` opens `openTaskEventStream` (the one copy of the replay, resume, snapshot and
 *    dedup logic), sends its replay meta as `task-meta` and each event as `task-event` with the phone projection (`projection.ts`).
 *    The first load asks for 256 KB; a snapshot answer is the stream's own (`meta.snapshotRequired`).
 *  - `subscribe-global` forwards only an allowlist of global events as `global-event`.
 *  - BACKPRESSURE: when the session's send queue passes 4 MB the subscription is dropped and the phone is told
 *    `snapshot-required{reason:"backpressure"}`, so a slow phone never grows memory on the Mac.
 *  - PEER PRESENCE: while the relay says the phone is away its subscriptions pause (the streams are released); when it returns they resume
 *    from the last event id (or a snapshot if the replay window passed; the global subscription says `gap` and the phone refetches its
 *    delta).
 */
import { EVENTS_FIRST_LOAD_BYTES, type GlobalEvent, type RunEvent } from "../../shared/types.ts";
import { projectEvent } from "./projection.ts";
import type { PhoneChannel } from "./types.ts";

/** The 4 MB cap on a session's send queue. */
export const BACKPRESSURE_BYTES = 4 * 1024 * 1024;

/**
 * Which global events reach a phone. A new `GlobalEvent` kind breaks the type check here until someone decides (`satisfies Record<…>`),
 * and `subscriptions.test.ts` pins the allowlist.
 */
export const GLOBAL_EVENT_FORWARD = {
  column: true,
  interaction: true,
  pipeline: true,
  "run-status": true,
  "tasks-changed": true,
  "files-sent": true,
  "send-failed": true,
  "harness-swap": true,
  "fx-auto-resume": true,
  // `update` carries a whole task row for the webview's board; the phone reads the delta (`GET /tasks?delta=1`) instead.
  update: false,
} as const satisfies Record<GlobalEvent["kind"], boolean>;

export interface SubscriptionDeps {
  /** Open the shared task stream. Default: `task-event-stream.ts`. */
  openTaskEventStream?: typeof import("../task-event-stream.ts").openTaskEventStream;
  /** Subscribe to the global bus. Default: `orchestrator.subscribeGlobal`. */
  subscribeGlobal?: (fn: (ev: GlobalEvent) => void) => () => void;
  /** Cap on subscriptions per session (a phone that opens a thousand is dropped, never trusted). */
  maxSubscriptions?: number;
}

type TaskStreamHandle = { close(): void; started: Promise<void> };

interface TaskSub {
  kind: "task";
  sub: string;
  taskId: string;
  maxBytes: number | null;
  lastId: number | null;
  handle: TaskStreamHandle | null;
}

interface GlobalSub {
  kind: "global";
  sub: string;
  off: (() => void) | null;
}

export interface Subscriptions {
  subscribeTask(sub: string, taskId: string, afterId: number | null, maxBytes: number | null): void;
  subscribeGlobal(sub: string): void;
  unsubscribe(sub: string): void;
  /** Release every stream (the session ended). */
  closeAll(): void;
  count(): number;
}

export function createSubscriptions(channel: PhoneChannel, deps: SubscriptionDeps = {}): Subscriptions {
  const open = deps.openTaskEventStream ?? ((...a: Parameters<typeof import("../task-event-stream.ts").openTaskEventStream>) =>
    (require("../task-event-stream.ts") as typeof import("../task-event-stream.ts")).openTaskEventStream(...a));
  const subscribeBus = deps.subscribeGlobal ?? ((fn: (ev: GlobalEvent) => void) =>
    (require("../orchestrator.ts") as typeof import("../orchestrator.ts")).subscribeGlobal(fn));
  const max = deps.maxSubscriptions ?? 32;
  const subs = new Map<string, TaskSub | GlobalSub>();
  let closed = false;

  const release = (s: TaskSub | GlobalSub) => {
    if (s.kind === "task") {
      s.handle?.close();
      s.handle = null;
    } else {
      s.off?.();
      s.off = null;
    }
  };

  /** Over the 4 MB cap: drop this subscription and tell the phone to take a snapshot. */
  const overloaded = (s: TaskSub | GlobalSub): boolean => {
    if (channel.queuedBytes() <= BACKPRESSURE_BYTES) return false;
    release(s);
    subs.delete(s.sub);
    channel.send("snapshot-required", { sub: s.sub, reason: "backpressure" });
    return true;
  };

  const startTask = (s: TaskSub, cursor: number | null): void => {
    const handle = open(
      s.taskId,
      {
        cursor,
        ...(s.maxBytes !== null ? { maxBytes: s.maxBytes } : {}),
        // A stream that cannot go on is over: drop it (the phone takes a snapshot and subscribes again) instead of leaving a dead entry
        // that counts against the cap and is restarted at the next peer change.
        onFatal: () => {
          if (subs.get(s.sub) !== s) return;
          release(s);
          subs.delete(s.sub);
          channel.send("snapshot-required", { sub: s.sub, reason: "restart" });
        },
      },
      {
        meta: (meta) => {
          if (subs.get(s.sub) !== s || overloaded(s)) return;
          channel.send("task-meta", { sub: s.sub, taskId: s.taskId, meta });
        },
        event: (ev: RunEvent) => {
          if (subs.get(s.sub) !== s || overloaded(s)) return;
          if (typeof ev.id === "number") s.lastId = Math.max(s.lastId ?? 0, ev.id);
          const p = projectEvent(ev);
          channel.send("task-event", {
            sub: s.sub,
            event: p.raw,
            ...(p.parsed ? { parsed: p.parsed } : {}),
            ...(p.truncated ? { truncated: p.truncated } : {}),
          }, { heavy: p.truncated !== undefined || ev.data.length > 8192 });
        },
      },
    );
    // `onFatal` may have run before `open` returned: then there is no subscription left to attach the handle to.
    if (subs.get(s.sub) === s) s.handle = handle;
    else handle.close();
  };

  const startGlobal = (s: GlobalSub): void => {
    s.off = subscribeBus((ev) => {
      if (subs.get(s.sub) !== s || GLOBAL_EVENT_FORWARD[ev.kind] !== true || overloaded(s)) return;
      channel.send("global-event", { sub: s.sub, event: ev });
    });
  };

  const stopPeerWatch = channel.onPeerChange((present) => {
    if (closed) return;
    for (const s of [...subs.values()]) {
      if (!present) {
        release(s);
      } else if (s.kind === "task") {
        if (!s.handle) startTask(s, s.lastId);
      } else if (!s.off) {
        startGlobal(s);
        channel.send("snapshot-required", { sub: s.sub, reason: "gap" });
      }
    }
  });
  // A channel that already ended answers `onClose` at once, before `api` exists: the watch is registered after it is built.
  let stopCloseWatch: () => void = () => undefined;

  const api: Subscriptions = {
    subscribeTask(sub, taskId, afterId, maxBytes) {
      if (closed) return;
      const existing = subs.get(sub);
      if (existing) {
        release(existing);
        subs.delete(sub);
      }
      if (subs.size >= max) throw new Error("too many subscriptions");
      const s: TaskSub = { kind: "task", sub, taskId, maxBytes: maxBytes ?? EVENTS_FIRST_LOAD_BYTES, lastId: afterId, handle: null };
      subs.set(sub, s);
      if (channel.peerPresent()) startTask(s, afterId);
    },
    subscribeGlobal(sub) {
      if (closed) return;
      const existing = subs.get(sub);
      if (existing) {
        release(existing);
        subs.delete(sub);
      }
      if (subs.size >= max) throw new Error("too many subscriptions");
      const s: GlobalSub = { kind: "global", sub, off: null };
      subs.set(sub, s);
      if (channel.peerPresent()) startGlobal(s);
    },
    unsubscribe(sub) {
      const s = subs.get(sub);
      if (!s) return;
      release(s);
      subs.delete(sub);
    },
    closeAll() {
      closed = true;
      stopPeerWatch();
      stopCloseWatch();
      for (const s of subs.values()) release(s);
      subs.clear();
    },
    count: () => subs.size,
  };
  stopCloseWatch = channel.onClose(() => api.closeAll());
  return api;
}

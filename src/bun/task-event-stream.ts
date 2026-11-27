/**
 * The task event stream: the replay window, forward resume, snapshot answer, live subscription and dedup that
 * `GET /tasks/:id/events` serves (docs/architecture/core-responsiveness.md, "Forward resume"), extracted so the SSE route
 * and the phone subscriptions (remote/subscriptions.ts) share ONE copy instead of drifting apart.
 *
 * `openTaskEventStream` subscribes first (so no live event is missed), reads the replay from the database while live
 * events wait in a buffer, sends `meta` then the replayed rows, drains the buffer, then streams live. A saved row at or
 * below the last id the replay covered is dropped as a duplicate only when the replay sent that very row with that very
 * data (OpenCode rewrites a tool_use row in place and re-broadcasts it under the same id).
 *
 * The caller owns transport concerns: SSE framing and the keep-alive ping (server.ts), session sends (the phone).
 */

import {
  EVENTS_MAX_BYTES_FLOOR,
  EVENTS_REPLAY_ANCHOR_MAX_BYTES,
  EVENTS_REPLAY_ANCHOR_MAX_EVENTS,
  EVENTS_REPLAY_LIMIT,
  EVENTS_REPLAY_MAX_BYTES,
  MIN_REPLAY_EVENTS,
  type RunEvent,
  type TaskEventsReplayMeta,
} from "../shared/types.ts";
import { runs } from "./db-async.ts";
import { subscribe } from "./orchestrator.ts";

export interface TaskEventStreamSink {
  /** The replay-meta frame: sent once, before the replayed rows. */
  meta(m: TaskEventsReplayMeta): void;
  /** A saved row (replayed or live; it has a numeric `id`) or a live-only frame (`interaction`, `subagent`, …; no `id`). */
  event(e: RunEvent): void;
}

export interface OpenTaskEventStreamOpts {
  /** Forward-resume cursor (the last `run_events.id` the client holds), or null for a fresh window. */
  cursor: number | null;
  /** False opts the fresh window out of the last-user-message anchor extension (`?anchor=0`). Default true. */
  anchor?: boolean;
  /** A byte budget for the replay, clamped to [`EVENTS_MAX_BYTES_FLOOR`, `EVENTS_REPLAY_MAX_BYTES`]. Absent: today's behaviour, byte for byte. */
  maxBytes?: number;
  /** Called when the stream ends by itself (the replay read failed): the caller tears its transport down. */
  onFatal?: () => void;
}

export interface TaskEventStreamHandle {
  /** Stop: unsubscribe and drop anything buffered. Idempotent. */
  close(): void;
  /** Resolves when the replay has been sent and the buffer drained (or the stream ended first). Never rejects. */
  started: Promise<void>;
}

/** Clamp a client's `maxBytes` into the allowed range. NaN, non-finite and non-positive values count as absent. */
export function clampMaxBytes(requested: unknown, ceiling: number = EVENTS_REPLAY_MAX_BYTES): number | undefined {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return undefined;
  return Math.max(EVENTS_MAX_BYTES_FLOOR, Math.min(Math.floor(requested), ceiling));
}

/** Parse a `maxBytes` query value (a positive integer string). Anything else is absent, never a 400: a client retries an error forever. */
export function parseMaxBytesParam(raw: string | null, ceiling?: number): number | undefined {
  if (raw === null || !/^\d{1,12}$/.test(raw)) return undefined;
  return clampMaxBytes(Number(raw), ceiling);
}

export function openTaskEventStream(
  taskId: string,
  opts: OpenTaskEventStreamOpts,
  sink: TaskEventStreamSink,
): TaskEventStreamHandle {
  const { cursor } = opts;
  const anchorReplay = opts.anchor !== false;
  const byteBudget = clampMaxBytes(opts.maxBytes);
  const replayBytes = byteBudget ?? EVENTS_REPLAY_MAX_BYTES;
  // With a client budget the "at least this many newest events" floor drops to one, so a small ask returns at most one
  // oversize event beyond the budget instead of twenty.
  const minEvents = byteBudget === undefined ? MIN_REPLAY_EVENTS : 1;

  let closed = false;
  let buffer: RunEvent[] | null = [];
  let replayedThrough = 0;
  const replayedHashes = new Map<number, number | bigint>();

  const send = (e: RunEvent): void => {
    if (closed) return;
    try {
      sink.event(e);
    } catch {
      // The transport went away mid-send; its own teardown (close) owns the cleanup.
    }
  };
  const sendLive = (e: RunEvent): void => {
    if (typeof e.id === "number" && e.id <= replayedThrough) {
      const sent = replayedHashes.get(e.id);
      if (sent !== undefined && sent === Bun.hash(e.data)) return;
    }
    send(e);
  };
  const unsubscribe = subscribe((e) => {
    if (e.taskId !== taskId) return;
    if (buffer) buffer.push(e);
    else sendLive(e);
  });

  const close = (): void => {
    if (closed) return;
    closed = true;
    buffer = null;
    unsubscribe();
  };

  // Shared by the no-cursor connect and the snapshot answer, so a snapshot is exactly the window a fresh connect would get.
  const freshWindow = async () => {
    const window = await runs.eventsForTask(taskId, {
      limit: EVENTS_REPLAY_LIMIT,
      maxBytes: replayBytes,
      minEvents,
      ...(anchorReplay
        ? {
            anchor: {
              maxEvents: EVENTS_REPLAY_ANCHOR_MAX_EVENTS,
              maxBytes: byteBudget === undefined ? EVENTS_REPLAY_ANCHOR_MAX_BYTES : Math.min(EVENTS_REPLAY_ANCHOR_MAX_BYTES, byteBudget),
            },
          }
        : {}),
    });
    const earliestId = window.length > 0 ? window[0]!.id : null;
    const hasMore = earliestId !== null && (await runs.hasEventsBefore(taskId, earliestId));
    return { window, earliestId, hasMore };
  };

  const run = async (): Promise<void> => {
    let meta: TaskEventsReplayMeta;
    let replay: Awaited<ReturnType<typeof freshWindow>>["window"];
    try {
      if (cursor === null) {
        const fresh = await freshWindow();
        meta = { earliestId: fresh.earliestId, hasMore: fresh.hasMore };
        replay = fresh.window;
      } else {
        // Resume: only the rows after the cursor, subagent rows included. `earliestId`/`hasMore` describe a window, which a
        // resume doesn't send, so the client is told to leave its own alone. Snapshot (gap too big, or a cursor from another
        // database): the fresh window plus `snapshotRequired`, so the client replaces what it holds.
        const after = await runs.eventsForTaskAfter(taskId, cursor, { maxEvents: EVENTS_REPLAY_LIMIT, maxBytes: replayBytes });
        if (after.kind === "resume") {
          meta = { earliestId: null, hasMore: false, resumedAfter: cursor };
          replay = after.rows;
          // The client holds everything up to its cursor already.
          replayedThrough = cursor;
        } else {
          const fresh = await freshWindow();
          meta = { earliestId: fresh.earliestId, hasMore: fresh.hasMore, snapshotRequired: true };
          replay = fresh.window;
        }
      }
    } catch (err) {
      // The database worker is restarting or gone: end the stream; the client reconnects with its cursor and resumes.
      console.warn(`[agetor] /tasks/${taskId}/events replay failed:`, (err as Error)?.message ?? String(err));
      close();
      opts.onFatal?.();
      return;
    }
    if (closed) return;
    for (const ev of replay) {
      replayedThrough = Math.max(replayedThrough, ev.id);
      replayedHashes.set(ev.id, Bun.hash(ev.data));
    }
    try {
      sink.meta(meta);
    } catch {
      /* the transport went away; close() handles it */
    }
    for (const ev of replay) {
      send({
        id: ev.id,
        runId: ev.runId,
        taskId,
        stream: ev.stream as RunEvent["stream"],
        data: ev.data,
        ts: ev.ts,
        subagentId: ev.subagentId,
      });
    }
    const drained = buffer;
    buffer = null;
    if (drained) for (const ev of drained) sendLive(ev);
  };

  return { close, started: run().catch(() => undefined) };
}

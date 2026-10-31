import { useEffect, useRef, useState } from "react";
import { streamSse, type SseHandle } from "../sse.ts";
import { foldToolUseRevisions } from "../../shared/tool-use-revisions.ts";
import type { RunEvent } from "../../shared/types.ts";
import {
  TASK_STREAM_GAP_NOTICE,
  classifyReplayMeta,
  createIdHighWater,
  parseReplayMeta,
} from "../../shared/task-stream-resume.ts";

const TICK_MS = 33; // ~30fps flush — one state commit per tick, never per event
const MAX_LINES = 500; // ring-buffer cap on rendered scrollback

/**
 * Stream a task's conversation with the three anti-lag guardrails from the
 * known RunPanel O(N²) bug: (1) BATCH — buffer incoming events and commit once
 * per tick, never setState per frame; (2) VIRTUALIZE — keep only the last
 * MAX_LINES; (3) DEDUPE — collapse the replay/live overlap, first on the
 * server row id (a high-water mark, so a reconnect that re-delivers part of
 * the window adds nothing) and then on a payload-aware key. Cursor tool
 * revisions are kept and folded onto one row before the cap.
 *
 * Forward resume: `streamSse` echoes the last event id on reconnect, so the
 * server normally sends just the gap. When it can't (`replay_meta` carries
 * `snapshotRequired`) it sends a fresh window instead; the visible lines are
 * then replaced by a dim notice plus that window rather than stacked on top.
 */
export function useCoalescedStream(
  taskId: string | null,
  dataDir?: string,
): RunEvent[] {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const buffer = useRef<RunEvent[]>([]);
  const seen = useRef<Set<string>>(new Set());
  // Synchronous mirror of `events` so the flush can compute the next slice and
  // prune the dedup set without doing either inside the (deferred, must-stay-
  // pure) setState updater.
  const live = useRef<RunEvent[]>([]);

  useEffect(() => {
    setEvents([]);
    buffer.current = [];
    live.current = [];
    seen.current = new Set();
    // Highest server row id accepted; reset when a snapshot replaces the window.
    const highWater = createIdHighWater();
    if (!taskId) return;

    const flush = setInterval(() => {
      if (buffer.current.length === 0) return;
      const batch = buffer.current;
      buffer.current = [];
      const next = foldToolUseRevisions(live.current.concat(batch));
      const trimmed =
        next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      live.current = trimmed;
      // Keep the dedup set bounded to the retained (displayed) window — those
      // are exactly the events a reconnect replay could duplicate. Done here,
      // with `buffer` already drained, not inside the setState updater.
      if (seen.current.size > MAX_LINES * 2) {
        seen.current = new Set(trimmed.map(eventKey));
      }
      setEvents(trimmed);
    }, TICK_MS);

    // `?anchor=0`: skip the server's last-user-message window extension
    // (up to 3000 events / 16 MB on the webview's behalf) — this hook keeps
    // only MAX_LINES, so the extra history would be fetched and discarded.
    const handle: SseHandle = streamSse<RunEvent>(
      `/tasks/${taskId}/events?anchor=0`,
      (e) => {
        if (!highWater.accept(e.id)) return;
        const key = eventKey(e);
        if (seen.current.has(key)) return;
        seen.current.add(key);
        buffer.current.push(e);
      },
      {
        dataDir,
        onNamedEvent: (event, data) => {
          if (event !== "replay_meta") return;
          const meta = parseReplayMeta(data);
          if (!meta || classifyReplayMeta(meta) !== "snapshot") return;
          // The window that follows replaces everything shown. The notice is a
          // synthetic id-less status row, so the mark never sees it; the next
          // flush commits it ahead of the fresh rows.
          highWater.reset();
          seen.current = new Set();
          live.current = [];
          buffer.current = [
            {
              runId: "",
              taskId,
              stream: "status",
              data: TASK_STREAM_GAP_NOTICE,
              ts: Date.now(),
            },
          ];
        },
      },
    );

    return () => {
      clearInterval(flush);
      handle.close();
    };
  }, [taskId, dataDir]);

  return events;
}

/** Prefix kept from the old key, plus the length and the tail. Two tool
 *  payloads that share a timestamp and the first 64 characters still
 *  differ once `rawInput` grows. An exact replay (same length, prefix,
 *  and tail) still collapses. */
function streamDataKey(data: string): string {
  if (data.length <= 64) return data;
  return `${data.length}:${data.slice(0, 64)}:${data.slice(-80)}`;
}

export function eventKey(e: RunEvent): string {
  return `${e.ts}|${e.stream}|${streamDataKey(e.data ?? "")}`;
}

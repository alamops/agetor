import { useEffect, useRef, useState } from "react";
import { streamSse, type SseHandle } from "../sse.ts";
import type { RunEvent } from "../../shared/types.ts";

const TICK_MS = 33; // ~30fps flush — one state commit per tick, never per event
const MAX_LINES = 500; // ring-buffer cap on rendered scrollback

/**
 * Stream a task's conversation with the three anti-lag guardrails from the
 * known RunPanel O(N²) bug: (1) BATCH — buffer incoming events and commit once
 * per tick, never setState per frame; (2) VIRTUALIZE — keep only the last
 * MAX_LINES; (3) DEDUPE — collapse the replay/live overlap on the server's
 * documented `ts|stream|data-prefix` key (also used as the React render key).
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
    if (!taskId) return;

    const flush = setInterval(() => {
      if (buffer.current.length === 0) return;
      const batch = buffer.current;
      buffer.current = [];
      const next = live.current.concat(batch);
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

    const handle: SseHandle = streamSse<RunEvent>(
      `/tasks/${taskId}/events`,
      (e) => {
        const key = eventKey(e);
        if (seen.current.has(key)) return;
        seen.current.add(key);
        buffer.current.push(e);
      },
      { dataDir },
    );

    return () => {
      clearInterval(flush);
      handle.close();
    };
  }, [taskId, dataDir]);

  return events;
}

export function eventKey(e: RunEvent): string {
  return `${e.ts}|${e.stream}|${e.data.slice(0, 64)}`;
}

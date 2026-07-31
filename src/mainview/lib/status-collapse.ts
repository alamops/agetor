// Collapse for the already-persisted "permission-mode: <mode>" status spam
// the unified task-level event stream renders.
//
// Claude journals a mode-bearing JSONL event at every turn start, and the
// server used to unconditionally translate each one into a `status` chunk —
// so a long-running task's `run_events` history can carry many identical
// `permission-mode: auto` chips in a row, one per turn, even though the mode
// never actually changed. The server now emits these on-change only (see
// `mapParsedEventToChunks` in `claude-tmux.ts`), which stops NEW spam, but it
// can't rewrite history that's already persisted. This collapses that
// backlog client-side at render time so old tasks display clean too.
import type { RunEvent } from "../../shared/types.ts";

const PERMISSION_MODE_PREFIX = "permission-mode: ";

/**
 * Drop repeated `permission-mode: <mode>` status events that carry the same
 * value as the previously-KEPT one, regardless of how many other events
 * (any stream, or other status text) are interleaved between them — those
 * pass through untouched and don't reset the tracked value. A permission-mode
 * status with a *different* value is always kept and becomes the new tracked
 * value, so `auto, auto, plan, plan, auto` collapses to `auto, plan, auto`.
 *
 * Does not mutate `events`.
 */
export function collapseRepeatedModeStatus(events: RunEvent[]): RunEvent[] {
  const out: RunEvent[] = [];
  let lastModeStatus: string | null = null;
  for (const e of events) {
    if (e.stream === "status" && e.data?.startsWith(PERMISSION_MODE_PREFIX)) {
      if (e.data === lastModeStatus) continue;
      lastModeStatus = e.data;
    }
    out.push(e);
  }
  return out;
}

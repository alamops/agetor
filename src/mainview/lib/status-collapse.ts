// Collapse for two kinds of already-persisted status spam the unified
// task-level event stream renders: repeated `permission-mode: <mode>` chips,
// and repeated "session hibernated after 30m idle — …" chips.
//
// permission-mode: Claude journals a mode-bearing JSONL event at every turn
// start, and the server used to unconditionally translate each one into a
// `status` chunk — so a long-running task's `run_events` history can carry
// many identical `permission-mode: auto` chips in a row, one per turn, even
// though the mode never actually changed. The server now emits these
// on-change only (see `mapParsedEventToChunks` in `claude-tmux.ts`), which
// stops NEW spam, but it can't rewrite history that's already persisted.
//
// session hibernated: a tmux 3.6a bug in `probeSessionActivity`'s
// `display-message` probe made it report every session as "never attached,
// idle since 1970" regardless of actual state, so the idle-session reaper
// re-reaped (and re-appended the hibernate breadcrumb for) the same
// finished task on every 5-minute sweep — up to 50 consecutive identical
// rows per run in production. See
// docs/plans/fix-permission-mode-status-spam.md ("Follow-up") for the root
// cause and the server-side probe fix (F1) + idempotence guard (F2); this is
// the client-side cleanup (F3) for the backlog those already wrote.
//
// This helper collapses both kinds of backlog client-side at render time so
// old tasks display clean without a DB rewrite.
import type { RunEvent } from "../../shared/types.ts";

const PERMISSION_MODE_PREFIX = "permission-mode: ";
const HIBERNATE_PREFIX = "session hibernated after ";

/**
 * Drop repeated `permission-mode: <mode>` status events that carry the same
 * value as the previously-KEPT one, regardless of how many other events
 * (any stream, or other status text) are interleaved between them — those
 * pass through untouched and don't reset the tracked value. A permission-mode
 * status with a *different* value is always kept and becomes the new tracked
 * value, so `auto, auto, plan, plan, auto` collapses to `auto, plan, auto`.
 *
 * Separately, drop a "session hibernated after …" status event when the
 * IMMEDIATELY-preceding kept event is a SAME-RUN status event with
 * byte-identical `data`. This adjacency rule is deliberately different from
 * the permission-mode tracker above: unlike a mode change, a genuine *later*
 * hibernate always has user/agent events in between (resuming a session
 * creates new events before it can idle out again), so only truly
 * back-to-back identical chips are reaper spam — any intervening event, even
 * an unrelated status line, means the next one is real and must be kept.
 * Reaper spam is always same-run consecutive (`reapIdleSessions` appends to
 * the task's newest run), which is why the rule requires a matching `runId`:
 * the main tab's JSONL-rebuild path re-stamps a rebuilt run's events with
 * synthetic clustered timestamps and keeps only `status` events from live
 * history, which can sort two different runs' genuine hibernate breadcrumbs
 * adjacent — those must both survive. Two different hibernate message
 * variants exist ("— next message will resume it" vs "— no saved session id,
 * next message starts a fresh context"); comparing `data` byte-for-byte
 * handles both without special-casing the wording.
 *
 * Does not mutate `events`.
 */
export function collapseRepeatedStatusChips(events: RunEvent[]): RunEvent[] {
  const out: RunEvent[] = [];
  let lastModeStatus: string | null = null;
  for (const e of events) {
    if (e.stream === "status" && e.data?.startsWith(PERMISSION_MODE_PREFIX)) {
      if (e.data === lastModeStatus) continue;
      lastModeStatus = e.data;
    }
    if (e.stream === "status" && e.data?.startsWith(HIBERNATE_PREFIX)) {
      const prev = out[out.length - 1];
      if (prev && prev.runId === e.runId && prev.stream === "status" && prev.data === e.data) continue;
    }
    out.push(e);
  }
  return out;
}

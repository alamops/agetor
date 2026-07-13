// Pure decision helper for RunPanel's "rebuild from session JSONL" snapshot.
//
// Background: once a run leaves `status: "running"`, RunPanel re-parses the
// claude session JSONL and stores it as `rebuilt` — `displayedEvents` then
// splices those events in place of the live ones for every run sharing the
// snapshot's `claudeSessionId` (see `rebuiltRunIds` in RunPanel.tsx). That
// splice is a point-in-time snapshot: claude legitimately keeps emitting into
// the SAME session after a run resolves (a post-`end_turn` background-agent
// continuation is the main case), and without this check those later events
// are silently swallowed — the log looks frozen even though data is still
// flowing server-side. This module answers "does this incoming live event
// mean the snapshot is now stale and should be dropped?" so RunPanel can fall
// back to the live stream the moment that happens. It has no React/DOM
// dependency so it's unit-testable on its own (see the paired test task).

/** The subset of `rebuilt` state this check needs. */
export interface RebuiltSnapshotMeta {
  /**
   * The highest client-assigned event id RunPanel had observed at the moment
   * the snapshot was captured. Events at or below this id were already
   * accounted for (either folded into the snapshot or superseded by it), so
   * they must never re-trigger invalidation — this is what makes the check
   * safe against the server's SSE replay-on-(re)connect burst, which
   * re-delivers the full history (including old ids) on every subscribe.
   */
  maxLiveEventIdAtSnapshot: number;
}

/** The subset of a streamed event this check needs. RunPanel doesn't get a
 *  stable event id from the wire (the server doesn't expose `run_events.id`
 *  over SSE), so it assigns one client-side as events arrive — see
 *  `nextEventIdRef` in RunPanel.tsx. */
export interface RebuiltMaskEvent {
  id: number;
  runId: string;
  /** Set when this event belongs to a background/sub agent's stream rather
   *  than the task's main agent stream. Mirrors `RunEvent.subagentId`. */
  subagentId?: string | null;
}

/**
 * Does `event` invalidate the current rebuilt-from-JSONL snapshot?
 *
 * True only when ALL of:
 *  - the event is on the MAIN stream (no `subagentId`) — the rebuild splice
 *    only ever covers the main session transcript, and a subagent tab renders
 *    its own events directly (no rebuilt path applies there), so a subagent
 *    event can never make the main snapshot stale;
 *  - the event's `runId` is one the snapshot is currently standing in for
 *    (`maskedRunIds` — RunPanel's `rebuiltRunIds`, every run sharing the
 *    snapshot's `claudeSessionId`); an event for an unrelated run/session
 *    doesn't affect what the snapshot is displaying;
 *  - the event is strictly newer than everything the snapshot already
 *    accounts for (`id > maxLiveEventIdAtSnapshot`) — guards against the SSE
 *    replay burst (full history re-delivered on every reconnect) re-tripping
 *    the clear on events that predate the snapshot.
 */
export function invalidatesRebuiltSnapshot(
  snapshot: RebuiltSnapshotMeta,
  event: RebuiltMaskEvent,
  maskedRunIds: ReadonlySet<string>,
): boolean {
  if (event.subagentId) return false;
  if (event.id <= snapshot.maxLiveEventIdAtSnapshot) return false;
  return maskedRunIds.has(event.runId);
}

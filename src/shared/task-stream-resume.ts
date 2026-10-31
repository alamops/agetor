/**
 * Client-side helpers for forward resume of `GET /tasks/:id/events`
 * (`docs/plans/event-stream-forward-resume.md`). Three clients — the RunPanel,
 * the TUI dashboard and `agetor logs` — must agree on what a `replay_meta`
 * frame means and how to drop already-seen rows, so that logic lives here, the
 * only module both processes may import.
 */
import type { TaskEventsReplayMeta } from "./types.ts";

/** What a `replay_meta` frame asks the client to do. */
export type ReplayMetaKind = "fresh" | "resumed" | "snapshot";

/**
 * - `snapshot`: the server could not resume; reset local state and replace
 *   `earliestId` / `hasMore` from this meta.
 * - `resumed`: the rows that follow are the gap after the client's cursor;
 *   keep the window and ignore `earliestId` / `hasMore`.
 * - `fresh`: a plain connect (no cursor sent) — today's handling. This also
 *   covers an older core that knows neither field.
 */
export function classifyReplayMeta(meta: TaskEventsReplayMeta): ReplayMetaKind {
  if (meta.snapshotRequired === true) return "snapshot";
  if (typeof meta.resumedAfter === "number") return "resumed";
  return "fresh";
}

/**
 * Parse a `replay_meta` frame's data. Returns `null` on bad JSON or when the
 * required fields (`earliestId`: number | null, `hasMore`: boolean) have the
 * wrong shape. The optional fields are validated loosely: a wrong-typed
 * `resumedAfter` / `snapshotRequired` is dropped (the meta then classifies as
 * `fresh`) rather than rejecting the frame, so a garbled hint can never make a
 * client lose the window info it does understand.
 */
export function parseReplayMeta(data: string): TaskEventsReplayMeta | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const { earliestId, hasMore } = r;
  if (earliestId !== null && typeof earliestId !== "number") return null;
  if (typeof earliestId === "number" && !Number.isFinite(earliestId)) return null;
  if (typeof hasMore !== "boolean") return null;
  const meta: TaskEventsReplayMeta = { earliestId, hasMore };
  if (typeof r.resumedAfter === "number" && Number.isFinite(r.resumedAfter)) {
    meta.resumedAfter = r.resumedAfter;
  }
  if (r.snapshotRequired === true) meta.snapshotRequired = true;
  return meta;
}

export interface IdHighWater {
  /** True when the frame should be processed: its id is not a number
   *  (id-less, live-only frames always pass) or is above the mark, which it
   *  then becomes. False for an id at or below the mark (a duplicate). */
  accept(id: unknown): boolean;
  /** Forget the mark (a snapshot replaced everything the client had). */
  reset(): void;
  /** The highest accepted id, or `null` before any. */
  readonly highest: number | null;
}

/** The consumer's "highest server id accepted" — kept separate from the
 *  transport's last SSE id so a duplicate after a reconnect is dropped. */
export function createIdHighWater(): IdHighWater {
  let highest: number | null = null;
  return {
    accept(id: unknown): boolean {
      if (typeof id !== "number") return true;
      if (highest !== null && id <= highest) return false;
      highest = id;
      return true;
    },
    reset(): void {
      highest = null;
    },
    get highest(): number | null {
      return highest;
    },
  };
}

/** Shown (RunPanel toast, TUI status) when a reconnect had to fall back to a
 *  fresh window because the gap was too large to replay. */
export const TASK_STREAM_GAP_NOTICE = "Reconnected after a long gap — showing the latest messages";

/** Same situation for `agetor logs`, which prints rather than re-renders. */
export const LOGS_STREAM_GAP_NOTICE = "…gap too large — skipped older events, showing the latest";

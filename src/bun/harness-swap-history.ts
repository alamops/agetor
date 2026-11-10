/**
 * Per-stack swap history (`harness_swap_events`, migration 087). One row per
 * account move or refused move, newest first, cursor-paged. Labels and the task
 * title are denormalized and there is no foreign key to tasks or harnesses, so
 * a row still reads after either is deleted; the rows go with the stack
 * (`ON DELETE CASCADE`). See docs/architecture/harness-stacks.md.
 */
import { randomUUID } from "node:crypto";
import type { HarnessSwapEvent, HarnessSwapHistoryPage, HarnessSwapTrigger } from "../shared/types.ts";
import { db } from "./db.ts";

export const SWAP_HISTORY_DEFAULT_LIMIT = 50;
export const SWAP_HISTORY_MAX_LIMIT = 200;

type SwapRow = {
  id: string;
  stack_id: string;
  task_id: string | null;
  task_title: string | null;
  from_harness_id: string | null;
  from_label: string | null;
  to_harness_id: string | null;
  to_label: string | null;
  trigger: string;
  reason: string | null;
  source: string | null;
  message: string | null;
  model: string | null;
  resets_at_ms: number | null;
  from_run_id: string | null;
  to_run_id: string | null;
  continuation: string | null;
  at: number;
};

const TRIGGERS: ReadonlySet<string> = new Set<HarnessSwapTrigger>([
  "limit", "retry", "manual", "scheduled", "unavailable", "boot-resume", "blocked",
]);
const REASONS: ReadonlySet<string> = new Set([
  "quota", "rate_limit", "insufficient_credits", "no-usable-member", "member-removed",
  "member-disabled", "member-unavailable", "user",
]);
const SOURCES: ReadonlySet<string> = new Set(["claude-pane", "claude-api-error", "codex-error"]);
const CONTINUATIONS: ReadonlySet<string> = new Set(["transferred", "restarted"]);

/** Insert-time check: the trigger must be known and the optional unions
 *  (null allowed) must hold. Throws; nothing is written. */
function assertValid(e: Pick<HarnessSwapEvent, "trigger" | "reason" | "source" | "continuation">): void {
  if (!TRIGGERS.has(e.trigger)) throw new Error(`invalid swap-history trigger: ${String(e.trigger)}`);
  if (e.reason !== null && !REASONS.has(e.reason)) throw new Error(`invalid swap-history reason: ${String(e.reason)}`);
  if (e.source !== null && !SOURCES.has(e.source)) throw new Error(`invalid swap-history source: ${String(e.source)}`);
  if (e.continuation !== null && !CONTINUATIONS.has(e.continuation)) {
    throw new Error(`invalid swap-history continuation: ${String(e.continuation)}`);
  }
}

/** Read-time mapping. The database is agent-writable, so an unknown trigger
 *  DROPS the row (null: it never reaches a caller as a typed value); an
 *  unknown reason/source/continuation is coerced to null. */
function toEvent(row: SwapRow): HarnessSwapEvent | null {
  if (!TRIGGERS.has(row.trigger)) return null;
  return {
    id: row.id,
    stackId: row.stack_id,
    taskId: row.task_id,
    taskTitle: row.task_title,
    fromHarnessId: row.from_harness_id,
    fromLabel: row.from_label,
    toHarnessId: row.to_harness_id,
    toLabel: row.to_label,
    trigger: row.trigger as HarnessSwapEvent["trigger"],
    reason: row.reason !== null && REASONS.has(row.reason) ? (row.reason as HarnessSwapEvent["reason"]) : null,
    source: row.source !== null && SOURCES.has(row.source) ? (row.source as HarnessSwapEvent["source"]) : null,
    message: row.message,
    model: row.model,
    resetsAtMs: row.resets_at_ms,
    fromRunId: row.from_run_id,
    toRunId: row.to_run_id,
    continuation: row.continuation !== null && CONTINUATIONS.has(row.continuation)
      ? (row.continuation as HarnessSwapEvent["continuation"])
      : null,
    at: row.at,
  };
}

function encodeCursor(at: number, id: string): string {
  return Buffer.from(JSON.stringify([at, id]), "utf8").toString("base64url");
}

/** A malformed or tampered cursor decodes to null, which the caller treats as
 *  "first page". */
function decodeCursor(cursor: string | null | undefined): { at: number; id: string } | null {
  if (!cursor || cursor.length > 512) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [at, id] = parsed;
    if (typeof at !== "number" || !Number.isSafeInteger(at) || typeof id !== "string") return null;
    return { at, id };
  } catch {
    return null;
  }
}

export const harnessSwapEvents = {
  insert(e: Omit<HarnessSwapEvent, "id" | "at"> & { at?: number }): HarnessSwapEvent {
    assertValid(e);
    const id = randomUUID();
    const at = e.at ?? Date.now();
    db.run(
      `INSERT INTO harness_swap_events
         (id, stack_id, task_id, task_title, from_harness_id, from_label, to_harness_id, to_label,
          trigger, reason, source, message, model, resets_at_ms, from_run_id, to_run_id, continuation, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, e.stackId, e.taskId, e.taskTitle, e.fromHarnessId, e.fromLabel, e.toHarnessId, e.toLabel,
        e.trigger, e.reason, e.source, e.message, e.model, e.resetsAtMs, e.fromRunId, e.toRunId, e.continuation, at,
      ],
    );
    return { ...e, id, at };
  },
  /** Newest first by `(at, id)`; `before` is the previous page's `nextCursor`. */
  page(stackId: string, opts: { limit?: number; before?: string | null } = {}): HarnessSwapHistoryPage {
    const requested = Number.isFinite(opts.limit) ? Math.floor(opts.limit as number) : SWAP_HISTORY_DEFAULT_LIMIT;
    const limit = Math.min(Math.max(requested, 1), SWAP_HISTORY_MAX_LIMIT);
    const cursor = decodeCursor(opts.before);
    const rows = cursor
      ? db
          .query<SwapRow, [string, number, string, number]>(
            `SELECT * FROM harness_swap_events
              WHERE stack_id = ? AND (at, id) < (?, ?)
              ORDER BY at DESC, id DESC LIMIT ?`,
          )
          .all(stackId, cursor.at, cursor.id, limit + 1)
      : db
          .query<SwapRow, [string, number]>(
            `SELECT * FROM harness_swap_events WHERE stack_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
          )
          .all(stackId, limit + 1);
    const hasMore = rows.length > limit;
    const kept = rows.slice(0, limit);
    // The cursor comes from the last RAW row so a dropped (invalid) row at the
    // page end cannot stall paging.
    const lastRaw = kept[kept.length - 1];
    const events = kept.map(toEvent).filter((ev): ev is HarnessSwapEvent => ev !== null);
    return { events, nextCursor: hasMore && lastRaw ? encodeCursor(lastRaw.at, lastRaw.id) : null };
  },
  countForStack(stackId: string): number {
    const row = db
      .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM harness_swap_events WHERE stack_id = ?`)
      .get(stackId);
    return row?.n ?? 0;
  },
};

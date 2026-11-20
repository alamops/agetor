import type { Database } from "bun:sqlite";
import { defineOp, type OpCtx } from "./define.ts";

// Row shapes of the harness-stack tables, as stored. `harness-stacks.ts` maps
// them to the API shapes on the main thread; an op returns them raw.

export interface StackDbRow {
  id: string;
  label: string;
  kind: string;
  mirror_mode: string;
  created_at: number;
  updated_at: number;
}

export interface StackMemberDbRow {
  stack_id: string;
  harness_id: string;
  position: number;
}

export interface LimitDbRow {
  harness_id: string;
  model: string;
  reason: string;
  source: string;
  message: string | null;
  exhausted_until_ms: number;
  updated_at: number;
}

export interface StackWithMembers {
  stack: StackDbRow;
  members: StackMemberDbRow[];
}

function membersOf(conn: Database, stackId: string): StackMemberDbRow[] {
  return conn
    .query(`SELECT * FROM harness_stack_members WHERE stack_id = ? ORDER BY position ASC`)
    .all(stackId) as StackMemberDbRow[];
}

function getStack(conn: Database, id: string): StackWithMembers | null {
  const stack = conn.query(`SELECT * FROM harness_stacks WHERE id = ?`).get(id) as StackDbRow | null;
  return stack ? { stack, members: membersOf(conn, id) } : null;
}

function insertMembers(conn: Database, stackId: string, members: string[]): void {
  const insert = conn.query(`INSERT INTO harness_stack_members (stack_id, harness_id, position) VALUES (?, ?, ?)`);
  members.forEach((harnessId, position) => {
    insert.run(stackId, harnessId, position);
  });
}

/** Clear every task's harness state that names `stackId`, without bumping
 *  `updated_at` (see `tasks.setHarnessState`). Runs on the connection it is
 *  given, so a caller already in a transaction stays in it. */
function clearTaskStateForStackOn({ conn, modules }: OpCtx, stackId: string): number {
  const rows = conn.query(`SELECT id FROM tasks WHERE harness_state IS NOT NULL`).all() as { id: string }[];
  let cleared = 0;
  for (const row of rows) {
    const state = modules.tasks.get(row.id)?.harnessState;
    if (state?.stackId !== stackId) continue;
    modules.tasks.setHarnessState(row.id, null);
    cleared++;
  }
  return cleared;
}

export type StackUpdateOutcome = "ok" | "missing" | "changed";

export const harnessStacksOps = {
  /** Every stack and every membership, in the order the listing shows them. */
  "stacks.snapshot": defineOp({
    tx: false,
    run: ({ conn }): { stacks: StackDbRow[]; members: StackMemberDbRow[] } => ({
      stacks: conn.query(`SELECT * FROM harness_stacks ORDER BY created_at ASC`).all() as StackDbRow[],
      members: conn
        .query(`SELECT * FROM harness_stack_members ORDER BY stack_id ASC, position ASC`)
        .all() as StackMemberDbRow[],
    }),
  }),
  "stacks.get": defineOp({
    tx: false,
    run: ({ conn }, id: string): StackWithMembers | null => getStack(conn, id),
  }),
  "stacks.getByMember": defineOp({
    tx: false,
    run: ({ conn }, harnessId: string): StackWithMembers | null => {
      const row = conn
        .query(`SELECT stack_id FROM harness_stack_members WHERE harness_id = ?`)
        .get(harnessId) as { stack_id: string } | null;
      return row ? getStack(conn, row.stack_id) : null;
    },
  }),
  /** The stack each of `harnessIds` belongs to (absent: in none). */
  "stacks.memberships": defineOp({
    tx: false,
    run: ({ conn }, harnessIds: string[]): Record<string, string> => {
      const query = conn.query(`SELECT stack_id FROM harness_stack_members WHERE harness_id = ?`);
      const out: Record<string, string> = {};
      for (const id of harnessIds) {
        const row = query.get(id) as { stack_id: string } | null;
        if (row) out[id] = row.stack_id;
      }
      return out;
    },
  }),
  "stacks.create": defineOp({
    tx: true,
    run: (
      { conn },
      id: string, label: string, kind: string, mirrorMode: string, now: number, members: string[],
    ): null => {
      conn.query(
        `INSERT INTO harness_stacks (id, label, kind, mirror_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, label, kind, mirrorMode, now, now);
      insertMembers(conn, id, members);
      return null;
    },
  }),
  /** Replace a stack's fields and its full ordered membership. `expectedUpdatedAt`
   *  is the authoritative stale-draft check (null: none). */
  "stacks.update": defineOp({
    tx: true,
    run: (
      { conn },
      id: string, label: string, kind: string, mirrorMode: string, now: number, members: string[],
      expectedUpdatedAt: number | null,
    ): StackUpdateOutcome => {
      const stored = conn.query(`SELECT updated_at FROM harness_stacks WHERE id = ?`).get(id) as { updated_at: number } | null;
      if (!stored) return "missing";
      if (expectedUpdatedAt !== null && stored.updated_at !== expectedUpdatedAt) return "changed";
      // Strictly increasing, so two edits inside one millisecond still differ
      // and the second editor's `expectedUpdatedAt` conflicts.
      const stamp = Math.max(now, stored.updated_at + 1);
      conn.query(`UPDATE harness_stacks SET label = ?, kind = ?, mirror_mode = ?, updated_at = ? WHERE id = ?`)
        .run(label, kind, mirrorMode, stamp, id);
      conn.query(`DELETE FROM harness_stack_members WHERE stack_id = ?`).run(id);
      insertMembers(conn, id, members);
      return "ok";
    },
  }),
  /** Delete a stack and clear the failover state of every task that names it, together. */
  "stacks.delete": defineOp({
    tx: true,
    run: (ctx, id: string): null => {
      ctx.conn.query(`DELETE FROM harness_stacks WHERE id = ?`).run(id);
      clearTaskStateForStackOn(ctx, id);
      return null;
    },
  }),
  "stacks.clearTaskState": defineOp({
    tx: true,
    run: (ctx, stackId: string): number => clearTaskStateForStackOn(ctx, stackId),
  }),

  /** Write (or replace) a cooldown row, sweeping expired rows first. Returns the
   *  stored `exhausted_until_ms`: a fallback (no provider reset) never SHORTENS a
   *  later reset still active on the same row. */
  "limit.set": defineOp({
    tx: true,
    run: (
      { conn },
      harnessId: string, model: string, reason: string, source: string, message: string | null,
      resetAtMs: number | null, fallbackMs: number, now: number,
    ): number => {
      conn.query(`DELETE FROM harness_limit_state WHERE exhausted_until_ms <= ?`).run(now);
      const nextUntil = resetAtMs ?? now + fallbackMs;
      const existing = conn
        .query(`SELECT * FROM harness_limit_state WHERE harness_id = ? AND model = ?`)
        .get(harnessId, model) as LimitDbRow | null;
      const exhaustedUntilMs = resetAtMs === null && existing !== null && existing.exhausted_until_ms > nextUntil
        ? existing.exhausted_until_ms
        : nextUntil;
      conn.query(
        `INSERT INTO harness_limit_state
         (harness_id, model, reason, source, message, exhausted_until_ms, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(harness_id, model) DO UPDATE SET
         reason = excluded.reason,
         source = excluded.source,
         message = excluded.message,
         exhausted_until_ms = excluded.exhausted_until_ms,
         updated_at = excluded.updated_at`,
      ).run(harnessId, model, reason, source, message, exhaustedUntilMs, now);
      return exhaustedUntilMs;
    },
  }),
  /** The account-wide row and (when `model` is not "") that model's row. */
  "limit.rowsFor": defineOp({
    tx: false,
    run: ({ conn }, harnessId: string, model: string): LimitDbRow[] =>
      (model
        ? conn.query(`SELECT * FROM harness_limit_state WHERE harness_id = ? AND model IN ('', ?)`).all(harnessId, model)
        : conn.query(`SELECT * FROM harness_limit_state WHERE harness_id = ? AND model = ''`).all(harnessId)) as LimitDbRow[],
  }),
  "limit.list": defineOp({
    tx: false,
    run: ({ conn }): LimitDbRow[] =>
      conn.query(`SELECT * FROM harness_limit_state ORDER BY exhausted_until_ms ASC, harness_id ASC, model ASC`).all() as LimitDbRow[],
  }),
  /** Clear cooldown rows of one account: `startedAtMs` (rows written at or before
   *  it, account-wide and `model`'s), `accountWideOnly`, `model` alone, or all. */
  "limit.clear": defineOp({
    tx: false,
    run: (
      { conn },
      harnessId: string, mode: "startedAt" | "accountWide" | "model" | "all", model: string, startedAtMs: number,
    ): null => {
      if (mode === "startedAt") {
        conn.query(`DELETE FROM harness_limit_state WHERE harness_id = ? AND updated_at <= ? AND model IN ('', ?)`)
          .run(harnessId, startedAtMs, model);
      } else if (mode === "accountWide") {
        conn.query(`DELETE FROM harness_limit_state WHERE harness_id = ? AND model = ''`).run(harnessId);
      } else if (mode === "model") {
        conn.query(`DELETE FROM harness_limit_state WHERE harness_id = ? AND model = ?`).run(harnessId, model);
      } else {
        conn.query(`DELETE FROM harness_limit_state WHERE harness_id = ?`).run(harnessId);
      }
      return null;
    },
  }),
  "limit.prune": defineOp({
    tx: false,
    run: ({ conn }, now: number): null => {
      conn.query(`DELETE FROM harness_limit_state WHERE exhausted_until_ms <= ?`).run(now);
      return null;
    },
  }),
};

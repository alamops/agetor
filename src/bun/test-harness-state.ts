// Test helper: `bun test` runs every file in one process, and `db.ts` opens
// a single process-wide database on first import (see CLAUDE.md
// "Persistence"), so a harness a test inserts or disables is still there for
// every file that runs after it. Snapshot the harness rows (and the
// auto-enable bookkeeping) before mutating them and restore them in
// `afterAll`, so built-ins come back with the enabled flag they had and
// test-only rows are removed.
//
// Harness account stacks (migration 084) are harness state too: a leaked
// `harness_stack_members` row makes a later file's `UNIQUE(harness_id)` block
// fail for reasons it never created. The stack, membership and cooldown rows
// are snapshotted and restored alongside the harnesses.
//
// Usage, after `db.ts` is imported:
//   const restoreHarnesses = snapshotHarnessState();
//   afterAll(() => restoreHarnesses());

import { db, harnesses } from "./db.ts";

type StackRow = {
  id: string;
  label: string;
  kind: string;
  mirror_mode: string;
  created_at: number;
  updated_at: number;
};
type MemberRow = { stack_id: string; harness_id: string; position: number };
type LimitRow = {
  harness_id: string;
  reason: string;
  source: string;
  message: string | null;
  exhausted_until_ms: number;
  updated_at: number;
};

export function snapshotHarnessState(): () => void {
  const enabledById = new Map(harnesses.list().map((h) => [h.id, h.enabled] as const));
  const autoEnabledIds = new Set(
    (db.query("SELECT harness_id FROM harness_auto_enabled").all() as { harness_id: string }[])
      .map((r) => r.harness_id),
  );
  const stacks = db.query("SELECT * FROM harness_stacks").all() as StackRow[];
  const members = db.query("SELECT * FROM harness_stack_members").all() as MemberRow[];
  const limits = db.query("SELECT * FROM harness_limit_state").all() as LimitRow[];
  return () => {
    // Stacks first: deleting every test-created stack cascades its members,
    // then the snapshot rows go back. Deleting a row whose harness is about
    // to be removed is harmless; re-inserting a member for a harness the
    // restore keeps is the point.
    const snapshotStackIds = new Set(stacks.map((s) => s.id));
    for (const s of db.query("SELECT id FROM harness_stacks").all() as { id: string }[]) {
      if (!snapshotStackIds.has(s.id)) db.run("DELETE FROM harness_stacks WHERE id = ?", [s.id]);
    }
    for (const s of stacks) {
      db.run(
        `INSERT OR REPLACE INTO harness_stacks (id, label, kind, mirror_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [s.id, s.label, s.kind, s.mirror_mode, s.created_at, s.updated_at],
      );
    }
    db.run("DELETE FROM harness_stack_members");
    for (const m of members) {
      db.run(
        `INSERT OR IGNORE INTO harness_stack_members (stack_id, harness_id, position)
         VALUES (?, ?, ?)`,
        [m.stack_id, m.harness_id, m.position],
      );
    }
    db.run("DELETE FROM harness_limit_state");
    for (const l of limits) {
      db.run(
        `INSERT INTO harness_limit_state
           (harness_id, reason, source, message, exhausted_until_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [l.harness_id, l.reason, l.source, l.message, l.exhausted_until_ms, l.updated_at],
      );
    }
    for (const h of harnesses.list()) {
      const enabled = enabledById.get(h.id);
      if (enabled === undefined) {
        // `harnesses.delete` refuses a harness a task still points at; no
        // FK references `harnesses` from tasks, so a direct delete is safe
        // and keeps a fixed test id from colliding in a later file.
        db.run("DELETE FROM harnesses WHERE id = ?", [h.id]);
      } else if (h.enabled !== enabled) {
        harnesses.setEnabled(h.id, enabled);
      }
    }
    const recorded = db.query("SELECT harness_id FROM harness_auto_enabled").all() as { harness_id: string }[];
    for (const { harness_id } of recorded) {
      if (!autoEnabledIds.has(harness_id)) db.run("DELETE FROM harness_auto_enabled WHERE harness_id = ?", [harness_id]);
    }
  };
}

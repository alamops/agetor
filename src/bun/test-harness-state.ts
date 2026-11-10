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
// are snapshotted and restored alongside the harnesses. So are the orphaned
// handoff copies (migration 088) and the mirror's recorded primary folders
// (migration 089): a leaked row would make a later file's sweep or mirror act
// on an account id it reuses. Those two are copied whole-row (every column
// SQLite reports), so a column a later migration adds round-trips too.
//
// Usage, after `db.ts` is imported:
//   const restoreHarnesses = snapshotHarnessState();
//   afterAll(() => restoreHarnesses());

import type { SQLQueryBindings } from "bun:sqlite";
import { db, harnesses } from "./db.ts";

type StackRow = {
  id: string;
  label: string;
  kind: string;
  mirror_mode: string;
  created_at: number;
  updated_at: number;
};
type ProvenanceRow = {
  harness_id: string;
  stack_id: string | null;
  scope: string;
  path: string;
  key: string;
  value_hash: string | null;
  src_mtime_ms: number | null;
  src_size: number | null;
  preexisted: number;
  backup_ref: string | null;
  updated_at: number;
};
type MemberRow = { stack_id: string; harness_id: string; position: number };
type LimitRow = {
  harness_id: string;
  model: string;
  reason: string;
  source: string;
  message: string | null;
  exhausted_until_ms: number;
  updated_at: number;
};

/** Tables restored as they were, every column of every row. */
const WHOLE_ROW_TABLES = ["harness_orphaned_copies", "harness_mirror_sources"] as const;

type AnyRow = Record<string, SQLQueryBindings>;

function restoreWholeRows(table: (typeof WHOLE_ROW_TABLES)[number], rows: readonly AnyRow[]): void {
  db.run(`DELETE FROM ${table}`);
  for (const row of rows) {
    const columns = Object.keys(row);
    db.run(
      `INSERT INTO ${table} (${columns.map((c) => `"${c.replaceAll('"', '""')}"`).join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
      columns.map((c) => row[c]) as SQLQueryBindings[],
    );
  }
}

export function snapshotHarnessState(): () => void {
  const enabledById = new Map(harnesses.list().map((h) => [h.id, h.enabled] as const));
  const autoEnabledIds = new Set(
    (db.query("SELECT harness_id FROM harness_auto_enabled").all() as { harness_id: string }[])
      .map((r) => r.harness_id),
  );
  const stacks = db.query("SELECT * FROM harness_stacks").all() as StackRow[];
  const members = db.query("SELECT * FROM harness_stack_members").all() as MemberRow[];
  const limits = db.query("SELECT * FROM harness_limit_state").all() as LimitRow[];
  const provenance = db.query("SELECT * FROM harness_mirror_provenance").all() as ProvenanceRow[];
  const wholeRows = new Map(
    WHOLE_ROW_TABLES.map((t) => [t, db.query(`SELECT * FROM ${t}`).all() as AnyRow[]] as const),
  );
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
        // An upsert, not INSERT OR REPLACE: REPLACE deletes the row first and
        // fires ON DELETE CASCADE on harness_swap_events / members.
        `INSERT INTO harness_stacks (id, label, kind, mirror_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, kind = excluded.kind,
           mirror_mode = excluded.mirror_mode, created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
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
           (harness_id, model, reason, source, message, exhausted_until_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [l.harness_id, l.model, l.reason, l.source, l.message, l.exhausted_until_ms, l.updated_at],
      );
    }
    db.run("DELETE FROM harness_mirror_provenance");
    for (const r of provenance) {
      db.run(
        `INSERT INTO harness_mirror_provenance
           (harness_id, stack_id, scope, path, key, value_hash, src_mtime_ms, src_size, preexisted, backup_ref, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.harness_id, r.stack_id, r.scope, r.path, r.key, r.value_hash, r.src_mtime_ms, r.src_size, r.preexisted, r.backup_ref, r.updated_at],
      );
    }
    for (const [table, rows] of wholeRows) restoreWholeRows(table, rows);
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

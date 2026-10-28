// Test helper: `bun test` runs every file in one process, and `db.ts` opens
// a single process-wide database on first import (see CLAUDE.md
// "Persistence"), so a harness a test inserts or disables is still there for
// every file that runs after it. Snapshot the harness rows (and the
// auto-enable bookkeeping) before mutating them and restore them in
// `afterAll`, so built-ins come back with the enabled flag they had and
// test-only rows are removed.
//
// Usage, after `db.ts` is imported:
//   const restoreHarnesses = snapshotHarnessState();
//   afterAll(() => restoreHarnesses());

import { db, harnesses } from "./db.ts";

export function snapshotHarnessState(): () => void {
  const enabledById = new Map(harnesses.list().map((h) => [h.id, h.enabled] as const));
  const autoEnabledIds = new Set(
    (db.query("SELECT harness_id FROM harness_auto_enabled").all() as { harness_id: string }[])
      .map((r) => r.harness_id),
  );
  return () => {
    for (const h of harnesses.list()) {
      const enabled = enabledById.get(h.id);
      if (enabled === undefined) {
        // `harnesses.delete` refuses a harness a task still points at; no
        // table references `harnesses` by foreign key, so a direct delete is
        // safe and keeps a fixed test id from colliding in a later file.
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

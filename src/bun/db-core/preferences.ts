import type { Database } from "bun:sqlite";

export function makePreferences(conn: Database) {
  /**
   * Tiny key-value store for cross-session UI preferences. First customer:
   * NewTaskForm uses `lastModel:<agent>` / `lastEffort:<agent>` keys so the
   * pickers default to whatever the user last submitted, per agent. Values
   * are opaque strings; the meaning of a key lives in whichever caller
   * writes it.
   */
  const preferences = {
    get(key: string): string | null {
      const row = conn.query<{ value: string }, [string]>(
        `SELECT value FROM preferences WHERE key = ?`,
      ).get(key);
      return row?.value ?? null;
    },
    list(): Record<string, string> {
      const rows = conn.query<{ key: string; value: string }, []>(
        `SELECT key, value FROM preferences`,
      ).all();
      const out: Record<string, string> = {};
      for (const r of rows) out[r.key] = r.value;
      return out;
    },
    set(key: string, value: string): void {
      conn.run(
        `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, value, Date.now()],
      );
    },
    delete(key: string): void {
      conn.run(`DELETE FROM preferences WHERE key = ?`, [key]);
    },
  };
  return preferences;
}

export function makeRetentionSweeps(conn: Database) {
  /**
   * Archived-history retention's record of completed sweeps (migration 067):
   * `taskId → sweepKey`, where an unchanged key means the task holds nothing new
   * to trim. Written only by `retention.ts`. Kept out of `preferences` so it
   * never rides along on `GET /preferences` / `agetor config ls`.
   */
  const retentionSweeps = {
    /** Every recorded key — one row per swept archived task. */
    all(): Map<string, string> {
      const rows = conn.query<{ task_id: string; sweep_key: string }, []>(
        `SELECT task_id, sweep_key FROM retention_swept_tasks`,
      ).all();
      return new Map(rows.map((r) => [r.task_id, r.sweep_key]));
    },
    /** Records `taskId`'s completed sweep. A task deleted meanwhile is skipped
     *  (no row, and no foreign-key error). */
    set(taskId: string, sweepKey: string): void {
      conn.run(
        `INSERT INTO retention_swept_tasks (task_id, sweep_key)
       SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ?1)
       ON CONFLICT(task_id) DO UPDATE SET sweep_key = excluded.sweep_key`,
        [taskId, sweepKey],
      );
    },
    /** Drops the record of every task that is no longer archived at or before
     *  `cutoff` (unarchived, or the retention age grew), so the table stays
     *  bounded by the candidate set. */
    pruneNotArchivedBefore(cutoff: number): void {
      conn.run(
        `DELETE FROM retention_swept_tasks WHERE task_id NOT IN
         (SELECT id FROM tasks WHERE archived_at IS NOT NULL AND archived_at <= ?)`,
        [cutoff],
      );
    },
  };
  return retentionSweeps;
}

export function makeClaudeSessionSeen(conn: Database) {
  /**
   * Claude Code session ids the launch scan has already toasted (migration
   * 071). Offered, not imported: an id here is still listed and importable.
   */
  const claudeSessionSeen = {
    ids(): Set<string> {
      const rows = conn.query<{ session_id: string }, []>(
        `SELECT session_id FROM claude_session_seen`,
      ).all();
      return new Set(rows.map((r) => r.session_id));
    },
    /** Record `ids` as seen, in order, then keep only the newest `cap` rows.
     *  Re-adding a known id moves it to the newest end. */
    add(ids: readonly string[], cap: number, now: number = Date.now()): void {
      if (ids.length === 0) return;
      conn.transaction(() => {
        ids.forEach((id, i) => {
          conn.run(
            `INSERT INTO claude_session_seen (session_id, seen_at) VALUES (?, ?)
           ON CONFLICT(session_id) DO UPDATE SET seen_at = excluded.seen_at`,
            [id, now + i],
          );
        });
        conn.run(
          `DELETE FROM claude_session_seen WHERE session_id NOT IN (
           SELECT session_id FROM claude_session_seen
           ORDER BY seen_at DESC, session_id DESC LIMIT ?
         )`,
          [cap],
        );
      }).immediate();
    },
  };
  return claudeSessionSeen;
}

export function makeHarnessAutoEnabled(conn: Database) {
  /**
   * Bookkeeping for the "turn a built-in harness on once its CLI is installed"
   * hook (migration 080, `src/bun/harness-auto-enable.ts`,
   * docs/plans/add-opencode-harness.md D-14). A harness id here has been acted
   * on once and is never auto-enabled again — so a user who turns it back Off
   * keeps it off. `notified = 0` rows are the ones whose
   * `harnesses_auto_enabled` notice has not yet reached an `/app/events`
   * client. No FK to `harnesses` (a harnesses rebuild would cascade it away).
   */
  const harnessAutoEnabled = {
    has(harnessId: string): boolean {
      const row = conn.query<{ one: number }, [string]>(
        `SELECT 1 AS one FROM harness_auto_enabled WHERE harness_id = ? LIMIT 1`,
      ).get(harnessId);
      return row != null;
    },
    /** Record a harness as acted on. A second record of the same id is a
     *  no-op: it keeps the first `enabled_at` and never resets `notified`. */
    record(harnessId: string, now: number = Date.now()): void {
      conn.run(
        `INSERT OR IGNORE INTO harness_auto_enabled (harness_id, enabled_at, notified) VALUES (?, ?, 0)`,
        [harnessId, now],
      );
    },
    /** Recorded ids whose notice is still owed, oldest record first. */
    pending(): string[] {
      return conn.query<{ harness_id: string }, []>(
        `SELECT harness_id FROM harness_auto_enabled WHERE notified = 0
         ORDER BY enabled_at ASC, harness_id ASC`,
      ).all().map((r) => r.harness_id);
    },
    markNotified(harnessIds: readonly string[]): void {
      if (harnessIds.length === 0) return;
      conn.transaction(() => {
        for (const id of harnessIds) {
          conn.run(`UPDATE harness_auto_enabled SET notified = 1 WHERE harness_id = ?`, [id]);
        }
      }).immediate();
    },
    all(): { harnessId: string; enabledAt: number; notified: boolean }[] {
      return conn.query<{ harness_id: string; enabled_at: number; notified: number }, []>(
        `SELECT harness_id, enabled_at, notified FROM harness_auto_enabled
         ORDER BY enabled_at ASC, harness_id ASC`,
      ).all().map((r) => ({ harnessId: r.harness_id, enabledAt: r.enabled_at, notified: r.notified === 1 }));
    },
  };
  return harnessAutoEnabled;
}

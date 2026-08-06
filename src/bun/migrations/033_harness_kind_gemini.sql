-- Widen harnesses.kind's CHECK to admit 'gemini' and seed its built-in row.
--
-- SQLite can't ALTER a CHECK constraint in place, so this uses the full
-- table-rebuild recipe (create-new / copy-rows / drop / rename) — the same
-- recipe 024's comment documents as having caused a dogfood prod incident
-- once (an INSERT...SELECT copy that ran against an already-emptied table
-- left `harnesses` with only one row, dropping the claude-code/codex
-- builtins and every user alias). To not repeat that:
--   1. Copy rows via an EXPLICIT column list (never `SELECT *`), so a
--      future column reorder can't silently misalign the copy.
--   2. This whole file runs inside the migration runner's one transaction
--      (see migrate.ts) — the drop/rename only commits if every step
--      succeeded.
--   3. End with the same INSERT-OR-IGNORE self-heal 024 established for
--      claude-code/codex, extended to cover gemini too — idempotent, never
--      touches an existing row, so it's a no-op on a healthy rebuild and a
--      safety net if this rebuild ever loses rows the way the prod one did.
--
-- gemini is seeded disabled (enabled = 0), mirroring codex's 016 rollout
-- posture (parked-by-default; a user re-enables it from Settings) — this is
-- a brand-new, unvalidated-in-production harness kind.

CREATE TABLE harnesses_new (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('claude-code', 'codex', 'gemini')),
  label      TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  home       TEXT,
  bin        TEXT,
  env_json   TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1
);

INSERT INTO harnesses_new
  (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled)
SELECT
  id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled
FROM harnesses;

DROP TABLE harnesses;
ALTER TABLE harnesses_new RENAME TO harnesses;

INSERT OR IGNORE INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled)
VALUES
  ('claude-code', 'claude-code', 'Claude Code', 1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   1),
  ('codex',       'codex',       'Codex',       1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   0),
  ('gemini',      'gemini',      'Gemini CLI',  1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   0);

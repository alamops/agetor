-- Widen harnesses.kind's CHECK to admit 'jcode' (the Jcode ACP harness) and
-- seed its built-in row.
--
-- SQLite can't ALTER a CHECK constraint in place, so this uses the same
-- full table-rebuild recipe 032/037/038/046 already established (create-new /
-- copy-rows / drop / rename). Same three safeguards 046 documents against the
-- 024 prod incident (an INSERT...SELECT copy against an already-emptied table
-- that dropped every builtin + alias):
--   1. Copy rows via an EXPLICIT column list (never `SELECT *`), so a future
--      column reorder can't silently misalign the copy.
--   2. This whole file runs inside the migration runner's one transaction
--      (see migrate.ts) — the drop/rename only commits if every step
--      succeeded.
--   3. End with the same INSERT-OR-IGNORE self-heal 024/038/046 established,
--      extended to cover jcode too — idempotent, never touches an existing
--      row, so it's a no-op on a healthy rebuild and a safety net if this
--      rebuild ever loses rows the way the prod one did.
--
-- The CHECK carries forward every kind 046's CHECK already listed
-- (claude-code, codex, cursor, grok, gemini, kimi, fx) plus 'jcode', keeping
-- the reserved-kind entries ('grok', 'kimi') for the same order-independence
-- reason 032/037/046 kept them.
--
-- jcode is seeded disabled (enabled = 0), mirroring codex/cursor/gemini/fx's
-- own rollout posture (parked-by-default; a user re-enables it from Settings)
-- — it is a brand-new harness kind in this fork.

CREATE TABLE harnesses_new (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('claude-code', 'codex', 'cursor', 'grok', 'gemini', 'kimi', 'fx', 'jcode')),
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

-- Seed the built-in jcode row. Ships disabled — same house style as
-- codex/cursor/gemini/fx — until the kind is ready to surface by default.
INSERT OR IGNORE INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled)
VALUES
  ('jcode', 'jcode', 'Jcode', 1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   0);

-- Trailing self-heal re-seed of every known builtin (claude-code/codex/
-- cursor/gemini/fx/jcode), same as 038/046 did for their own sets — a no-op on
-- a healthy rebuild, a safety net on a damaged one. INSERT OR IGNORE never
-- touches an existing row, so a present builtin's enable/disable state and any
-- user aliases are preserved.
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
  ('cursor',      'cursor',      'Cursor',      1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   0),
  ('gemini',      'gemini',      'Gemini CLI',  1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   0),
  ('fx',          'fx',          'fx.sh',       1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   0),
  ('jcode',       'jcode',       'Jcode',       1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   0);

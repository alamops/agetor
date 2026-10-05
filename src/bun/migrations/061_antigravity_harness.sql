-- Widen harnesses.kind's CHECK to admit 'antigravity' (Google Antigravity CLI `agy`)
-- and seed its built-in row enabled by default.
--
-- Follows the table-rebuild recipe established by 032/037/046:
--   1. Create harnesses_new with 'antigravity' added to the CHECK constraint.
--   2. Copy existing rows explicitly.
--   3. Drop harnesses and rename harnesses_new to harnesses.
--   4. Seed built-in 'antigravity' row.
--   5. Self-heal re-seed of all built-in harnesses.
--   6. Add `antigravity_session_id` to `runs`.

CREATE TABLE harnesses_new (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('claude-code', 'codex', 'cursor', 'grok', 'gemini', 'kimi', 'fx', 'antigravity')),
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

-- Seed the built-in antigravity row. Enabled by default.
INSERT OR IGNORE INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled)
VALUES
  ('antigravity', 'antigravity', 'Antigravity', 1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   1);

-- Trailing self-heal re-seed of every known builtin
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
  ('antigravity', 'antigravity', 'Antigravity', 1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   1);

ALTER TABLE runs ADD COLUMN antigravity_session_id TEXT;

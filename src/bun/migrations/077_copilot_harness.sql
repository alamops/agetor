-- Widen harnesses.kind's CHECK to admit 'copilot' (GitHub Copilot CLI) and
-- seed its built-in row enabled by default.
--
-- The CHECK also admits 'opencode' so a concurrently developed harness
-- migration can land in either order without a second rebuild fighting this
-- one over the constraint.
--
-- Follows the table-rebuild recipe established by 032/037/046/061:
--   1. Create harnesses_new with 'copilot' (and 'opencode') in the CHECK.
--   2. Copy existing rows explicitly, every column by name
--      (`profile_mcp_servers`, added by 073, included).
--   3. Drop harnesses and rename harnesses_new to harnesses.
--   4. Seed built-in 'copilot' row.
--   5. Self-heal re-seed of the built-in harnesses this build knows.
--   6. Add `copilot_session_id` to `runs`.

CREATE TABLE harnesses_new (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('claude-code', 'codex', 'cursor', 'grok', 'gemini', 'kimi', 'fx', 'antigravity', 'opencode', 'copilot')),
  label      TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  home       TEXT,
  bin        TEXT,
  env_json   TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  profile_mcp_servers INTEGER NOT NULL DEFAULT 1
);

INSERT INTO harnesses_new
  (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled, profile_mcp_servers)
SELECT
  id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled, profile_mcp_servers
FROM harnesses;

DROP TABLE harnesses;
ALTER TABLE harnesses_new RENAME TO harnesses;

-- Seed the built-in copilot row. Enabled by default.
INSERT OR IGNORE INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled)
VALUES
  ('copilot', 'copilot', 'GitHub Copilot', 1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   1);

-- Trailing self-heal re-seed of every builtin this build knows. INSERT OR
-- IGNORE leaves a row the user already toggled untouched.
INSERT OR IGNORE INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled)
VALUES
  ('claude-code', 'claude-code', 'Claude Code',    1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   1),
  ('codex',       'codex',       'Codex',          1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   0),
  ('cursor',      'cursor',      'Cursor',         1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   0),
  ('gemini',      'gemini',      'Gemini CLI',     1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   0),
  ('fx',          'fx',          'fx.sh',          1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   0),
  ('antigravity', 'antigravity', 'Antigravity',    1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   1),
  ('copilot',     'copilot',     'GitHub Copilot', 1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   1);

ALTER TABLE runs ADD COLUMN copilot_session_id TEXT;

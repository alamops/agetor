-- Widen harnesses.kind's CHECK to admit 'opencode' (OpenCode CLI) and seed
-- its built-in row disabled. The CHECK also lists 'copilot' (077) so this
-- rebuild and Copilot's copy cleanly in either order
-- (docs/plans/add-opencode-harness.md §2c) — neither branch adds a harnesses
-- column. Authored as 077 and renumbered to 078 when Copilot merged first.
--
-- Follows the table-rebuild recipe established by 032/037/046/061:
--   1. Create harnesses_new with 'opencode' (and 'copilot') in the CHECK.
--   2. Copy existing rows explicitly — every column, `profile_mcp_servers`
--      (073) included.
--   3. Drop harnesses and rename harnesses_new to harnesses.
--   4. Seed the built-in 'opencode' row, disabled (the auto-enable hook,
--      `harness_auto_enabled` / 080, turns it on once the CLI is installed).
--   5. Self-heal re-seed of all built-in harnesses.
--   6. Add `opencode_session_id` to `runs`.
--
-- No table references harnesses by FK, so the DROP cascades nothing.

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

-- Seed the built-in opencode row. Disabled by default.
INSERT OR IGNORE INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled)
VALUES
  ('opencode', 'opencode', 'OpenCode', 1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   0);

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
   1),
  ('opencode',    'opencode',    'OpenCode',    1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   0),
  ('copilot',     'copilot',     'GitHub Copilot', 1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   1);

ALTER TABLE runs ADD COLUMN opencode_session_id TEXT;

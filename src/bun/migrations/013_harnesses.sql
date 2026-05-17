-- Harnesses are the user-facing name for what the rest of the code calls an
-- "agent". A row pairs a built-in CLI `kind` (claude-code, codex) with
-- optional overrides — a custom HOME path so the CLI's login/config writes
-- to a separate dir (multi-account), an alternate binary path, and arbitrary
-- env vars. The two built-in rows (`claude-code`, `codex`) are seeded here
-- so legacy `tasks.agent ∈ {"claude-code","codex"}` rows still resolve to a
-- valid harness without any data migration. Built-ins are immutable from
-- the UI / API — to customise, create an alias.

CREATE TABLE harnesses (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('claude-code', 'codex')),
  label      TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  home       TEXT,
  bin        TEXT,
  env_json   TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at)
VALUES
  ('claude-code', 'claude-code', 'Claude Code', 1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('codex',       'codex',       'Codex',       1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000);

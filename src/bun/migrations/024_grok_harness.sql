-- Widen the harnesses.kind CHECK constraint to allow 'grok' (Grok Build,
-- xAI's CLI coding agent — see docs/plans/grok-build-agent-support.md).
-- SQLite can't ALTER a CHECK constraint in place, so rebuild the table:
-- create a new one with the full current schema (013's base columns plus
-- 014's `enabled` column — 015/016 only wrote data, they added no columns),
-- copy every row across, drop the old table, rename the new one into place.
-- No indexes or triggers exist on `harnesses` as of this migration, so none
-- need to be recreated. Nothing else has a foreign key on this table —
-- `tasks.agent` stores the harness id/kind as a plain string, not a FK.

CREATE TABLE harnesses_new (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('claude-code', 'codex', 'grok')),
  label      TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  home       TEXT,
  bin        TEXT,
  env_json   TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1
);

INSERT INTO harnesses_new (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled)
SELECT id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled
FROM harnesses;

DROP TABLE harnesses;

ALTER TABLE harnesses_new RENAME TO harnesses;

-- Seed the built-in grok row, mirroring 013's seed pattern (id = kind for
-- built-ins) and 016's disable-by-default treatment for a new harness that
-- isn't ready for general use yet: shipped disabled, Experimental in the UI,
-- until the user opts in from Settings.
INSERT OR IGNORE INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled)
VALUES
  ('grok', 'grok', 'Grok Build', 1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   0);

-- Widen the harnesses.kind CHECK to allow the third built-in agent kind,
-- 'cursor' (driven through the cursor-agent CLI). SQLite can't ALTER a CHECK
-- constraint in place, so this is the standard rebuild recipe: create a new
-- table with the identical shape but the widened CHECK, copy every row over
-- by explicit column list (never `SELECT *`, so a future column addition
-- can't silently get lost in a copy nobody updates), drop the old table, and
-- rename the new one into place.
--
-- No other table declares a foreign key against harnesses(id) — `tasks.agent`
-- and `runs.agent` are plain TEXT columns resolved through `harnesses.get` /
-- `getByIdOrKind` in application code, not a SQL-level FK — so this rebuild
-- doesn't need `PRAGMA foreign_keys` toggled (which couldn't happen inside
-- this transaction anyway; see src/bun/migrate.ts). There are also no
-- indexes or triggers on `harnesses` to recreate.
CREATE TABLE harnesses_new (
  id         TEXT PRIMARY KEY,
  -- 'grok' is permitted here even though this branch doesn't ship it: a
  -- sibling branch adds a grok harness with its own CHECK-rebuild migration,
  -- and both rebuilds must be order-independent — a rebuild whose CHECK
  -- excludes the other branch's already-seeded kind would fail the row copy.
  -- App-layer validation in db.ts (harnesses.insert) governs what can
  -- actually be created.
  kind       TEXT NOT NULL CHECK (kind IN ('claude-code', 'codex', 'cursor', 'grok')),
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

-- Seed the built-in cursor row. Ships disabled — same house style as codex's
-- migration 016 rollback — until the driver has been live-verified against
-- the real cursor-agent CLI and the feature is ready to surface by default.
INSERT OR IGNORE INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled)
VALUES
  ('cursor', 'cursor', 'Cursor', 1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   0);

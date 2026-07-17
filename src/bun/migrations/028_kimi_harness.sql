-- Add Kimi Code as a built-in harness kind. SQLite CHECK constraints can't be
-- altered in place, so widening `harnesses.kind` requires the full
-- table-rebuild recipe (create-new / copy-rows / drop / rename — same
-- approach called out in 024's background comment).
--
-- Fleet convention (decision entry a1a98166): the rebuilt CHECK lists the
-- UNION of every in-flight AgentKind across sibling branches — including
-- kinds not yet merged to this branch (cursor, grok) — so whichever branch
-- merges second doesn't have to re-widen the CHECK again; it just renumbers
-- this migration file if a collision occurs. `INSERT OR IGNORE` keeps this
-- migration idempotent against a DB that already has some of these builtins
-- seeded by another branch's migration.
CREATE TABLE harnesses_new (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('claude-code', 'codex', 'cursor', 'grok', 'kimi')),
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

-- Seed the kimi builtin row, disabled by default — no local binary existed
-- to smoke-test the driver against at implementation time (see the harness
-- plan doc), and the CLI mapper is doc-verified only. A user re-enables it
-- from Settings once they've confirmed the binary works for them.
INSERT OR IGNORE INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled)
VALUES
  ('kimi', 'kimi', 'Kimi Code', 1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   0);

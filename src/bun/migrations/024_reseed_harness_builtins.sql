-- Self-heal: re-seed the built-in claude-code and codex harness rows when
-- they are missing.
--
-- Background: widening `harnesses.kind`'s CHECK requires SQLite's full
-- table-rebuild recipe (create-new / copy-rows / drop / rename — see 013 and
-- the in-flight cursor/grok AgentKind branches). If such a rebuild's
-- `INSERT ... SELECT` copy ever fails or runs against an already-emptied
-- table, the rebuilt `harnesses` can come out missing its seed rows. That
-- happened on a dogfood prod DB: the table was left with a single row and the
-- claude-code/codex builtins (plus the user's custom aliases) were gone.
-- Tasks still spawned — `harnesses.getByIdOrKind` synthesises a fallback for
-- the claude-code/codex kinds — but the Settings harness picker was empty of
-- the builtins and custom aliases hard-broke.
--
-- INSERT OR IGNORE is a no-op on a healthy DB (the PK already exists) and
-- restores the two builtins on a damaged one. Because OR IGNORE never touches
-- an existing row, a user's enable/disable choice on a present builtin is
-- preserved. codex is seeded disabled to match 016 (parked-by-default); a
-- user re-enables it from Settings. Custom aliases (non-builtin, user-defined
-- home/bin/env) cannot be reconstructed generically and are out of scope —
-- their config homes survive on disk under the data dir and are restored
-- manually.
INSERT OR IGNORE INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled)
VALUES
  ('claude-code', 'claude-code', 'Claude Code', 1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   1),
  ('codex',       'codex',       'Codex',       1, NULL, NULL, '{}',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   0);

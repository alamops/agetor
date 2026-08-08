-- Self-heal, round 2: re-seed every known builtin (claude-code/codex/
-- cursor/gemini) whenever it's missing, same as 024 did for the first two.
-- Originally numbered 034, renumbered to 038 on merge with the cursor
-- branch's migrations (see migrations/index.ts's aliases field).
--
-- Discovered live on a real dogfood ~/.agetor-dev database: after
-- 037_harness_kind_gemini's table-rebuild (numbered 033 at the time), the
-- rebuilt `harnesses` table was left with only the `codex` row —
-- `claude-code` (and the newly-seeded `gemini`) were gone, even though that
-- migration's own trailing `INSERT OR IGNORE` should have covered this.
-- 024's comment already documents this exact failure class for the
-- table-rebuild recipe ("the rebuilt harnesses can come out missing its seed
-- rows... happened on a dogfood prod DB") and its fix is exactly this: an
-- idempotent re-seed as its own migration, run again. Per the "never edit an
-- applied migration" rule, 037 itself is not touched — this is deliberately
-- a separate file so every already-migrated database (this one included)
-- picks up the fix on its next boot. `cursor` is included here too — the
-- same rebuild could just as easily have dropped it, since it's seeded by
-- an earlier migration (032) in the same table.
--
-- INSERT OR IGNORE is a no-op on a healthy DB (the PK already exists) and
-- restores any missing builtin on a damaged one, without touching a present
-- row's enable/disable state or a user's custom aliases.
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
   0);

-- Backfill tasks.model / tasks.effort that predate the "no placeholder" change.
-- Pre-migration: both columns could be NULL meaning "let the CLI pick". The
-- UI no longer offers that choice, and buildCommand no longer treats NULL
-- as 'no flag', so existing NULL rows would error on next launch. Join to
-- the harnesses table to find each task's kind, then write the kind's
-- default. Haiku 4.5 is the one model where effort must stay NULL (the CLI
-- doesn't accept the flag); the WHERE clause excludes it.

UPDATE tasks
SET model = 'opus-4.7'
WHERE model IS NULL
  AND agent IN (SELECT id FROM harnesses WHERE kind = 'claude-code');

UPDATE tasks
SET model = 'gpt-5-codex'
WHERE model IS NULL
  AND agent IN (SELECT id FROM harnesses WHERE kind = 'codex');

UPDATE tasks
SET effort = 'high'
WHERE effort IS NULL
  AND model != 'haiku-4.5'
  AND agent IN (SELECT id FROM harnesses WHERE kind = 'claude-code');

UPDATE tasks
SET effort = 'high'
WHERE effort IS NULL
  AND agent IN (SELECT id FROM harnesses WHERE kind = 'codex');

-- Catch-all for tasks whose `agent` no longer resolves to any harness row
-- (alias was deleted in a prior session, leaving an orphan task). The row
-- is unrunnable in that state anyway, but leaving model NULL would violate
-- the "model is always set" invariant that the rest of the codebase now
-- relies on (PATCH validation, buildCommand throw). Default the orphan to
-- the most-likely-correct values; the user can fix the harness later.
UPDATE tasks SET model = 'opus-4.7' WHERE model IS NULL;
UPDATE tasks SET effort = 'high' WHERE effort IS NULL AND model != 'haiku-4.5';

-- Provenance for a Claude Code session imported from outside Agetor
-- (`Task.importedClaude`, src/shared/types.ts). Written ONLY by
-- `tasks.setImportedClaude` — a targeted UPDATE that never bumps
-- `updated_at` — never by `tasks.insert` (new rows stay NULL) and never by
-- the generic `tasks.update` SET clause, same treatment as `fx_recovery`
-- (051) / `checkout_branch` (063): an unrelated PATCH must not clobber an
-- in-flight history backfill. NULL means the task was not imported.
ALTER TABLE tasks ADD COLUMN imported_claude TEXT;

-- Ownership filter for the session scanner (`runs.claudeSessionIds`).
-- `claude_session_id` has existed since 009 and was unindexed; listing every
-- id Agetor already owns must not scan `runs`.
CREATE INDEX runs_claude_session_id_idx
  ON runs(claude_session_id) WHERE claude_session_id IS NOT NULL;

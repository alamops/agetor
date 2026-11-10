-- Where each backup account's own folder resolved on its last mirror
-- (docs/architecture/harness-stacks.md, "Mirror provenance, backups, preview and Restore").
--
-- 089 pins the primary's folder. A BACKUP with no config folder of its own
-- (the built-in account at position 2, say) resolves through the core's
-- environment too, so a core started with another CLAUDE_CONFIG_DIR /
-- CODEX_HOME would apply the account's provenance rows to a different folder:
-- every recorded file there reads as edited, its "original" is saved over the
-- real one, and a later Restore writes those originals into the wrong folder.
-- Each row now also records the folder(s) the backup resolved to (the config
-- root, plus the `.claude.json` folder for Claude) and a fingerprint of the
-- backup's own root settings. When the same settings resolve to a different
-- folder while the recorded one still exists, the mirror skips that backup.
-- When the folder really changed (other settings, or the recorded folder is
-- gone), the mirror drops the account's old records and saved originals and
-- mirrors it as new. Restore refuses whenever the recorded folder differs.
--
-- '' means not recorded yet (a row written before this migration); the next
-- real mirror run records it. Never edit 089: existing databases applied it.
ALTER TABLE harness_mirror_sources ADD COLUMN backup_root TEXT NOT NULL DEFAULT '';
ALTER TABLE harness_mirror_sources ADD COLUMN backup_config TEXT NOT NULL DEFAULT '';

-- The leftover-copy sweep asks which tasks still reference a session
-- (`runs.taskIdsWithSession`), for the two kinds a stack hands sessions
-- between. `claude_session_id` is already covered by 068's
-- `runs_claude_session_id_idx`; `codex_session_id` had no index, so the lookup
-- scanned every run. Partial, like 068's and 079's: most runs carry no codex id.
CREATE INDEX IF NOT EXISTS runs_codex_session_id_idx
  ON runs(codex_session_id) WHERE codex_session_id IS NOT NULL;

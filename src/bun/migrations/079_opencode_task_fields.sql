-- OpenCode per-task and per-profile fields
-- (docs/plans/add-opencode-harness.md D-4, D-13).
--
-- `opencode_server` picks how a v2 OpenCode turn reaches its server: the
-- user's shared background server, or `--standalone` (an in-process one).
-- Meaningful for opencode-kind rows only; every other kind ignores it.
-- Patchable on tasks (the generic `tasks.update` SET clause writes it).
ALTER TABLE tasks ADD COLUMN opencode_server TEXT NOT NULL DEFAULT 'shared'
  CHECK (opencode_server IN ('shared', 'standalone'));
ALTER TABLE agent_profiles ADD COLUMN opencode_server TEXT NOT NULL DEFAULT 'shared'
  CHECK (opencode_server IN ('shared', 'standalone'));

-- Provenance for an OpenCode session imported from outside Agetor
-- (`Task.importedOpencode`), parallel to `imported_claude` (068/069). Both
-- columns are written ONLY by `tasks.setImportedOpencode` — a targeted
-- UPDATE that never bumps `updated_at` — never by `tasks.insert` and never by
-- the generic `tasks.update` SET clause. `imported_opencode_session_id` is the
-- ownership claim: one imported task per OpenCode session id. NULL means the
-- task holds no session. A new column, so there is nothing to backfill.
ALTER TABLE tasks ADD COLUMN imported_opencode TEXT;
ALTER TABLE tasks ADD COLUMN imported_opencode_session_id TEXT;

CREATE UNIQUE INDEX tasks_imported_opencode_session_uidx
  ON tasks(imported_opencode_session_id)
  WHERE imported_opencode_session_id IS NOT NULL;

-- Ownership filter for the session scanner (`runs.opencodeSessionIdsOwned`),
-- the 069 precedent: listing every id Agetor already owns must not scan `runs`.
CREATE INDEX runs_opencode_session_id_idx
  ON runs(opencode_session_id) WHERE opencode_session_id IS NOT NULL;

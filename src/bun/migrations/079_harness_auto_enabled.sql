-- Bookkeeping for "turn a built-in harness on once its CLI is installed"
-- (docs/plans/add-opencode-harness.md D-14, `src/bun/harness-auto-enable.ts`).
-- One row per harness the hook has acted on — recorded even when the row was
-- already on, so a later user Off sticks. `notified` flips to 1 once the
-- `harnesses_auto_enabled` notice reached an `/app/events` client.
--
-- Deliberately NO foreign key to harnesses: every future harnesses rebuild
-- (CREATE new / DROP old / RENAME) would cascade-delete these rows.
CREATE TABLE harness_auto_enabled (
  harness_id TEXT PRIMARY KEY,
  enabled_at INTEGER NOT NULL,
  notified   INTEGER NOT NULL DEFAULT 0
);

-- Harness-stack handoff copies that no handoff row can clean up any more
-- (docs/architecture/harness-stacks.md, "Leftover handoff copies").
--
-- A `harness_session_handoffs` row names ONE session, and cleanup removes a
-- recorded path only when its shape names that session. Two cases used to
-- leave copied files on disk with nothing able to remove them:
--   * the row was re-keyed to a newer session (the same task moved onto the
--     same account again) and some of the old session's copies could not be
--     unlinked;
--   * a task was deleted while its row still held copies cleanup had to keep
--     (the account's config directory had changed, or an unlink failed), and
--     the row cascaded with the task.
-- Such paths move here, each with the session it was copied for, and a sweep
-- (boot, the retention pass, an account edit, a later transfer) retries them
-- under the same rules as handoff cleanup: inside the account's CURRENT root,
-- of a handoff shape for this row's session, a real path, a regular file.
--
-- No foreign keys on purpose: the rows must outlive their task, and an FK to
-- `harnesses` would be wiped by the documented rebuild-the-table recipe. An
-- account delete removes its rows explicitly (`harnesses.delete`).
CREATE TABLE harness_orphaned_copies (
  harness_id TEXT NOT NULL,
  column_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (harness_id, column_name, path)
);

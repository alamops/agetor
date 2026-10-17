-- One imported task per Claude session id.
--
-- `runs.claude_session_id` stays non-unique: a follow-up turn inserts another
-- run that reuses the same id (`spawnResumedSession`). The ownership claim
-- is this column, written only by `tasks.setImportedClaude` in the same
-- UPDATE as `imported_claude`, and written before the seed run so a crash
-- in that insert can still be resumed. A JSON expression index cannot do
-- this job: `json_extract` rejects malformed provenance, and the reader is
-- required to tolerate that. NULL means the task holds no session.
--
-- Rows written before this column existed keep the session id only inside
-- `imported_claude`. Copy a valid string id onto the claim before the unique
-- index is created, so those tasks are visible to it. `json_valid` skips
-- malformed provenance — `json_extract` would abort the migration. When two
-- rows name the same session, the earliest `created_at` (then id) wins and
-- the other stays NULL so the index can be built. Migration 070 repeats
-- this UPDATE for a database that already applied an earlier revision of
-- this file. Keep the two UPDATE statements identical.
ALTER TABLE tasks ADD COLUMN imported_claude_session_id TEXT;

UPDATE tasks
SET imported_claude_session_id = json_extract(imported_claude, '$.sessionId')
WHERE id IN (
  SELECT pick.id FROM (
    SELECT candidate.id AS id,
           ROW_NUMBER() OVER (
             PARTITION BY json_extract(candidate.imported_claude, '$.sessionId')
             ORDER BY candidate.created_at ASC, candidate.id ASC
           ) AS rn
    FROM tasks AS candidate
    WHERE candidate.imported_claude_session_id IS NULL
      AND candidate.imported_claude IS NOT NULL
      AND json_valid(candidate.imported_claude)
      AND json_type(candidate.imported_claude, '$.sessionId') = 'text'
      AND length(json_extract(candidate.imported_claude, '$.sessionId')) > 0
      AND NOT EXISTS (
        SELECT 1 FROM tasks AS claimed
        WHERE claimed.imported_claude_session_id =
          json_extract(candidate.imported_claude, '$.sessionId')
      )
  ) AS pick
  WHERE pick.rn = 1
);

CREATE UNIQUE INDEX tasks_imported_claude_session_uidx
  ON tasks(imported_claude_session_id)
  WHERE imported_claude_session_id IS NOT NULL;

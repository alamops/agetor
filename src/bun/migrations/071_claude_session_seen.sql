-- Claude Code session ids the launch scan has already toasted
-- (docs/plans/import-claude-code-sessions.md D5: "offered", not imported).
-- `claudeSessions.launchScan` stays in `preferences`; this set does not.
--
-- Its own table rather than a JSON array in `preferences`, same reason as
-- `retention_swept_tasks` (067): the array held up to 2 000 ids (~75 KB) and
-- rode along on every `GET /preferences` and `agetor config ls`. The writer
-- (`claudeSessionSeen.add`) keeps the newest 2 000 rows by `seen_at`.
CREATE TABLE claude_session_seen (
  session_id TEXT PRIMARY KEY,
  seen_at    INTEGER NOT NULL
);

CREATE INDEX claude_session_seen_at_idx ON claude_session_seen(seen_at);

-- Carry over the pre-table record (unreleased, only ever written by
-- development builds of this branch). Array order is oldest first, so each
-- id's `seen_at` counts up from the preference's own write time. Malformed
-- JSON reads as an empty array instead of aborting the migration.
INSERT OR IGNORE INTO claude_session_seen (session_id, seen_at)
SELECT item.value,
       pref.updated_at - (json_array_length(pref.value) - 1 - CAST(item.key AS INTEGER))
FROM preferences AS pref,
     json_each(
       CASE WHEN json_valid(pref.value) AND json_type(pref.value) = 'array'
            THEN pref.value ELSE '[]' END
     ) AS item
WHERE pref.key = 'claudeSessions.seenIds'
  AND item.type = 'text'
  AND length(item.value) > 0;

DELETE FROM preferences WHERE key = 'claudeSessions.seenIds';

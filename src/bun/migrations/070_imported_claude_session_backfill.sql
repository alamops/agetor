-- Repair databases that applied 069 before the session-id backfill was
-- added. Idempotent: a row that already holds a claim is left alone, and a
-- session id another row already claims is not copied. Malformed provenance
-- stays NULL. Keep this UPDATE identical to the one in 069.
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

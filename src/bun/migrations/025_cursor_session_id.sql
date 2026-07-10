-- Cursor session parity: persist cursor-agent's own conversation/session id
-- (the `session_id` carried on every event of its `--output-format
-- stream-json` NDJSON stream, first seen on `system/init`) so a follow-up
-- turn can `cursor-agent --resume <session_id>` and a mid-turn run can be
-- reattached after an agetor restart. Mirrors `codex_session_id` (migration
-- 021) / `claude_session_id` (migration 009) but is a distinct namespace —
-- none of the three session id columns are interchangeable. NULL for
-- claude-code/codex runs and pre-migration rows.
ALTER TABLE runs ADD COLUMN cursor_session_id TEXT;

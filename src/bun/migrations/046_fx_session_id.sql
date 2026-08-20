-- fx session parity: persist fx.sh's own conversation/session id so a
-- follow-up turn can resume it and a mid-turn run can be reattached after an
-- agetor restart. Mirrors `cursor_session_id` (migration 033) /
-- `gemini_session_id` (migration 036) / `codex_session_id` (migration 021) /
-- `claude_session_id` (migration 009) but is a distinct namespace — none of
-- the session id columns are interchangeable. NULL for every other agent's
-- runs and pre-migration rows.
ALTER TABLE runs ADD COLUMN fx_session_id TEXT;

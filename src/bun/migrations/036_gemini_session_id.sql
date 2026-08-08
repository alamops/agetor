-- Gemini session parity: persist gemini's own conversation/session id — a
-- uuid agetor self-issues at spawn time (passed as `--session-id` on the
-- first turn) rather than one discovered from a CLI event, unlike codex's
-- `codex_session_id` (migration 021). A follow-up turn passes the same uuid
-- back via `--resume <uuid>`, and a mid-turn run can be reattached after an
-- agetor restart. Distinct namespace from claude_session_id (migration 009)
-- and codex_session_id — never interchangeable. NULL for claude-code/codex
-- runs and pre-migration rows.
ALTER TABLE runs ADD COLUMN gemini_session_id TEXT;

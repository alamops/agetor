-- Kimi session parity: persist Kimi Code's own per-turn session id (a
-- crypto.randomUUID() the driver pre-generates at first spawn — kimi's
-- `--session <id>` both resumes and creates, so no output parsing is needed
-- to discover it) so a follow-up turn can pass the same `--session <id>` and
-- a mid-turn run can be reattached after an agetor restart. Mirrors
-- `codex_session_id` (migration 021) but is a distinct namespace. NULL for
-- claude-code/codex runs and pre-migration rows.
ALTER TABLE runs ADD COLUMN kimi_session_id TEXT;

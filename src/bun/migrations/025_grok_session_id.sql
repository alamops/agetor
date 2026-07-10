-- Grok session parity: persist grok's own session id (the `sessionId` field
-- surfaced in its `--output-format streaming-json` event stream) so a
-- follow-up turn can `grok --resume <session-id>` and a mid-turn run can be
-- reattached after an agetor restart. Mirrors `codex_session_id` (migration
-- 021), which itself mirrors `claude_session_id` (migration 009) — each
-- agent's session-id namespace is distinct and not interchangeable. NULL for
-- claude-code/codex runs and pre-migration rows.
ALTER TABLE runs ADD COLUMN grok_session_id TEXT;

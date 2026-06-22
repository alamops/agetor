-- Codex session parity: persist codex's own conversation/thread id (the
-- `thread_id` from the `thread.started` event in its `--json` stream) so a
-- follow-up turn can `codex exec resume <thread_id>` and a mid-turn run can be
-- reattached after an agetor restart. Mirrors `claude_session_id` (migration
-- 009) but is a distinct namespace — claude's JSONL uuid and codex's thread id
-- are not interchangeable. NULL for claude-code runs and pre-migration rows.
ALTER TABLE runs ADD COLUMN codex_session_id TEXT;

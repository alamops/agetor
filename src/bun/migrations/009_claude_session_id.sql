-- Claude Code's own per-session uuid (the basename of the JSONL file under
-- `~/.claude/projects/<encoded-cwd>/<id>.jsonl`). Recorded so we can pass it
-- to `claude --resume <id>` when the user wants to continue a finished run
-- and the original tmux session has been torn down. NULL for codex rows and
-- pre-migration legacy rows.
ALTER TABLE runs ADD COLUMN claude_session_id TEXT;

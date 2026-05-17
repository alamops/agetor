-- Per-task agent options. Both nullable; NULL means "use the agent's default"
-- (which preserves the pre-existing behavior: --dangerously-skip-permissions
-- for claude-code, --full-auto for codex, no --model flag).
ALTER TABLE tasks ADD COLUMN mode TEXT;
ALTER TABLE tasks ADD COLUMN model TEXT;

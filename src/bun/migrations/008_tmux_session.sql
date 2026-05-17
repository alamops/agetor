-- Tmux session name that hosts this run's claude-code interactive REPL.
-- Same value across every run for a given task under the one-session-per-task
-- model. Recorded so reconcileOrphans + deleteTask can find sessions to kill
-- without having to recompute the name from the task id. NULL for codex runs
-- (they don't use tmux) and for any pre-migration rows.
ALTER TABLE runs ADD COLUMN tmux_session TEXT;

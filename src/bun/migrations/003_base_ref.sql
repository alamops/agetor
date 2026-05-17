-- Resolved sha (40 hex chars) that the per-task worktree was — or will be —
-- created from. Pinned at task-create time so subsequent re-runs share a
-- stable starting point even if the source repo's HEAD has moved.
-- NULL when the workdir wasn't a git repo (or isolation was off) at create time.
ALTER TABLE tasks ADD COLUMN base_ref TEXT;

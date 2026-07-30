-- Persisted PR URL for a task. Set server-side by the /github/pull-create
-- route when creation succeeds and the request carried a matching `taskId`
-- (see server.ts). NULL means no PR has been created for this task yet.
-- Deliberately server-managed only — not part of the PATCH /tasks/:id
-- allow-list, mirroring branch/worktree_path/base_ref.
ALTER TABLE tasks ADD COLUMN pr_url TEXT;

-- Multiple repositories per task (issue #291).
--
-- `repositories` holds the pinned repository set as JSON (`TaskRepository[]`).
-- A SINGLE-repository row stores '[]' on purpose: the scalar columns
-- (branch/worktree_path/base_ref/checkout_branch/pr_url) remain its one
-- source of truth as they update, and `toTask` derives its one-entry array.
-- A multi-repository row stores two or more entries; its scalar columns are
-- the task-workspace mirror (`workdir`/`worktree_path` point at
-- `<dataDir>/worktrees/<task-id>`), so every existing cwd site keeps working.
--
-- `issue_repo_path` names the `repositories[].path` whose remote matches
-- `issue_url`; only that repository's PR body gets `Closes #N`. Both columns
-- are server-managed: written by `createTask` and the targeted
-- `tasks.setRepositories` / `setRepositoryPrUrl` / `setRepositoryCheckout`
-- writers, never by the generic `tasks.update` SET clause.
ALTER TABLE tasks ADD COLUMN repositories TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN issue_repo_path TEXT;

-- Persisted issue URL for a task created from a Git issue. Set server-side
-- by createTask (validated with parseIssueUrl and same-repo-checked against
-- the workdir's remote) — never patchable, mirroring pr_url (migration 031).
-- NULL means the task wasn't created from an issue.
ALTER TABLE tasks ADD COLUMN issue_url TEXT;

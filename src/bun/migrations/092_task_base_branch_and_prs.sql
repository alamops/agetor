-- Pull requests as a list, and the base branch NAME recorded at task creation
-- (docs/plans/create-all-prs-title-and-base.md, docs/architecture/persistence.md).
--
-- `base_branch` is the branch name `base_ref` (the pinned sha) was resolved
-- from at create time: `develop`, `release/1.2`. NULL when the ref was a tag,
-- a sha, a non-git directory, an `existingBranch` task, or the task predates
-- this migration (not reliably recoverable: one sha can match several refs).
--
-- `prs` is `TaskPr[]` as JSON, oldest first: every pull request opened for the
-- task's branch. It replaces the single `pr_url`, which is no longer written
-- (kept so a downgrade to an older build still opens; PRs opened after the
-- upgrade are not visible to it). A multi-repository task keeps its PRs on
-- `repositories[].prs`; its task-level `prs` stays '[]'.
--
-- Both columns are server-managed: `base_branch` is written only by
-- `tasks.insert`, `prs` only by the targeted `tasks.appendPr` UPDATE. The
-- generic `tasks.update` SET clause skips both, and neither write bumps
-- `updated_at`.
ALTER TABLE tasks ADD COLUMN base_branch TEXT;
ALTER TABLE tasks ADD COLUMN prs TEXT NOT NULL DEFAULT '[]';

-- Backfill: each stamped `pr_url` becomes a one-entry list. The head is the
-- last-seen checkout, else the task branch; the base and number were never
-- recorded. `repositories[].prUrl` entries are converted at read time instead
-- (`parseTaskRepositories`), since they live inside a JSON column.
UPDATE tasks
SET prs = json_array(json_object(
  'url', pr_url,
  'head', COALESCE(checkout_branch, branch),
  'base', NULL,
  'number', NULL,
  'createdAt', updated_at
))
WHERE pr_url IS NOT NULL AND pr_url <> '';

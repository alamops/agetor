-- Allow-rules now live as native claude permission entries in each task's
-- `.claude/settings.local.json` `permissions.allow` array. The legacy
-- `approval_rules` SQLite table (introduced in 010_approval_rules.sql) is
-- orphaned. Drop it on upgrade.
--
-- Existing rows are lost in the migration. That's acceptable: rules were
-- per-task, and tasks are short-lived. Users in flight may need to re-tick
-- "Allow always" on the next matching tool call. The cost is one extra
-- approval card per (task, tool); no data corruption or hang.
DROP TABLE IF EXISTS approval_rules;

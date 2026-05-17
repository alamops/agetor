-- Path-only references the user has attached to the task (files and folders
-- on their local machine). Replaces the image-upload `attachments` column from
-- migration 006 — agetor no longer copies or uploads anything, it just inlines
-- the absolute paths into the launch prompt as text. The old `attachments`
-- column is left dormant for legacy rows; new code never reads from it.
ALTER TABLE tasks ADD COLUMN refs TEXT NOT NULL DEFAULT '[]';

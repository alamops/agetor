-- Per-task composer draft: the unsent text + attached references currently
-- sitting in the task details modal's composer, autosaved so closing the
-- modal (or restarting agetor) doesn't lose in-progress typing. Stored as a
-- single JSON object ({ text, references }), mirroring the `refs` column
-- pattern from migration 012. NULL means "composer is empty" — distinct from
-- `backlog` (migration 025), which holds explicit, multi-item saved drafts.
ALTER TABLE tasks ADD COLUMN draft TEXT;

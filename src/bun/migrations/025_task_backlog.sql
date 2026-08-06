-- Per-task "messages backlog": saved, not-yet-sent draft messages the user
-- wants to send later. Stored as a JSON array of BacklogMessage objects
-- ({ id, text, references, createdAt }), mirroring the `refs` column pattern
-- from migration 012. Legacy rows default to an empty list.
ALTER TABLE tasks ADD COLUMN backlog TEXT NOT NULL DEFAULT '[]';

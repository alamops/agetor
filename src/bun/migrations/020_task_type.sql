-- Cosmetic task classification ("task" | "bug" | "spike"). Drives the icon
-- and left-border color on the kanban card; has no effect on orchestration.
-- Default "task" backfills legacy rows; new inserts always pass a value.
ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'task';

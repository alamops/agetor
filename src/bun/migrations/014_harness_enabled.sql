-- Soft-delete / enable toggle for harnesses. Default 1 covers existing rows
-- (both built-ins and user aliases): everything is enabled until the user
-- explicitly turns it off in Settings. Disabling hides the harness from the
-- New Task picker but leaves historical `tasks.agent = <id>` references
-- intact, so completed runs stay attributable.
ALTER TABLE harnesses ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;

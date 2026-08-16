-- Board-level TODO/task-tools progress summary — `{ completed, total }` JSON,
-- derived by the orchestrator's chunk handler (via `deriveTodoProgress` /
-- `summarizeTodoProgress`, src/shared/todo-progress.ts) from a task's
-- TodoWrite/TaskCreate/TaskUpdate tool events and persisted here so the
-- kanban board can render a mini progress badge from the 2s `/tasks` poll
-- without loading per-task events. NULL until the task's first todo-family
-- tool call. Mirrors the `plans` column pattern from migration 041.
ALTER TABLE tasks ADD COLUMN todo_progress TEXT;

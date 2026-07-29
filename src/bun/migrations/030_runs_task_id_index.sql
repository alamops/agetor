-- `runs.task_id` had no index — every /tasks poll's LEFT JOIN and every
-- eventsForTask/hasEventsBefore query (JOIN runs ON runs.task_id = ...) did a
-- full table scan of `runs`. Cheap, additive, safe to apply on an existing
-- large runs table.
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);

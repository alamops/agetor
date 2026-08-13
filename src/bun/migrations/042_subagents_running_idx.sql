-- Partial index for the `status = 'running'` scans that dominate reads on
-- this table: `hasRunning`/`hasAnyRunning` run every 30s from the headless
-- daemon's idle loop, and `subagents` is append-only in practice (rows are
-- flipped, never deleted), so it only grows. The common case — zero running
-- rows — must stay a cheap index lookup rather than a full table scan.
CREATE INDEX IF NOT EXISTS idx_subagents_running
  ON subagents(task_id) WHERE status = 'running';

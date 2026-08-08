-- Covering index for runs.userMessageHistory: user-stream events, newest-first,
-- main-agent only (subagent rows are excluded by the query).
CREATE INDEX IF NOT EXISTS idx_run_events_user_history
  ON run_events(stream, id DESC) WHERE subagent_id IS NULL;

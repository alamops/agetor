-- Pending Cursor askQuestionToolCall cards. Written when the card is
-- registered, so boot can rebuild an unanswered question without scanning
-- run_events. Historical print-mode rejects are not rows.
-- No alias: nothing has shipped this id.
CREATE TABLE cursor_asks (
  task_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  outcome TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  PRIMARY KEY (task_id, tool_call_id)
);

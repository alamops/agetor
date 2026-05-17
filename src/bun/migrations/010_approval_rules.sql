-- Per-task "always allow" rules. Inserted when the user clicks "Allow always
-- for this task" on a PreToolUse approval; consulted on every subsequent
-- hook fire so we don't bother the user again for the same tool within the
-- same task. Question / ask_user answers don't persist — every clarifying
-- question is fresh by design (the agent picks what to ask each turn).
CREATE TABLE approval_rules (
  task_id    TEXT NOT NULL,
  tool_name  TEXT NOT NULL,
  decision   TEXT NOT NULL,           -- always 'allow' for now
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, tool_name)
);
CREATE INDEX idx_approval_rules_task ON approval_rules(task_id);

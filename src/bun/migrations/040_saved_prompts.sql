-- Saved prompts: user-global reusable snippets ({ name, content }), unrelated
-- to any single task — distinct from `tasks.draft` (per-task composer state)
-- and `tasks.backlog` (per-task queued messages).
CREATE TABLE saved_prompts (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

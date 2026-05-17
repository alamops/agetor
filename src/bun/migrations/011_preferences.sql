-- Tiny key-value store for user-level UI preferences that should survive
-- restarts but aren't tied to any single task or project.
--
-- First customer: NewTaskForm uses `lastModel:<agent>` and
-- `lastEffort:<agent>` so the model + effort pickers default to whatever
-- the user last submitted, per agent (claude-code, codex).
CREATE TABLE preferences (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

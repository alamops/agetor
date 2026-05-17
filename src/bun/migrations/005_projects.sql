-- Known projects. A project is just a working directory the user has selected
-- — either by browsing for one in the New Task picker, or implicitly by
-- creating a task with that workdir (auto-inserted by the orchestrator). The
-- picker reads from this table so users don't retype the same path for every
-- task. The path itself is the primary key; if the directory moves, the user
-- re-adds it.
CREATE TABLE projects (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  added_at INTEGER NOT NULL
);

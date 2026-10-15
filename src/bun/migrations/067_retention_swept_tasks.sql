-- Archived-history retention's "this task's last sweep completed" record
-- (docs/plans/non-blocking-session-restore.md, decision G). One row per
-- archived task whose sweep ran to completion, keyed by what that sweep saw
-- (`<archived_at>:<maxBytes>:<max event id>`); an unchanged key means there is
-- nothing new to trim, so the pass skips the task.
--
-- Its own table rather than one JSON blob in `preferences`: the blob grew by
-- ~80 bytes per archived task and rode along on every `GET /preferences`
-- (boot, Settings, the New Task form, the launch dialogs) and `agetor config
-- ls`, and every pass rewrote all of it. Rows here are written per task as its
-- sweep completes, and a deleted task's row goes with it (ON DELETE CASCADE).
CREATE TABLE retention_swept_tasks (
  task_id   TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  sweep_key TEXT NOT NULL
);

-- The pre-table record (unreleased, only ever written by development builds of
-- this branch). Dropping it costs at most one extra sweep per archived task.
DELETE FROM preferences WHERE key = 'retention:sweptTasks';

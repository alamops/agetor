-- Per-task revision log, maintained by SQLite triggers, so the board can fetch
-- only the tasks that changed since a cursor (docs/plans/non-blocking-core.md §3).
--
-- `task_rev_meta` is a single row: `epoch` identifies THIS database (a client
-- cursor minted against a wiped or different data dir carries another epoch and
-- is answered with a full snapshot), `rev` is the monotonic counter.
--
-- `task_revs` holds one row per task: the `rev` of its latest change and
-- `deleted = 1` once the task row is gone (a tombstone). There is deliberately
-- no foreign key to `tasks`, so the row survives the task's deletion.
--
-- Every trigger bumps `rev` by one and upserts the row of the affected task.
-- A task counts as changed when its own row is inserted, updated (any column,
-- server-managed ones included) or deleted, when a run of it is inserted or
-- changes `status`, or when a subagent of it is inserted or changes `status`:
-- those are the child rows the /tasks projection derives fields from. A change
-- to another column of a run (`ended_at` alone) does not bump.
--
-- The triggers never write to `tasks`, so they cannot bump `updated_at` (which
-- server-managed columns must not do) and cannot recurse; SQLite's
-- `recursive_triggers` pragma is off by default and nothing here depends on it.
--
-- No backfill: a client with no cursor (or a stale epoch) gets a full snapshot,
-- and `rev` 0 means "nothing changed since the database was created".
--
-- Additive only: two new tables, one index and triggers, no ALTER and no DROP of
-- anything existing. An older build ignores the new tables; its writes still
-- fire these triggers (they live in the database file), which is harmless.

CREATE TABLE task_rev_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch TEXT NOT NULL,
  rev INTEGER NOT NULL
);

INSERT INTO task_rev_meta (id, epoch, rev) VALUES (1, lower(hex(randomblob(8))), 0);

CREATE TABLE task_revs (
  task_id TEXT PRIMARY KEY,
  rev INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_task_revs_rev ON task_revs(rev);

CREATE TRIGGER trg_task_revs_tasks_insert AFTER INSERT ON tasks
BEGIN
  UPDATE task_rev_meta SET rev = rev + 1 WHERE id = 1;
  INSERT INTO task_revs (task_id, rev, deleted)
    VALUES (NEW.id, (SELECT rev FROM task_rev_meta WHERE id = 1), 0)
    ON CONFLICT(task_id) DO UPDATE SET rev = excluded.rev, deleted = excluded.deleted;
END;

CREATE TRIGGER trg_task_revs_tasks_update AFTER UPDATE ON tasks
BEGIN
  UPDATE task_rev_meta SET rev = rev + 1 WHERE id = 1;
  INSERT INTO task_revs (task_id, rev, deleted)
    VALUES (NEW.id, (SELECT rev FROM task_rev_meta WHERE id = 1), 0)
    ON CONFLICT(task_id) DO UPDATE SET rev = excluded.rev, deleted = excluded.deleted;
END;

CREATE TRIGGER trg_task_revs_tasks_delete AFTER DELETE ON tasks
BEGIN
  UPDATE task_rev_meta SET rev = rev + 1 WHERE id = 1;
  INSERT INTO task_revs (task_id, rev, deleted)
    VALUES (OLD.id, (SELECT rev FROM task_rev_meta WHERE id = 1), 1)
    ON CONFLICT(task_id) DO UPDATE SET rev = excluded.rev, deleted = excluded.deleted;
END;

CREATE TRIGGER trg_task_revs_runs_insert AFTER INSERT ON runs
BEGIN
  UPDATE task_rev_meta SET rev = rev + 1 WHERE id = 1;
  INSERT INTO task_revs (task_id, rev, deleted)
    VALUES (NEW.task_id, (SELECT rev FROM task_rev_meta WHERE id = 1), 0)
    ON CONFLICT(task_id) DO UPDATE SET rev = excluded.rev, deleted = excluded.deleted;
END;

CREATE TRIGGER trg_task_revs_runs_status AFTER UPDATE OF status ON runs
BEGIN
  UPDATE task_rev_meta SET rev = rev + 1 WHERE id = 1;
  INSERT INTO task_revs (task_id, rev, deleted)
    VALUES (NEW.task_id, (SELECT rev FROM task_rev_meta WHERE id = 1), 0)
    ON CONFLICT(task_id) DO UPDATE SET rev = excluded.rev, deleted = excluded.deleted;
END;

CREATE TRIGGER trg_task_revs_subagents_insert AFTER INSERT ON subagents
BEGIN
  UPDATE task_rev_meta SET rev = rev + 1 WHERE id = 1;
  INSERT INTO task_revs (task_id, rev, deleted)
    VALUES (NEW.task_id, (SELECT rev FROM task_rev_meta WHERE id = 1), 0)
    ON CONFLICT(task_id) DO UPDATE SET rev = excluded.rev, deleted = excluded.deleted;
END;

CREATE TRIGGER trg_task_revs_subagents_status AFTER UPDATE OF status ON subagents
BEGIN
  UPDATE task_rev_meta SET rev = rev + 1 WHERE id = 1;
  INSERT INTO task_revs (task_id, rev, deleted)
    VALUES (NEW.task_id, (SELECT rev FROM task_rev_meta WHERE id = 1), 0)
    ON CONFLICT(task_id) DO UPDATE SET rev = excluded.rev, deleted = excluded.deleted;
END;

-- OpenCode server driver: child-session bookkeeping
-- (docs/architecture/harness-opencode.md, docs/plans/opencode-server-driver.md
-- decision R4). No alias: nothing has shipped this id.
--
-- 1. The child sessions agetor itself interrupted. Interrupting a background
--    subagent makes OpenCode wake its parent with a synthetic "subagent
--    cancelled" item; the orchestrator asks this table whether that wake is the
--    tail of agetor's own Stop, also after a core restart. Written by
--    `noteOpencodeChildStoppedByAgetor` (src/bun/opencode-subagents.ts), read by
--    `wasOpencodeChildStoppedByAgetor` through the primary key; a row counts for
--    24 h and older rows are pruned on each write through the `stopped_at`
--    index. Its own table, not a `subagents` column, because the note can come
--    before the child's subagent row exists, and a placeholder row would show up
--    as a tab. No foreign key to `tasks`: the note must never fail, and a
--    deleted task's rows age out like any other.
CREATE TABLE opencode_stopped_children (
  child_session_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  stopped_at INTEGER NOT NULL
);
CREATE INDEX opencode_stopped_children_at_idx ON opencode_stopped_children(stopped_at);

-- 2. OpenCode subagent rows by status: the boot linger's
--    `subagents.opencodeOrphanedTaskIdsSince` (status = 'orphaned', no task)
--    and the driver's relist `subagents.settledOpencodeChildSessionIds`
--    (one task, settled statuses) SEARCH it instead of scanning `subagents` or
--    loading every row of the task.
CREATE INDEX idx_subagents_opencode_status ON subagents(status, task_id) WHERE parent_kind = 'opencode_subagent';

-- Track Claude Code background / sub agents the main agent spawns. Each one is
-- a separate sidechain transcript that claude writes at
-- `<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.jsonl` (with a
-- `agent-<agentId>.meta.json` sidecar), a sibling of the main session JSONL we
-- already tail. We tail those files too and store their events in the SAME
-- run_events table, tagged with `subagent_id` (NULL = the main agent's own
-- stream). The `subagents` table is the per-stream registry that drives the
-- read-only tab strip in the run panel.
--
-- `parent_kind` generalises the registry so a future `claude --bg` independent
-- background session (its own top-level JSONL, enumerated via
-- `claude agents --json`) can be a second kind of agent stream without a schema
-- change — only the tailer/discovery differs.
ALTER TABLE run_events ADD COLUMN subagent_id TEXT;

-- Rebuild the dedup index to be subagent-aware. A subagent line carries its own
-- claude `uuid`, unique per file; keying on (run_id, subagent_id, line_uuid)
-- guarantees a subagent event and a main-stream event can never collide under
-- the same run, and keeps a per-file replay-from-offset-0 on reattach
-- idempotent (same role the original (run_id, line_uuid) index played for the
-- main stream). Existing rows have subagent_id NULL → IFNULL(...,'') so they
-- keep exactly their prior uniqueness semantics.
DROP INDEX IF EXISTS run_events_run_line_uuid;
CREATE UNIQUE INDEX run_events_run_sub_line_uuid
  ON run_events(run_id, IFNULL(subagent_id, ''), line_uuid) WHERE line_uuid IS NOT NULL;

CREATE TABLE IF NOT EXISTS subagents (
  id          TEXT PRIMARY KEY,                       -- claude agentId (basename of agent-<id>.jsonl)
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id      TEXT REFERENCES runs(id) ON DELETE CASCADE, -- parent run active when the subagent was spawned
  parent_kind TEXT NOT NULL DEFAULT 'subagent',       -- 'subagent' | 'bg_session' (future)
  agent_type  TEXT,                                   -- meta.json.agentType (e.g. "Explore")
  description TEXT,                                   -- meta.json.description
  spawn_depth INTEGER NOT NULL DEFAULT 1,             -- meta.json.spawnDepth (1 = spawned by the main agent)
  source_path TEXT NOT NULL,                          -- absolute path to agent-<id>.jsonl
  status      TEXT NOT NULL DEFAULT 'running',        -- running|completed|failed|cancelled|orphaned
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_subagents_task ON subagents(task_id, started_at);

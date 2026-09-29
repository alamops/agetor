-- Pipelines: named, reusable graphs of agent-profile-bound steps connected
-- by edges (`Pipeline`/`PipelineGraph`, src/shared/types.ts) — the templates
-- a pipeline task is launched from. See docs/plans/pipelines.md (§3, D1/D8).
-- `name_key` is `lower(trim(name))`, maintained by `db.ts`'s `pipelines`
-- module (never derived in SQL) and UNIQUE for the same reason
-- `agent_profiles.name_key` is (052): the CLI's by-name lookup
-- (`matchPipelineRef`) and the create/update routes get a single, race-free
-- constraint violation instead of a read-then-write check. `graph` is the
-- normalized `PipelineGraph` JSON returned by `validatePipelineGraph` — the
-- server never stores an un-normalized graph. There is no FK from
-- `tasks.pipeline_id` to this table: like `agent_profiles`, a pipeline row
-- can be deleted while tasks still reference it (`pipelines.delete` is never
-- blocked, mirroring `agentProfiles.delete` — D8 in the plan) because a
-- started run is already frozen onto `tasks.pipeline_run.snapshot` and
-- doesn't need the live row to keep running.
CREATE TABLE pipelines (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  graph       TEXT NOT NULL,
  max_steps   INTEGER NOT NULL DEFAULT 25,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

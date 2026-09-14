-- Agent profiles: reusable, named bundles of harness + model + effort + mode
-- + fast/maxMode + free-text instructions + skills (`AgentProfile`,
-- src/shared/types.ts), picked on task launch instead of choosing each field
-- by hand — see docs/plans/agent-profiles.md. `name_key` is `lower(trim(name))`,
-- maintained by `db.ts`'s `agentProfiles` module (never derived in SQL), and
-- is UNIQUE so the CLI's by-name lookup (`matchAgentProfileRef`) and the
-- create/update routes can treat a name clash as a single, race-free
-- constraint violation rather than a read-then-write check. `harness_id` is
-- a SOFT reference — there is no FK — because a profile must keep pointing
-- at a harness that no longer exists just as gracefully as a task's `agent`
-- column already does; instead, `harnesses.delete` is extended to refuse the
-- delete while any profile still references the harness (`HarnessInUseError`
-- gains `profileIds`), so a profile never silently outlives its harness.
CREATE TABLE agent_profiles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  name_key     TEXT NOT NULL UNIQUE,
  harness_id   TEXT NOT NULL,
  model        TEXT NOT NULL,
  effort       TEXT,
  mode         TEXT,
  fast         INTEGER NOT NULL DEFAULT 0,
  max_mode     INTEGER NOT NULL DEFAULT 0,
  instructions TEXT NOT NULL DEFAULT '',
  skills_json  TEXT NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX idx_agent_profiles_harness_id ON agent_profiles(harness_id);

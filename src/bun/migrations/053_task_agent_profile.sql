-- Binds a task to the `agent_profiles` row it was launched from (soft
-- reference, migration 052) plus a point-in-time JSON snapshot
-- (`AgentProfileSnapshot`, src/shared/types.ts) captured the moment the
-- profile was applied. Both columns are written ONLY by `tasks.insert` (at
-- create time) and `tasks.setAgentProfile` (its own targeted UPDATE) — never
-- by the generic `tasks.update` SET clause, same treatment as `sent_files`
-- (050) / `fx_recovery` (051): an unrelated PATCH landing mid-first-run must
-- not clobber the snapshot, and the write never bumps `updated_at` either.
-- `agent_profile_id` NULL means "no agent" (the pre-existing manual
-- harness/model/effort/mode flow); `agent_profile` is NULL whenever
-- `agent_profile_id` is NULL and non-NULL otherwise. No backfill needed —
-- every existing row reads as "no agent", which is correct for tasks that
-- predate this feature.
ALTER TABLE tasks ADD COLUMN agent_profile_id TEXT;
ALTER TABLE tasks ADD COLUMN agent_profile TEXT;

-- Binds a task to the pipeline run it is (or is a hidden step of) — see
-- docs/plans/pipelines.md (D1/D2/D11) and `PipelineRunState`/`PipelineStep`
-- in src/shared/types.ts. Two independent pairs of columns, used by two
-- different kinds of `tasks` rows:
--
--   * `pipeline_id` / `pipeline_run` live on the PARENT (board) task — the
--     one the user sees as a Pipeline card. `pipeline_id` is a soft
--     reference to `pipelines.id` (migration 056; no FK, same rationale as
--     `agent_profiles.harness_id` and `tasks.agent_profile_id` — a deleted
--     pipeline must not strand an already-started run, which lives entirely
--     off the frozen `pipeline_run.snapshot`). `pipeline_run` is the JSON
--     `PipelineRunState` — server-managed run progress (active step
--     executions, partial joins, blocks, history) — written ONLY by
--     `tasks.insert` (the initial idle state, at create time) and
--     `tasks.setPipelineRun`'s own targeted UPDATE, exactly like
--     `agent_profile`/`sent_files`/`fx_recovery` before it: never by the
--     generic `tasks.update` SET clause, and that write never bumps
--     `updated_at` either.
--
--   * `pipeline_parent_id` / `pipeline_step_id` live on hidden STEP tasks —
--     one per executed `PipelineStep`, sharing the parent's worktree (D2).
--     `pipeline_parent_id` points back at the parent task's id (soft
--     reference, indexed below since the runner and the board/`agetor ls`
--     filter look up "every step of parent X" and "hide rows with this set"
--     respectively) and `pipeline_step_id` names the `PipelineStep.id` this
--     task executes. Both are written ONLY by `tasks.insert` at the step
--     row's creation and never change afterward — a step task's identity
--     within its pipeline run is fixed for its whole lifetime.
--
-- All four columns are skipped by the generic `tasks.update` SET clause and
-- are not in `ALLOWED_PATCH_FIELDS` (server.ts) — none of them are ever
-- PATCHable.
ALTER TABLE tasks ADD COLUMN pipeline_id TEXT;
ALTER TABLE tasks ADD COLUMN pipeline_run TEXT;
ALTER TABLE tasks ADD COLUMN pipeline_parent_id TEXT;
ALTER TABLE tasks ADD COLUMN pipeline_step_id TEXT;

CREATE INDEX idx_tasks_pipeline_parent ON tasks(pipeline_parent_id);

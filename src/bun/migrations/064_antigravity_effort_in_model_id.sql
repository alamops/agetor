-- Antigravity: reasoning effort now rides in the model id suffix
-- (gemini-4-argon-high, gemini-3.8-flash-low, ...), and the command builder
-- no longer emits `--effort` at all. A separate saved effort on an
-- antigravity task or agent profile is therefore meaningless, and the old
-- `max` / `xhigh` values were never accepted by `agy --effort` anyway. Clear
-- them so the effort state of these rows is fully empty, matching what the
-- pickers now show (every MODEL_EFFORT_SUPPORT.antigravity set is empty).
--
-- Kind-joined: effort is only meaningful, and only cleared, on antigravity
-- rows. Frozen `tasks.agent_profile` / `tasks.pipeline_run` snapshots are
-- deliberately NOT rewritten (harmless: the builder ignores effort for this
-- kind), and `updated_at` is left alone.
--
-- Idempotent by construction: re-running matches no row (effort IS NOT NULL
-- is false after the first pass) and the DELETE of an absent key is a no-op.
UPDATE tasks
SET effort = NULL
WHERE effort IS NOT NULL
  AND agent IN (SELECT id FROM harnesses WHERE kind = 'antigravity');

UPDATE agent_profiles
SET effort = NULL
WHERE effort IS NOT NULL
  AND harness_id IN (SELECT id FROM harnesses WHERE kind = 'antigravity');

-- The CLI picker seed for the removed effort picker. Written only by
-- `agetor add` after an effort pick; nothing reads it for antigravity now.
DELETE FROM preferences WHERE key = 'lastEffort:antigravity';

-- Cursor: this release adds a CURSOR_MODEL_SPECS entry for Gemini 4 Argon
-- (`gemini-4-argon`) with three effort tiers (high/medium/low). cursor-agent's
-- suffixed variant ids (gemini-4-argon-{high,medium,low}) are now "covered by
-- the catalog", so every picker hides the discovered rows. A task or agent
-- profile that picked one of those as a discovered-only row before this
-- release would otherwise render as an unlisted row with a collapsed effort
-- dropdown. Normalize to base id + effort, the shape cursorModelArg
-- re-composes into the SAME --model argv.
--
-- The kind join (harnesses.kind = 'cursor') is load-bearing here: the very
-- same literals gemini-4-argon-{high,medium,low} are the antigravity kind's
-- curated model ids (effort rides in the id suffix there), and those rows
-- must stay verbatim. Matching the model alone would corrupt them.
--
-- `fast` is written (always 0) because no -fast form exists today; zeroing a
-- stale fast=1 keeps a future Fast tier from silently attaching the task to a
-- pricier variant once the id gains one (same rationale as 060/062).
-- Kind-joined also because effort/fast are only meaningful on cursor rows.
--
-- `updated_at` is left alone, and frozen `tasks.agent_profile` /
-- `tasks.pipeline_run` JSON snapshots are NOT rewritten.
UPDATE tasks
SET effort = CASE
      WHEN model LIKE 'gemini-4-argon-high%' THEN 'high'
      WHEN model LIKE 'gemini-4-argon-medium%' THEN 'medium'
      ELSE 'low'
    END,
    fast = 0,
    model = 'gemini-4-argon'
WHERE model IN ('gemini-4-argon-high', 'gemini-4-argon-medium', 'gemini-4-argon-low')
  AND agent IN (SELECT id FROM harnesses WHERE kind = 'cursor');

UPDATE agent_profiles
SET effort = CASE
      WHEN model LIKE 'gemini-4-argon-high%' THEN 'high'
      WHEN model LIKE 'gemini-4-argon-medium%' THEN 'medium'
      ELSE 'low'
    END,
    fast = 0,
    model = 'gemini-4-argon'
WHERE model IN ('gemini-4-argon-high', 'gemini-4-argon-medium', 'gemini-4-argon-low')
  AND harness_id IN (SELECT id FROM harnesses WHERE kind = 'cursor');

-- The CLI picker seed: point a covered variant id at the base id.
UPDATE preferences
SET value = 'gemini-4-argon'
WHERE key = 'lastModel:cursor'
  AND value IN ('gemini-4-argon-high', 'gemini-4-argon-medium', 'gemini-4-argon-low');

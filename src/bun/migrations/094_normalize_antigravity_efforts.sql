-- Antigravity: reasoning effort is now a first-class effort pick on grouped
-- base models (`gemini-4-argon`, `gemini-3.8-flash`, …), and
-- `antigravityModelArg` composes `<base>-<effort>` for `agy --model` at launch
-- (matching Cursor).
--
-- Normalize ONLY the exact 18 formerly-curated flat suffixed model ids covered
-- by `ANTIGRAVITY_MODEL_SPECS` on antigravity-kind tasks, agent profiles, and
-- remembered preferences (`lastModel:antigravity` / `lastEffort:antigravity`)
-- to `model = <base>, effort = <effort>`. Every migrated row is guaranteed to
-- round-trip back to its exact original CLI `--model` id via
-- `antigravityModelArg` even when discovery is empty.
--
-- Explicit IN lists, never LIKE: discovered-only flat variants (including any
-- `-extra-high` ids whose exact suffix cannot be reconstructed without
-- discovery) and effort-less models (`gemini-pro-orchestrator*`) are left
-- untouched so their original CLI id is preserved verbatim; the picker renders
-- a stored flat variant with a read-time hint via `antigravityVariantOf`.
--
-- Kind-joined on `harnesses.kind = 'antigravity'` so no other harness is
-- touched. Frozen `tasks.agent_profile` / `tasks.pipeline_run` JSON snapshots
-- are deliberately not rewritten (`antigravityModelArg` passes flat variant
-- ids through verbatim).
--
-- Idempotent: after the first pass no row matches any of the 18 flat ids, so
-- re-running is a no-op.

UPDATE tasks
SET effort = CASE
      WHEN model LIKE '%-high' THEN 'high'
      WHEN model LIKE '%-medium' THEN 'medium'
      WHEN model LIKE '%-low' THEN 'low'
      ELSE effort
    END,
    model = CASE
      WHEN model LIKE '%-high' THEN substr(model, 1, length(model) - length('-high'))
      WHEN model LIKE '%-medium' THEN substr(model, 1, length(model) - length('-medium'))
      WHEN model LIKE '%-low' THEN substr(model, 1, length(model) - length('-low'))
      ELSE model
    END
WHERE agent IN (SELECT id FROM harnesses WHERE kind = 'antigravity')
  AND model IN (
    'gemini-4-argon-high', 'gemini-4-argon-medium', 'gemini-4-argon-low',
    'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
    'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
    'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
    'claude-opus-5-5-high', 'claude-opus-5-5-medium', 'claude-opus-5-5-low',
    'claude-sonnet-5-5-high', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-low',
    'gpt-oss-120b-medium'
  );

UPDATE agent_profiles
SET effort = CASE
      WHEN model LIKE '%-high' THEN 'high'
      WHEN model LIKE '%-medium' THEN 'medium'
      WHEN model LIKE '%-low' THEN 'low'
      ELSE effort
    END,
    model = CASE
      WHEN model LIKE '%-high' THEN substr(model, 1, length(model) - length('-high'))
      WHEN model LIKE '%-medium' THEN substr(model, 1, length(model) - length('-medium'))
      WHEN model LIKE '%-low' THEN substr(model, 1, length(model) - length('-low'))
      ELSE model
    END
WHERE harness_id IN (SELECT id FROM harnesses WHERE kind = 'antigravity')
  AND model IN (
    'gemini-4-argon-high', 'gemini-4-argon-medium', 'gemini-4-argon-low',
    'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
    'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
    'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
    'claude-opus-5-5-high', 'claude-opus-5-5-medium', 'claude-opus-5-5-low',
    'claude-sonnet-5-5-high', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-low',
    'gpt-oss-120b-medium'
  );

-- Remembered picker seed: record the extracted effort before stripping the
-- suffix from `lastModel:antigravity`.
INSERT INTO preferences (key, value, updated_at)
SELECT
  'lastEffort:antigravity',
  CASE
    WHEN value LIKE '%-high' THEN 'high'
    WHEN value LIKE '%-medium' THEN 'medium'
    WHEN value LIKE '%-low' THEN 'low'
  END,
  updated_at
FROM preferences
WHERE key = 'lastModel:antigravity'
  AND value IN (
    'gemini-4-argon-high', 'gemini-4-argon-medium', 'gemini-4-argon-low',
    'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
    'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
    'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
    'claude-opus-5-5-high', 'claude-opus-5-5-medium', 'claude-opus-5-5-low',
    'claude-sonnet-5-5-high', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-low',
    'gpt-oss-120b-medium'
  )
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

UPDATE preferences
SET value = CASE
      WHEN value LIKE '%-high' THEN substr(value, 1, length(value) - length('-high'))
      WHEN value LIKE '%-medium' THEN substr(value, 1, length(value) - length('-medium'))
      WHEN value LIKE '%-low' THEN substr(value, 1, length(value) - length('-low'))
      ELSE value
    END
WHERE key = 'lastModel:antigravity'
  AND value IN (
    'gemini-4-argon-high', 'gemini-4-argon-medium', 'gemini-4-argon-low',
    'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
    'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
    'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
    'claude-opus-5-5-high', 'claude-opus-5-5-medium', 'claude-opus-5-5-low',
    'claude-sonnet-5-5-high', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-low',
    'gpt-oss-120b-medium'
  );

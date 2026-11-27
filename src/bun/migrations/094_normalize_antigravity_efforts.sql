-- Antigravity: reasoning effort is now a first-class effort pick on grouped
-- base models (`gemini-4-neon`, `gemini-4-argon`, `gemini-3.8-flash`, …), and
-- `antigravityModelArg` composes `<base>-<effort>` for `agy --model` at launch
-- (matching Cursor).
--
-- Normalize previously stored flat suffixed model ids on antigravity-kind
-- tasks, agent profiles, and remembered preferences (`lastModel:antigravity`)
-- to `model = <base>, effort = <effort>` so existing rows land on the grouped
-- model row with their effort selected instead of appearing as unlisted flat
-- variants with a disabled Effort picker.
--
-- Kind-joined on `harnesses.kind = 'antigravity'` so no other harness is
-- touched. `-extra-high` and `-xhigh` are checked before `-high`. Models with
-- no effort suffix (`gemini-pro-orchestrator`, `-neon`, `-argon`) do not match
-- and stay verbatim. Frozen `tasks.agent_profile` / `tasks.pipeline_run` JSON
-- snapshots are deliberately not rewritten (`antigravityModelArg` passes flat
-- variant ids through verbatim).
--
-- Idempotent: after the first pass no matching antigravity model ends in an
-- effort suffix, so re-running is a no-op.

UPDATE tasks
SET effort = CASE
      WHEN model LIKE '%-extra-high' THEN 'xhigh'
      WHEN model LIKE '%-xhigh' THEN 'xhigh'
      WHEN model LIKE '%-medium' THEN 'medium'
      WHEN model LIKE '%-minimal' THEN 'minimal'
      WHEN model LIKE '%-high' THEN 'high'
      WHEN model LIKE '%-low' THEN 'low'
      WHEN model LIKE '%-max' THEN 'max'
      WHEN model LIKE '%-none' THEN 'none'
      ELSE effort
    END,
    model = CASE
      WHEN model LIKE '%-extra-high' THEN substr(model, 1, length(model) - length('-extra-high'))
      WHEN model LIKE '%-xhigh' THEN substr(model, 1, length(model) - length('-xhigh'))
      WHEN model LIKE '%-medium' THEN substr(model, 1, length(model) - length('-medium'))
      WHEN model LIKE '%-minimal' THEN substr(model, 1, length(model) - length('-minimal'))
      WHEN model LIKE '%-high' THEN substr(model, 1, length(model) - length('-high'))
      WHEN model LIKE '%-low' THEN substr(model, 1, length(model) - length('-low'))
      WHEN model LIKE '%-max' THEN substr(model, 1, length(model) - length('-max'))
      WHEN model LIKE '%-none' THEN substr(model, 1, length(model) - length('-none'))
      ELSE model
    END
WHERE agent IN (SELECT id FROM harnesses WHERE kind = 'antigravity')
  AND (
    (model LIKE '%-extra-high' AND length(model) > length('-extra-high')) OR
    (model LIKE '%-xhigh' AND length(model) > length('-xhigh')) OR
    (model LIKE '%-medium' AND length(model) > length('-medium')) OR
    (model LIKE '%-minimal' AND length(model) > length('-minimal')) OR
    (model LIKE '%-high' AND length(model) > length('-high')) OR
    (model LIKE '%-low' AND length(model) > length('-low')) OR
    (model LIKE '%-max' AND length(model) > length('-max')) OR
    (model LIKE '%-none' AND length(model) > length('-none'))
  );

UPDATE agent_profiles
SET effort = CASE
      WHEN model LIKE '%-extra-high' THEN 'xhigh'
      WHEN model LIKE '%-xhigh' THEN 'xhigh'
      WHEN model LIKE '%-medium' THEN 'medium'
      WHEN model LIKE '%-minimal' THEN 'minimal'
      WHEN model LIKE '%-high' THEN 'high'
      WHEN model LIKE '%-low' THEN 'low'
      WHEN model LIKE '%-max' THEN 'max'
      WHEN model LIKE '%-none' THEN 'none'
      ELSE effort
    END,
    model = CASE
      WHEN model LIKE '%-extra-high' THEN substr(model, 1, length(model) - length('-extra-high'))
      WHEN model LIKE '%-xhigh' THEN substr(model, 1, length(model) - length('-xhigh'))
      WHEN model LIKE '%-medium' THEN substr(model, 1, length(model) - length('-medium'))
      WHEN model LIKE '%-minimal' THEN substr(model, 1, length(model) - length('-minimal'))
      WHEN model LIKE '%-high' THEN substr(model, 1, length(model) - length('-high'))
      WHEN model LIKE '%-low' THEN substr(model, 1, length(model) - length('-low'))
      WHEN model LIKE '%-max' THEN substr(model, 1, length(model) - length('-max'))
      WHEN model LIKE '%-none' THEN substr(model, 1, length(model) - length('-none'))
      ELSE model
    END
WHERE harness_id IN (SELECT id FROM harnesses WHERE kind = 'antigravity')
  AND (
    (model LIKE '%-extra-high' AND length(model) > length('-extra-high')) OR
    (model LIKE '%-xhigh' AND length(model) > length('-xhigh')) OR
    (model LIKE '%-medium' AND length(model) > length('-medium')) OR
    (model LIKE '%-minimal' AND length(model) > length('-minimal')) OR
    (model LIKE '%-high' AND length(model) > length('-high')) OR
    (model LIKE '%-low' AND length(model) > length('-low')) OR
    (model LIKE '%-max' AND length(model) > length('-max')) OR
    (model LIKE '%-none' AND length(model) > length('-none'))
  );

-- Remembered picker seed: record the extracted effort before stripping the
-- suffix from `lastModel:antigravity`.
INSERT INTO preferences (key, value, updated_at)
SELECT
  'lastEffort:antigravity',
  CASE
    WHEN value LIKE '%-extra-high' THEN 'xhigh'
    WHEN value LIKE '%-xhigh' THEN 'xhigh'
    WHEN value LIKE '%-medium' THEN 'medium'
    WHEN value LIKE '%-minimal' THEN 'minimal'
    WHEN value LIKE '%-high' THEN 'high'
    WHEN value LIKE '%-low' THEN 'low'
    WHEN value LIKE '%-max' THEN 'max'
    WHEN value LIKE '%-none' THEN 'none'
  END,
  updated_at
FROM preferences
WHERE key = 'lastModel:antigravity'
  AND (
    (value LIKE '%-extra-high' AND length(value) > length('-extra-high')) OR
    (value LIKE '%-xhigh' AND length(value) > length('-xhigh')) OR
    (value LIKE '%-medium' AND length(value) > length('-medium')) OR
    (value LIKE '%-minimal' AND length(value) > length('-minimal')) OR
    (value LIKE '%-high' AND length(value) > length('-high')) OR
    (value LIKE '%-low' AND length(value) > length('-low')) OR
    (value LIKE '%-max' AND length(value) > length('-max')) OR
    (value LIKE '%-none' AND length(value) > length('-none'))
  )
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

UPDATE preferences
SET value = CASE
      WHEN value LIKE '%-extra-high' THEN substr(value, 1, length(value) - length('-extra-high'))
      WHEN value LIKE '%-xhigh' THEN substr(value, 1, length(value) - length('-xhigh'))
      WHEN value LIKE '%-medium' THEN substr(value, 1, length(value) - length('-medium'))
      WHEN value LIKE '%-minimal' THEN substr(value, 1, length(value) - length('-minimal'))
      WHEN value LIKE '%-high' THEN substr(value, 1, length(value) - length('-high'))
      WHEN value LIKE '%-low' THEN substr(value, 1, length(value) - length('-low'))
      WHEN value LIKE '%-max' THEN substr(value, 1, length(value) - length('-max'))
      WHEN value LIKE '%-none' THEN substr(value, 1, length(value) - length('-none'))
      ELSE value
    END
WHERE key = 'lastModel:antigravity'
  AND (
    (value LIKE '%-extra-high' AND length(value) > length('-extra-high')) OR
    (value LIKE '%-xhigh' AND length(value) > length('-xhigh')) OR
    (value LIKE '%-medium' AND length(value) > length('-medium')) OR
    (value LIKE '%-minimal' AND length(value) > length('-minimal')) OR
    (value LIKE '%-high' AND length(value) > length('-high')) OR
    (value LIKE '%-low' AND length(value) > length('-low')) OR
    (value LIKE '%-max' AND length(value) > length('-max')) OR
    (value LIKE '%-none' AND length(value) > length('-none'))
  );

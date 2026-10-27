-- Cursor: this release adds CURSOR_MODEL_SPECS entries for three new families
-- (`muse-wonder-1.0`, `muse-spark-1.3`, `deepseek-v41-flash-1017`), each with
-- its own effort tiers. cursor-agent's suffixed variant ids
-- (`<base>-{max,xhigh,high,medium,low,minimal,none}`) are now "covered by the
-- catalog", so every picker hides the discovered rows. A task or agent profile
-- that picked one of those as a discovered-only row before this release would
-- otherwise render as an unlisted row with a collapsed effort dropdown.
-- Normalize to base id + effort, the shape cursorModelArg re-composes into the
-- SAME --model argv (same convention as 055/056/060/062/064).
--
-- The kind join (harnesses.kind = 'cursor') keeps other kinds' rows verbatim:
-- these literals, or an fx Gateway id such as `meta/muse-wonder-1.0`, must
-- never be rewritten on a non-cursor row. Effort/speed are also only
-- meaningful on cursor rows.
--
-- `speed` is written ('off') because no -fast form exists for these families;
-- resetting a stale 'fast' keeps a future Fast tier from silently attaching
-- the task to a pricier variant once the id gains one (same rationale as
-- 060/062/064, which wrote the pre-072 `fast = 0`; 072 replaced that column
-- with `speed`).
--
-- Explicit IN lists, never LIKE: an unknown future suffix (for example
-- `muse-wonder-1.0-ultra`) is left alone instead of being folded into a bogus
-- effort. Only the variants cursor-agent actually lists per family are
-- folded; deepseek has no `xhigh`/`minimal`, and `none` exists only there.
--
-- Like 064, only `lastModel:cursor` is moved; `lastEffort:cursor` is left
-- alone (a picker seed the effort picker re-validates against the model).
-- `updated_at` is left alone, and frozen `tasks.agent_profile` /
-- `tasks.pipeline_run` JSON snapshots are NOT rewritten. One-way, and
-- idempotent: after the first pass no cursor-kind row matches a variant id.

-- muse-wonder-1.0
UPDATE tasks
SET effort = substr(model, length('muse-wonder-1.0-') + 1),
    speed = 'off',
    model = 'muse-wonder-1.0'
WHERE model IN ('muse-wonder-1.0-max', 'muse-wonder-1.0-xhigh', 'muse-wonder-1.0-high', 'muse-wonder-1.0-medium', 'muse-wonder-1.0-low', 'muse-wonder-1.0-minimal')
  AND agent IN (SELECT id FROM harnesses WHERE kind = 'cursor');

UPDATE agent_profiles
SET effort = substr(model, length('muse-wonder-1.0-') + 1),
    speed = 'off',
    model = 'muse-wonder-1.0'
WHERE model IN ('muse-wonder-1.0-max', 'muse-wonder-1.0-xhigh', 'muse-wonder-1.0-high', 'muse-wonder-1.0-medium', 'muse-wonder-1.0-low', 'muse-wonder-1.0-minimal')
  AND harness_id IN (SELECT id FROM harnesses WHERE kind = 'cursor');

-- The CLI picker seed: point a covered variant id at the base id.
UPDATE preferences
SET value = 'muse-wonder-1.0'
WHERE key = 'lastModel:cursor'
  AND value IN ('muse-wonder-1.0-max', 'muse-wonder-1.0-xhigh', 'muse-wonder-1.0-high', 'muse-wonder-1.0-medium', 'muse-wonder-1.0-low', 'muse-wonder-1.0-minimal');

-- muse-spark-1.3
UPDATE tasks
SET effort = substr(model, length('muse-spark-1.3-') + 1),
    speed = 'off',
    model = 'muse-spark-1.3'
WHERE model IN ('muse-spark-1.3-max', 'muse-spark-1.3-xhigh', 'muse-spark-1.3-high', 'muse-spark-1.3-medium', 'muse-spark-1.3-low', 'muse-spark-1.3-minimal')
  AND agent IN (SELECT id FROM harnesses WHERE kind = 'cursor');

UPDATE agent_profiles
SET effort = substr(model, length('muse-spark-1.3-') + 1),
    speed = 'off',
    model = 'muse-spark-1.3'
WHERE model IN ('muse-spark-1.3-max', 'muse-spark-1.3-xhigh', 'muse-spark-1.3-high', 'muse-spark-1.3-medium', 'muse-spark-1.3-low', 'muse-spark-1.3-minimal')
  AND harness_id IN (SELECT id FROM harnesses WHERE kind = 'cursor');

-- The CLI picker seed: point a covered variant id at the base id.
UPDATE preferences
SET value = 'muse-spark-1.3'
WHERE key = 'lastModel:cursor'
  AND value IN ('muse-spark-1.3-max', 'muse-spark-1.3-xhigh', 'muse-spark-1.3-high', 'muse-spark-1.3-medium', 'muse-spark-1.3-low', 'muse-spark-1.3-minimal');

-- deepseek-v41-flash-1017
UPDATE tasks
SET effort = substr(model, length('deepseek-v41-flash-1017-') + 1),
    speed = 'off',
    model = 'deepseek-v41-flash-1017'
WHERE model IN ('deepseek-v41-flash-1017-max', 'deepseek-v41-flash-1017-high', 'deepseek-v41-flash-1017-medium', 'deepseek-v41-flash-1017-low', 'deepseek-v41-flash-1017-none')
  AND agent IN (SELECT id FROM harnesses WHERE kind = 'cursor');

UPDATE agent_profiles
SET effort = substr(model, length('deepseek-v41-flash-1017-') + 1),
    speed = 'off',
    model = 'deepseek-v41-flash-1017'
WHERE model IN ('deepseek-v41-flash-1017-max', 'deepseek-v41-flash-1017-high', 'deepseek-v41-flash-1017-medium', 'deepseek-v41-flash-1017-low', 'deepseek-v41-flash-1017-none')
  AND harness_id IN (SELECT id FROM harnesses WHERE kind = 'cursor');

-- The CLI picker seed: point a covered variant id at the base id.
UPDATE preferences
SET value = 'deepseek-v41-flash-1017'
WHERE key = 'lastModel:cursor'
  AND value IN ('deepseek-v41-flash-1017-max', 'deepseek-v41-flash-1017-high', 'deepseek-v41-flash-1017-medium', 'deepseek-v41-flash-1017-low', 'deepseek-v41-flash-1017-none');

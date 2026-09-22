-- Cursor: this release adds a CURSOR_MODEL_SPECS entry for Grok 4.7
-- (`grok-4.7`), so cursor-agent's suffixed variant ids
-- (grok-4.7-{xhigh,high,medium,low} and their -fast forms) are now "covered
-- by the catalog" (`cursorModelIdCoveredByCatalog`) and every picker hides
-- the discovered rows. A task or agent profile that picked one of those
-- variants as a discovered-only row before this release — or was created
-- with the id passed explicitly — would otherwise render as an unlisted row
-- with a collapsed effort dropdown (the run itself still works —
-- cursorModelArg passes unknown ids through verbatim). Normalize to base id
-- + effort + fast, the shape cursorModelArg re-composes into the SAME
-- --model argv — same treatment as 049's Gemini Flash block.
--
-- `fast` is written in both directions on purpose: an unknown id ignores the
-- fast flag today, so a stored `grok-4.7-high` with a stale fast=1 runs the
-- regular tier — leaving that 1 in place would silently move the task onto
-- the Fast variant (twice the price) the moment the id becomes known.
-- Kind-joined because effort/fast are only meaningful on cursor rows.
-- `updated_at` is left alone, as in 034/049.
UPDATE tasks
SET effort = CASE
      WHEN model LIKE 'grok-4.7-xhigh%' THEN 'xhigh'
      WHEN model LIKE 'grok-4.7-high%' THEN 'high'
      WHEN model LIKE 'grok-4.7-medium%' THEN 'medium'
      ELSE 'low'
    END,
    fast = CASE WHEN model LIKE '%-fast' THEN 1 ELSE 0 END,
    model = 'grok-4.7'
WHERE model IN (
    'grok-4.7-xhigh', 'grok-4.7-xhigh-fast',
    'grok-4.7-high', 'grok-4.7-high-fast',
    'grok-4.7-medium', 'grok-4.7-medium-fast',
    'grok-4.7-low', 'grok-4.7-low-fast'
  )
  AND agent IN (SELECT id FROM harnesses WHERE kind = 'cursor');

-- Agent profiles pick from the same pickers, so they can hold the same
-- variant ids. A task's frozen `agent_profile` JSON snapshot is deliberately
-- NOT rewritten — it records what the task first ran with.
UPDATE agent_profiles
SET effort = CASE
      WHEN model LIKE 'grok-4.7-xhigh%' THEN 'xhigh'
      WHEN model LIKE 'grok-4.7-high%' THEN 'high'
      WHEN model LIKE 'grok-4.7-medium%' THEN 'medium'
      ELSE 'low'
    END,
    fast = CASE WHEN model LIKE '%-fast' THEN 1 ELSE 0 END,
    model = 'grok-4.7'
WHERE model IN (
    'grok-4.7-xhigh', 'grok-4.7-xhigh-fast',
    'grok-4.7-high', 'grok-4.7-high-fast',
    'grok-4.7-medium', 'grok-4.7-medium-fast',
    'grok-4.7-low', 'grok-4.7-low-fast'
  )
  AND harness_id IN (SELECT id FROM harnesses WHERE kind = 'cursor');

-- The CLI picker seed: a covered variant id no longer matches any offered
-- row, so point the pref at the base id it now belongs to.
UPDATE preferences
SET value = 'grok-4.7'
WHERE key = 'lastModel:cursor'
  AND value IN (
    'grok-4.7-xhigh', 'grok-4.7-xhigh-fast',
    'grok-4.7-high', 'grok-4.7-high-fast',
    'grok-4.7-medium', 'grok-4.7-medium-fast',
    'grok-4.7-low', 'grok-4.7-low-fast'
  );

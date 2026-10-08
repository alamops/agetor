-- Cursor: this release adds a CURSOR_MODEL_SPECS entry for Claude Haiku 5.5
-- (`claude-haiku-5-5`) with a Thinking toggle and five effort tiers
-- (max/xhigh/high/medium/low). cursor-agent's THINKING variant ids
-- (claude-haiku-5-5-thinking-{max,xhigh,high,medium,low}) are now "covered by
-- the catalog", so every picker hides the discovered rows. A task or agent
-- profile that picked one of those as a discovered-only row before this
-- release would otherwise render as an unlisted row with a collapsed effort
-- dropdown. Normalize to base id + effort, the shape cursorModelArg
-- re-composes into the SAME --model argv.
--
-- The No Thinking ids (claude-haiku-5-5-{low,medium,high,xhigh,max}) are
-- deliberately NOT rewritten: those rows are intentionally left as discovered
-- models and must keep launching No Thinking. Rewriting them to the base id
-- would silently switch them onto the Thinking variant.
--
-- `fast` is written (always 0) because no -fast form exists today; zeroing a
-- stale fast=1 keeps a future Fast tier from silently attaching the task to a
-- pricier variant once the id gains one (same rationale as 060). Kind-joined
-- because effort/fast are only meaningful on cursor rows.
--
-- The `-thinking-` infix in the patterns is load-bearing: 'claude-haiku-5-5-max%'
-- would not match 'claude-haiku-5-5-thinking-max'. xhigh is tested before high.
-- `updated_at` is left alone, and frozen `tasks.agent_profile` JSON snapshots
-- are NOT rewritten.
UPDATE tasks
SET effort = CASE
      WHEN model LIKE 'claude-haiku-5-5-thinking-max%' THEN 'max'
      WHEN model LIKE 'claude-haiku-5-5-thinking-xhigh%' THEN 'xhigh'
      WHEN model LIKE 'claude-haiku-5-5-thinking-high%' THEN 'high'
      WHEN model LIKE 'claude-haiku-5-5-thinking-medium%' THEN 'medium'
      ELSE 'low'
    END,
    fast = 0,
    model = 'claude-haiku-5-5'
WHERE model IN (
    'claude-haiku-5-5-thinking-max', 'claude-haiku-5-5-thinking-xhigh', 'claude-haiku-5-5-thinking-high',
    'claude-haiku-5-5-thinking-medium', 'claude-haiku-5-5-thinking-low'
  )
  AND agent IN (SELECT id FROM harnesses WHERE kind = 'cursor');

UPDATE agent_profiles
SET effort = CASE
      WHEN model LIKE 'claude-haiku-5-5-thinking-max%' THEN 'max'
      WHEN model LIKE 'claude-haiku-5-5-thinking-xhigh%' THEN 'xhigh'
      WHEN model LIKE 'claude-haiku-5-5-thinking-high%' THEN 'high'
      WHEN model LIKE 'claude-haiku-5-5-thinking-medium%' THEN 'medium'
      ELSE 'low'
    END,
    fast = 0,
    model = 'claude-haiku-5-5'
WHERE model IN (
    'claude-haiku-5-5-thinking-max', 'claude-haiku-5-5-thinking-xhigh', 'claude-haiku-5-5-thinking-high',
    'claude-haiku-5-5-thinking-medium', 'claude-haiku-5-5-thinking-low'
  )
  AND harness_id IN (SELECT id FROM harnesses WHERE kind = 'cursor');

-- The CLI picker seed: point a covered variant id at the base id.
UPDATE preferences
SET value = 'claude-haiku-5-5'
WHERE key = 'lastModel:cursor'
  AND value IN (
    'claude-haiku-5-5-thinking-max', 'claude-haiku-5-5-thinking-xhigh', 'claude-haiku-5-5-thinking-high',
    'claude-haiku-5-5-thinking-medium', 'claude-haiku-5-5-thinking-low'
  );

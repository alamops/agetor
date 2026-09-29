-- Cursor: this release adds a CURSOR_MODEL_SPECS entry for Claude Sonnet 5.5
-- (`claude-sonnet-5-5`, measured on cursor-agent 2026.09.26: five effort
-- tiers — max/xhigh/high/medium/low — with no -fast forms and no
-- -thinking- variants), so cursor-agent's suffixed variant ids
-- (claude-sonnet-5-5-{max,xhigh,high,medium,low}) are now "covered by the
-- catalog" (`cursorModelIdCoveredByCatalog`) and every picker hides the
-- discovered rows. A task or agent profile that picked one of those variants
-- as a discovered-only row before this release — or was created with the id
-- passed explicitly — would otherwise render as an unlisted row with a
-- collapsed effort dropdown (the run itself still works — cursorModelArg
-- passes unknown ids through verbatim). Normalize to base id + effort, the
-- shape cursorModelArg re-composes into the SAME --model argv — same
-- treatment as 055's Grok 4.7 and 056's Opus 5.5 blocks.
--
-- `fast` is still written (always 0) even though no -fast forms exist for
-- this model: a stale fast=1 is ignored today because
-- `cursorModelSupportsFast` is false for this spec, but zeroing it keeps a
-- future Cursor `-fast` addition from silently switching the task onto a
-- Fast variant (a pricier tier) the moment the id gains one. Kind-joined
-- because effort/fast are only meaningful on cursor rows.
--
-- Do NOT touch `claude-sonnet-5-*` (Sonnet 5) ids — only the
-- `claude-sonnet-5-5-*` (Sonnet 5.5) ones. `updated_at` is left alone, as in
-- 034/049/055/056. Frozen `tasks.agent_profile` JSON snapshots are
-- deliberately NOT rewritten — they record what the task first ran with.
UPDATE tasks
SET effort = CASE
      WHEN model LIKE 'claude-sonnet-5-5-max%' THEN 'max'
      WHEN model LIKE 'claude-sonnet-5-5-xhigh%' THEN 'xhigh'
      WHEN model LIKE 'claude-sonnet-5-5-high%' THEN 'high'
      WHEN model LIKE 'claude-sonnet-5-5-medium%' THEN 'medium'
      ELSE 'low'
    END,
    fast = 0,
    model = 'claude-sonnet-5-5'
WHERE model IN (
    'claude-sonnet-5-5-max', 'claude-sonnet-5-5-xhigh', 'claude-sonnet-5-5-high',
    'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-low'
  )
  AND agent IN (SELECT id FROM harnesses WHERE kind = 'cursor');

-- Agent profiles pick from the same pickers, so they can hold the same
-- variant ids. A task's frozen `agent_profile` JSON snapshot is deliberately
-- NOT rewritten — it records what the task first ran with.
UPDATE agent_profiles
SET effort = CASE
      WHEN model LIKE 'claude-sonnet-5-5-max%' THEN 'max'
      WHEN model LIKE 'claude-sonnet-5-5-xhigh%' THEN 'xhigh'
      WHEN model LIKE 'claude-sonnet-5-5-high%' THEN 'high'
      WHEN model LIKE 'claude-sonnet-5-5-medium%' THEN 'medium'
      ELSE 'low'
    END,
    fast = 0,
    model = 'claude-sonnet-5-5'
WHERE model IN (
    'claude-sonnet-5-5-max', 'claude-sonnet-5-5-xhigh', 'claude-sonnet-5-5-high',
    'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-low'
  )
  AND harness_id IN (SELECT id FROM harnesses WHERE kind = 'cursor');

-- The CLI picker seed: a covered variant id no longer matches any offered
-- row, so point the pref at the base id it now belongs to.
UPDATE preferences
SET value = 'claude-sonnet-5-5'
WHERE key = 'lastModel:cursor'
  AND value IN (
    'claude-sonnet-5-5-max', 'claude-sonnet-5-5-xhigh', 'claude-sonnet-5-5-high',
    'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-low'
  );

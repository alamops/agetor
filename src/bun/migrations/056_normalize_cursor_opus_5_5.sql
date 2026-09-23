-- Cursor: this release adds a CURSOR_MODEL_SPECS entry for Claude Opus 5.5
-- (`claude-opus-5-5`, measured on cursor-agent 2026.09.18: five effort
-- tiers — max/xhigh/high/medium/low — each with a -fast form, no
-- -thinking- variants), so cursor-agent's suffixed variant ids
-- (claude-opus-5-5-{max,xhigh,high,medium,low} and their -fast forms) are
-- now "covered by the catalog" (`cursorModelIdCoveredByCatalog`) and every
-- picker hides the discovered rows. A task or agent profile that picked one
-- of those variants as a discovered-only row before this release — or was
-- created with the id passed explicitly — would otherwise render as an
-- unlisted row with a collapsed effort dropdown (the run itself still
-- works — cursorModelArg passes unknown ids through verbatim). Normalize to
-- base id + effort + fast, the shape cursorModelArg re-composes into the
-- SAME --model argv — same treatment as 055's Grok 4.7 block.
--
-- `fast` is written in both directions on purpose: an unknown id ignores the
-- fast flag today, so a stored `claude-opus-5-5-high` with a stale fast=1
-- runs the regular tier — leaving that 1 in place would silently move the
-- task onto the Fast variant (twice the price) the moment the id becomes
-- known. Kind-joined because effort/fast are only meaningful on cursor rows.
--
-- Do NOT touch `claude-opus-5-*` (Opus 5, no `-5-` suffix repeated) ids —
-- only the `claude-opus-5-5-*` (Opus 5.5) ones. `updated_at` is left alone,
-- as in 034/049/055. Frozen `tasks.agent_profile` JSON snapshots are
-- deliberately NOT rewritten — they record what the task first ran with.
UPDATE tasks
SET effort = CASE
      WHEN model LIKE 'claude-opus-5-5-max%' THEN 'max'
      WHEN model LIKE 'claude-opus-5-5-xhigh%' THEN 'xhigh'
      WHEN model LIKE 'claude-opus-5-5-high%' THEN 'high'
      WHEN model LIKE 'claude-opus-5-5-medium%' THEN 'medium'
      ELSE 'low'
    END,
    fast = CASE WHEN model LIKE '%-fast' THEN 1 ELSE 0 END,
    model = 'claude-opus-5-5'
WHERE model IN (
    'claude-opus-5-5-max', 'claude-opus-5-5-max-fast',
    'claude-opus-5-5-xhigh', 'claude-opus-5-5-xhigh-fast',
    'claude-opus-5-5-high', 'claude-opus-5-5-high-fast',
    'claude-opus-5-5-medium', 'claude-opus-5-5-medium-fast',
    'claude-opus-5-5-low', 'claude-opus-5-5-low-fast'
  )
  AND agent IN (SELECT id FROM harnesses WHERE kind = 'cursor');

-- Agent profiles pick from the same pickers, so they can hold the same
-- variant ids. A task's frozen `agent_profile` JSON snapshot is deliberately
-- NOT rewritten — it records what the task first ran with.
UPDATE agent_profiles
SET effort = CASE
      WHEN model LIKE 'claude-opus-5-5-max%' THEN 'max'
      WHEN model LIKE 'claude-opus-5-5-xhigh%' THEN 'xhigh'
      WHEN model LIKE 'claude-opus-5-5-high%' THEN 'high'
      WHEN model LIKE 'claude-opus-5-5-medium%' THEN 'medium'
      ELSE 'low'
    END,
    fast = CASE WHEN model LIKE '%-fast' THEN 1 ELSE 0 END,
    model = 'claude-opus-5-5'
WHERE model IN (
    'claude-opus-5-5-max', 'claude-opus-5-5-max-fast',
    'claude-opus-5-5-xhigh', 'claude-opus-5-5-xhigh-fast',
    'claude-opus-5-5-high', 'claude-opus-5-5-high-fast',
    'claude-opus-5-5-medium', 'claude-opus-5-5-medium-fast',
    'claude-opus-5-5-low', 'claude-opus-5-5-low-fast'
  )
  AND harness_id IN (SELECT id FROM harnesses WHERE kind = 'cursor');

-- The CLI picker seed: a covered variant id no longer matches any offered
-- row, so point the pref at the base id it now belongs to.
UPDATE preferences
SET value = 'claude-opus-5-5'
WHERE key = 'lastModel:cursor'
  AND value IN (
    'claude-opus-5-5-max', 'claude-opus-5-5-max-fast',
    'claude-opus-5-5-xhigh', 'claude-opus-5-5-xhigh-fast',
    'claude-opus-5-5-high', 'claude-opus-5-5-high-fast',
    'claude-opus-5-5-medium', 'claude-opus-5-5-medium-fast',
    'claude-opus-5-5-low', 'claude-opus-5-5-low-fast'
  );

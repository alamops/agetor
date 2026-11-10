-- Cursor: this release adds a CURSOR_MODEL_SPECS entry for `claude-fable-5-2`
-- (five plain effort tiers), so cursor-agent's suffixed variant ids
-- (`claude-fable-5-2-{max,xhigh,high,medium,low}`) are now "covered by the
-- catalog" and every picker hides the discovered rows. A task or agent
-- profile that picked one of those as a discovered-only row before this
-- release would otherwise render as an unlisted row with a collapsed effort
-- dropdown. Normalize to base id + effort, the shape cursorModelArg
-- re-composes into the SAME --model argv (same convention as
-- 055/056/060/062/064/076).
--
-- The same pass backfills `claude-fable-5-1`'s five plain variant ids: that
-- spec shipped in an earlier release without its own migration (a
-- pre-existing gap), and the spec covers those ids identically now. Only the
-- PLAIN tiers are folded — `claude-fable-5-1-thinking-*` stays a discovered
-- row (the spec deliberately does not cover it, see CURSOR_MODEL_SPECS), so
-- it must never match.
--
-- The kind join (harnesses.kind = 'cursor') keeps other kinds' rows verbatim:
-- these literals, or an fx Gateway id such as
-- `anthropic/claude-fable-5.2`, must never be rewritten on a non-cursor row.
-- Effort/speed are also only meaningful on cursor rows.
--
-- `speed` is written ('off') because no -fast form exists for these families;
-- resetting a stale 'fast' keeps a future Fast tier from silently attaching
-- the task to a pricier variant once the id gains one (same rationale as
-- 060/062/064/076, which wrote the pre-072 `fast = 0`; 072 replaced that
-- column with `speed`).
--
-- Explicit IN lists, never LIKE: an unknown future suffix (for example
-- `claude-fable-5-2-ultra`) is left alone instead of being folded into a
-- bogus effort. Only the variants cursor-agent actually lists per family are
-- folded; neither family has `minimal` or `none` in the catalog.
--
-- Like 064/076, only `lastModel:cursor` is moved; `lastEffort:cursor` is left
-- alone (a picker seed the effort picker re-validates against the model).
-- `updated_at` is left alone, and frozen `tasks.agent_profile` /
-- `tasks.pipeline_run` JSON snapshots are NOT rewritten. One-way, and
-- idempotent: after the first pass no cursor-kind row matches a variant id.

-- claude-fable-5-2
UPDATE tasks
SET effort = substr(model, length('claude-fable-5-2-') + 1),
    speed = 'off',
    model = 'claude-fable-5-2'
WHERE model IN ('claude-fable-5-2-max', 'claude-fable-5-2-xhigh', 'claude-fable-5-2-high', 'claude-fable-5-2-medium', 'claude-fable-5-2-low')
  AND agent IN (SELECT id FROM harnesses WHERE kind = 'cursor');

UPDATE agent_profiles
SET effort = substr(model, length('claude-fable-5-2-') + 1),
    speed = 'off',
    model = 'claude-fable-5-2'
WHERE model IN ('claude-fable-5-2-max', 'claude-fable-5-2-xhigh', 'claude-fable-5-2-high', 'claude-fable-5-2-medium', 'claude-fable-5-2-low')
  AND harness_id IN (SELECT id FROM harnesses WHERE kind = 'cursor');

-- The CLI picker seed: point a covered variant id at the base id.
UPDATE preferences
SET value = 'claude-fable-5-2'
WHERE key = 'lastModel:cursor'
  AND value IN ('claude-fable-5-2-max', 'claude-fable-5-2-xhigh', 'claude-fable-5-2-high', 'claude-fable-5-2-medium', 'claude-fable-5-2-low');

-- claude-fable-5-1 (plain tiers only — `-thinking-*` is not spec-covered)
UPDATE tasks
SET effort = substr(model, length('claude-fable-5-1-') + 1),
    speed = 'off',
    model = 'claude-fable-5-1'
WHERE model IN ('claude-fable-5-1-max', 'claude-fable-5-1-xhigh', 'claude-fable-5-1-high', 'claude-fable-5-1-medium', 'claude-fable-5-1-low')
  AND agent IN (SELECT id FROM harnesses WHERE kind = 'cursor');

UPDATE agent_profiles
SET effort = substr(model, length('claude-fable-5-1-') + 1),
    speed = 'off',
    model = 'claude-fable-5-1'
WHERE model IN ('claude-fable-5-1-max', 'claude-fable-5-1-xhigh', 'claude-fable-5-1-high', 'claude-fable-5-1-medium', 'claude-fable-5-1-low')
  AND harness_id IN (SELECT id FROM harnesses WHERE kind = 'cursor');

-- The CLI picker seed: point a covered variant id at the base id.
UPDATE preferences
SET value = 'claude-fable-5-1'
WHERE key = 'lastModel:cursor'
  AND value IN ('claude-fable-5-1-max', 'claude-fable-5-1-xhigh', 'claude-fable-5-1-high', 'claude-fable-5-1-medium', 'claude-fable-5-1-low');

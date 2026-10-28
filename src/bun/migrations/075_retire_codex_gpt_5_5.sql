-- Retire codex's GPT-5.5. Codex no longer lists it and a ChatGPT-plan turn on
-- it 400s, so the model is removed from the codex picker and pinned rows move
-- to gpt-6.1-sol, the codex default, so the stored id is one the picker still
-- offers.
--
-- Kind-joined, like 074/066: `gpt-5.5` is ALSO a live Cursor model id (a
-- CURSOR_MODEL_SPECS entry) and fx carries `openai/gpt-5.5`, so matching the
-- model alone would corrupt those rows. A row whose harness was since deleted
-- (the orphan case) is left alone and renders as an unlisted row; that is
-- accepted.
--
-- Model and effort move in ONE UPDATE per table (SQLite evaluates SET
-- expressions against the old row). GPT-6.1 Sol accepts ultra, max, xhigh,
-- high, medium and low, and rejects `none` with a live 400, so an effort in
-- that set (or NULL) is kept and anything else (`none`, `minimal`, `auto`,
-- junk) becomes `high`. The rule is deliberately wider than just `none`: every
-- value outside the accepted set would 400 the same way.
--
-- The `lastModel:codex` preference is UPDATEd to the same target. The pref
-- key carries the kind, so no join is needed there. `lastEffort:codex` is NOT
-- touched: it is only a picker seed that the effort picker re-validates
-- against the selected model.
--
-- `updated_at` is left alone, and frozen `tasks.agent_profile` /
-- `tasks.pipeline_run` JSON snapshots are NOT rewritten. One-way (rolling back
-- means a new migration, never an edit to this one) and idempotent by
-- construction: after the first pass no codex-kind row matches `gpt-5.5`.

UPDATE tasks
SET model = 'gpt-6.1-sol',
    effort = CASE
      WHEN effort IS NULL OR effort IN ('ultra', 'max', 'xhigh', 'high', 'medium', 'low') THEN effort
      ELSE 'high'
    END
WHERE model = 'gpt-5.5'
  AND agent IN (SELECT id FROM harnesses WHERE kind = 'codex');

UPDATE agent_profiles
SET model = 'gpt-6.1-sol',
    effort = CASE
      WHEN effort IS NULL OR effort IN ('ultra', 'max', 'xhigh', 'high', 'medium', 'low') THEN effort
      ELSE 'high'
    END
WHERE model = 'gpt-5.5'
  AND harness_id IN (SELECT id FROM harnesses WHERE kind = 'codex');

UPDATE preferences
SET value = 'gpt-6.1-sol'
WHERE key = 'lastModel:codex'
  AND value = 'gpt-5.5';

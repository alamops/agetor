-- Retire three fx (Vercel AI Gateway) rows: alibaba/qwen3-coder-plus,
-- mistral/devstral-2 and anthropic/claude-3-haiku. A signed-in standard
-- account's catalog lacks all three, so they are removed from the fx picker
-- and pinned rows move to the new `DEFAULT_MODEL.fx`,
-- deepseek/deepseek-v4-flash, so the stored id is one the picker still offers.
--
-- Kind-joined, like 066: the ids are fx Gateway ids, and matching the model
-- alone could rewrite another kind's row that happened to carry the same
-- literal. A row whose harness was since deleted (the orphan case) is left
-- alone and renders as an unlisted row; that is accepted.
--
-- The `lastModel:fx` preference is UPDATEd, not DELETEd: the target is the
-- fixed default row. It ALSO moves off zai/glm-5.3-flash, the previous
-- default, which a signed-in standard account's catalog lacks too (owner
-- decision at plan approval). That id is NOT retired: the curated row stays
-- and tasks / agent profiles pinned to it are left as they are, so the
-- glm-5.3-flash rewrite is preference-only. The pref key carries the kind,
-- so no join is needed there. Only the built-in fx kind's pref key exists
-- (`lastModel:<kind>`), so additional fx harnesses need nothing extra.
--
-- The retired rows advertised no efforts, so no effort fix-up is needed.
-- `updated_at` is left alone, and frozen `tasks.agent_profile` /
-- `tasks.pipeline_run` JSON snapshots are NOT rewritten. Idempotent by
-- construction: after the first pass no row matches the old ids.

UPDATE tasks
SET model = 'deepseek/deepseek-v4-flash'
WHERE model IN ('alibaba/qwen3-coder-plus', 'mistral/devstral-2', 'anthropic/claude-3-haiku')
  AND agent IN (SELECT id FROM harnesses WHERE kind = 'fx');

UPDATE agent_profiles
SET model = 'deepseek/deepseek-v4-flash'
WHERE model IN ('alibaba/qwen3-coder-plus', 'mistral/devstral-2', 'anthropic/claude-3-haiku')
  AND harness_id IN (SELECT id FROM harnesses WHERE kind = 'fx');

UPDATE preferences
SET value = 'deepseek/deepseek-v4-flash'
WHERE key = 'lastModel:fx'
  AND value IN (
    'alibaba/qwen3-coder-plus', 'mistral/devstral-2', 'anthropic/claude-3-haiku',
    'zai/glm-5.3-flash'
  );

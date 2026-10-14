-- Retire gemini-3.7-flash and gemini-3.5-flash. Google deprecated 3.7 Flash
-- on 2026-10-08 (the API auto-routes it to 3.8 Flash) and 3.5 Flash (routed
-- to 3.6); both rows are removed from the gemini and antigravity pickers and
-- pinned rows move to the same-tier successor gemini-3.8-flash so the stored
-- id is one the picker still offers.
--
-- The kind join is REQUIRED, unlike 049's un-joined gemini-3-pro-preview
-- rewrite: Cursor's catalog keeps gemini-3.7-flash / gemini-3.5-flash as live
-- base ids (049 itself normalized cursor rows INTO that shape), so matching
-- the model alone would wrongly rewrite cursor tasks. The same goes for the
-- antigravity-suffixed ids, which were also once Cursor variant ids. A row
-- whose harness was since deleted (the orphan case) is left alone and
-- renders as an unlisted row; that is accepted.
--
-- Preferences are UPDATEd to the successor, not DELETEd: the successor is a
-- fixed, non-default row (049 deleted because its old id was the default and
-- a DELETE let the default change freely). The pref key carries the kind, so
-- no join is needed there.
--
-- `updated_at` is left alone, and frozen `tasks.agent_profile` /
-- `tasks.pipeline_run` JSON snapshots are NOT rewritten. Idempotent by
-- construction: after the first pass no row matches the old ids.

-- gemini kind: base ids.
UPDATE tasks
SET model = 'gemini-3.8-flash'
WHERE model IN ('gemini-3.7-flash', 'gemini-3.5-flash')
  AND agent IN (SELECT id FROM harnesses WHERE kind = 'gemini');

UPDATE agent_profiles
SET model = 'gemini-3.8-flash'
WHERE model IN ('gemini-3.7-flash', 'gemini-3.5-flash')
  AND harness_id IN (SELECT id FROM harnesses WHERE kind = 'gemini');

UPDATE preferences
SET value = 'gemini-3.8-flash'
WHERE key = 'lastModel:gemini'
  AND value IN ('gemini-3.7-flash', 'gemini-3.5-flash');

-- antigravity kind: the effort rides in the id suffix, so it is preserved.
UPDATE tasks
SET model = CASE model
      WHEN 'gemini-3.7-flash-high' THEN 'gemini-3.8-flash-high'
      WHEN 'gemini-3.7-flash-medium' THEN 'gemini-3.8-flash-medium'
      ELSE 'gemini-3.8-flash-low'
    END
WHERE model IN ('gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low')
  AND agent IN (SELECT id FROM harnesses WHERE kind = 'antigravity');

UPDATE agent_profiles
SET model = CASE model
      WHEN 'gemini-3.7-flash-high' THEN 'gemini-3.8-flash-high'
      WHEN 'gemini-3.7-flash-medium' THEN 'gemini-3.8-flash-medium'
      ELSE 'gemini-3.8-flash-low'
    END
WHERE model IN ('gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low')
  AND harness_id IN (SELECT id FROM harnesses WHERE kind = 'antigravity');

UPDATE preferences
SET value = CASE value
      WHEN 'gemini-3.7-flash-high' THEN 'gemini-3.8-flash-high'
      WHEN 'gemini-3.7-flash-medium' THEN 'gemini-3.8-flash-medium'
      ELSE 'gemini-3.8-flash-low'
    END
WHERE key = 'lastModel:antigravity'
  AND value IN ('gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low');

-- Retire gemini-3-pro-preview. Google shut the model down on 2026-03-09
-- (ai.google.dev/gemini-api/docs/deprecations) and names gemini-3.1-pro-preview
-- as its replacement; it was agetor's gemini default until this release, so a
-- task still pinned to it either fails at the API or runs only through
-- Google's server-side alias. Rewrite pinned rows to the successor — same Pro
-- tier — so the stored id is one the picker still offers.
--
-- No harness-kind join (unlike 015/034): the literal is unique to the gemini
-- kind's catalog (cursor's picker uses gemini-3.1-pro, fx's uses
-- google/gemini-3.1-pro-preview), so matching the model alone is exact and
-- also covers tasks whose harness row was since deleted — the orphan case
-- 015 needed a separate catch-all UPDATE for. updated_at is left alone,
-- matching 015/034.
UPDATE tasks
SET model = 'gemini-3.1-pro-preview'
WHERE model = 'gemini-3-pro-preview';

-- The same dead id is also cached as the "last used model" preference
-- (`lastModel:gemini`, written by NewTaskForm / TaskLaunchPickers /
-- `agetor add`'s persistPrefs). The two webview pickers validate that pref
-- against AGENT_OPTIONS and self-heal, but `agetor add` seeded its picker
-- from it unvalidated — and mergeModelOptions' unlisted-row rule made the
-- stale id selectable, so the CLI could re-create exactly the rows the
-- UPDATE above just fixed. Drop the pref so every picker falls through to
-- DEFAULT_MODEL.gemini (a DELETE, not an UPDATE, so a future default change
-- needs no further data fix).
DELETE FROM preferences
WHERE key = 'lastModel:gemini' AND value = 'gemini-3-pro-preview';

-- Cursor: this release adds CURSOR_MODEL_SPECS entries for Gemini 3.8 / 3.7
-- Flash, so their suffixed variant ids (gemini-3.{8,7}-flash-{high,medium,low})
-- are now "covered by the catalog" and every picker hides the discovered
-- rows. A task that picked one of those variants as a discovered-only row
-- before this release would otherwise render as an unlisted "not in this
-- account's catalog" row with a collapsed effort dropdown (the run itself
-- still works — cursorModelArg passes unknown ids through verbatim).
-- Normalize to base id + effort, the shape cursorModelArg re-composes into
-- the same --model argv — mirrors 034's claude-opus-4.8 normalization,
-- kind-joined because effort is only meaningful on cursor rows.
UPDATE tasks SET model = 'gemini-3.8-flash', effort = 'high'
WHERE model = 'gemini-3.8-flash-high' AND agent IN (SELECT id FROM harnesses WHERE kind = 'cursor');
UPDATE tasks SET model = 'gemini-3.8-flash', effort = 'medium'
WHERE model = 'gemini-3.8-flash-medium' AND agent IN (SELECT id FROM harnesses WHERE kind = 'cursor');
UPDATE tasks SET model = 'gemini-3.8-flash', effort = 'low'
WHERE model = 'gemini-3.8-flash-low' AND agent IN (SELECT id FROM harnesses WHERE kind = 'cursor');
UPDATE tasks SET model = 'gemini-3.7-flash', effort = 'high'
WHERE model = 'gemini-3.7-flash-high' AND agent IN (SELECT id FROM harnesses WHERE kind = 'cursor');
UPDATE tasks SET model = 'gemini-3.7-flash', effort = 'medium'
WHERE model = 'gemini-3.7-flash-medium' AND agent IN (SELECT id FROM harnesses WHERE kind = 'cursor');
UPDATE tasks SET model = 'gemini-3.7-flash', effort = 'low'
WHERE model = 'gemini-3.7-flash-low' AND agent IN (SELECT id FROM harnesses WHERE kind = 'cursor');

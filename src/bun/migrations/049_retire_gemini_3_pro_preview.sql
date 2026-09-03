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

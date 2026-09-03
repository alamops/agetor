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
-- also covers tasks whose harness row was since deleted. updated_at is left
-- alone, matching 015/034.
UPDATE tasks
SET model = 'gemini-3.1-pro-preview'
WHERE model = 'gemini-3-pro-preview';

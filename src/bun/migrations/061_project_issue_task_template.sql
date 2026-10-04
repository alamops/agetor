-- Per-project issue task template ("Work on this with Agetor"), stored as a
-- JSON blob. NULL = no template: the issue dialog seeds the built-in issue
-- prompt and no agent profile. Shape:
--   { "prompt": "/acme:cards {number}", "agentProfileId": "<id>" | null }
ALTER TABLE projects ADD COLUMN issue_task_template TEXT;

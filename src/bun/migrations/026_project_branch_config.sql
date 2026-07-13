-- Per-project branch nomenclature, stored as a JSON blob. NULL = use the
-- built-in defaults (DEFAULT_BRANCH_CONFIG). Shape:
--   { "rules": { "task": { "prefix": "feature/" }, "bug": {...}, "spike": {...} },
--     "includeSlug": true }
ALTER TABLE projects ADD COLUMN branch_config TEXT;

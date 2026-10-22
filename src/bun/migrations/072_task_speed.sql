-- Replace the boolean `fast` column with a three-state `speed` on tasks and
-- agent profiles: 'off' | 'fast' | 'ultrafast' (`Speed` in shared/types.ts).
-- fx 0.0.14 adds Fast and Ultrafast model variants, so a boolean no longer
-- covers the picker; Cursor keeps using 'off' / 'fast' only.
--
-- ONE-WAY DOOR: this is the repo's first `DROP COLUMN`. A build older than
-- this migration cannot open a migrated DB's tasks/profiles (its SQL names
-- `fast`). Why it is safe here:
--   - no index, trigger or view names `fast` (checked across every
--     migration in this directory and in a production `sqlite_master`), and
--     `fast` is in no PRIMARY KEY, UNIQUE, CHECK or FOREIGN KEY clause, which
--     are the cases where SQLite refuses `DROP COLUMN`;
--   - the bundled SQLite is 3.51.0 (bun 1.3.10 and the packaged app's bun
--     1.3.13), well past 3.35's `DROP COLUMN` and with CHECK on `ADD COLUMN`;
--   - the older migrations that WRITE `fast` (034, 052, 055, 056, 060, 062,
--     064) all run before this one on a fresh DB, so none of them sees the
--     column gone.
--
-- `updated_at` is left alone. Frozen `tasks.agent_profile` /
-- `tasks.pipeline_run` JSON snapshots keep their `fast` boolean; the db layer
-- reads a snapshot's `speed` first and falls back to `fast`.

ALTER TABLE tasks ADD COLUMN speed TEXT NOT NULL DEFAULT 'off'
  CHECK (speed IN ('off', 'fast', 'ultrafast'));
UPDATE tasks SET speed = CASE WHEN fast = 1 THEN 'fast' ELSE 'off' END;
ALTER TABLE tasks DROP COLUMN fast;

ALTER TABLE agent_profiles ADD COLUMN speed TEXT NOT NULL DEFAULT 'off'
  CHECK (speed IN ('off', 'fast', 'ultrafast'));
UPDATE agent_profiles SET speed = CASE WHEN fast = 1 THEN 'fast' ELSE 'off' END;
ALTER TABLE agent_profiles DROP COLUMN fast;

-- The pickers remember the last Fast toggle per kind as `lastFast:<kind>` =
-- 'true' | 'false'; they now remember `lastSpeed:<kind>` = a `Speed` id.
-- `substr(key, 10)` strips the 9-character `lastFast:` prefix. A
-- `lastSpeed:<kind>` that somehow already exists is overwritten by the
-- migrated value (INSERT OR REPLACE), then every `lastFast:*` key goes.
INSERT OR REPLACE INTO preferences (key, value, updated_at)
SELECT 'lastSpeed:' || substr(key, 10),
       CASE WHEN value = 'true' THEN 'fast' ELSE 'off' END,
       updated_at
FROM preferences
WHERE key LIKE 'lastFast:%';

DELETE FROM preferences WHERE key LIKE 'lastFast:%';

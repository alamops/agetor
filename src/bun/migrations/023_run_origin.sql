-- Distinguish a user-initiated run from one the orchestrator opened on the
-- user's behalf after a claude session auto-resumed post `end_turn` (e.g. the
-- main agent delegated to a background task and later continued talking once
-- it finished). NULL = user-initiated (the existing behavior for every prior
-- row); 'continuation' = opened by the orchestrator's continuation-run
-- factory. Nullable, no default needed — SQLite backfills existing rows with
-- NULL, which is exactly the "user-initiated" reading.
ALTER TABLE runs ADD COLUMN origin TEXT;

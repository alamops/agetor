-- Cursor Max Mode / large-context toggle. Ignored by non-Cursor harnesses.
ALTER TABLE tasks ADD COLUMN max_mode INTEGER NOT NULL DEFAULT 0;

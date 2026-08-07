-- Cursor fast-model toggle. Ignored by non-Cursor harnesses.
ALTER TABLE tasks ADD COLUMN fast INTEGER NOT NULL DEFAULT 0;

-- Normalize the legacy curated Cursor Opus 4.8 id. The real cursor-agent model
-- ids use hyphenated versions (`claude-opus-4-8-*`), and the new Cursor model
-- catalog keys off that base id.
UPDATE tasks
SET model = 'claude-opus-4-8'
WHERE model = 'claude-opus-4.8'
  AND agent IN (SELECT id FROM harnesses WHERE kind = 'cursor');

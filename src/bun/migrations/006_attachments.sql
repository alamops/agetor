-- Per-task image attachments saved to disk. JSON array of
-- { name, path, mimeType } objects. Empty array when nothing is attached.
-- Default '[]' so existing rows decode cleanly without a backfill.
ALTER TABLE tasks ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';

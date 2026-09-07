-- Files delivered to the user via `SendUserFile` (src/shared/sent-files.ts) — `SentFileEntry[]` JSON, written only by `tasks.mergeSentFiles` on confirmed delivery, never by the generic `tasks.update` SET clause. NULL until the task's first delivered file.
ALTER TABLE tasks ADD COLUMN sent_files TEXT;

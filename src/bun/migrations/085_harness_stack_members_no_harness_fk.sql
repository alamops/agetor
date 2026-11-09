-- Drop the foreign key from harness_stack_members.harness_id to harnesses(id).
-- See docs/architecture/harness-stacks.md.
--
-- 084 declared `harness_id REFERENCES harnesses(id) ON DELETE CASCADE`. Every
-- harnesses CHECK widening is a table rebuild (CREATE harnesses_new / copy /
-- DROP harnesses / RENAME, as 032/037/046/061/077/078 do), and db.ts turns
-- `PRAGMA foreign_keys = ON` before `migrate()` runs. With foreign keys on,
-- `DROP TABLE harnesses` is an implicit DELETE of every row, so the cascade
-- would wipe every stack membership on the next rebuild. No other table
-- references harnesses by FK, and the rebuild recipe relies on that.
--
-- Membership rows are now removed explicitly by `harnesses.delete` (db.ts),
-- inside the same transaction that renumbers the stack. The FK to
-- harness_stacks (cascade on stack delete), the primary key and both UNIQUE
-- constraints stay as 084 declared them. Never edit 084: dev DBs may already
-- have applied it.
--
-- This file runs inside the migration runner's one transaction, statement by
-- statement, so the rebuild only commits when every step succeeded.

CREATE TABLE harness_stack_members_new (
  stack_id TEXT NOT NULL REFERENCES harness_stacks(id) ON DELETE CASCADE,
  harness_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (stack_id, harness_id),
  UNIQUE (harness_id),
  UNIQUE (stack_id, position)
);

INSERT INTO harness_stack_members_new (stack_id, harness_id, position)
SELECT stack_id, harness_id, position FROM harness_stack_members;

DROP TABLE harness_stack_members;
ALTER TABLE harness_stack_members_new RENAME TO harness_stack_members;

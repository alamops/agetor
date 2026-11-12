-- Harness stacks fix round. See docs/plans/harness-stacks-fix-round.md and
-- docs/architecture/harness-stacks.md.
--
-- 1. `harness_limit_state` becomes per-(account, model). `model = ''` is the
--    whole-account cooldown every pre-087 row was, so existing cooldowns keep
--    their meaning. Still no foreign key to `harnesses` (085: a harnesses
--    rebuild with foreign keys on would cascade); `harnesses.delete` clears
--    the rows explicitly.
-- 2. `harness_swap_events` is the swap/blocked history. It cascades with the
--    stack but references no task and no harness: the labels are denormalized
--    so the history survives a task or account delete. `trigger` has no CHECK:
--    `HarnessSwapTrigger` may grow without a table rebuild; the store
--    validates it.
-- 3. `harness_mirror_provenance` records what a mirror run wrote into a backup
--    account (file/key/link), so a later run can tell its own output from the
--    user's edits. No foreign keys, for the same reason as 085. Rows are
--    untrusted on use (the database is agent-writable).

CREATE TABLE harness_limit_state_new (
  harness_id TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT,
  exhausted_until_ms INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (harness_id, model)
);

INSERT INTO harness_limit_state_new (harness_id, model, reason, source, message, exhausted_until_ms, updated_at)
SELECT harness_id, '', reason, source, message, exhausted_until_ms, updated_at FROM harness_limit_state;

DROP TABLE harness_limit_state;
ALTER TABLE harness_limit_state_new RENAME TO harness_limit_state;
CREATE INDEX idx_harness_limit_state_until ON harness_limit_state(exhausted_until_ms);

CREATE TABLE harness_swap_events (
  id TEXT PRIMARY KEY,
  stack_id TEXT NOT NULL REFERENCES harness_stacks(id) ON DELETE CASCADE,
  task_id TEXT,
  task_title TEXT,
  from_harness_id TEXT,
  from_label TEXT,
  to_harness_id TEXT,
  to_label TEXT,
  trigger TEXT NOT NULL,
  reason TEXT,
  source TEXT,
  message TEXT,
  model TEXT,
  resets_at_ms INTEGER,
  from_run_id TEXT,
  to_run_id TEXT,
  continuation TEXT CHECK (continuation IS NULL OR continuation IN ('transferred','restarted')),
  at INTEGER NOT NULL
);
CREATE INDEX idx_harness_swap_events_stack ON harness_swap_events(stack_id, at DESC, id DESC);

CREATE TABLE harness_mirror_provenance (
  harness_id TEXT NOT NULL,
  stack_id TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('file','key','link')),
  path TEXT NOT NULL,
  key TEXT NOT NULL DEFAULT '',
  value_hash TEXT,
  src_mtime_ms INTEGER,
  src_size INTEGER,
  preexisted INTEGER NOT NULL DEFAULT 0,
  backup_ref TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (harness_id, path, key)
);

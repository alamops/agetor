-- Harness account stacks (backup accounts with automatic failover).
-- See docs/architecture/harness-stacks.md and
-- docs/plans/harness-account-stacks.md (T01).
--
-- A stack is an ordered membership on harness rows of ONE kind: position 0 is
-- the primary, the rest are backups. A task's stack is derived from its
-- current account (`tasks.agent`), so nothing on tasks/profiles/pipelines
-- references a stack id. Every table is additive; no `harnesses` rebuild.
--
-- `harness_limit_state` is the account-global cooldown (quota/429/402) that
-- keeps N tasks from rediscovering the same exhausted account. It survives a
-- stack delete on purpose: a cooldown is a fact about the account, not the
-- grouping.
--
-- `harness_session_handoffs` maps (task, destination account, session column)
-- to the provider session transferred onto that account, so
-- `findLastSessionIdForHarness` can resume a conversation an account itself
-- never created. `copied_paths_json` is the cleanup allowlist; a path not
-- recorded here is never removed.
--
-- `tasks.harness_state` is the per-task lap/pending-swap/all-exhausted JSON
-- (`TaskHarnessState`). It is server-managed: written only by
-- `tasks.setHarnessState`, skipped by `tasks.update`'s generic SET clause and
-- never bumps `updated_at`, the same treatment as `fx_recovery`.
CREATE TABLE harness_stacks (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('claude-code','codex')),
  mirror_mode TEXT NOT NULL DEFAULT 'full' CHECK (mirror_mode IN ('full','safe')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE harness_stack_members (
  stack_id TEXT NOT NULL REFERENCES harness_stacks(id) ON DELETE CASCADE,
  harness_id TEXT NOT NULL REFERENCES harnesses(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (stack_id, harness_id),
  UNIQUE (harness_id),
  UNIQUE (stack_id, position)
);

CREATE TABLE harness_limit_state (
  harness_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT,
  exhausted_until_ms INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_harness_limit_state_until ON harness_limit_state(exhausted_until_ms);

CREATE TABLE harness_session_handoffs (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  harness_id TEXT NOT NULL,
  column_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  copied_paths_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, harness_id, column_name)
);

ALTER TABLE tasks ADD COLUMN harness_state TEXT;

-- Latest per-harness usage/quota snapshot for the topbar usage tracker
-- (see docs/plans/harness-usage-tracker.md). Stores the most recent
-- `HarnessQuota` (src/shared/types.ts) as JSON, keyed by harness id, so the
-- topbar can render last-known meters instantly on boot (before the first
-- poll completes) and across restarts. Deliberately a standalone table, not
-- a column on `harnesses` — that table's shape has caused prod incidents via
-- rebuild migrations (024/032/037/038 self-heal), and this data is disposable
-- cache, not identity. No foreign key on harness_id: the schema resolves
-- harness identity at the app layer (see `harnesses.getByIdOrKind`), not via
-- SQL constraints.
CREATE TABLE IF NOT EXISTS harness_usage (
  harness_id  TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

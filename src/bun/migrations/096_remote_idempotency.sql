-- Stored results of remote mutations, keyed by device and the phone's 128-bit `idem` key (docs/specs/remote-readiness-spec.md
-- "Idempotency"). Persisted, not in memory, so a retry that crosses a port handoff or a core restart still gets the stored
-- result instead of applying the mutation twice. Rows are pruned after 10 minutes. `response` holds a result up to 64 KB whole;
-- a larger mutation response stores its status only (`response` NULL).
CREATE TABLE IF NOT EXISTS remote_idempotency (
  device_id    TEXT NOT NULL,
  idem_key     TEXT NOT NULL,
  body_hash    TEXT NOT NULL,
  status       INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  response     BLOB,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (device_id, idem_key)
);

CREATE INDEX IF NOT EXISTS idx_remote_idempotency_created ON remote_idempotency (created_at);

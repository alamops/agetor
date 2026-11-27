-- Hash-chained audit log of every remote action (docs/specs/remote-readiness-spec.md "Audit log").
--
-- `hash` = SHA-256(prev_hash || canonical JSON of the row without `hash`), computed by the op that inserts the row
-- (src/bun/db-core/ops/remote-ops.ts), inside the same transaction as the action's own writes. `kind = 'anchor'` rows are
-- written by a trim: they record the hash of the last dropped entry so the chain verifies from the oldest remaining row.
-- Bodies are never stored, only `body_hash`; a decision's signature is stored.
--
-- UPDATE is always refused. DELETE is refused too, except inside the trim op, which drops and recreates the DELETE trigger
-- within one BEGIN IMMEDIATE. An agent that drops the triggers can edit the table, which is accepted: the chain and the
-- phone's saved heads still reveal an edit (`remote.auditVerify`).
CREATE TABLE IF NOT EXISTS remote_audit (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('entry', 'anchor')),
  device_id   TEXT,
  session_hash TEXT,
  action      TEXT NOT NULL,
  route       TEXT,
  target_json TEXT,
  result_code TEXT,
  attempt_seq INTEGER,
  body_hash   TEXT,
  signature   TEXT,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_remote_audit_device ON remote_audit (device_id, seq);

CREATE TRIGGER IF NOT EXISTS remote_audit_no_update
BEFORE UPDATE ON remote_audit
BEGIN
  SELECT RAISE(ABORT, 'remote_audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS remote_audit_no_delete
BEFORE DELETE ON remote_audit
BEGIN
  SELECT RAISE(ABORT, 'remote_audit is append-only');
END;

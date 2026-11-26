import type { RemoteAuditHead, RemoteAuditInput, RemoteAuditVerify, RemoteDeviceInsert } from "../../../shared/remote-types.ts";
import { appendAudit, auditHead, insertDeviceRow, verifyAuditChain } from "../remote.ts";
import { defineOp } from "./define.ts";

// The Companion's multi-statement writes (docs/architecture/persistence.md, "Remote tables"). Each runs whole inside the database
// worker. A device change and its audit row commit together, so an action never exists without its record (invariant 12).

export interface AuditTrimResult {
  dropped: number;
  /** The seq of the anchor row the trim wrote, or null when nothing was dropped. */
  anchorSeq: number | null;
}

export interface IdempotencyPut {
  deviceId: string;
  idemKey: string;
  bodyHash: string;
  status: number;
  contentType: string;
  /** Up to 64 KB stored whole; a larger response is stored as null (status only). */
  response: Uint8Array | null;
  createdAt: number;
  /**
   * An existing row for the same key created at or before this instant is expired (the 10-minute window) and is replaced; a newer one is kept.
   * The prune runs once a minute, so an expired row can still be there when its key is used again.
   */
  expiredBefore?: number;
}

export const IDEMPOTENCY_MAX_RESPONSE_BYTES = 64 * 1024;

export const remoteOps = {
  /** Insert a registry row and its `pair` audit entry in one transaction. The row is written only after the key helper signed it. */
  "remote.addDevice": defineOp({
    tx: true,
    run({ conn }, device: RemoteDeviceInsert, audit: RemoteAuditInput): RemoteAuditHead {
      insertDeviceRow(conn, device);
      return appendAudit(conn, { ...audit, action: "pair", deviceId: device.id });
    },
  }),

  /** Mark devices revoked and audit each one. An id with no row (revoked in the key helper's list only) is still audited. */
  "remote.revokeDevices": defineOp({
    tx: true,
    run({ conn }, ids: string[], reason: string, ts: number): { revoked: string[] } {
      const revoked: string[] = [];
      for (const id of ids) {
        conn.run(`UPDATE remote_devices SET status = 'revoked' WHERE id = ?`, [id]);
        appendAudit(conn, { ts, action: "revoke", deviceId: id, target: { reason } });
        revoked.push(id);
      }
      return { revoked };
    },
  }),

  /** Append one audit row: reads the head, computes the chained hash, inserts. */
  "remote.auditAppend": defineOp({
    tx: true,
    run({ conn }, entry: RemoteAuditInput): RemoteAuditHead {
      return appendAudit(conn, entry);
    },
  }),

  /**
   * Retention (grill C2): drop rows older than `maxAgeMs` or beyond the newest `maxRows`, never the head. The DELETE trigger is dropped,
   * the rows deleted, the trigger recreated and an anchor row holding the hash of the last dropped entry appended, all in one
   * BEGIN IMMEDIATE, so no other statement ever sees the table without its trigger.
   */
  "remote.auditTrim": defineOp({
    tx: true,
    run({ conn }, opts: { maxAgeMs: number; maxRows: number; now: number }): AuditTrimResult {
      const head = auditHead(conn);
      if (!head) return { dropped: 0, anchorSeq: null };
      const byAge = conn
        .query<{ seq: number | null }, [number, number]>(`SELECT MAX(seq) AS seq FROM remote_audit WHERE ts < ? AND seq < ?`)
        .get(opts.now - opts.maxAgeMs, head.seq)?.seq ?? 0;
      const total = conn.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM remote_audit`).get()?.n ?? 0;
      let byCount = 0;
      if (total > opts.maxRows) {
        byCount = conn
          .query<{ seq: number | null }, [number]>(`SELECT seq FROM remote_audit ORDER BY seq ASC LIMIT 1 OFFSET ?`)
          .get(total - opts.maxRows - 1)?.seq ?? 0;
      }
      const through = Math.min(Math.max(byAge, byCount), head.seq - 1);
      if (through <= 0) return { dropped: 0, anchorSeq: null };
      const last = conn.query<{ hash: string }, [number]>(`SELECT hash FROM remote_audit WHERE seq = ?`).get(through);
      if (!last) return { dropped: 0, anchorSeq: null };
      conn.run(`DROP TRIGGER IF EXISTS remote_audit_no_delete`);
      const dropped = conn.query<{ n: number }, [number]>(`SELECT COUNT(*) AS n FROM remote_audit WHERE seq <= ?`).get(through)?.n ?? 0;
      conn.run(`DELETE FROM remote_audit WHERE seq <= ?`, [through]);
      conn.run(
        `CREATE TRIGGER remote_audit_no_delete BEFORE DELETE ON remote_audit BEGIN SELECT RAISE(ABORT, 'remote_audit is append-only'); END`,
      );
      const anchor = appendAudit(conn, {
        ts: opts.now,
        kind: "anchor",
        action: "trim",
        target: { droppedThrough: through, hash: last.hash, dropped },
      });
      return { dropped, anchorSeq: anchor.seq };
    },
  }),

  /** Walk the chain (in the worker, up to 50,000 rows) and name the first bad row. Read-only. */
  "remote.auditVerify": defineOp({
    tx: false,
    run({ conn }): RemoteAuditVerify {
      return verifyAuditChain(conn);
    },
  }),

  /** Store a result under (device, idem key). A second put of the same key keeps the first unless that one has expired. Returns whether this call stored it. */
  "remote.idempotencyPut": defineOp({
    tx: true,
    run({ conn }, row: IdempotencyPut): boolean {
      const response = row.response && row.response.length <= IDEMPOTENCY_MAX_RESPONSE_BYTES ? row.response : null;
      const r = conn.run(
        `INSERT INTO remote_idempotency (device_id, idem_key, body_hash, status, content_type, response, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (device_id, idem_key) DO UPDATE SET
           body_hash = excluded.body_hash, status = excluded.status, content_type = excluded.content_type, response = excluded.response, created_at = excluded.created_at
         WHERE remote_idempotency.created_at <= ?`,
        [row.deviceId, row.idemKey, row.bodyHash, row.status, row.contentType, response, row.createdAt, row.expiredBefore ?? 0],
      );
      return r.changes === 1;
    },
  }),

  /** Delete results created before `beforeTs` (the 10-minute window). */
  "remote.idempotencyPrune": defineOp({
    tx: true,
    run({ conn }, beforeTs: number): number {
      return conn.run(`DELETE FROM remote_idempotency WHERE created_at < ?`, [beforeTs]).changes;
    },
  }),
};

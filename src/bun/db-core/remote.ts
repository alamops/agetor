import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { canonicalize } from "@agetor/remote-protocol/canonical-json";
import type {
  RemoteAuditHead,
  RemoteAuditInput,
  RemoteAuditRow,
  RemoteAuditVerify,
  RemoteDeviceInsert,
  RemoteDeviceRow,
  RemoteIdempotencyRow,
} from "../../shared/remote-types.ts";

/**
 * SQL for the Companion's tables (migrations 094 devices, 095 audit, 096 idempotency; docs/architecture/persistence.md).
 * Reads are plain module methods. Anything that writes more than one statement is a named op in `ops/remote-ops.ts`
 * (`BEGIN IMMEDIATE`), built from the helpers exported here.
 */

export const ZERO_HASH = "0".repeat(64);

// ── rows ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface DeviceSqlRow {
  id: string;
  name: string;
  platform: string;
  app_version: string;
  session_pub: Uint8Array;
  approve_pub: Uint8Array;
  push_pub: Uint8Array;
  link_secret: Uint8Array;
  level: string;
  status: string;
  enrolled_at: number;
  last_seen_at: number | null;
  push_ref: string | null;
  push_send_key: Uint8Array | null;
  push_dead: number;
  sig: Uint8Array;
}

const bytes = (b: Uint8Array): Uint8Array => new Uint8Array(b);

function toDevice(r: DeviceSqlRow): RemoteDeviceRow {
  return {
    id: r.id,
    name: r.name,
    platform: r.platform as RemoteDeviceRow["platform"],
    appVersion: r.app_version,
    sessionPub: bytes(r.session_pub),
    approvePub: bytes(r.approve_pub),
    pushPub: bytes(r.push_pub),
    linkSecret: bytes(r.link_secret),
    level: r.level as RemoteDeviceRow["level"],
    status: r.status as RemoteDeviceRow["status"],
    enrolledAt: r.enrolled_at,
    lastSeenAt: r.last_seen_at,
    pushRef: r.push_ref,
    pushSendKey: r.push_send_key ? bytes(r.push_send_key) : null,
    pushDead: r.push_dead === 1,
    sig: bytes(r.sig),
  };
}

interface AuditSqlRow {
  seq: number;
  ts: number;
  kind: string;
  device_id: string | null;
  session_hash: string | null;
  action: string;
  route: string | null;
  target_json: string | null;
  result_code: string | null;
  attempt_seq: number | null;
  body_hash: string | null;
  signature: string | null;
  prev_hash: string;
  hash: string;
}

function toAudit(r: AuditSqlRow): RemoteAuditRow {
  return {
    seq: r.seq,
    ts: r.ts,
    kind: r.kind as RemoteAuditRow["kind"],
    deviceId: r.device_id,
    sessionHash: r.session_hash,
    action: r.action,
    route: r.route,
    targetJson: r.target_json,
    resultCode: r.result_code,
    attemptSeq: r.attempt_seq,
    bodyHash: r.body_hash,
    signature: r.signature,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

// ── the audit chain ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The fields a row's hash covers: everything except `hash` itself. Keys sort in canonical JSON, so order here does not matter. */
function hashedFields(r: Omit<AuditSqlRow, "hash">): Record<string, unknown> {
  return {
    seq: r.seq,
    ts: r.ts,
    kind: r.kind,
    device_id: r.device_id,
    session_hash: r.session_hash,
    action: r.action,
    route: r.route,
    target_json: r.target_json,
    result_code: r.result_code,
    attempt_seq: r.attempt_seq,
    body_hash: r.body_hash,
    signature: r.signature,
    prev_hash: r.prev_hash,
  };
}

/** `SHA-256(prev_hash || canonical JSON of the row without hash)`, lowercase hex. */
export function auditHash(r: Omit<AuditSqlRow, "hash">): string {
  return createHash("sha256").update(r.prev_hash).update(canonicalize(hashedFields(r))).digest("hex");
}

export function auditHead(conn: Database): RemoteAuditHead | null {
  const row = conn.query<{ seq: number; hash: string }, []>(`SELECT seq, hash FROM remote_audit ORDER BY seq DESC LIMIT 1`).get();
  return row ? { seq: row.seq, hash: row.hash } : null;
}

/** Append one row to the chain. Call it inside the caller's transaction so it commits with the action's own writes. */
export function appendAudit(conn: Database, input: RemoteAuditInput): RemoteAuditHead {
  const head = auditHead(conn);
  const target = input.target === undefined ? null : canonicalize(input.target);
  const base: Omit<AuditSqlRow, "hash"> = {
    seq: (head?.seq ?? 0) + 1,
    ts: input.ts,
    kind: input.kind ?? "entry",
    device_id: input.deviceId ?? null,
    session_hash: input.sessionHash ?? null,
    action: input.action,
    route: input.route ?? null,
    target_json: target,
    result_code: input.resultCode ?? null,
    attempt_seq: input.attemptSeq ?? null,
    body_hash: input.bodyHash ?? null,
    signature: input.signature ?? null,
    prev_hash: head?.hash ?? ZERO_HASH,
  };
  const hash = auditHash(base);
  conn.run(
    `INSERT INTO remote_audit (seq, ts, kind, device_id, session_hash, action, route, target_json, result_code, attempt_seq, body_hash, signature, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [base.seq, base.ts, base.kind, base.device_id, base.session_hash, base.action, base.route, base.target_json, base.result_code, base.attempt_seq, base.body_hash, base.signature, base.prev_hash, hash],
  );
  return { seq: base.seq, hash };
}

/**
 * Walk the chain and report the first bad row. The first remaining row's `prev_hash` must be zeros (the chain starts at seq 1) or the
 * hash a trim recorded in its anchor row (`target.droppedThrough` = the row before it). A bad hash, a broken link or a missing anchor
 * names the offending seq. Runs inside the database worker.
 */
export function verifyAuditChain(conn: Database): RemoteAuditVerify {
  // Chunked reads with `.all()`, never `.iterate()`: bun:sqlite caches prepared statements, and an iterator abandoned by an early
  // return would leave the cached statement half-read for the next caller.
  const PAGE = 2000;
  const anchors = new Map<number, string>();
  let expectedPrev: string | null = null;
  let firstSeq: number | null = null;
  let firstPrev = "";
  let count = 0;
  let prevSeq: number | null = null;
  let after = 0;
  for (;;) {
    const rows = conn.query<AuditSqlRow, [number, number]>(`SELECT * FROM remote_audit WHERE seq > ? ORDER BY seq ASC LIMIT ?`).all(after, PAGE);
    if (rows.length === 0) break;
    for (const r of rows) {
      count++;
      if (r.kind === "anchor" && r.target_json) {
        try {
          const t = JSON.parse(r.target_json) as { droppedThrough?: number; hash?: string };
          if (typeof t.droppedThrough === "number" && typeof t.hash === "string") anchors.set(t.droppedThrough, t.hash);
        } catch {
          /* a malformed anchor simply anchors nothing */
        }
      }
      if (expectedPrev === null) {
        // The first remaining row: its prev_hash is vouched for below (zeros at seq 1, else an anchor the trim wrote).
        firstSeq = r.seq;
        firstPrev = r.prev_hash;
        expectedPrev = r.prev_hash;
      } else if (r.prev_hash !== expectedPrev) {
        return { ok: false, firstBadSeq: r.seq, rows: count };
      }
      if (prevSeq !== null && r.seq !== prevSeq + 1) return { ok: false, firstBadSeq: r.seq, rows: count };
      const { hash: stored, ...rest } = r;
      if (auditHash(rest) !== stored) return { ok: false, firstBadSeq: r.seq, rows: count };
      expectedPrev = stored;
      prevSeq = r.seq;
    }
    after = rows[rows.length - 1]!.seq;
  }
  if (count === 0 || firstSeq === null) return { ok: true, firstBadSeq: null, rows: 0 };
  if (firstSeq === 1) {
    if (firstPrev !== ZERO_HASH) return { ok: false, firstBadSeq: 1, rows: count };
  } else {
    // A trim wrote an anchor naming the hash of the row just before the first remaining one.
    const anchored = anchors.get(firstSeq - 1);
    if (anchored === undefined || anchored !== firstPrev) return { ok: false, firstBadSeq: firstSeq, rows: count };
  }
  return { ok: true, firstBadSeq: null, rows: count };
}

// ── modules ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function makeRemote(conn: Database) {
  const remoteDevices = {
    list(): RemoteDeviceRow[] {
      return conn.query<DeviceSqlRow, []>(`SELECT * FROM remote_devices ORDER BY enrolled_at ASC, id ASC`).all().map(toDevice);
    },
    get(id: string): RemoteDeviceRow | null {
      const r = conn.query<DeviceSqlRow, [string]>(`SELECT * FROM remote_devices WHERE id = ?`).get(id);
      return r ? toDevice(r) : null;
    },
    setLastSeen(id: string, ts: number): void {
      conn.run(`UPDATE remote_devices SET last_seen_at = ? WHERE id = ?`, [ts, id]);
    },
    /** The gateway's opaque push address and the device's push send key, set by the phone over its session. Clears `push_dead`. */
    setPushRef(id: string, pushRef: string, sendKey: Uint8Array): void {
      conn.run(`UPDATE remote_devices SET push_ref = ?, push_send_key = ?, push_dead = 0 WHERE id = ?`, [pushRef, sendKey, id]);
    },
    markPushDead(id: string, dead = true): void {
      conn.run(`UPDATE remote_devices SET push_dead = ? WHERE id = ?`, [dead ? 1 : 0, id]);
    },
  };

  const remoteAudit = {
    head(): RemoteAuditHead | null {
      return auditHead(conn);
    },
    /** Newest first. `beforeSeq` pages backwards. */
    page(opts: { beforeSeq?: number; limit: number }): RemoteAuditRow[] {
      const limit = Math.max(1, Math.min(Math.floor(opts.limit), 500));
      const rows =
        opts.beforeSeq === undefined
          ? conn.query<AuditSqlRow, [number]>(`SELECT * FROM remote_audit ORDER BY seq DESC LIMIT ?`).all(limit)
          : conn.query<AuditSqlRow, [number, number]>(`SELECT * FROM remote_audit WHERE seq < ? ORDER BY seq DESC LIMIT ?`).all(opts.beforeSeq, limit);
      return rows.map(toAudit);
    },
    count(): number {
      return conn.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM remote_audit`).get()?.n ?? 0;
    },
    /** Rows of one attempt: the attempt row and its result row, for "outcome unknown" detection. */
    resultFor(attemptSeq: number): RemoteAuditRow | null {
      const r = conn.query<AuditSqlRow, [number]>(`SELECT * FROM remote_audit WHERE attempt_seq = ? ORDER BY seq ASC LIMIT 1`).get(attemptSeq);
      return r ? toAudit(r) : null;
    },
  };

  const remoteIdempotency = {
    get(deviceId: string, idemKey: string): RemoteIdempotencyRow | null {
      const r = conn
        .query<{ device_id: string; idem_key: string; body_hash: string; status: number; content_type: string; response: Uint8Array | null; created_at: number }, [string, string]>(
          `SELECT * FROM remote_idempotency WHERE device_id = ? AND idem_key = ?`,
        )
        .get(deviceId, idemKey);
      return r
        ? { deviceId: r.device_id, idemKey: r.idem_key, bodyHash: r.body_hash, status: r.status, contentType: r.content_type, response: r.response ? bytes(r.response) : null, createdAt: r.created_at }
        : null;
    },
  };

  return { remoteDevices, remoteAudit, remoteIdempotency };
}

/** Insert a device row (used by `remote.addDevice`, inside its transaction). */
export function insertDeviceRow(conn: Database, d: RemoteDeviceInsert): void {
  conn.run(
    `INSERT INTO remote_devices (id, name, platform, app_version, session_pub, approve_pub, push_pub, link_secret, level, status, enrolled_at, sig)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.id, d.name, d.platform, d.appVersion, d.sessionPub, d.approvePub, d.pushPub, d.linkSecret, d.level, d.status ?? "active", d.enrolledAt, d.sig],
  );
}

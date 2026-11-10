/**
 * What a mirror run wrote into a backup account (`harness_mirror_provenance`,
 * migration 087): one row per file, merged key or symlink, keyed by
 * (account, path, key). A later run uses it to tell its own output from the
 * user's edits and to know which files it may remove or restore.
 *
 * Rows are UNTRUSTED on use: the database is agent-writable, so a row's `path`
 * and `backupRef` are claims, not facts. Every consumer must validate the path
 * against the account's config root (no-follow, containment) before touching
 * the filesystem; this module only stores and returns rows. There is no
 * foreign key (085: a harnesses rebuild would cascade), so
 * `deleteForHarness` is called by `harnesses.delete`'s SQL and by account
 * cleanup.
 */
import { db } from "./db.ts";

export interface MirrorProvenanceRow {
  harnessId: string;
  stackId: string | null;
  scope: "file" | "key" | "link";
  path: string;
  /** "" for a whole-file or link row; the dotted key for a merged key. */
  key: string;
  valueHash: string | null;
  srcMtimeMs: number | null;
  srcSize: number | null;
  /** The target existed before the first mirror run touched it. */
  preexisted: boolean;
  backupRef: string | null;
  updatedAt: number;
}

type ProvenanceDbRow = {
  harness_id: string;
  stack_id: string | null;
  scope: string;
  path: string;
  key: string;
  value_hash: string | null;
  src_mtime_ms: number | null;
  src_size: number | null;
  preexisted: number;
  backup_ref: string | null;
  updated_at: number;
};

function toRow(row: ProvenanceDbRow): MirrorProvenanceRow {
  return {
    harnessId: row.harness_id,
    stackId: row.stack_id,
    scope: row.scope === "key" || row.scope === "link" ? row.scope : "file",
    path: row.path,
    key: row.key,
    valueHash: row.value_hash,
    srcMtimeMs: row.src_mtime_ms,
    srcSize: row.src_size,
    preexisted: row.preexisted === 1,
    backupRef: row.backup_ref,
    updatedAt: row.updated_at,
  };
}

export const mirrorProvenance = {
  upsert(row: MirrorProvenanceRow): void {
    db.run(
      `INSERT INTO harness_mirror_provenance
         (harness_id, stack_id, scope, path, key, value_hash, src_mtime_ms, src_size, preexisted, backup_ref, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(harness_id, path, key) DO UPDATE SET
         stack_id = excluded.stack_id,
         scope = excluded.scope,
         value_hash = excluded.value_hash,
         src_mtime_ms = excluded.src_mtime_ms,
         src_size = excluded.src_size,
         preexisted = excluded.preexisted,
         backup_ref = excluded.backup_ref,
         updated_at = excluded.updated_at`,
      [
        row.harnessId, row.stackId, row.scope, row.path, row.key, row.valueHash,
        row.srcMtimeMs, row.srcSize, row.preexisted ? 1 : 0, row.backupRef, row.updatedAt,
      ],
    );
  },
  get(harnessId: string, path: string, key = ""): MirrorProvenanceRow | null {
    const row = db
      .query<ProvenanceDbRow, [string, string, string]>(
        `SELECT * FROM harness_mirror_provenance WHERE harness_id = ? AND path = ? AND key = ?`,
      )
      .get(harnessId, path, key);
    return row ? toRow(row) : null;
  },
  list(harnessId: string): MirrorProvenanceRow[] {
    return db
      .query<ProvenanceDbRow, [string]>(
        `SELECT * FROM harness_mirror_provenance WHERE harness_id = ? ORDER BY path ASC, key ASC`,
      )
      .all(harnessId)
      .map(toRow);
  },
  listForPath(harnessId: string, path: string): MirrorProvenanceRow[] {
    return db
      .query<ProvenanceDbRow, [string, string]>(
        `SELECT * FROM harness_mirror_provenance WHERE harness_id = ? AND path = ? ORDER BY key ASC`,
      )
      .all(harnessId, path)
      .map(toRow);
  },
  remove(harnessId: string, path: string, key = ""): void {
    db.run(`DELETE FROM harness_mirror_provenance WHERE harness_id = ? AND path = ? AND key = ?`, [harnessId, path, key]);
  },
  removeForPath(harnessId: string, path: string): void {
    db.run(`DELETE FROM harness_mirror_provenance WHERE harness_id = ? AND path = ?`, [harnessId, path]);
  },
  deleteForHarness(harnessId: string): void {
    db.run(`DELETE FROM harness_mirror_provenance WHERE harness_id = ?`, [harnessId]);
  },
};

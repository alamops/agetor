import type { Harness } from "../../../shared/types.ts";
import type { HarnessPatch } from "../harnesses.ts";
import { defineOp } from "./define.ts";

function mirrorSignature(conn: import("bun:sqlite").Database, harnessId: string): string {
  const prov = conn
    .query(`SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS u FROM harness_mirror_provenance WHERE harness_id = ?`)
    .get(harnessId) as { n: number; u: number };
  const src = conn
    .query(`SELECT updated_at FROM harness_mirror_sources WHERE harness_id = ?`)
    .get(harnessId) as { updated_at: number } | null;
  return `${prov.n}:${prov.u}:${src ? src.updated_at : "-"}`;
}

// Row shapes of the three harness-stack bookkeeping tables, as stored. The main
// thread maps them to typed rows (`harness-mirror-provenance.ts`,
// `harness-swap-history.ts`); an op returns them raw.

export interface ProvenanceDbRow {
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
}

export interface SourceDbRow {
  harness_id: string;
  primary_id: string;
  primary_root: string;
  primary_config: string;
  backup_root: string | null;
  backup_config: string | null;
  updated_at: number;
}

export interface SwapDbRow {
  id: string;
  stack_id: string;
  task_id: string | null;
  task_title: string | null;
  from_harness_id: string | null;
  from_label: string | null;
  to_harness_id: string | null;
  to_label: string | null;
  trigger: string;
  reason: string | null;
  source: string | null;
  message: string | null;
  model: string | null;
  resets_at_ms: number | null;
  from_run_id: string | null;
  to_run_id: string | null;
  continuation: string | null;
  at: number;
}

/** Positional values of one `harness_mirror_provenance` row, in column order of the upsert. */
export type ProvenanceUpsertArgs = [
  harnessId: string, stackId: string | null, scope: string, path: string, key: string,
  valueHash: string | null, srcMtimeMs: number | null, srcSize: number | null,
  preexisted: number, backupRef: string | null, updatedAt: number,
];

/** Positional values of one `harness_swap_events` row. */
export type SwapInsertArgs = [
  id: string, stackId: string, taskId: string | null, taskTitle: string | null,
  fromHarnessId: string | null, fromLabel: string | null, toHarnessId: string | null, toLabel: string | null,
  trigger: string, reason: string | null, source: string | null, message: string | null, model: string | null,
  resetsAtMs: number | null, fromRunId: string | null, toRunId: string | null, continuation: string | null, at: number,
];

export const harnessMirrorOps = {
  /** A fingerprint of an account's mirror records (provenance count and newest
   *  stamp, plus the recorded source stamp): changes whenever a mirror run writes. */
  "mirrorProvenance.signature": defineOp({
    tx: false,
    run: ({ conn }, harnessId: string): string => mirrorSignature(conn, harnessId),
  }),
  /** Save an account edit only while its mirror records are still the ones the
   *  caller judged (`expectedSignature`, null: no check). The signature compare
   *  and the update are one transaction, so a mirror run cannot land between
   *  the check that cleared the edit and the write. A thrown error (e.g. a
   *  built-in harness) rolls back and propagates. */
  "harnesses.updateGuarded": defineOp({
    tx: true,
    run: (
      { conn, modules },
      id: string,
      patch: HarnessPatch,
      expectedSignature: string | null,
    ): { ok: true; harness: Harness } | { ok: false } => {
      if (expectedSignature !== null && mirrorSignature(conn, id) !== expectedSignature) return { ok: false };
      return { ok: true, harness: modules.harnesses.update(id, patch) };
    },
  }),
  "mirrorProvenance.upsert": defineOp({
    tx: false,
    run: ({ conn }, row: ProvenanceUpsertArgs): null => {
      conn.query(
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
      ).run(...row);
      return null;
    },
  }),
  "mirrorProvenance.get": defineOp({
    tx: false,
    run: ({ conn }, harnessId: string, path: string, key: string): ProvenanceDbRow | null =>
      (conn.query(`SELECT * FROM harness_mirror_provenance WHERE harness_id = ? AND path = ? AND key = ?`)
        .get(harnessId, path, key) as ProvenanceDbRow | null) ?? null,
  }),
  "mirrorProvenance.list": defineOp({
    tx: false,
    run: ({ conn }, harnessId: string): ProvenanceDbRow[] =>
      conn.query(`SELECT * FROM harness_mirror_provenance WHERE harness_id = ? ORDER BY path ASC, key ASC`)
        .all(harnessId) as ProvenanceDbRow[],
  }),
  "mirrorProvenance.listForPath": defineOp({
    tx: false,
    run: ({ conn }, harnessId: string, path: string): ProvenanceDbRow[] =>
      conn.query(`SELECT * FROM harness_mirror_provenance WHERE harness_id = ? AND path = ? ORDER BY key ASC`)
        .all(harnessId, path) as ProvenanceDbRow[],
  }),
  "mirrorProvenance.remove": defineOp({
    tx: false,
    run: ({ conn }, harnessId: string, path: string, key: string): null => {
      conn.query(`DELETE FROM harness_mirror_provenance WHERE harness_id = ? AND path = ? AND key = ?`).run(harnessId, path, key);
      return null;
    },
  }),
  "mirrorProvenance.removeForPath": defineOp({
    tx: false,
    run: ({ conn }, harnessId: string, path: string): null => {
      conn.query(`DELETE FROM harness_mirror_provenance WHERE harness_id = ? AND path = ?`).run(harnessId, path);
      return null;
    },
  }),
  "mirrorProvenance.removeAllButPath": defineOp({
    tx: false,
    run: ({ conn }, harnessId: string, path: string): null => {
      conn.query(`DELETE FROM harness_mirror_provenance WHERE harness_id = ? AND path <> ?`).run(harnessId, path);
      return null;
    },
  }),
  "mirrorProvenance.deleteForHarness": defineOp({
    tx: false,
    run: ({ conn }, harnessId: string): null => {
      conn.query(`DELETE FROM harness_mirror_provenance WHERE harness_id = ?`).run(harnessId);
      return null;
    },
  }),
  "mirrorProvenance.harnessIds": defineOp({
    tx: false,
    run: ({ conn }): string[] =>
      (conn.query(`SELECT DISTINCT harness_id FROM harness_mirror_provenance`).all() as { harness_id: string }[])
        .map((r) => r.harness_id),
  }),
  "mirrorSources.get": defineOp({
    tx: false,
    run: ({ conn }, harnessId: string): SourceDbRow | null =>
      (conn.query(`SELECT * FROM harness_mirror_sources WHERE harness_id = ?`).get(harnessId) as SourceDbRow | null) ?? null,
  }),
  "mirrorSources.set": defineOp({
    tx: false,
    run: (
      { conn },
      harnessId: string, primaryId: string, primaryRoot: string, primaryConfig: string,
      backupRoot: string, backupConfig: string, updatedAt: number,
    ): null => {
      conn.query(
        `INSERT INTO harness_mirror_sources
         (harness_id, primary_id, primary_root, primary_config, backup_root, backup_config, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(harness_id) DO UPDATE SET
         primary_id = excluded.primary_id,
         primary_root = excluded.primary_root,
         primary_config = excluded.primary_config,
         backup_root = excluded.backup_root,
         backup_config = excluded.backup_config,
         updated_at = excluded.updated_at`,
      ).run(harnessId, primaryId, primaryRoot, primaryConfig, backupRoot, backupConfig, updatedAt);
      return null;
    },
  }),
  "mirrorSources.deleteForHarness": defineOp({
    tx: false,
    run: ({ conn }, harnessId: string): null => {
      conn.query(`DELETE FROM harness_mirror_sources WHERE harness_id = ?`).run(harnessId);
      return null;
    },
  }),
  "swapEvents.insert": defineOp({
    tx: false,
    run: ({ conn }, row: SwapInsertArgs): null => {
      conn.query(
        `INSERT INTO harness_swap_events
         (id, stack_id, task_id, task_title, from_harness_id, from_label, to_harness_id, to_label,
          trigger, reason, source, message, model, resets_at_ms, from_run_id, to_run_id, continuation, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(...row);
      return null;
    },
  }),
  /** One page, newest first by `(at, id)`; `cursor` is the previous page's last raw row. */
  "swapEvents.page": defineOp({
    tx: false,
    run: ({ conn }, stackId: string, cursor: { at: number; id: string } | null, fetch: number): SwapDbRow[] =>
      (cursor
        ? conn.query(
          `SELECT * FROM harness_swap_events
              WHERE stack_id = ? AND (at, id) < (?, ?)
              ORDER BY at DESC, id DESC LIMIT ?`,
        ).all(stackId, cursor.at, cursor.id, fetch)
        : conn.query(
          `SELECT * FROM harness_swap_events WHERE stack_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
        ).all(stackId, fetch)) as SwapDbRow[],
  }),
  "swapEvents.countForStack": defineOp({
    tx: false,
    run: ({ conn }, stackId: string): number =>
      ((conn.query(`SELECT COUNT(*) AS n FROM harness_swap_events WHERE stack_id = ?`).get(stackId) as { n: number } | null)?.n) ?? 0,
  }),
};

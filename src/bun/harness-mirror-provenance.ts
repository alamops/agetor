/**
 * What a mirror run wrote into a backup account (`harness_mirror_provenance`,
 * migration 087): one row per file, merged key or symlink, keyed by
 * (account, path, key), plus a marker row for a merged file the mirror created
 * ({@link CREATED_FILE_KEY}). A later run uses it to tell its own output from the
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
import { op } from "./db-async.ts";
import type { ProvenanceDbRow, SourceDbRow } from "./db-core/ops/harness-mirror-ops.ts";

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
  async upsert(row: MirrorProvenanceRow): Promise<void> {
    await op("mirrorProvenance.upsert", [[
      row.harnessId, row.stackId, row.scope, row.path, row.key, row.valueHash,
      row.srcMtimeMs, row.srcSize, row.preexisted ? 1 : 0, row.backupRef, row.updatedAt,
    ]]);
  },
  async get(harnessId: string, path: string, key = ""): Promise<MirrorProvenanceRow | null> {
    const row = await op("mirrorProvenance.get", [harnessId, path, key]);
    return row ? toRow(row) : null;
  },
  async list(harnessId: string): Promise<MirrorProvenanceRow[]> {
    return (await op("mirrorProvenance.list", [harnessId])).map(toRow);
  },
  async listForPath(harnessId: string, path: string): Promise<MirrorProvenanceRow[]> {
    return (await op("mirrorProvenance.listForPath", [harnessId, path])).map(toRow);
  },
  async remove(harnessId: string, path: string, key = ""): Promise<void> {
    await op("mirrorProvenance.remove", [harnessId, path, key]);
  },
  async removeForPath(harnessId: string, path: string): Promise<void> {
    await op("mirrorProvenance.removeForPath", [harnessId, path]);
  },
  /** Every row of the account except those for `path` (a Claude account whose
   *  config folder moved while its `.claude.json` folder did not). */
  async removeAllButPath(harnessId: string, path: string): Promise<void> {
    await op("mirrorProvenance.removeAllButPath", [harnessId, path]);
  },
  async deleteForHarness(harnessId: string): Promise<void> {
    await op("mirrorProvenance.deleteForHarness", [harnessId]);
  },
  /** Fingerprint of the account's mirror records; see `harnesses.updateGuarded`. */
  signature(harnessId: string): Promise<string> {
    return op("mirrorProvenance.signature", [harnessId]);
  },
};

/** Stamp (in both source columns) of a row whose ownership ended while its
 *  saved original is still needed: a `preexisted` item stays as the mirror
 *  last wrote it, and Restore must still be able to put the original back.
 *  Propagation and deletion skip such a row; a later mirror write that
 *  re-adopts the item replaces the stamp. No schema change: a real source
 *  stamp is never negative. */
export const UNOWNED_STAMP = -1;

export function isUnownedRow(row: MirrorProvenanceRow): boolean {
  return row.srcMtimeMs === UNOWNED_STAMP && row.srcSize === UNOWNED_STAMP;
}

/**
 * The `key` of a merged file's "created" marker: a `file`-scope row at the
 * merged file's path that says the mirror created that file (it did not
 * exist before the mirror wrote it), with `valueHash` the sha256 of the text
 * the mirror last wrote there. Restore removes a merged file only with this
 * marker, and only while the file still holds those bytes. Merged files have
 * only `key` rows otherwise, and a whole-file or link row's key is always "",
 * so no other row is ever a `file` row with this key (the mirror never owns a
 * merged key spelled this way either). No schema change: the scope CHECK
 * already allows `file`. A row from before the marker existed has none, so a
 * file it describes is never removed.
 */
export const CREATED_FILE_KEY = "(created by the mirror)";

export function isCreatedFileMarker(row: Pick<MirrorProvenanceRow, "scope" | "key">): boolean {
  return row.scope === "file" && row.key === CREATED_FILE_KEY;
}

/** Where a backup's mirror last read its primary from (migration 089) and
 *  where the backup's own folder resolved (migration 090). */
export interface MirrorSourceRow {
  harnessId: string;
  primaryId: string;
  /** The primary's resolved config folder (and, for Claude, a second line with
   *  its `.claude.json` folder), `path.resolve`d. */
  primaryRoot: string;
  /** Fingerprint of the primary's own root settings (`home` and the root env
   *  keys); a change means the user re-pointed the account. */
  primaryConfig: string;
  /** The backup's own resolved folder(s), in the same form as `primaryRoot`;
   *  "" when not recorded yet (a row from before migration 090). */
  backupRoot: string;
  /** Fingerprint of the backup's own root settings; "" when not recorded. */
  backupConfig: string;
  updatedAt: number;
}

/** One row per backup account; untrusted like provenance rows. Its folders are
 *  only compared and checked for existence (resolved lexically, never stat'ed
 *  inside a macOS-protected folder), never read from or written to, so a
 *  planted row can at most make a mirror skip, a Restore refuse, or a mirror
 *  or a Restore drop this same account's own mirror records and saved
 *  originals (never a file in any account folder). */
export const mirrorSources = {
  async get(harnessId: string): Promise<MirrorSourceRow | null> {
    const row: SourceDbRow | null = await op("mirrorSources.get", [harnessId]);
    return row
      ? {
        harnessId: row.harness_id,
        primaryId: row.primary_id,
        primaryRoot: row.primary_root,
        primaryConfig: row.primary_config,
        backupRoot: row.backup_root ?? "",
        backupConfig: row.backup_config ?? "",
        updatedAt: row.updated_at,
      }
      : null;
  },
  async set(row: MirrorSourceRow): Promise<void> {
    await op("mirrorSources.set", [
      row.harnessId, row.primaryId, row.primaryRoot, row.primaryConfig, row.backupRoot, row.backupConfig, row.updatedAt,
    ]);
  },
  async deleteForHarness(harnessId: string): Promise<void> {
    await op("mirrorSources.deleteForHarness", [harnessId]);
  },
};

/** Distinct harness ids with at least one provenance row (the primary key
 *  index covers the scan). */
export function harnessIdsWithProvenance(): Promise<string[]> {
  return op("mirrorProvenance.harnessIds", []);
}

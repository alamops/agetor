import type { Database } from "bun:sqlite";
import path from "node:path";
import type { AgentKind, Harness, HarnessQuota, HarnessUsage } from "../../shared/types.ts";
import { handoffCopySessionIdFromPath } from "../../shared/harness-mirror.ts";
import { HarnessBuiltinError, HarnessInUseError } from "./errors.ts";
import type { SessionIdColumn } from "./runs.ts";

export type HarnessRow = {
  id: string;
  kind: string;
  label: string;
  is_builtin: number;
  home: string | null;
  bin: string | null;
  env_json: string;
  enabled: number;
  // fx-only per-harness toggle (migration 073, default 1) — see
  // `Harness.profileMcpServers`.
  profile_mcp_servers: number;
  created_at: number;
  updated_at: number;
};

export const toHarness = (r: HarnessRow): Harness => {
  let env: Record<string, string> = {};
  try {
    const parsed = JSON.parse(r.env_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") env[k] = v;
      }
    }
  } catch { /* malformed env_json → empty */ }
  return {
    id: r.id,
    kind: r.kind as AgentKind,
    label: r.label,
    isBuiltin: r.is_builtin === 1,
    home: r.home,
    bin: r.bin,
    env,
    enabled: r.enabled === 1,
    profileMcpServers: r.profile_mcp_servers !== 0,
  };
};

export const HARNESS_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

export interface HarnessInsertInput {
  id: string;
  kind: AgentKind;
  label: string;
  home?: string | null;
  bin?: string | null;
  env?: Record<string, string>;
  /** Defaults to on (the column's default) when omitted. */
  profileMcpServers?: boolean;
}

export interface HarnessPatch {
  label?: string;
  home?: string | null;
  bin?: string | null;
  env?: Record<string, string>;
  /** The one field `update` accepts on a built-in harness too — see its doc. */
  profileMcpServers?: boolean;
}

/** A provider session copied from one stack account onto another. */
export interface HarnessSessionHandoff {
  taskId: string;
  harnessId: string;
  columnName: SessionIdColumn;
  sessionId: string;
  /** Absolute paths the transfer wrote, used as the cleanup allowlist. */
  copiedPaths: string[];
  createdAt: number;
}

export type HandoffRow = {
  task_id: string;
  harness_id: string;
  column_name: string;
  session_id: string;
  copied_paths_json: string;
  created_at: number;
};

export const toHandoff = (r: HandoffRow): HarnessSessionHandoff => ({
  taskId: r.task_id,
  harnessId: r.harness_id,
  columnName: r.column_name as SessionIdColumn,
  sessionId: r.session_id,
  copiedPaths: (() => {
    try {
      const parsed = JSON.parse(r.copied_paths_json);
      return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
    } catch {
      return [];
    }
  })(),
  createdAt: r.created_at,
});

export type OrphanedCopyRow = {
  harness_id: string;
  column_name: string;
  session_id: string;
  path: string;
  created_at: number;
};

export interface HarnessOrphanedCopy {
  harnessId: string;
  columnName: SessionIdColumn;
  /** The session the file was copied for: its shape must name it. */
  sessionId: string;
  path: string;
  createdAt: number;
}

/** The only columns a handoff copy is ever recorded under. The table is
 *  agent-writable, so a row naming any other column is never returned and is
 *  never acted on (`forgetForeignColumns` drops it). */
export const ORPHAN_COLUMNS: readonly SessionIdColumn[] = ["claude_session_id", "codex_session_id"];

export const toOrphanedCopy = (r: OrphanedCopyRow): HarnessOrphanedCopy | null => {
  const columnName = ORPHAN_COLUMNS.find((c) => c === r.column_name);
  if (!columnName) return null;
  return {
    harnessId: r.harness_id,
    columnName,
    sessionId: r.session_id,
    path: r.path,
    createdAt: r.created_at,
  };
};

export const isOrphanedCopy = (r: HarnessOrphanedCopy | null): r is HarnessOrphanedCopy => r !== null;

/** How far ahead of the wall clock an earlier run's stamp may seed the next
 *  one (a clock that was ahead, then corrected). */
export const ORPHAN_STAMP_SEED_MARGIN_MS = 24 * 60 * 60 * 1000;

export type HarnessUsageRow = {
  harness_id: string;
  snapshot_json: string;
  updated_at: number;
};

export function makeHarnessStore(conn: Database) {
  /**
   * Re-pack a stack's stored ranks to `0..n-1` in their current order.
   * `harnesses.delete` removes one membership row and leaves a gap;
   * `UNIQUE(stack_id, position)` forbids renumbering in place, so the surviving
   * rows are rewritten inside the caller's transaction. A stack with no rows
   * left is a no-op (nothing to rank).
   */
  function renumberStackPositions(stackId: string): void {
    const survivors = conn
      .query<{ harness_id: string }, [string]>(
        `SELECT harness_id FROM harness_stack_members WHERE stack_id = ? ORDER BY position ASC`,
      )
      .all(stackId)
      .map((row) => row.harness_id);
    if (survivors.length === 0) return;
    conn.run(`DELETE FROM harness_stack_members WHERE stack_id = ?`, [stackId]);
    survivors.forEach((harnessId, position) => {
      conn.run(
        `INSERT INTO harness_stack_members (stack_id, harness_id, position) VALUES (?, ?, ?)`,
        [stackId, harnessId, position],
      );
    });
  }

  /**
   * The newest `created_at` this process has stamped on (or seen in)
   * `harness_orphaned_copies`. Stamps only move forward, so a sweep can take a
   * mark (`sweepMark`) and later forget only the records stamped at or before
   * it: a record a transfer wrote while the sweep was running is always stamped
   * after the mark, even within the same millisecond. Seeded from the table on
   * first use, so a record from an earlier run whose clock was ahead is still
   * at or below the first mark.
   *
   * The table is agent-writable, so the seed reads only integer stamps and is
   * clamped to {@link ORPHAN_STAMP_SEED_MARGIN_MS} past the wall clock: a
   * planted `created_at` at or above 2^53 (where `+ 1` no longer changes a
   * double) or a huge REAL would otherwise freeze every later stamp at one value,
   * and a sweep would then forget a record written mid-sweep. A row stamped
   * past the clamp is simply never forgotten by a sweep (the safe side).
   */
  let orphanStamp: number | null = null;

  function currentOrphanStamp(): number {
    if (orphanStamp === null) {
      const max = conn
        .query<{ m: number | null }, []>(
          `SELECT MAX(created_at) AS m FROM harness_orphaned_copies WHERE typeof(created_at) = 'integer'`,
        )
        .get()?.m;
      const seed = typeof max === "number" && Number.isSafeInteger(max) ? max : 0;
      orphanStamp = Math.min(seed, Date.now() + ORPHAN_STAMP_SEED_MARGIN_MS);
    }
    return orphanStamp;
  }

  /** Test seam: forget the seeded stamp, so the next stamp re-reads the table. */
  function resetOrphanStampForTests(): void {
    orphanStamp = null;
  }

  /** A stamp strictly after every earlier stamp and every mark. */
  function nextOrphanStamp(): number {
    orphanStamp = Math.max(Date.now(), currentOrphanStamp() + 1);
    return orphanStamp;
  }

  const harnesses = {
    list(): Harness[] {
      return conn
        .query<HarnessRow, []>(
          `SELECT * FROM harnesses ORDER BY is_builtin DESC, created_at ASC`,
        )
        .all()
        .map(toHarness);
    },
    get(id: string): Harness | null {
      const row = conn
        .query<HarnessRow, [string]>(`SELECT * FROM harnesses WHERE id = ?`)
        .get(id);
      return row ? toHarness(row) : null;
    },
    /**
     * Resolve a harness id, falling back to a synthetic built-in when the id
     * looks like a known kind (legacy rows or freshly-deleted aliases). Used
     * at spawn time so an out-of-band missing row never silently picks the
     * wrong kind.
     */
    getByIdOrKind(id: string): Harness | null {
      const direct = this.get(id);
      if (direct) return direct;
      if (
        id === "claude-code" || id === "codex" || id === "cursor" ||
        id === "gemini" || id === "fx" || id === "antigravity" || id === "opencode" ||
        id === "copilot"
      ) {
        const label =
          id === "claude-code" ? "Claude Code"
          : id === "codex" ? "Codex"
          : id === "cursor" ? "Cursor"
          : id === "gemini" ? "Gemini CLI"
          : id === "fx" ? "fx.sh"
          : id === "antigravity" ? "Antigravity"
          : id === "copilot" ? "GitHub Copilot"
          : "OpenCode";
        return {
          id,
          kind: id,
          label,
          isBuiltin: true,
          home: null,
          bin: null,
          env: {},
          enabled: true,
          profileMcpServers: true,
        } satisfies Harness;
      }
      return null;
    },
    insert(input: HarnessInsertInput): Harness {
      if (!HARNESS_ID_RE.test(input.id)) {
        throw new Error(
          `invalid harness id "${input.id}" — must match ${HARNESS_ID_RE}`,
        );
      }
      if (
        input.kind !== "claude-code" && input.kind !== "codex" &&
        input.kind !== "cursor" && input.kind !== "gemini" &&
        input.kind !== "antigravity" && input.kind !== "fx" &&
        input.kind !== "opencode" && input.kind !== "copilot"
      ) {
        throw new Error(`unknown harness kind: ${input.kind}`);
      }
      const now = Date.now();
      const envJson = JSON.stringify(input.env ?? {});
      conn.run(
        `INSERT INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, profile_mcp_servers, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.kind,
          input.label,
          input.home ?? null,
          input.bin ?? null,
          envJson,
          input.profileMcpServers === false ? 0 : 1,
          now,
          now,
        ],
      );
      return this.get(input.id) as Harness;
    },
    /**
     * Edit a harness's config. Built-ins refuse every identity/config field
     * (`HarnessBuiltinError`), but `profileMcpServers` is a behaviour toggle
     * like `enabled` — the built-in fx row is the harness most users run — so
     * a patch carrying only that field is accepted on a built-in too.
     */
    update(id: string, patch: HarnessPatch): Harness {
      const current = this.get(id);
      if (!current) throw new Error(`harness not found: ${id}`);
      const touchesConfig =
        patch.label !== undefined || patch.home !== undefined ||
        patch.bin !== undefined || patch.env !== undefined;
      if (current.isBuiltin && touchesConfig) throw new HarnessBuiltinError("edit");
      const next = {
        label: patch.label ?? current.label,
        home: patch.home === undefined ? current.home : patch.home,
        bin: patch.bin === undefined ? current.bin : patch.bin,
        env: patch.env ?? current.env,
        profileMcpServers: patch.profileMcpServers ?? current.profileMcpServers !== false,
      };
      conn.run(
        `UPDATE harnesses
         SET label = ?, home = ?, bin = ?, env_json = ?, profile_mcp_servers = ?, updated_at = ?
       WHERE id = ?`,
        [
          next.label,
          next.home,
          next.bin,
          JSON.stringify(next.env),
          next.profileMcpServers ? 1 : 0,
          Date.now(),
          id,
        ],
      );
      return this.get(id) as Harness;
    },
    /**
     * Refuse a delete with the same two guards `delete` enforces, WITHOUT
     * touching a row or a file. Route handlers that must remove on-disk state
     * owned by the harness (its copied handoff sessions) call this first: a
     * refused delete must leave that state intact. Keeping one implementation
     * here means the pre-check and the real delete can never disagree.
     * A missing row is a no-op, matching `delete`.
     */
    assertDeletable(id: string): void {
      const current = this.get(id);
      if (!current) return;
      if (current.isBuiltin) throw new HarnessBuiltinError("delete");
      const inUse = conn
        .query<{ id: string }, [string]>(
          `SELECT id FROM tasks WHERE agent = ?`,
        )
        .all(id);
      const inUseByProfiles = conn
        .query<{ id: string }, [string]>(
          `SELECT id FROM agent_profiles WHERE harness_id = ?`,
        )
        .all(id);
      if (inUse.length > 0 || inUseByProfiles.length > 0) {
        throw new HarnessInUseError(inUse.map((r) => r.id), inUseByProfiles.map((r) => r.id));
      }
    },
    delete(id: string): void {
      const current = this.get(id);
      if (!current) return;
      this.assertDeletable(id);
      conn.transaction(() => {
        // Remember the stack before the membership row goes, so the surviving
        // ranks can be made contiguous again. A gap (`0, 2`) would make the
        // stored position an impossible "3/2" in the swap divider and the card
        // badge (review R13-M1); the reader also re-ranks defensively, but the
        // DB must not claim a rank that does not exist.
        const membership = conn
          .query<{ stack_id: string }, [string]>(
            `SELECT stack_id FROM harness_stack_members WHERE harness_id = ?`,
          )
          .get(id);
        conn.run(`DELETE FROM harnesses WHERE id = ?`, [id]);
        // Drop any cached usage snapshot so a deleted alias doesn't leave an
        // orphaned harness_usage row (the table has no FK cascade by design).
        conn.run(`DELETE FROM harness_usage WHERE harness_id = ?`, [id]);
        // Stack membership has no FK to harnesses (085: a cascade would wipe
        // every membership on the next harnesses table rebuild), so the row is
        // deleted here, before the survivors are renumbered. The cooldown is
        // account-global and keyed by harness id with no FK, and the handoff
        // table deliberately names a destination account without an FK (a
        // historical handoff is not ownership), so both are deleted here too.
        conn.run(`DELETE FROM harness_stack_members WHERE harness_id = ?`, [id]);
        conn.run(`DELETE FROM harness_limit_state WHERE harness_id = ?`, [id]);
        harnessSessionHandoffs.deleteForHarness(id);
        harnessOrphanedCopies.deleteForHarness(id);
        // Mirror provenance names the account by id with no FK (087); its store
        // imports this module, so the delete is inline here. Swap-history rows
        // are kept on purpose (denormalized labels).
        conn.run(`DELETE FROM harness_mirror_provenance WHERE harness_id = ?`, [id]);
        conn.run(`DELETE FROM harness_mirror_sources WHERE harness_id = ?`, [id]);
        if (membership) {
          renumberStackPositions(membership.stack_id);
          // The membership changed, so the stack's `updated_at` must too or an
          // editor's `expectedUpdatedAt` would not see it. Strictly increasing,
          // like `harnessStacks.update`.
          conn.run(`UPDATE harness_stacks SET updated_at = MAX(?, updated_at + 1) WHERE id = ?`, [Date.now(), membership.stack_id]);
        }
      })();
    },
    /**
     * Soft delete / re-enable. Carve-out from `HarnessBuiltinError` — toggling
     * the enabled flag is allowed on built-ins too. Identity/config fields
     * (label, home, bin, env) remain immutable for built-ins via `update`.
     */
    setEnabled(id: string, enabled: boolean): Harness {
      const current = this.get(id);
      if (!current) throw new Error(`harness not found: ${id}`);
      conn.run(
        `UPDATE harnesses SET enabled = ?, updated_at = ? WHERE id = ?`,
        [enabled ? 1 : 0, Date.now(), id],
      );
      return this.get(id) as Harness;
    },
    /**
     * Reports how many tasks reference this harness and which ones are
     * currently running. The UI uses this to warn before disabling.
     */
    usage(id: string): HarnessUsage {
      const total = conn
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM tasks WHERE agent = ?`,
        )
        .get(id);
      const running = conn
        .query<{ id: string }, [string]>(
          `SELECT id FROM tasks WHERE agent = ? AND "column" = 'running'`,
        )
        .all(id);
      return {
        harnessId: id,
        runningTaskIds: running.map((r) => r.id),
        totalTaskCount: total?.n ?? 0,
      };
    },
  };

  /**
   * The recorded provider-session handoffs (migration 084). A row is the one
   * exception to "session ids are scoped to the harness that created them": it
   * says `sessionId` was COPIED onto `harnessId` for `taskId`, so the resume
   * lookup may use it there. `copiedPaths` is the cleanup allowlist — a path
   * not recorded here is never removed.
   */
  const harnessSessionHandoffs = {
    get(taskId: string, harnessId: string, column: SessionIdColumn): HarnessSessionHandoff | null {
      const row = conn
        .query<HandoffRow, [string, string, string]>(
          `SELECT * FROM harness_session_handoffs
          WHERE task_id = ? AND harness_id = ? AND column_name = ?`,
        )
        .get(taskId, harnessId, column);
      return row ? toHandoff(row) : null;
    },
    /**
     * Record (or replace) the handoff for one (task, destination, column). The
     * session id and timestamp are replaced. For the SAME session `copiedPaths`
     * is MERGED with the existing row's list (existing order first, duplicates
     * dropped): a file an earlier transfer copied onto this account is still on
     * disk, and dropping it from the allowlist would leak it past task delete,
     * retention and harness delete. For a DIFFERENT session the old paths move
     * to `harnessOrphanedCopies` under the old session id, because cleanup only
     * removes paths of the row's own session (docs/architecture/harness-stacks.md).
     * Read and write share one transaction so two upserts can't lose each
     * other's paths.
     */
    upsert(handoff: HarnessSessionHandoff): void {
      conn.transaction(() => {
        const existing = this.get(handoff.taskId, handoff.harnessId, handoff.columnName);
        let copiedPaths: string[];
        if (existing && existing.sessionId !== handoff.sessionId) {
          // Re-keyed to another session: cleanup removes a path only when its
          // shape names the row's session, so the old session's copies could
          // never be removed from here. They move to the orphan store under
          // their own session id, where a sweep removes them.
          const incoming = new Set(handoff.copiedPaths);
          harnessOrphanedCopies.addLabelled(existing, existing.copiedPaths.filter((p) => !incoming.has(p)));
          copiedPaths = [...incoming];
        } else {
          copiedPaths = [...new Set([...(existing?.copiedPaths ?? []), ...handoff.copiedPaths])];
        }
        // A path back on a live row (a failed transfer restoring the previous
        // session) is no longer an orphan.
        harnessOrphanedCopies.forget(handoff.harnessId, handoff.columnName, handoff.sessionId, copiedPaths);
        conn.run(
          `INSERT INTO harness_session_handoffs
           (task_id, harness_id, column_name, session_id, copied_paths_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, harness_id, column_name) DO UPDATE SET
           session_id = excluded.session_id,
           copied_paths_json = excluded.copied_paths_json,
           created_at = excluded.created_at`,
          [
            handoff.taskId,
            handoff.harnessId,
            handoff.columnName,
            handoff.sessionId,
            JSON.stringify(copiedPaths),
            handoff.createdAt,
          ],
        );
      })();
    },
    deleteForHarness(harnessId: string): void {
      conn.run(`DELETE FROM harness_session_handoffs WHERE harness_id = ?`, [harnessId]);
    },
    deleteOne(taskId: string, harnessId: string, column: SessionIdColumn): void {
      conn.run(
        `DELETE FROM harness_session_handoffs WHERE task_id = ? AND harness_id = ? AND column_name = ?`,
        [taskId, harnessId, column],
      );
    },
    /** Drop a row whose files may still be on disk (a transfer that failed with
     *  no earlier handoff to restore): its paths move to the orphan store first,
     *  so a sweep can still remove whatever the copy created. */
    abandon(taskId: string, harnessId: string, column: SessionIdColumn): void {
      conn.transaction(() => {
        const row = this.get(taskId, harnessId, column);
        if (!row) return;
        harnessOrphanedCopies.add(row.harnessId, row.columnName, row.sessionId, row.copiedPaths);
        this.deleteOne(taskId, harnessId, column);
      })();
    },
    /**
     * The boot normalization of one row (see `adoptMismatchedHandoffPaths`):
     * paths whose shape names another session move to the orphan store under
     * that session, the rest stay. The row is re-read inside the transaction, so
     * a transfer that re-keyed or extended it since the caller listed it is
     * never overwritten; a row stamped 0 (a transfer that never completed, whose
     * old session is still the resumable one) is left alone. Returns the number
     * of paths moved.
     */
    orphanMismatchedPaths(taskId: string, harnessId: string, column: SessionIdColumn): number {
      return conn.transaction(() => {
        const row = this.get(taskId, harnessId, column);
        if (!row || row.createdAt === 0) return 0;
        const kind = column === "codex_session_id" ? "codex" : "claude-code";
        const keep: string[] = [];
        const bySession = new Map<string, string[]>();
        for (const p of row.copiedPaths) {
          const sid = handoffCopySessionIdFromPath(kind, path.resolve(p), row.sessionId);
          if (sid !== null && sid !== row.sessionId) bySession.set(sid, [...(bySession.get(sid) ?? []), p]);
          else keep.push(p);
        }
        if (bySession.size === 0) return 0;
        let moved = 0;
        for (const [sid, paths] of bySession) {
          harnessOrphanedCopies.add(row.harnessId, row.columnName, sid, paths);
          moved += paths.length;
        }
        conn.run(
          `UPDATE harness_session_handoffs SET copied_paths_json = ?
          WHERE task_id = ? AND harness_id = ? AND column_name = ?`,
          [JSON.stringify(keep), taskId, harnessId, column],
        );
        return moved;
      })();
    },
    listAll(): HarnessSessionHandoff[] {
      return conn
        .query<HandoffRow, []>(`SELECT * FROM harness_session_handoffs ORDER BY created_at ASC`)
        .all()
        .map(toHandoff);
    },
    /** True when a live row for this account and column names `sessionId`: its
     *  files belong to a conversation that can still be resumed. */
    hasLiveSession(harnessId: string, column: SessionIdColumn, sessionId: string): boolean {
      return (
        conn
          .query<{ n: number }, [string, string, string]>(
            `SELECT COUNT(*) AS n FROM harness_session_handoffs
            WHERE harness_id = ? AND column_name = ? AND session_id = ?`,
          )
          .get(harnessId, column, sessionId)?.n ?? 0
      ) > 0;
    },
    listForTask(taskId: string): HarnessSessionHandoff[] {
      return conn
        .query<HandoffRow, [string]>(
          `SELECT * FROM harness_session_handoffs WHERE task_id = ? ORDER BY created_at ASC`,
        )
        .all(taskId)
        .map(toHandoff);
    },
    /** Every handoff whose destination is this account (harness delete). */
    listForHarness(harnessId: string): HarnessSessionHandoff[] {
      return conn
        .query<HandoffRow, [string]>(
          `SELECT * FROM harness_session_handoffs WHERE harness_id = ? ORDER BY created_at ASC`,
        )
        .all(harnessId)
        .map(toHandoff);
    },
  };

  /**
   * Handoff copies no handoff row can clean up any more (migration 088): the
   * old session's files after a row was re-keyed, and the kept files of a
   * deleted task. Each path carries the session it was copied for. The sweep in
   * `harness-session-transfer.ts` removes them under the handoff cleanup rules;
   * a path is never removed just because it is listed here.
   */
  const harnessOrphanedCopies = {
    add(harnessId: string, column: SessionIdColumn, sessionId: string, paths: readonly string[]): void {
      if (paths.length === 0) return;
      conn.transaction(() => {
        const now = nextOrphanStamp();
        for (const p of new Set(paths)) {
          if (typeof p !== "string" || p === "") continue;
          conn.run(
            `INSERT INTO harness_orphaned_copies (harness_id, column_name, session_id, path, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(harness_id, column_name, path) DO UPDATE SET
             session_id = excluded.session_id,
             created_at = excluded.created_at`,
            [harnessId, column, sessionId, p, now],
          );
        }
      })();
    },
    /**
     * A mark for a sweep, taken before it lists the records: every record listed
     * after it is stamped at or before the mark, and every record written later
     * (a transfer of the same session recording its pending paths while the
     * sweep yields) is stamped after it. Pass it to `forget` as `notAfter`.
     */
    sweepMark(): number {
      orphanStamp = Math.max(Date.now(), currentOrphanStamp());
      return orphanStamp;
    },
    /** Forget the listed paths of one session: they are on a live row again, or
     *  a sweep removed them, found them gone or rejected them as never ours. The
     *  session id is part of the match, so a path re-orphaned under another
     *  session meanwhile is kept. With `notAfter` (a sweep's mark), a record
     *  written after the mark is kept too: it is a newer transfer's pending
     *  record of a file that transfer may be creating right now. Without it the
     *  stamp is not compared at all, so a record with a planted `created_at`
     *  (past 2^53, a REAL, a TEXT) is still forgotten. */
    forget(
      harnessId: string,
      column: SessionIdColumn,
      sessionId: string,
      paths: readonly string[],
      opts: { notAfter?: number } = {},
    ): void {
      if (paths.length === 0) return;
      const notAfter = opts.notAfter;
      conn.transaction(() => {
        for (const p of new Set(paths)) {
          if (notAfter === undefined) {
            conn.run(
              `DELETE FROM harness_orphaned_copies
              WHERE harness_id = ? AND column_name = ? AND path = ? AND session_id = ?`,
              [harnessId, column, p, sessionId],
            );
          } else {
            conn.run(
              `DELETE FROM harness_orphaned_copies
              WHERE harness_id = ? AND column_name = ? AND path = ? AND session_id = ?
                AND created_at <= ?`,
              [harnessId, column, p, sessionId, notAfter],
            );
          }
        }
      })();
    },
    /** Drop every record (of one account, when given) whose column is not a
     *  handoff column. Nothing agetor writes has one, so such a row was planted;
     *  it is never listed, and this removes it. Returns how many rows went. */
    forgetForeignColumns(harnessId?: string): number {
      const placeholders = ORPHAN_COLUMNS.map(() => "?").join(", ");
      if (harnessId !== undefined) {
        return conn.run(
          `DELETE FROM harness_orphaned_copies WHERE harness_id = ? AND column_name NOT IN (${placeholders})`,
          [harnessId, ...ORPHAN_COLUMNS],
        ).changes;
      }
      return conn.run(
        `DELETE FROM harness_orphaned_copies WHERE column_name NOT IN (${placeholders})`,
        [...ORPHAN_COLUMNS],
      ).changes;
    },
    list(filter: { harnessId?: string } = {}): HarnessOrphanedCopy[] {
      if (filter.harnessId !== undefined) {
        return conn
          .query<OrphanedCopyRow, [string]>(
            `SELECT * FROM harness_orphaned_copies WHERE harness_id = ? ORDER BY created_at ASC, path ASC`,
          )
          .all(filter.harnessId)
          .map(toOrphanedCopy)
          .filter(isOrphanedCopy);
      }
      return conn
        .query<OrphanedCopyRow, []>(`SELECT * FROM harness_orphaned_copies ORDER BY created_at ASC, path ASC`)
        .all()
        .map(toOrphanedCopy)
        .filter(isOrphanedCopy);
    },
    deleteForHarness(harnessId: string): void {
      conn.run(`DELETE FROM harness_orphaned_copies WHERE harness_id = ?`, [harnessId]);
    },
    /**
     * Keep a task's remaining handoff copies before its rows cascade away. Task
     * delete first runs the normal cleanup, which drops every row whose files
     * are gone; whatever is still recorded here could not be removed (the
     * account's root changed, an unlink failed), so it is orphaned instead of
     * forgotten. Rows for an account that no longer exists are skipped: there is
     * no root to resolve them against, as in handoff cleanup.
     */
    adoptFromTask(taskId: string): void {
      for (const row of harnessSessionHandoffs.listForTask(taskId)) {
        if (!harnesses.getByIdOrKind(row.harnessId)) continue;
        this.addLabelled(row, row.copiedPaths);
      }
    },
    /** Orphan some of a handoff row's paths, each labelled with the session its
     *  shape names (a pre-088 re-keyed row can still list another session's
     *  paths); the row's own session wins, and is the fallback. */
    addLabelled(row: HarnessSessionHandoff, paths: readonly string[]): void {
      const kind = row.columnName === "codex_session_id" ? "codex" : "claude-code";
      const bySession = new Map<string, string[]>();
      for (const p of paths) {
        const sid = handoffCopySessionIdFromPath(kind, path.resolve(p), row.sessionId) ?? row.sessionId;
        bySession.set(sid, [...(bySession.get(sid) ?? []), p]);
      }
      for (const [sid, list] of bySession) this.add(row.harnessId, row.columnName, sid, list);
    },
  };
  return { harnesses, harnessSessionHandoffs, harnessOrphanedCopies, resetOrphanStampForTests };
}

export function makeHarnessUsage(conn: Database) {
  /**
   * Latest per-harness usage/quota snapshot for the topbar usage tracker
   * (docs/plans/harness-usage-tracker.md). Standalone table, deliberately not
   * a column on `harnesses` — see migration 042's comment. `get`/`getAll`
   * parse defensively (a malformed or stale-shape snapshot is dropped rather
   * than thrown), mirroring `toHarness`'s handling of `env_json`.
   */
  const harnessUsage = {
    get(harnessId: string): HarnessQuota | null {
      const row = conn
        .query<HarnessUsageRow, [string]>(
          `SELECT * FROM harness_usage WHERE harness_id = ?`,
        )
        .get(harnessId);
      if (!row) return null;
      try {
        return JSON.parse(row.snapshot_json) as HarnessQuota;
      } catch {
        return null;
      }
    },
    getAll(): HarnessQuota[] {
      const rows = conn
        .query<HarnessUsageRow, []>(`SELECT * FROM harness_usage`)
        .all();
      const out: HarnessQuota[] = [];
      for (const row of rows) {
        try {
          out.push(JSON.parse(row.snapshot_json) as HarnessQuota);
        } catch {
          // malformed snapshot — skip rather than throw.
        }
      }
      return out;
    },
    upsert(quota: HarnessQuota): void {
      conn.run(
        `INSERT INTO harness_usage (harness_id, snapshot_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(harness_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at`,
        [quota.harnessId, JSON.stringify(quota), Date.now()],
      );
    },
    delete(harnessId: string): void {
      conn.run(`DELETE FROM harness_usage WHERE harness_id = ?`, [harnessId]);
    },
  };
  return harnessUsage;
}

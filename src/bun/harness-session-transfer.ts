/**
 * Provider-session transfer for a harness-stack failover
 * (docs/architecture/harness-stacks.md, plan T05/T12).
 *
 * A conversation belongs to the account that created it. The one sanctioned
 * exception is a recorded handoff: when a task fails over, its Claude
 * transcript (or Codex rollout) is copied onto the destination account at the
 * exact path that account's CLI will read, and `harness_session_handoffs`
 * records the copy so `findLastSessionIdForHarness` can resume it and the
 * cleanup can remove it later.
 *
 * Every source path is agent-writable, so reads are no-follow/regular-file,
 * copies are atomic and 0600, and a symlink/FIFO/oversized transcript is
 * refused rather than followed. A config root that now resolves (through a
 * symlink planted after the account was saved) into a macOS-protected home
 * folder its stored path did not name is refused before anything touches it
 * (contract CR4, `rootRedirectRefusal`). Two accounts whose config roots resolve to the
 * same directory (realpath) are refused, and a destination file that existed
 * BEFORE the copy (the destination account's own original after an A→B→A
 * wrap) is never recorded in `copiedPaths`, so cleanup can only delete files
 * the transfer created. A missing transcript is `no-session`; the
 * caller decides what that means — when it has a recorded session id the
 * conversation is gone and the swap blocks (`harness-swap-failed`) rather than
 * silently starting fresh.
 */
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { encodeProjectPath } from "./claude-tmux.ts";
import { harnesses, harnessSessionHandoffs, runs, type HarnessSessionHandoff, type SessionIdColumn } from "./db.ts";
import {
  copyRegularFileDetailed,
  copyTreeCooperative,
  isPlainAncestorPathUnder,
  isPlainDir,
  isRegularFileNoFollow,
  removeCopiedPaths,
  rootsRedirectRefusal,
  sameConfigRoot,
} from "./harness-file-transfer.ts";
import { claudeConfigDirFor, codexHomeFor } from "./harness-config-root.ts";
import { CLAUDE_SESSION_SIDECAR_DIRS, isHandoffCopyShape, isSafePathSegment } from "../shared/harness-mirror.ts";
import type { Harness, HarnessStackKind } from "../shared/types.ts";
import { resolveBin } from "./agents.ts";
import { childEnv, coreSpawn } from "./core-spawn.ts";

export const CLAUDE_SESSION_COLUMN = "claude_session_id" as const satisfies SessionIdColumn;
export const CODEX_SESSION_COLUMN = "codex_session_id" as const satisfies SessionIdColumn;

const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const SIDECAR_DIRS = CLAUDE_SESSION_SIDECAR_DIRS;

export type TransferResult =
  | {
      ok: true;
      sessionId: string;
      copiedPaths: string[];
      /** Non-fatal maintenance problems (e.g. Codex's rollout projection
       *  migration). The transfer succeeded; callers surface these as status
       *  lines / logs instead of dropping them. */
      warnings?: string[];
    }
  | {
      ok: false;
      reason: "no-session" | "unsafe-source" | "too-large" | "io" | "unsupported";
      message: string;
    };

export interface TransferArgs {
  taskId: string;
  fromHarness: Harness;
  toHarness: Harness;
  sessionId: string;
  cwd: string;
}

export interface SessionTransferAdapter {
  kind: "claude-code" | "codex";
  column: SessionIdColumn;
  transfer(args: TransferArgs): Promise<TransferResult>;
  /** Remove this adapter's recorded copies for one task/account pair. */
  cleanup(taskId: string, harnessId: string): Promise<void>;
}

function unsafeReason(message: string): TransferResult {
  return { ok: false, reason: "unsafe-source", message };
}

function claudeTranscriptPath(root: string, cwd: string, sessionId: string): {
  fresh: string;
  legacy: string;
  encoded: string;
} {
  const encoded = encodeProjectPath(cwd);
  return {
    fresh: path.join(root, "projects", encoded, `${sessionId}.jsonl`),
    legacy: path.join(root, ".claude", "projects", encoded, `${sessionId}.jsonl`),
    encoded,
  };
}

/** The Claude adapter: transcript + the three sidecar dirs. */
export const claudeSessionTransfer: SessionTransferAdapter = {
  kind: "claude-code",
  column: CLAUDE_SESSION_COLUMN,
  async transfer({ taskId, fromHarness, toHarness, sessionId, cwd }): Promise<TransferResult> {
    if (fromHarness.kind !== "claude-code" || toHarness.kind !== "claude-code") {
      return { ok: false, reason: "unsupported", message: "session transfer needs two claude-code accounts" };
    }
    const fromRoot = claudeConfigDirFor(fromHarness);
    const toRoot = claudeConfigDirFor(toHarness);
    // Contract CR4: refuse a root that now resolves into a macOS-protected
    // folder it was not saved under, before anything (realpath included)
    // touches it.
    const redirected = rootsRedirectRefusal([
      [fromRoot, "the source account's config directory"],
      [toRoot, "the destination account's config directory"],
    ]);
    if (redirected) return unsafeReason(redirected);
    // realpath, not `path.resolve`: a later `PATCH /harnesses/:id` can point a
    // backup's root at the primary's through a symlink, and copying an account
    // onto itself then lets cleanup delete the source's own transcript.
    if (sameConfigRoot(fromRoot, toRoot)) {
      return { ok: false, reason: "unsafe-source", message: "source and destination share a config directory" };
    }
    // The id becomes a file name on the destination; a separator or `..`
    // would write outside `projects/<enc>/`.
    if (!isSafePathSegment(sessionId)) return unsafeReason("the session id is not a plain file name");
    const source = claudeTranscriptPath(fromRoot, cwd, sessionId);
    const isFresh = existsSync(source.fresh);
    const src = isFresh ? source.fresh : source.legacy;
    if (!existsSync(src)) {
      return { ok: false, reason: "no-session", message: "no transcript recorded yet" };
    }
    // The leaf is checked no-follow below, but a linked *parent*
    // (`projects/` → outside the account) would make the leaf look like a
    // regular file inside the account. Refuse the whole chain below the
    // trusted config root.
    if (!isPlainAncestorPathUnder(fromRoot, src)) {
      return unsafeReason("the transcript path traverses a symlinked directory");
    }
    if (!isRegularFileNoFollow(src)) {
      return unsafeReason("the transcript is not a regular file (symlink or special file refused)");
    }
    try {
      const st = lstatSync(src);
      if (st.size > MAX_SESSION_BYTES) {
        return { ok: false, reason: "too-large", message: "the transcript is larger than the transfer limit" };
      }
    } catch (err) {
      return { ok: false, reason: "io", message: err instanceof Error ? err.message : String(err) };
    }
    const destDir = path.join(toRoot, "projects", source.encoded);
    const dest = path.join(destDir, `${sessionId}.jsonl`);
    // Only files this transfer CREATED go on the cleanup allowlist. A
    // pre-existing destination is the account's own file (e.g. its original
    // transcript after an A→B→A wrap): the copy still updates it, but deleting
    // it later would destroy that account's conversation (contract C5).
    const copied: string[] = [];
    try {
      const result = await copyRegularFileDetailed(src, dest, { maxBytes: MAX_SESSION_BYTES, root: toRoot });
      if (result.created) copied.push(dest);
    } catch (err) {
      return { ok: false, reason: "io", message: err instanceof Error ? err.message : String(err) };
    }

    const srcBase = isFresh ? path.join(fromRoot, "projects", source.encoded) : path.join(fromRoot, ".claude", "projects", source.encoded);
    for (const dir of SIDECAR_DIRS) {
      const sidecar = path.join(srcBase, sessionId, dir);
      // Same rule as the transcript: every folder between the config root and
      // the sidecar must be a real directory, not a plantable symlink.
      if (!isPlainAncestorPathUnder(fromRoot, sidecar) || !isPlainDir(sidecar)) continue;
      try {
        const result = await copyTreeCooperative(sidecar, path.join(destDir, sessionId, dir), {
          maxBytes: MAX_SESSION_BYTES,
          root: toRoot,
        });
        copied.push(...result.created.map((rel) => path.join(destDir, sessionId, dir, rel)));
      } catch {
        // A sidecar that cannot be copied is not fatal: the transcript is the
        // conversation; the sidecar only carries subagent/tool scratch files.
      }
    }

    harnessSessionHandoffs.upsert({
      taskId,
      harnessId: toHarness.id,
      columnName: CLAUDE_SESSION_COLUMN,
      sessionId,
      copiedPaths: copied,
      createdAt: Date.now(),
    });
    return { ok: true, sessionId, copiedPaths: copied };
  },
  async cleanup(taskId, harnessId): Promise<void> {
    const handoff = harnessSessionHandoffs.get(taskId, harnessId, CLAUDE_SESSION_COLUMN);
    if (!handoff) return;
    const harness = harnesses.getByIdOrKind(harnessId);
    if (harness) await removeCopiedPaths(handoff.copiedPaths, claudeConfigDirFor(harness), "claude-code");
    harnessSessionHandoffs.deleteOne(taskId, harnessId, CLAUDE_SESSION_COLUMN);
  },
};

/** Codex lays rollouts out as `sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl`.
 *  The walk is async and yields to the shared Bun main thread: a large
 *  `sessions/` tree must not freeze the app while a swap is in flight. */
const ROLLOUT_WALK_MAX_ENTRIES = 50_000;
const ROLLOUT_WALK_YIELD_MS = 20;

async function findCodexRollout(root: string, threadId: string): Promise<string | null> {
  const sessions = path.join(root, "sessions");
  if (!isPlainDir(sessions)) return null;
  const suffix = `-${threadId}.jsonl`;
  const stack = [sessions];
  let seen = 0;
  let lastYield = Date.now();
  while (stack.length > 0 && seen < ROLLOUT_WALK_MAX_ENTRIES) {
    const dir = stack.pop()!;
    if (!isPlainDir(dir)) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Newest first: Codex's date directories sort lexicographically, and a
    // live thread is almost always in the most recent day.
    entries.sort((a, b) => b.name.localeCompare(a.name));
    const subdirs: string[] = [];
    for (const entry of entries) {
      seen++;
      if (Date.now() - lastYield >= ROLLOUT_WALK_YIELD_MS) {
        lastYield = Date.now();
        await Bun.sleep(0);
      }
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        subdirs.push(abs);
        continue;
      }
      if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) {
        return abs;
      }
    }
    // Push in reverse so the newest directory is popped (visited) first.
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]!);
  }
  return null;
}

/** Run Codex's rollout projection migration when the destination already has
 *  a `thread_history_*.sqlite` — a stale projection can shadow a copied
 *  rollout. Best-effort: a failure is reported and the caller decides. */
async function migrateCodexRollouts(harness: Harness): Promise<string | null> {
  const root = codexHomeFor(harness);
  const hasHistory = readdirSyncSafe(root).some((n) => /^thread_history_.*\.sqlite$/.test(n));
  if (!hasHistory) return null;
  const bin = resolveBin(harness);
  try {
    const proc = coreSpawn([bin, "migrate-rollouts", "--apply"], {
      cwd: root,
      env: childEnv({ ...harnessEnvelope(harness) }),
      stdout: "pipe",
      stderr: "pipe",
    }) as Bun.Subprocess<"ignore", "pipe", "pipe">;
    const timeout = setTimeout(() => proc.kill(), 30_000);
    const code = await proc.exited;
    clearTimeout(timeout);
    if (code !== 0) return `codex migrate-rollouts exited ${code}`;
    return null;
  } catch (err) {
    return `codex migrate-rollouts could not run: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function harnessEnvelope(harness: Harness): Record<string, string> {
  // The migration must run against exactly the root the rollout was copied
  // into, which is `codexHomeFor` for every account shape: an env-map
  // CODEX_HOME, a home (`<home>/.codex`), an env-map HOME alone
  // (`<HOME>/.codex`), the process-level CODEX_HOME or the real `~/.codex`.
  // Passing it always — not only for a home or an env CODEX_HOME — keeps an
  // env-map-HOME account from migrating the user's real `~/.codex` instead
  // (review R-S11). The full spawn env builder lives in agents.ts and
  // importing it here would create a cycle.
  return { CODEX_HOME: codexHomeFor(harness) };
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** The Codex adapter: rollout copy, optional projection migration, resume by
 *  thread id. */
export const codexSessionTransfer: SessionTransferAdapter = {
  kind: "codex",
  column: CODEX_SESSION_COLUMN,
  async transfer({ taskId, fromHarness, toHarness, sessionId }): Promise<TransferResult> {
    if (fromHarness.kind !== "codex" || toHarness.kind !== "codex") {
      return { ok: false, reason: "unsupported", message: "session transfer needs two codex accounts" };
    }
    const fromRoot = codexHomeFor(fromHarness);
    const toRoot = codexHomeFor(toHarness);
    // Contract CR4, as in the Claude adapter.
    const redirected = rootsRedirectRefusal([
      [fromRoot, "the source account's CODEX_HOME"],
      [toRoot, "the destination account's CODEX_HOME"],
    ]);
    if (redirected) return unsafeReason(redirected);
    if (sameConfigRoot(fromRoot, toRoot)) {
      return { ok: false, reason: "unsafe-source", message: "source and destination share a CODEX_HOME" };
    }
    if (!isSafePathSegment(sessionId)) return unsafeReason("the thread id is not a plain file name");
    const source = await findCodexRollout(fromRoot, sessionId);
    if (!source) return { ok: false, reason: "no-session", message: "no rollout recorded yet" };
    // Defense in depth: the walk already skips symlinked entries, but the
    // recorded path must still be a real-directory chain below CODEX_HOME.
    if (!isPlainAncestorPathUnder(fromRoot, source)) {
      return unsafeReason("the rollout path traverses a symlinked directory");
    }
    if (!isRegularFileNoFollow(source)) {
      return unsafeReason("the rollout is not a regular file (symlink or special file refused)");
    }
    const rel = path.relative(fromRoot, source);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return unsafeReason("rollout path escapes CODEX_HOME");
    // Only Codex's own `sessions/YYYY/MM/DD/rollout-*.jsonl` layout is copied:
    // it is the only shape cleanup will ever remove, so a copy of any other
    // shape could never be cleaned up.
    if (!isHandoffCopyShape("codex", rel.split(path.sep).join("/"))) {
      return unsafeReason("the rollout is not in Codex's sessions/YYYY/MM/DD layout");
    }
    const dest = path.join(toRoot, rel);
    const copiedPaths: string[] = [];
    try {
      const result = await copyRegularFileDetailed(source, dest, { maxBytes: MAX_SESSION_BYTES, root: toRoot });
      // Same rule as the Claude adapter: a rollout the destination already
      // had is its own, never put on the cleanup allowlist (contract C5).
      if (result.created) copiedPaths.push(dest);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: message.includes("too large") ? "too-large" : "io", message };
    }
    const warnings: string[] = [];
    const migrationWarning = await migrateCodexRollouts(toHarness);
    if (migrationWarning) warnings.push(migrationWarning);
    harnessSessionHandoffs.upsert({
      taskId,
      harnessId: toHarness.id,
      columnName: CODEX_SESSION_COLUMN,
      sessionId,
      copiedPaths,
      createdAt: Date.now(),
    });
    // The migration warning is surfaced through the caller's status line; the
    // transfer itself succeeded because the rollout is on disk.
    return {
      ok: true,
      sessionId,
      copiedPaths,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
  async cleanup(taskId, harnessId): Promise<void> {
    const handoff = harnessSessionHandoffs.get(taskId, harnessId, CODEX_SESSION_COLUMN);
    if (!handoff) return;
    const harness = harnesses.getByIdOrKind(harnessId);
    if (harness) await removeCopiedPaths(handoff.copiedPaths, codexHomeFor(harness), "codex");
    harnessSessionHandoffs.deleteOne(taskId, harnessId, CODEX_SESSION_COLUMN);
  },
};

const ADAPTERS: SessionTransferAdapter[] = [claudeSessionTransfer, codexSessionTransfer];

/**
 * The newest provider session `harnessId` genuinely owns for this task — the
 * single implementation of the rule shared by the swap settlement
 * (`orchestrator.ts`'s `findLastSessionIdForHarness`) and the manual move
 * (`harness-failover.ts`).
 *
 * Deliberately NOT "any session the task ever recorded": after a failover the
 * newest row belongs to another account, and resuming it from a third account
 * would either fail or replay a conversation that account never had. A
 * recorded handoff for this account is the one explicit exception: the
 * conversation was copied onto it by a swap, so use it when it is newer than
 * any run this account itself recorded. A row whose `agent` is a legacy bare
 * kind is resolved through the harness lookup so the built-in kind id and the
 * built-in harness id compare equal.
 */
export function findSessionIdForHarness(
  taskId: string,
  column: SessionIdColumn,
  harnessId: string,
): string | null {
  const handoff = harnessSessionHandoffs.get(taskId, harnessId, column);
  if (handoff) {
    const own = runs.newestSessionForHarness(taskId, column, harnessId);
    if (!own || handoff.createdAt >= own.startedAt) return handoff.sessionId;
  }
  const resolved = new Map<string, string>();
  for (const row of runs.sessionIdsForTask(taskId, column)) {
    let rowHarnessId = resolved.get(row.agent);
    if (rowHarnessId === undefined) {
      rowHarnessId = harnesses.getByIdOrKind(row.agent)?.id ?? row.agent;
      resolved.set(row.agent, rowHarnessId);
    }
    if (rowHarnessId === harnessId) return row.sessionId;
  }
  return null;
}

/** The adapter for a harness kind, or null for kinds stacks don't support. */
export function sessionTransferAdapter(kind: string): SessionTransferAdapter | null {
  return ADAPTERS.find((a) => a.kind === kind) ?? null;
}

/**
 * Whether a task already had a provider conversation on `harnessId` BEFORE
 * `excludeRunId` (usually the run that just hit its limit).
 *
 * The harness-stack continuation gate is "did this account do any work?" —
 * `runs.hasToolUse` plus a recorded handoff. That alone loses the conversation
 * on a **follow-up** turn: the user's earlier turns produced the session, the
 * follow-up hits the limit before its own first tool call, and a clean retry
 * would start a fresh session with only the follow-up text. A prior run on the
 * same account proves a conversation exists, so the swap must transfer/resume
 * it instead (R11-M1). The current run is excluded so the task's very first
 * turn (no tool call, only its own freshly-minted session id) still takes the
 * documented clean retry.
 */
export function hasPriorSessionForHarness(
  taskId: string,
  column: SessionIdColumn,
  harnessId: string,
  excludeRunId: string,
): boolean {
  const resolved = new Map<string, string>();
  for (const row of runs.sessionIdsForTask(taskId, column, { excludeRunId })) {
    let rowHarnessId = resolved.get(row.agent);
    if (rowHarnessId === undefined) {
      rowHarnessId = harnesses.getByIdOrKind(row.agent)?.id ?? row.agent;
      resolved.set(row.agent, rowHarnessId);
    }
    if (rowHarnessId === harnessId) return true;
  }
  return false;
}

/**
 * A harness's copied handoff files, captured while the harness row still
 * resolves their config root. Read-only: nothing on disk or in the DB changes
 * until {@link removeHarnessSessionCopies} is called, which lets a caller
 * capture first, delete the row, then unlink — so a refused delete (409,
 * built-in) leaves a live task's conversation intact (review R13-S2).
 */
export interface HarnessSessionCopies {
  kind: HarnessStackKind;
  root: string;
  paths: readonly string[];
}

/** Capture (never remove) the copied files a harness owns as a handoff
 *  DESTINATION. Empty for a missing harness or an account with no handoffs. */
export function collectHarnessSessionCopies(harnessId: string): HarnessSessionCopies[] {
  const harness = harnesses.getByIdOrKind(harnessId);
  if (!harness) return [];
  return harnessSessionHandoffs.listForHarness(harnessId).map((handoff) => {
    const codex = handoff.columnName === CODEX_SESSION_COLUMN;
    return {
      kind: codex ? "codex" : "claude-code",
      root: codex ? codexHomeFor(harness) : claudeConfigDirFor(harness),
      paths: handoff.copiedPaths,
    };
  });
}

/** Remove copies captured by {@link collectHarnessSessionCopies}. Only regular
 *  files recorded in the handoff allowlist, inside `root` and of a handoff
 *  shape are unlinked (`removeCopiedPaths`). Cooperative and never rejects, so
 *  a caller may also fire it without awaiting. */
export async function removeHarnessSessionCopies(copies: readonly HarnessSessionCopies[]): Promise<void> {
  for (const copy of copies) {
    try {
      await removeCopiedPaths(copy.paths, copy.root, copy.kind);
    } catch (err) {
      console.warn("[harness-stacks] removing handoff copies failed:", err);
    }
  }
}

/**
 * Remove every copied session file belonging to a task, across all its
 * handoffs. A missing destination harness still drops the row (there is
 * nothing left to resume); a path outside the destination root is ignored.
 */
export async function cleanupHarnessSessionCopies(taskId: string): Promise<void> {
  const handoffs = harnessSessionHandoffs.listForTask(taskId);
  for (const handoff of handoffs) {
    const adapter = sessionTransferAdapter(handoff.columnName === CODEX_SESSION_COLUMN ? "codex" : "claude-code");
    const harness = harnesses.getByIdOrKind(handoff.harnessId);
    if (adapter) await adapter.cleanup(taskId, handoff.harnessId);
    else if (!harness) harnessSessionHandoffs.deleteOne(taskId, handoff.harnessId, handoff.columnName);
  }
}


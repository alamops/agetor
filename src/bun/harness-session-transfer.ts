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
 * copies are atomic and 0600, and a symlink/FIFO transcript is refused rather
 * than followed, and no transcript is ever refused for its size. A config root that now resolves (through a
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
import { lstatSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { encodeProjectPath } from "./claude-tmux.ts";
import {
  harnesses,
  harnessOrphanedCopies,
  harnessSessionHandoffs,
  runs,
  type HarnessSessionHandoff,
  type SessionIdColumn,
} from "./db.ts";
import {
  copyRegularFileDetailed,
  copyTreeCooperative,
  isPlainAncestorPathUnder,
  isPlainDir,
  isRegularFileNoFollow,
  destinationState,
  planTreeDestinations,
  removeCopiedPathsDetailed,
  rootsRedirectRefusal,
  sameConfigRoot,
} from "./harness-file-transfer.ts";
import { claudeConfigDirFor, codexHomeFor } from "./harness-config-root.ts";
import {
  CLAUDE_SESSION_SIDECAR_DIRS,
  handoffCopySessionIdFromPath,
  isHandoffCopyShape,
  isSafePathSegment,
} from "../shared/harness-mirror.ts";
import type { Harness, HarnessStackKind } from "../shared/types.ts";
import { resolveBin } from "./agents.ts";
import { childEnv, coreSpawn } from "./core-spawn.ts";

export const CLAUDE_SESSION_COLUMN = "claude_session_id" as const satisfies SessionIdColumn;
export const CODEX_SESSION_COLUMN = "codex_session_id" as const satisfies SessionIdColumn;

/** A transcript or rollout is never refused for its size: dropping the
 *  conversation to stay under a cap loses exactly what the swap exists to
 *  keep. The copy streams in 1 MB async chunks, so a huge file still yields to
 *  the shared main thread between chunks. */
const NO_SIZE_LIMIT = Number.POSITIVE_INFINITY;
/** Entry budget for a sidecar tree (`subagents`, `tool-results`, `mcp-tasks`,
 *  `file-history/<sid>`); the walk is cooperative. Reaching it is reported as
 *  a transfer warning, never silently. */
const SIDECAR_MAX_ENTRIES = 50_000;
/** Directories examined while looking for a transcript by session id. */
const PROJECTS_SCAN_MAX_ENTRIES = 50_000;
const YIELD_EVERY_MS = 20;
/** Longest encoded project dir name Claude uses verbatim (longer ones are hashed). */
const MAX_PLAIN_PROJECT_DIR_NAME = 200;
const SIDECAR_DIRS = CLAUDE_SESSION_SIDECAR_DIRS;

export type TransferResult =
  | {
      ok: true;
      sessionId: string;
      copiedPaths: string[];
      /** Non-fatal problems (a sidecar or `/rewind` checkpoint tree that could
       *  not be copied in full, Codex's rollout projection migration). The
       *  transfer succeeded; callers surface these as status lines / logs
       *  instead of dropping them. */
      warnings?: string[];
    }
  | {
      ok: false;
      reason: "no-session" | "unsafe-source" | "io" | "unsupported";
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
  /** Remove this adapter's recorded copies for one task/account pair. Resolves
   *  to warnings (copies that could not be removed yet and were kept on the
   *  row); never rejects for a path problem. */
  cleanup(taskId: string, harnessId: string): Promise<string[]>;
}

function unsafeReason(message: string): TransferResult {
  return { ok: false, reason: "unsafe-source", message };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type LocatedTranscript =
  | { kind: "found"; src: string; projectDirName: string; legacy: boolean }
  | { kind: "none" }
  | { kind: "unsafe"; message: string };

/** `lstat` of a leaf whose ancestors were already verified plain. */
function leafKind(p: string): "file" | "missing" | "other" {
  try {
    return lstatSync(p).isFile() ? "file" : "other";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "other";
  }
}

/**
 * Find the source transcript `<root>/projects/<project dir>/<sid>.jsonl`
 * (or the legacy `<root>/.claude/projects/…`). The encoded cwd names the
 * project dir when it is short enough; Claude hashes longer names in a way
 * `encodeProjectPath` cannot reproduce, so a miss falls back to scanning the
 * project dirs for the session id (a UUID, unique across projects).
 *
 * Nothing is stat'ed before the chain of directories between the trusted
 * config root and it has been `lstat`-checked: a `projects` swapped for a
 * symlink into a protected folder must not be followed even to ask whether
 * the transcript exists.
 */
async function locateClaudeTranscript(root: string, cwd: string, sessionId: string): Promise<LocatedTranscript> {
  const encoded = encodeProjectPath(cwd);
  const bases = [
    { dir: path.join(root, "projects"), legacy: false },
    { dir: path.join(root, ".claude", "projects"), legacy: true },
  ];
  // Claude cuts an encoded name over 200 characters and appends a hash this
  // function cannot reproduce; that name is not a usable path component, so
  // such a cwd goes straight to the scan below.
  for (const base of encoded.length > MAX_PLAIN_PROJECT_DIR_NAME ? [] : bases) {
    const candidate = path.join(base.dir, encoded, `${sessionId}.jsonl`);
    if (!isPlainAncestorPathUnder(root, candidate)) {
      return { kind: "unsafe", message: "the transcript path traverses a symlinked directory" };
    }
    const leaf = leafKind(candidate);
    if (leaf === "file") return { kind: "found", src: candidate, projectDirName: encoded, legacy: base.legacy };
    if (leaf === "other") {
      return { kind: "unsafe", message: "the transcript is not a regular file (symlink or special file refused)" };
    }
  }
  let seen = 0;
  let lastYield = Date.now();
  for (const base of bases) {
    // The ancestors of `<base>/x` are the base's own components.
    if (!isPlainAncestorPathUnder(root, path.join(base.dir, "x")) || !isPlainDir(base.dir)) continue;
    let entries;
    try {
      entries = await readdir(base.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++seen > PROJECTS_SCAN_MAX_ENTRIES) return { kind: "none" };
      if (Date.now() - lastYield >= YIELD_EVERY_MS) {
        lastYield = Date.now();
        await Bun.sleep(0);
      }
      // A Dirent is not followed: a symlinked project dir reports neither
      // directory nor file here.
      if (!entry.isDirectory() || !isSafePathSegment(entry.name)) continue;
      const candidate = path.join(base.dir, entry.name, `${sessionId}.jsonl`);
      if (leafKind(candidate) === "file") {
        return { kind: "found", src: candidate, projectDirName: entry.name, legacy: base.legacy };
      }
    }
  }
  return { kind: "none" };
}

/** A tree to carry beside the transcript: where it is and where it goes. */
interface SessionTree {
  label: string;
  src: string;
  dest: string;
}

/** The directories to copy alongside a Claude transcript, keeping only those
 *  whose every ancestor below the config root is a real directory. */
function claudeSessionTrees(
  fromRoot: string,
  toRoot: string,
  located: { src: string; projectDirName: string; legacy: boolean },
  sessionId: string,
): SessionTree[] {
  const srcProject = path.dirname(located.src);
  const destProject = path.join(toRoot, "projects", located.projectDirName);
  const candidates: SessionTree[] = SIDECAR_DIRS.map((dir) => ({
    label: dir,
    src: path.join(srcProject, sessionId, dir),
    dest: path.join(destProject, sessionId, dir),
  }));
  // `/rewind` checkpoints: `<root>/file-history/<sid>/<hash>@vN`. Only this
  // session's folder moves; the mirror never copies `file-history` as a whole.
  const historyBase = located.legacy ? path.join(fromRoot, ".claude", "file-history") : path.join(fromRoot, "file-history");
  candidates.push({
    label: "file-history",
    src: path.join(historyBase, sessionId),
    dest: path.join(toRoot, "file-history", sessionId),
  });
  // Same rule as the transcript: every folder between the config root and the
  // tree must be a real directory, not a plantable symlink.
  return candidates.filter((t) => isPlainAncestorPathUnder(fromRoot, t.src) && isPlainDir(t.src));
}

/** Keep a handoff row's session id and timestamp as they were, after a failed
 *  attempt wrote the intended paths into it. */
function restoreHandoff(
  prior: HarnessSessionHandoff | null,
  taskId: string,
  harnessId: string,
  column: SessionIdColumn,
): void {
  // Whatever the failed copy created is recorded under the new session; it
  // moves to the orphan store (re-key or abandon) so a sweep can remove it,
  // and the previous session's row comes back whole, its paths reclaimed from
  // the orphan store.
  if (!prior) {
    harnessSessionHandoffs.abandon(taskId, harnessId, column);
    return;
  }
  harnessSessionHandoffs.upsert(prior);
}

/**
 * Record the files a transfer is ABOUT to create, before copying them. A
 * crash between the copy and the final row would otherwise leave files no row
 * names, and the boot re-run would see the destination existing and never
 * record it. `upsert` merges `copiedPaths`, and a path recorded but never
 * created is harmless (cleanup skips a missing file). The session id is
 * recorded with a zero timestamp on a new row so the resume lookup prefers any
 * run the account really made until the final upsert stamps the real time.
 */
function recordIntended(
  taskId: string,
  harnessId: string,
  column: SessionIdColumn,
  sessionId: string,
  prior: HarnessSessionHandoff | null,
  intended: readonly string[],
): void {
  if (intended.length === 0) return;
  harnessSessionHandoffs.upsert({
    taskId,
    harnessId,
    columnName: column,
    sessionId,
    copiedPaths: [...intended],
    createdAt: prior && prior.sessionId === sessionId ? prior.createdAt : 0,
  });
}

/** A different session's copies are superseded by a successful transfer. The
 *  re-key moved them to the orphan store under the OLD session id (the row can
 *  name one session only), and they are removed only AFTER the new copy
 *  succeeded and the row was re-keyed: a failed transfer must leave the old
 *  conversation intact. Copies that cannot be removed now stay in the orphan
 *  store, so a later sweep retries them. */
async function dropSupersededCopies(
  prior: HarnessSessionHandoff | null,
  sessionId: string,
  harnessId: string,
  column: SessionIdColumn,
  warnings: string[],
): Promise<void> {
  if (!prior || prior.sessionId === sessionId) return;
  const left = await sweepOrphanedHandoffCopies({ harnessId, columnName: column, sessionId: prior.sessionId });
  if (left.retained > 0) {
    warnings.push(`${left.retained} copied file(s) of the superseded session ${prior.sessionId} could not be removed yet; they are kept on record and retried later`);
  }
}

/** The Claude adapter: transcript + `/rewind` checkpoints + the sidecar dirs. */
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
    // Ancestors are lstat-checked before any leaf is stat'ed (see
    // `locateClaudeTranscript`); the leaf is checked no-follow again at open.
    const located = await locateClaudeTranscript(fromRoot, cwd, sessionId);
    if (located.kind === "unsafe") return unsafeReason(located.message);
    if (located.kind === "none") return { ok: false, reason: "no-session", message: "no transcript recorded yet" };
    const src = located.src;
    if (!isRegularFileNoFollow(src)) {
      return unsafeReason("the transcript is not a regular file (symlink or special file refused)");
    }
    // The destination's Claude derives the same project dir name from the same
    // cwd, so the directory name found on the source is reused verbatim.
    const dest = path.join(toRoot, "projects", located.projectDirName, `${sessionId}.jsonl`);
    const trees = claudeSessionTrees(fromRoot, toRoot, located, sessionId);

    const warnings: string[] = [];
    const prior = harnessSessionHandoffs.get(taskId, toHarness.id, CLAUDE_SESSION_COLUMN);
    // Only files this transfer will CREATE go on the cleanup allowlist. A
    // pre-existing destination is the account's own file (e.g. its original
    // transcript after an A→B→A wrap): the copy still updates it, but deleting
    // it later would destroy that account's conversation (contract C5).
    const intended: string[] = [];
    const destState = destinationState(toRoot, dest);
    if (destState === "unsafe") return unsafeReason("the destination path traverses a symlinked directory");
    if (destState === "absent") intended.push(dest);
    for (const tree of trees) {
      try {
        intended.push(...(await planTreeDestinations(tree.src, tree.dest, { maxEntries: SIDECAR_MAX_ENTRIES, root: toRoot })));
      } catch (err) {
        warnings.push(`${tree.label}: could not be scanned (${errMessage(err)})`);
      }
    }
    recordIntended(taskId, toHarness.id, CLAUDE_SESSION_COLUMN, sessionId, prior, intended);

    const copied: string[] = [];
    try {
      const result = await copyRegularFileDetailed(src, dest, { maxBytes: NO_SIZE_LIMIT, root: toRoot });
      if (result.created) copied.push(dest);
    } catch (err) {
      if (intended.length > 0) {
        restoreHandoff(prior, taskId, toHarness.id, CLAUDE_SESSION_COLUMN);
        await sweepOrphanedHandoffCopies({ harnessId: toHarness.id, columnName: CLAUDE_SESSION_COLUMN, sessionId });
      }
      return { ok: false, reason: "io", message: errMessage(err) };
    }

    // The transcript is the conversation; a tree that cannot be copied in full
    // is reported as a warning instead of failing the transfer or vanishing.
    for (const tree of trees) {
      try {
        const result = await copyTreeCooperative(tree.src, tree.dest, {
          maxBytes: NO_SIZE_LIMIT,
          maxEntries: SIDECAR_MAX_ENTRIES,
          root: toRoot,
        });
        copied.push(...result.created.map((rel) => path.join(tree.dest, rel)));
        if (result.truncated) {
          warnings.push(`${tree.label}: stopped at the ${SIDECAR_MAX_ENTRIES}-entry limit; some files were not transferred`);
        }
        if (result.skipped.length > 0) {
          warnings.push(`${tree.label}: ${result.skipped.length} entries were skipped (links, special files or files that vanished)`);
        }
      } catch (err) {
        warnings.push(`${tree.label}: not transferred (${errMessage(err)})`);
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
    await dropSupersededCopies(prior, sessionId, toHarness.id, CLAUDE_SESSION_COLUMN, warnings);
    return { ok: true, sessionId, copiedPaths: copied, ...(warnings.length > 0 ? { warnings } : {}) };
  },
  async cleanup(taskId, harnessId): Promise<string[]> {
    return cleanupHandoff(taskId, harnessId, CLAUDE_SESSION_COLUMN, "claude-code", claudeConfigDirFor);
  },
};

/**
 * Remove one handoff's copies and then its row. The row goes only once every
 * recorded path is unlinked or confirmed gone (or rejected as never ours): a
 * path outside the account's CURRENT root (its `home` was changed after the
 * copy), a refused root or a failed unlink keeps the row, so a later cleanup
 * can still remove the file, and returns a warning. A harness that no longer
 * exists has nothing to resume, so its row is dropped.
 */
async function cleanupHandoff(
  taskId: string,
  harnessId: string,
  column: SessionIdColumn,
  kind: HarnessStackKind,
  rootFor: (harness: Harness) => string,
): Promise<string[]> {
  const handoff = harnessSessionHandoffs.get(taskId, harnessId, column);
  if (!handoff) return [];
  const harness = harnesses.getByIdOrKind(harnessId);
  if (!harness) {
    harnessSessionHandoffs.deleteOne(taskId, harnessId, column);
    return [];
  }
  const result = await removeCopiedPathsDetailed(handoff.copiedPaths, rootFor(harness), kind, handoff.sessionId);
  if (result.retained.length > 0) {
    return [
      `${result.retained.length} copied session file(s) for task ${taskId} were left in place (account ${harnessId}: its config directory changed or a file could not be removed); the record is kept so a later cleanup can remove them`,
    ];
  }
  harnessSessionHandoffs.deleteOne(taskId, harnessId, column);
  return [];
}

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
    if (!isHandoffCopyShape("codex", rel.split(path.sep).join("/"), sessionId)) {
      return unsafeReason("the rollout is not in Codex's sessions/YYYY/MM/DD layout");
    }
    const dest = path.join(toRoot, rel);
    const prior = harnessSessionHandoffs.get(taskId, toHarness.id, CODEX_SESSION_COLUMN);
    // Same rules as the Claude adapter: a rollout the destination already had
    // is its own, never put on the cleanup allowlist (contract C5), and the
    // new path is recorded BEFORE it is created.
    const destState = destinationState(toRoot, dest);
    if (destState === "unsafe") return unsafeReason("the destination path traverses a symlinked directory");
    const intended = destState === "absent" ? [dest] : [];
    recordIntended(taskId, toHarness.id, CODEX_SESSION_COLUMN, sessionId, prior, intended);
    const copiedPaths: string[] = [];
    try {
      const result = await copyRegularFileDetailed(source, dest, { maxBytes: NO_SIZE_LIMIT, root: toRoot });
      if (result.created) copiedPaths.push(dest);
    } catch (err) {
      if (intended.length > 0) {
        restoreHandoff(prior, taskId, toHarness.id, CODEX_SESSION_COLUMN);
        await sweepOrphanedHandoffCopies({ harnessId: toHarness.id, columnName: CODEX_SESSION_COLUMN, sessionId });
      }
      return { ok: false, reason: "io", message: errMessage(err) };
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
    await dropSupersededCopies(prior, sessionId, toHarness.id, CODEX_SESSION_COLUMN, warnings);
    // The migration warning is surfaced through the caller's status line; the
    // transfer itself succeeded because the rollout is on disk.
    return {
      ok: true,
      sessionId,
      copiedPaths,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
  async cleanup(taskId, harnessId): Promise<string[]> {
    return cleanupHandoff(taskId, harnessId, CODEX_SESSION_COLUMN, "codex", codexHomeFor);
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
  // A row stamped 0 is a pre-recorded intent whose copy never completed (the
  // final upsert stamps the real time): never resume it.
  if (handoff && handoff.createdAt > 0) {
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
  /** The handoff's recorded session id: every path must name it. */
  sessionId: string;
  paths: readonly string[];
}

/** Capture (never remove) the copied files a harness owns as a handoff
 *  DESTINATION. Empty for a missing harness or an account with no handoffs. */
export function collectHarnessSessionCopies(harnessId: string): HarnessSessionCopies[] {
  const harness = harnesses.getByIdOrKind(harnessId);
  if (!harness) return [];
  const toCopies = (column: SessionIdColumn, sessionId: string, paths: readonly string[]): HarnessSessionCopies => {
    const codex = column === CODEX_SESSION_COLUMN;
    return {
      kind: codex ? "codex" : "claude-code",
      root: codex ? codexHomeFor(harness) : claudeConfigDirFor(harness),
      sessionId,
      paths,
    };
  };
  // The orphaned copies (migration 088) are this account's files too.
  const orphans = groupOrphans(harnessOrphanedCopies.list({ harnessId: harness.id }));
  return [
    ...harnessSessionHandoffs.listForHarness(harnessId).map((h) => toCopies(h.columnName, h.sessionId, h.copiedPaths)),
    ...orphans.map((g) => toCopies(g.columnName, g.sessionId, g.paths)),
  ];
}

/** Remove copies captured by {@link collectHarnessSessionCopies}. Only regular
 *  files recorded in the handoff allowlist, inside `root` and of a handoff
 *  shape are unlinked (`removeCopiedPaths`). Cooperative and never rejects, so
 *  a caller may also fire it without awaiting. */
export async function removeHarnessSessionCopies(copies: readonly HarnessSessionCopies[]): Promise<void> {
  for (const copy of copies) {
    try {
      await removeCopiedPathsDetailed(copy.paths, copy.root, copy.kind, copy.sessionId);
    } catch (err) {
      console.warn("[harness-stacks] removing handoff copies failed:", err);
    }
  }
}

/**
 * Remove every copied session file belonging to a task, across all its
 * handoffs. A missing destination harness still drops the row (there is
 * nothing left to resume). A row whose files could not all be removed (the
 * account's root changed, say) is kept, and the returned warnings say so.
 */
export async function cleanupHarnessSessionCopies(taskId: string): Promise<string[]> {
  const warnings: string[] = [];
  for (const handoff of harnessSessionHandoffs.listForTask(taskId)) {
    const adapter = sessionTransferAdapter(handoff.columnName === CODEX_SESSION_COLUMN ? "codex" : "claude-code");
    const harness = harnesses.getByIdOrKind(handoff.harnessId);
    if (adapter) warnings.push(...(await adapter.cleanup(taskId, handoff.harnessId)));
    else if (!harness) harnessSessionHandoffs.deleteOne(taskId, handoff.harnessId, handoff.columnName);
  }
  for (const warning of warnings) console.warn(`[harness-stacks] ${warning}`);
  return warnings;
}


// ---------------------------------------------------------------------------
// Orphaned handoff copies (migration 088)
// ---------------------------------------------------------------------------

interface OrphanGroup {
  harnessId: string;
  columnName: SessionIdColumn;
  sessionId: string;
  paths: string[];
}

function groupOrphans(rows: readonly { harnessId: string; columnName: SessionIdColumn; sessionId: string; path: string }[]): OrphanGroup[] {
  const groups = new Map<string, OrphanGroup>();
  for (const row of rows) {
    const key = `${row.harnessId}\u0000${row.columnName}\u0000${row.sessionId}`;
    let group = groups.get(key);
    if (!group) {
      group = { harnessId: row.harnessId, columnName: row.columnName, sessionId: row.sessionId, paths: [] };
      groups.set(key, group);
    }
    group.paths.push(row.path);
  }
  return [...groups.values()];
}

/** What a sweep did: files unlinked, records dropped (gone, or never ours),
 *  and files still kept on record for a later retry. */
export interface OrphanSweepResult {
  removed: number;
  forgotten: number;
  retained: number;
}

let sweepChain: Promise<unknown> = Promise.resolve();

/**
 * Remove orphaned handoff copies, optionally only one account's, column's or
 * session's. Each path is removed under exactly the handoff cleanup rules
 * ({@link removeCopiedPathsDetailed}: inside the account's CURRENT root, of a
 * handoff shape naming the path's own session, a real path, a regular file).
 * A record is dropped once its file is removed or gone, or rejected as never
 * ours; one that may still be ours (the root changed, the unlink failed) is
 * kept for the next sweep. An account that no longer exists has no root to
 * resolve against, so its records are dropped, as for a handoff row. A session
 * that is live again on a handoff row of the same account is skipped: its
 * files belong to a conversation that can still be resumed.
 *
 * Sweeps are serialized, so two never race on one file. Cooperative (the
 * removal yields every ~20 ms) and never rejects.
 */
export function sweepOrphanedHandoffCopies(
  filter: { harnessId?: string; columnName?: SessionIdColumn; sessionId?: string } = {},
): Promise<OrphanSweepResult> {
  const run = sweepChain.then(
    () => sweepOnce(filter),
    () => sweepOnce(filter),
  );
  sweepChain = run.catch(() => {});
  return run.catch((err) => {
    console.warn("[harness-stacks] sweeping orphaned handoff copies failed:", err);
    return { removed: 0, forgotten: 0, retained: 0 };
  });
}

async function sweepOnce(
  filter: { harnessId?: string; columnName?: SessionIdColumn; sessionId?: string },
): Promise<OrphanSweepResult> {
  const out: OrphanSweepResult = { removed: 0, forgotten: 0, retained: 0 };
  const rows = harnessOrphanedCopies
    .list(filter.harnessId !== undefined ? { harnessId: filter.harnessId } : {})
    .filter((r) => (filter.columnName === undefined || r.columnName === filter.columnName)
      && (filter.sessionId === undefined || r.sessionId === filter.sessionId));
  for (const group of groupOrphans(rows)) {
    const harness = harnesses.getByIdOrKind(group.harnessId);
    if (!harness) {
      harnessOrphanedCopies.forget(group.harnessId, group.columnName, group.sessionId, group.paths);
      out.forgotten += group.paths.length;
      continue;
    }
    if (harnessSessionHandoffs.hasLiveSession(group.harnessId, group.columnName, group.sessionId)) {
      out.retained += group.paths.length;
      continue;
    }
    const codex = group.columnName === CODEX_SESSION_COLUMN;
    const result = await removeCopiedPathsDetailed(
      group.paths,
      codex ? codexHomeFor(harness) : claudeConfigDirFor(harness),
      codex ? "codex" : "claude-code",
      group.sessionId,
    );
    const keep = new Set(result.retained);
    const done = group.paths.filter((p) => !keep.has(p));
    harnessOrphanedCopies.forget(group.harnessId, group.columnName, group.sessionId, done);
    out.removed += result.removed.length;
    out.forgotten += done.length - result.removed.length;
    out.retained += keep.size;
  }
  return out;
}

/**
 * Boot normalization for rows written before migration 088: a handoff row
 * re-keyed to a newer session could still list the old session's copies,
 * which its cleanup always rejected (the shape names another session). Each
 * such path whose own session can be read from it moves to the orphan store
 * under that session. Idempotent; a path whose session cannot be read stays.
 */
export function adoptMismatchedHandoffPaths(): number {
  let moved = 0;
  for (const row of harnessSessionHandoffs.listAll()) {
    const kind: HarnessStackKind = row.columnName === CODEX_SESSION_COLUMN ? "codex" : "claude-code";
    const keep: string[] = [];
    const bySession = new Map<string, string[]>();
    for (const p of row.copiedPaths) {
      const sid = handoffCopySessionIdFromPath(kind, path.resolve(p), row.sessionId);
      if (sid !== null && sid !== row.sessionId) {
        const list = bySession.get(sid) ?? [];
        list.push(p);
        bySession.set(sid, list);
      } else {
        keep.push(p);
      }
    }
    if (bySession.size === 0) continue;
    for (const [sid, paths] of bySession) {
      harnessOrphanedCopies.add(row.harnessId, row.columnName, sid, paths);
      moved += paths.length;
    }
    harnessSessionHandoffs.setPaths(row.taskId, row.harnessId, row.columnName, keep);
  }
  return moved;
}

/** The boot pass: normalize old rows, then sweep every orphaned copy. Fired
 *  without awaiting by `reconcileOrphans`; never rejects. */
export async function sweepOrphanedHandoffCopiesAtBoot(): Promise<void> {
  try {
    const adopted = adoptMismatchedHandoffPaths();
    const result = await sweepOrphanedHandoffCopies();
    if (adopted > 0 || result.removed > 0 || result.retained > 0) {
      console.log(
        `[harness-stacks] orphaned handoff copies: ${adopted} adopted from re-keyed rows, ${result.removed} removed, ${result.retained} kept for a later retry`,
      );
    }
  } catch (err) {
    console.warn("[harness-stacks] boot sweep of orphaned handoff copies failed:", err);
  }
}

// Pure helpers behind the multi-repository webview surfaces (issue #291):
// the Select Projects dialog's git-root merge, board search, the delete
// confirm, the open-folder guard and the run panel's "Create all PRs"
// in-flight registry. Kept free of React and `api` so each rule is
// unit-testable without a DOM harness.
// Contract: docs/architecture/multi-repo-tasks.md.
import type { Task, TaskRepository } from "../../shared/types.ts";
import type { RepoSelection } from "./repo-selection.ts";
import { isMultiRepoTask } from "../../shared/multi-repo.ts";

/** Trimmed base ref, or null when unset/blank (blank means "HEAD"). */
function refOf(entry: Pick<RepoSelection, "baseRef">): string | null {
  const ref = entry.baseRef?.trim();
  return ref ? ref : null;
}

// ── Git-root merge in the Select Projects dialog ───────────────────────────

export interface RootMerge {
  /** The kept (first selected) path for the root. */
  path: string;
  /** The paths that collapsed into it. */
  merged: string[];
}

export interface RootConflict {
  /** Every entry of the root that carries a base ref, in selection order. */
  entries: { path: string; baseRef: string }[];
}

/**
 * Collapses entries that share a resolved git root to the first selected
 * path (the server's `createTask` dedupe), but never silently drops a base
 * ref: when the kept entry has none, it takes the one set on a collapsed
 * duplicate. Two different base refs on one root can't both apply, so they
 * are returned as a conflict for the dialog to show instead of saving.
 * Entries with an unknown root are always kept (see `dedupeSelections`).
 */
export function mergeSelectionsByRoot(entries: readonly RepoSelection[]): {
  kept: RepoSelection[];
  merges: RootMerge[];
  conflicts: RootConflict[];
} {
  const kept: RepoSelection[] = [];
  const byRoot = new Map<string, { index: number; members: RepoSelection[] }>();
  for (const entry of entries) {
    if (!entry.root) {
      kept.push(entry);
      continue;
    }
    const group = byRoot.get(entry.root);
    if (group) {
      group.members.push(entry);
      continue;
    }
    byRoot.set(entry.root, { index: kept.length, members: [entry] });
    kept.push(entry);
  }
  const merges: RootMerge[] = [];
  const conflicts: RootConflict[] = [];
  for (const { index, members } of byRoot.values()) {
    if (members.length < 2) continue;
    const head = members[0]!;
    merges.push({ path: head.path, merged: members.slice(1).map((m) => m.path) });
    const withRef = members
      .map((m) => ({ path: m.path, baseRef: refOf(m) }))
      .filter((m): m is { path: string; baseRef: string } => m.baseRef !== null);
    if (new Set(withRef.map((m) => m.baseRef)).size > 1) {
      conflicts.push({ entries: withRef });
      continue;
    }
    if (refOf(head) === null && withRef.length > 0) {
      kept[index] = { ...head, baseRef: withRef[0]!.baseRef };
    }
  }
  return { kept, merges, conflicts };
}

/** One sentence naming a base-ref conflict, for the dialog's error line. */
export function describeRootConflict(conflict: RootConflict): string {
  const parts = conflict.entries.map((e) => `${e.path} (${e.baseRef})`);
  return `${parts.join(" and ")} are in the same repository but have different base refs. Remove one, or close and keep one base ref in the Branch rows.`;
}

// ── Select Projects dialog: abandoning a save ──────────────────────────────

/**
 * A request-id guard: `begin()` hands out a token, `invalidate()` (on close,
 * cancel or reopen) makes every outstanding token stale, and `isCurrent`
 * tells an awaited continuation whether it may still apply its result.
 */
export function createSessionGuard(): {
  begin: () => number;
  invalidate: () => void;
  isCurrent: (token: number) => boolean;
} {
  let current = 0;
  return {
    begin: () => ++current,
    invalidate: () => {
      current += 1;
    },
    isCurrent: (token) => token === current,
  };
}

// ── Board search ───────────────────────────────────────────────────────────

/**
 * The lowercase text the board search matches against. A multi-repository
 * task has no scalar `branch` (it is null by design), so its repositories'
 * pinned and last-seen checkout branches are folded in too; without them no
 * branch name could ever find the card. A single task's text is unchanged
 * (its derived entry's branch is already `task.branch`).
 */
export function taskSearchText(
  t: Pick<Task, "title" | "prompt" | "workdir" | "branch"> & {
    repositories?: readonly TaskRepository[];
    multiRepo?: boolean;
  },
): string {
  const repos = t.repositories ?? [];
  const multi = isMultiRepoTask(t);
  const repoHay = repos
    .map((r) => (multi
      ? [r.name, r.path, r.branch ?? "", r.checkoutBranch ?? ""].join(" ")
      : `${r.name} ${r.path}`))
    .join("\n");
  return `${t.title}\n${t.prompt}\n${t.workdir}\n${t.branch ?? ""}\n${repoHay}`.toLowerCase();
}

/**
 * "1 repository" / "3 repositories" — a multi-repository task can be left
 * with one repository after a removal, and "1 repositories" read as a bug.
 */
export function repositoryCountLabel(count: number): string {
  return `${count} ${count === 1 ? "repository" : "repositories"}`;
}

// ── Delete confirm fallback ────────────────────────────────────────────────

/**
 * The delete confirm's fallback text for a multi-repository task when the
 * teardown preview is unavailable: each repository's own branch (a multi row
 * has no scalar `branch`, so the single-repository text rendered an empty
 * `()`), plus any branch a repository's checkout last drifted onto.
 */
export function multiRepoDeleteFallback(repos: readonly TaskRepository[]): {
  branches: string | null;
  maybeDrifted: string | null;
} {
  const branches = repos
    .filter((r) => r.branch)
    .map((r) => `${r.name}: ${r.branch}`);
  const drifted = repos
    .filter((r) => r.checkoutBranch && r.checkoutBranch !== r.branch)
    .map((r) => `${r.name}: ${r.checkoutBranch}`);
  return {
    branches: branches.length > 0 ? branches.join(", ") : null,
    maybeDrifted: drifted.length > 0 ? drifted.join(", ") : null,
  };
}

// ── Open folder ────────────────────────────────────────────────────────────

/**
 * Why "Open in Finder" / the panel's working-folder button can't open this
 * task's folder, or null when it can. A multi-repository task's `workdir` is
 * its per-task workspace, which is only created when the task first runs
 * (`worktreePath` stays null until then), so opening it 404s. Single tasks
 * always return null — their behavior is unchanged.
 */
export function openFolderUnavailableReason(
  t: Pick<Task, "worktreePath"> & { repositories?: readonly unknown[]; multiRepo?: boolean },
): string | null {
  if (!isMultiRepoTask(t)) return null;
  if (t.worktreePath) return null;
  return "The workspace folder is created when the task first runs. Start the task to open it.";
}

// ── Repository tab selection (run panel, diff dialog) ─────────────────────

/**
 * The repository tab a multi-repository surface should show: the current
 * selection while that repository is still on the task, else the first one
 * (a removal can take the selected repository away), or null for a
 * single-repository task — which has no tabs, even though its derived
 * `repositories` carries one entry.
 */
export function selectedRepositoryName(
  task: { multiRepo?: boolean; repositories?: readonly { name: string }[] },
  current: string | null | undefined,
): string | null {
  if (!isMultiRepoTask(task)) return null;
  const repos = task.repositories ?? [];
  if (current && repos.some((r) => r.name === current)) return current;
  return repos[0]?.name ?? null;
}

// ── Run panel: Resolve Conflicts confirmation ──────────────────────────────

/**
 * The key a "Resolve Conflicts — Sent to agent" confirmation belongs to: the
 * repository tab it was sent from (a multi task has one PR per repository),
 * or "" for a single-repository task. The confirmation (and its lockout) only
 * applies while the same key is showing.
 */
export function resolveConflictsKey(multiRepo: boolean, activeRepoName: string | null | undefined): string {
  return multiRepo ? `repo:${activeRepoName ?? ""}` : "";
}

// ── Run panel: "Create all PRs" in-flight registry ─────────────────────────
//
// Module-level because `RunPanelBody` is one long-lived instance whose local
// state is reset on every task switch (docs/architecture/run-panel.md): a
// per-panel busy flag let a switch away and back (or a press before the next
// 2 s poll stamped `prUrl`) start a second walk that re-targeted repositories
// the first one had just opened PRs for, and GitHub's 422 showed as a failure.

const runningBatches = new Set<string>();
const stampedByBatch = new Map<string, Set<string>>();
const batchListeners = new Set<() => void>();

function notifyBatches(): void {
  for (const listener of batchListeners) listener();
}

/** `useSyncExternalStore` subscribe for {@link isPrBatchRunning}. */
export function subscribePrBatches(listener: () => void): () => void {
  batchListeners.add(listener);
  return () => {
    batchListeners.delete(listener);
  };
}

/** True while a "Create all PRs" walk for this task is in flight. */
export function isPrBatchRunning(taskId: string): boolean {
  return runningBatches.has(taskId);
}

/** Claims the task's batch slot; false when one is already running. */
export function beginPrBatch(taskId: string): boolean {
  if (runningBatches.has(taskId)) return false;
  runningBatches.add(taskId);
  notifyBatches();
  return true;
}

/** Releases the task's batch slot. */
export function endPrBatch(taskId: string): void {
  if (runningBatches.delete(taskId)) notifyBatches();
}

/** Records that a batch opened a PR for this repository of the task. */
export function markRepositoryPrOpened(taskId: string, repoName: string): void {
  let set = stampedByBatch.get(taskId);
  if (!set) {
    set = new Set();
    stampedByBatch.set(taskId, set);
  }
  set.add(repoName);
}

/**
 * The repositories a "Create all PRs" press may target: no `prUrl` on the
 * row, and not opened by an earlier batch this session whose stamp the board
 * poll hasn't delivered yet.
 */
export function repositoriesForPrBatch<T extends { name: string; prUrl: string | null }>(
  taskId: string,
  repos: readonly T[],
): T[] {
  const opened = stampedByBatch.get(taskId);
  return repos.filter((r) => !r.prUrl && !opened?.has(r.name));
}

/** Test seam: forget every batch. */
export function resetPrBatchesForTest(): void {
  runningBatches.clear();
  stampedByBatch.clear();
  notifyBatches();
}

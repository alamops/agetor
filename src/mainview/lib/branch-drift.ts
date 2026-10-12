/**
 * Worktree branch drift, in one place for the webview. A task's worktree can
 * end up on a different branch than `task.branch` (the branch agetor created)
 * — an agent or a terminal ran `git checkout -b …`. agetor tolerates that
 * rather than switching it back, and surfaces it instead: the run panel and
 * the Worktrees page compare against the live branch from git, the board card
 * against the server's recorded last-seen checkout (`task.checkoutBranch`).
 * Kept DOM-free so it unit-tests under `bun test`.
 */

export interface BranchDrift {
  /** True when `observed` names a branch other than `taskBranch`. */
  drifted: boolean;
  /** The branch to display as "where the worktree is": `observed` when known,
   *  else `taskBranch`. */
  live: string | null;
}

/**
 * Compare the task's own branch with an observed checkout. Unknown (`null` /
 * `undefined` — never observed, detached HEAD, git unreadable) or no task
 * branch to drift from never counts as drift.
 */
export function driftOf(taskBranch: string | null, observed: string | null | undefined): BranchDrift {
  const seen = observed ?? null;
  if (!taskBranch || !seen) return { drifted: false, live: seen ?? taskBranch };
  return { drifted: seen !== taskBranch, live: seen };
}

/** Tooltip for a drift marker: names the branch agetor created for the task. */
export function driftTitle(taskBranch: string | null): string {
  return `task branch: ${taskBranch ?? "—"}`;
}

/**
 * Pure derivation logic for the run panel's "Commit & push" composer chip.
 * Kept DOM-free (like subagent-tabs.ts / event-dedup.ts) so it can be unit
 * tested with `bun test` — the repo has no jsdom/testing-library, so component
 * behaviour is validated by testing the logic the component drives.
 */

export interface TaskGitStatus {
  hasChanges: boolean;
  ahead: number;
  ignored: boolean;
}

/**
 * Whether the "Commit & push" chip should be offered for the given git
 * status. Intentionally independent of run status: with background-agent
 * support, a task can dirty its worktree (or gain unpushed commits) while
 * its latest run is still `running` — most of a task's lifetime, in
 * practice — so gating on `status === "succeeded"` would hide the action
 * exactly when it's most useful. The chip only cares about actual git
 * state: uncommitted changes, or commits ahead of the pushed branch.
 */
export function shouldOfferCommitPush(status: TaskGitStatus | null): boolean {
  if (!status || status.ignored) return false;
  return status.hasChanges || status.ahead > 0;
}

/**
 * Pure derivation logic for the run panel's "Commit & push" / "Open PR"
 * composer chips. Kept DOM-free (like subagent-tabs.ts / event-dedup.ts) so
 * it can be unit tested with `bun test` — the repo has no jsdom/testing-
 * library, so component behaviour is validated by testing the logic the
 * component drives.
 */
import type { TaskGitStatus } from "../../shared/types.ts";

export type { TaskGitStatus };

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

/**
 * Whether the "Open PR" chip should be offered. Git-state-only, like its
 * sibling above — `prUrl`/read-only gating happens at the call site (a task
 * that already has a PR shows "View PR" instead, regardless of this result).
 */
export function shouldOfferOpenPr(status: TaskGitStatus | null): boolean {
  return !!status && !status.ignored && !!status.remoteSynced;
}

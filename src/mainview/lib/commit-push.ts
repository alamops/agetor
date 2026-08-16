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

/**
 * The branch a "Create PR" click should use as the PR head, or `null` when
 * there isn't a sensible one — which doubles as the gate for showing the chip
 * at all.
 *
 * `taskBranch` (`task.branch`) is agetor's *worktree-managed* branch and is
 * only ever written for `isolation: "worktree"` tasks. Keying the gate on it
 * alone hid the chip for every `isolation: "none"` task, including one whose
 * workdir sits on the user's own pushed, synced feature branch — the branch
 * field is NULL there by construction, not because there's nothing to PR.
 *
 * So: prefer the managed branch verbatim (unchanged worktree behaviour — an
 * `agetor/<id>-<slug>` branch is never the repo default, so no extra check is
 * warranted), and otherwise fall back to the live checked-out branch reported
 * by `GET /tasks/:id/git-status`. The fallback is the ONLY path that consults
 * `isDefaultBranch`, guarding the original concern this gate was written for:
 * an isolation-none task sitting on `main` would open a base == head PR.
 */
export function prHeadBranch(taskBranch: string | null, status: TaskGitStatus | null): string | null {
  if (taskBranch) return taskBranch;
  if (!status || status.ignored) return null;
  if (!status.branch || status.isDefaultBranch) return null;
  return status.branch;
}

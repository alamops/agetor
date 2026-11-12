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
 * The "Commit & push" gate for a whole task. On a multi-repository task the
 * prompt is aggregate ("commit all changes in every repository"), so the chip
 * must appear when ANY repository has something to commit or push — gating on
 * the selected tab alone hid it exactly when another repository was dirty.
 * The single-repository path is the plain {@link shouldOfferCommitPush} check.
 */
export function shouldOfferCommitPushForTask(status: TaskGitStatus | null): boolean {
  if (!status) return false;
  const repos = status.repositories;
  // The per-repository array is present only for a multi task (the core
  // omits it for a single one), and a multi task left with one repository
  // still answers per repository, so its presence (not a count) decides.
  if (repos && repos.length > 0) return repos.some((repo) => shouldOfferCommitPush(repo));
  return shouldOfferCommitPush(status);
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
 * `taskBranch` (`task.branch`) is agetor's *worktree-managed* branch — the one
 * it created — and is only ever written for `isolation: "worktree"` tasks.
 * Keying the gate on it alone hid the chip for every `isolation: "none"`
 * task, including one whose workdir sits on the user's own pushed, synced
 * feature branch — the branch field is NULL there by construction, not
 * because there's nothing to PR.
 *
 * A worktree can drift off `task.branch` (an agent or a terminal ran `git
 * checkout -b …`); agetor tolerates that rather than switching it back, so
 * the commits the agent pushed live on the branch it is actually on. Rules:
 *   1. A PR-head task (`branchSource: "existing"`) always uses `taskBranch` —
 *      its PR already exists on that head, and a drifted branch would open a
 *      second PR.
 *   2. Otherwise the live checked-out branch from `GET /tasks/:id/git-status`
 *      wins when it is set, isn't the repo default, and differs from
 *      `taskBranch`.
 *   3. Otherwise `taskBranch` verbatim (an `agetor/<id>-<slug>` branch is never
 *      the repo default, so no extra check is warranted).
 *   4. With no `taskBranch` at all, fall back to the live branch — the only
 *      path besides rule 2 that consults `isDefaultBranch`, guarding the
 *      original concern: an isolation-none task sitting on `main` would open
 *      a base == head PR.
 */
export function prHeadBranch(
  taskBranch: string | null,
  status: TaskGitStatus | null,
  branchSource?: "created" | "existing",
): string | null {
  if (taskBranch && branchSource === "existing") return taskBranch;
  const live = status && !status.ignored && status.branch && !status.isDefaultBranch ? status.branch : null;
  if (taskBranch) return live && live !== taskBranch ? live : taskBranch;
  return live;
}

/**
 * PR head for ONE repository of a multi-repository task, and its
 * git-state gate (issue #291 review). Mirrors the single-repository chip:
 * the branch must be pushed and synced ({@link shouldOfferOpenPr}) before a
 * pull request is offered, and drift wins over the pinned entry branch —
 * the commits the agent pushed live on the branch actually checked out
 * ({@link prHeadBranch}). `status` is that repository's entry from the
 * batched `GET /tasks/:id/git-status` response; `null` (not polled yet, or
 * the repo's status failed) hides the affordance rather than opening a PR
 * from a stale stored branch.
 */
export function repositoryPrHead(
  repo: { branch: string | null; branchSource?: "created" | "existing" | null },
  status: TaskGitStatus | null,
): string | null {
  if (!shouldOfferOpenPr(status)) return null;
  return prHeadBranch(repo.branch, status, repo.branchSource ?? undefined);
}

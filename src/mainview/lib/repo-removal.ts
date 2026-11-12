// Pure helpers behind the run panel's per-repository details and its
// "Remove from task" action for a multi-repository task (issue #291). Kept
// free of React and `api` so each rule is unit-testable without a DOM
// harness, like `multi-repo-ui.ts`.
// Contract: docs/architecture/multi-repo-tasks.md.
import type { Task, TaskGitStatus, TaskRepository } from "../../shared/types.ts";
import { driftOf } from "./branch-drift.ts";

/** The task fields the removal gate reads. */
export type RemovalTaskShape = Pick<Task, "column" | "runId"> & {
  repositories?: readonly TaskRepository[];
  pipelineParentId?: string | null;
};

/**
 * Why "Remove from task" is disabled for this task, or null when it is
 * offered. Mirrors the core's refusals the client can see up front (the core
 * still decides: a dirty checkout or a pipeline parent with a running step is
 * only known there, and its message is shown as a toast).
 */
export function removeRepositoryBlockReason(task: RemovalTaskShape): string | null {
  // `blocked` still holds a live run waiting on the user.
  if (task.column === "running" || task.column === "blocked" || task.runId != null) {
    return "The task is running. Stop it before removing a repository.";
  }
  if (task.pipelineParentId != null) {
    return "This is a pipeline step; its repositories belong to the pipeline task. Remove it there.";
  }
  if ((task.repositories?.length ?? 0) <= 1) {
    return "A task needs at least one repository.";
  }
  return null;
}

/** The confirm dialog's title and body lines for removing one repository. */
export function removeRepositoryConfirmCopy(
  repo: Pick<TaskRepository, "name" | "path" | "branch" | "worktreePath">,
): { title: string; lines: string[]; confirmLabel: string } {
  const lines: string[] = [];
  lines.push(
    repo.worktreePath
      ? `Its checkout at ${repo.worktreePath} is detached from the task.`
      : "It has no checkout yet, so it is only dropped from the task.",
  );
  lines.push(
    repo.branch
      ? `The branch ${repo.branch} is kept in ${repo.path}, with any commits on it.`
      : `No branch was created for it in ${repo.path}.`,
  );
  lines.push("Uncommitted changes in the checkout block the removal.");
  lines.push("This can't be undone from here.");
  return { title: `Remove ${repo.name} from this task?`, lines, confirmLabel: "Remove repository" };
}

/**
 * Why a repository needs attention, or null when it looks healthy (or its
 * status is unknown). The core's per-repository git status reports `ignored`
 * when the directory can't be inspected: a checkout (or, before the first
 * run, the source repository) that was deleted or is no longer a git
 * repository. That is the repository a user wants to find and remove.
 */
export function repositoryProblem(
  repo: Pick<TaskRepository, "worktreePath">,
  status: Pick<TaskGitStatus, "ignored"> | null | undefined,
): string | null {
  if (!status || !status.ignored) return null;
  return repo.worktreePath
    ? "Checkout or source repository is missing or unreadable"
    : "Source repository is missing or unreadable";
}

/** One repository's line in the task details list. */
export interface RepositoryDetail {
  name: string;
  path: string;
  /** "<branch>", "on <checkout> (drifted from <branch>)", or null before one exists. */
  branchText: string | null;
  drifted: boolean;
  /** Short base sha, or null. */
  base: string | null;
  /** The checkout path, or "not created yet". */
  checkoutText: string;
  checkoutCreated: boolean;
  prUrl: string | null;
  problem: string | null;
}

/**
 * The task details' per-repository rows. The live branch comes from the
 * panel's git-status poll when the checkout is readable, else the last-seen
 * `checkoutBranch` the core recorded.
 */
export function repositoryDetails(
  repos: readonly TaskRepository[],
  statusFor: (name: string) => Pick<TaskGitStatus, "ignored" | "branch"> | null,
): RepositoryDetail[] {
  return repos.map((repo) => {
    const status = statusFor(repo.name);
    const observed = status && !status.ignored ? status.branch : repo.checkoutBranch;
    const drift = driftOf(repo.branch, observed);
    const branchText = drift.drifted
      ? `on ${drift.live} (drifted from ${repo.branch})`
      : repo.branch;
    return {
      name: repo.name,
      path: repo.path,
      branchText,
      drifted: drift.drifted,
      base: repo.baseRef ? repo.baseRef.slice(0, 12) : null,
      checkoutText: repo.worktreePath ?? "not created yet",
      checkoutCreated: repo.worktreePath != null,
      prUrl: repo.prUrl,
      problem: repositoryProblem(repo, status),
    };
  });
}

/**
 * The fields to merge from the task the removal route returned. Only the
 * fields a removal changes — merging the whole snapshot could revert a
 * concurrent optimistic patch (same rule as Detach in `TaskDetails`).
 */
export function removalMergeFields(updated: Task): Partial<Task> {
  return {
    repositories: updated.repositories,
    issueRepoPath: updated.issueRepoPath ?? null,
    ...(updated.multiRepo !== undefined ? { multiRepo: updated.multiRepo } : {}),
  };
}

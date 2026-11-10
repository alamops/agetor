// Client-side helpers for the multi-repository selector (issue #291).
import { repoNameForPath, uniqueRepoSlugs } from "../../shared/multi-repo.ts";

/** One selected repository in the dialog, before it becomes a create payload. */
export interface RepoSelection {
  /** The selected project path (may be a subdirectory of the git root). */
  path: string;
  /** The git root, once resolved (null while unknown / not a repo). */
  root: string | null;
  /** Per-repository base ref override (empty = the repo's HEAD). */
  baseRef?: string;
}

/** Warn (non-blocking) above this many repositories. Owner decision: no cap. */
export const MANY_REPOSITORIES = 10;

/** True when the selection should show the non-blocking size warning. */
export function tooManyRepositories(count: number): boolean {
  return count > MANY_REPOSITORIES;
}

/**
 * Keep the first selected path per resolved git root (dedupe), preserving
 * order. Entries whose root is still unknown are always kept — dropping one
 * on a guess could silently lose the repository the user picked. Pure, so
 * the dialog can show the count before and after without a round trip.
 */
export function dedupeSelections(entries: RepoSelection[]): RepoSelection[] {
  const seenRoots = new Set<string>();
  const out: RepoSelection[] = [];
  for (const entry of entries) {
    if (entry.root) {
      if (seenRoots.has(entry.root)) continue;
      seenRoots.add(entry.root);
    }
    out.push(entry);
  }
  return out;
}

/** Deterministic workspace names for the selection, in order. */
export function selectionNames(entries: Pick<RepoSelection, "path">[]): string[] {
  return uniqueRepoSlugs(entries.map((e) => e.path));
}

/** The display name for one selected repository. */
export function selectionName(entry: Pick<RepoSelection, "path">): string {
  return repoNameForPath(entry.path);
}

/**
 * The `@` file scopes for a multi selection: one named scope per repository,
 * listing that repository at its pinned base ref when worktree isolation is on
 * (the worktree doesn't exist yet) or at live HEAD otherwise. Shared by New
 * Task and the issue dialog so both surfaces expose the same `<name>/…`
 * prefixes — an issue task's extras are real repositories, not just the
 * issue's own.
 */
export function repositoryFileScopes(
  entries: Pick<RepoSelection, "path" | "baseRef">[],
  isolate: boolean,
): { name: string; dir: string; ref: string | null }[] {
  // Workspace names are `uniqueRepoSlugs` (the server's createTask layout).
  // Two different repositories can share a basename (`/a/api`, `/b/api`), and
  // the `@` prefix must match the actual workspace subdirectory (`api-2`), or
  // a highlighted token would not resolve.
  const names = uniqueRepoSlugs(entries.map((entry) => entry.path));
  return entries.map((entry, i) => ({
    name: names[i]!,
    dir: entry.path,
    ref: isolate ? (entry.baseRef?.trim() || "HEAD") : null,
  }));
}

/**
 * A directory that is always a real repository for this task: a single task's
 * `workdir`, or the first selected repository for a multi task (whose
 * `workdir` is the non-git workspace root). Surfaces that resolve a provider
 * remote or run git must default here, never at the workspace root.
 */
export function taskProjectPath(task: {
  workdir: string;
  repositories?: { path: string }[];
}): string {
  return (task.repositories?.length ?? 0) > 1
    ? (task.repositories?.[0]?.path ?? task.workdir)
    : task.workdir;
}

/**
 * The directory whose provider remote owns a task's issue URL. A
 * multi-repository task's `workdir` is the workspace root, which is NOT a git
 * repository — passing it to the GitHub dialog made the issue-thread fetch
 * 400. Use the entry whose remote matched `issueUrl` (`issueRepoPath`),
 * falling back to the selected tab, then to the first repository for rows
 * created before that field (the workspace root is never a valid answer).
 */
export function issueProjectPath(
  task: {
    workdir: string;
    issueRepoPath?: string | null;
    repositories?: { path: string }[];
  },
  activeRepo?: { path: string } | null,
): string {
  if ((task.repositories?.length ?? 0) > 1) {
    return task.issueRepoPath ?? activeRepo?.path ?? taskProjectPath(task);
  }
  return task.workdir;
}

/**
 * Merge an existing selection with the ProjectPicker's currently chosen path:
 * choosing a project collapses a multi selection back to that one repository
 * (and seeds its base ref), matching the plan's "changing the ProjectPicker
 * while 2+ are selected collapses back to that one repo".
 */
export function collapseToProject(path: string, previous: RepoSelection[]): RepoSelection[] {
  if (!path) return [];
  const known = previous.find((e) => e.path === path);
  return [known ?? { path, root: null }];
}

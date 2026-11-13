// Client-side helpers for the combined single/multi project selection (the
// Select Projects control, issue #291).
import { isMultiRepoTask, repoNameForPath, uniqueRepoSlugs } from "../../shared/multi-repo.ts";

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
export function dedupeSelections(entries: readonly RepoSelection[]): RepoSelection[] {
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

/** The raw last path segment — the label the single-project trigger used to
 *  show, not the sanitized workspace slug. */
export function projectDisplayName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/** The full-width Select Projects button's label: a zero-selection prompt,
 *  the project's own name for one project, the count for 2+ (the same
 *  convention `MultiSearchSelect`'s trigger uses). Counted after git-root
 *  dedupe, so two subdirectories of one repository read as one project. */
export function projectSelectionLabel(entries: readonly Pick<RepoSelection, "path" | "root">[]): string {
  const kept = dedupeSelections(entries);
  if (kept.length === 0) return "Select projects…";
  if (kept.length === 1) return projectDisplayName(kept[0]!.path);
  return `${kept.length} projects selected`;
}

/** One row label per path, in order. When two displayed names collide
 *  (`/a/api`, `/b/api`), every colliding row appends its full path so the
 *  user — and the tests — can tell them apart. */
export function projectRowLabels(paths: readonly string[]): string[] {
  const names = paths.map(projectDisplayName);
  const seen = new Map<string, number>();
  for (const name of names) seen.set(name, (seen.get(name) ?? 0) + 1);
  return names.map((name, i) => (seen.get(name)! > 1 ? `${name} — ${paths[i]}` : name));
}

/** Replace one entry's base ref, preserving order, roots and every other
 *  entry. An unknown path is a no-op (the row was removed while its branch
 *  list was still loading). A blank ref drops the key so the create payload
 *  omits it (HEAD). */
export function updateSelectionBaseRef(
  entries: readonly RepoSelection[],
  path: string,
  baseRef: string,
): RepoSelection[] {
  if (!entries.some((entry) => entry.path === path)) return [...entries];
  const ref = baseRef.trim();
  return entries.map((entry) => {
    if (entry.path !== path) return entry;
    const { baseRef: _stale, ...rest } = entry;
    return ref ? { ...rest, baseRef: ref } : rest;
  });
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
  multiRepo?: boolean;
}): string {
  // `isMultiRepoTask`, not a count: a multi task left with one repository
  // still has the workspace root as its `workdir`.
  return isMultiRepoTask(task)
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
    multiRepo?: boolean;
  },
  activeRepo?: { path: string } | null,
): string {
  if (isMultiRepoTask(task)) {
    return task.issueRepoPath ?? activeRepo?.path ?? taskProjectPath(task);
  }
  return task.workdir;
}

// Pure helpers shared by the Bun core, the webview, the CLI and the TUI for
// multi-repository tasks (issue #291). Must stay free of runtime imports from
// either process — see `file-scope.ts`'s header for the same rule.
import type { Task, TaskRepository } from "./types.ts";

/** The subset of a task the repository helpers read. */
export type RepoTaskShape = Pick<
  Task,
  | "workdir"
  | "isolation"
  | "branch"
  | "branchSource"
  | "worktreePath"
  | "baseRef"
  | "checkoutBranch"
  | "prUrl"
  | "repositories"
>;

/** Sanitized directory/branch-safe name from a project path's basename. */
export function repoNameForPath(projectPath: string): string {
  if (typeof projectPath !== "string") return "repo";
  const base = projectPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40);
  return slug || "repo";
}

/**
 * Deterministic, collision-free workspace subdirectory names for a selection,
 * in input order. The first path for a name keeps it; later collisions get
 * `-2`, `-3`, …. Shared by the client (predicting the layout for the dialog
 * and `@` prefixes) and the server (`createTask`), so both always agree.
 */
export function uniqueRepoSlugs(paths: string[]): string[] {
  const used = new Map<string, number>();
  return paths.map((p) => {
    const base = repoNameForPath(p);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    if (seen === 0) return base;
    let n = seen + 1;
    let candidate = `${base}-${n}`;
    while (used.has(candidate)) candidate = `${base}-${++n}`;
    used.set(candidate, 1);
    return candidate;
  });
}

/**
 * Every repository entry for a task, in selection order. Multi-repo tasks
 * carry their own array; a single-repo task (or a legacy row, whose column is
 * `[]`) derives one entry from the scalar columns so callers never branch on
 * `undefined`.
 */
export function repositoriesForTask(task: RepoTaskShape): TaskRepository[] {
  if (task.repositories && task.repositories.length > 1) return task.repositories;
  return [
    {
      path: task.workdir,
      name: repoNameForPath(task.workdir ?? ""),
      branch: task.branch ?? null,
      branchSource: task.branchSource ?? "created",
      worktreePath: task.worktreePath ?? null,
      baseRef: task.baseRef ?? null,
      checkoutBranch: task.checkoutBranch ?? null,
      prUrl: task.prUrl ?? null,
    },
  ];
}

/** True only for a task created against two or more repositories. */
export function isMultiRepoTask(task: Pick<Task, "repositories">): boolean {
  return (task.repositories?.length ?? 0) > 1;
}

/**
 * The `Repositories:` launch-prompt block (only appended for 2+ repos, so a
 * single-repo launch prompt stays byte-identical). Each line names the
 * workspace subdirectory, its absolute path and the branch checked out there.
 */
export function formatRepositoriesPrompt(
  repos: Pick<TaskRepository, "name" | "worktreePath" | "path" | "branch">[],
): string {
  const lines = repos.map(
    (r) => `- ${r.name}: ${r.worktreePath ?? r.path} (branch ${r.branch ?? "none yet"})`,
  );
  return lines.length === 0 ? "Repositories:" : `Repositories:\n${lines.join("\n")}`;
}

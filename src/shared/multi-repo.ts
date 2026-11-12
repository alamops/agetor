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
> & Pick<Partial<Task>, "multiRepo">;

/**
 * The subset {@link repositoriesForTask} and the `@`/discovery scope helpers
 * need. Narrower than {@link RepoTaskShape} so CLI callers that only know the
 * repository set don't have to invent checkout/PR fields; those two are
 * optional (a derived single-repository entry reports them when present).
 */
export type RepoSetShape = Pick<
  Task,
  "workdir" | "isolation" | "branch" | "branchSource" | "worktreePath" | "baseRef"
> & { repositories?: TaskRepository[]; multiRepo?: boolean };

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
 * in input order. The first path for a name keeps it; later collisions get a
 * numeric suffix (`app-2`, `app-3`, …). A colliding base that already ends in
 * a number resumes that stem's sequence instead of nesting a second suffix
 * (`app-2` -> `app-3`, never `app-2-2`). Shared by the client (predicting the
 * layout for the dialog and `@` prefixes) and the server (`createTask`), so
 * both always agree.
 */
export function uniqueRepoSlugs(paths: string[]): string[] {
  const used = new Set<string>();
  return paths.map((p) => {
    const base = repoNameForPath(p);
    let candidate = base;
    if (used.has(candidate)) {
      const suffixed = /^(.*)-(\d+)$/.exec(base);
      const stem = suffixed ? suffixed[1]! : base;
      let n = suffixed ? Number(suffixed[2]) + 1 : 2;
      candidate = `${stem}-${n}`;
      while (used.has(candidate)) candidate = `${stem}-${++n}`;
    }
    used.add(candidate);
    return candidate;
  });
}

/**
 * Every repository entry for a task, in selection order. Multi-repo tasks
 * ({@link isMultiRepoTask}, which includes a one-repository multi task left
 * by a removal) carry their own array; a single-repo task (or a legacy row,
 * whose column is `[]`) derives one entry from the scalar columns so callers
 * never branch on `undefined`.
 */
export function repositoriesForTask(
  task: RepoSetShape & Partial<Pick<Task, "checkoutBranch" | "prUrl">>,
): TaskRepository[] {
  if (task.repositories && task.repositories.length > 0 && isMultiRepoTask(task)) return task.repositories;
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

/**
 * True for a multi-repository task: one created against two or more
 * repositories, which stays multi (workspace-root layout, `Repositories:`
 * block, per-repository everything) even after repositories are removed down
 * to one. The core computes `multiRepo` from the stored column (`db.ts`'s
 * `toTask`); the count fallback keeps an older core's JSON, which has no
 * `multiRepo`, working. Every multi/single decision goes through this, never
 * through `repositories.length`.
 */
export function isMultiRepoTask(task: { multiRepo?: boolean; repositories?: readonly unknown[] | null }): boolean {
  return task.multiRepo ?? ((task.repositories?.length ?? 0) > 1);
}

/**
 * The `Repositories:` launch-prompt block (only appended for a multi task, so
 * a single-repo launch prompt stays byte-identical). Each line names the
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

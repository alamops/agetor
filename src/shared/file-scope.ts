// Shared by both processes — must stay free of runtime imports from either
// side (same rule `issue-task.ts`/`at-refs.ts` document). This is the single
// source of truth for "which tree does this task's agent see": the live
// worktree once it exists; before the first run of an isolated task, the
// source repo at whatever ref `prepareWorkdir` will actually check the
// worktree out on (`task.branch` when pinned to a pre-existing branch, else
// the pinned `baseRef`); a plain workdir otherwise. Used by the webview's
// `RunPanel.tsx`, the TUI's `at-complete.ts`/`Dashboard.tsx`, and the CLI —
// for BOTH the `@` file listing (`GET /files/index`, whose `dir`/`ref`
// params are exactly `scope.dir`/`scope.ref`) and capability discovery
// (`GET /agent-discovery`, whose `workdir`/`branch` params are exactly
// `scope.dir`/`scope.ref`, via {@link discoveryParamsForTask}).
import type { Task } from "./types.ts";
import { isMultiRepoTask, repositoriesForTask } from "./multi-repo.ts";
import type { RepoSetShape } from "./multi-repo.ts";

/**
 * The project scope (`GET /files/index` params) a task's `@` popover — and,
 * via {@link discoveryParamsForTask}, capability discovery — should
 * list/validate against: the live worktree once it exists; before the first
 * run of an isolated task, the source repo at whatever ref `prepareWorkdir`
 * will actually check the worktree out on (`task.branch` when pinned to a
 * pre-existing branch, else the pinned `baseRef`); a plain workdir
 * otherwise.
 */
export function fileScopeForTask(
  task: Pick<Task, "workdir" | "worktreePath" | "isolation" | "baseRef" | "branchSource" | "branch">,
): { dir: string; ref?: string | null } {
  if (task.worktreePath) return { dir: task.worktreePath };
  if (task.isolation === "worktree") {
    return {
      dir: task.workdir,
      ref: task.branchSource === "existing" && task.branch ? task.branch : (task.baseRef ?? "HEAD"),
    };
  }
  return { dir: task.workdir };
}

/**
 * {@link fileScopeForTask}, reshaped as `GET /agent-discovery`'s own
 * `workdir`/`branch` params — the route treats `branch` as a git ref exactly
 * like `/files/index`'s `ref`, so this is a pure relabeling, not a different
 * rule. Callers that need to invoke `agentDiscovery(agent, workdir, branch)`
 * should build the last two args from this rather than re-deriving the
 * dir/ref mapping themselves.
 */
export function discoveryParamsForTask(
  task: Pick<Task, "workdir" | "worktreePath" | "isolation" | "baseRef" | "branchSource" | "branch">,
): { workdir: string; branch: string | null } {
  const scope = fileScopeForTask(task);
  return { workdir: scope.dir, branch: scope.ref ?? null };
}

/**
 * Every `GET /agent-discovery` scope a multi-repository task should union
 * over. A single-repository task returns exactly one entry — byte-identical to
 * {@link discoveryParamsForTask} — so today's behavior is unchanged. A multi
 * task returns one entry per repository (its materialized worktree, or the
 * source repo at the pinned branch/ref before start), because the workspace
 * root is not a git repository: discovery there finds no project-level
 * commands, skills or MCP servers from any of the selected repositories.
 */
export function discoveryScopesForTask(
  task: RepoSetShape,
): Array<{ workdir: string; branch: string | null }> {
  return fileScopesForTask(task).map((scope) => ({ workdir: scope.dir, branch: scope.ref ?? null }));
}

/** One repository's `@`/discovery scope, tagged with its workspace name. */
export interface RepoFileScope {
  /** Workspace subdirectory name, or null for a single-repository task. */
  name: string | null;
  /** The directory to list/validate against (`/files/index`'s `dir`). */
  dir: string;
  /** The ref to list/validate at (`/files/index`'s `ref`). */
  ref?: string | null;
}

/**
 * Every scope a task's `@` popover (and capability discovery) should union
 * over. A single-repository task returns exactly one entry — byte-identical
 * to {@link fileScopeForTask} — so today's behavior is unchanged. A
 * multi-repository task returns one entry per repository: the materialized
 * worktree once it exists, otherwise the source repo at the branch/ref
 * `prepareRepoWorktree` will use, tagged with the repository's workspace name
 * so the client can prefix entries (`<name>/src/a.ts`).
 */
export function fileScopesForTask(task: RepoSetShape): RepoFileScope[] {
  // A one-repository multi task still lists through its named scope: its
  // cwd is the non-git workspace root, so `<name>/…` is how `@` reaches it.
  if (!isMultiRepoTask(task)) return [{ name: null, ...fileScopeForTask(task) }];
  const repos = repositoriesForTask(task);
  return repos.map((repo) => {
    if (repo.worktreePath) return { name: repo.name, dir: repo.worktreePath };
    if (task.isolation === "worktree") {
      return {
        name: repo.name,
        dir: repo.path,
        ref: repo.branchSource === "existing" && repo.branch
          ? repo.branch
          : (repo.baseRef ?? "HEAD"),
      };
    }
    return { name: repo.name, dir: repo.path };
  });
}

/**
 * The named scopes a multi-repository task's composer/diff surfaces union
 * over, or `[]` for a single-repository task (whose callers should keep using
 * {@link fileScopeForTask} unchanged). This is the shared derivation behind
 * `RunPanel`'s and `DiffDialog`'s `fileScopes` prop — the workspace root is
 * not a git repository, so listing there would find none of the selected
 * repositories' files.
 */
export function multiRepoFileScopes(
  task: RepoSetShape,
): Array<{ name: string; dir: string; ref?: string | null }> {
  const scopes: Array<{ name: string; dir: string; ref?: string | null }> = [];
  for (const scope of fileScopesForTask(task)) {
    if (!scope.name) continue;
    scopes.push(
      scope.ref === undefined
        ? { name: scope.name, dir: scope.dir }
        : { name: scope.name, dir: scope.dir, ref: scope.ref },
    );
  }
  return scopes;
}

/**
 * Split a `<workspace-name>/<repo-local-path>` token into its owning scope and
 * the path inside that scope. Returns `null` when the path has no known
 * workspace prefix (it cannot resolve from the multi-repository workspace
 * root) or when there are no scopes at all. Pure and shared by the webview's
 * `@` popover/search (`src/mainview/lib/use-project-files.ts`) and the CLI's
 * advisory pre-check (`src/cli/at-warn.ts`), so the prefix grammar can't
 * drift between them.
 */
export function splitNamedScopePath<T extends { name: string | null }>(
  scopes: readonly T[] | null | undefined,
  path: string,
): { scope: T; path: string } | null {
  if (!scopes || scopes.length === 0 || !path) return null;
  const slash = path.indexOf("/");
  if (slash <= 0) return null;
  const name = path.slice(0, slash);
  const scope = scopes.find((s) => s.name === name);
  if (!scope) return null;
  return { scope, path: path.slice(slash + 1) };
}

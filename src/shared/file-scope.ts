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
import { repositoriesForTask } from "./multi-repo.ts";
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
  const repos = repositoriesForTask(task);
  if (repos.length <= 1) return [{ name: null, ...fileScopeForTask(task) }];
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

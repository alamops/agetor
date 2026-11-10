// Pure/near-pure helpers for validating and planning a task's repository set
// (issue #291). Deliberately does NOT import `worktree.ts` (which imports
// `db.ts`): callers inject `resolveRoot`, so there is no cycle and the set can
// be validated before any side effect. Shared by `createTask`, the worktree
// engine and tests.
import path from "node:path";
import { uniqueRepoSlugs } from "../shared/multi-repo.ts";
import type { TaskRepository, TaskRepositoryInput } from "../shared/types.ts";

/** A repository input that passed validation, with the git root resolved. */
export interface ResolvedRepository {
  /** The selected project path (may be a subdirectory of the git root). */
  path: string;
  /** The git top-level for `path`. */
  root: string;
}

export type RepositorySetResult =
  | { ok: true; repositories: TaskRepository[]; repositoriesRoots: Map<string, string> }
  /**
   * Validation failed. `repositories` still carries the entries that DID
   * resolve (with empty server fields), so a caller can keep validating their
   * base refs and report every problem in one response.
   */
  | { ok: false; errors: string[]; repositories: TaskRepository[] };

/**
 * Validate and normalize the create-time repository selection:
 *  - every path must be a non-empty absolute path inside a git repository;
 *  - paths that resolve to the same git root are deduped, keeping the first
 *    selected path (the displayed project) for that root;
 *  - workspace names come from {@link uniqueRepoSlugs}, so client and server
 *    always agree on the layout.
 *
 * All-or-nothing on validation: every bad entry is collected and returned, so
 * a caller can name all of them at once. `resolveRoot` is injected (it is
 * `repoRoot` in production) to keep this module import-cycle free.
 */
export async function resolveRepositorySet(
  input: TaskRepositoryInput[],
  opts: { resolveRoot: (dir: string) => Promise<string | null> },
): Promise<RepositorySetResult> {
  const errors: string[] = [];
  const seenRoots = new Set<string>();
  const kept: ResolvedRepository[] = [];

  for (let i = 0; i < input.length; i++) {
    const raw = input[i]?.path;
    const projectPath = typeof raw === "string" ? raw.trim() : "";
    const label = `repository ${i + 1}${projectPath ? ` (${projectPath})` : ""}`;
    if (!projectPath) {
      errors.push(`${label}: path is empty`);
      continue;
    }
    if (!path.isAbsolute(projectPath)) {
      errors.push(`${label}: path must be absolute`);
      continue;
    }
    const root = await opts.resolveRoot(projectPath);
    if (!root) {
      errors.push(`${label}: not inside a git repository`);
      continue;
    }
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    kept.push({ path: projectPath, root });
  }

  const names = uniqueRepoSlugs(kept.map((k) => k.path));
  const repositories: TaskRepository[] = kept.map((k, i) => ({
    path: k.path,
    name: names[i]!,
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    checkoutBranch: null,
    prUrl: null,
  }));
  if (errors.length > 0) return { ok: false, errors, repositories };
  return {
    ok: true,
    repositories,
    repositoriesRoots: new Map(kept.map((k) => [k.path, k.root])),
  };
}

/**
 * The branch name each repository should attempt first. All repositories share
 * `desired`; a repository whose root already holds that name in `takenByRoot`
 * (another task pinned it but has not materialized it yet) gets `-2`, `-3`, …
 * — the per-repository fallback. Keyed by repo root so a name held in repo A
 * never forces a rename in repo B.
 */
export function repoBranchPlan(
  repositories: Pick<TaskRepository, "path" | "name">[],
  roots: Map<string, string>,
  desired: string,
  takenByRoot: Map<string, Set<string>> = new Map(),
): Map<string, string> {
  const out = new Map<string, string>();
  for (const repo of repositories) {
    const root = roots.get(repo.path) ?? repo.path;
    const taken = takenByRoot.get(root) ?? new Set<string>();
    let candidate = desired;
    for (let n = 2; taken.has(candidate) && n < 10_000; n++) candidate = `${desired}-${n}`;
    out.set(repo.name, candidate);
  }
  return out;
}

/**
 * True when `candidate` is lexically contained in `root` (equal or a
 * descendant). Lexical only — symlinks are not resolved, matching the
 * worktree engine's own ownership guard. Used by tests and callers that must
 * prove a nested worktree path stays inside its workspace.
 */
export function lexicallyInsideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Branch names already pinned on tasks other than `taskId`, grouped by the
 * source git root each one belongs to. Used by `createTask`/`startTask` so a
 * not-yet-started multi-repository task can't be handed a branch another task
 * is holding in the same repository.
 */
export function branchesPinnedByOtherTasks(
  taskId: string,
  tasks: { id: string; branch: string | null; workdir: string; repositories?: TaskRepository[] }[],
): Map<string, Set<string>> {
  const byWorkdir = new Map<string, Set<string>>();
  for (const t of tasks) {
    if (t.id === taskId) continue;
    const add = (key: string, branch: string | null) => {
      if (!branch) return;
      const set = byWorkdir.get(key) ?? new Set<string>();
      set.add(branch);
      byWorkdir.set(key, set);
    };
    add(t.workdir, t.branch);
    for (const repo of t.repositories ?? []) add(repo.path, repo.branch);
  }
  return byWorkdir;
}

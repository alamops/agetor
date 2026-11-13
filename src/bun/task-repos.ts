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
 * How many `resolveRoot` calls `branchesPinnedByOtherTasks` runs at once while
 * adding git-root keys. A board with many pinned paths must not fan out one
 * `git rev-parse` per path all at once — that is an unbounded subprocess burst
 * on every create/start. Four matches the worktree engine's own
 * `MULTI_REPO_CONCURRENCY` fan-out; this module can't import that constant
 * (import cycle), so the number is kept local and asserted by the unit test.
 */
export const PIN_ROOT_CONCURRENCY = 4;

/**
 * Branch names already pinned on tasks other than `taskId`, grouped by the
 * selected project path each one belongs to (`workdir` for a single-repository
 * row, `repositories[].path` for a multi row) AND by that path's git root.
 * Used by `createTask`/`startTask` so a not-yet-started task can't be handed a
 * branch another task is holding in the same repository.
 *
 * The git-root keys are load-bearing for multi-repository rows. A pin is
 * stored against the path the other task *selected*, which may be any
 * subdirectory of the repository; the caller looks it up by the path THIS task
 * selected. Two tasks that picked sibling subdirectories of one repository
 * therefore share no path key at all — without also keying by the resolved
 * root, the second start found no pin and silently attached to the first
 * task's branch (and its commits). `resolveRoot` is injected (it is `repoRoot`
 * in production) to keep this module import-cycle free; once a branch exists
 * as a ref, `ensureUniqueBranch` remains the backstop for path aliases the
 * resolver can't see (e.g. a symlinked checkout).
 *
 * Callers that only need the *set* of pinned branch names (the single-
 * repository paths fold every value and ignore the keys) must omit
 * `resolveRoot`: resolving every pin's root there is pure wasted work on the
 * hottest create/start path. Only the multi-repository lookups, which query by
 * `[path, root]`, need the root keys.
 */
export async function branchesPinnedByOtherTasks(
  taskId: string,
  tasks: { id: string; branch: string | null; workdir: string; repositories?: TaskRepository[] }[],
  opts: { resolveRoot?: (dir: string) => Promise<string | null> } = {},
): Promise<Map<string, Set<string>>> {
  const byKey = new Map<string, Set<string>>();
  const add = (key: string, branch: string): void => {
    const set = byKey.get(key) ?? new Set<string>();
    set.add(branch);
    byKey.set(key, set);
  };

  // Every non-null pin with the path it is stored against. Paths are resolved
  // once per distinct value; `repoRoot` memoizes successful lookups, so a
  // large board's repeated workdirs are cheap after the first call.
  const pins: Array<{ path: string; branch: string }> = [];
  for (const t of tasks) {
    if (t.id === taskId) continue;
    if (t.branch && t.workdir) pins.push({ path: t.workdir, branch: t.branch });
    for (const repo of t.repositories ?? []) {
      if (repo.branch && repo.path) pins.push({ path: repo.path, branch: repo.branch });
    }
  }
  const rootByPath = new Map<string, string>();
  if (opts.resolveRoot) {
    const resolveRoot = opts.resolveRoot;
    // Deduped paths resolved through a bounded worker pool, not one
    // unbounded Promise.all: a board with hundreds of pinned paths used to
    // spawn a `git rev-parse` for every one of them at once on each
    // create/start. `repoRoot` memoizes successes, so repeated calls only pay
    // for paths that failed/are no longer repos — still bounded here.
    const paths = [...new Set(pins.map((pin) => pin.path))];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const i = next++;
        const dir = paths[i];
        if (dir === undefined) return;
        const root = await resolveRoot(dir).catch(() => null);
        if (root) rootByPath.set(dir, root);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PIN_ROOT_CONCURRENCY, paths.length) }, worker),
    );
  }

  for (const pin of pins) {
    add(pin.path, pin.branch);
    const root = rootByPath.get(pin.path);
    if (root) add(root, pin.branch);
  }
  return byKey;
}

/**
 * Every branch name `pins` holds for any of `keys` — a repository's selected
 * path and its git root, in that order. The sets are UNIONed, not first-match:
 * two other tasks that selected different sibling subdirectories of one
 * repository contribute separate path sets plus one shared root set, so taking
 * only the first matching key would silently drop one task's pin.
 */
export function pinnedBranchesFor(
  pins: Map<string, Set<string>> | undefined,
  keys: readonly (string | null | undefined)[],
): Set<string> {
  const out = new Set<string>();
  for (const key of keys) {
    if (!key) continue;
    for (const branch of pins?.get(key) ?? []) out.add(branch);
  }
  return out;
}

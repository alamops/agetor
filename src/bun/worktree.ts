import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./db.ts";
import type { Task } from "../shared/types.ts";

const WORKTREES_DIR = path.join(dataDir, "worktrees");

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

const GIT_TIMEOUT_MS = 30_000;

/**
 * Run `git` against a working directory. Never throws — callers inspect `ok`.
 * Using Bun.spawn directly (not Bun.$) so we don't pay shell-parsing cost or
 * worry about argument quoting on user-supplied paths/branch names.
 *
 * A hard kill fires after `timeoutMs` (default 30 s) so a hung credential
 * prompt or a stalled pack-objects can't block agetor indefinitely.
 */
async function git(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  } finally {
    clearTimeout(timer);
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false;
  const res = await git(["rev-parse", "--is-inside-work-tree"], dir);
  return res.ok && res.stdout === "true";
}

/**
 * Whether `dir` has uncommitted changes (staged, unstaged, or untracked).
 * Returns null when we can't tell — missing dir, not a git repo, or a git
 * command failure. Callers should treat null as "unknown" rather than false
 * so we never claim "clean" for a working tree we couldn't actually inspect.
 */
export async function hasUncommittedChanges(dir: string): Promise<boolean | null> {
  if (!existsSync(dir)) return null;
  if (!(await isGitRepo(dir))) return null;
  const res = await git(["status", "--porcelain"], dir);
  if (!res.ok) return null;
  return res.stdout.trim().length > 0;
}

/**
 * Return the absolute path of the repo root for `dir`, or null if `dir`
 * isn't a git working tree. We base worktrees off the root, not subdirectories.
 */
export async function repoRoot(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  const res = await git(["rev-parse", "--show-toplevel"], dir);
  return res.ok ? res.stdout : null;
}

/**
 * Resolve a ref (branch name, tag, "HEAD", or partial sha) to a full 40-char sha
 * relative to `dir`. Returns null if `dir` isn't a git repo or the ref doesn't
 * exist — callers turn that into a user-facing error.
 */
export async function resolveRef(dir: string, ref: string): Promise<string | null> {
  const res = await git(["rev-parse", "--verify", `${ref}^{commit}`], dir);
  if (!res.ok) return null;
  return /^[0-9a-f]{40}$/.test(res.stdout) ? res.stdout : null;
}

export interface BranchInfo {
  /** Short ref name, e.g. "main", "feature/x", or "origin/feature/x". */
  name: string;
  /** Unix-ms timestamp of the tip commit, used to sort recents first. */
  committedAt: number;
  /** True for the branch currently checked out at `dir`. */
  current: boolean;
  /** True for remote-tracking refs (`refs/remotes/<remote>/<name>`). */
  remote: boolean;
}

/**
 * List branches at `dir`, sorted by most recent commit first. Includes both
 * local branches (`refs/heads/…`) and remote-tracking branches (`refs/remotes/<remote>/…`),
 * so a fresh clone with only `main` checked out still surfaces every `origin/*`
 * branch in the picker.
 *
 * Dedup rule: when a local and a remote-tracking branch share the same short
 * name (e.g. `main` and `origin/main`), only the local one is kept — the
 * pinned-base sha will resolve identically and we don't want two visually
 * indistinguishable rows.
 *
 * Branches created by agetor itself (under `refs/heads/agetor/…`) are excluded
 * so the picker shows the user's own branches, not the per-task ones we manage.
 * The branch currently checked out in `dir` (if any) is flagged so the UI can
 * float it to the top regardless of recency. `HEAD` pointer aliases such as
 * `origin/HEAD` are skipped.
 */
export async function listBranches(dir: string): Promise<BranchInfo[]> {
  const root = await repoRoot(dir);
  if (!root) return [];
  const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  const currentName = head.ok ? head.stdout : null;
  // Tab-separated to keep parsing simple — branch names can't contain tabs.
  // `%(HEAD)` marks the current branch with `*`. Querying both heads and
  // remotes in one pass keeps the sort stable.
  const res = await git(
    [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname)\t%(refname:short)\t%(committerdate:unix)",
      "refs/heads/",
      "refs/remotes/",
    ],
    root,
  );
  if (!res.ok) return [];

  const seen = new Set<string>();
  const branches: BranchInfo[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const fullRef = parts[0]!;
    const shortName = parts[1]!;
    const ts = Number(parts[2]) * 1000;
    const isRemote = fullRef.startsWith("refs/remotes/");
    // `origin/HEAD -> origin/main` shows up as an empty timestamp on the
    // pointer line; the actual `origin/main` row already covers it.
    if (isRemote && shortName.endsWith("/HEAD")) continue;
    // The remote's short name keeps the `<remote>/` prefix so a local `main`
    // and a tracking `origin/main` don't collide; for the dedup key, strip
    // that prefix so we can prefer the local one.
    const dedupKey = isRemote ? shortName.replace(/^[^/]+\//, "") : shortName;
    if (!isRemote && shortName.startsWith("agetor/")) continue;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    branches.push({
      name: shortName,
      committedAt: Number.isFinite(ts) ? ts : 0,
      current: !isRemote && shortName === currentName,
      remote: isRemote,
    });
  }
  return branches;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";
}

export function branchName(task: Pick<Task, "id" | "title">): string {
  return `agetor/${task.id.replace(/-/g, "").slice(0, 12)}-${slugify(task.title)}`;
}

export function worktreePath(task: Task): string {
  return path.join(WORKTREES_DIR, task.id);
}

export interface PreparedWorkdir {
  /** Where the agent should actually `spawn` from. */
  cwd: string;
  /** Set when a worktree was used. */
  branch: string | null;
  /** Set when a worktree was used. */
  worktreePath: string | null;
  /** Human-readable note for the run log. */
  note: string;
}

/** Returned instead of PreparedWorkdir when the worktree cannot be set up. */
export interface PrepareError {
  error: string;
}

export type PrepareResult = PreparedWorkdir | PrepareError;

/**
 * Materialize a per-task git worktree if `task.isolation === "worktree"` and
 * `task.workdir` is inside a git repo. Idempotent: reuses an existing worktree
 * when one is already recorded on the task and still exists on disk.
 *
 * Returns `PrepareError` (instead of silently falling back) when isolation is
 * on but the worktree cannot be created — running the agent unisolated against
 * the user's live working tree when they asked for isolation is worse than a
 * clear error. Callers should surface the message and abort the run.
 */
export async function prepareWorkdir(task: Task): Promise<PrepareResult> {
  if (task.isolation !== "worktree") {
    return { cwd: task.workdir, branch: null, worktreePath: null, note: "isolation: none" };
  }

  const root = await repoRoot(task.workdir);
  if (!root) {
    return {
      error: `worktree isolation is on but "${task.workdir}" is not inside a git repo — change isolation to "none" or point workdir at a git repo`,
    };
  }

  // Reuse if previously created and still on disk.
  if (task.worktreePath && task.branch && existsSync(task.worktreePath)) {
    // Verify the worktree is on the expected branch. A user cd-ing in and
    // switching branches shouldn't silently redirect the agent.
    const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], task.worktreePath, 5_000);
    if (head.ok && head.stdout !== task.branch) {
      const checkout = await git(["checkout", task.branch], task.worktreePath, 10_000);
      if (!checkout.ok) {
        return {
          error: `worktree is on "${head.stdout}" not "${task.branch}" and could not be switched: ${checkout.stderr || checkout.stdout}`,
        };
      }
    }
    return {
      cwd: task.worktreePath,
      branch: task.branch,
      worktreePath: task.worktreePath,
      note: `reusing worktree at ${task.worktreePath} on ${task.branch}`,
    };
  }

  mkdirSync(WORKTREES_DIR, { recursive: true });
  const wt = worktreePath(task);
  // Branch name: pinned at create time (task.branch is set by createTask for
  // worktree-isolation tasks). Fall back to computing it for legacy rows
  // created before the pinning was added.
  const branch = task.branch ?? branchName(task);
  // Pinned base sha if set on the task; otherwise use HEAD at start time.
  // The sha makes the start state sticky across re-runs even when HEAD moves.
  const base = task.baseRef ?? "HEAD";

  // If the branch already exists (e.g. the worktree dir was manually deleted
  // but the branch survived), re-attach rather than reset — using `-B` would
  // forcibly rewind the branch back to `base`, discarding any commits the
  // previous run made.
  const branchExists = (await git(["rev-parse", "--verify", `refs/heads/${branch}`], root, 5_000)).ok;
  // Prune stale worktree registrations before any `add` — git rejects adding
  // a path it still tracks as a missing-but-registered worktree without a
  // prune step first.
  await git(["worktree", "prune"], root, 10_000);
  const created = branchExists
    ? await git(["worktree", "add", wt, branch], root)
    : await git(["worktree", "add", "-b", branch, wt, base], root);

  if (!created.ok) {
    return {
      error: `worktree creation failed: ${created.stderr || created.stdout}`,
    };
  }

  const baseLabel = task.baseRef ? `base: ${task.baseRef.slice(0, 7)}` : `base: ${root} HEAD`;
  return {
    cwd: wt,
    branch,
    worktreePath: wt,
    note: `created worktree at ${wt} on ${branch} (${baseLabel})`,
  };
}

/**
 * Best-effort cleanup. Called on task delete; never throws.
 * Removes the worktree directory and deletes the branch.
 *
 * Two-stage cleanup so we never leak a directory under our owned data dir:
 *   1. Ask git to remove the registered worktree + branch (works in the
 *      common case where `task.workdir` still points at the original repo).
 *   2. If the worktree path still exists and lives under `dataDir/worktrees/`
 *      (which we always construct it to), force-rm it. This catches the case
 *      where the user edited `task.workdir` after the worktree was created,
 *      so git in the new workdir doesn't know about this worktree.
 */
export async function removeWorktree(task: Task): Promise<void> {
  if (!task.worktreePath) return;
  const root = await repoRoot(task.workdir);
  if (root) {
    await git(["worktree", "remove", "--force", task.worktreePath], root);
    if (task.branch) await git(["branch", "-D", task.branch], root);
    // Clean up any stale .git/worktrees/<id>/ registrations left by previous
    // partial removes (e.g. workdir was changed after the worktree was created).
    await git(["worktree", "prune"], root, 10_000);
  }
  const ownedPrefix = WORKTREES_DIR + path.sep;
  if (
    task.worktreePath.startsWith(ownedPrefix)
    && existsSync(task.worktreePath)
  ) {
    try { rmSync(task.worktreePath, { recursive: true, force: true }); }
    catch { /* best-effort */ }
  }
}

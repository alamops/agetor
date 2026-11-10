import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { dataDir } from "./db.ts";
import { coreSpawn } from "./core-spawn.ts";
import { readTextNoFollow } from "./no-follow.ts";
import { readFileBytes } from "./core-file-read.ts";
import { MAX_DIFF_FILES, parseGitDiff } from "./git-diff.ts";
import { LEGACY_BRANCH_PREFIX } from "../shared/types.ts";
import type { BranchInfo, Task, TaskDiff, TaskRepository, WorktreeTeardownResult } from "../shared/types.ts";
import { MAX_BLOB_PREVIEW_BYTES } from "../shared/attachments.ts";
import { lexicallyInsideRoot } from "./task-repos.ts";

export type { BranchInfo };

export const WORKTREES_DIR = path.join(dataDir, "worktrees");

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

const GIT_TIMEOUT_MS = 30_000;

/**
 * Run `git` against a working directory. Resolves with `ok` reflecting exit
 * status for a normal invocation — but CAN throw synchronously, since it's a
 * thin wrapper over `coreSpawn` (`Bun.spawn` semantics), which throws when the `git`
 * binary isn't on `PATH` or `cwd` doesn't exist. Callers that need a true non-throwing
 * contract (e.g. `gitWritableRoots`) must wrap their own call in try/catch.
 * Spawning directly (not Bun.$) so we don't pay shell-parsing cost or
 * worry about argument quoting on user-supplied paths/branch names.
 *
 * A hard kill fires after `timeoutMs` (default 30 s) so a hung credential
 * prompt or a stalled pack-objects can't block agetor indefinitely.
 */
async function git(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  // Through the disclaim wrapper: a repo's own config (`core.fsmonitor`, hooks,
  // filters) is agent-plantable and must not run with Agetor's macOS identity
  // (docs/plans/master-token-agent-read.md, P2/P3).
  const proc = coreSpawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  }) as Bun.Subprocess<"ignore", "pipe", "pipe">;
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

/**
 * Like `git`, but for reading raw blob bytes (e.g. `git show <sha>:<path>`)
 * whose content may not be valid UTF-8 — images and PDFs, in particular.
 * `git`'s `text()` collection would mangle those bytes via replacement-
 * character substitution, so this variant collects stdout as an
 * `ArrayBuffer` instead. Same never-throws contract and 30s default timeout
 * as `git`.
 */
async function gitRaw(
  args: string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<{ ok: boolean; exitCode: number; bytes: Uint8Array<ArrayBuffer>; stderr: string }> {
  // Through the disclaim wrapper: a repo's own config (`core.fsmonitor`, hooks,
  // filters) is agent-plantable and must not run with Agetor's macOS identity
  // (docs/plans/master-token-agent-read.md, P2/P3).
  const proc = coreSpawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  }) as Bun.Subprocess<"ignore", "pipe", "pipe">;
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [buf, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: exitCode === 0, exitCode, bytes: new Uint8Array(buf), stderr: stderr.trim() };
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
 * How many commits on `dir`'s HEAD would be pushed — i.e. haven't reached
 * the branch's remote yet. Three tiers, from most to least authoritative:
 *
 * 1. `@{u}..HEAD` — the branch has a configured upstream, so this is the
 *    literal "what would `git push` send" count. Success here is definitive.
 * 2. No upstream (the common case for a fresh `agetor/<id>-<slug>` branch
 *    that's never been pushed): fall back to `baseRef..HEAD` when a baseRef
 *    is known. A branch with no upstream has never been pushed, so every
 *    commit ahead of the base it was cut from is, by construction, unpushed.
 * 3. No upstream and no baseRef to compare against: return `0` rather than
 *    `null`. This is "unknown but not blocking" — we can't compute a real
 *    ahead count, but callers already have `hasChanges` to decide whether
 *    there's anything actionable, so a silent `0` is preferable to `null`
 *    forcing every caller to special-case "ahead is unknown."
 *
 * `null` is reserved for cases where we can't even attempt the comparison —
 * missing dir or not a git repo — mirroring `hasUncommittedChanges`'s
 * null-means-"couldn't inspect" contract.
 */
export async function getAheadCount(dir: string, baseRef: string | null): Promise<number | null> {
  if (!existsSync(dir)) return null;
  if (!(await isGitRepo(dir))) return null;

  const upstream = await git(["rev-list", "--count", "@{u}..HEAD"], dir);
  if (upstream.ok) {
    const count = Number.parseInt(upstream.stdout, 10);
    if (!Number.isNaN(count)) return count;
    return null;
  }

  // A "-"-leading ref would parse as a rev-list flag; skip the comparison
  // rather than trust upstream validation (mirrors gitPull's guard), falling
  // through to the unknown-but-not-blocking 0 below.
  if (baseRef && !baseRef.startsWith("-")) {
    const base = await git(["rev-list", "--count", `${baseRef}..HEAD`], dir);
    if (base.ok) {
      const count = Number.parseInt(base.stdout, 10);
      if (!Number.isNaN(count)) return count;
    }
    return null;
  }

  return 0;
}

export interface RemoteSyncState {
  hasUpstream: boolean;
  ahead: number | null;
  behind: number | null;
}

/**
 * Whether `dir`'s current branch has a configured upstream and, if so, how
 * many commits it is ahead/behind that upstream. Drives the "Open PR" gate —
 * a PR only makes sense once the branch exists on the remote and local HEAD
 * has nothing left to push.
 *
 * Deliberately local-only: no `fetch`/`ls-remote`, so this reflects the
 * remote-tracking ref as of the last fetch/push rather than the literal
 * current remote state. That's exactly right for "did my push already
 * land" — `git push` updates the local tracking ref synchronously, so
 * right after a push this is accurate with zero network latency.
 *
 * `hasUpstream: false` (both counts `null`) covers missing dir, not a git
 * repo, or no upstream configured for HEAD — "no upstream" is itself a
 * meaningful, definitive answer (unlike `getAheadCount`'s `null`-means-
 * "unknown" contract, there's no fallback tier here to attempt first).
 * A git failure on the count step (upstream resolved but `rev-list` failed)
 * degrades to `{hasUpstream: true, ahead: null, behind: null}` rather than
 * collapsing back to `hasUpstream: false` — the upstream unambiguously
 * exists, only the counts are unknown.
 */
export async function remoteSyncState(dir: string): Promise<RemoteSyncState> {
  const NO_UPSTREAM: RemoteSyncState = { hasUpstream: false, ahead: null, behind: null };
  if (!existsSync(dir)) return NO_UPSTREAM;
  if (!(await isGitRepo(dir))) return NO_UPSTREAM;

  const upstream = await git(["rev-parse", "--abbrev-ref", "@{u}"], dir);
  if (!upstream.ok || !upstream.stdout) return NO_UPSTREAM;

  // `--left-right --count @{u}...HEAD` prints "<behind>\t<ahead>" — commits
  // only reachable from @{u} (left) vs only reachable from HEAD (right).
  const counts = await git(["rev-list", "--left-right", "--count", "@{u}...HEAD"], dir);
  if (!counts.ok) return { hasUpstream: true, ahead: null, behind: null };

  const [behindRaw, aheadRaw] = counts.stdout.split(/\s+/);
  const behind = Number.parseInt(behindRaw ?? "", 10);
  const ahead = Number.parseInt(aheadRaw ?? "", 10);
  if (Number.isNaN(behind) || Number.isNaN(ahead)) {
    return { hasUpstream: true, ahead: null, behind: null };
  }
  return { hasUpstream: true, ahead, behind };
}

/**
 * The repo's default branch as a ref usable directly with `merge-base` /
 * `rev-parse` — `origin/main`-shaped when the remote advertises one, a bare
 * local `main`/`master` otherwise. Most to least authoritative:
 *
 * 1. `git rev-parse --abbrev-ref origin/HEAD` — the remote's advertised
 *    default (e.g. resolves to `origin/main`). Used verbatim when it
 *    succeeds and isn't the literal unresolved `origin/HEAD` (that string
 *    comes back when the symbolic ref exists but doesn't point anywhere
 *    useful, e.g. no remote configured).
 * 2. No `origin/HEAD` — try local `main`, then `master`, via
 *    `git show-ref --verify --quiet refs/heads/<b>` (exit 0 = branch exists).
 * 3. Neither resolves: return `null` rather than guessing.
 *
 * Callers must treat `null` as *unknown*, never as "there is no default
 * branch". Assumes `dir` is already known to be a git repo — the two callers
 * below both check first, so this doesn't re-spawn `isGitRepo`.
 */
async function resolveDefaultBranchRef(dir: string): Promise<string | null> {
  const originHead = await git(["rev-parse", "--abbrev-ref", "origin/HEAD"], dir);
  if (originHead.ok && originHead.stdout.length > 0 && originHead.stdout !== "origin/HEAD") {
    return originHead.stdout;
  }
  for (const candidate of ["main", "master"]) {
    const ref = await git(["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], dir);
    if (ref.ok) return candidate;
  }
  return null;
}

/**
 * Whether `dir`'s HEAD has already landed on the source repo's default
 * branch — i.e. is an ancestor of it, so the worktree's work is safe to
 * throw away. `null` means "couldn't determine" and must never be presented
 * as merged; callers should treat it as unknown, same contract as
 * `hasUncommittedChanges`/`getAheadCount`.
 *
 * Once `resolveDefaultBranchRef` picks a candidate, `git merge-base
 * --is-ancestor HEAD <default>` maps exit code 0 → `true` (HEAD is an
 * ancestor, i.e. merged), exit code 1 → `false` (diverged/not merged), and
 * any other exit code (git error) → `null`.
 *
 * Runs with `cwd` = `dir`; a linked worktree shares the source repo's refs
 * via its common git dir, so this resolves correctly without needing the
 * source repo's own path.
 */
export async function isMergedIntoDefaultBranch(dir: string): Promise<boolean | null> {
  if (!existsSync(dir)) return null;
  if (!(await isGitRepo(dir))) return null;

  const defaultBranch = await resolveDefaultBranchRef(dir);

  if (!defaultBranch || defaultBranch.startsWith("-")) return null;

  const res = await git(["merge-base", "--is-ancestor", "HEAD", defaultBranch], dir);
  if (res.exitCode === 0) return true;
  if (res.exitCode === 1) return false;
  return null;
}

export interface HeadBranchState {
  /** Short name of the branch `dir` currently has checked out (`main`,
   *  `feat/thing`). `null` on a detached HEAD, a missing dir, or a non-repo —
   *  all three mean "there is no branch to open a PR from". */
  branch: string | null;
  /** `branch` IS the repo's default branch, so a PR from it would degenerate
   *  to base == head. **`false` also covers "couldn't tell"** (no
   *  `origin/HEAD`, no local `main`/`master`) — the caller is a UI gate, and
   *  hiding the affordance on an unresolvable default is the worse failure:
   *  a bogus base == head PR is rejected loudly by GitHub with the branch
   *  pickers right there, whereas a silently missing button reads as the
   *  feature being broken. */
  isDefaultBranch: boolean;
}

/**
 * The branch `dir` is on and whether it's the repo default. Drives the "Create
 * PR" gate for `isolation: "none"` tasks, which have no agetor-managed
 * `task.branch` to key off — the user's own checkout is the head branch.
 *
 * Local-only (no network), same as `remoteSyncState`, since it's polled
 * alongside it every 5s per open run panel.
 */
export async function headBranchState(dir: string): Promise<HeadBranchState> {
  const NONE: HeadBranchState = { branch: null, isDefaultBranch: false };
  if (!existsSync(dir)) return NONE;
  if (!(await isGitRepo(dir))) return NONE;

  // `--abbrev-ref HEAD` prints the literal "HEAD" on a detached checkout.
  const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  if (!head.ok || !head.stdout || head.stdout === "HEAD") return NONE;
  const branch = head.stdout;

  const defaultRef = await resolveDefaultBranchRef(dir);
  if (!defaultRef) return { branch, isDefaultBranch: false };
  // `resolveDefaultBranchRef` returns a remote-qualified ref (`origin/main`)
  // in its first tier and a bare local name (`main`) in its second, so strip
  // one leading remote segment before comparing against a local branch name.
  const defaultName = defaultRef.startsWith("origin/") ? defaultRef.slice("origin/".length) : defaultRef;
  return { branch, isDefaultBranch: branch === defaultName };
}

/**
 * The branch `dir` currently has checked out, read straight from git
 * (`symbolic-ref`), distinguishing the three outcomes callers care about:
 *   • `{ ok: true, branch: "<name>" }` — on a named branch;
 *   • `{ ok: true, branch: null }`     — detached HEAD (nothing to record);
 *   • `{ ok: false, error }`           — the dir is missing, isn't a repo, or
 *                                         git failed/timed out (unknown).
 *
 * Unlike `headBranchState` this does no default-branch lookup and does not
 * collapse "detached" and "couldn't tell" into one value, so a refresh point
 * can decide to write `null` (detached) versus leave the stored value alone
 * (unknown). Never throws; 5 s timeout.
 */
export async function readCheckoutBranch(
  dir: string,
): Promise<{ ok: true; branch: string | null } | { ok: false; error: string }> {
  if (!existsSync(dir)) return { ok: false, error: `directory does not exist: ${dir}` };
  try {
    const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], dir, 5_000);
    if (head.ok) {
      return head.stdout ? { ok: true, branch: head.stdout } : { ok: true, branch: null };
    }
    // `--quiet` makes a detached HEAD exit 1 with no output; any other failure
    // (128 = not a repo / corrupt, a killed timeout, ...) is "unknown".
    if (head.exitCode === 1 && !head.stdout && !head.stderr) return { ok: true, branch: null };
    return { ok: false, error: head.stderr || head.stdout || `git exited ${head.exitCode}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The repo's default branch as a bare local name (`main`), or null when it
 * can't be resolved. Wraps `resolveDefaultBranchRef` (which can return the
 * remote-qualified `origin/main`) and strips the remote/refs prefix so the
 * result is comparable against a local branch name. `root` should be the repo
 * root (or any dir inside the repo). Never throws.
 *
 * Deliberately NOT process-cached (unlike `repoRoot`): a repo's default branch
 * can change mid-session (`git symbolic-ref refs/remotes/origin/HEAD`), and a
 * stale value in a teardown plan could delete the branch that is now the
 * default. Callers that resolve it once per repository per operation memoize
 * locally instead (`teardownBranchesForTask`).
 */
export async function resolveDefaultBranchName(root: string): Promise<string | null> {
  try {
    if (!existsSync(root)) return null;
    const ref = await resolveDefaultBranchRef(root);
    if (!ref) return null;
    const name = ref
      .replace(/^refs\/remotes\/origin\//, "")
      .replace(/^refs\/heads\//, "")
      .replace(/^origin\//, "");
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/** Why `planTeardownBranches` refused to delete a candidate branch. */
export interface TeardownBranchExclusion {
  branch: string;
  reason: "default-branch" | "pr-head" | "held-by-task";
}

/** Which input the second (non-task) branch name came from. */
export type TeardownBranchSource = "live" | "last-seen" | "task-branch" | "none";

/**
 * Pure planner for which git branches deleting a task should remove.
 *
 * Candidates are `taskBranch` (the branch agetor created — never for a PR-head
 * task, `branchSource: "existing"`, whose branch is the user's own) and, when
 * it is a different name, the branch the worktree is actually on: `liveBranch`
 * when readable, else the `lastSeen` value recorded on the task row. Any
 * candidate equal to the repo default (`defaultBranch`, or the literal
 * `main`/`master` when the default couldn't be resolved) or held by another
 * task (`heldByOthers`) is dropped and reported in `excluded` instead.
 *
 * Takes every other row's names as input rather than looking them up: this
 * module must not import `tasks` from db.ts (init cycle, see terminals.ts).
 */
export function planTeardownBranches(input: {
  taskBranch: string | null;
  branchSource: "created" | "existing" | null | undefined;
  liveBranch: string | null;
  lastSeen: string | null;
  defaultBranch: string | null;
  heldByOthers: Set<string>;
}): { branches: string[]; source: TeardownBranchSource; excluded: TeardownBranchExclusion[] } {
  const { taskBranch, branchSource, liveBranch, lastSeen, defaultBranch, heldByOthers } = input;
  const excluded: TeardownBranchExclusion[] = [];
  const candidates: string[] = [];
  const exclude = (branch: string, reason: TeardownBranchExclusion["reason"]): void => {
    if (!excluded.some((e) => e.branch === branch && e.reason === reason)) {
      excluded.push({ branch, reason });
    }
  };
  const consider = (branch: string): void => {
    const isDefault = defaultBranch !== null
      ? branch === defaultBranch
      : branch === "main" || branch === "master";
    if (isDefault) exclude(branch, "default-branch");
    else if (heldByOthers.has(branch)) exclude(branch, "held-by-task");
    else if (!candidates.includes(branch)) candidates.push(branch);
  };

  if (taskBranch) {
    if (branchSource === "existing") exclude(taskBranch, "pr-head");
    else consider(taskBranch);
  }

  // The "other" name: live wins over last-seen, and only counts when it is a
  // different branch from the task's own.
  let source: TeardownBranchSource = taskBranch ? "task-branch" : "none";
  const other = liveBranch ?? lastSeen;
  if (other && other !== taskBranch) {
    source = liveBranch ? "live" : "last-seen";
    consider(other);
  }

  return { branches: candidates, source, excluded };
}

// A directory's git top-level is stable for the lifetime of the process, so
// resolved roots are memoized — discovery (/agent-discovery) resolves the same
// workdir on every refresh and would otherwise spawn a `git rev-parse` for
// both the commands and the extensions pass. Only *successful* lookups are cached:
// a null (not-a-repo) result is left uncached so a mid-session `git init` is
// still picked up on the next call.
const repoRootCache = new Map<string, string>();

/**
 * Return the absolute path of the repo root for `dir`, or null if `dir`
 * isn't a git working tree. We base worktrees off the root, not subdirectories.
 */
export async function repoRoot(dir: string): Promise<string | null> {
  const cached = repoRootCache.get(dir);
  if (cached !== undefined) return cached;
  if (!existsSync(dir)) return null;
  const res = await git(["rev-parse", "--show-toplevel"], dir);
  if (!res.ok) return null;
  repoRootCache.set(dir, res.stdout);
  return res.stdout;
}

/**
 * Git directories that live OUTSIDE `cwd` and therefore must be granted to a
 * codex `workspace-write` sandbox's writable roots for `git commit` (and any
 * other ref/object-writing command) to succeed.
 *
 * For a linked worktree, `cwd`'s `.git` is a *file* pointing at
 * `<source-repo>/.git/worktrees/<id>`, and the objects + refs a commit writes
 * live in the shared `<source-repo>/.git` (the "common dir") — entirely
 * outside the worktree root that codex makes writable by default. Without this,
 * codex's sandbox blocks the write and `git commit` fails inside an agetor
 * worktree. The per-worktree gitdir is a child of the common dir, so a single
 * writable root at the common dir covers both. (The same logic also covers an
 * isolation=none task whose workdir is a subdirectory of the repo, where
 * `.git` sits above the writable cwd.)
 *
 * Returns the absolute git common dir when it isn't contained in `cwd`;
 * returns `[]` for an ordinary checkout where `.git` already sits inside the
 * writable cwd, or when `cwd` isn't a git repo / git is unavailable
 * (non-throwing — callers just get no extra roots).
 *
 * Multi-repository workspaces (issue #291): the agent's cwd is the task
 * workspace root, which is NOT itself a git checkout — it holds one linked
 * worktree per repository. A bare `git rev-parse` there fails, so the old
 * implementation returned `[]` and codex's sandbox stayed on
 * `workspace-write`, blocking every `git add`/`git commit` in the children
 * because their shared `.git` lives in each source repo (outside the
 * workspace). When `cwd` isn't a checkout, resolve every direct child that
 * carries a `.git` pointer file the same way and union the roots. Non-git
 * child directories (a scratch dir an agent created) contribute nothing.
 *
 * Async, via the file's shared `git()` helper (`Bun.spawn` + its own 5s
 * timeout here) rather than a sync `child_process.spawnSync` — the codex
 * spawn paths this feeds (`buildCodexCommand` → `spawnAgent`) run on the same
 * thread that serves `Bun.serve` + the whole orchestrator, so a sync fork
 * would stall every concurrent HTTP/SSE connection for the life of the git
 * call. `--path-format=absolute` (git ≥ 2.31) yields an absolute path
 * directly; the `path.resolve` is belt-and-suspenders for any git that
 * ignores the flag.
 *
 * Containment is checked against the realpath'd cwd: git canonicalizes symlinks
 * in the path it reports (e.g. `/tmp` → `/private/tmp` on macOS), so comparing
 * the reported common dir against a non-canonical `cwd` would otherwise flag an
 * ordinary `.git`-inside-cwd checkout as "outside" and add a redundant root.
 */
export async function gitWritableRoots(cwd: string): Promise<string[]> {
  const self = await gitCommonDirOutside(cwd);
  if (self !== null) return self ? [self] : [];
  // Not a git checkout itself. A multi-repository task workspace is exactly
  // this shape: linked worktrees as direct children. Only children with a
  // `.git` POINTER file can be linked worktrees (an ordinary nested checkout
  // would have a `.git` directory, which is already inside the writable cwd,
  // so it needs no root either).
  return await linkedWorktreeChildRoots(cwd);
}

/**
 * The common dir of `cwd`'s checkout when it lives OUTSIDE `cwd`, `""` when
 * the checkout's `.git` is already inside (no extra root needed), or `null`
 * when `cwd` isn't a git checkout / git is unavailable.
 */
async function gitCommonDirOutside(cwd: string): Promise<string | "" | null> {
  let res: GitResult;
  try {
    res = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd, 5_000);
  } catch {
    // `git()` itself can throw synchronously (`Bun.spawn` throws on a
    // missing `git` binary or a `cwd` that no longer exists) even though
    // THIS function's own contract is non-throwing — a codex spawn on a host
    // without git must proceed unescalated, not hard-fail. Same outcome as
    // every other "can't tell" branch.
    return null;
  }
  if (!res.ok) return null;
  const out = res.stdout;
  if (!out) return null;
  const commonDir = path.resolve(cwd, out);
  let realCwd = cwd;
  try { realCwd = realpathSync(cwd); } catch { /* cwd missing — compare as-is */ }
  const rel = path.relative(realCwd, commonDir);
  const insideCwd = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  return insideCwd ? "" : commonDir;
}

/** Union of external git common dirs for the linked worktrees directly under
 *  a multi-repository workspace root (`<workspace>/<repo-slug>/.git` files). */
async function linkedWorktreeChildRoots(workspace: string): Promise<string[]> {
  let children: string[];
  try {
    children = readdirSync(workspace, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const roots = new Set<string>();
  for (const child of children) {
    const childPath = path.join(workspace, child);
    // Cheap fs gate before spawning git: only a linked worktree has `.git`
    // as a file. A nested ordinary checkout's `.git` is inside the writable
    // workspace root already.
    try {
      if (!lstatSync(path.join(childPath, ".git")).isFile()) continue;
    } catch {
      continue;
    }
    const common = await gitCommonDirOutside(childPath);
    if (common) roots.add(common);
  }
  return [...roots];
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

/**
 * Fill in any per-repository `baseRef` that was never pinned (a row created
 * before a path was a git repository, or a hand-edited/legacy row). The
 * single-repository lazy pin reads the task's own `workdir`; a multi row has
 * no such scalar, so each entry resolves against its own path — the same
 * commit `prepareRepoWorktree` used for that repository's worktree.
 *
 * Returns a new array (entries with an existing pin are passed through
 * unchanged). A repository whose HEAD can't be resolved keeps its null
 * `baseRef` rather than failing the caller, matching the single-repo pin.
 */
export async function pinMissingRepositoryBaseRefs(
  repos: TaskRepository[],
): Promise<TaskRepository[]> {
  return Promise.all(repos.map(async (repo) => {
    if (repo.baseRef) return repo;
    let sha: string | null = null;
    try {
      sha = await resolveRef(repo.path, "HEAD");
    } catch {
      // Missing/deleted repository, or git itself unavailable: keep the null
      // pin like the single-repository lazy pin does.
    }
    return sha ? { ...repo, baseRef: sha } : repo;
  }));
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
export async function listBranches(
  dir: string,
  opts?: { exclude?: Set<string> },
): Promise<BranchInfo[]> {
  const exclude = opts?.exclude;
  const root = await repoRoot(dir);
  if (!root) return [];
  const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  const currentName = head.ok ? head.stdout : null;
  // Tab-separated to keep parsing simple — branch names can't contain tabs.
  // `%(HEAD)` marks the current branch with `*`. Querying both heads and
  // remotes in one pass keeps the sort stable. `%(upstream:short)` /
  // `%(upstream:track)` give the configured upstream + a "[ahead N, behind M]"
  // string, computed locally against the remote-tracking ref (no network), so
  // the behind/ahead counts reflect the last fetch.
  const res = await git(
    [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname)\t%(refname:short)\t%(committerdate:unix)\t%(upstream:short)\t%(upstream:track)",
      "refs/heads/",
      "refs/remotes/",
    ],
    root,
  );
  if (!res.ok) return [];

  // First pass: collect the local head short-names. A remote-tracking ref is
  // only surfaced when it has no local counterpart — and we decide that up front
  // rather than via first-seen dedup because `--sort=-committerdate` can place a
  // remote ref AHEAD of its own local branch when the local branch is behind.
  // First-seen dedup would then keep `origin/main` and drop local `main`,
  // mislabeling the row as remote (losing its `current`/`behind`/`upstream`).
  const localNames = new Set<string>();
  for (const line of res.stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    if (
      parts[0]!.startsWith("refs/heads/") &&
      !parts[1]!.startsWith(LEGACY_BRANCH_PREFIX) &&
      !exclude?.has(parts[1]!)
    ) {
      localNames.add(parts[1]!);
    }
  }

  const seenRemote = new Set<string>();
  const branches: BranchInfo[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const fullRef = parts[0]!;
    const shortName = parts[1]!;
    const ts = Number(parts[2]) * 1000;
    // `for-each-ref` emits all 4 trailing tabs, so these fields are always
    // present (possibly empty). split("\t") keeps trailing empties.
    const upstreamShort = parts[3] ?? "";
    const track = parts[4] ?? "";
    const isRemote = fullRef.startsWith("refs/remotes/");
    if (isRemote) {
      // `origin/HEAD -> origin/main` shows up as a pointer alias; the real
      // `origin/main` row already covers it.
      if (shortName.endsWith("/HEAD")) continue;
      // Strip the `<remote>/` prefix to compare against local names + other
      // remotes (so `origin/main` and a local `main` don't both show).
      const bare = shortName.replace(/^[^/]+\//, "");
      if (localNames.has(bare)) continue; // a local branch with this name wins
      if (seenRemote.has(bare)) continue; // first remote-tracking ref wins among remotes
      seenRemote.add(bare);
    } else {
      // Branches agetor manages itself aren't the user's own — hide them. Local
      // short-names are unique, so no further dedup is needed for heads. Legacy
      // per-task branches carry the `agetor/` prefix; custom-nomenclature ones
      // (feature/…, fix/…) are recognized via the caller-supplied `exclude` set
      // of pinned task branches.
      if (shortName.startsWith(LEGACY_BRANCH_PREFIX)) continue;
      if (exclude?.has(shortName)) continue;
    }
    // Upstream tracking. Only meaningful for local branches with a configured
    // upstream that still exists. `track` looks like "[ahead 2, behind 3]",
    // "[behind 1]", "[gone]", or "" (in sync). An empty `upstreamShort` means
    // no upstream is set; "[gone]" means the upstream ref was deleted — both
    // leave the counts null ("can't compare") rather than 0 ("up to date").
    let upstream: string | null = null;
    let ahead: number | null = null;
    let behind: number | null = null;
    if (!isRemote && upstreamShort && track !== "[gone]") {
      upstream = upstreamShort;
      ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0);
      behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0);
    }
    branches.push({
      name: shortName,
      committedAt: Number.isFinite(ts) ? ts : 0,
      current: !isRemote && shortName === currentName,
      remote: isRemote,
      upstream,
      ahead,
      behind,
    });
  }
  return branches;
}

/**
 * Fetch every remote for the repo containing `dir`, pruning deleted
 * remote-tracking refs so the branch picker mirrors the remote exactly. After
 * this resolves, `listBranches` surfaces any newly-fetched `origin/*` branches.
 *
 * Network-bound, so it gets a longer budget than the default 30 s git()
 * timeout. A repo with no remotes succeeds with no output. Returns
 * `{ ok: false, error }` when `dir` isn't a git repo or the fetch failed — the
 * stderr (where git writes auth/network errors) is surfaced for the UI.
 */
export async function gitFetch(dir: string): Promise<{ ok: boolean; error?: string }> {
  const root = await repoRoot(dir);
  if (!root) return { ok: false, error: "not a git repository" };
  const res = await git(["fetch", "--all", "--prune"], root, 120_000);
  if (!res.ok) return { ok: false, error: res.stderr || `git fetch failed (exit ${res.exitCode})` };
  return { ok: true };
}

/**
 * Fetch a single branch from `origin` into `dir`'s repo — a targeted refresh
 * used before resolving or checking out a pre-existing branch (e.g. a PR's
 * head branch), so `origin/<branch>` reflects the remote even if it was
 * pushed after the last full fetch. Unlike `gitFetch` (`--all --prune`), this
 * touches only the one ref. Callers treat this as best-effort — the ref may
 * already exist locally, so a failure here isn't necessarily fatal.
 */
export async function fetchBranch(dir: string, branch: string): Promise<{ ok: boolean; error?: string }> {
  if (branch.startsWith("-")) return { ok: false, error: `invalid branch name: ${branch}` };
  const root = await repoRoot(dir);
  if (!root) return { ok: false, error: "not a git repository" };
  const res = await git(["fetch", "origin", branch], root, 120_000);
  if (!res.ok) return { ok: false, error: res.stderr || `git fetch failed (exit ${res.exitCode})` };
  return { ok: true };
}

/**
 * Fast-forward a single local `branch` in the repo containing `dir` to its
 * upstream. Always fast-forward-only, so a pull never creates a merge commit or
 * leaves conflicts in the user's repo — a diverged branch fails with a clear
 * message instead.
 *
 * Two cases:
 *  - `branch` is the branch checked out at the repo root → `git pull --ff-only`
 *    (fetches its upstream and fast-forwards in place, updating tracking refs).
 *  - `branch` is any other local branch → refresh its remote-tracking ref over
 *    the network, then fast-forward the local ref from it *without* a checkout.
 *
 * Network-bound, so it gets the same longer budget as `gitFetch`. Returns
 * `{ ok: false, error }` when `dir` isn't a git repo, the branch has no
 * upstream, the fetch failed, or the branch has diverged (non-ff). The stderr
 * (where git writes auth/network/ff errors) is surfaced for the UI.
 */
export async function gitPull(dir: string, branch: string): Promise<{ ok: boolean; error?: string }> {
  // Defense-in-depth: branch names from listBranches can never start with "-"
  // (git's ref-format rules forbid it), but guard anyway so a "-"-leading value
  // can't be read as a flag by the git invocations below. (We avoid git's
  // `--end-of-options` here because `git rev-parse` echoes it back into stdout
  // rather than consuming it, which would corrupt the upstream parse.)
  if (branch.startsWith("-")) return { ok: false, error: `invalid branch name: ${branch}` };
  const root = await repoRoot(dir);
  if (!root) return { ok: false, error: "not a git repository" };

  const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], root, 5_000);
  const current = head.ok ? head.stdout : null;

  if (branch === current) {
    // Checked-out branch: fetch + fast-forward in place (also updates tracking refs).
    const res = await git(["pull", "--ff-only"], root, 120_000);
    if (!res.ok) return { ok: false, error: res.stderr || res.stdout || `git pull failed (exit ${res.exitCode})` };
    return { ok: true };
  }

  // Non-checked-out local branch: resolve its upstream, refresh the tracking ref
  // from the network, then fast-forward the local ref from the tracking ref.
  const up = await git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], root, 5_000);
  if (!up.ok) return { ok: false, error: `"${branch}" has no upstream to pull from` };
  const upstream = up.stdout; // e.g. "origin/main"
  const slash = upstream.indexOf("/");
  if (slash < 0) return { ok: false, error: `"${branch}" has an unexpected upstream "${upstream}"` };
  const remote = upstream.slice(0, slash);
  const remoteBranch = upstream.slice(slash + 1);

  // Update refs/remotes/<remote>/<remoteBranch> from the network.
  const fetched = await git(["fetch", remote, remoteBranch], root, 120_000);
  if (!fetched.ok) return { ok: false, error: fetched.stderr || `git fetch failed (exit ${fetched.exitCode})` };

  // `git fetch .` from the local repo is fast-forward-only — it refuses a non-ff
  // update, which is exactly the divergence guard we want. Fast-forwarding from
  // the freshly-updated tracking ref keeps the behind indicator honest afterwards
  // (a direct `<remoteBranch>:<branch>` fetch would leave the tracking ref stale).
  const ff = await git(
    ["fetch", ".", `refs/remotes/${remote}/${remoteBranch}:refs/heads/${branch}`],
    root,
    10_000,
  );
  if (!ff.ok) {
    return { ok: false, error: ff.stderr || `"${branch}" has diverged from ${upstream}; fast-forward not possible` };
  }
  return { ok: true };
}

/**
 * Push a local `branch` to the repo's remote and set its upstream, so a branch
 * that only exists locally (e.g. an agetor worktree branch) can be turned into a
 * pull request. The target remote is the branch's existing upstream remote if it
 * has one, else `origin`, else the first configured remote.
 *
 * Network-bound, so it gets the same longer budget as `gitFetch`/`gitPull`.
 * Returns `{ ok: false, error }` when `dir` isn't a git repo, has no remote, or
 * the push failed (rejected, auth, network) — the git stderr is surfaced for the
 * UI. On success, `remote` names the remote the branch was pushed to.
 */
export async function gitPush(
  dir: string,
  branch: string,
): Promise<{ ok: boolean; error?: string; remote?: string }> {
  // Defense-in-depth against a "-"-leading value being read as a git flag,
  // mirroring gitPull's guard.
  if (branch.startsWith("-")) return { ok: false, error: `invalid branch name: ${branch}` };
  const root = await repoRoot(dir);
  if (!root) return { ok: false, error: "not a git repository" };

  // Prefer the branch's existing upstream remote; fall back to `origin`, then the
  // first configured remote. No remotes → nothing to push to.
  let remote: string;
  const up = await git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], root, 5_000);
  if (up.ok && up.stdout.includes("/")) {
    remote = up.stdout.slice(0, up.stdout.indexOf("/"));
  } else {
    const remotes = await git(["remote"], root, 5_000);
    const list = remotes.ok ? remotes.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    if (list.length === 0) return { ok: false, error: "no git remote configured to push to" };
    remote = list.includes("origin") ? "origin" : list[0]!;
  }

  // `--set-upstream` so subsequent PR creation and the behind indicator have a
  // tracking ref to work against. The leading-dash guard above is what keeps the
  // branch arg from being read as a flag (git push has no `--end-of-options`).
  const res = await git(["push", "--set-upstream", remote, branch], root, 120_000);
  if (!res.ok) return { ok: false, error: res.stderr || res.stdout || `git push failed (exit ${res.exitCode})` };
  return { ok: true, remote };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";
}

export function branchName(task: Pick<Task, "id" | "title">): string {
  return `${LEGACY_BRANCH_PREFIX}${task.id.replace(/-/g, "").slice(0, 12)}-${slugify(task.title)}`;
}

/**
 * Whether a failed `git worktree add` means "that branch name is taken" — a
 * create-time uniqueness race we can recover from by re-pinning. Git words it
 * differently depending on which add form was used:
 *   • `worktree add <path> <branch>`    → "'X' is already used by worktree at …"
 *                                          (older git: "is already checked out at …")
 *   • `worktree add -b <branch> <path>` → "a branch named 'X' already exists"
 *
 * Deliberately excludes `"'<path>' already exists"` — a stale worktree directory,
 * where renaming the branch would not help and the error should surface as-is.
 */
export function isBranchNameTakenError(output: string): boolean {
  return /is already used by worktree|already checked out|a branch named .* already exists/i
    .test(output);
}

/**
 * Return a branch name based on `desired` that is free within the repo at
 * `root`: not already a local branch AND not in `taken` (the set of names
 * pinned on other task rows, which may not exist as refs yet because branches
 * are created lazily at start-time). Appends `-2`, `-3`, … until a free name
 * is found. Guards against two tasks with the same title+type — and therefore
 * the same computed name — colliding on one branch.
 */
export async function ensureUniqueBranch(
  root: string,
  desired: string,
  taken: Set<string>,
): Promise<string> {
  const free = async (name: string): Promise<boolean> => {
    if (taken.has(name)) return false;
    const res = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], root, 5_000);
    return !res.ok; // rev-parse fails (non-zero) when the ref doesn't exist
  };
  if (await free(desired)) return desired;
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${desired}-${n}`;
    if (await free(candidate)) return candidate;
  }
  return desired; // give up after 10k collisions — practically unreachable
}

export function worktreePath(task: Task): string {
  return path.join(WORKTREES_DIR, task.id);
}

/**
 * The workspace root a multi-repository task's worktrees live under.
 *
 * A multi row mirrors its workspace in BOTH `workdir` and `worktreePath`, so a
 * pipeline step — which copies its parent's workspace onto its own row — must
 * reuse that path instead of deriving a fresh `<WORKTREES_DIR>/<step-id>` from
 * its own id (that would materialize a second, empty workspace and strand the
 * parent's repositories). Falls back to the canonical per-task path when the
 * mirrored path is absent or outside `WORKTREES_DIR` (a hand-edited/corrupt
 * row must never widen the ownership boundary).
 */
export function workspacePathFor(task: Task): string {
  const mirrored = task.worktreePath ?? task.workdir;
  if (mirrored && lexicallyInsideRoot(WORKTREES_DIR, mirrored)) return mirrored;
  return worktreePath(task);
}

/** The `GET /worktrees` row id for one repository of a multi-repo task. */
export function worktreeIdForRepo(taskId: string, repoName: string): string {
  return `${taskId}__${repoName}`;
}

/** A single path segment that is safe to join onto a trusted root. */
function isSafeSegment(segment: string): boolean {
  return (
    segment.length > 0
    && segment !== "."
    && segment !== ".."
    && !segment.includes("/")
    && !segment.includes("\\")
    && path.basename(segment) === segment
  );
}

export interface ResolvedWorktreeRef {
  /** Absolute path of the worktree directory. */
  path: string;
  /** Owning task id (parsed from a nested `<taskId>__<slug>` id too). */
  taskId: string;
  /** Repository slug for a nested id, else null. */
  repoName: string | null;
}

/**
 * The single id-to-path guard for `DELETE /worktrees/:id` and
 * `GET /worktrees/:id/git-status` (issue #291). Accepts either a direct child
 * id (`<taskId>`, today's layout) or a nested multi-repo id
 * (`<taskId>__<slug>`). Every segment must be non-empty, not `.`/`..`, free of
 * `/` and `\`, and equal its own basename; the final path must be a direct
 * child of its parent, and the parent a direct child of `WORKTREES_DIR`. Any
 * violation is refused rather than normalized.
 */
export function resolveWorktreeRef(
  id: string,
): { ok: true; value: ResolvedWorktreeRef } | { ok: false; error: string } {
  if (!isSafeSegment(id)) return { ok: false, error: "invalid worktree id" };
  const sepAt = id.indexOf("__");
  if (sepAt < 0) {
    const full = path.join(WORKTREES_DIR, id);
    if (path.dirname(full) !== WORKTREES_DIR) return { ok: false, error: "invalid worktree id" };
    return { ok: true, value: { path: full, taskId: id, repoName: null } };
  }
  const taskId = id.slice(0, sepAt);
  const repoName = id.slice(sepAt + 2);
  // Task ids are UUIDs and never contain an underscore, so the first `__` is
  // the unambiguous boundary even when the slug itself contains `__`.
  if (!isSafeSegment(taskId) || !isSafeSegment(repoName)) {
    return { ok: false, error: "invalid worktree id" };
  }
  const parent = path.join(WORKTREES_DIR, taskId);
  const full = path.join(parent, repoName);
  if (path.dirname(parent) !== WORKTREES_DIR || path.dirname(full) !== parent) {
    return { ok: false, error: "invalid worktree id" };
  }
  return { ok: true, value: { path: full, taskId, repoName } };
}

/** A `.git` pointer file is one `gitdir: <path>` line; anything bigger is not one. */
const GIT_POINTER_MAX_BYTES = 8 * 1024;

/**
 * Best-effort parse of a linked worktree's `.git` file — for a worktree
 * (unlike an ordinary checkout) `.git` is a *file* containing a single line
 * `gitdir: <repo>/.git/worktrees/<id>`, pointing back at the source repo's
 * common dir. Used for orphaned worktree dirs (no task row to read `workdir`
 * from) so the worktrees list can still show which repo they came from.
 *
 * Plain fs only — no git subprocess. Returns null when `.git` is missing,
 * isn't a pointer file, or the path doesn't match the expected
 * `.git/worktrees/<id>` shape.
 */
export function parseWorktreeGitPointer(worktreeDir: string): string | null {
  try {
    // Everything under the worktrees dir is agent-writable, and `GET /worktrees`
    // is open to the CLI token: never follow a planted symlink (the worktree
    // dir or its `.git`) into a protected folder in-process, never block on a
    // FIFO, and never slurp more than a pointer file's worth (no-follow.ts).
    if (!lstatSync(worktreeDir).isDirectory()) return null;
    const gitFile = path.join(worktreeDir, ".git");
    const contents = readTextNoFollow(gitFile, { maxBytes: GIT_POINTER_MAX_BYTES }).trim();
    const match = /^gitdir:\s*(.+)$/.exec(contents);
    if (!match) return null;
    const gitdir = match[1]!;
    const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
    const idx = gitdir.indexOf(marker);
    if (idx < 0) return null;
    // Exactly ONE segment follows the marker: `.git/worktrees/<id>`.
    // A submodule checked out inside a linked worktree points at
    // `<repo>/.git/worktrees/<id>/modules/<sub>` — the same marker, with a
    // deeper tail. Treating that as a linked worktree would split one
    // single-repository worktree into bogus nested repository rows (and,
    // for an orphan, attribute its checkout to the submodule path).
    const remainder = gitdir.slice(idx + marker.length);
    if (!remainder || remainder.includes("/") || remainder.includes(path.sep)) return null;
    return gitdir.slice(0, idx);
  } catch {
    return null;
  }
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
  /**
   * The branch actually checked out in `cwd` at the moment of the call: the
   * live name when an existing worktree was reused (which may differ from
   * `branch` if the user or an agent switched it — drift is tolerated, never
   * corrected), the branch the worktree was just created/re-attached on
   * otherwise. `null` for a detached HEAD, an unreadable checkout, or when no
   * worktree is involved (`isolation: "none"`). Callers record it as the
   * task's last-seen checkout; `branch` stays "the branch agetor created".
   */
  checkoutBranch: string | null;
  /**
   * Whether `checkoutBranch` is an actual reading of the worktree: `true` for
   * a successful read (a detached HEAD included) and for a worktree that was
   * just created or re-attached; `false` when the reuse-path read failed or no
   * worktree is involved. Callers must only record `checkoutBranch` when this
   * is `true` — an unknown read stored as `null` would erase the recorded
   * drifted branch (the badge, delete-time teardown and unarchive restore all
   * read it), matching `readCheckoutBranch`'s own keep-on-failure contract.
   * See `recordableCheckout`.
   */
  checkoutKnown: boolean;
  /**
   * A non-fatal problem worth surfacing in the run log — currently only: the
   * recorded checkout branch could not be restored on re-attach, so the
   * worktree came back on `task.branch` instead.
   */
  warning?: string;
  /**
   * For a multi-repository task, the materialized entries (each with its
   * branch/worktree/baseRef). `cwd` is the task workspace root. Absent for a
   * single-repository task.
   */
  repositories?: TaskRepository[];
}

/**
 * The value a caller should record as the task's last-seen checkout after a
 * `prepareWorkdir`, or `undefined` when there is nothing to record — no
 * worktree (`isolation: "none"`), or the reuse-path read failed. Keeping the
 * stored value on `undefined` is what stops a transient git failure from
 * erasing a recorded drifted branch.
 */
export function recordableCheckout(prepared: PreparedWorkdir): string | null | undefined {
  if (!prepared.worktreePath || !prepared.checkoutKnown) return undefined;
  return prepared.checkoutBranch;
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
export async function prepareWorkdir(
  task: Task,
  opts?: {
    /**
     * Branch names already pinned on other task rows. Used by the collision
     * recovery below so a re-pin can't steal a name a not-yet-started task is
     * holding (those have no git ref yet, so a ref-only search can't see them).
     */
    takenBranches?: Set<string>;
  },
): Promise<PrepareResult> {
  if (task.isolation !== "worktree") {
    return { cwd: task.workdir, branch: null, worktreePath: null, note: "isolation: none", checkoutBranch: null, checkoutKnown: false };
  }

  const root = await repoRoot(task.workdir);
  if (!root) {
    return {
      error: `worktree isolation is on but "${task.workdir}" is not inside a git repo — change isolation to "none" or point workdir at a git repo`,
    };
  }

  // Reuse if previously created and still on disk.
  if (task.worktreePath && task.branch && existsSync(task.worktreePath)) {
    // Branch drift is tolerated, never corrected. A user (or the agent itself)
    // may have switched this worktree onto another branch; we read the live
    // name purely to report it. We deliberately do NOT `git checkout
    // task.branch`: a checkout can fail on conflicting uncommitted edits, and
    // when it succeeds it silently switches the branch under a live agent or
    // an open terminal. `task.branch` stays "the branch agetor created"; the
    // live name travels back as `checkoutBranch` for callers to record. A
    // failed read is unknown (`checkoutKnown: false`) — it must not fail the
    // prepare, and callers must not record it over the stored value.
    const live = await readCheckoutBranch(task.worktreePath);
    const checkoutBranch = live.ok ? live.branch : null;
    let where: string;
    if (!live.ok) where = `on ${task.branch}`;
    else if (checkoutBranch === null) where = `(detached HEAD; task branch ${task.branch})`;
    else if (checkoutBranch !== task.branch) where = `on ${checkoutBranch} (task branch ${task.branch})`;
    else where = `on ${task.branch}`;
    return {
      cwd: task.worktreePath,
      branch: task.branch,
      worktreePath: task.worktreePath,
      note: `reusing worktree at ${task.worktreePath} ${where}`,
      checkoutBranch,
      checkoutKnown: live.ok,
    };
  }

  mkdirSync(WORKTREES_DIR, { recursive: true });
  const wt = worktreePath(task);
  // Branch name: pinned at create time (task.branch is set by createTask for
  // worktree-isolation tasks). Fall back to computing it for legacy rows
  // created before the pinning was added.
  return prepareRepoWorktree({
    root,
    worktreePath: wt,
    branch: task.branch ?? branchName(task),
    branchSource: task.branchSource,
    baseRef: task.baseRef,
    recordedCheckout: task.checkoutBranch ?? null,
    takenBranches: opts?.takenBranches ?? new Set(),
    reattach: Boolean(task.worktreePath),
    fetchExisting: true,
  });
}

/** Inputs for {@link prepareRepoWorktree} — the body of `prepareWorkdir`'s
 *  creation path, extracted so a multi-repository task can run it once per
 *  repository (issue #291). */
export interface PrepareRepoWorktreeArgs {
  /** The source repo's git top-level. */
  root: string;
  /** The linked-worktree directory to create (`<workspace>/<slug>`). */
  worktreePath: string;
  /** The branch to attempt first (a create-time collision may re-pin it). */
  branch: string;
  branchSource: "created" | "existing";
  /** Pinned base sha, or null to use the repo's HEAD. */
  baseRef: string | null;
  /** The branch agetor last recorded for this worktree, if any. */
  recordedCheckout: string | null;
  /** Branch names pinned on other tasks, to avoid a collision-recovery steal. */
  takenBranches: Set<string>;
  /**
   * True when this worktree materialized before (the task/worktree entry has a
   * path). Disables collision recovery: a re-attach failure must stay a hard
   * error so a previous run's commits are never silently orphaned.
   */
  reattach: boolean;
  /** Fetch a `branchSource: "existing"` branch from origin first (single-repo). */
  fetchExisting?: boolean;
}

export interface PreparedRepoWorktree extends PreparedWorkdir {
  branch: string;
  /** True when THIS call minted the branch (safe to delete on rollback). */
  createdBranch: boolean;
}

/**
 * Materialize ONE repository's linked worktree at `worktreePath` using
 * `branch`, restoring the recorded checkout when it still exists and falling
 * back to the shared branch name. This is today's `prepareWorkdir` creation
 * body, parameterized so the multi-repository path reuses exactly the same
 * reuse/drift/re-attach/collision semantics per repository.
 */
export async function prepareRepoWorktree(
  args: PrepareRepoWorktreeArgs,
): Promise<PreparedRepoWorktree | PrepareError> {
  const { root, worktreePath: wt, branchSource, baseRef, recordedCheckout, takenBranches, reattach } = args;
  let branch = args.branch;
  // Pinned base sha if set; otherwise use HEAD at start time. The sha makes
  // the start state sticky across re-runs even when HEAD moves.
  const base = baseRef ?? "HEAD";

  // For a task pinned to a pre-existing branch (e.g. a PR's head branch),
  // refresh it from origin before deciding how to materialize the worktree —
  // best-effort, since the branch may already be present locally with no
  // remote at all. Multi-repo entries are always `"created"` in v1.
  if (branchSource === "existing" && args.fetchExisting !== false) {
    await fetchBranch(root, branch);
  }

  // If the branch already exists (e.g. the worktree dir was manually deleted
  // but the branch survived), re-attach rather than reset — using `-B` would
  // forcibly rewind the branch back to `base`, discarding any commits the
  // previous run made.
  const branchExists = (await git(["rev-parse", "--verify", `refs/heads/${branch}`], root, 5_000)).ok;
  // Prune stale worktree registrations before any `add` — git rejects adding
  // a path it still tracks as a missing-but-registered worktree without a
  // prune step first.
  await git(["worktree", "prune"], root, 10_000);
  // Re-attach prefers the checkout agetor last recorded for this task (e.g. an
  // archived task whose worktree had drifted onto another branch), so unarchive
  // / restore brings the worktree back where the user left it — whenever that
  // branch still exists and differs from the task branch, even if the task
  // branch itself is gone (the work lives on the recorded branch, so recreating
  // `task.branch` from base would bring the worktree back without it). When the
  // recorded branch is missing or the attach fails (say it is checked out
  // elsewhere), fall back to the task branch and say so via `warning`.
  const recorded = recordedCheckout;
  const wantsRecorded = recorded !== null && recorded !== branch;
  const recordedExists = wantsRecorded
    && (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${recorded}`], root, 5_000)).ok;
  let restoredOn: string | null = null;
  let createdBranch = false;
  const warnings: string[] = [];
  let created: GitResult | null = null;
  if (recordedExists) {
    const onRecorded = await git(["worktree", "add", wt, recorded], root);
    if (onRecorded.ok) {
      restoredOn = recorded;
      created = onRecorded;
      // A PR-head task's branch may live only as `origin/<branch>` (fetchBranch
      // refreshes the remote-tracking ref, never a local one), so a missing
      // local ref alone doesn't mean the task branch is gone.
      if (!branchExists) {
        const onOrigin = branchSource === "existing"
          && (await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], root, 5_000)).ok;
        if (!onOrigin) warnings.push(`task branch ${branch} no longer exists — restored on ${recorded}`);
      }
    } else {
      const why = (onRecorded.stderr || onRecorded.stdout).split("\n")[0] ?? "";
      warnings.push(`could not restore recorded checkout ${recorded}${why ? ` (${why})` : ""} — restored on ${branch}`);
    }
  } else if (wantsRecorded) {
    warnings.push(`recorded checkout ${recorded} no longer exists — restored on ${branch}`);
  }
  if (!created) {
    if (branchExists) {
      created = await git(["worktree", "add", wt, branch], root);
    } else if (branchSource === "existing") {
      created = await git(["worktree", "add", "--track", "-b", branch, wt, `origin/${branch}`], root);
    } else {
      // A re-attach (the task materialized before) whose branch was deleted by
      // hand: the branch comes back fresh from base, without the previous
      // run's commits — say so rather than let it pass silently.
      if (reattach) warnings.push(`task branch ${branch} no longer exists — recreated it from ${base === "HEAD" ? "HEAD" : base.slice(0, 7)}`);
      created = await git(["worktree", "add", "-b", branch, wt, base], root);
      if (created.ok) createdBranch = true;
    }
  }

  // Collision recovery — ONLY on a first materialization (`!reattach`).
  //
  // Branch names are pinned at create time but only materialized here, so two
  // tasks that computed the same name (a create-time uniqueness race — neither
  // branch exists as a ref yet, so the create-time dedup can't see its twin) can
  // end up pointing at one branch. Depending on which task wins, git rejects the
  // loser in one of two ways, so neither `branchExists` arm can be assumed:
  //   • re-attach path (branchExists) → "'X' is already used by worktree at …"
  //   • new-branch path (-b)          → "a branch named 'X' already exists"
  //     (the twin created it between our branchExists probe and this add)
  // Rather than fail the run, pin a fresh unique variant off the base. The
  // re-pinned name flows back via the returned `branch`; startTask persists it.
  //
  // The `!reattach` gate is load-bearing. Once a task HAS materialized,
  // `task.branch` is ours and may hold the previous run's commits; we reach this
  // code again only when the worktree dir was deleted, and the `worktree add`
  // above is a deliberate *re-attach* that preserves those commits (see the `-B`
  // note further up). Re-pinning there would create a fresh branch at `base` and
  // silently orphan that work — so a re-attach failure must stay a hard error
  // (e.g. the user checked the branch out in their main repo; they can free it).
  //
  // `takenBranches` keeps the replacement from stealing a name that another task
  // has pinned but not yet started (no ref exists for those, so a ref-only search
  // would miss them). See `isBranchNameTakenError` for the exact git wordings,
  // and what it deliberately does not match (e.g. a stale worktree directory).
  //
  // Excluded for `branchSource === "existing"`: that branch name is the PR's
  // real head branch, not one agetor minted — re-pinning it to a fresh variant
  // would silently disconnect the task from the branch the user asked for. A
  // collision there (branch checked out elsewhere) surfaces as a hard error.
  if (
    !created.ok &&
    !reattach &&
    branchSource !== "existing" &&
    isBranchNameTakenError(`${created.stderr}\n${created.stdout}`)
  ) {
    const unique = await ensureUniqueBranch(root, branch, takenBranches);
    if (unique !== branch) {
      const retry = await git(["worktree", "add", "-b", unique, wt, base], root);
      if (retry.ok) {
        branch = unique;
        created = retry;
        createdBranch = true;
      }
    }
  }

  if (!created.ok) {
    const detail = created.stderr || created.stdout;
    if (branchSource === "existing") {
      const used = /already used by worktree at '?([^'\n]+)'?/.exec(detail);
      if (used) {
        return {
          error: `'${branch}' is currently checked out in ${used[1]} — switch that working tree to another branch, then start the task again`,
        };
      }
    }
    return {
      error: `worktree creation failed: ${detail}`,
    };
  }

  const warning = warnings.length > 0 ? warnings.join("; ") : undefined;
  if (restoredOn) {
    return {
      cwd: wt,
      branch,
      worktreePath: wt,
      note: `restored worktree at ${wt} on ${restoredOn} (task branch ${branch})`,
      checkoutBranch: restoredOn,
      checkoutKnown: true,
      createdBranch,
      ...(warning ? { warning } : {}),
    };
  }

  const baseLabel = baseRef ? `base: ${baseRef.slice(0, 7)}` : `base: ${root} HEAD`;
  return {
    cwd: wt,
    branch,
    worktreePath: wt,
    note: `created worktree at ${wt} on ${branch} (${baseLabel})`,
    checkoutBranch: branch,
    checkoutKnown: true,
    createdBranch,
    ...(warning ? { warning } : {}),
  };
}

/** How many repositories prepare/teardown in parallel per task. */
export const MULTI_REPO_CONCURRENCY = 4;

/** Bounded `Promise.all` — runs at most `limit` calls at once, preserving order. */
async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Materialize a task's working directory. A single-repository task (or a
 * legacy row, whose `repositories` has one derived entry) delegates to
 * {@link prepareWorkdir} unchanged, so its behavior is byte-identical. A
 * multi-repository task gets a per-task workspace root
 * (`<WORKTREES_DIR>/<task-id>`) with one linked worktree per repository
 * (`<workspace>/<slug>`) and returns the workspace as `cwd`.
 *
 * All-or-nothing: every repository is attempted (at most
 * {@link MULTI_REPO_CONCURRENCY} at a time) so one failure doesn't hide the
 * others; if any fails, worktrees and branches created in THIS attempt are
 * removed, any pre-existing/reused ones are left alone, and the returned error
 * names every failed repository. `takenBranches` is keyed by source git root.
 */
export async function prepareTaskWorkdir(
  task: Task,
  opts?: { takenBranches?: Map<string, Set<string>> },
): Promise<PrepareResult> {
  const repos = task.repositories ?? [];
  if (repos.length <= 1) {
    // Preserve the single-repo contract exactly: `takenBranches` was a global
    // set before the repository dimension existed, so fold every root's set.
    const taken = new Set<string>();
    for (const set of opts?.takenBranches?.values() ?? []) for (const b of set) taken.add(b);
    return prepareWorkdir(task, { takenBranches: taken });
  }
  if (task.isolation !== "worktree") {
    return { error: "multi-repository tasks require worktree isolation" };
  }

  const workspace = workspacePathFor(task);
  mkdirSync(workspace, { recursive: true });

  interface Attempt {
    repo: TaskRepository;
    createdHere: boolean;
    result: PreparedRepoWorktree | PrepareError;
    root: string | null;
  }

  const attempts = await mapBounded(repos, MULTI_REPO_CONCURRENCY, async (repo): Promise<Attempt> => {
    const root = await repoRoot(repo.path);
    if (!root) {
      return {
        repo,
        createdHere: false,
        root: null,
        result: { error: `"${repo.path}" is not inside a git repository` },
      };
    }
    const target = path.join(workspace, repo.name);
    if (path.dirname(target) !== workspace || !lexicallyInsideRoot(workspace, target)) {
      return {
        repo,
        createdHere: false,
        root,
        result: { error: `invalid workspace name "${repo.name}"` },
      };
    }
    const branch = repo.branch ?? task.branch ?? branchName(task);

    // Reuse an existing worktree exactly like the single-repo path: report the
    // live checkout, never check out or create anything.
    if (repo.worktreePath && existsSync(repo.worktreePath)) {
      const live = await readCheckoutBranch(repo.worktreePath);
      const checkoutBranch = live.ok ? live.branch : null;
      let where: string;
      if (!live.ok) where = `on ${branch}`;
      else if (checkoutBranch === null) where = `(detached HEAD; task branch ${branch})`;
      else if (checkoutBranch !== branch) where = `on ${checkoutBranch} (task branch ${branch})`;
      else where = `on ${branch}`;
      return {
        repo,
        createdHere: false,
        root,
        result: {
          cwd: repo.worktreePath,
          branch,
          worktreePath: repo.worktreePath,
          note: `reusing worktree at ${repo.worktreePath} ${where}`,
          checkoutBranch,
          checkoutKnown: live.ok,
          createdBranch: false,
        },
      };
    }

    const result = await prepareRepoWorktree({
      root,
      worktreePath: target,
      branch,
      branchSource: repo.branchSource ?? "created",
      baseRef: repo.baseRef,
      recordedCheckout: repo.checkoutBranch ?? null,
      // Pins are keyed by the selected project path (`branchesPinnedByOtherTasks`);
      // fall back to the git root so a row that selected a subdirectory of the
      // same repository still sees the other task's pin.
      takenBranches: opts?.takenBranches?.get(repo.path) ?? opts?.takenBranches?.get(root) ?? new Set(),
      reattach: Boolean(repo.worktreePath),
      fetchExisting: false,
    });
    return { repo, createdHere: !repo.worktreePath, root, result };
  });

  const failures = attempts.filter((a) => "error" in a.result);
  if (failures.length > 0) {
    // Roll back only what THIS attempt created (a rolled-back branch is one we
    // just minted, so deleting it can't lose the user's work). Best-effort,
    // async, and ordered so two repos never race each other into a deadlock.
    await mapBounded(attempts, MULTI_REPO_CONCURRENCY, async (a) => {
      if (!a.createdHere || !a.root || "error" in a.result) return;
      const wt = a.result.worktreePath ?? path.join(workspace, a.repo.name);
      const branch = a.result.createdBranch ? a.result.branch : null;
      await git(["worktree", "remove", "--force", wt], a.root);
      if (branch) await git(["branch", "-D", branch], a.root);
      await git(["worktree", "prune"], a.root, 10_000);
    });
    removeWorkspaceIfEmpty(workspace);
    return {
      error: `could not prepare ${failures.length} of ${repos.length} repositories:\n${failures
        .map((f) => `- ${f.repo.name} (${f.repo.path}): ${("error" in f.result && f.result.error) || "unknown error"}`)
        .join("\n")}`,
    };
  }

  const preparedEntries: TaskRepository[] = [
    ...attempts.map((a) => {
      const res = a.result as PreparedRepoWorktree;
      return {
        ...a.repo,
        branch: res.branch,
        worktreePath: res.worktreePath ?? path.join(workspace, a.repo.name),
        checkoutBranch: res.checkoutKnown ? res.checkoutBranch : a.repo.checkoutBranch,
      };
    }),
  ];
  const warnings = attempts
    .map((a) => (a.result as PreparedRepoWorktree).warning)
    .filter((w): w is string => Boolean(w));
  const notes = attempts.map((a) => (a.result as PreparedRepoWorktree).note);
  return {
    cwd: workspace,
    branch: null,
    worktreePath: workspace,
    note: `workspace ${workspace} — ${notes.join("; ")}`,
    checkoutBranch: null,
    checkoutKnown: false,
    repositories: preparedEntries,
    ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
  };
}

/**
 * Remove the agetor-owned scratch dirs a claude session leaves in a task
 * workspace root, so the root can be removed once its repository worktrees
 * are gone. `ensureInstalledForCwd` writes `<workspace>/.claude/settings.local.json`
 * on every claude spawn (cwd is the workspace root for a multi-repository
 * task); `git worktree remove` can't clear that because the root is not
 * itself a worktree. Only agetor's own settings file is touched — anything
 * else in `.claude` (or the root) is agent/user data and keeps the directory
 * alive, exactly like the non-recursive contract below. `.claude` is removed
 * only once it is empty.
 */
function pruneWorkspaceScratch(dir: string): void {
  const claudeDir = path.join(dir, ".claude");
  try {
    if (!lstatSync(claudeDir).isDirectory()) return;
    const settings = path.join(claudeDir, "settings.local.json");
    if (lstatSync(settings).isFile()) rmSync(settings, { force: true });
    if (readdirSync(claudeDir).length === 0) rmdirSync(claudeDir);
  } catch {
    /* best-effort — missing dir/file, permissions, ... */
  }
}

/**
 * True when a task workspace holds nothing but agetor's own scratch: no
 * entries at all, or only a `.claude` directory containing just
 * `settings.local.json`. `false` for any agent/user artifact (including any
 * other file or directory inside `.claude`), a missing/unreadable root, or a
 * `.claude` that isn't a directory.
 *
 * The boot sweep uses this to decide whether a teardown job would still have
 * something to do. Checking only for the `.claude` entry itself treated a
 * workspace left with real agent content inside `.claude` as reclaimable and
 * re-enqueued a no-op teardown on every boot.
 */
export function workspaceHasOnlyAgetorScratch(dir: string): boolean {
  let entries: string[];
  try {
    if (!lstatSync(dir).isDirectory()) return false;
    entries = readdirSync(dir);
  } catch {
    return false; // missing or unreadable — nothing to reclaim
  }
  if (entries.length === 0) return true;
  if (entries.some((entry) => entry !== ".claude")) return false;
  try {
    const claudeDir = path.join(dir, ".claude");
    if (!lstatSync(claudeDir).isDirectory()) return false;
    return readdirSync(claudeDir).every((entry) => entry === "settings.local.json");
  } catch {
    return false;
  }
}

/**
 * Remove a multi-repository workspace root only when nothing else is left in
 * it (never a recursive wipe — an agent may have written notes or artifacts
 * the user still wants). Agetor's own `.claude/settings.local.json` scratch
 * is pruned first so a completed teardown doesn't strand
 * `<WORKTREES_DIR>/<task-id>` forever.
 *
 * Exported because the Worktrees page's orphan cleanup
 * (`deleteOrphanWorktree` in orchestrator.ts) removes the same nested root
 * after its last repository child is deleted.
 */
export function removeWorkspaceIfEmpty(dir: string): void {
  if (!workspaceHasOnlyAgetorScratch(dir)) return;
  pruneWorkspaceScratch(dir);
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    /* best-effort */
  }
}

// Process at most this many newly-created (untracked) files. Each costs a
// `git diff --no-index` spawn, so cap to keep a runaway scratch dir cheap.
const MAX_UNTRACKED = 200;
/**
 * Compute everything a task changed in its working directory — committed AND
 * uncommitted changes to tracked files, plus newly created (untracked) files
 * synthesized as full additions.
 *
 * For worktree-isolated tasks the diff is against the pinned `baseRef`; for
 * isolation=none tasks it's against the workdir's current `HEAD` (so the user
 * still gets uncommitted changes + untracked files, just without a stable
 * pinned base — there isn't one without isolation).
 *
 * Returns a friendly `note` (and empty `files`) when there's nothing to show.
 * Never throws.
 */
export async function getTaskDiff(task: Task, repoName?: string | null): Promise<TaskDiff> {
  let cwd: string;
  let base: string;
  let shortBase: string | null;
  let emptyNote: string;
  let repo: string | null = null;

  if ((task.repositories?.length ?? 0) > 1) {
    const repos = task.repositories!;
    const entry = repoName ? repos.find((r) => r.name === repoName) : repos[0];
    if (!entry) {
      return { base: null, files: [], note: `Unknown repository "${repoName}".`, repo: repoName ?? null };
    }
    repo = entry.name;
    const entryPath = entry.worktreePath ?? path.join(worktreePath(task), entry.name);
    if (!existsSync(entryPath)) {
      return {
        base: null,
        files: [],
        repo,
        note: "This repository hasn't created a worktree yet — run the task to see its changes here.",
      };
    }
    cwd = entryPath;
    base = entry.baseRef ?? "HEAD";
    shortBase = entry.baseRef ? entry.baseRef.slice(0, 7) : null;
    emptyNote = "No changes yet — the worktree matches its base.";
  } else if (task.isolation === "worktree") {
    if (!task.worktreePath || !existsSync(task.worktreePath)) {
      return { base: null, files: [], note: "This task hasn't created a worktree yet — run it to see its changes here." };
    }
    cwd = task.worktreePath;
    base = task.baseRef ?? "HEAD";
    shortBase = task.baseRef ? task.baseRef.slice(0, 7) : null;
    emptyNote = "No changes yet — the worktree matches its base.";
  } else {
    if (!existsSync(task.workdir) || !(await isGitRepo(task.workdir))) {
      return { base: null, files: [], note: "Diff isn't available — the task's workdir isn't a git repo." };
    }
    // A fresh `git init` has no HEAD yet — `git diff HEAD` would fail with
    // "ambiguous argument 'HEAD'". Short-circuit with a friendlier note
    // instead of leaking the raw git error.
    const head = await git(["rev-parse", "--verify", "HEAD"], task.workdir, 5_000);
    if (!head.ok) {
      return { base: null, files: [], note: "Diff isn't available yet — the workdir has no commits to diff against." };
    }
    cwd = task.workdir;
    base = "HEAD";
    shortBase = null;
    emptyNote = "No changes yet — the workdir matches HEAD.";
  }

  // Tracked changes (committed + working-tree) vs the base.
  const tracked = await git(["diff", "--no-color", base], cwd);
  if (!tracked.ok) {
    return { base: shortBase, files: [], repo, note: `Could not compute diff: ${tracked.stderr || tracked.stdout || "git diff failed"}` };
  }
  const files = parseGitDiff(tracked.stdout);

  // Newly created files aren't part of `git diff <base>`; surface them as
  // full additions via --no-index (which exits 1 when content differs).
  const listed = await git(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
  if (listed.ok) {
    const rels = listed.stdout.split("\0").filter(Boolean).slice(0, MAX_UNTRACKED);
    // `ls-files` (and the `--no-index` diff below) run in `cwd`, so `rel` is
    // CWD-relative — but tracked entries from `git diff <base>` above are
    // repo-ROOT-relative. For an isolation=none task whose workdir is a repo
    // subdirectory, mixing the two namespaces in one TaskDiff is wrong (it's
    // exactly what getTaskDiffBlob's cwd-fallback exists to paper over).
    // Normalize by prefixing the root→cwd path segment onto the emitted
    // DiffFile.path only; the `--no-index` invocation itself keeps using the
    // cwd-relative `rel`, since that's what exists relative to the cwd git
    // runs in. `path.sep` is "/" here (this app is macOS-only, see
    // README.md's Install section), so the split/join below is a no-op — kept only for
    // symmetry with the `path.relative` call it normalizes, not because it
    // does any actual backslash conversion (a backslash is a legal macOS
    // filename char, so it must never be rewritten).
    //
    // `repoRoot` reports git's canonicalized path (symlinks resolved, e.g.
    // `/tmp` → `/private/tmp` on macOS — see `gitWritableRoots`'s doc
    // comment for the same gotcha), so diffing it against a non-canonical
    // `cwd` would spuriously produce a non-empty prefix even when cwd IS the
    // root. Realpath `cwd` first to compare like-for-like. Skipped entirely
    // when there are no untracked files to prefix — avoids paying a git
    // spawn + realpathSync in the common zero-untracked case.
    let prefix = "";
    if (rels.length > 0) {
      const root = await repoRoot(cwd);
      let realCwd = cwd;
      try { realCwd = realpathSync(cwd); } catch { /* cwd missing — compare as-is */ }
      const rawPrefix = root ? path.relative(root, realCwd).split(path.sep).join("/") : "";
      // GIT_WORK_TREE/bind-mount exotics can leave git's toplevel not a
      // prefix of realpath(cwd), in which case `path.relative` returns a
      // `..`-leading escape. A `../`-prefixed DiffFile.path would be
      // rejected by isSafeRelPath downstream and permanently break that
      // file's preview with no diagnostic — fall back to the old no-prefix
      // behavior instead of emitting an escaping path.
      prefix = rawPrefix.startsWith("..") ? "" : rawPrefix;
    }
    for (const rel of rels) {
      const res = await git(["diff", "--no-color", "--no-index", "--", "/dev/null", rel], cwd);
      if (res.exitCode !== 0 && res.exitCode !== 1) continue;
      const [parsed] = parseGitDiff(res.stdout);
      const emittedPath = prefix ? `${prefix}/${rel}` : rel;
      files.push(
        parsed
          ? { ...parsed, status: "added", path: emittedPath, oldPath: null }
          : { path: emittedPath, oldPath: null, status: "added", additions: 0, deletions: 0, binary: false, hunks: "", truncated: false },
      );
    }
  }

  if (files.length === 0) {
    return { base: shortBase, files: [], repo, note: emptyNote };
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (files.length > MAX_DIFF_FILES) {
    const total = files.length;
    return {
      base: shortBase,
      files: files.slice(0, MAX_DIFF_FILES),
      repo,
      note: `Showing the first ${MAX_DIFF_FILES} of ${total} changed files — the rest are omitted to keep the viewer responsive.`,
    };
  }
  return { base: shortBase, files, repo };
}

// Re-exported so existing/future importers of `MAX_BLOB_PREVIEW_BYTES` from
// this module keep working; `../shared/attachments.ts` is now the canonical
// definition (shared with `github.ts`'s GitHub pull-blob route).
export { MAX_BLOB_PREVIEW_BYTES };

/**
 * True iff `relPath` is safe to `path.join` onto a trusted `cwd`: non-empty,
 * free of null bytes, not itself absolute, and whose normalized form
 * doesn't escape `cwd` (no leading `..` segment once normalized). This is a
 * stricter contract than `/files/preview`'s (which trusts an already-
 * absolute, already-existing path) — `getTaskDiffBlob` (and, via
 * `git-host.ts`'s `pullBlob`, the GitHub pull-blob route) take a
 * repo-relative path from the client, so traversal must be rejected before
 * it ever touches the filesystem or a `git`/API invocation. Rejects
 * lexically-escaping paths only; symlink containment is not enforced,
 * consistent with `/files/preview`'s trust posture (this app has no
 * sandbox — see the repo's CLAUDE.md).
 */
export function isSafeRelPath(relPath: string): boolean {
  if (!relPath) return false;
  if (relPath.includes("\0")) return false;
  if (path.isAbsolute(relPath)) return false;
  const normalized = path.normalize(relPath);
  if (path.isAbsolute(normalized)) return false;
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) return false;
  return true;
}

/**
 * Read the raw bytes of one file, on one side of a task's diff, for the
 * binary-preview UI (images/PDFs get an old-vs-new inline preview instead of
 * the plain "binary file — no textual diff" placeholder). Mirrors
 * `getTaskDiff`'s cwd/base selection exactly, so "old"/"new" here are
 * literally the two sides `git diff <base>` compared:
 *
 *  - "new" reads the on-disk file in the task's cwd (the working tree).
 *  - "old" resolves `base` to a commit sha and reads the blob via
 *    `git show <sha>:<relPath>` — raw bytes (`gitRaw`), never text, since
 *    images/PDFs aren't valid UTF-8 and must never round-trip through a
 *    string.
 *
 * Never throws. `relPath` must pass `isSafeRelPath` — this route is
 * repo-dir-relative, not an arbitrary-path reader like `/files/preview`.
 * Renamed files: the caller is responsible for passing whichever path
 * applies to the requested side (e.g. `oldPath` for `side: "old"` on a
 * rename) — this function has no rename awareness of its own.
 */
export async function getTaskDiffBlob(
  task: Task,
  relPath: string,
  side: "old" | "new",
  repoName?: string | null,
): Promise<{ ok: true; bytes: Uint8Array<ArrayBuffer>; etag: string } | { ok: false; error: string; status: number }> {
  let cwd: string;
  let base: string;

  if ((task.repositories?.length ?? 0) > 1) {
    const repos = task.repositories!;
    const entry = repoName ? repos.find((r) => r.name === repoName) : repos[0];
    if (!entry) return { ok: false, error: "unknown repository", status: 400 };
    const entryPath = entry.worktreePath ?? path.join(worktreePath(task), entry.name);
    if (!existsSync(entryPath)) {
      return { ok: false, error: "this repository hasn't created a worktree yet", status: 404 };
    }
    cwd = entryPath;
    base = entry.baseRef ?? "HEAD";
  } else if (task.isolation === "worktree") {
    if (!task.worktreePath || !existsSync(task.worktreePath)) {
      return { ok: false, error: "this task hasn't created a worktree yet", status: 404 };
    }
    cwd = task.worktreePath;
    base = task.baseRef ?? "HEAD";
  } else {
    if (!existsSync(task.workdir) || !(await isGitRepo(task.workdir))) {
      return { ok: false, error: "the task's workdir isn't a git repo", status: 404 };
    }
    cwd = task.workdir;
    base = "HEAD";
  }

  if (!isSafeRelPath(relPath)) {
    return { ok: false, error: "invalid path", status: 400 };
  }

  if (side === "new") {
    // `git diff`/`git ls-files` report tracked paths relative to the repo
    // ROOT, not necessarily `cwd` — for an isolation=none task whose workdir
    // is a subdirectory of the repo, joining `relPath` onto `cwd` directly
    // double-prefixes it and 404s. (The "old" side below is unaffected:
    // `git show <sha>:<relPath>` is root-relative by construction, same as
    // the diff itself.) Resolve the repo root once and join there instead.
    //
    // The cwd-relative fallback below exists for untracked files surfaced via
    // `git ls-files --others` — getTaskDiff's synthetic "added" entries used
    // to emit those CWD-relative, which only resolved under this fallback
    // join. getTaskDiff now normalizes those to root-relative paths at the
    // source, so for any freshly-generated diff the root-relative join above
    // always hits and this fallback is vestigial. It stays anyway: a stale
    // client (open DiffDialog tab, cached response) may still hold a
    // pre-normalization cwd-relative path, and falling back is free.
    const root = await repoRoot(cwd);
    const rootAbs = root ? path.join(root, relPath) : null;
    const cwdAbs = path.join(cwd, relPath);
    // The file is the agent's, so it is read through `readFileBytes`: a
    // disclaimed child while disclaiming, never the core's own process (D25,
    // D26(j)); without following a symlink at the final component (git shows
    // a symlink as its target text, so the diff never asks for one), and only
    // a regular file (a FIFO/device named `*.png` would hang the read).
    const read = (abs: string) =>
      readFileBytes(abs, { followSymlinks: false, maxBytes: MAX_BLOB_PREVIEW_BYTES });
    let result = await read(rootAbs ?? cwdAbs);
    if (result.kind === "missing" && rootAbs && rootAbs !== cwdAbs) result = await read(cwdAbs);
    switch (result.kind) {
      case "ok":
        return { ok: true, bytes: result.bytes, etag: result.etag };
      case "too-large":
        return { ok: false, error: "too large to preview", status: 413 };
      case "missing":
      case "not-modified":
        return { ok: false, error: "not found", status: 404 };
      case "denied":
        return { ok: false, error: "not readable", status: 403 };
      case "error":
        return { ok: false, error: result.message, status: 500 };
    }
  }

  // side === "old"
  const rev = await git(["rev-parse", "--verify", `${base}^{commit}`], cwd, 10_000);
  if (!rev.ok || !rev.stdout) {
    return { ok: false, error: "could not resolve base", status: 404 };
  }
  const sha = rev.stdout;

  // Check the blob's size before reading it whole into memory.
  const sizeRes = await git(["cat-file", "-s", `${sha}:${relPath}`], cwd, 10_000);
  if (!sizeRes.ok) {
    return { ok: false, error: "not present at base", status: 404 };
  }
  const size = Number(sizeRes.stdout);
  // Fail CLOSED on an unparsable size: `cat-file -s` exited 0 (handled
  // above) but printed something we can't read as a number is "can't
  // confirm this is safe to read into memory," not "assume it's small
  // enough." Two separate branches (rather than one combined condition) so
  // each gets its own clear error/status.
  if (!Number.isFinite(size)) {
    return { ok: false, error: "could not determine blob size", status: 404 };
  }
  if (size > MAX_BLOB_PREVIEW_BYTES) {
    return { ok: false, error: "too large to preview", status: 413 };
  }

  const blob = await gitRaw(["show", `${sha}:${relPath}`], cwd);
  if (!blob.ok) {
    return { ok: false, error: "not present at base", status: 404 };
  }
  // Stable hash (not Bun.hash — see claude-tmux.ts's note on its algorithm
  // not being a cross-version stability contract) of the resolved sha+path,
  // so this etag stays valid for the lifetime of the pinned base.
  const etag = `"${createHash("sha1").update(`${sha}:${relPath}`).digest("hex")}"`;
  return { ok: true, bytes: blob.bytes, etag };
}

/**
 * Best-effort cleanup. Called on task delete; never throws.
 * Removes the worktree directory and deletes the branch.
 *
 * By default only `task.branch` is deleted (never a `branchSource: "existing"`
 * one). Pass `opts.branches` to delete exactly that list instead — each with
 * `git branch -D`, independently and best-effort — which is how delete also
 * removes a branch the worktree had drifted onto (see `planTeardownBranches`,
 * which is responsible for excluding branches that must survive).
 *
 * Two-stage cleanup so we never leak a directory under our owned data dir:
 *   1. Ask git to remove the registered worktree + branch (works in the
 *      common case where `task.workdir` still points at the original repo).
 *   2. If the worktree path still exists and lives under `dataDir/worktrees/`
 *      (which we always construct it to), force-rm it. This catches the case
 *      where the user edited `task.workdir` after the worktree was created,
 *      so git in the new workdir doesn't know about this worktree.
 */
/** Remove one repository's worktree checkout and (optionally) its branches. */
async function removeOneWorktree(root: string | null, wt: string, branches: string[] | null): Promise<void> {
  if (root) {
    await git(["worktree", "remove", "--force", wt], root);
    if (branches) {
      // Caller-planned list: each branch is deleted on its own so one failure
      // (e.g. "checked out at <main repo>") never blocks the rest. A leading
      // "-" would be read as an option, so such a name is skipped.
      for (const b of branches) {
        if (!b || b.startsWith("-")) continue;
        try { await git(["branch", "-D", b], root); }
        catch { /* best-effort */ }
      }
    }
    // Clean up any stale .git/worktrees/<id>/ registrations left by previous
    // partial removes (e.g. workdir was changed after the worktree was created).
    await git(["worktree", "prune"], root, 10_000);
  }
  const ownedPrefix = WORKTREES_DIR + path.sep;
  if (wt.startsWith(ownedPrefix) && existsSync(wt)) {
    // Async on purpose: a synchronous rmSync over a large worktree (e.g. one
    // with node_modules) would block the event loop for seconds, starving
    // every other HTTP connection and SSE stream.
    try { await rm(wt, { recursive: true, force: true }); }
    catch { /* best-effort */ }
  }
}

export async function removeWorktree(
  task: Task,
  opts?: {
    /** Single-repository: the exact branches to delete. */
    branches?: string[];
    /**
     * Multi-repository: each repository's own teardown plan (the same
     * `TaskTeardownPreview.repositories` the delete confirm read). Without it
     * the plan falls back to each entry's pinned branch, which misses a
     * checkout that drifted onto another branch.
     */
    repositories?: { name: string; branches: string[] }[];
  },
): Promise<void> {
  const repos = task.repositories ?? [];
  if (repos.length > 1) {
    // Per repository: remove its checkout and the branches the per-repo plan
    // says agetor owns there. `branchSource: "existing"` never happens for a
    // multi task in v1, but the guard keeps a future per-repo PR head safe.
    const planned = new Map((opts?.repositories ?? []).map((p) => [p.name, p.branches]));
    for (const repo of repos) {
      if (!repo.worktreePath) continue;
      const root = await repoRoot(repo.path);
      const branches = planned.get(repo.name)
        ?? (repo.branch && repo.branchSource !== "existing" ? [repo.branch] : null);
      await removeOneWorktree(root, repo.worktreePath, branches);
    }
    // Each nested directory is its own worktree; only the now-empty workspace
    // root is ours to delete (never recursively).
    removeWorkspaceIfEmpty(workspacePathFor(task));
    return;
  }
  if (!task.worktreePath) return;
  const root = await repoRoot(task.workdir);
  let branches: string[] | null = null;
  if (opts?.branches) branches = opts.branches;
  else if (task.branch && task.branchSource !== "existing") {
    // A `branchSource: "existing"` branch is the user's own (e.g. a PR's head
    // branch) — deleting it here would destroy a branch agetor doesn't own.
    branches = [task.branch];
  }
  await removeOneWorktree(root, task.worktreePath, branches);
}

/**
 * Best-effort `git worktree prune` in `root` — clears the stale
 * `.git/worktrees/<id>` registration left behind after a worktree directory
 * is removed outside of `git worktree remove` (e.g. `deleteOrphanWorktree`,
 * which `rm -rf`s an orphaned dir with no task row to drive a proper
 * removal). Never throws.
 */
export async function pruneWorktrees(root: string): Promise<void> {
  await git(["worktree", "prune"], root, 10_000);
}

/** Detach one repository's worktree, keeping its branch and refusing a dirty checkout. */
async function detachOneWorktree(
  sourcePath: string,
  wt: string | null,
  opts?: { force?: boolean },
): Promise<WorktreeTeardownResult> {
  if (!wt) return { removed: false, reason: "no-worktree" };
  if (!existsSync(wt)) return { removed: false, reason: "already-absent" };
  if (!opts?.force) {
    const dirty = await hasUncommittedChanges(wt);
    if (dirty !== false) return { removed: false, reason: "dirty" };
  }
  const root = await repoRoot(sourcePath);
  if (root) {
    await git(["worktree", "remove", "--force", wt], root);
    // Deliberately no `git branch -D` — the branch survives for a re-attach.
    await git(["worktree", "prune"], root, 10_000);
  }
  const ownedPrefix = WORKTREES_DIR + path.sep;
  if (wt.startsWith(ownedPrefix) && existsSync(wt)) {
    try { await rm(wt, { recursive: true, force: true }); }
    catch { /* best-effort */ }
  }
  const removed = !existsSync(wt);
  return removed ? { removed } : { removed, reason: "failed" };
}

/**
 * Branch-preserving teardown for archive. Unlike `removeWorktree`, this keeps
 * the branch (and thus every commit on it) intact — it only removes the
 * worktree *checkout* from disk, so `prepareWorkdir`'s re-attach path
 * (`task.worktreePath` recorded but the dir is gone, branch still exists) can
 * rematerialize it later at the same deterministic path. This is what lets an
 * archived task's session (claude JSONL, run history, codex thread id — none
 * of which live inside the worktree) be resumed after unarchiving or after a
 * follow-up message.
 *
 * No-op when there's nothing to detach: `task.worktreePath` is null, or the
 * directory is already gone (idempotent — safe to call repeatedly).
 *
 * Skips removal when the worktree has uncommitted changes — `git worktree
 * remove --force` would otherwise permanently discard them with no way back
 * (the branch only has what was committed). `hasUncommittedChanges` returns
 * null whenever it can't get an answer — dir gone (vanished between the two
 * checks), path not a git repo, or `git status` failing on a broken/pruned
 * registration; all of those are "can't confirm clean" → skip removal.
 *
 * Pass `{ force: true }` to skip that dirty gate entirely — the Worktrees
 * page's delete action offers this as an explicit, user-confirmed "discard
 * uncommitted changes" option once the ordinary path above has left a row
 * permanently stuck (dirty checkouts, or a `git status` that keeps failing on
 * a broken registration, would otherwise never clear). Force only ever skips
 * the dirty check — the rest of the body, including the branch-preserving
 * guarantee below, is unchanged: `git branch -D` is never called, forced or
 * not, so the branch and every commit on it survive for a later re-attach.
 *
 * Never throws — best-effort, mirroring `removeWorktree`.
 */
export async function detachWorktree(
  task: Task,
  opts?: { force?: boolean },
): Promise<WorktreeTeardownResult> {
  const repos = task.repositories ?? [];
  if (repos.length > 1) {
    const outcomes: { name: string; result: WorktreeTeardownResult }[] = [];
    for (const repo of repos) {
      outcomes.push({ name: repo.name, result: await detachOneWorktree(repo.path, repo.worktreePath, opts) });
    }
    // Only the empty workspace root is removed; a dirty repository's checkout
    // (and the workspace holding it) stays put.
    removeWorkspaceIfEmpty(workspacePathFor(task));
    const removed = outcomes.every((o) => o.result.removed);
    if (removed) return { removed, repositories: outcomes };
    const reason = outcomes.find((o) => !o.result.removed)?.result.reason ?? "failed";
    return { removed, reason, repositories: outcomes };
  }
  if (!task.worktreePath) return { removed: false, reason: "no-worktree" };
  if (!existsSync(task.worktreePath)) return { removed: false, reason: "already-absent" };

  if (!opts?.force) {
    const dirty = await hasUncommittedChanges(task.worktreePath);
    if (dirty !== false) return { removed: false, reason: "dirty" };
  }

  const root = await repoRoot(task.workdir);
  if (root) {
    await git(["worktree", "remove", "--force", task.worktreePath], root);
    // Deliberately no `git branch -D` — the whole point of detach is to keep
    // the branch around for a later re-attach.
    await git(["worktree", "prune"], root, 10_000);
  }
  const ownedPrefix = WORKTREES_DIR + path.sep;
  if (
    task.worktreePath.startsWith(ownedPrefix)
    && existsSync(task.worktreePath)
  ) {
    // Async on purpose: a synchronous rmSync over a large worktree (e.g. one
    // with node_modules) would block the event loop for seconds, starving
    // every other HTTP connection and SSE stream.
    try { await rm(task.worktreePath, { recursive: true, force: true }); }
    catch { /* best-effort */ }
  }
  const removed = !existsSync(task.worktreePath);
  return removed ? { removed } : { removed, reason: "failed" };
}

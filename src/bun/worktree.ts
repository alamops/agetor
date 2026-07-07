import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { dataDir } from "./db.ts";
import { MAX_DIFF_FILES, parseGitDiff } from "./git-diff.ts";
import type { BranchInfo, Task, TaskDiff } from "../shared/types.ts";

export type { BranchInfo };

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
 * Synchronous on purpose: the codex spawn paths (`spawnCodexTurnNow`,
 * `spawnAgent`) are synchronous, and a local `git rev-parse` is sub-20ms.
 * `--path-format=absolute` (git ≥ 2.31) yields an absolute path directly; the
 * `path.resolve` is belt-and-suspenders for any git that ignores the flag.
 *
 * Containment is checked against the realpath'd cwd: git canonicalizes symlinks
 * in the path it reports (e.g. `/tmp` → `/private/tmp` on macOS), so comparing
 * the reported common dir against a non-canonical `cwd` would otherwise flag an
 * ordinary `.git`-inside-cwd checkout as "outside" and add a redundant root.
 */
export function gitWritableRootsSync(cwd: string): string[] {
  let out: string;
  try {
    const res = spawnSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, encoding: "utf8", timeout: 5_000 },
    );
    if (res.status !== 0 || typeof res.stdout !== "string") return [];
    out = res.stdout.trim();
  } catch {
    return [];
  }
  if (!out) return [];
  const commonDir = path.resolve(cwd, out);
  let realCwd = cwd;
  try { realCwd = realpathSync(cwd); } catch { /* cwd missing — compare as-is */ }
  const rel = path.relative(realCwd, commonDir);
  const insideCwd = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  return insideCwd ? [] : [commonDir];
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
    if (parts[0]!.startsWith("refs/heads/") && !parts[1]!.startsWith("agetor/")) {
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
      // short-names are unique, so no further dedup is needed for heads.
      if (shortName.startsWith("agetor/")) continue;
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
export async function getTaskDiff(task: Task): Promise<TaskDiff> {
  let cwd: string;
  let base: string;
  let shortBase: string | null;
  let emptyNote: string;

  if (task.isolation === "worktree") {
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
    return { base: shortBase, files: [], note: `Could not compute diff: ${tracked.stderr || tracked.stdout || "git diff failed"}` };
  }
  const files = parseGitDiff(tracked.stdout);

  // Newly created files aren't part of `git diff <base>`; surface them as
  // full additions via --no-index (which exits 1 when content differs).
  const listed = await git(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
  if (listed.ok) {
    const rels = listed.stdout.split("\0").filter(Boolean).slice(0, MAX_UNTRACKED);
    for (const rel of rels) {
      const res = await git(["diff", "--no-color", "--no-index", "--", "/dev/null", rel], cwd);
      if (res.exitCode !== 0 && res.exitCode !== 1) continue;
      const [parsed] = parseGitDiff(res.stdout);
      files.push(
        parsed
          ? { ...parsed, status: "added", path: rel, oldPath: null }
          : { path: rel, oldPath: null, status: "added", additions: 0, deletions: 0, binary: false, hunks: "", truncated: false },
      );
    }
  }

  if (files.length === 0) {
    return { base: shortBase, files: [], note: emptyNote };
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (files.length > MAX_DIFF_FILES) {
    const total = files.length;
    return {
      base: shortBase,
      files: files.slice(0, MAX_DIFF_FILES),
      note: `Showing the first ${MAX_DIFF_FILES} of ${total} changed files — the rest are omitted to keep the viewer responsive.`,
    };
  }
  return { base: shortBase, files };
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

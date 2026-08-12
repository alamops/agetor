import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { dataDir } from "./db.ts";
import { MAX_DIFF_FILES, parseGitDiff } from "./git-diff.ts";
import { LEGACY_BRANCH_PREFIX } from "../shared/types.ts";
import type { BranchInfo, Task, TaskDiff, WorktreeTeardownResult } from "../shared/types.ts";
import { MAX_BLOB_PREVIEW_BYTES } from "../shared/attachments.ts";

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
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
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
 * Whether `dir`'s HEAD has already landed on the source repo's default
 * branch — i.e. is an ancestor of it, so the worktree's work is safe to
 * throw away. `null` means "couldn't determine" and must never be presented
 * as merged; callers should treat it as unknown, same contract as
 * `hasUncommittedChanges`/`getAheadCount`.
 *
 * Default branch resolution, most to least authoritative:
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
 * Once a default branch candidate is picked, `git merge-base --is-ancestor
 * HEAD <default>` maps exit code 0 → `true` (HEAD is an ancestor, i.e.
 * merged), exit code 1 → `false` (diverged/not merged), and any other exit
 * code (git error) → `null`.
 *
 * Runs with `cwd` = `dir`; a linked worktree shares the source repo's refs
 * via its common git dir, so this resolves correctly without needing the
 * source repo's own path.
 */
export async function isMergedIntoDefaultBranch(dir: string): Promise<boolean | null> {
  if (!existsSync(dir)) return null;
  if (!(await isGitRepo(dir))) return null;

  let defaultBranch: string | null = null;

  const originHead = await git(["rev-parse", "--abbrev-ref", "origin/HEAD"], dir);
  if (originHead.ok && originHead.stdout.length > 0 && originHead.stdout !== "origin/HEAD") {
    defaultBranch = originHead.stdout;
  } else {
    for (const candidate of ["main", "master"]) {
      const ref = await git(["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], dir);
      if (ref.ok) {
        defaultBranch = candidate;
        break;
      }
    }
  }

  if (!defaultBranch || defaultBranch.startsWith("-")) return null;

  const res = await git(["merge-base", "--is-ancestor", "HEAD", defaultBranch], dir);
  if (res.exitCode === 0) return true;
  if (res.exitCode === 1) return false;
  return null;
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
    const gitFile = path.join(worktreeDir, ".git");
    const contents = readFileSync(gitFile, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/.exec(contents);
    if (!match) return null;
    const gitdir = match[1]!;
    const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
    const idx = gitdir.indexOf(marker);
    if (idx < 0) return null;
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
  // created before the pinning was added. `let` because a create-time
  // uniqueness race may force us to re-pin below.
  let branch = task.branch ?? branchName(task);
  // Pinned base sha if set on the task; otherwise use HEAD at start time.
  // The sha makes the start state sticky across re-runs even when HEAD moves.
  const base = task.baseRef ?? "HEAD";

  // For a task pinned to a pre-existing branch (e.g. a PR's head branch),
  // refresh it from origin before deciding how to materialize the worktree —
  // best-effort, since the branch may already be present locally with no
  // remote at all.
  if (task.branchSource === "existing") {
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
  let created = branchExists
    ? await git(["worktree", "add", wt, branch], root)
    : task.branchSource === "existing"
      ? await git(["worktree", "add", "--track", "-b", branch, wt, `origin/${branch}`], root)
      : await git(["worktree", "add", "-b", branch, wt, base], root);

  // Collision recovery — ONLY on a first materialization (`!task.worktreePath`).
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
  // The `!task.worktreePath` gate is load-bearing. Once a task HAS materialized,
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
    !task.worktreePath &&
    task.branchSource !== "existing" &&
    isBranchNameTakenError(`${created.stderr}\n${created.stdout}`)
  ) {
    const unique = await ensureUniqueBranch(root, branch, opts?.takenBranches ?? new Set());
    if (unique !== branch) {
      const retry = await git(["worktree", "add", "-b", unique, wt, base], root);
      if (retry.ok) {
        branch = unique;
        created = retry;
      }
    }
  }

  if (!created.ok) {
    const detail = created.stderr || created.stdout;
    if (task.branchSource === "existing") {
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
): Promise<{ ok: true; bytes: Uint8Array<ArrayBuffer>; etag: string } | { ok: false; error: string; status: number }> {
  let cwd: string;
  let base: string;

  if (task.isolation === "worktree") {
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
    // Caveat: untracked files surfaced via `git ls-files --others`
    // (getTaskDiff's synthetic "added" entries) are CWD-relative, not
    // root-relative — so such a file's path may only resolve under the
    // cwd-relative join. Try the root-relative path first (the common case —
    // tracked diffs are root-relative), and fall back to the cwd-relative
    // join only when the root-relative stat misses and the two differ.
    const root = await repoRoot(cwd);
    const rootAbs = root ? path.join(root, relPath) : null;
    const cwdAbs = path.join(cwd, relPath);
    let abs = rootAbs ?? cwdAbs;
    let st;
    try {
      st = statSync(abs);
    } catch {
      if (rootAbs && rootAbs !== cwdAbs) {
        try {
          st = statSync(cwdAbs);
          abs = cwdAbs;
        } catch {
          return { ok: false, error: "not found", status: 404 };
        }
      } else {
        return { ok: false, error: "not found", status: 404 };
      }
    }
    // Only regular files: a FIFO/device named `*.png` would otherwise hang
    // the read forever (same guard as /files/preview).
    if (!st.isFile()) {
      return { ok: false, error: "not found", status: 404 };
    }
    if (st.size > MAX_BLOB_PREVIEW_BYTES) {
      return { ok: false, error: "too large to preview", status: 413 };
    }
    const bytes = new Uint8Array(await Bun.file(abs).arrayBuffer());
    return { ok: true, bytes, etag: `"${st.size}-${st.mtimeMs}"` };
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
    // A `branchSource: "existing"` branch is the user's own (e.g. a PR's head
    // branch) — deleting it here would destroy a branch agetor doesn't own.
    if (task.branch && task.branchSource !== "existing") {
      await git(["branch", "-D", task.branch], root);
    }
    // Clean up any stale .git/worktrees/<id>/ registrations left by previous
    // partial removes (e.g. workdir was changed after the worktree was created).
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
